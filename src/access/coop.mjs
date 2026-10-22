import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OrchestratorError, invariant } from '../errors.mjs';
import { readJson, writeJsonAtomic, validateId, withLock, runPath } from '../state.mjs';

// Durable cooperation events: a bound agent reports what happened to a task it is authorized
// for; HarnessOrbit records the event once, durably, and delivers it to registered recipients,
// who read it from an inbox and acknowledge receipt. Transport acceptance, inbox receipt, a
// worker's own report, a HarnessOrbit check, independent verification and integration are
// distinct states; nothing here upgrades one into another. Events are untrusted external data
// for whoever reads them.
//
// Store identity and recovery (phase 2A). The store has one lineage identifier, its generation,
// and one committed boundary, kept in store.json and rewritten atomically after every mutation.
// The boundary names how many bytes and lines of journal.jsonl (events) and receipts.jsonl (acks
// and dispatch attempts) are committed, the sha of each log's last committed line, and the
// revision and sha of recipients.json. Log lines chain: each carries the sha of the line before
// it, so a committed prefix is fixed by its last sha. Opening the store verifies all three files
// against the boundary under the store lock and fails closed on anything shorter or different
// inside it (rolled back, corrupt); lines beyond the boundary are the crash window between an
// append and its commit and are adopted when they chain, while an incomplete final fragment is
// removed and a complete row with a bad checksum or chain is corruption, never repaired. A
// recipient replacement persists a small mutation intent (pre-image, exact post-image) before the
// file is replaced, so a crash in between rolls forward the frozen operation instead of
// regenerating epochs. A new store is created only by explicit host initialisation and a store
// from before this protocol only by an explicit, resumable, stopped-writer migration; remote
// calls never recreate an empty store. The fault model is process crash; the existing atomic
// writer already syncs file and directory, and no power-loss claim is made.

export const COOP_SCHEMA = 'harnessorbit.coop.event.v1';
export const COOP_VERSION = 1;
export const STORE_SCHEMA = 'harnessorbit.coop.store.v2';
export const INTENT_SCHEMA = 'harnessorbit.coop.intent.v1';
export const REPORTABLE_TYPES = Object.freeze(['work.reported', 'task.blocked', 'verification.requested', 'question.asked', 'handoff.offered']);
export const OBSERVER_TYPES = Object.freeze(['agent.turn_finished', 'session.ready']);
export const VERIFIER_TYPES = Object.freeze(['verification.passed', 'verification.failed', 'task.integrated']);
export const RECIPIENT_KINDS = Object.freeze(['inbox', 'grok-native-webhook', 'codex-app-server']);
export const DELIVERY_STATES = Object.freeze(['pending', 'accepted', 'acknowledged', 'unknown', 'failed', 'revoked', 'dead']);
export const MAX_PAYLOAD_BYTES = 8192;
export const MAX_INBOX_LIMIT = 200;
export const MAX_HOPS = 8;
export const MAX_CURSOR_TOKEN = 400;
// Historical facts imported by the host from a managed source. Never reportable, never a verifier
// or observer signal, never an attestation; delivered only to recipients that name the type.
export const HISTORICAL_TYPES = Object.freeze(['history.imported']);
export const IMPORT_LINEAGE = 'harnessorbit.run-events.v1';
export const IMPORTABLE_TYPES = Object.freeze(['attempt.reserved', 'attempt.state']);
export const IMPORT_CAPS = Object.freeze({ maxRowBytes: 65536, captureLimit: 8 * 1048576, maxPrefixBytes: 64 * 1048576 });
const IMPORT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_:.-]{0,159}$/;
const IMPORT_TUPLE = ['id', 'runId', 'taskId', 'principalId', 'principalIncarnation'];
const sameTuple = (a, b) => Boolean(a && b) && IMPORT_TUPLE.every(k => a[k] === b[k]);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function textField(value, field, max, { required = true, min = 1, multiline = false } = {}) {
  if (value === undefined || value === null) { invariant(!required, 'invalid_event', `${field} is required.`, { field }); return null; }
  invariant(typeof value === 'string', 'invalid_event', `${field} must be a string.`, { field });
  const trimmed = value.trim();
  invariant(trimmed.length >= min && trimmed.length <= max, 'invalid_event', `${field} must be ${min} to ${max} characters.`, { field });
  invariant(!CONTROL.test(trimmed) && (multiline || !/[\n\t]/.test(trimmed)), 'invalid_event', `${field} must not contain control characters.`, { field });
  return trimmed;
}

// Payloads are bounded plain data: depth ≤ 3, strings ≤ 2000 chars, ≤ 8 KiB serialized, no
// functions or binary. They are carried, never interpreted as instructions.
export function boundedPayload(value, field = 'payload', depth = 0) {
  if (value === null || ['boolean', 'number'].includes(typeof value)) { invariant(typeof value !== 'number' || Number.isFinite(value), 'invalid_event', `${field} must be finite.`); return value; }
  if (typeof value === 'string') { invariant(value.length <= 2000 && !CONTROL.test(value), 'invalid_event', `${field} strings must be at most 2000 characters without control characters.`, { field }); return value; }
  invariant(depth < 3, 'invalid_event', `${field} nests too deeply (max depth 3).`, { field });
  if (Array.isArray(value)) { invariant(value.length <= 50, 'invalid_event', `${field} lists are limited to 50 entries.`, { field }); return value.map((v, i) => boundedPayload(v, `${field}[${i}]`, depth + 1)); }
  invariant(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, 'invalid_event', `${field} must be plain JSON data.`, { field });
  const keys = Object.keys(value);
  invariant(keys.length <= 50, 'invalid_event', `${field} objects are limited to 50 keys.`, { field });
  const out = {};
  for (const key of keys.sort()) { invariant(/^[A-Za-z0-9_.-]{1,64}$/.test(key), 'invalid_event', `${field} has an invalid key.`, { field, key }); out[key] = boundedPayload(value[key], `${field}.${key}`, depth + 1); }
  return out;
}

function canonical(value) { return JSON.stringify(value); }
// Key-sorted canonical form of a persisted source row, so every field (known or not) is in its hash.
function canonicalRow(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalRow).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalRow(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const EMPTY_SHA = crypto.createHash('sha256').update('').digest('hex');
// A zero-length prefix hashes to sha256(""); a persisted null from an earlier record means the same.
const sameSha = (stored, computed) => stored === computed || (stored === null && computed === EMPTY_SHA);

// The exact bytes writeJsonAtomic produces for a JSON document, so a sha recorded before a
// replacement names the file that will exist after it.
export function jsonFileBytes(value) { return `${JSON.stringify(value, null, 2)}\n`; }
const genesis = generation => `genesis:${generation}`;

// Parses one journal line. A record's sha covers everything but the sha itself, including `prev`.
// `parseable` separates a complete JSON row that fails its checksum (corruption, whatever follows
// it) from bytes that are not a row at all (an interrupted append, repairable only at the tail).
function parseLine(raw) {
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, parseable: false }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, parseable: false };
  const { sha: stored, ...rest } = parsed;
  if (typeof stored !== 'string' || sha(canonical(rest)) !== stored) return { ok: false, parseable: true };
  return { ok: true, parseable: true, record: rest, sha: stored, prev: typeof rest.prev === 'string' ? rest.prev : null };
}

// Append-only logs with a per-line checksum and, from this protocol on, a per-line chain.
class Journal {
  constructor(file) { this.file = file; this.name = path.basename(file); }

  // The whole file split into lines with byte offsets. Volumes are small (one host).
  async scan() {
    let text;
    try { text = await fs.readFile(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { exists: false, text: '', size: 0, lines: [] }; throw error; }
    const lines = [];
    let at = 0, offset = 0;
    while (at < text.length) {
      const nl = text.indexOf('\n', at);
      const raw = nl < 0 ? text.slice(at) : text.slice(at, nl);
      const terminated = nl >= 0;
      const end = offset + Buffer.byteLength(raw) + (terminated ? 1 : 0);
      lines.push({ raw, terminated, start: offset, end, index: lines.length });
      offset = end; at = terminated ? nl + 1 : text.length;
    }
    return { exists: true, text, size: Buffer.byteLength(text), lines };
  }

  // Read-only view of the valid records (no verification against a boundary, no repair).
  async load() {
    const scanned = await this.scan();
    const records = [];
    for (const line of scanned.lines) { const parsed = parseLine(line.raw); if (parsed.ok) records.push(parsed.record); }
    return { records };
  }

  // Checks the file against the committed boundary. Inside the boundary nothing may differ; beyond
  // it, chained rows are the crash window and may be adopted, an incomplete final fragment may be
  // removed, and a complete row that fails its checksum or chain is corruption.
  async verify({ anchor, legacy = { lines: 0, bytes: 0, sha: null }, committed = { lines: 0, bytes: 0, lastSha: null } }) {
    const scanned = await this.scan();
    const out = { size: scanned.size, records: [], lines: 0, bytes: 0, lastSha: anchor, excess: 0, repair: null, problem: null };
    const fail = (kind, detail) => { out.problem = { kind, detail }; return out; };
    if (legacy.bytes) {
      if (scanned.size < legacy.bytes) return fail('rolled_back', `${this.name} is shorter than its legacy baseline`);
      if (sha(Buffer.from(scanned.text, 'utf8').subarray(0, legacy.bytes)) !== legacy.sha) return fail('rolled_back', `${this.name} legacy baseline differs from the recorded one`);
    }
    let prev = anchor;
    for (const line of scanned.lines) {
      const i = line.index;
      const inCommitted = i < committed.lines;
      const parsed = parseLine(line.raw);
      if (!parsed.ok) {
        if (inCommitted) return fail('rolled_back', `${this.name} line ${i + 1} inside the committed boundary is not intact`);
        // Parseable JSON is a complete row whatever follows it: a checksum failure there is corruption.
        if (parsed.parseable || line.terminated || i !== scanned.lines.length - 1) return fail('corrupt', `${this.name} line ${i + 1} is a complete row with a bad checksum`);
        out.repair = { truncateTo: line.start, droppedLine: i + 1 }; // genuinely incomplete final fragment beyond the committed prefix
        break;
      }
      if (i >= legacy.lines && parsed.prev !== prev) {
        if (inCommitted) return fail('rolled_back', `${this.name} line ${i + 1} inside the committed boundary does not chain`);
        return fail('corrupt', `${this.name} line ${i + 1} does not chain to the line before it (a nonconforming write)`);
      }
      if (!line.terminated) {
        if (inCommitted) return fail('rolled_back', `${this.name} committed line ${i + 1} lost its delimiter`);
        out.repair = { addDelimiter: true }; // a complete, valid row whose newline never landed: kept
      }
      out.records.push(parsed.record); prev = parsed.sha; out.lines = i + 1; out.bytes = line.terminated ? line.end : line.end + 1; out.lastSha = parsed.sha;
      if (i + 1 === committed.lines && (line.end !== committed.bytes || parsed.sha !== committed.lastSha)) return fail('rolled_back', `${this.name} committed prefix differs from the boundary`);
    }
    if (out.lines < committed.lines) return fail('rolled_back', `${this.name} has fewer lines than the committed boundary`);
    out.excess = out.lines - committed.lines;
    return out;
  }

  async applyRepair(repair) {
    if (!repair) return null;
    if (repair.addDelimiter) { await fs.appendFile(this.file, '\n', { mode: 0o600 }); return { addedDelimiter: true }; }
    await fs.truncate(this.file, repair.truncateTo);
    return { droppedTornTail: true, line: repair.droppedLine };
  }

  // Appends one chained line. The caller holds the store lock and commits the boundary afterwards.
  async append(record, prev) {
    const body = { ...record, prev };
    const line = `${canonical({ ...body, sha: sha(canonical(body)) })}\n`;
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.appendFile(this.file, line, { mode: 0o600 });
    return { sha: sha(canonical(body)), bytes: Buffer.byteLength(line) };
  }
}

function boundaryOf(fields) {
  const boundary = { eventSeq: fields.eventSeq, eventLines: fields.eventLines, eventBytes: fields.eventBytes, eventLastSha: fields.eventLastSha, receiptLines: fields.receiptLines, receiptBytes: fields.receiptBytes, receiptLastSha: fields.receiptLastSha, recipientsRevision: fields.recipientsRevision, recipientsSha: fields.recipientsSha, retentionFloor: fields.retentionFloor, updatedAt: fields.updatedAt };
  return { ...boundary, sha: sha(canonical(boundary)) };
}

function storeError(code, message, details) { return new OrchestratorError(code, message, details); }

export class CoopStore {
  constructor({ root } = {}) {
    invariant(typeof root === 'string' && root.length > 0, 'invalid_state_root', 'Coop store root is required.');
    this.root = path.resolve(root);
    this.directory = path.join(this.root, 'access', 'coop');
    this.journal = new Journal(path.join(this.directory, 'journal.jsonl'));
    this.receipts = new Journal(path.join(this.directory, 'receipts.jsonl'));
    this.recipientsFile = path.join(this.directory, 'recipients.json');
    this.intentFile = path.join(this.directory, 'recipients.intent.json');
    this.storeFile = path.join(this.directory, 'store.json');
  }

  lock(fn) { return withLock(path.join(this.root, 'locks', 'access-coop'), fn, { timeoutMs: 15000 }); }

  // Recovering read under the store lock: the only way to see the current state from outside.
  load() { return this.lock(() => this.open()); }

  async recipients() {
    const stored = await readJson(this.recipientsFile, { optional: true });
    return stored?.recipients || {};
  }

  async _readText(file) {
    try { return await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  // Without store.json the root is one of: never initialised, a legacy (pre-protocol) store, or an
  // initialised store whose metadata disappeared. None of them is an empty store.
  async _classifyWithoutControl() {
    const [journal, receipts, recipientsText, intent] = await Promise.all([this.journal.scan(), this.receipts.scan(), this._readText(this.recipientsFile), this._readText(this.intentFile)]);
    let recipientsDoc = null;
    try { recipientsDoc = recipientsText ? JSON.parse(recipientsText) : null; } catch { recipientsDoc = { invalid: true }; }
    const chained = [...journal.lines, ...receipts.lines].some(line => { try { return typeof JSON.parse(line.raw)?.prev === 'string'; } catch { return false; } });
    if (intent !== null || chained || typeof recipientsDoc?.generation === 'string') return { status: 'store_metadata_missing', operatorAction: 'The data files carry store-v2 markers but store.json is missing: restore store.json from backup. Do not run init or migrate on this root.' };
    if (journal.size === 0 && receipts.size === 0 && recipientsText === null) return { status: 'store_uninitialized', operatorAction: 'Initialise the cooperation store on the host: access coop store init' };
    return { status: 'legacy_migration_required', operatorAction: 'This store predates the store protocol. Stop every writer (access serve, access coop dispatch, access observe), keep them stopped, then run: access coop store migrate --from-v1' };
  }

  async _control() {
    const control = await readJson(this.storeFile, { optional: true });
    if (!control) { const c = await this._classifyWithoutControl(); throw storeError(c.status, c.operatorAction, { status: c.status, operatorAction: c.operatorAction }); }
    invariant(control.schema === STORE_SCHEMA && typeof control.generation === 'string', 'store_unsupported_version', `store.json is not ${STORE_SCHEMA}; this binary cannot use it.`, { status: 'store_unsupported_version', operatorAction: 'Use a binary that understands this store version.' });
    if (control.migration?.state === 'in_progress') throw storeError('migration_in_progress', control.migration.from === 'init' ? 'Store initialisation was interrupted; finish it before using the store.' : 'A store migration was interrupted; finish it before using the store.', { status: 'migration_in_progress', from: control.migration.from, phase: control.migration.phase, operatorAction: control.migration.from === 'init' ? 'On the host: rerun access coop store init (it replays the saved plan)' : 'With writers stopped: access coop store migrate --resume' });
    const { sha: stored, ...boundary } = control.boundary || {};
    invariant(typeof stored === 'string' && sha(canonical(boundary)) === stored, 'store_metadata_invalid', 'store.json carries a boundary that does not match its checksum.', { status: 'store_metadata_invalid', operatorAction: 'Restore store.json from backup.' });
    return control;
  }

  _legacy(control, kind) {
    const base = control.migration?.baseline;
    if (!base) return { lines: 0, bytes: 0, sha: null };
    return kind === 'events' ? { lines: base.eventLines, bytes: base.eventBytes, sha: base.eventsSha } : { lines: base.receiptLines, bytes: base.receiptBytes, sha: base.receiptsSha };
  }

  _anchor(control, kind) {
    const base = control.migration?.baseline;
    if (kind === 'events') return base?.eventLines ? base.eventLastSha : genesis(control.generation);
    return base?.receiptLines ? base.receiptLastSha : genesis(control.generation);
  }

  // Pure examination: verifies every file against the boundary and reports what open() would do,
  // without writing. Used by open() and by the operator's inspect.
  async _examine() {
    const control = await this._control();
    const b = control.boundary;
    const events = await this.journal.verify({ anchor: this._anchor(control, 'events'), legacy: this._legacy(control, 'events'), committed: { lines: b.eventLines, bytes: b.eventBytes, lastSha: b.eventLastSha } });
    const receipts = await this.receipts.verify({ anchor: this._anchor(control, 'receipts'), legacy: this._legacy(control, 'receipts'), committed: { lines: b.receiptLines, bytes: b.receiptBytes, lastSha: b.receiptLastSha } });
    const recipientsText = await this._readText(this.recipientsFile);
    const intent = await readJson(this.intentFile, { optional: true });
    const recipientsSha = recipientsText === null ? null : sha(recipientsText);
    let recipientsDoc = null;
    try { recipientsDoc = recipientsText === null ? null : JSON.parse(recipientsText); } catch { recipientsDoc = null; }
    const recipients = { sha: recipientsSha, doc: recipientsDoc, intent, action: null, problem: null };
    if (intent) {
      // The intent must describe one replacement: a well-formed post-image whose revision follows its
      // pre-image. The boundary then says how far that replacement got: still at pre (roll forward
      // from pre, or commit from post), or already at post (committed; only the intent is left to
      // remove). Every other combination is fail-closed.
      const wellFormed = intent.schema === INTENT_SCHEMA && intent.generation === control.generation && intent.pre && typeof intent.pre.sha === 'string' && Number.isInteger(intent.pre.revision) && intent.post && typeof intent.post.sha === 'string' && intent.post.revision === intent.pre.revision + 1 && intent.post.content && sha(jsonFileBytes(intent.post.content)) === intent.post.sha && intent.post.content.revision === intent.post.revision && intent.post.content.generation === control.generation;
      const boundaryAtPre = wellFormed && b.recipientsSha === intent.pre.sha && b.recipientsRevision === intent.pre.revision;
      const boundaryAtPost = wellFormed && b.recipientsSha === intent.post.sha && b.recipientsRevision === intent.post.revision;
      if (!wellFormed || !(boundaryAtPre || boundaryAtPost)) recipients.problem = { kind: 'corrupt', detail: 'recipients.intent.json does not describe a replacement of the committed recipients file' };
      else if (boundaryAtPre && recipientsSha === intent.pre.sha) recipients.action = 'roll_forward';
      else if (boundaryAtPre && recipientsSha === intent.post.sha) recipients.action = 'complete';
      else if (boundaryAtPost && recipientsSha === intent.post.sha) recipients.action = 'cleanup';
      else recipients.problem = { kind: 'corrupt', detail: boundaryAtPost ? 'recipients.json is not the committed post-image although its replacement was committed' : 'recipients.json matches neither the pre-image nor the post-image of the pending replacement' };
    } else if (recipientsSha !== b.recipientsSha) recipients.problem = { kind: 'rolled_back', detail: 'recipients.json differs from the committed boundary' };
    else if (!recipientsDoc || recipientsDoc.generation !== control.generation || recipientsDoc.revision !== b.recipientsRevision) recipients.problem = { kind: 'corrupt', detail: 'recipients.json does not carry the store generation and committed revision' };
    return { control, events, receipts, recipients };
  }

  _raise(result, file, { rolledBack, corrupt }) {
    if (!result.problem) return;
    const code = result.problem.kind === 'rolled_back' ? rolledBack : corrupt;
    const operatorAction = result.problem.kind === 'rolled_back' ? `Inspect the store (access coop store inspect) and restore ${file} from a backup taken at or after the committed boundary; the store stays read-only until then.` : `Inspect the store (access coop store inspect) and restore ${file} from backup; the invalid row is never repaired in place.`;
    throw storeError(code, `${result.problem.detail}.`, { status: code, operatorAction, file });
  }

  // Open-and-recover. The caller holds the store lock. Fails closed on anything inside the committed
  // boundary; adopts chained rows beyond it; rolls a pending recipient replacement forward; and
  // commits the resulting boundary before returning, so no caller sees a half-recovered store.
  async open() {
    const examined = await this._examine();
    let { control } = examined;
    this._raise(examined.events, 'journal.jsonl', { rolledBack: 'store_rolled_back', corrupt: 'journal_corrupt' });
    this._raise(examined.receipts, 'receipts.jsonl', { rolledBack: 'receipts_rolled_back', corrupt: 'receipts_corrupt' });
    this._raise({ problem: examined.recipients.problem }, 'recipients.json', { rolledBack: 'recipients_rolled_back', corrupt: 'recipients_corrupt' });
    const recovered = { journal: null, receipts: null, recipients: null };
    const patch = {};
    recovered.journal = await this.journal.applyRepair(examined.events.repair);
    recovered.receipts = await this.receipts.applyRepair(examined.receipts.repair);
    if (examined.events.excess) { recovered.journal = { ...(recovered.journal || {}), adoptedLines: examined.events.excess }; Object.assign(patch, { eventSeq: examined.events.records.at(-1).seq, eventLines: examined.events.lines, eventBytes: examined.events.bytes, eventLastSha: examined.events.lastSha }); }
    if (examined.receipts.excess) { recovered.receipts = { ...(recovered.receipts || {}), adoptedLines: examined.receipts.excess }; Object.assign(patch, { receiptLines: examined.receipts.lines, receiptBytes: examined.receipts.bytes, receiptLastSha: examined.receipts.lastSha }); }
    let recipientsDoc = examined.recipients.doc;
    const { intent, action } = examined.recipients;
    if (intent && action !== 'cleanup') {
      if (action === 'roll_forward') await writeJsonAtomic(this.recipientsFile, intent.post.content);
      recipientsDoc = intent.post.content;
      recovered.recipients = { [action === 'roll_forward' ? 'rolledForward' : 'completed']: true, revision: intent.post.revision };
      Object.assign(patch, { recipientsRevision: intent.post.revision, recipientsSha: intent.post.sha });
    }
    if (Object.keys(patch).length || recovered.journal || recovered.receipts || recovered.recipients) control = await this._commit(control, patch, { recovery: { at: now(), ...recovered } });
    // Cleanup window: the replacement was already committed; only the matching intent is removed.
    // Nothing is written to store.json, the logs or the recipients file.
    if (intent) { await fs.unlink(this.intentFile).catch(() => {}); if (action === 'cleanup') recovered.recipients = { cleanedUp: true, revision: intent.post.revision }; }
    const byId = new Map(); const byKey = new Map();
    for (const record of examined.events.records) { byId.set(record.event.eventId, record); byKey.set(`${record.idempotency.principalId}:${record.idempotency.incarnation}:${record.idempotency.keyHash}`, record); }
    const acks = new Map(); const attempts = new Map();
    for (const receipt of examined.receipts.records) {
      const key = `${receipt.eventId}:${receipt.consumerId}`;
      if (receipt.kind === 'ack') { if (!acks.has(key)) acks.set(key, receipt); }
      else if (receipt.kind === 'attempt') attempts.set(key, receipt);
    }
    return {
      control, generation: control.generation, boundary: control.boundary, records: examined.events.records, byId, byKey, acks, attempts, receipts: examined.receipts.records, recipients: recipientsDoc?.recipients || {}, recipientsDoc,
      recovered, lastRecovery: control.lastRecovery || null, retentionFloor: control.boundary.retentionFloor, nextSeq: examined.events.records.length ? examined.events.records.at(-1).seq + 1 : 1,
    };
  }

  // Read-only view for a dry run: the committed records only, no recovery, no writes. Callers check
  // examined.* for pending recovery first.
  static readOnlyState(examined) {
    const byId = new Map(); const byKey = new Map();
    for (const record of examined.events.records) { byId.set(record.event.eventId, record); byKey.set(`${record.idempotency.principalId}:${record.idempotency.incarnation}:${record.idempotency.keyHash}`, record); }
    return { control: examined.control, generation: examined.control.generation, boundary: examined.control.boundary, records: examined.events.records, byId, byKey, receipts: examined.receipts.records, recipients: examined.recipients.doc?.recipients || {}, nextSeq: examined.events.records.length ? examined.events.records.at(-1).seq + 1 : 1, readOnly: true };
  }

  static pendingRecovery(examined) {
    const e = examined.events, r = examined.receipts, p = examined.recipients;
    const pending = { journal: e.problem || e.repair || (e.excess ? { adopt: e.excess } : null) || null, receipts: r.problem || r.repair || (r.excess ? { adopt: r.excess } : null) || null, recipients: p.problem || p.action || (p.intent ? { intent: true } : null) || null };
    return Object.values(pending).some(Boolean) ? pending : null;
  }

  async _commit(control, patch, { recovery } = {}) {
    const { sha: _ignored, ...current } = control.boundary;
    const boundary = boundaryOf({ ...current, ...patch, updatedAt: now() });
    const next = { ...control, boundary, ...(recovery !== undefined ? { lastRecovery: recovery } : {}) };
    await writeJsonAtomic(this.storeFile, next);
    return next;
  }

  // Mutations. Each appends (or replaces) and then commits the boundary; the state object is
  // updated in place so a caller can continue under the same lock.
  async appendEvent(state, record) {
    const b = state.control.boundary;
    const { sha: lineSha, bytes } = await this.journal.append(record, b.eventLines ? b.eventLastSha : this._anchor(state.control, 'events'));
    state.control = await this._commit(state.control, { eventSeq: record.seq, eventLines: b.eventLines + 1, eventBytes: b.eventBytes + bytes, eventLastSha: lineSha });
    state.boundary = state.control.boundary; state.nextSeq = record.seq + 1;
    // Index only after the boundary commit, so a later row in the same lock finds this one by key
    // and id; a failed append throws before this point and is never treated as committed.
    state.records.push(record); state.byId.set(record.event.eventId, record); state.byKey.set(`${record.idempotency.principalId}:${record.idempotency.incarnation}:${record.idempotency.keyHash}`, record);
    return record;
  }

  async appendReceipt(state, receipt) {
    const b = state.control.boundary;
    const { sha: lineSha, bytes } = await this.receipts.append(receipt, b.receiptLines ? b.receiptLastSha : this._anchor(state.control, 'receipts'));
    state.control = await this._commit(state.control, { receiptLines: b.receiptLines + 1, receiptBytes: b.receiptBytes + bytes, receiptLastSha: lineSha });
    state.boundary = state.control.boundary;
    if (Array.isArray(state.receipts)) state.receipts.push(receipt);
    return receipt;
  }

  // Intent first (pre-image and exact post-image), then the replacement, then the boundary; the
  // intent is removed last. open() rolls an interrupted replacement forward from either image.
  async replaceRecipients(state, recipients) {
    const b = state.control.boundary;
    const content = { schemaVersion: COOP_VERSION, generation: state.generation, revision: b.recipientsRevision + 1, recipients };
    const post = { revision: content.revision, sha: sha(jsonFileBytes(content)), content };
    await writeJsonAtomic(this.intentFile, { schema: INTENT_SCHEMA, generation: state.generation, at: now(), pre: { revision: b.recipientsRevision, sha: b.recipientsSha }, post });
    await writeJsonAtomic(this.recipientsFile, content);
    state.control = await this._commit(state.control, { recipientsRevision: post.revision, recipientsSha: post.sha });
    state.boundary = state.control.boundary; state.recipients = recipients; state.recipientsDoc = content;
    await fs.unlink(this.intentFile);
    return content;
  }

  // Host-only. The one-generation init plan (the expected recipients image) is persisted in
  // store.json before any data file exists; then the expected empty files are created; then the
  // boundary completes. Rerunning init replays the saved plan with the same generation and refuses
  // any file that does not match it. A root that already holds data is never adopted.
  init() {
    return this.lock(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const control = await readJson(this.storeFile, { optional: true });
      if (control) {
        invariant(control.schema === STORE_SCHEMA && control.migration?.state === 'in_progress' && control.migration.from === 'init', 'store_initialized', 'The cooperation store is already initialised.', { status: 'store_initialized' });
        return this._resumeInit(control);
      }
      const classified = await this._classifyWithoutControl();
      invariant(classified.status === 'store_uninitialized', 'store_not_empty', `This root is not empty (${classified.status}). ${classified.operatorAction}`, { status: classified.status, operatorAction: classified.operatorAction });
      const generation = uuid(); const at = now();
      const content = { schemaVersion: COOP_VERSION, generation, revision: 0, recipients: {} };
      const plan = { schema: STORE_SCHEMA, generation, initializedAt: at, migration: { state: 'in_progress', from: 'init', phase: 'prepared', startedAt: at, completedAt: null, baseline: null, repair: null, expected: { recipientsSha: sha(jsonFileBytes(content)), recipientsContent: content } }, boundary: null, lastRecovery: null };
      await writeJsonAtomic(this.storeFile, plan);
      return this._resumeInit(plan);
    });
  }

  async _resumeInit(control) {
    const expected = control.migration.expected;
    const blocked = detail => storeError('init_blocked', `${detail}; the saved init plan cannot be applied. Inspect the store and restore the root to its state when init was prepared.`, { status: 'init_blocked', operatorAction: 'access coop store inspect; remove or restore the unexpected file; rerun access coop store init' });
    const [journal, receipts, recipientsText, intent] = await Promise.all([this.journal.scan(), this.receipts.scan(), this._readText(this.recipientsFile), this._readText(this.intentFile)]);
    if (journal.size !== 0) throw blocked('journal.jsonl is not empty');
    if (receipts.size !== 0) throw blocked('receipts.jsonl is not empty');
    if (intent !== null) throw blocked('recipients.intent.json exists');
    await fs.writeFile(this.journal.file, '', { flag: 'a', mode: 0o600 });
    await fs.writeFile(this.receipts.file, '', { flag: 'a', mode: 0o600 });
    if (recipientsText === null) await writeJsonAtomic(this.recipientsFile, expected.recipientsContent);
    else if (sha(recipientsText) !== expected.recipientsSha) throw blocked('recipients.json does not match the planned image');
    const at = now();
    const boundary = boundaryOf({ eventSeq: 0, eventLines: 0, eventBytes: 0, eventLastSha: null, receiptLines: 0, receiptBytes: 0, receiptLastSha: null, recipientsRevision: 0, recipientsSha: expected.recipientsSha, retentionFloor: 0, updatedAt: at });
    await writeJsonAtomic(this.storeFile, { ...control, migration: { ...control.migration, state: 'none', phase: 'complete', completedAt: at }, boundary });
    return { generation: control.generation, initialized: true };
  }

  // Verifies a pre-protocol log: every row intact, no chain required. Only an incomplete final
  // fragment or a missing final delimiter may be repaired; the baseline describes the repaired file.
  _legacyLog(scanned, { events = false } = {}) {
    const out = { records: [], lines: 0, bytes: 0, lastSha: null, repair: null };
    for (const line of scanned.lines) {
      const parsed = parseLine(line.raw);
      if (!parsed.ok) {
        invariant(!parsed.parseable && !line.terminated && line.index === scanned.lines.length - 1, 'legacy_prefix_invalid', `Legacy log has a complete row with a bad checksum at line ${line.index + 1}; nothing is migrated.`, { status: 'legacy_prefix_invalid', line: line.index + 1 });
        out.repair = { truncateTo: line.start, droppedLine: line.index + 1 }; break;
      }
      invariant(parsed.prev === null, 'store_metadata_missing', 'A chained row exists in a store without store.json; restore store.json from backup instead of migrating.', { status: 'store_metadata_missing' });
      if (!line.terminated) out.repair = { addDelimiter: true };
      out.records.push(parsed.record); out.lines = line.index + 1; out.bytes = line.terminated ? line.end : line.end + 1; out.lastSha = parsed.sha;
    }
    if (events) {
      const ids = new Set();
      out.records.forEach((record, i) => {
        invariant(record.kind === 'event' && record.seq === i + 1 && typeof record.event?.eventId === 'string' && !ids.has(record.event.eventId), 'legacy_prefix_invalid', `Legacy journal is not a contiguous event sequence from 1 with unique ids (line ${i + 1}); nothing is migrated.`, { status: 'legacy_prefix_invalid', line: i + 1 });
        ids.add(record.event.eventId);
      });
    }
    const intact = Buffer.from(scanned.text, 'utf8').subarray(0, out.repair?.truncateTo ?? (out.repair?.addDelimiter ? scanned.size : out.bytes));
    out.sha = out.bytes ? sha(out.repair?.addDelimiter ? Buffer.concat([intact, Buffer.from('\n')]) : intact) : null;
    return out;
  }

  async _writersActive() {
    const owner = await readJson(path.join(this.root, 'locks', 'access-coop-dispatcher', 'owner.json'), { optional: true }).catch(() => null);
    if (!owner || !Number.isInteger(owner.pid)) return false;
    try { process.kill(owner.pid, 0); return true; } catch { return false; }
  }

  // Host-only, stopped-writer migration of a pre-protocol store. One generation is minted when the
  // plan is persisted; resume replays only that plan against the frozen images and never adopts the
  // current files as a new baseline. The operator's stopped-and-isolated writers are a precondition;
  // the dispatcher-lock probe is best effort, not proof.
  migrate({ fromV1 = false, resume = false } = {}) {
    return this.lock(async () => {
      invariant(!(await this._writersActive()), 'writers_active', 'A dispatcher still holds its lock on this root; stop every writer before migrating.', { status: 'writers_active' });
      const control = await readJson(this.storeFile, { optional: true });
      if (control) {
        invariant(control.schema === STORE_SCHEMA, 'store_unsupported_version', 'store.json is of an unknown version.', { status: 'store_unsupported_version' });
        invariant(control.migration?.state === 'in_progress', 'store_initialized', 'This store is already on the current protocol; nothing to migrate.', { status: 'store_initialized' });
        invariant(control.migration.from === 'v1', 'migration_in_progress', 'An interrupted initialisation exists on this root; rerun "access coop store init" to replay its plan.', { status: 'migration_in_progress', from: 'init', phase: control.migration.phase });
        invariant(resume, 'migration_in_progress', 'An interrupted migration exists; rerun with --resume to replay its plan.', { status: 'migration_in_progress', from: 'v1', phase: control.migration.phase });
        return this._resumeMigration(control);
      }
      invariant(!resume, 'migration_not_started', 'No interrupted migration exists on this root.', { status: 'migration_not_started' });
      invariant(fromV1, 'invalid_arguments', 'Name the source protocol: --from-v1.');
      const classified = await this._classifyWithoutControl();
      if (classified.status === 'store_uninitialized') throw storeError('store_empty', 'This root holds no cooperation data; use "access coop store init".', { status: 'store_empty' });
      if (classified.status !== 'legacy_migration_required') throw storeError(classified.status, classified.operatorAction, { status: classified.status, operatorAction: classified.operatorAction });
      const [journal, receipts, recipientsText] = await Promise.all([this.journal.scan(), this.receipts.scan(), this._readText(this.recipientsFile)]);
      const events = this._legacyLog(journal, { events: true });
      const acks = this._legacyLog(receipts);
      let recipientsContent = null;
      if (recipientsText !== null) { try { recipientsContent = JSON.parse(recipientsText); } catch { recipientsContent = null; } invariant(recipientsContent && typeof recipientsContent === 'object', 'legacy_prefix_invalid', 'recipients.json is not valid JSON; nothing is migrated.', { status: 'legacy_prefix_invalid' }); }
      const at = now();
      const plan = {
        schema: STORE_SCHEMA, generation: uuid(), initializedAt: at,
        migration: {
          state: 'in_progress', from: 'v1', phase: 'prepared', startedAt: at, completedAt: null,
          baseline: { eventLines: events.lines, eventBytes: events.bytes, eventsSha: events.sha, eventLastSha: events.lastSha, eventSeq: events.records.length ? events.records.at(-1).seq : 0, receiptLines: acks.lines, receiptBytes: acks.bytes, receiptsSha: acks.sha, receiptLastSha: acks.lastSha, recipientsSha: recipientsText === null ? null : sha(recipientsText), recipientsContent },
          // Exact original images (whole-file sha before any repair) plus the one tail-only repair each
          // log may need; resume applies a repair only to a file that is still exactly that image.
          repair: { journal: { bytesBefore: journal.size, originalSha: journal.size ? sha(journal.text) : null, ...(events.repair || {}) }, receipts: { bytesBefore: receipts.size, originalSha: receipts.size ? sha(receipts.text) : null, ...(acks.repair || {}) } },
        },
        boundary: null, lastRecovery: null,
      };
      await writeJsonAtomic(this.storeFile, plan);
      return this._resumeMigration(plan);
    });
  }

  // A log must be exactly at its frozen baseline, or still exactly as it was before the planned
  // repair (then the repair is applied). Anything else blocks: the plan is never recomputed.
  async _settleLegacyLog(journal, { bytes, sha: expected }, repair) {
    const scanned = await journal.scan();
    const blocked = detail => storeError('migration_blocked', `${journal.name} ${detail}; the migration plan cannot be applied. Inspect the store and restore the file to its state at preparation time.`, { status: 'migration_blocked', file: journal.name, operatorAction: 'access coop store inspect; restore the file; then migrate --resume' });
    const buffer = Buffer.from(scanned.text, 'utf8');
    if (scanned.size === bytes && (bytes === 0 || sha(buffer) === expected)) return { repaired: false };
    if (scanned.size !== repair.bytesBefore || (repair.originalSha !== undefined && sha(buffer) !== repair.originalSha)) throw blocked('is neither the frozen original image nor the planned result');
    if (repair.addDelimiter) {
      if (sha(Buffer.concat([buffer, Buffer.from('\n')])) !== expected) throw blocked('differs from the frozen pre-image');
      await fs.appendFile(journal.file, '\n', { mode: 0o600 }); return { repaired: true, addedDelimiter: true };
    }
    if (typeof repair.truncateTo === 'number') {
      const prefixMatches = repair.truncateTo === 0 ? expected === null : sha(buffer.subarray(0, repair.truncateTo)) === expected;
      if (!prefixMatches) throw blocked('differs from the frozen pre-image');
      await fs.truncate(journal.file, repair.truncateTo); return { repaired: true, droppedTornTail: true, line: repair.droppedLine };
    }
    throw blocked('differs from the frozen baseline');
  }

  async _resumeMigration(control) {
    const m = control.migration; const base = m.baseline;
    const repaired = { journal: await this._settleLegacyLog(this.journal, { bytes: base.eventBytes, sha: base.eventsSha }, m.repair.journal), receipts: await this._settleLegacyLog(this.receipts, { bytes: base.receiptBytes, sha: base.receiptsSha }, m.repair.receipts) };
    await fs.writeFile(this.journal.file, '', { flag: 'a', mode: 0o600 });
    await fs.writeFile(this.receipts.file, '', { flag: 'a', mode: 0o600 });
    const post = { schemaVersion: COOP_VERSION, generation: control.generation, revision: 1, recipients: base.recipientsContent?.recipients || {} };
    const postSha = sha(jsonFileBytes(post));
    const currentText = await this._readText(this.recipientsFile);
    const currentSha = currentText === null ? null : sha(currentText);
    if (currentSha === base.recipientsSha) await writeJsonAtomic(this.recipientsFile, post);
    else invariant(currentSha === postSha, 'migration_blocked', 'recipients.json matches neither the frozen pre-image nor the planned post-image; the migration plan cannot be applied.', { status: 'migration_blocked', file: 'recipients.json', operatorAction: 'access coop store inspect; restore recipients.json; then migrate --resume' });
    if (m.phase === 'prepared') { control = { ...control, migration: { ...m, phase: 'recipients_replaced' } }; await writeJsonAtomic(this.storeFile, control); }
    const at = now();
    const boundary = boundaryOf({ eventSeq: base.eventSeq, eventLines: base.eventLines, eventBytes: base.eventBytes, eventLastSha: base.eventLastSha, receiptLines: base.receiptLines, receiptBytes: base.receiptBytes, receiptLastSha: base.receiptLastSha, recipientsRevision: 1, recipientsSha: postSha, retentionFloor: 0, updatedAt: at });
    await writeJsonAtomic(this.storeFile, { ...control, migration: { ...control.migration, state: 'complete', phase: 'complete', completedAt: at }, boundary });
    return { generation: control.generation, migrated: true, baseline: { events: base.eventLines, lastSeq: base.eventSeq, receipts: base.receiptLines, recipients: Object.keys(post.recipients).length }, repaired, note: 'Protocol guarantees begin at this baseline; no event, receipt, epoch or delivery was rewritten, acknowledged, regenerated or sent.' };
  }

  // Operator view, read-only: the classification open() would reach, without repairing anything.
  inspect() {
    return this.lock(async () => {
      let examined;
      try { examined = await this._examine(); }
      catch (error) { return { status: error.code || 'error', detail: error.message, operatorAction: error.details?.operatorAction || null, phase: error.details?.phase || null }; }
      const issue = examined.events.problem || examined.receipts.problem || examined.recipients.problem;
      const pending = { journal: examined.events.repair || (examined.events.excess ? { adopt: examined.events.excess } : null), receipts: examined.receipts.repair || (examined.receipts.excess ? { adopt: examined.receipts.excess } : null), recipients: examined.recipients.action };
      return { status: issue ? (issue.kind === 'rolled_back' ? 'rolled_back' : 'corrupt') : 'ok', detail: issue?.detail || null, generation: examined.control.generation, boundary: examined.control.boundary, migration: { state: examined.control.migration?.state || 'none', from: examined.control.migration?.from || null, baseline: examined.control.migration?.baseline ? { events: examined.control.migration.baseline.eventLines, receipts: examined.control.migration.baseline.receiptLines } : null }, pendingRecovery: pending, lastRecovery: examined.control.lastRecovery || null, files: { journalBytes: examined.events.size, receiptBytes: examined.receipts.size, recipientsSha: examined.recipients.sha } };
    });
  }
}

// Scoped cursor token: a position in one store lineage for one consumer identity.
export function encodeCursor({ generation, seq, consumerId, incarnation, epoch }) {
  return Buffer.from(canonical({ v: 2, g: generation, s: seq, c: consumerId, i: incarnation, e: epoch }), 'utf8').toString('base64url');
}

export function decodeCursor(token) {
  invariant(typeof token === 'string' && token.length > 0 && token.length <= MAX_CURSOR_TOKEN && /^[A-Za-z0-9_-]+$/.test(token), 'invalid_cursor', 'cursorV2 must be a scoped cursor token from a previous inbox response.', { status: 'cursor_malformed', field: 'cursorV2' });
  let parsed;
  try { parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); } catch { parsed = null; }
  invariant(parsed && typeof parsed === 'object' && parsed.v === 2 && typeof parsed.g === 'string' && Number.isSafeInteger(parsed.s) && parsed.s >= 0 && typeof parsed.c === 'string' && typeof parsed.i === 'string' && typeof parsed.e === 'string', 'invalid_cursor', 'cursorV2 is malformed (version, generation, sequence, consumer, incarnation and epoch are all required).', { status: 'cursor_malformed', field: 'cursorV2' });
  return { generation: parsed.g, seq: parsed.s, consumerId: parsed.c, incarnation: parsed.i, epoch: parsed.e };
}

export class CoopService {
  constructor({ root, store, principals, jobs, sessions, orchestrator, now: clock = now } = {}) {
    invariant(typeof root === 'string' && root.length > 0, 'invalid_state_root', 'Coop service root is required.');
    invariant(principals, 'invalid_principals', 'Coop service requires a principal store.');
    this.root = path.resolve(root);
    this.store = store || new CoopStore({ root: this.root });
    this.principals = principals; this.jobs = jobs || null; this.sessions = sessions || null; this.orchestrator = orchestrator || null;
    this.now = clock;
  }

  describe(principal) {
    return {
      schema: COOP_SCHEMA, store: STORE_SCHEMA, tools: ['coop_report', 'coop_inbox', 'coop_ack'], reportableTypes: [...REPORTABLE_TYPES], observerTypes: [...OBSERVER_TYPES], verifierTypes: [...VERIFIER_TYPES],
      cursors: 'coop_inbox takes either cursor (legacy numeric sequence) or cursorV2 (scoped token carrying store generation, sequence, consumer, incarnation and epoch), never both; every response returns nextCursor and nextCursorV2.',
      note: 'coop_report records what you observed or decided about a task you own; it is attributed to you and verifies nothing. coop_inbox reads events delivered to your registered recipient; coop_ack records receipt only. Idle prompts, HTTP 2xx and memory contents never mean a task is complete.',
      principal: { id: principal.id, kind: principal.kind || 'other' },
    };
  }

  // Every call uses the store's current principal record; the request's incarnation must match.
  async _current(principal) {
    const current = await this.principals.get(principal?.id).catch(() => null);
    invariant(!current || typeof current.incarnation === 'string', 'legacy_migration_required', `Principal ${current?.id} predates identity tracking; run "access principal migrate --id ${current?.id}" first.`);
    invariant(typeof principal?.incarnation === 'string' && current && current.incarnation === principal.incarnation, 'permission_denied', 'This request’s principal identity is not current; authenticate again.');
    return current;
  }

  // Task references name a job the principal owns or a session bound to it; both are re-checked
  // against the principal's current scope (project, agent) on every report.
  async _task(current, ref) {
    const text = textField(ref, 'task.ref', 200);
    const m = /^harnessorbit:(job|session)\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})$/.exec(text);
    invariant(m, 'invalid_event', 'task.ref must be harnessorbit:job/<id> or harnessorbit:session/<id>.', { field: 'task.ref' });
    const inScope = project => project && current.projects.some(p => project === p || project.startsWith(`${p}${path.sep}`));
    if (m[1] === 'job') {
      invariant(this.jobs, 'jobs_unavailable', 'Jobs are not enabled on this server.');
      const job = await this.jobs.get(m[2]).catch(() => null);
      invariant(job && job.principalId === current.id && job.principalIncarnation === current.incarnation, 'task_not_found', `Task ${text} is not yours.`);
      invariant(inScope(job.project) && current.agents.includes(job.agent), 'permission_denied', 'The job is outside your current scope.');
      let revision = null;
      try { const inspected = await this.orchestrator?.inspect(job.runId, job.taskId); revision = inspected?.attempt?.number ?? null; } catch { revision = null; }
      return { ref: text, kind: 'job', id: job.id, project: job.project, agent: job.agent, intentRevision: revision, binding: null };
    }
    invariant(this.sessions, 'sessions_unavailable', 'Live sessions are not enabled on this server.');
    const record = await this.sessions.get(m[2]).catch(() => null);
    invariant(record && record.principalId === current.id && record.principalIncarnation === current.incarnation && typeof record.bindingId === 'string', 'task_not_found', `Task ${text} is not yours.`);
    invariant(current.permissions.sessions === true && inScope(record.project) && current.agents.includes(record.agent.kind), 'permission_denied', 'The session is outside your current scope.');
    return { ref: text, kind: 'session', id: record.id, project: record.project, agent: record.agent.kind, intentRevision: null, binding: record.bindingId };
  }

  _evidenceRefs(value, current, { observer = false } = {}) {
    if (value === undefined) return [];
    invariant(Array.isArray(value) && value.length <= 20, 'invalid_event', 'evidenceRefs must be a list of at most 20 entries.', { field: 'evidenceRefs' });
    return value.map((entry, i) => {
      invariant(entry && typeof entry === 'object' && ['planned', 'reported'].includes(entry.label), 'authority_denied', `evidenceRefs[${i}].label may be planned or reported; verified and integrated come only from a verifier.`, { field: 'evidenceRefs' });
      return { label: entry.label, ref: textField(entry.ref, `evidenceRefs[${i}].ref`, 200), issuer: observer ? 'harnessorbit:observer' : `principal:${current.id}`, ...(entry.summary === undefined ? {} : { summary: textField(entry.summary, `evidenceRefs[${i}].summary`, 400, { multiline: true }) }) };
    });
  }

  // Records one event, once. The commit boundary is a single journal line holding the envelope,
  // the idempotency record and the deliveries frozen with each recipient's registration epoch,
  // followed by the store boundary that covers it.
  async report(principal, input = {}, { via = 'mcp' } = {}) {
    const current = await this._current(principal);
    invariant(current.permissions.submit !== false || current.permissions.sessions === true, 'permission_denied', 'This principal may not report.');
    const idempotencyKey = textField(input.idempotencyKey, 'idempotencyKey', 128);
    const type = textField(input.type, 'type', 64);
    invariant(!VERIFIER_TYPES.includes(type) && !OBSERVER_TYPES.includes(type) && !HISTORICAL_TYPES.includes(type), 'authority_denied', `${type} is issued only by a verifier, the observer or the host importer, never by a reporting principal.`, { type });
    invariant(REPORTABLE_TYPES.includes(type), 'invalid_event', `type must be one of ${REPORTABLE_TYPES.join(', ')}.`, { type });
    const task = await this._task(current, input.task?.ref ?? input.taskRef);
    const payload = boundedPayload(input.payload === undefined ? {} : input.payload);
    invariant(Buffer.byteLength(canonical(payload)) <= MAX_PAYLOAD_BYTES, 'invalid_event', `payload must serialize to at most ${MAX_PAYLOAD_BYTES} bytes.`);
    const evidenceRefs = this._evidenceRefs(input.evidenceRefs, current);
    const conversationRef = textField(input.conversationRef, 'conversationRef', 200, { required: false });
    const correlationId = textField(input.correlationId, 'correlationId', 128, { required: false });
    const causationId = textField(input.causationId, 'causationId', 64, { required: false });
    const body = { type, task: task.ref, intentRevision: task.intentRevision, payload, evidenceRefs, conversationRef, correlationId, causationId };
    const bodyHash = sha(canonical(body));
    return this.store.lock(async () => {
      const state = await this.store.open();
      // Scope is re-validated after the wait: the fresh principal must still own the same target
      // (same ref, kind, id, binding, checkout and agent) before anything is returned or committed.
      const fresh = await this._current(principal);
      invariant(fresh.permissions.submit !== false || fresh.permissions.sessions === true, 'permission_denied', 'This principal may not report.');
      const recheck = await this._task(fresh, task.ref);
      invariant(recheck.kind === task.kind && recheck.id === task.id && recheck.binding === task.binding && recheck.project === task.project && recheck.agent === task.agent, 'permission_denied', 'The task changed while waiting; report again.');
      const keyHash = sha(idempotencyKey);
      const existing = state.byKey.get(`${fresh.id}:${fresh.incarnation}:${keyHash}`);
      if (existing) {
        invariant(existing.idempotency.bodyHash === bodyHash, 'event_conflict', 'This idempotencyKey was already used for a different event. Choose a new key.', { idempotencyKey });
        return this._reported(existing, state, { reused: true });
      }
      let hop = 0;
      if (causationId) {
        const parent = state.byId.get(causationId);
        invariant(parent, 'invalid_event', 'causationId does not name a recorded event.', { causationId });
        hop = (parent.event.hop ?? 0) + 1;
        invariant(hop <= MAX_HOPS, 'causal_depth_exceeded', `A causal chain may not exceed ${MAX_HOPS} hops; start a new chain.`, { hop });
      }
      const event = {
        schema: COOP_SCHEMA, eventId: uuid(), seq: state.nextSeq, createdAt: this.now(), type,
        source: { principalId: fresh.id, incarnation: fresh.incarnation, kind: fresh.kind || 'other', via, binding: task.binding },
        task: { ref: task.ref, kind: task.kind, id: task.id, intentRevision: task.intentRevision },
        conversationRef, correlationId, causationId, hop, payload, evidenceRefs,
      };
      const deliveries = this._deliveriesFor(event, fresh, state.recipients);
      await this.store.appendEvent(state, { v: COOP_VERSION, kind: 'event', seq: event.seq, event, idempotency: { principalId: fresh.id, incarnation: fresh.incarnation, keyHash, bodyHash }, deliveries });
      return this._reported({ event, deliveries }, state, { reused: false });
    });
  }

  _reported(record, state, { reused }) {
    const deliveries = record.deliveries.map(d => ({ consumerId: d.consumerId, kind: d.kind, epoch: d.epoch, state: state.acks.has(`${record.event.eventId}:${d.consumerId}`) ? 'acknowledged' : (state.attempts.get(`${record.event.eventId}:${d.consumerId}`)?.outcome || 'pending') }));
    return { schema: COOP_SCHEMA, event: record.event, reused, deliveries, note: 'Recorded and attributed to you. Delivery to recipients is at-least-once with durable dedup; acknowledgement, verification and integration are separate.' };
  }

  // Deliveries are frozen at commit time: active recipients whose task and source scopes match,
  // each with its registration epoch. A later re-registration gets a new epoch and the frozen
  // delivery is revoked instead of redirected.
  _deliveriesFor(event, source, recipients) {
    const out = [];
    for (const recipient of Object.values(recipients)) {
      if (recipient.revokedAt) continue;
      if (recipient.principalId === source.id && recipient.kind === 'inbox') continue; // a reporter does not receive its own report in its inbox
      const taskOk = !recipient.scope.taskRefs.length || recipient.scope.taskRefs.some(prefix => event.task.ref === prefix || event.task.ref.startsWith(prefix));
      const sourceOk = !recipient.scope.sources.length || recipient.scope.sources.includes(source.id);
      // A wildcard registration (types: []) receives every current type and never a historical import;
      // historical types reach only registrations that name them explicitly.
      const typeOk = recipient.scope.types.length ? recipient.scope.types.includes(event.type) : !HISTORICAL_TYPES.includes(event.type);
      // The delivery freezes who the recipient was: registration epoch and, for inboxes, the owning
      // principal incarnation. A later registration under the same id is a different recipient.
      if (taskOk && sourceOk && typeOk) out.push({ consumerId: recipient.id, kind: recipient.kind, epoch: recipient.epoch, principalId: recipient.principalId ?? null, principalIncarnation: recipient.principalIncarnation ?? null, state: 'pending' });
    }
    return out;
  }

  // The inbox consumer is the recipient of kind inbox registered for the calling principal's
  // current incarnation. Reading never acknowledges; progress is per consumer by sequence.
  _consumer(current, recipients) {
    const mine = Object.values(recipients).filter(r => r.kind === 'inbox' && !r.revokedAt && r.principalId === current.id && r.principalIncarnation === current.incarnation);
    invariant(mine.length === 1, mine.length ? 'consumer_ambiguous' : 'consumer_not_registered', mine.length ? 'More than one inbox is registered for this principal; the operator must revoke one.' : 'No inbox is registered for this principal. The host operator registers one with "access recipient register --kind inbox".');
    return mine[0];
  }

  // Cursor mode is chosen before any default applies: a legacy numeric sequence, a scoped token, or
  // (neither given) a bootstrap from this consumer's own start. Tokens are positions, not authority.
  _position({ cursor, cursorV2 }, state, consumer) {
    invariant(!(cursor !== undefined && cursorV2 !== undefined), 'invalid_cursor', 'Pass either cursor (legacy numeric) or cursorV2 (scoped token), not both.', { status: 'cursor_mode_conflict' });
    let mode = 'bootstrap', position = 0;
    if (cursorV2 !== undefined) {
      mode = 'scoped';
      const token = decodeCursor(cursorV2);
      invariant(token.generation === state.generation, 'cursor_wrong_generation', 'This cursor belongs to another store lineage; it cannot be applied here.', { status: 'cursor_wrong_generation', generation: state.generation, operatorAction: 'Inspect the store (access coop store inspect). If the store was restored or re-initialised, the consumer must bootstrap explicitly from its own start; progress under the old lineage cannot be assumed.' });
      invariant(token.consumerId === consumer.id && token.incarnation === consumer.principalIncarnation && token.epoch === consumer.epoch, 'cursor_namespace_mismatch', 'This cursor was issued to a different consumer, principal incarnation or registration epoch; a new consumer identity starts from its own position.', { status: 'cursor_namespace_mismatch', operatorAction: 'Bootstrap with no cursor; the token of another identity is never reused.' });
      position = token.seq;
    } else if (cursor !== undefined) {
      mode = 'legacy_numeric';
      invariant(Number.isInteger(cursor) && cursor >= 0, 'invalid_cursor', 'cursor must be a non-negative integer sequence.', { field: 'cursor' });
      position = cursor;
    }
    invariant(position >= state.retentionFloor, 'cursor_expired', 'The cursor is below the retention floor; events before it are no longer replayable.', { status: 'cursor_expired', retentionFloor: state.retentionFloor, operatorAction: 'Resume from the retention floor explicitly; the gap is a store fact and nothing in it is acknowledged.' });
    invariant(position <= state.boundary.eventSeq, 'cursor_ahead', 'The cursor is ahead of the committed boundary; the store may have been restored from an older copy.', { status: 'cursor_ahead', committedSeq: state.boundary.eventSeq, operatorAction: 'Inspect the store (access coop store inspect) and restore the newer store, or have the consumer resume explicitly from the committed boundary. Nothing jumps to the head and nothing is acknowledged.' });
    return { mode, position };
  }

  async inbox(principal, { cursor, cursorV2, limit = 50 } = {}) {
    const current = await this._current(principal);
    invariant(Number.isInteger(limit) && limit >= 1 && limit <= MAX_INBOX_LIMIT, 'invalid_event', `limit must be 1 to ${MAX_INBOX_LIMIT}.`, { field: 'limit' });
    return this.store.lock(async () => {
      const state = await this.store.open();
      const consumer = this._consumer(current, state.recipients);
      const { mode, position } = this._position({ cursor, cursorV2 }, state, consumer);
      // A delivery is readable only by the recipient it was frozen for: same consumer id and the same
      // owning principal incarnation. A recipient re-registered for a recreated principal, or a
      // delivery without owner metadata, never surfaces an earlier owner's payloads; same-owner
      // history under an older epoch is listed as not current.
      const owned = d => d.consumerId === consumer.id && typeof d.principalIncarnation === 'string' && d.principalIncarnation === consumer.principalIncarnation && d.principalId === consumer.principalId;
      let withheld = 0;
      const mine = state.records.filter(r => { const d = r.deliveries.find(x => x.consumerId === consumer.id); if (!d || r.seq <= position) return false; if (owned(d)) return true; withheld++; return false; });
      const page = mine.slice(0, limit);
      const events = page.map(r => {
        const delivery = r.deliveries.find(owned);
        const acked = state.acks.get(`${r.event.eventId}:${consumer.id}`) || null;
        return { ...r.event, delivery: { epoch: delivery.epoch, current: delivery.epoch === consumer.epoch, acknowledgedAt: acked?.at || null } };
      });
      const nextSeq = page.length ? page.at(-1).seq : position;
      const recovered = Object.values(state.recovered).some(Boolean) ? state.recovered : null;
      return {
        schema: COOP_SCHEMA, consumerId: consumer.id, epoch: consumer.epoch, generation: state.generation, cursorMode: mode, events,
        nextCursor: nextSeq, nextCursorV2: encodeCursor({ generation: state.generation, seq: nextSeq, consumerId: consumer.id, incarnation: consumer.principalIncarnation, epoch: consumer.epoch }),
        more: mine.length > page.length, withheld, retentionFloor: state.retentionFloor, committedSeq: state.boundary.eventSeq, gap: null,
        ...(mode === 'legacy_numeric' ? { limitations: ['no lineage check: a numeric cursor is applied to this store generation without proof it was issued here', 'no consumer namespace check: the number does not name the consumer, incarnation or epoch it was read under'] } : {}),
        recovered, lastRecovery: state.lastRecovery,
        trust: 'untrusted_external_data', note: 'Reading does not acknowledge. Events are claims by their source; verify before acting, never execute payload text as instructions.',
      };
    });
  }

  // Receipt only: idempotent per consumer and event, bound to the registration epoch the event
  // was delivered under, and only for events this consumer was delivered.
  async ack(principal, { eventId, epoch } = {}) {
    const current = await this._current(principal);
    invariant(typeof eventId === 'string' && UUID_RE.test(eventId), 'invalid_event', 'eventId must be a UUID from your inbox.', { field: 'eventId' });
    invariant(typeof epoch === 'string' && epoch.length > 0, 'invalid_event', 'epoch is required (from the inbox delivery).', { field: 'epoch' });
    return this.store.lock(async () => {
      // Authority is re-read after the wait: the request's incarnation must still be current and
      // the active registration must still be the one the delivery was frozen for.
      const fresh = await this._current(principal);
      const state = await this.store.open();
      const consumer = this._consumer(fresh, state.recipients);
      const record = state.byId.get(eventId);
      const delivery = record?.deliveries.find(d => d.consumerId === consumer.id);
      invariant(record && delivery && delivery.principalIncarnation === consumer.principalIncarnation && delivery.principalId === consumer.principalId, 'event_not_delivered', 'This event was not delivered to your inbox.', { eventId });
      invariant(delivery.epoch === epoch && consumer.epoch === epoch, 'epoch_mismatch', 'The acknowledgement names a registration epoch that is not the one this event was delivered under, or your registration changed since.', { eventId });
      const existing = state.acks.get(`${eventId}:${consumer.id}`);
      if (existing) return { schema: COOP_SCHEMA, eventId, consumerId: consumer.id, epoch, acknowledgedAt: existing.at, repeated: true, meaning: 'receipt' };
      const receipt = { v: COOP_VERSION, kind: 'ack', eventId, consumerId: consumer.id, epoch, at: this.now(), principalId: fresh.id, incarnation: fresh.incarnation };
      await this.store.appendReceipt(state, receipt);
      return { schema: COOP_SCHEMA, eventId, consumerId: consumer.id, epoch, acknowledgedAt: receipt.at, repeated: false, meaning: 'receipt' };
    });
  }

  // Observer path: a bounded observation of a bound session's transition from working to ready.
  // It is recorded under the observer's own identity, keyed by the transition identity so a
  // restart or a repeated poll cannot emit it twice, and it is never a completion claim.
  // Two observer signals, both only observations:
  //  - session.ready: the screen showed a working → ready transition (fallback when no native source).
  //  - agent.turn_finished: the provider's own native record says a turn ended (Claude Code end_turn).
  // Keyed by the caller's stable identity (screen transition or provider message id) so restarts and
  // repeated polls never emit the same signal twice.
  async observe({ sessionId, transitionId, observedAt, fromState, toState, bindingId, via = 'observer', type = 'session.ready', signal = null, legacy = false } = {}) {
    invariant(this.sessions, 'sessions_unavailable', 'Live sessions are not enabled on this server.');
    invariant(OBSERVER_TYPES.includes(type), 'invalid_event', 'Observer events are session.ready or agent.turn_finished.');
    const record = await this.sessions.get(sessionId).catch(() => null);
    invariant(record && record.bindingId === bindingId, 'session_not_found', `Session ${sessionId} is not bound (or was re-bound).`);
    const owner = await this.principals.get(record.principalId).catch(() => null);
    invariant(owner && owner.incarnation === record.principalIncarnation && owner.permissions.sessions === true, 'permission_denied', 'The binding’s principal is no longer current or lacks the sessions permission; not observing.');
    // Fresh scope at emission: the bound checkout and agent must still be within the owner's current scope.
    invariant(owner.projects.some(p => record.project === p || record.project.startsWith(`${p}${path.sep}`)) && owner.agents.includes(record.agent.kind), 'permission_denied', 'The bound session is outside its principal’s current project or agent scope; not observing.');
    invariant(typeof transitionId === 'string' && /^[0-9a-f]{16,64}$/.test(transitionId), 'invalid_event', 'transitionId must be a hex transition identity.');
    let payload;
    if (type === 'agent.turn_finished') {
      invariant(signal && signal.source === 'native_end_turn' && typeof signal.providerSessionId === 'string' && typeof signal.providerMessageId === 'string', 'invalid_event', 'agent.turn_finished needs the provider’s native end_turn record identity.');
      payload = { observation: 'native_end_turn', provider: signal.provider || record.agent.kind, providerSessionId: signal.providerSessionId, providerMessageId: signal.providerMessageId, providerTimestamp: signal.providerTimestamp || null, observedAt, sessionId: record.id, agent: record.agent.kind, meaning: 'The provider’s own record says a model turn ended (end_turn). This is an observation of the turn boundary, not task completion and not verification.' };
    } else {
      invariant(fromState === 'busy' && toState === 'idle', 'invalid_event', 'Only a working → ready transition is emitted; an initial idle snapshot is not a completion.');
      payload = { observation: 'working_to_ready', fromState, toState, observedAt, sessionId: record.id, agent: record.agent.kind, meaning: 'The agent’s prompt became ready for input again (screen observation). Not a provider turn boundary, not task completion, not verification.' };
    }
    const body = { type, task: `harnessorbit:session/${record.id}`, payload };
    const bodyHash = sha(canonical(body));
    return this.store.lock(async () => {
      const state = await this.store.open();
      // The first pilot keyed screen observations without a type. A migrated pending transition whose
      // event that pilot already committed is found by that old identity and reused as it is: same
      // UUID, same body, still a screen observation, never relabelled.
      if (legacy && type === 'session.ready') {
        const old = state.byKey.get(`${owner.id}:${owner.incarnation}:${sha(`observer:${record.bindingId}:${transitionId}`)}`);
        if (old) return this._reported(old, state, { reused: true });
      }
      const keyHash = sha(`observer:${type}:${record.bindingId}:${transitionId}`);
      const existing = state.byKey.get(`${owner.id}:${owner.incarnation}:${keyHash}`);
      if (existing) return this._reported(existing, state, { reused: true });
      const event = {
        schema: COOP_SCHEMA, eventId: uuid(), seq: state.nextSeq, createdAt: this.now(), type,
        source: { principalId: owner.id, incarnation: owner.incarnation, kind: 'orchestrator', via, binding: record.bindingId, observer: 'harnessorbit' },
        task: { ref: `harnessorbit:session/${record.id}`, kind: 'session', id: record.id, intentRevision: null },
        conversationRef: null, correlationId: null, causationId: null, hop: 0, payload, evidenceRefs: [],
      };
      const deliveries = this._deliveriesFor(event, owner, state.recipients);
      await this.store.appendEvent(state, { v: COOP_VERSION, kind: 'event', seq: event.seq, event, idempotency: { principalId: owner.id, incarnation: owner.incarnation, keyHash, bodyHash }, deliveries });
      return this._reported({ event, deliveries }, state, { reused: false });
    });
  }

  // Operator-only registration. The registration (not the caller) fixes kind, destination,
  // allowed sources, task scopes and types; each registration has its own epoch.
  async registerRecipient({ id, kind, principalId = null, endpoint = null, secretFile = null, threadId = null, socketPath = null, taskRefs = [], sources = [], types = [], label = null } = {}) {
    validateId(id);
    invariant(RECIPIENT_KINDS.includes(kind), 'invalid_recipient', `kind must be one of ${RECIPIENT_KINDS.join(', ')}.`, { kind });
    invariant(Array.isArray(taskRefs) && taskRefs.every(t => typeof t === 'string' && /^harnessorbit:(job|session)\/[a-zA-Z0-9_-]*$/.test(t)) && taskRefs.length <= 50, 'invalid_recipient', 'taskRefs must be harnessorbit:job/… or harnessorbit:session/… prefixes.');
    invariant(Array.isArray(sources) && sources.every(s => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(s)) && sources.length <= 50, 'invalid_recipient', 'sources must be principal ids.');
    invariant(Array.isArray(types) && types.every(t => [...REPORTABLE_TYPES, ...OBSERVER_TYPES, ...VERIFIER_TYPES, ...HISTORICAL_TYPES].includes(t)) && types.length <= 20, 'invalid_recipient', 'types must be known event types.');
    invariant(label === null || (typeof label === 'string' && label.length <= 120), 'invalid_recipient', 'label must be at most 120 characters.');
    const record = { id, kind, epoch: crypto.randomBytes(8).toString('hex'), label, scope: { taskRefs, sources, types }, createdAt: now(), revokedAt: null };
    if (kind === 'inbox') {
      const principal = await this.principals.get(principalId).catch(() => null);
      invariant(principal && typeof principal.incarnation === 'string', 'principal_not_found', 'An inbox recipient needs an existing, migrated principal.');
      record.principalId = principal.id; record.principalIncarnation = principal.incarnation;
    } else if (kind === 'grok-native-webhook') {
      invariant(typeof endpoint === 'string' && /^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(endpoint), 'invalid_recipient', 'A Grok native webhook needs an exact https endpoint (no query, no redirects).');
      invariant(typeof secretFile === 'string' && path.isAbsolute(secretFile), 'invalid_recipient', 'secretFile must be an absolute path to a 0600 file holding the bearer secret.');
      record.transport = { endpoint, secretFile };
    } else {
      invariant(typeof socketPath === 'string' && path.isAbsolute(socketPath) && typeof threadId === 'string' && threadId.length > 0 && threadId.length <= 128, 'invalid_recipient', 'A Codex app-server recipient needs the owning runtime’s socket path and the thread id.');
      record.transport = { socketPath, threadId };
    }
    return this.store.lock(async () => {
      const state = await this.store.open();
      const recipients = { ...state.recipients };
      const previous = recipients[id];
      invariant(!previous || previous.revokedAt, 'recipient_exists', `Recipient ${id} is already registered (revoke it first to re-register with a new epoch).`, { id });
      recipients[id] = record;
      await this.store.replaceRecipients(state, recipients);
      return this._publicRecipient(record);
    });
  }

  async revokeRecipient(id) {
    validateId(id);
    return this.store.lock(async () => {
      const state = await this.store.open();
      const recipients = { ...state.recipients };
      const record = recipients[id];
      if (!record || record.revokedAt) return { id, revoked: false };
      recipients[id] = { ...record, revokedAt: now() };
      await this.store.replaceRecipients(state, recipients);
      return { id, revoked: true, epoch: record.epoch };
    });
  }

  async listRecipients() { return { recipients: Object.values((await this.store.load()).recipients).map(r => this._publicRecipient(r)) }; }

  // Pending deliveries for non-inbox kinds, for a dispatcher. A delivery whose recipient epoch
  // changed is reported revoked, never redirected to the new registration.
  async pendingDeliveries() {
    const state = await this.store.load();
    const recipients = state.recipients;
    const out = [];
    for (const record of state.records) {
      for (const delivery of record.deliveries) {
        if (delivery.kind === 'inbox') continue;
        const key = `${record.event.eventId}:${delivery.consumerId}`;
        if (state.acks.has(key)) continue;
        const attempt = state.attempts.get(key);
        if (attempt && ['accepted', 'dead', 'revoked'].includes(attempt.outcome)) continue;
        const recipient = recipients[delivery.consumerId];
        const revoked = !recipient || recipient.revokedAt || recipient.epoch !== delivery.epoch;
        out.push({ eventId: record.event.eventId, seq: record.seq, consumerId: delivery.consumerId, kind: delivery.kind, epoch: delivery.epoch, state: revoked ? 'revoked' : (attempt?.outcome || 'pending'), attempts: attempt?.attempts || 0, nextAttemptAt: attempt?.nextAttemptAt || null, unresolved: attempt?.unresolved === true, lastDetail: attempt?.detail || null, recipient: revoked ? null : recipient });
      }
    }
    return out;
  }

  // Records one dispatch attempt outcome durably. `unknown` is its own state: the transport may
  // have delivered, so the next attempt reconciles by eventId before any repeated side effect.
  async recordAttempt({ eventId, consumerId, epoch, outcome, detail = null, attempts = 1, nextAttemptAt = null, unresolved = false, receipt: transportReceipt = null }) {
    // sending: journaled before the external side effect, so a crash afterwards leaves an explicit
    // unresolved boundary. deferred: the destination cannot take it right now (wrong runtime, busy
    // thread, missing secret); it stays pending without consuming the attempt budget.
    invariant(['sending', 'accepted', 'unknown', 'failed', 'deferred', 'revoked', 'dead'].includes(outcome), 'invalid_event', 'Unknown attempt outcome.');
    const receipt = { v: COOP_VERSION, kind: 'attempt', eventId, consumerId, epoch, outcome, detail: detail ? String(detail).slice(0, 200) : null, attempts, nextAttemptAt, unresolved: unresolved === true, receipt: transportReceipt && typeof transportReceipt === 'object' ? JSON.parse(JSON.stringify(transportReceipt).slice(0, 400)) : null, at: this.now() };
    await this.store.lock(async () => { const state = await this.store.open(); await this.store.appendReceipt(state, receipt); });
    return receipt;
  }

  // Operator decision for a delivery the transport could not settle: `accepted` records that the
  // operator confirmed the receiver holds it (out of band); `resend` authorizes exactly one more
  // send. Neither is automatic, and neither is an inbox acknowledgement.
  async resolveDelivery({ eventId, consumerId, as, note = null }) {
    invariant(['accepted', 'resend'].includes(as), 'invalid_event', 'as must be accepted or resend.');
    const state = await this.store.load();
    const record = state.byId.get(eventId);
    const delivery = record?.deliveries.find(d => d.consumerId === consumerId);
    invariant(record && delivery, 'event_not_delivered', 'No such delivery.', { eventId, consumerId });
    const attempt = state.attempts.get(`${eventId}:${consumerId}`);
    invariant(attempt && ['sending', 'unknown'].includes(attempt.outcome), 'delivery_not_unresolved', `The delivery is ${attempt?.outcome || 'pending'}, not unresolved.`, { eventId, consumerId });
    const detail = `operator ${as}${note ? `: ${String(note).slice(0, 120)}` : ''}`;
    if (as === 'accepted') return this.recordAttempt({ eventId, consumerId, epoch: delivery.epoch, outcome: 'accepted', detail, attempts: attempt.attempts });
    return this.recordAttempt({ eventId, consumerId, epoch: delivery.epoch, outcome: 'failed', detail, attempts: attempt.attempts, nextAttemptAt: this.now() });
  }

  _publicRecipient(record) {
    const { transport, ...rest } = record;
    return { ...rest, transport: transport ? { ...transport, ...(transport.secretFile ? { secretFile: '<redacted path>' } : {}) } : null };
  }

  // ---- Host-only import of stable-ID lifecycle facts (phase 2B) -------------------------------
  //
  // Source: the job's own run event log (runs/<runId>/events.jsonl), reached only through the job
  // record. Custody: the job's recorded owner at its current incarnation (an authorized custodian,
  // not a proven original author); checked without the orchestrator. Protocol: durable preparation
  // (custody, prior checkpoint, exact captured range and its hash) before the first imported event,
  // one journal record per event (the idempotency record is the mapping), then a checkpoint tied to
  // the same plan. Both import records live in receipts.jsonl under the Gate A chain and boundary.
  // Every offset and hash comes from one captured byte image; nothing is re-read after a commit.

  async _custody(jobId) {
    invariant(this.jobs, 'jobs_unavailable', 'Jobs are not enabled on this host.');
    const job = await this.jobs.get(jobId);
    invariant(job, 'job_not_found', `Job ${jobId} does not exist.`, { jobId });
    invariant(typeof job.principalIncarnation === 'string', 'legacy_migration_required', `Job ${jobId} predates principal identity tracking; the host operator adopts it first (access principal adopt-jobs). Import never adopts.`, { jobId });
    const owner = await this.principals.get(job.principalId).catch(() => null);
    invariant(owner && owner.incarnation === job.principalIncarnation, 'permission_denied', 'The job’s custodian is not the current incarnation of that principal; not importing.', { jobId });
    invariant(owner.permissions.submit !== false || owner.permissions.sessions === true, 'permission_denied', 'The custodian may not report; not importing.', { jobId });
    const inScope = typeof job.project === 'string' && owner.projects.some(p => job.project === p || job.project.startsWith(`${p}${path.sep}`)) && owner.agents.includes(job.agent);
    invariant(inScope, 'permission_denied', 'The job is outside its custodian’s current project or agent scope; not importing.', { jobId });
    invariant(typeof job.runId === 'string' && typeof job.taskId === 'string', 'source_missing', 'The job record names no run or task.', { jobId });
    return { job, owner, tuple: { id: job.id, runId: job.runId, taskId: job.taskId, principalId: owner.id, principalIncarnation: owner.incarnation } };
  }

  // Indices over the import records in receipts.jsonl. Any inconsistency refuses the import.
  _importIndex(receipts) {
    const byJob = new Map(), bySource = new Map(), prepares = new Map(), unresolved = new Map();
    const bad = detail => { throw storeError('import_records_invalid', `Import records in receipts.jsonl are inconsistent: ${detail}.`, { status: 'import_records_invalid', operatorAction: 'Inspect receipts.jsonl and restore it from backup; nothing is imported until then.' }); };
    const tupleOk = t => t && typeof t === 'object' && IMPORT_TUPLE.every(k => typeof t[k] === 'string');
    for (const r of receipts) {
      if (r.kind === 'import.prepare') {
        if (r.v !== 1 || typeof r.planId !== 'string' || !tupleOk(r.job) || typeof r.sourceId !== 'string' || !r.range || !r.prior) bad(`malformed prepare ${r.planId ?? '?'}`);
        if (prepares.has(r.planId)) bad(`duplicate planId ${r.planId}`);
        const frozen = byJob.get(r.job.id);
        if (frozen && !sameTuple(frozen, r.job)) bad(`job ${r.job.id} prepared under two tuples`);
        if (!frozen) byJob.set(r.job.id, r.job);
        const src = bySource.get(r.sourceId);
        if (src && src.jobId !== r.job.id) bad(`source ${r.sourceId} bound to two jobs`);
        if (!src) bySource.set(r.sourceId, { jobId: r.job.id, checkpoint: null, prepare: r }); else src.prepare = r;
        if (unresolved.has(r.sourceId)) bad(`source ${r.sourceId} has two unresolved plans`);
        unresolved.set(r.sourceId, r); prepares.set(r.planId, r);
      } else if (r.kind === 'import.checkpoint') {
        const p = prepares.get(r.planId);
        if (!p || p.sourceId !== r.sourceId || !sameTuple(p.job, r.job) || !r.checkpoint) bad(`checkpoint without matching prepare ${r.planId ?? '?'}`);
        if (unresolved.get(r.sourceId) !== p) bad(`checkpoint ${r.planId} does not settle the open plan`);
        unresolved.delete(r.sourceId);
        bySource.get(r.sourceId).checkpoint = r;
      }
    }
    return { byJob, bySource, unresolved };
  }

  // One handle, one read, one byte image. Returns image[0 .. min(size, fromBytes + captureLimit)].
  async _captureSource(file, { fromBytes, captureLimit }) {
    let handle;
    try { handle = await fs.open(file, 'r'); }
    catch (error) { if (error.code === 'ENOENT') return { status: 'source_missing', detail: 'the run has no events.jsonl' }; throw error; }
    try {
      const st = await handle.stat();
      const ps = await fs.stat(file).catch(() => null);
      if (!ps || ps.ino !== st.ino || ps.dev !== st.dev) return { status: 'source_unstable', detail: 'the source path was replaced while it was being opened' };
      if (st.size < fromBytes) return { status: 'source_shortened', detail: `the source is ${st.size} bytes, shorter than the ${fromBytes} verified bytes`, size: st.size, expected: fromBytes };
      const end = Math.min(st.size, fromBytes + captureLimit);
      const image = Buffer.alloc(end);
      let offset = 0;
      while (offset < end) { const { bytesRead } = await handle.read(image, offset, end - offset, offset); if (!bytesRead) break; offset += bytesRead; }
      const after = await handle.stat();
      if (offset < end || after.size < end) return { status: 'source_unstable', detail: 'the source shrank while it was being read' };
      return { status: 'ok', image, size: st.size, end };
    } finally { await handle?.close(); }
  }

  _classifyRow(line, T) {
    let row;
    try { row = JSON.parse(line); } catch { return { gap: 'malformed_row' }; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return { gap: 'malformed_row' };
    if (typeof row.eventId !== 'string' || !IMPORT_ID_RE.test(row.eventId) || typeof row.timestamp !== 'string' || typeof row.type !== 'string') return { gap: 'anonymous_row' };
    if (row.runId !== T.runId) return { gap: 'foreign_run' };
    if (!IMPORTABLE_TYPES.includes(row.type)) return { unsupported: true, row };
    if (row.taskId !== T.taskId) return { gap: 'foreign_task' };
    if (typeof row.attemptId !== 'string' || !row.attemptId) return { gap: 'missing_attempt_identity' };
    const sourceKey = `harnessorbit:run/${T.runId}/event/${row.eventId}`;
    const sourceBodyHash = sha(canonicalRow(row));
    const legacyRef = { lineage: IMPORT_LINEAGE, sourceId: `harnessorbit:run/${T.runId}`, runId: T.runId, taskId: T.taskId, attemptId: row.attemptId, eventId: row.eventId, type: row.type, timestamp: row.timestamp };
    const bodyHash = sha(canonical({ type: 'history.imported', task: `harnessorbit:job/${T.id}`, legacyRef, sourceBodyHash }));
    const known = new Set(['schemaVersion', 'runId', 'eventId', 'type', 'timestamp', 'taskId', 'attemptId', 'sequence', 'from', 'to', 'errorCode', 'phase', 'source']);
    const clip = v => typeof v === 'string' ? v.slice(0, 200) : v;
    const payload = { observedAt: row.timestamp, runtimeType: row.type, attemptId: clip(row.attemptId), sourceBodyHash, extraFields: Object.keys(row).filter(k => !known.has(k)).length, projection: 'bounded' };
    for (const f of ['sequence', 'from', 'to', 'errorCode', 'phase', 'source']) if (typeof row[f] === 'string' || Number.isInteger(row[f])) payload[f] = clip(row[f]);
    return { row, sourceKey, keyHash: sha(`import:${sourceKey}`), sourceBodyHash, bodyHash, legacyRef, payload: boundedPayload(payload) };
  }

  // Plans a batch from the captured image, from the prior checkpoint, bounded by the line limit,
  // the row size, the batch capture and the prefix cap. Pure: no writes, no re-reads.
  _planRows(capture, prior, T, owner, state, caps, limit) {
    const { image, end, size } = capture;
    const rows = []; const overlay = new Map();
    let at = prior.bytes, lines = 0, gap = null, partialTail = false, capBlocked = false, capReached = false, more = false, lastEventId = prior.lastEventId ?? null;
    while (lines < limit && at < end) {
      const nl = image.indexOf(0x0a, at);
      if (nl < 0) {
        if (end - at > caps.maxRowBytes) gap = { row: prior.rows + lines + 1, byte: at, reason: 'oversized_row' };
        else if (end < size) more = true; // cut by the batch capture, not by the file
        else partialTail = true;
        break;
      }
      const lineEnd = nl + 1;
      if (lineEnd > caps.maxPrefixBytes) { if (lines === 0) capBlocked = true; else capReached = true; more = true; break; }
      if (nl - at > caps.maxRowBytes) { gap = { row: prior.rows + lines + 1, byte: at, reason: 'oversized_row' }; break; }
      const rowNo = prior.rows + lines + 1;
      const cls = this._classifyRow(image.subarray(at, nl).toString('utf8'), T);
      if (cls.gap) { gap = { row: rowNo, byte: at, reason: cls.gap }; break; }
      const entry = { row: rowNo, byte: at, sourceEventId: cls.row.eventId, runtimeType: cls.row.type };
      if (cls.unsupported) { entry.outcome = 'skipped'; entry.reason = 'unsupported_type'; }
      else {
        const ns = `${owner.id}:${owner.incarnation}:${cls.keyHash}`;
        const committed = state.byKey.get(ns);
        const existing = committed ? committed.idempotency.bodyHash : overlay.get(ns);
        if (existing === undefined) { entry.outcome = 'new'; overlay.set(ns, cls.bodyHash); }
        else if (existing === cls.bodyHash) { entry.outcome = 'reused'; entry.planned = !committed; }
        else { gap = { row: rowNo, byte: at, reason: 'conflict', committedBodyHash: existing, sourceBodyHash: cls.sourceBodyHash }; break; }
        Object.assign(entry, { sourceKey: cls.sourceKey, keyHash: cls.keyHash, sourceBodyHash: cls.sourceBodyHash, bodyHash: cls.bodyHash, legacyRef: cls.legacyRef, payload: cls.payload, committedEventId: committed?.event.eventId || null });
      }
      rows.push(entry); lines += 1; at = lineEnd; lastEventId = cls.row.eventId;
    }
    if (lines === limit && at < end) more = true;
    return { rows, lines, toByte: at, range: { fromByte: prior.bytes, toByte: at, lines, sha: sha(image.subarray(0, at)) }, gap, partialTail, more, capBlocked, capReached, lastEventId };
  }

  // Commits the planned new rows one by one, re-reading custody before each new effect. Returns
  // truthfully how far it got; a refusal leaves the plan unresolved for resume.
  async _settlePlan(state, plan, T, hooks) {
    let committed = 0, reused = 0, unsupported = 0; const rows = [];
    for (const entry of plan.rows) {
      if (entry.outcome === 'skipped') { unsupported += 1; rows.push(entry); continue; }
      const ns = `${T.principalId}:${T.principalIncarnation}:${entry.keyHash}`;
      const existing = state.byKey.get(ns);
      if (existing) {
        if (existing.idempotency.bodyHash !== entry.bodyHash) return { committed, reused, unsupported, rows, refused: 'conflict', detail: `row ${entry.row} differs from the committed event ${existing.event.eventId}` };
        reused += 1; rows.push({ ...entry, outcome: 'reused', committedEventId: existing.event.eventId }); continue;
      }
      let fresh;
      try { fresh = await this._custody(T.id); } catch (error) { return { committed, reused, unsupported, rows, refused: error.code || 'permission_denied', detail: error.message }; }
      if (!sameTuple(fresh.tuple, T)) return { committed, reused, unsupported, rows, refused: 'source_remapped', detail: 'the job no longer maps to the frozen run, task and custodian' };
      const owner = fresh.owner;
      const event = {
        schema: COOP_SCHEMA, eventId: uuid(), seq: state.nextSeq, createdAt: this.now(), type: 'history.imported',
        source: { principalId: owner.id, incarnation: owner.incarnation, kind: owner.kind || 'other', via: 'import', binding: null, importer: 'harnessorbit:host', custody: 'authorized custodian of the job, not the proven original author' },
        task: { ref: `harnessorbit:job/${T.id}`, kind: 'job', id: T.id, intentRevision: null },
        legacyRef: entry.legacyRef, conversationRef: null, correlationId: null, causationId: null, hop: 0, payload: entry.payload,
        evidenceRefs: [{ label: 'reported', ref: entry.sourceKey, issuer: 'harnessorbit:importer' }],
      };
      const deliveries = this._deliveriesFor(event, owner, state.recipients);
      await this.store.appendEvent(state, { v: COOP_VERSION, kind: 'event', seq: event.seq, event, idempotency: { principalId: owner.id, incarnation: owner.incarnation, keyHash: entry.keyHash, bodyHash: entry.bodyHash }, deliveries });
      committed += 1; rows.push({ ...entry, outcome: 'new', committedEventId: event.eventId, deliveries: deliveries.map(d => d.consumerId) });
      if (hooks?.afterEventCommit) await hooks.afterEventCommit(committed); // test seam: simulates a crash after a commit
    }
    return { committed, reused, unsupported, rows, refused: null };
  }

  _prepareRecord({ planId, T, prior, range, limit, gap }) {
    return { v: 1, kind: 'import.prepare', planId, at: this.now(), lineage: IMPORT_LINEAGE, sourceId: `harnessorbit:run/${T.runId}`, job: T, prior: { planId: prior.planId, rows: prior.rows, bytes: prior.bytes, sha: prior.sha }, range, limit, gapAt: gap ? { row: gap.row, byte: gap.byte, reason: gap.reason } : null };
  }

  _checkpointRecord({ planId, T, prior, range, lastEventId, settled, gap }) {
    return { v: 1, kind: 'import.checkpoint', planId, at: this.now(), sourceId: `harnessorbit:run/${T.runId}`, job: T, checkpoint: { rows: prior.rows + range.lines, bytes: range.toByte, sha: range.sha, lastEventId }, settled: { new: settled.committed, reused: settled.reused, unsupported: settled.unsupported }, gap: gap ? { row: gap.row, byte: gap.byte, reason: gap.reason } : null };
  }

  // access coop import run-events --job ID [--limit N] [--dry-run]. Host CLI only.
  async importRunEvents({ jobId, limit = 50, dryRun = false, caps = IMPORT_CAPS, hooks = null } = {}) {
    validateId(jobId);
    invariant(Number.isInteger(limit) && limit >= 1 && limit <= MAX_INBOX_LIMIT, 'invalid_arguments', `limit must be 1 to ${MAX_INBOX_LIMIT}.`);
    return this.store.lock(async () => {
      let state;
      if (dryRun) {
        const examined = await this.store._examine();
        const pending = CoopStore.pendingRecovery(examined);
        if (pending) return { ok: false, status: 'recovery_pending', mode: 'dry_run', pendingRecovery: pending, note: 'The store has recovery to apply on its next open; a dry run plans nothing and writes nothing.' };
        state = CoopStore.readOnlyState(examined);
      } else state = await this.store.open();
      const custody = await this._custody(jobId);
      const T = custody.tuple;
      const idx = this._importIndex(state.receipts);
      const sourceId = `harnessorbit:run/${T.runId}`;
      const mode = dryRun ? 'dry_run' : 'fresh';
      const base = { job: T.id, runId: T.runId, sourceId, lineage: IMPORT_LINEAGE, custody: 'authorized custodian, not proven original author' };
      const frozen = idx.byJob.get(T.id);
      if (frozen && !sameTuple(frozen, T)) return { ok: false, status: 'source_remapped', mode, ...base, frozen, current: T, note: 'The job no longer maps to the run, task and custodian it was bound to; nothing imported, nothing written.' };
      const src = idx.bySource.get(sourceId);
      if (src && src.jobId !== T.id) return { ok: false, status: 'source_claimed', mode, ...base, boundJob: src.jobId, note: 'This run is bound to another job; nothing imported, nothing written.' };
      const file = path.join(runPath(this.root, T.runId), 'events.jsonl');
      const unresolved = idx.unresolved.get(sourceId);
      if (unresolved) return this._resumeImport({ state, prepare: unresolved, T, file, caps, dryRun, hooks, base });
      const cp = src?.checkpoint?.checkpoint;
      const prior = cp ? { planId: src.checkpoint.planId, rows: cp.rows, bytes: cp.bytes, sha: cp.sha, lastEventId: cp.lastEventId ?? null } : { planId: null, rows: 0, bytes: 0, sha: EMPTY_SHA, lastEventId: null };
      if (prior.bytes > caps.maxPrefixBytes) return { ok: false, status: 'source_too_large', mode, ...base, prior, note: `The verified prefix exceeds the ${caps.maxPrefixBytes}-byte verification cap.` };
      const capture = await this._captureSource(file, { fromBytes: prior.bytes, captureLimit: caps.captureLimit });
      if (capture.status !== 'ok') return { ok: false, status: capture.status, mode, ...base, prior, detail: capture.detail, note: 'Nothing imported, nothing written; the committed events stand.' };
      if (hooks?.afterCapture) await hooks.afterCapture(); // test seam: a source change after the image was taken
      if (!sameSha(prior.sha, sha(capture.image.subarray(0, prior.bytes)))) return { ok: false, status: 'source_replaced', mode, ...base, prior, note: 'The verified prefix of the source differs from the committed checkpoint; restore the source bytes. Nothing imported, nothing written.' };
      const plan = this._planRows(capture, prior, T, custody.owner, state, caps, limit);
      if (plan.capBlocked) return { ok: false, status: 'source_prefix_cap', mode, ...base, prior, cap: caps.maxPrefixBytes, note: 'The next row would end beyond the prefix verification cap; no row consumed, no plan written.' };
      const bound = Boolean(frozen);
      const result = { ok: true, mode, ...base, planId: null, prior: { rows: prior.rows, bytes: prior.bytes }, range: plan.range, consumed: plan.lines, committed: 0, reused: plan.rows.filter(r => r.outcome === 'reused').length, skipped: { unsupported_type: plan.rows.filter(r => r.outcome === 'skipped').length }, gap: plan.gap, partialTail: plan.partialTail, more: plan.more, capReached: plan.capReached, complete: !plan.gap && !plan.partialTail && !plan.more, rows: plan.rows.map(({ legacyRef: _l, payload: _p, ...r }) => r), wrote: [] };
      if (plan.lines === 0) {
        if (bound || dryRun) return { ...result, bound, wouldBind: !bound && dryRun, note: bound ? 'No complete new row; nothing written.' : 'Dry run: a first import would bind this job to its run with an empty range.' };
        // First-import binding with zero progress: custody becomes durable, the offending bytes do not.
        const planId = uuid();
        await this.store.appendReceipt(state, this._prepareRecord({ planId, T, prior, range: plan.range, limit, gap: plan.gap }));
        await this.store.appendReceipt(state, this._checkpointRecord({ planId, T, prior, range: plan.range, lastEventId: null, settled: { committed: 0, reused: 0, unsupported: 0 }, gap: plan.gap }));
        return { ...result, planId, bound: true, wrote: ['import.prepare', 'import.checkpoint'], note: 'Bound the job to its run; no row was consumed.' };
      }
      if (dryRun) return { ...result, bound, wouldPrepare: this._prepareRecord({ planId: '<new>', T, prior, range: plan.range, limit, gap: plan.gap }), wouldCommit: plan.rows.filter(r => r.outcome === 'new').length, note: 'Dry run: nothing written.' };
      const planId = uuid();
      await this.store.appendReceipt(state, this._prepareRecord({ planId, T, prior, range: plan.range, limit, gap: plan.gap }));
      const settled = await this._settlePlan(state, plan, T, hooks);
      const out = { ...result, planId, bound: true, committed: settled.committed, reused: settled.reused, rows: settled.rows.map(({ legacyRef: _l, payload: _p, ...r }) => r), wrote: ['import.prepare'] };
      if (settled.refused) return { ...out, ok: false, status: settled.refused, detail: settled.detail, planPending: planId, note: `Refused after ${settled.committed} committed row(s); the plan stays unresolved and resumes under the same source constraint.` };
      await this.store.appendReceipt(state, this._checkpointRecord({ planId, T, prior, range: plan.range, lastEventId: plan.lastEventId, settled, gap: plan.gap }));
      out.wrote.push('import.checkpoint');
      return out;
    });
  }

  // An unresolved preparation is authoritative: the same job tuple and the same captured bytes, or
  // an explicit refusal that preserves the plan and the events already committed under it.
  async _resumeImport({ state, prepare, T, file, caps, dryRun, hooks, base }) {
    const mode = dryRun ? 'dry_run' : 'resume';
    const pending = { planId: prepare.planId, range: prepare.range, prior: prepare.prior };
    if (!sameTuple(prepare.job, T)) return { ok: false, status: 'source_remapped', mode, ...base, planPending: prepare.planId, frozen: prepare.job, current: T, note: 'The unresolved plan was prepared for another job mapping; nothing imported, plan preserved.' };
    const toByte = prepare.range.toByte;
    const capture = await this._captureSource(file, { fromBytes: toByte, captureLimit: 0 });
    if (capture.status !== 'ok') return { ok: false, status: capture.status, mode, ...base, planPending: prepare.planId, detail: capture.detail, note: 'The prepared range cannot be re-read; plan and committed events preserved.' };
    if (hooks?.afterCapture) await hooks.afterCapture();
    const verified = sameSha(prepare.range.sha, sha(capture.image.subarray(0, toByte)));
    if (!verified) return { ok: false, status: 'source_replaced', mode, ...base, planPending: prepare.planId, pending, note: 'The source no longer holds the bytes the plan was prepared from; restore them. Plan and committed events preserved; no new event ids.' };
    const prior = { planId: prepare.prior.planId, rows: prepare.prior.rows, bytes: prepare.prior.bytes, sha: prepare.prior.sha, lastEventId: null };
    const plan = this._planRows({ image: capture.image, end: toByte, size: toByte }, prior, T, { id: T.principalId, incarnation: T.principalIncarnation }, state, caps, prepare.limit || MAX_INBOX_LIMIT);
    if (plan.toByte !== toByte || plan.lines !== prepare.range.lines) throw storeError('import_records_invalid', 'The prepared range does not re-derive from the same bytes.', { status: 'import_records_invalid', planId: prepare.planId });
    const result = { ok: true, mode, ...base, planId: prepare.planId, prior: { rows: prior.rows, bytes: prior.bytes }, range: plan.range, consumed: plan.lines, committed: 0, reused: 0, skipped: { unsupported_type: plan.rows.filter(r => r.outcome === 'skipped').length }, gap: prepare.gapAt || null, partialTail: false, more: false, complete: false, rows: plan.rows.map(({ legacyRef: _l, payload: _p, ...r }) => r), wrote: [] };
    if (dryRun) return { ...result, status: 'plan_pending', sourceVerified: true, wouldCommit: plan.rows.filter(r => r.outcome === 'new').length, wouldReuse: plan.rows.filter(r => r.outcome === 'reused').length, note: 'Dry run: an unresolved plan would be settled from its own captured range; nothing written.' };
    const settled = await this._settlePlan(state, plan, T, hooks);
    const out = { ...result, committed: settled.committed, reused: settled.reused, rows: settled.rows.map(({ legacyRef: _l, payload: _p, ...r }) => r) };
    if (settled.refused) return { ...out, ok: false, status: settled.refused, detail: settled.detail, planPending: prepare.planId };
    await this.store.appendReceipt(state, this._checkpointRecord({ planId: prepare.planId, T, prior, range: plan.range, lastEventId: plan.lastEventId, settled, gap: prepare.gapAt || null }));
    return { ...out, wrote: ['import.checkpoint'], note: 'Resumed and settled the unresolved plan; a further batch is a new invocation.' };
  }
}
