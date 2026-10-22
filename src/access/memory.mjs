import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OrchestratorError, invariant } from '../errors.mjs';
import { runCommand } from '../process.mjs';
import { readJson, writeJsonAtomic, withLock } from '../state.mjs';
import { HISTORICAL_TYPES } from './coop.mjs';

// Memory for the access layer: recall before continuing a session or job, an explicit admission
// (begin) before new handoff content is gathered, and a distilled checkpoint (save) afterwards.
// HarnessOrbit owns identity, permissions, busy/idle, idempotent sending and verification state;
// the memory provider stores goals, decisions, constraints, open questions and sourced handoff
// notes. Nothing recalled grants permission, acts as a lock or command, or counts as current fact.
//
// The production provider is Memy's own `memy handoff` CLI (contract: memy-orbit-handoff
// docs/harnessorbit_handoff.md, memy.handoff.v1, AgentMemory issue 1429). It resolves the
// checkout (process cwd) to a Project connection and Agent grant itself; HarnessOrbit passes no
// token, project id, tenant or namespace.

export const MEMORY_SCHEMA_VERSION = 2;
export const ORCHESTRATOR_VERSION = '0.4.0';
export const RECALL_STATUSES = Object.freeze(['ok', 'degraded', 'unconfigured', 'denied', 'timeout', 'invalid', 'error']);
export const BEGIN_STATUSES = Object.freeze(['admitted', 'unconfigured', 'denied', 'timeout', 'error']);
export const SAVE_STATUSES = Object.freeze(['saved', 'pending', 'denied', 'conflict', 'unconfigured', 'invalid', 'timeout', 'error']);
export const EVIDENCE_LABELS = Object.freeze(['planned', 'reported', 'verified', 'integrated']);
export const PARTICIPANT_KINDS = Object.freeze(['claude_code', 'codex', 'grok', 'human', 'orchestrator', 'other']);
export const MAX_RECALL_ITEMS = 10;
export const MAX_RECALL_BYTES = 8192;
export const MAX_ITEM_CHARS = 1200;
const LIST_LIMIT = 20;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const CHECKPOINT_SCHEMA = 'memy.handoff.checkpoint.v1';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const clip = (value, max) => (typeof value === 'string' && value.length > max ? `${value.slice(0, max - 1)}…` : value);

// Recall items are bounded excerpts. Lengths are counted in Unicode scalar values (code points),
// the same unit Memy uses for its original_chars, so a clipped CJK or emoji text is measured the
// same way on both sides. Clipping keeps max - 1 scalars plus an ellipsis.
export function scalarCount(text) { let n = 0; for (const _ of String(text)) n += 1; return n; }
export function clipScalars(text, max) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= max) return { content: chars.join(''), clipped: false, chars: chars.length };
  return { content: `${chars.slice(0, max - 1).join('')}…`, clipped: true, chars: chars.length };
}

// Per-item excerpt metadata from a provider item plus Orbit's own clipping. Provider fields are
// optional and additive: `truncated` (boolean) and `original_chars` (non-negative integer counted
// after redaction, before clipping). Missing or malformed metadata is unknown (null), never a
// completeness claim; metadata that contradicts the received content is also unknown.
export function excerptMetadata(item, received) {
  const providerTruncated = typeof item?.truncated === 'boolean' ? item.truncated : null;
  let providerChars = Number.isInteger(item?.original_chars) && item.original_chars >= 0 ? item.original_chars : null;
  const receivedChars = scalarCount(item?.content ?? '');
  // A provider that says the content is complete but counts more (or fewer) scalars than it sent, or
  // that says it truncated but counts fewer than it sent, contradicts itself: trust neither field.
  const inconsistent = providerChars !== null && ((providerTruncated === false && providerChars !== receivedChars) || (providerTruncated === true && providerChars < receivedChars) || (providerTruncated === null && providerChars < receivedChars));
  if (inconsistent) providerChars = null;
  const truncatedKnown = inconsistent ? null : providerTruncated;
  let truncated;
  if (received.clipped || truncatedKnown === true) truncated = true;
  else if (truncatedKnown === false) truncated = false;
  else truncated = null;
  const originalChars = providerChars ?? (truncatedKnown === false ? received.chars : null);
  return { truncated, originalChars };
}

// Memy identifies an operation by UUID; derive one deterministically (RFC 4122 v5 layout) from
// the caller's stable operation identifier so a retry carries the same id.
export function uuidFromOperationId(operationId, namespace = 'harnessorbit-access') {
  const digest = crypto.createHash('sha1').update(`${namespace}\u0000${operationId}`).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50; digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// HarnessOrbit agent kinds → the Memy-integrated Agent whose grant carries the request.
export function handoffAgent(kind) {
  return kind === 'claude' ? { flag: 'claude-code', id: 'claude_code' } : kind === 'codex' ? { flag: 'codex', id: 'codex' } : kind === 'orchestrator' ? { flag: 'orchestrator', id: 'orchestrator' } : null;
}
export const MEMORY_AUTHORITIES = Object.freeze(['agent', 'orchestrator']);

// Provenance is kept as a flat object of short scalars so it stays bounded without ever being
// cut in the middle of a JSON document.
export function boundedProvenance(value, { maxKeys = 12, maxChars = 200 } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (Object.keys(out).length >= maxKeys) { out._truncated = true; break; }
    if (raw === null || ['string', 'number', 'boolean'].includes(typeof raw)) out[String(key).slice(0, 64)] = typeof raw === 'string' ? clip(raw, maxChars) : raw;
    else if (Array.isArray(raw) && raw.every(v => ['string', 'number', 'boolean'].includes(typeof v))) out[String(key).slice(0, 64)] = raw.slice(0, 8).map(v => (typeof v === 'string' ? clip(v, maxChars) : v));
  }
  return out;
}

// Providers answer with the contract's statuses. Anything else is not a reason to throw at the
// caller: transient transport words become a retryable status with their reason kept, and
// everything unknown is an error with reason protocol.
const TRANSIENT = new Set(['unavailable', 'offline', 'busy', 'rate_limited', 'resident_unavailable']);
export function normalizeProviderResult(kind, result) {
  const allowed = kind === 'save' ? SAVE_STATUSES : kind === 'begin' ? BEGIN_STATUSES : RECALL_STATUSES;
  const status = typeof result?.status === 'string' ? result.status : 'error';
  if (allowed.includes(status)) return { ...result, status };
  if (TRANSIENT.has(status)) return { ...result, status: kind === 'save' ? 'pending' : 'timeout', reason: result.reason || status };
  return { ...result, status: 'error', reason: 'protocol', detail: `provider returned unknown status "${clip(String(status), 40)}"` };
}

// The timer is the only thing guaranteed to settle this race, so it must keep the event loop
// alive: an unref'd timer would let a process exit while the caller still awaits the timeout.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'timeout', reason: 'timeout', detail: `${label} did not answer within ${ms} ms` }), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Default when nothing is configured: every call says so instead of pretending.
export class NullMemoryProvider {
  constructor({ reason = 'setup_unavailable', detail = 'No memory provider is configured on this host.' } = {}) { this.name = 'none'; this.configured = false; this.reason = reason; this.detail = detail; }
  async recall() { return { status: 'unconfigured', reason: this.reason, detail: this.detail, items: [] }; }
  async begin() { return { status: 'unconfigured', reason: this.reason, detail: this.detail }; }
  async save() { return { status: 'unconfigured', reason: this.reason, detail: this.detail }; }
}

// Runs `memy handoff <command>` with the checkout as working directory and parses its single JSON
// line. Memy's own connection records and Project OAuth grant decide authority; a missing binary,
// a checkout without connection or an unsupported agent come back as unconfigured.
export class MemyHandoffCliProvider {
  constructor({ argv = ['memy'], timeoutMs = 8000, command = runCommand } = {}) {
    invariant(Array.isArray(argv) && argv.length > 0 && argv.every(a => typeof a === 'string' && a.length > 0), 'invalid_memory_config', 'memy argv must be a nonempty string array.');
    invariant(Number.isInteger(timeoutMs) && timeoutMs >= 500 && timeoutMs <= 30000, 'invalid_memory_config', 'timeoutMs must be 500 to 30000 (the contract’s --timeout-ms range).');
    this.name = 'memy-handoff-cli'; this.configured = true; this.argv = argv; this.timeoutMs = timeoutMs; this.command = command;
  }

  // The same CLI contract through another exact argv prefix (an operator route): same command runner,
  // same timeout, nothing else inherited.
  withArgv(argv) { return new MemyHandoffCliProvider({ argv, timeoutMs: this.timeoutMs, command: this.command }); }

  async _run(subcommand, args, { cwd, input, timeoutMs = this.timeoutMs, expectProject = null } = {}) {
    const startedAt = Date.now();
    let result;
    // --expect-project is Memy's own guard: the trusted route's Project id, never a caller value.
    const expect = expectProject ? ['--expect-project', expectProject] : [];
    try { result = await this.command([...this.argv, 'handoff', subcommand, ...args, ...expect, '--timeout-ms', String(timeoutMs)], { cwd, input, timeoutMs: timeoutMs + 2000, maxBytes: 262144 }); }
    catch (error) {
      const latencyMs = Date.now() - startedAt;
      if (error?.code === 'command_spawn_failed') return { status: 'unconfigured', reason: 'setup_unavailable', detail: 'The memy CLI is not installed on this host.', latencyMs };
      if (error?.code === 'command_timeout') return { status: 'timeout', reason: 'timeout', detail: `memy handoff ${subcommand} did not finish within ${timeoutMs} ms.`, latencyMs };
      return { status: 'error', reason: 'protocol', detail: clip(String(error?.code || 'spawn failed'), 120), latencyMs };
    }
    const latencyMs = Date.now() - startedAt;
    if (result.code === 2) return { status: 'invalid', reason: 'invalid_arguments', detail: 'memy rejected the arguments (exit 2).', latencyMs };
    const line = String(result.stdout || '').trim();
    let json;
    try { json = JSON.parse(line); } catch { return { status: 'error', reason: 'protocol', detail: `memy handoff ${subcommand} returned no JSON (exit ${result.code}).`, latencyMs }; }
    if (!json || json.schema !== 'memy.handoff.v1' || json.command !== subcommand || typeof json.status !== 'string') return { status: 'error', reason: 'protocol', detail: 'memy answered with an unexpected schema.', latencyMs };
    if (typeof json.reason !== 'undefined' && json.reason !== null && typeof json.reason !== 'string') return { status: 'error', reason: 'protocol', detail: 'memy answered with a non-string reason.', latencyMs };
    return { ...json, latencyMs };
  }

  // A success envelope must carry the fields the contract promises for that command, and they
  // must describe this request (the operation id we sent). Anything less is a protocol error, never
  // a success with blanks.
  _validated(json, subcommand, { operationUuid = null } = {}) {
    const fail = detail => ({ status: 'error', reason: 'protocol', detail: `memy handoff ${subcommand}: ${detail}`, latencyMs: json.latencyMs });
    const isUuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
    const isGeneration = v => Number.isInteger(v) && v >= 0;
    if (subcommand === 'status' && json.status === 'ok') {
      if (!isUuid(json.project_id) || !json.collection || typeof json.collection.write_enabled !== 'boolean' || !isGeneration(json.collection.write_generation)) return fail('ok response lacks project_id or collection fields');
    } else if (subcommand === 'recall' && json.status === 'ok') {
      if (!Array.isArray(json.items)) return fail('ok response lacks items');
    } else if (subcommand === 'begin' && json.status === 'admitted') {
      if (json.operation_id !== operationUuid) return fail('admitted response names a different operation');
      if (!isUuid(json.project_id) || !isGeneration(json.write_generation)) return fail('admitted response lacks project_id or write_generation');
    } else if (subcommand === 'save' && json.status === 'saved') {
      if (json.operation_id !== operationUuid) return fail('saved response names a different operation');
      if (!isUuid(json.project_id) || !isGeneration(json.write_generation) || !Array.isArray(json.memory_ids) || !json.memory_ids.length || !json.memory_ids.every(isUuid) || typeof json.deduplicated !== 'boolean') return fail('saved response lacks a UUID project_id, write_generation, UUID memory_ids or deduplicated');
    }
    return json;
  }

  async status({ project, agent, expectProject = null } = {}) {
    const who = handoffAgent(agent);
    if (!who) return { status: 'unconfigured', reason: 'agent_unsupported', detail: `Memy handoff supports claude and codex sessions; ${agent} is not integrated.` };
    return this._validated(await this._run('status', ['--agent', who.flag], { cwd: project, expectProject }), 'status');
  }

  async recall({ project, agent, question, topK = 5, exclude = [], timeoutMs = this.timeoutMs, expectProject = null } = {}) {
    const who = handoffAgent(agent);
    if (!who) return { status: 'unconfigured', reason: 'agent_unsupported', detail: `Memy handoff supports claude and codex sessions; ${agent} is not integrated.`, items: [] };
    const args = ['--agent', who.flag, '--query', question, '--top-k', String(topK), '--max-bytes', String(MAX_RECALL_BYTES)];
    for (const id of exclude) args.push('--exclude', id);
    const json = normalizeProviderResult('recall', this._validated(await this._run('recall', args, { cwd: project, timeoutMs, expectProject }), 'recall'));
    if (json.status !== 'ok') return { status: json.status, reason: json.reason ?? null, detail: json.detail ?? null, items: [], latencyMs: json.latencyMs };
    const items = (Array.isArray(json.items) ? json.items : []).map(item => {
      const received = clipScalars(item.content ?? '', MAX_ITEM_CHARS);
      return {
        id: item.memory_id ?? null, content: received.content, type: item.memory_type ?? null, score: typeof item.score === 'number' ? item.score : null,
        observedAt: item.provenance?.observed_at ?? item.provenance?.created_at ?? null, provenance: boundedProvenance(item.provenance), handoff: item.handoff ? boundedProvenance(item.handoff) : null,
        ...excerptMetadata(item, received),
      };
    });
    return { status: json.degraded ? 'degraded' : 'ok', reason: null, items, omitted: json.omitted ?? null, notice: json.notice ?? null, projectId: json.project_id ?? null, latencyMs: json.latencyMs };
  }

  async begin({ project, agent, operationId, timeoutMs = this.timeoutMs, expectProject = null } = {}) {
    const who = handoffAgent(agent);
    if (!who) return { status: 'unconfigured', reason: 'agent_unsupported', detail: `Memy handoff supports claude and codex sessions; ${agent} is not integrated.` };
    const operationUuid = uuidFromOperationId(operationId);
    const json = normalizeProviderResult('begin', this._validated(await this._run('begin', ['--agent', who.flag, '--operation-id', operationUuid], { cwd: project, timeoutMs, expectProject }), 'begin', { operationUuid }));
    return { status: json.status, reason: json.reason ?? null, detail: json.detail ?? null, projectId: json.project_id ?? null, writeGeneration: json.write_generation ?? null, latencyMs: json.latencyMs };
  }

  // stdin is the canonical checkpoint JSON; a retry must send the same bytes under the same id.
  async save({ project, agent, operationId, canonical, timeoutMs = this.timeoutMs, expectProject = null } = {}) {
    const who = handoffAgent(agent);
    if (!who) return { status: 'unconfigured', reason: 'agent_unsupported', detail: `Memy handoff supports claude and codex sessions; ${agent} is not integrated.` };
    const operationUuid = uuidFromOperationId(operationId);
    const json = normalizeProviderResult('save', this._validated(await this._run('save', ['--agent', who.flag, '--operation-id', operationUuid], { cwd: project, input: `${canonical}\n`, timeoutMs, expectProject }), 'save', { operationUuid }));
    return { status: json.status, reason: json.reason ?? null, detail: json.detail ?? null, projectId: json.project_id ?? null, memoryIds: Array.isArray(json.memory_ids) ? json.memory_ids : [], deduplicated: json.deduplicated === true, writeGeneration: json.write_generation ?? null, latencyMs: json.latencyMs };
  }
}

// Operator-only provider routing: an exact canonical host project may be mapped to another exact
// argv prefix (for example `docker exec -i --workdir … <container> memy`), a declared provider
// checkout and the Memy Project id that checkout must resolve to. Unmapped projects keep the
// same-machine default. The store is host state written only by the operator CLI; bots have no
// setter, and no request field can name an executable, a path or a Project. A store that exists
// but cannot be read or does not validate fails every memory operation closed: a parse failure is
// never "unmapped".
export const ROUTE_SCHEMA_VERSION = 1;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const routeError = (code, message, details) => new OrchestratorError(code, message, details);

export class MemoryRouteStore {
  constructor({ root } = {}) {
    invariant(typeof root === 'string' && root.length > 0, 'invalid_state_root', 'Memory route store root is required.');
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'access', 'memory', 'routes.json');
  }

  // One gate per canonical host project, shared by bind/unbind and by every provider invocation for
  // that project: an admitted call finishes on its frozen route before a mutation lands, and a
  // mutation that landed is seen by every later call. Unrelated projects are independent.
  gate(project, fn, { timeoutMs = 60000 } = {}) { return withLock(path.join(this.root, 'locks', `access-memory-gate-${sha(project).slice(0, 24)}`), fn, { timeoutMs }); }
  _lock(fn) { return withLock(path.join(this.root, 'locks', 'access-memory-routes'), fn, { timeoutMs: 15000 }); }

  static validateRecord(record, key) {
    const bad = detail => { throw routeError('memory_route_invalid', `Route for ${key} is invalid: ${detail}.`, { status: 'memory_route_invalid', hostProject: key, operatorAction: 'access memory route show / bind again' }); };
    if (!record || typeof record !== 'object') bad('not an object');
    if (typeof record.routeId !== 'string' || !UUID_RE.test(record.routeId)) bad('routeId is not a uuid');
    if (!Number.isInteger(record.revision) || record.revision < 1) bad('revision is not a positive integer');
    if (record.hostProject !== key) bad('hostProject does not match its key');
    if (!Array.isArray(record.argv) || record.argv.length === 0 || !record.argv.every(a => typeof a === 'string' && a.length > 0)) bad('argv is not a non-empty array of non-empty strings');
    if (typeof record.providerCheckout !== 'string' || !record.providerCheckout.length) bad('providerCheckout is missing');
    if (typeof record.expectedProjectId !== 'string' || !UUID_RE.test(record.expectedProjectId)) bad('expectedProjectId is not a uuid');
    if (typeof record.enabled !== 'boolean') bad('enabled is not a boolean');
    return record;
  }

  static argvHash(argv) { return sha(JSON.stringify(argv)); }
  static snapshot(record) { return { routeId: record.routeId, revision: record.revision, hostProject: record.hostProject, argv: [...record.argv], providerCheckout: record.providerCheckout, expectedProjectId: record.expectedProjectId, argvHash: MemoryRouteStore.argvHash(record.argv), enabled: record.enabled, label: record.label ?? null }; }
  static frozen(snapshot) { return snapshot ? { routeId: snapshot.routeId, revision: snapshot.revision, expectedProjectId: snapshot.expectedProjectId, argvHash: snapshot.argvHash } : null; }
  static sameFrozen(a, b) { return (a ?? null) === null ? (b ?? null) === null : Boolean(b) && a.routeId === b.routeId && a.revision === b.revision && a.expectedProjectId === b.expectedProjectId && a.argvHash === b.argvHash; }

  // Absent file: no routes (same-machine default everywhere). Present but unreadable, unparseable or
  // off-schema: fail closed for every project.
  async load() {
    let text;
    try { text = await fs.readFile(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { schemaVersion: ROUTE_SCHEMA_VERSION, routes: {} }; throw routeError('memory_route_store_invalid', 'The memory route store could not be read; no memory operation runs until the operator restores it.', { status: 'memory_route_store_invalid', cause: error.code, operatorAction: 'inspect and restore access/memory/routes.json' }); }
    let doc;
    try { doc = JSON.parse(text); } catch { doc = null; }
    if (!doc || typeof doc !== 'object' || doc.schemaVersion !== ROUTE_SCHEMA_VERSION || !doc.routes || typeof doc.routes !== 'object' || Array.isArray(doc.routes)) throw routeError('memory_route_store_invalid', 'The memory route store is malformed; no memory operation runs until the operator restores it. A malformed store is never treated as unmapped.', { status: 'memory_route_store_invalid', operatorAction: 'inspect and restore access/memory/routes.json' });
    return doc;
  }

  // The resolution for one canonical project, as one immutable snapshot.
  async lookup(project) {
    const doc = await this.load();
    const record = doc.routes[project];
    if (!record) return { kind: 'unmapped', snapshot: null };
    const snapshot = MemoryRouteStore.snapshot(MemoryRouteStore.validateRecord(record, project));
    return { kind: snapshot.enabled ? 'route' : 'disabled', snapshot };
  }

  static async canonicalProject(hostProject) {
    invariant(typeof hostProject === 'string' && path.isAbsolute(hostProject), 'invalid_route', 'hostProject must be an absolute path.');
    let real;
    try { real = await fs.realpath(hostProject); invariant((await fs.stat(real)).isDirectory(), 'invalid_route', 'hostProject must be a directory.'); }
    catch (error) { if (error instanceof OrchestratorError) throw error; invariant(false, 'invalid_route', 'hostProject does not exist on this host.', { hostProject }); }
    return real;
  }

  // Operator bind: a new routeId every time, revision +1 even for identical content.
  async bind({ hostProject, argv, providerCheckout, expectedProjectId, label = null } = {}) {
    const key = await MemoryRouteStore.canonicalProject(hostProject);
    invariant(Array.isArray(argv) && argv.length > 0 && argv.length <= 64 && argv.every(a => typeof a === 'string' && a.length > 0 && a.length <= 1024), 'invalid_route', 'argv must be a non-empty array of non-empty strings (exact tokens; no shell).');
    invariant(typeof providerCheckout === 'string' && providerCheckout.length > 0 && providerCheckout.length <= 1024, 'invalid_route', 'providerCheckout is required (the checkout inside the provider environment that corresponds to this host project).');
    invariant(typeof expectedProjectId === 'string' && UUID_RE.test(expectedProjectId), 'invalid_route', 'expectedProjectId must be the Memy Project UUID.');
    invariant(label === null || (typeof label === 'string' && label.length <= 120), 'invalid_route', 'label must be at most 120 characters.');
    return this.gate(key, () => this._lock(async () => {
      const doc = await this.load();
      const previous = doc.routes[key] || null;
      const record = { routeId: crypto.randomUUID(), revision: (previous?.revision || 0) + 1, hostProject: key, argv: [...argv], providerCheckout, expectedProjectId: expectedProjectId.toLowerCase(), label, enabled: true, createdAt: previous?.createdAt || now(), updatedAt: now(), disabledAt: null };
      doc.routes[key] = record;
      await writeJsonAtomic(this.file, doc);
      return this.public(record, { argv: true });
    }));
  }

  async unbind({ hostProject } = {}) {
    const key = await MemoryRouteStore.canonicalProject(hostProject);
    return this.gate(key, () => this._lock(async () => {
      const doc = await this.load();
      const record = doc.routes[key];
      invariant(record, 'memory_route_not_found', `No route is bound for ${key}.`, { hostProject: key });
      if (record.enabled) { record.enabled = false; record.disabledAt = now(); record.updatedAt = now(); await writeJsonAtomic(this.file, doc); }
      return this.public(record);
    }));
  }

  async list() { const doc = await this.load(); return { routes: Object.values(doc.routes).map(r => this.public(r)) }; }
  async show({ hostProject } = {}) { const key = await MemoryRouteStore.canonicalProject(hostProject); const doc = await this.load(); const record = doc.routes[key]; invariant(record, 'memory_route_not_found', `No route is bound for ${key}.`, { hostProject: key }); return this.public(record, { argv: true }); }

  public(record, { argv = false } = {}) {
    return { routeId: record.routeId, revision: record.revision, hostProject: record.hostProject, providerCheckout: record.providerCheckout, expectedProjectId: record.expectedProjectId, label: record.label ?? null, enabled: record.enabled, createdAt: record.createdAt, updatedAt: record.updatedAt, disabledAt: record.disabledAt ?? null, argvHash: MemoryRouteStore.argvHash(record.argv), ...(argv ? { argv: [...record.argv] } : {}) };
  }
}

export function memoryProviderFromEnv(env = process.env) {
  const selected = env.HARNESSORBIT_MEMORY_PROVIDER || null;
  if (!selected) return new NullMemoryProvider({ reason: 'setup_unavailable', detail: 'No memory provider selected. Set HARNESSORBIT_MEMORY_PROVIDER=memy-handoff-cli on a host with the Memy CLI and a connected checkout.' });
  if (selected === 'memy-handoff-cli') {
    const timeoutMs = env.HARNESSORBIT_MEMY_TIMEOUT_MS ? Number(env.HARNESSORBIT_MEMY_TIMEOUT_MS) : 8000;
    return new MemyHandoffCliProvider({ argv: (env.HARNESSORBIT_MEMY_BIN || 'memy').split(' ').filter(Boolean), timeoutMs: Number.isInteger(timeoutMs) ? Math.min(30000, Math.max(500, timeoutMs)) : 8000 });
  }
  return new NullMemoryProvider({ reason: 'setup_unavailable', detail: `Unknown memory provider "${selected}".` });
}

function textField(value, field, max, { required = true, min = 1, multiline = true } = {}) {
  if (value === undefined || value === null) { invariant(!required, 'invalid_memory_request', `${field} is required.`, { field }); return null; }
  invariant(typeof value === 'string', 'invalid_memory_request', `${field} must be a string.`, { field });
  const trimmed = value.trim();
  invariant(trimmed.length >= min && trimmed.length <= max, 'invalid_memory_request', `${field} must be ${min} to ${max} characters.`, { field });
  invariant(!CONTROL.test(trimmed) && (multiline || !/[\n\t]/.test(trimmed)), 'invalid_memory_request', `${field} must not contain control characters.`, { field });
  return trimmed;
}

function listField(value, field, { maxItems = LIST_LIMIT, maxChars = 400 } = {}) {
  if (value === undefined) return [];
  invariant(Array.isArray(value) && value.length <= maxItems, 'invalid_memory_request', `${field} must be a list of at most ${maxItems} entries.`, { field });
  return value.map((entry, i) => textField(entry, `${field}[${i}]`, maxChars));
}

export class MemoryService {
  // orchestratorCarrier is the host operator's explicit choice to allow Memy's distinct
  // orchestrator grant (`--agent orchestrator`) for checkpoints that no Claude/Codex session grant
  // carries. Off by default; never a fallback for an agent-carried operation or vice versa.
  constructor({ root, provider = new NullMemoryProvider(), principals, sessions, jobs, orchestrator, coop = null, orchestratorCarrier = false, timeoutMs = 8000, routes = null } = {}) {
    invariant(typeof root === 'string' && root.length > 0, 'invalid_state_root', 'Memory service root is required.');
    invariant(principals, 'invalid_principals', 'Memory service requires a principal store.');
    this.root = path.resolve(root);
    this.provider = provider; this.principals = principals; this.sessions = sessions || null; this.jobs = jobs || null; this.orchestrator = orchestrator || null; this.coop = coop;
    this.orchestratorCarrier = orchestratorCarrier === true;
    this.timeoutMs = timeoutMs;
    this.directory = path.join(this.root, 'access', 'memory');
    this.routes = routes || new MemoryRouteStore({ root: this.root });
  }

  // Runs one provider call under the target project's invocation gate. Inside the gate the target
  // and principal are authorized again and the route snapshot is taken; both are used only for this
  // call, and the gate is held through the bounded provider call. `frozen` (from an admission) must
  // equal the current route or the operation is refused rather than moved to another provider.
  async _routed(principal, selector, firstTarget, frozen, fn, { operationId = null, bound = [] } = {}) {
    return this.routes.gate(firstTarget.project, async () => {
      const { target, principal: current } = await this._target(principal, selector);
      // The complete target identity, including a job's current attempt (intentRevision) and a
      // session's binding, must be what it was before the wait; and every durable record this
      // operation already holds (admission, pending, receipt) must still name this exact identity.
      // An operation admitted at one attempt is never re-admitted or saved under a later one.
      invariant(target.kind === firstTarget.kind && target.id === firstTarget.id && target.project === firstTarget.project && target.agent === firstTarget.agent && (target.bindingId ?? null) === (firstTarget.bindingId ?? null) && (target.intentRevision ?? null) === (firstTarget.intentRevision ?? null), 'operation_conflict', 'The target’s identity changed while waiting for the memory gate (re-bound, or the job moved to another attempt); nothing was sent. Begin a new operation for the current identity.', { operationId, before: { intentRevision: firstTarget.intentRevision ?? null, bindingId: firstTarget.bindingId ?? null }, now: { intentRevision: target.intentRevision ?? null, bindingId: target.bindingId ?? null } });
      for (const record of bound) this._sameOwner(record, current, target, operationId);
      const resolution = await this.routes.lookup(target.project);
      if (frozen !== undefined) invariant(MemoryRouteStore.sameFrozen(frozen, MemoryRouteStore.frozen(resolution.snapshot && resolution.kind === 'route' ? resolution.snapshot : null)) && !(frozen === null && resolution.kind === 'disabled'), 'memory_route_changed', 'The provider route for this project changed (bound, rebound or unbound) since this operation was admitted; the operation is refused and is never moved to another provider. Begin a new operation if appropriate.', { status: 'memory_route_changed', frozen: frozen ? { routeId: frozen.routeId, revision: frozen.revision } : null, current: resolution.snapshot ? { routeId: resolution.snapshot.routeId, revision: resolution.snapshot.revision, enabled: resolution.snapshot.enabled } : null });
      if (resolution.kind === 'disabled') throw routeError('memory_route_disabled', 'This project’s provider route is unbound (disabled); the same-machine default is not used for a project that was mapped.', { status: 'memory_route_disabled', routeId: resolution.snapshot.routeId, revision: resolution.snapshot.revision, operatorAction: 'access memory route bind …' });
      let provider = this.provider; let route = null;
      if (resolution.kind === 'route') {
        route = resolution.snapshot;
        provider = typeof this.provider.withArgv === 'function' ? this.provider.withArgv(route.argv) : null;
      }
      return fn({ target, current, provider, route, expectProject: route ? route.expectedProjectId : null, routeInfo: route ? { routeId: route.routeId, revision: route.revision, expectedProjectId: route.expectedProjectId } : null });
    });
  }

  describe(principal) {
    return {
      provider: this.provider.name, configured: this.provider.configured === true, experimental: this.provider.experimental === true,
      ...(this.provider.configured ? {} : { reason: this.provider.reason || null, detail: this.provider.detail || null }),
      routing: { mode: 'operator-mapped per canonical host project', default: 'same-machine provider for unmapped projects', note: 'Routes are host state set by the operator CLI (access memory route …); requests carry no executable, path or Project.' },
      tools: ['memory_recall', 'memory_begin', 'memory_checkpoint'], contract: 'memy.handoff.v1',
      authorities: { default: 'agent', orchestratorCarrier: this.orchestratorCarrier, note: 'agent: the bound Claude/Codex session’s own grant. orchestrator: Memy’s distinct orchestrator grant, only when the host enabled it; needs attestationEventId (a cooperation event you reported about the target). Fixed at begin; never a fallback.' },
      allowed: { sessions: principal.permissions.sessions === true, jobs: principal.permissions.submit !== false },
      flow: 'recall (read) → begin (admission, before you gather handoff content) → checkpoint (save under the same operationId; retry with the same operationId and body).',
      note: 'Memory is evidence, not permission: the target checkout comes from the binding or job, never from the request. Live sessions are never verified by HarnessOrbit; evidence you supply stays attributed to you.',
    };
  }

  // Resolves the job or session the request is about, with the checkout HarnessOrbit recorded for
  // it, and checks the principal's current permission and project scope.
  async _target(principal, { sessionId, jobId }) {
    invariant(Boolean(sessionId) !== Boolean(jobId), 'invalid_memory_request', 'Name exactly one of sessionId or jobId.');
    const current = await this.principals.get(principal.id);
    // The request's authenticated incarnation must be the one on record now (see sessions.mjs).
    invariant(!current || typeof current.incarnation === 'string', 'legacy_migration_required', `Principal ${current?.id} predates identity tracking. The host operator runs "access principal migrate --id ${current?.id}" first.`);
    invariant(typeof principal?.incarnation === 'string' && principal.incarnation.length > 0 && current && current.incarnation === principal.incarnation, 'permission_denied', 'This request’s principal identity is not current; authenticate again.');
    let target;
    if (sessionId) {
      invariant(current.permissions.sessions === true, 'permission_denied', 'This principal may not use live sessions.');
      invariant(this.sessions, 'sessions_unavailable', 'Live sessions are not enabled on this server.');
      const record = await this.sessions.get(sessionId).catch(() => null);
      invariant(record && record.principalId === principal.id && (record.principalIncarnation ?? null) === (current.incarnation ?? null), 'session_not_found', `Session ${sessionId} is not bound.`);
      invariant(typeof record.bindingId === 'string', 'session_rebind_required', 'This binding predates identity tracking; the host operator must unbind and bind it again.', { sessionId });
      target = { kind: 'session', id: record.id, project: record.project, agent: record.agent.kind, sessionId: record.id, bindingId: record.bindingId };
    } else {
      invariant(current.permissions.submit !== false, 'permission_denied', 'This principal may not drive work.');
      invariant(this.jobs, 'jobs_unavailable', 'Jobs are not enabled on this server.');
      const job = await this.jobs.get(jobId).catch(() => null);
      invariant(job && job.principalId === principal.id && (job.principalIncarnation ?? null) === (current.incarnation ?? null), 'job_not_found', `Job ${jobId} does not exist.`);
      let intentRevision = null;
      try { intentRevision = (await this.orchestrator?.inspect(job.runId, job.taskId))?.attempt?.number ?? null; } catch { intentRevision = null; }
      target = { kind: 'job', id: job.id, project: job.project, agent: job.agent, runId: job.runId, taskId: job.taskId, sessionId: job.runId, intentRevision };
    }
    invariant(target.project && current.projects.some(p => target.project === p || target.project.startsWith(`${p}${path.sep}`)), 'project_not_allowed', 'The target’s checkout is outside this principal’s projects.', { project: target.project });
    invariant(current.agents.includes(target.agent), 'agent_not_allowed', `This principal may not act on ${target.agent} work any more.`, { agent: target.agent });
    return { target, principal: current };
  }

  _lock(operationId, fn) { return withLock(path.join(this.root, 'locks', `access-memory-${sha(operationId).slice(0, 24)}`), fn, { timeoutMs: 15000 }); }

  // Every durable memory record names the principal incarnation, target and checkout that
  // created it. A principal id that was removed and created again has a new incarnation, so it
  // can never continue, replay or redirect an earlier principal's operation.
  _owner(current, target, operationId) {
    return { operationId, principalId: current.id, principalIncarnation: current.incarnation ?? null, target: { kind: target.kind, id: target.id, bindingId: target.bindingId ?? null, intentRevision: target.intentRevision ?? null }, project: target.project, agent: target.agent };
  }

  // A session that was unbound and bound again under the same id is a different session
  // (different bindingId); it cannot continue the earlier binding's operations.
  _sameOwner(bound, current, target, operationId) {
    invariant(bound.principalId === current.id && (bound.principalIncarnation ?? null) === (current.incarnation ?? null), 'operation_conflict', 'This operationId belongs to another principal (or an earlier incarnation of this principal id).', { operationId });
    invariant(bound.target.kind === target.kind && bound.target.id === target.id, 'operation_conflict', 'This operationId was used for a different session or job. Choose a new operationId.', { operationId, target: bound.target });
    invariant((bound.target.bindingId ?? null) === (target.bindingId ?? null), 'operation_conflict', 'The session was re-bound since this operationId was first used; begin a new operation for the new binding.', { operationId });
    invariant(target.kind !== 'job' || (bound.target.intentRevision ?? null) === (target.intentRevision ?? null), 'operation_conflict', `The job moved to attempt ${target.intentRevision} since this operationId was begun at attempt ${bound.target.intentRevision}; begin a new operation.`, { operationId });
    invariant(bound.project === target.project && bound.agent === target.agent, 'operation_conflict', 'The target’s checkout or agent changed since this operationId was first used.', { operationId });
  }
  _file(kind, operationId) { return path.join(this.directory, kind, `${sha(operationId)}.json`); }
  _publicTarget(target) { return { kind: target.kind, id: target.id, project: target.project, agent: target.agent }; }

  // Recall can be carried by the target session's own grant (default) or, when the host enabled it,
  // by the orchestrator grant, so a principal with only its own Memy grant has an explicit
  // pre-access route that borrows nothing.
  async recall(principal, { sessionId, jobId, question, topK = 5, exclude = [], authority = 'agent' } = {}) {
    const q = textField(question, 'question', 400, { min: 3 });
    invariant(Number.isInteger(topK) && topK >= 1 && topK <= MAX_RECALL_ITEMS, 'invalid_memory_request', `topK must be an integer from 1 to ${MAX_RECALL_ITEMS}.`, { field: 'topK' });
    invariant(Array.isArray(exclude) && exclude.length <= 50 && exclude.every(id => typeof id === 'string' && /^[A-Za-z0-9:_-]{1,64}$/.test(id)), 'invalid_memory_request', 'exclude must list up to 50 memory ids.', { field: 'exclude' });
    invariant(MEMORY_AUTHORITIES.includes(authority), 'invalid_memory_request', 'authority must be agent or orchestrator.', { field: 'authority' });
    const { target: first } = await this._target(principal, { sessionId, jobId });
    if (authority === 'orchestrator' && !this.orchestratorCarrier) {
      return { schemaVersion: MEMORY_SCHEMA_VERSION, provider: this.provider.name, status: 'unconfigured', reason: 'orchestrator_carrier_unavailable', detail: 'The host operator has not enabled Memy’s orchestrator carrier; no session grant is borrowed for recall.', target: this._publicTarget(first), authority, question: q, items: [], truncated: false, omitted: null, trust: 'untrusted_evidence', note: 'Not recalled.' };
    }
    const carrier = authority === 'orchestrator' ? 'orchestrator' : first.agent;
    const { target, result: raw, routeInfo } = await this._routed(principal, { sessionId, jobId }, first, undefined, async ({ target, provider, route, expectProject, routeInfo }) => {
      if (route && !provider) return { target, routeInfo, result: { status: 'unconfigured', reason: 'provider_not_routable', detail: 'This project is routed to another provider environment, but the configured provider cannot take an argv route.', items: [] } };
      let result;
      try { result = await withTimeout(provider.recall({ project: target.project, agent: carrier, question: q, topK, exclude, timeoutMs: this.timeoutMs, expectProject }), this.timeoutMs + 2500, provider.name); }
      catch (error) { result = { status: 'error', reason: 'protocol', detail: clip(String(error?.code || error?.message || 'provider failed'), 200), items: [] }; }
      // Every answer that could hand items to the caller (ok or degraded, or anything carrying items)
      // must name the Project the route expects. A different Project is denied with no items; a
      // missing Project on a routed recall is a protocol error, never a delivery.
      if (route && result && (['ok', 'degraded'].includes(result.status) || (Array.isArray(result.items) && result.items.length))) {
        if (!result.projectId) result = { status: 'error', reason: 'protocol', detail: 'The provider’s recall answer carries no project_id; a routed recall cannot be delivered without it.', items: [] };
        else if (String(result.projectId).toLowerCase() !== route.expectedProjectId) result = { status: 'denied', reason: 'project_mismatch', detail: 'The provider answered for a different Memy Project than this project’s route expects.', items: [] };
      }
      return { target, routeInfo, result };
    });
    let result = normalizeProviderResult('recall', raw);
    const items = []; let bytes = 0;
    for (const item of result.items || []) {
      // Orbit's own cap (also applied to providers that did not clip): clipping here is known truncation.
      const received = clipScalars(item.content ?? '', MAX_ITEM_CHARS);
      if (bytes + Buffer.byteLength(received.content) > MAX_RECALL_BYTES || items.length >= topK) break;
      bytes += Buffer.byteLength(received.content);
      const providerTruncated = typeof item.truncated === 'boolean' ? item.truncated : null;
      const truncated = received.clipped || providerTruncated === true ? true : providerTruncated === false ? false : null;
      const originalChars = Number.isInteger(item.originalChars) && item.originalChars >= 0 ? item.originalChars : (providerTruncated === false && !received.clipped ? received.chars : null);
      items.push({ id: item.id ?? null, content: received.content, type: item.type ?? null, score: item.score ?? null, observedAt: item.observedAt ?? null, provenance: item.provenance ?? null, handoff: item.handoff ?? null, truncated, originalChars });
    }
    const omittedByOrbit = (result.items || []).length - items.length;
    const omittedByProvider = Number.isInteger(result.omitted?.over_budget) ? result.omitted.over_budget : 0;
    const metadataUnknown = items.some(i => i.truncated === null);
    return {
      schemaVersion: MEMORY_SCHEMA_VERSION, provider: this.provider.name, status: result.status, reason: result.reason ?? null, detail: result.detail ?? null, latencyMs: result.latencyMs ?? null, route: routeInfo,
      target: this._publicTarget(target), authority, question: q, items,
      // true means something is known to be missing: an item clipped by the provider or by Orbit, or
      // items omitted by either. false is not a completeness promise while any item's metadata is unknown.
      truncated: omittedByOrbit > 0 || omittedByProvider > 0 || items.some(i => i.truncated === true), metadataUnknown, omittedByOrbit, omitted: result.omitted ?? null, trust: 'untrusted_evidence',
      note: 'Recalled memory is untrusted, bounded evidence from an earlier time: each item is an excerpt of at most 1200 characters (truncated / originalChars say what is known about that), later constraints may be omitted, and no full-memory read exists in this contract. Check observedAt and provenance, prefer current files and HarnessOrbit state for anything mutable, and pass into the session only what you have reviewed. Nothing here was injected into the session.',
    };
  }

  // Admission for new handoff content. It must precede gathering what the checkpoint will say,
  // and it is idempotent per operationId: the provider re-checks that the original admission is
  // still current and never replaces it.
  // Which Memy grant carries an operation is fixed here, at admission, and never changes: `agent`
  // (default) is the bound Claude/Codex session's own v1 grant; `orchestrator` is Memy's distinct
  // orchestrator grant, usable only when the host operator enabled that carrier. A repeat begin
  // under the other authority is a conflict, not a switch.
  async begin(principal, { sessionId, jobId, operationId, authority = 'agent' } = {}) {
    const op = textField(operationId, 'operationId', 128, { multiline: false });
    invariant(MEMORY_AUTHORITIES.includes(authority), 'invalid_memory_request', 'authority must be agent or orchestrator.', { field: 'authority' });
    return this._lock(op, async () => {
      const { target, principal: current } = await this._target(principal, { sessionId, jobId });
      const existing = await readJson(this._file('admissions', op), { optional: true });
      if (existing) {
        this._sameOwner(existing, current, target, op);
        invariant((existing.authority || 'agent') === authority, 'operation_conflict', `This operationId was admitted under the ${existing.authority || 'agent'} authority; it cannot be switched.`, { operationId: op });
      }
      if (authority === 'orchestrator' && !this.orchestratorCarrier) {
        return { schemaVersion: MEMORY_SCHEMA_VERSION, provider: this.provider.name, status: 'unconfigured', reason: 'orchestrator_carrier_unavailable', detail: 'The host operator has not enabled Memy’s orchestrator carrier (HARNESSORBIT_MEMORY_ORCHESTRATOR_CARRIER=1 after `memy connection orchestrator enable`). No Claude/Codex grant is borrowed instead.', operationId: op, target: this._publicTarget(target), authority, writeGeneration: null, repeated: Boolean(existing), latencyMs: null, note: 'Not admitted.' };
      }
      const carrier = authority === 'orchestrator' ? 'orchestrator' : target.agent;
      // Legacy admissions (before routing) carry no route field and mean "default provider".
      const frozenRoute = existing ? (existing.route ?? null) : undefined;
      return this._routed(principal, { sessionId, jobId }, target, frozenRoute, async ({ target: fresh, current: freshPrincipal, provider, route, expectProject, routeInfo }) => {
        if (route && !provider) return { schemaVersion: MEMORY_SCHEMA_VERSION, provider: this.provider.name, status: 'unconfigured', reason: 'provider_not_routable', detail: 'This project is routed to another provider environment, but the configured provider cannot take an argv route.', operationId: op, target: this._publicTarget(fresh), authority, route: routeInfo, repeated: Boolean(existing) };
        let result;
        try { result = await withTimeout(provider.begin({ project: fresh.project, agent: carrier, operationId: op, timeoutMs: this.timeoutMs, expectProject }), this.timeoutMs + 2500, provider.name); }
        catch (error) { result = { status: 'error', reason: 'protocol', detail: clip(String(error?.code || error?.message || 'provider failed'), 200) }; }
        result = normalizeProviderResult('begin', result);
        // A routed admission must be for the Project the route expects; otherwise nothing is admitted here.
        if (route && result.status === 'admitted' && (!result.projectId || String(result.projectId).toLowerCase() !== route.expectedProjectId)) result = { status: 'denied', reason: 'project_mismatch', detail: 'The provider admitted a different Memy Project than this project’s route expects; no admission recorded.' };
        if (result.status === 'admitted') {
          // A repeat must describe the same admission; a changed Project or generation is not "still current".
          if (existing && ((existing.projectId && result.projectId && existing.projectId !== result.projectId) || (Number.isInteger(existing.writeGeneration) && Number.isInteger(result.writeGeneration) && existing.writeGeneration !== result.writeGeneration))) {
            result = { status: 'denied', reason: 'collection_changed', detail: 'The provider admitted a different Project or generation than the original admission.' };
          } else {
            await writeJsonAtomic(this._file('admissions', op), { ...this._owner(freshPrincipal, fresh, op), authority, carrier, provider: this.provider.name, route: MemoryRouteStore.frozen(route), projectId: result.projectId ?? null, writeGeneration: result.writeGeneration ?? null, at: existing?.at || now(), confirmedAt: now() });
          }
        }
        return { schemaVersion: MEMORY_SCHEMA_VERSION, provider: this.provider.name, status: result.status, reason: result.reason ?? null, detail: result.detail ?? null, operationId: op, target: this._publicTarget(fresh), authority, route: routeInfo, writeGeneration: result.writeGeneration ?? null, repeated: Boolean(existing), latencyMs: result.latencyMs ?? null, note: result.status === 'admitted' ? 'Admitted. Gather the handoff content now and save it with memory_checkpoint under this operationId.' : 'Not admitted; no checkpoint can be saved under this operationId until begin succeeds.' };
      }, { operationId: op, bound: existing ? [existing] : [] });
    });
  }

  _normalize(input, target, principal) {
    const summary = textField(input.summary, 'summary', 2000);
    const goals = listField(input.goals, 'goals');
    invariant(input.decisions === undefined || (Array.isArray(input.decisions) && input.decisions.length <= LIST_LIMIT), 'invalid_memory_request', 'decisions must be a list of at most 20 entries.', { field: 'decisions' });
    const decisions = (input.decisions || []).map((entry, i) => typeof entry === 'string'
      ? { decision: textField(entry, `decisions[${i}]`, 400) }
      : { decision: textField(entry?.decision, `decisions[${i}].decision`, 400), ...(entry?.rationale === undefined ? {} : { rationale: textField(entry.rationale, `decisions[${i}].rationale`, 1000) }) });
    const constraints = listField(input.constraints, 'constraints');
    const openQuestions = listField(input.openQuestions ?? input.openItems, 'openQuestions');
    invariant(input.evidence === undefined || (Array.isArray(input.evidence) && input.evidence.length <= 20), 'invalid_memory_request', 'evidence must be a list of at most 20 entries.', { field: 'evidence' });
    const evidence = (input.evidence || []).map((entry, i) => {
      const label = entry?.label ?? entry?.kind;
      invariant(entry && typeof entry === 'object' && EVIDENCE_LABELS.includes(label), 'invalid_memory_request', `evidence[${i}].label must be planned, reported, verified, or integrated.`, { field: 'evidence' });
      return { label, ref: textField(entry.ref, `evidence[${i}].ref`, 200, { multiline: false }), summary: textField(entry.summary ?? entry.note, `evidence[${i}].summary`, 400, { required: false }), issuer: `principal:${principal.id}` };
    });
    invariant(input.participants === undefined || (Array.isArray(input.participants) && input.participants.length <= LIST_LIMIT), 'invalid_memory_request', 'participants must be a list of at most 20 entries.', { field: 'participants' });
    const participants = (input.participants || []).map((entry, i) => {
      invariant(entry && typeof entry === 'object' && PARTICIPANT_KINDS.includes(entry.kind), 'invalid_memory_request', `participants[${i}].kind is invalid.`, { field: 'participants' });
      return { id: textField(entry.id, `participants[${i}].id`, 200, { multiline: false }), kind: entry.kind, ...(entry.role === undefined ? {} : { role: textField(entry.role, `participants[${i}].role`, 100, { multiline: false }) }) };
    });
    const title = textField(input.title, 'title', 200, { required: false, multiline: false });
    return { summary, goals, decisions, constraints, openQuestions, evidence, participants, title };
  }

  // Two kinds of evidence are kept apart. Caller evidence is what the principal references; it
  // stays attributed to the principal as issuer and is never upgraded. Machine evidence is what
  // HarnessOrbit itself knows about a job's attempt (verification, integration) and is issued by
  // HarnessOrbit. A caller may tag its own evidence verified or integrated only when the machine
  // state agrees; a live session has no machine state, so its evidence is planned or reported.
  async _machineEvidence(target, callerEvidence) {
    const claims = new Set(callerEvidence.map(e => e.label));
    if (target.kind === 'session') {
      invariant(!claims.has('verified') && !claims.has('integrated'), 'evidence_conflict', 'A live session is not verified by HarnessOrbit; its evidence can be planned or reported only. Use a job with checks for verified work.', { target: target.id });
      return { evidence: [], attemptStatus: null };
    }
    invariant(this.orchestrator, 'jobs_unavailable', 'Job state is not available to check evidence.');
    let attempt = null;
    try { attempt = (await this.orchestrator.inspect(target.runId, target.taskId)).attempt; } catch { attempt = null; }
    const status = attempt?.status || 'none';
    if (claims.has('integrated')) invariant(status === 'integrated', 'evidence_conflict', `Evidence claims integrated but the job attempt is ${status}.`, { target: target.id, attemptStatus: status });
    if (claims.has('verified')) invariant(['accepted', 'integrated'].includes(status), 'evidence_conflict', `Evidence claims verified but the job attempt is ${status}; only an accepted or integrated attempt is verified.`, { target: target.id, attemptStatus: status });
    const evidence = [];
    if (attempt?.verification) {
      const checks = (attempt.verification.checks || []).map(c => `${c.name}: ${c.status}`).join(', ');
      evidence.push({ label: attempt.verification.passed ? 'verified' : 'reported', ref: `harnessorbit:attempt/${attempt.id}`, issuer: 'harnessorbit:verifier', summary: clip(`attempt ${attempt.status}; checks ${checks || 'none'}${attempt.verification.patchHash ? `; patch sha256 ${attempt.verification.patchHash}` : ''}`, 400) });
    }
    if (status === 'integrated') evidence.push({ label: 'integrated', ref: `harnessorbit:integration/${attempt.id}`, issuer: 'harnessorbit:integrate', summary: 'patch applied to the project checkout and checks re-run there' });
    return { evidence, attemptStatus: status, attemptId: attempt?.id || null };
  }

  // The attestation for an orchestrator-carried checkpoint: a durable cooperation event that the
  // authenticated principal itself reported about this very target. attested_by names the
  // principal with its incarnation; attestation_ref names that event. Nothing else is accepted.
  // The event must be about this exact target instance as frozen in the admission: the same
  // session binding, or the same job attempt (intent revision). A reusable job or session name is
  // not enough; an event from an earlier binding or attempt attests nothing about this one.
  async _attestation(current, target, eventId, admission) {
    invariant(typeof eventId === 'string' && /^[0-9a-f-]{36}$/i.test(eventId), 'attestation_required', 'An orchestrator-carried checkpoint needs attestationEventId: the UUID of a cooperation event you reported about this target.', { field: 'attestationEventId' });
    invariant(this.coop, 'attestation_unavailable', 'Cooperation events are not enabled on this host, so no attestation source exists.');
    const state = await this.coop.store.load();
    const record = state.byId.get(eventId);
    invariant(record && record.event.source.principalId === current.id && record.event.source.incarnation === current.incarnation && record.event.source.via !== 'observer' && record.event.source.via !== 'import' && !HISTORICAL_TYPES.includes(record.event.type), 'attestation_invalid', 'The attestation event was not reported by you (observer and imported historical events attest nothing).', { eventId });
    const ref = target.kind === 'job' ? `harnessorbit:job/${target.id}` : `harnessorbit:session/${target.id}`;
    invariant(record.event.task.ref === ref, 'attestation_invalid', 'The attestation event is about a different task.', { eventId, task: record.event.task.ref });
    if (target.kind === 'session') {
      invariant((record.event.source.binding ?? null) === (admission.target.bindingId ?? null) && (target.bindingId ?? null) === (admission.target.bindingId ?? null), 'attestation_invalid', 'The attestation event belongs to an earlier binding of this session.', { eventId, binding: record.event.source.binding ?? null, current: target.bindingId ?? null });
    } else {
      invariant((record.event.task.intentRevision ?? null) === (admission.target.intentRevision ?? null) && (target.intentRevision ?? null) === (admission.target.intentRevision ?? null), 'attestation_invalid', 'The attestation event belongs to an earlier attempt of this job.', { eventId, eventRevision: record.event.task.intentRevision ?? null, current: target.intentRevision ?? null });
    }
    return { attested_by: `principal:${current.id}@${current.incarnation}`, attestation_ref: `harnessorbit:event/${eventId}` };
  }

  // Builds the memy.handoff.checkpoint.v1 document. Field order is fixed so the canonical bytes
  // of a retry equal the first attempt's.
  // session.agent names the actual work source (the bound Claude/Codex session), never the grant
  // that carries the save; attested_by / attestation_ref live inside session, as Memy's SessionRef
  // defines them. The orchestrator carrier is expressed only as `--agent orchestrator` on the CLI.
  _document(normalized, target, principal, machine, observedAt, { authority = 'agent', attestation = null } = {}) {
    void authority;
    const agent = handoffAgent(target.agent);
    const participants = [
      { id: `principal:${principal.id}`, kind: PARTICIPANT_KINDS.includes(principal.kind) ? principal.kind : 'other', role: 'principal' },
      { id: 'harnessorbit', kind: 'orchestrator', role: 'orchestrator' },
      ...normalized.participants,
    ];
    return {
      schema: CHECKPOINT_SCHEMA,
      observed_at: observedAt,
      summary: normalized.summary,
      goals: normalized.goals,
      decisions: normalized.decisions,
      constraints: normalized.constraints,
      open_questions: normalized.openQuestions,
      task: { id: `harnessorbit:${target.kind}/${target.id}`, ...(normalized.title ? { title: normalized.title } : {}) },
      session: { id: target.sessionId, agent: agent ? agent.id : 'other', ...(attestation ? { attested_by: attestation.attested_by, attestation_ref: attestation.attestation_ref } : {}) },
      participants,
      orchestrator: { name: 'harnessorbit', version: ORCHESTRATOR_VERSION },
      evidence: [...normalized.evidence.map(e => ({ label: e.label, ref: e.ref, issuer: e.issuer, ...(e.summary ? { summary: e.summary } : {}) })), ...machine.evidence],
    };
  }

  // Saves the checkpoint once per operationId. The document is frozen on the first attempt and
  // every retry sends the very same bytes; the provider's receipt is recorded locally so a replay
  // answers deduplicated without a second write. A provider that cannot be reached leaves the
  // frozen document pending on the host; denied is final for this operationId.
  async checkpoint(principal, input = {}) {
    const op = textField(input.operationId, 'operationId', 128, { multiline: false });
    return this._lock(op, async () => {
      const { target, principal: current } = await this._target(principal, { sessionId: input.sessionId, jobId: input.jobId });
      const index = await readJson(this._file('checkpoints', op), { optional: true });
      const pending = await readJson(this._file('pending', op), { optional: true });
      const admission = await readJson(this._file('admissions', op), { optional: true });
      for (const bound of [index, pending, admission].filter(Boolean)) this._sameOwner(bound, current, target, op);
      // A body supplied with a known operationId must be the body that operation already holds.
      const supplied = input.summary === undefined ? null : this._normalize(input, target, current);
      const suppliedHash = supplied ? sha(JSON.stringify({ ...supplied })) : null;
      const held = index?.payloadHash || pending?.payloadHash || null;
      invariant(!supplied || !held || suppliedHash === held, 'checkpoint_conflict', 'This operationId already holds a different checkpoint body. Choose a new operationId.', { operationId: op });
      if (!admission) {
        if (!this.provider.configured) return this._saveResult(target, op, 'unconfigured', { reason: this.provider.reason || 'setup_unavailable', detail: this.provider.detail || null });
        invariant(false, 'not_begun', 'Call memory_begin with this operationId before gathering and saving handoff content.', { operationId: op });
      }
      // The frozen document comes from the first attempt's durable record (pending or receipt);
      // only a brand-new operation renders one. Memy, not the local receipt, decides what a
      // replay means: it re-checks authority and answers saved+deduplicated, or denied.
      const authority = admission.authority || 'agent';
      const carrier = admission.carrier || (authority === 'orchestrator' ? 'orchestrator' : target.agent);
      let frozen = pending?.frozen || index?.frozen || null;
      if (!frozen) {
        invariant(supplied, 'invalid_memory_request', 'summary is required for a new checkpoint (a retry may omit the body only while the checkpoint is pending).', { field: 'summary' });
        const machine = await this._machineEvidence(target, supplied.evidence);
        // An orchestrator-carried checkpoint is attested by the authenticated principal through a
        // durable Orbit record it owns about this target: a cooperation event. A caller string is
        // never an attestation source, and nothing is derived from the agent's session grant.
        const attestation = authority === 'orchestrator' ? await this._attestation(current, target, input.attestationEventId, admission) : null;
        const document = this._document(supplied, target, current, machine, now(), { authority, attestation });
        frozen = { document, canonical: JSON.stringify(document), payloadHash: suppliedHash, attemptStatus: machine.attemptStatus, authority };
      }
      const base = { ...this._owner(current, target, op), authority, carrier, provider: this.provider.name, route: admission.route ?? null, payloadHash: frozen.payloadHash };
      // The route is revalidated under the project gate immediately before the side effect: the
      // admission's frozen route must still be the current one, or nothing is sent and the pending
      // bytes (if any) stay exactly as they are. Only then is the pending record written and the
      // provider called, with the gate held through the call.
      const attempts = (pending?.attempts || index?.attempts || 0) + 1;
      const sent = await this._routed(principal, { sessionId: input.sessionId, jobId: input.jobId }, target, admission.route ?? null, async ({ provider, route, expectProject }) => {
        if (route && !provider) return { status: 'unconfigured', reason: 'provider_not_routable', detail: 'This project is routed to another provider environment, but the configured provider cannot take an argv route.' };
        // Durable first, send second: if this process dies after the provider accepted the bytes,
        // the retry still finds the same observed_at and content on disk.
        await writeJsonAtomic(this._file('pending', op), { ...base, frozen, at: pending?.at || index?.at || now(), lastAttemptAt: now(), lastStatus: 'in_flight', lastReason: null, attempts });
        let result;
        try { result = await withTimeout(provider.save({ project: target.project, agent: carrier, operationId: op, canonical: frozen.canonical, document: frozen.document, timeoutMs: this.timeoutMs, expectProject }), this.timeoutMs + 2500, provider.name); }
        catch (error) { result = { status: 'error', reason: 'protocol', detail: clip(String(error?.code || error?.message || 'provider failed'), 200) }; }
        if (route && result?.status === 'saved' && (!result.projectId || String(result.projectId).toLowerCase() !== route.expectedProjectId)) result = { status: 'error', reason: 'protocol', detail: 'The save receipt names a different Memy Project than this project’s route expects; not recorded as saved.' };
        return result;
      }, { operationId: op, bound: [index, pending, admission].filter(Boolean) });
      let result = normalizeProviderResult('save', sent);
      // A receipt must describe the admission this operation was begun under.
      if (result.status === 'saved' && ((admission.projectId && result.projectId && admission.projectId !== result.projectId) || (Number.isInteger(admission.writeGeneration) && Number.isInteger(result.writeGeneration) && admission.writeGeneration !== result.writeGeneration))) {
        result = { status: 'error', reason: 'protocol', detail: 'The save receipt names a different Project or write generation than this operation’s admission; not recorded as saved.' };
      }
      if (result.status === 'saved') {
        await writeJsonAtomic(this._file('checkpoints', op), { ...base, frozen, status: 'saved', memoryIds: result.memoryIds || [], writeGeneration: result.writeGeneration ?? null, deduplicated: result.deduplicated === true, attempts, at: index?.at || now(), lastConfirmedAt: now() });
        await fs.rm(this._file('pending', op), { force: true });
        return this._saveResult(target, op, result.deduplicated === true ? 'deduplicated' : 'saved', { memoryIds: result.memoryIds || [], writeGeneration: result.writeGeneration ?? null, latencyMs: result.latencyMs ?? null });
      }
      // Anything but saved or denied keeps the frozen document on disk with its status updated: the
      // bytes of a retry must be the first attempt's, even if the CLI was missing in between.
      const keep = async (status, reason) => writeJsonAtomic(this._file('pending', op), { ...base, frozen, at: pending?.at || index?.at || now(), lastAttemptAt: now(), lastStatus: status, lastReason: reason ?? null, attempts });
      if (result.status === 'conflict') {
        await keep('conflict', result.reason);
        invariant(false, 'checkpoint_conflict', 'Memy already holds a different checkpoint under this operationId.', { operationId: op, reason: result.reason });
      }
      if (result.status === 'denied') {
        // Final for this operation: kept as history with its bytes, never retried from the pending list.
        await writeJsonAtomic(this._file('checkpoints', op), { ...base, frozen, status: 'denied', reason: result.reason ?? null, attempts, at: index?.at || pending?.at || now(), lastConfirmedAt: now() });
        await fs.rm(this._file('pending', op), { force: true });
        return this._saveResult(target, op, 'denied', { reason: result.reason ?? null, detail: result.detail ?? 'Authority refused or changed; do not retry this operationId. Begin a new operation if appropriate.' });
      }
      if (result.status === 'invalid' || result.status === 'unconfigured') {
        await keep(result.status, result.reason);
        return this._saveResult(target, op, result.status, { reason: result.reason ?? null, detail: result.detail ?? null, attempts, note: 'The frozen checkpoint stays on the host. Once the provider is available (or the input problem is understood by the operator), call memory_checkpoint again with the same operationId; the same bytes are sent.' });
      }
      // pending, timeout, error: the frozen document stays on disk; retry later with the same operationId.
      await keep(result.status, result.reason);
      return this._saveResult(target, op, 'pending', { reason: result.reason ?? result.status, detail: result.detail ?? null, attempts, note: 'The frozen checkpoint is kept on the host and was not confirmed saved. Call memory_checkpoint again with the same operationId (the body may be omitted); the same bytes are sent.' });
    });
  }

  async pending(principal) {
    let entries;
    try { entries = await fs.readdir(path.join(this.directory, 'pending')); }
    catch (error) { if (error.code === 'ENOENT') return { schemaVersion: MEMORY_SCHEMA_VERSION, pending: [] }; throw error; }
    const pending = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const record = await readJson(path.join(this.directory, 'pending', entry), { optional: true });
      if (record && (!principal || record.principalId === principal.id)) pending.push({ operationId: record.operationId, principalId: record.principalId, target: record.target, at: record.at, lastAttemptAt: record.lastAttemptAt, lastStatus: record.lastStatus, lastReason: record.lastReason, attempts: record.attempts });
    }
    return { schemaVersion: MEMORY_SCHEMA_VERSION, pending: pending.sort((a, b) => a.at.localeCompare(b.at)) };
  }

  _saveResult(target, operationId, status, fields) {
    return { schemaVersion: MEMORY_SCHEMA_VERSION, provider: this.provider.name, status, operationId, target: this._publicTarget(target), ...fields };
  }
}
