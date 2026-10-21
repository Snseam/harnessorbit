import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Orchestrator } from '../src/orchestrator.mjs';
import { PrincipalStore } from '../src/access/principals.mjs';
import { AccessService, ACCESS_TOOLS } from '../src/access/service.mjs';
import { SessionStore } from '../src/access/sessions.mjs';
import { CoopService } from '../src/access/coop.mjs';
import { MemoryService, MemyHandoffCliProvider, NullMemoryProvider, memoryProviderFromEnv, uuidFromOperationId, boundedProvenance } from '../src/access/memory.mjs';
import { startAccessServer } from '../src/access/server.mjs';
import { parseArgs } from '../bin/cao.mjs';
import { fixture, FakeHerdr, writeResult } from './helpers.mjs';

// Verification level: the memory layer runs against a scripted provider and against a fake
// `memy handoff` CLI that speaks memy.handoff.v1 (tests/fixtures/memy/fake-memy.mjs). No real
// Memy server, CLI or connection is involved; this host has none (docs/access.md, "Memory").

const FAKE_MEMY = path.resolve('tests/fixtures/memy/fake-memy.mjs');
const checks = [{ name: 'math', argv: [process.execPath, '--test', 'tests/math.test.mjs'], timeoutMs: 10000 }];
const job = (project, extra = {}) => ({ idempotencyKey: 'req-1', project, objective: 'Fix add to add its two inputs; preserve the existing tests.', context: 'Tests already encode the expected behaviour.', allowedPaths: ['src/math.mjs'], checks, ...extra });
const body = extra => ({ summary: 'add() now adds; tests pass on the host.', goals: ['Make add() add its inputs'], decisions: [{ decision: 'Keep the two-argument signature', rationale: 'callers rely on it' }, 'No new dependencies'], constraints: ['Do not touch tests'], openQuestions: ['Document the fix'], evidence: [{ label: 'reported', ref: 'worker report', summary: 'worker says done' }], ...extra });

class ScriptedProvider {
  constructor(script = {}) { this.name = 'scripted'; this.configured = true; this.script = script; this.calls = []; }
  _answer(tool, input, fallback) {
    this.calls.push({ tool, input });
    const s = this.script[tool];
    if (s === 'hang') return new Promise(() => {});
    if (typeof s === 'function') return Promise.resolve(s(input));
    return Promise.resolve(s || fallback);
  }
  recall(input) { return this._answer('recall', input, { status: 'ok', items: [{ id: 'm1', content: 'Earlier decision: keep add() binary.', type: 'checkpoint', observedAt: '2026-10-01T00:00:00Z', provenance: { source: 'test' } }] }); }
  begin(input) { return this._answer('begin', input, { status: 'admitted', projectId: 'p-1', writeGeneration: 3 }); }
  save(input) {
    // Like Memy, a replay of a saved operation with the same bytes is confirmed as deduplicated.
    this.saved ||= new Map();
    const seen = this.saved.get(input.operationId);
    const fallback = seen ? { status: 'saved', memoryIds: seen, deduplicated: true, writeGeneration: 3 } : { status: 'saved', memoryIds: [`mem-${this.calls.length}`], deduplicated: false, writeGeneration: 3 };
    if (!seen && !this.script.save) this.saved.set(input.operationId, fallback.memoryIds);
    return this._answer('save', input, fallback);
  }
}

async function setup(t, { provider = new ScriptedProvider(), runtime = new FakeHerdr(), timeoutMs = 600 } = {}) {
  const f = await fixture(); t.after(f.remove);
  f.project = await fs.realpath(f.project);
  const orchestrator = new Orchestrator({ stateRoot: f.stateRoot, herdr: runtime });
  const principals = new PrincipalStore({ root: f.stateRoot });
  const { principal, token } = await principals.create({ id: 'grok', projects: [f.project], agents: ['claude', 'codex'], permissions: { sessions: true }, kind: 'grok' });
  const access = new AccessService({ root: f.stateRoot, orchestrator, principals, driver: 'inline' });
  const sessions = new SessionStore({ root: f.stateRoot });
  const memory = new MemoryService({ root: f.stateRoot, provider, principals, sessions, jobs: access.jobs, orchestrator, timeoutMs });
  return { ...f, orchestrator, principals, principal, token, access, sessions, memory, provider };
}

// A bound session record as the session bridge would store it; the pane is never touched here.
const sessionRecord = (project, principal, extra = {}) => ({ id: 'ses-1', bindingId: 'b-1', principalId: principal.id, principalIncarnation: principal.incarnation, label: null, paneId: '%9', target: 'live:0.0', panePid: 1, tmuxSocket: null, agent: { kind: 'claude', pid: 1, startedAt: 'x', comm: 'claude' }, project, allowKeys: false, messages: [], createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z', ...extra });

test('recall needs a target the principal owns, within its projects, and returns bounded evidence that is never injected', async t => {
  const { memory, principal, access, project, sessions, provider } = await setup(t);
  const submitted = await access.submit(principal, job(project));
  await assert.rejects(memory.recall(principal, { question: 'what was decided?' }), e => e.code === 'invalid_memory_request');
  await assert.rejects(memory.recall(principal, { jobId: submitted.job.id, sessionId: 'x', question: 'what?' }), e => e.code === 'invalid_memory_request');
  await assert.rejects(memory.recall(principal, { jobId: submitted.job.id, question: 'hi' }), e => e.code === 'invalid_memory_request');
  await assert.rejects(memory.recall(principal, { jobId: submitted.job.id, question: 'what was decided?', topK: 50 }), e => e.code === 'invalid_memory_request');
  await assert.rejects(memory.recall(principal, { jobId: 'job-missing', question: 'what was decided?' }), e => e.code === 'job_not_found');
  await assert.rejects(memory.recall({ ...principal, id: 'dot' }, { jobId: submitted.job.id, question: 'what was decided?' }), e => e.code === 'permission_denied');
  const recalled = await memory.recall(principal, { jobId: submitted.job.id, question: 'what was decided about add()?', topK: 3, exclude: ['m0'] });
  assert.equal(recalled.status, 'ok');
  assert.equal(recalled.trust, 'untrusted_evidence');
  assert.equal(recalled.items.length, 1);
  assert.equal(recalled.items[0].observedAt, '2026-10-01T00:00:00Z');
  assert.deepEqual(recalled.target, { kind: 'job', id: submitted.job.id, project, agent: 'claude' });
  assert.equal(provider.calls[0].input.project, project, 'the provider gets the recorded checkout, never a caller value');
  assert.equal(provider.calls[0].input.agent, 'claude');
  assert.deepEqual(provider.calls[0].input.exclude, ['m0']);
  await sessions.create(sessionRecord('/definitely/elsewhere', principal));
  await assert.rejects(memory.recall(principal, { sessionId: 'ses-1', question: 'what was decided?' }), e => e.code === 'project_not_allowed');
  await sessions.remove('ses-1'); await sessions.create(sessionRecord(project, principal));
  assert.equal((await memory.recall(principal, { sessionId: 'ses-1', question: 'what was decided?' })).target.kind, 'session');
  await assert.rejects(memory.recall({ ...principal, id: 'dot' }, { sessionId: 'ses-1', question: 'what was decided?' }), e => e.code === 'permission_denied');
});

test('recall reports unconfigured, timeout, denied and degraded providers instead of pretending, and bounds the payload', async t => {
  const none = await setup(t, { provider: new NullMemoryProvider() });
  const s1 = await none.access.submit(none.principal, job(none.project));
  const unconfigured = await none.memory.recall(none.principal, { jobId: s1.job.id, question: 'anything known?' });
  assert.equal(unconfigured.status, 'unconfigured');
  assert.equal(unconfigured.reason, 'setup_unavailable');
  assert.deepEqual(unconfigured.items, []);
  const slow = await setup(t, { provider: new ScriptedProvider({ recall: 'hang' }), timeoutMs: 500 });
  const s2 = await slow.access.submit(slow.principal, job(slow.project));
  assert.equal((await slow.memory.recall(slow.principal, { jobId: s2.job.id, question: 'anything known?' })).status, 'timeout');
  const denied = await setup(t, { provider: new ScriptedProvider({ recall: { status: 'denied', reason: 'forbidden', items: [] } }) });
  const s3 = await denied.access.submit(denied.principal, job(denied.project));
  assert.equal((await denied.memory.recall(denied.principal, { jobId: s3.job.id, question: 'anything known?' })).reason, 'forbidden');
  const big = 'x'.repeat(5000);
  const degraded = await setup(t, { provider: new ScriptedProvider({ recall: { status: 'degraded', items: [{ id: 'a', content: big }, { id: 'b', content: big }, { id: 'c', content: big }] } }) });
  const s4 = await degraded.access.submit(degraded.principal, job(degraded.project));
  const view = await degraded.memory.recall(degraded.principal, { jobId: s4.job.id, question: 'anything known?', topK: 3 });
  assert.equal(view.status, 'degraded');
  assert.ok(view.items.every(item => item.content.length <= 1200));
  assert.ok(JSON.stringify(view.items).length <= 9000);
  assert.deepEqual(boundedProvenance({ source_id: 's'.repeat(900), nested: { deep: true }, tags: ['a', 'b'], n: 1 }), { source_id: `${'s'.repeat(199)}…`, tags: ['a', 'b'], n: 1 });
});

test('begin admits once per operationId and binds it to principal, target and checkout; checkpoint without begin is refused', async t => {
  const { memory, principal, access, project, provider, sessions } = await setup(t);
  const submitted = await access.submit(principal, job(project));
  await assert.rejects(memory.checkpoint(principal, { jobId: submitted.job.id, operationId: 'op-1', ...body() }), e => e.code === 'not_begun', 'save never admits implicitly');
  assert.equal(provider.calls.filter(c => c.tool === 'save').length, 0);
  const admitted = await memory.begin(principal, { jobId: submitted.job.id, operationId: 'op-1' });
  assert.equal(admitted.status, 'admitted');
  assert.equal(admitted.writeGeneration, 3);
  assert.equal(admitted.repeated, false);
  assert.equal(provider.calls.at(-1).input.project, project);
  assert.equal((await memory.begin(principal, { jobId: submitted.job.id, operationId: 'op-1' })).repeated, true, 'begin is idempotent and re-checked');
  const other = await access.submit(principal, job(project, { idempotencyKey: 'req-2' }));
  await assert.rejects(memory.begin(principal, { jobId: other.job.id, operationId: 'op-1' }), e => e.code === 'operation_conflict', 'an operation stays bound to its first target');
  await sessions.create(sessionRecord(project, principal));
  await assert.rejects(memory.checkpoint(principal, { sessionId: 'ses-1', operationId: 'op-1', ...body() }), e => e.code === 'operation_conflict');
  await assert.rejects(memory.begin({ ...principal, id: 'dot' }, { jobId: submitted.job.id, operationId: 'op-1' }), e => e.code === 'permission_denied');
  const unconfigured = await setup(t, { provider: new NullMemoryProvider() });
  const s2 = await unconfigured.access.submit(unconfigured.principal, job(unconfigured.project));
  assert.equal((await unconfigured.memory.begin(unconfigured.principal, { jobId: s2.job.id, operationId: 'u' })).status, 'unconfigured');
  const notSaved = await unconfigured.memory.checkpoint(unconfigured.principal, { jobId: s2.job.id, operationId: 'u', ...body() });
  assert.equal(notSaved.status, 'unconfigured', 'without a provider the answer is explicit, not pending and not an error');
});

test('checkpoint freezes the document, is idempotent per operationId, refuses a different body, and keeps caller evidence apart from machine verification', async t => {
  const { memory, principal, access, project, provider, sessions } = await setup(t);
  const submitted = await access.submit(principal, job(project));
  await access.status(principal, { jobId: submitted.job.id });
  await memory.begin(principal, { jobId: submitted.job.id, operationId: 'op-1' });
  await assert.rejects(memory.checkpoint(principal, { jobId: submitted.job.id, operationId: 'op-1', ...body({ evidence: [{ label: 'integrated', ref: 'checkout' }] }) }), e => e.code === 'evidence_conflict' && e.details.attemptStatus === 'accepted');
  const saved = await memory.checkpoint(principal, { jobId: submitted.job.id, operationId: 'op-1', ...body({ evidence: [{ label: 'verified', ref: 'checks: math', summary: 'passed on host' }] }) });
  assert.equal(saved.status, 'saved');
  assert.equal(saved.memoryIds.length, 1);
  const sent = provider.calls.find(c => c.tool === 'save').input;
  assert.equal(sent.project, project);
  const doc = sent.document;
  assert.equal(doc.schema, 'memy.handoff.checkpoint.v1');
  assert.equal(doc.session.agent, 'claude_code');
  assert.equal(doc.task.id, `harnessorbit:job/${submitted.job.id}`);
  assert.deepEqual(doc.orchestrator, { name: 'harnessorbit', version: '0.4.0' });
  assert.deepEqual(doc.participants.slice(0, 2), [{ id: 'principal:grok', kind: 'grok', role: 'principal' }, { id: 'harnessorbit', kind: 'orchestrator', role: 'orchestrator' }]);
  assert.deepEqual(doc.decisions, [{ decision: 'Keep the two-argument signature', rationale: 'callers rely on it' }, { decision: 'No new dependencies' }]);
  assert.deepEqual(doc.evidence[0], { label: 'verified', ref: 'checks: math', issuer: 'principal:grok', summary: 'passed on host' }, 'caller evidence stays attributed to the caller');
  assert.equal(doc.evidence[1].issuer, 'harnessorbit:verifier');
  assert.match(doc.evidence[1].ref, /^harnessorbit:attempt\/main-a1-/);
  assert.equal(doc.evidence[1].label, 'verified');
  assert.match(doc.evidence[1].summary, /checks math: passed; patch sha256 [0-9a-f]{64}/);
  for (const forbidden of ['project_id', 'tenant_id', 'namespace', 'receipt_agent', 'write_generation']) assert.equal(doc[forbidden], undefined);
  assert.equal(JSON.parse(sent.canonical).summary, doc.summary, 'canonical bytes are the document');
  const again = await memory.checkpoint(principal, { jobId: submitted.job.id, operationId: 'op-1', ...body({ evidence: [{ label: 'verified', ref: 'checks: math', summary: 'passed on host' }] }) });
  assert.equal(again.status, 'deduplicated');
  assert.deepEqual(again.memoryIds, saved.memoryIds);
  const saves = provider.calls.filter(c => c.tool === 'save');
  assert.equal(saves.length, 2, 'a replay goes back to the provider, which re-checks authority and confirms the duplicate');
  assert.equal(saves[0].input.canonical, saves[1].input.canonical, 'the replay carries the frozen bytes');
  await assert.rejects(memory.checkpoint(principal, { jobId: submitted.job.id, operationId: 'op-1', ...body({ summary: 'Something else' }) }), e => e.code === 'checkpoint_conflict');
  // A live session can only report; its document says agent claude_code but carries no machine evidence.
  await sessions.create(sessionRecord(project, principal));
  await memory.begin(principal, { sessionId: 'ses-1', operationId: 'op-2' });
  await assert.rejects(memory.checkpoint(principal, { sessionId: 'ses-1', operationId: 'op-2', ...body({ evidence: [{ label: 'verified', ref: 'agent said so' }] }) }), e => e.code === 'evidence_conflict');
  const reported = await memory.checkpoint(principal, { sessionId: 'ses-1', operationId: 'op-2', ...body() });
  assert.equal(reported.status, 'saved');
  const sessionDoc = provider.calls.at(-1).input.document;
  assert.equal(sessionDoc.evidence.length, 1);
  assert.equal(sessionDoc.evidence[0].issuer, 'principal:grok');
  assert.equal(sessionDoc.session.id, 'ses-1');
  // A reworked job cannot claim verified; the machine evidence then says reported.
  const failing = await setup(t, { runtime: new FakeHerdr(p => writeResult(p, { fix: false })) });
  const bad = await failing.access.submit(failing.principal, job(failing.project));
  await failing.access.status(failing.principal, { jobId: bad.job.id });
  await failing.memory.begin(failing.principal, { jobId: bad.job.id, operationId: 'op-3' });
  await assert.rejects(failing.memory.checkpoint(failing.principal, { jobId: bad.job.id, operationId: 'op-3', ...body({ evidence: [{ label: 'verified', ref: 'checks' }] }) }), e => e.code === 'evidence_conflict' && e.details.attemptStatus === 'rework');
  assert.equal((await failing.memory.checkpoint(failing.principal, { jobId: bad.job.id, operationId: 'op-3', ...body() })).status, 'saved');
  assert.equal(failing.provider.calls.at(-1).input.document.evidence.at(-1).label, 'reported');
  assert.equal(failing.provider.calls.at(-1).input.document.evidence.at(-1).issuer, 'harnessorbit:verifier');
});

test('a checkpoint the provider cannot confirm stays pending with frozen bytes, re-authorizes on retry, and denied is final', async t => {
  const flaky = new ScriptedProvider({ save: { status: 'timeout', reason: 'timeout' } });
  const { memory, principal, access, project, stateRoot, principals } = await setup(t, { provider: flaky });
  const submitted = await access.submit(principal, job(project));
  await memory.begin(principal, { jobId: submitted.job.id, operationId: 'must' });
  const first = await memory.checkpoint(principal, { jobId: submitted.job.id, operationId: 'must', ...body() });
  assert.equal(first.status, 'pending');
  assert.equal(first.attempts, 1);
  assert.equal((await memory.pending(principal)).pending[0].operationId, 'must');
  assert.equal((await fs.readdir(path.join(stateRoot, 'access', 'memory', 'pending'))).length, 1);
  await assert.rejects(memory.checkpoint(principal, { jobId: submitted.job.id, operationId: 'must', ...body({ summary: 'changed' }) }), e => e.code === 'checkpoint_conflict');
  // Another target under the same operation is a conflict even with the body omitted.
  const other = await access.submit(principal, job(project, { idempotencyKey: 'req-2' }));
  await assert.rejects(memory.checkpoint(principal, { jobId: other.job.id, operationId: 'must' }), e => e.code === 'operation_conflict');
  await assert.rejects(memory.checkpoint(principal, { sessionId: 'ses-x', operationId: 'must' }), e => e.code === 'session_not_found');
  // Revoked permission is honoured inside the lock, before the provider is called.
  const before = flaky.calls.length;
  await principals.update(principal.id, { permissions: { submit: false } });
  await assert.rejects(memory.checkpoint(principal, { jobId: submitted.job.id, operationId: 'must' }), e => e.code === 'permission_denied');
  assert.equal(flaky.calls.length, before);
  await principals.update(principal.id, { permissions: { submit: true } });
  // The provider recovers; the retry sends identical bytes and the same observed_at.
  flaky.script.save = { status: 'saved', memoryIds: ['mem-late'], deduplicated: false, writeGeneration: 3 };
  const finished = await memory.checkpoint(principal, { jobId: submitted.job.id, operationId: 'must' });
  assert.equal(finished.status, 'saved');
  const attempts = flaky.calls.filter(c => c.tool === 'save' && c.input.operationId === 'must');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].input.canonical, attempts[1].input.canonical, 'retry sends the frozen bytes');
  assert.equal((await memory.pending(principal)).pending.length, 0);
  flaky.script.save = { status: 'saved', memoryIds: ['mem-late'], deduplicated: true, writeGeneration: 3 };
  assert.equal((await memory.checkpoint(principal, { jobId: submitted.job.id, operationId: 'must', ...body() })).status, 'deduplicated', 'the replay is confirmed by the provider');
  // Denied is final: recorded, not pending, and later calls answer denied without contacting the provider.
  const denying = new ScriptedProvider({ save: { status: 'denied', reason: 'collection_changed' } });
  const d = await setup(t, { provider: denying });
  const dj = await d.access.submit(d.principal, job(d.project));
  await d.memory.begin(d.principal, { jobId: dj.job.id, operationId: 'd1' });
  assert.equal((await d.memory.checkpoint(d.principal, { jobId: dj.job.id, operationId: 'd1', ...body() })).status, 'denied');
  assert.equal((await d.memory.pending(d.principal)).pending.length, 0);
  const saves = denying.calls.filter(c => c.tool === 'save').length;
  const later = await d.memory.checkpoint(d.principal, { jobId: dj.job.id, operationId: 'd1', ...body() });
  assert.equal(later.status, 'denied');
  assert.equal(later.reason, 'collection_changed');
  assert.equal(denying.calls.filter(c => c.tool === 'save').length, saves + 1, 'denial is re-asked of the provider, never answered from a local cache');
  // A permission revoked while another checkpoint holds the lock is honoured before sending.
  const slowProvider = new ScriptedProvider({ save: () => new Promise(resolve => setTimeout(() => resolve({ status: 'saved', memoryIds: ['slow'] }), 400)) });
  const race = await setup(t, { provider: slowProvider, timeoutMs: 2000 });
  const r1 = await race.access.submit(race.principal, job(race.project));
  await race.memory.begin(race.principal, { jobId: r1.job.id, operationId: 'race' });
  const a = race.memory.checkpoint(race.principal, { jobId: r1.job.id, operationId: 'race', ...body() });
  await new Promise(r => setTimeout(r, 50));
  const b = race.memory.checkpoint(race.principal, { jobId: r1.job.id, operationId: 'race', ...body() });
  await race.principals.update(race.principal.id, { permissions: { submit: false } });
  assert.equal((await a).status, 'saved');
  await assert.rejects(b, e => e.code === 'permission_denied');
  assert.equal(slowProvider.calls.filter(c => c.tool === 'save').length, 1);
});

test('the memy handoff CLI provider runs in the checkout, speaks memy.handoff.v1, and maps every contract status', async t => {
  const f = await fixture(); t.after(f.remove);
  const project = await fs.realpath(f.project);
  const log = path.join(f.base, 'memy.log'); const state = path.join(f.base, 'memy-state.json');
  const env = { ...process.env, FAKE_MEMY_LOG: log, FAKE_MEMY_STATE: state };
  const run = mode => (argv, opts) => import('../src/process.mjs').then(m => m.runCommand(argv, { ...opts, env: { ...env, FAKE_MEMY_MODE: mode } }));
  const provider = mode => new MemyHandoffCliProvider({ argv: [process.execPath, FAKE_MEMY], timeoutMs: 1500, command: run(mode) });
  const calls = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const ok = provider('ok');
  assert.equal((await ok.recall({ project, agent: 'pi', question: 'q' })).reason, 'agent_unsupported', 'only claude and codex grants exist');
  const recalled = await ok.recall({ project, agent: 'claude', question: 'what was decided?', topK: 2, exclude: ['m-2'] });
  assert.equal(recalled.status, 'ok');
  assert.equal(recalled.items.length, 1);
  assert.equal(recalled.items[0].id, 'm-1');
  assert.ok(recalled.items[0].provenance.source_id.length <= 200, 'long provenance values are clipped structurally');
  assert.equal(recalled.items[0].provenance.nested, undefined);
  assert.deepEqual(recalled.omitted, { excluded: 1, over_budget: 0, duplicate: 0 });
  let seen = await calls();
  assert.equal(seen[0].cwd, project, 'memy runs in the bound checkout');
  assert.equal(seen[0].flags.agent, 'claude-code');
  assert.equal(seen[0].flags.query, 'what was decided?');
  assert.deepEqual(seen[0].excludes, ['m-2']);
  assert.equal(seen[0].flags['top-k'], '2');
  const begun = await ok.begin({ project, agent: 'codex', operationId: 'op-7' });
  assert.equal(begun.status, 'admitted');
  assert.equal(begun.writeGeneration, 3);
  seen = await calls();
  assert.equal(seen[1].flags['operation-id'], uuidFromOperationId('op-7'));
  assert.equal(seen[1].flags.agent, 'codex');
  const document = { schema: 'memy.handoff.checkpoint.v1', observed_at: '2026-10-21T10:00:00.000Z', summary: 's', goals: [], decisions: [], constraints: [], open_questions: [], task: { id: 't' }, session: { id: 'x', agent: 'codex' }, participants: [], orchestrator: { name: 'harnessorbit', version: '0.4.0' }, evidence: [] };
  const canonical = JSON.stringify(document);
  const saved = await ok.save({ project, agent: 'codex', operationId: 'op-7', canonical, document });
  assert.equal(saved.status, 'saved');
  assert.deepEqual(saved.memoryIds, ['00000000-0000-4000-8000-000000000001']);
  assert.equal(saved.deduplicated, false);
  seen = await calls();
  assert.equal(seen[2].stdin, `${canonical}\n`, 'stdin carries the canonical document');
  const replay = await ok.save({ project, agent: 'codex', operationId: 'op-7', canonical, document });
  assert.equal(replay.status, 'saved');
  assert.equal(replay.deduplicated, true);
  assert.equal((await ok.save({ project, agent: 'codex', operationId: 'op-7', canonical: canonical.replace('"s"', '"changed"'), document })).status, 'conflict');
  assert.equal((await ok.save({ project, agent: 'claude', operationId: 'op-7', canonical, document })).status, 'denied', 'a session agent that differs from the grant is agent_mismatch');
  assert.equal((await ok.save({ project, agent: 'codex', operationId: 'op-never-begun', canonical, document })).reason, 'not_begun');
  assert.equal((await provider('not_connected').begin({ project, agent: 'claude', operationId: 'n' })).reason, 'not_connected');
  assert.equal((await provider('denied').recall({ project, agent: 'claude', question: 'q' })).status, 'denied');
  assert.equal((await provider('paused').begin({ project, agent: 'claude', operationId: 'p' })).reason, 'collection_paused');
  assert.equal((await provider('pending').save({ project, agent: 'codex', operationId: 'op-7', canonical, document })).status, 'saved', 'a replay of a saved operation is served from the fake journal');
  assert.equal((await provider('protocol').recall({ project, agent: 'claude', question: 'q' })).reason, 'protocol');
  assert.equal((await provider('invalid').recall({ project, agent: 'claude', question: 'q' })).status, 'invalid');
  const hung = await provider('hang').recall({ project, agent: 'claude', question: 'q' });
  assert.equal(hung.status, 'timeout');
  const missing = new MemyHandoffCliProvider({ argv: [path.join(f.base, 'no-such-memy')], timeoutMs: 1000 });
  assert.equal((await missing.recall({ project, agent: 'claude', question: 'q' })).reason, 'setup_unavailable');
  assert.ok(!(await fs.readFile(log, 'utf8')).includes('tenant'), 'nothing about tenants or namespaces is ever sent');
  assert.equal(memoryProviderFromEnv({}).name, 'none');
  assert.equal(memoryProviderFromEnv({ HARNESSORBIT_MEMORY_PROVIDER: 'memy-handoff-cli' }).name, 'memy-handoff-cli');
  assert.equal(memoryProviderFromEnv({ HARNESSORBIT_MEMORY_PROVIDER: 'something' }).name, 'none');
  assert.match(uuidFromOperationId('op-x'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('MemoryService on the fake memy CLI: begin, save, replay and a changed-generation denial end to end', async t => {
  const f = await fixture(); t.after(f.remove);
  const project = await fs.realpath(f.project);
  const env = { ...process.env, FAKE_MEMY_LOG: path.join(f.base, 'memy.log'), FAKE_MEMY_STATE: path.join(f.base, 'memy-state.json') };
  const command = (argv, opts) => import('../src/process.mjs').then(m => m.runCommand(argv, { ...opts, env: { ...env, FAKE_MEMY_MODE: env.MODE || 'ok' } }));
  const provider = new MemyHandoffCliProvider({ argv: [process.execPath, FAKE_MEMY], timeoutMs: 1500, command });
  const orchestrator = new Orchestrator({ stateRoot: f.stateRoot, herdr: new FakeHerdr() });
  const principals = new PrincipalStore({ root: f.stateRoot });
  const { principal } = await principals.create({ id: 'grok', projects: [project], agents: ['claude', 'codex'], kind: 'grok' });
  const access = new AccessService({ root: f.stateRoot, orchestrator, principals, driver: 'inline' });
  const memory = new MemoryService({ root: f.stateRoot, provider, principals, jobs: access.jobs, orchestrator, timeoutMs: 1500 });
  const submitted = await access.submit(principal, job(project, { agent: 'codex' }));
  assert.equal((await memory.begin(principal, { jobId: submitted.job.id, operationId: 'e2e' })).status, 'admitted');
  const saved = await memory.checkpoint(principal, { jobId: submitted.job.id, operationId: 'e2e', ...body() });
  assert.equal(saved.status, 'saved');
  assert.deepEqual(saved.memoryIds, ['00000000-0000-4000-8000-000000000001']);
  assert.equal((await memory.checkpoint(principal, { jobId: submitted.job.id, operationId: 'e2e', ...body() })).status, 'deduplicated');
  const log = (await fs.readFile(env.FAKE_MEMY_LOG, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(log.map(l => l.command), ['begin', 'save', 'save'], 'the replay is re-sent and confirmed by memy as a duplicate');
  assert.equal(log[1].stdin, log[2].stdin, 'the replay carries the same bytes');
  assert.equal(JSON.parse(log[1].stdin).session.agent, 'codex');
  assert.equal(JSON.parse(log[1].stdin).participants[0].kind, 'grok');
});

test('MCP exposes memory_recall, memory_begin and memory_checkpoint with audit lines that carry the status but no content', async t => {
  const { access, memory, token, project, stateRoot } = await setup(t);
  const started = await startAccessServer({ service: access, memory, toolTimeoutMs: 10000 });
  t.after(started.close);
  const post = async (payload) => (await fetch(started.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(payload) })).json();
  const call = async (id, name, args = {}) => (await post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })).result;
  const list = await post({ jsonrpc: '2.0', id: 0, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map(tool => tool.name), [...ACCESS_TOOLS]);
  const described = await call(1, 'describe');
  assert.equal(described.structuredContent.memory.provider, 'scripted');
  assert.equal(described.structuredContent.memory.contract, 'memy.handoff.v1');
  const jobId = (await call(2, 'submit', job(project))).structuredContent.job.id;
  assert.equal((await call(3, 'memory_recall', { jobId, question: 'what did we decide about the quokka?' })).structuredContent.status, 'ok');
  assert.equal((await call(4, 'memory_begin', { jobId, operationId: 'mcp-1' })).structuredContent.status, 'admitted');
  const saved = await call(5, 'memory_checkpoint', { jobId, operationId: 'mcp-1', ...body({ summary: 'secret summary about the quokka' }) });
  assert.equal(saved.isError, false, JSON.stringify(saved.structuredContent));
  assert.equal(saved.structuredContent.status, 'saved');
  const conflict = await call(6, 'memory_checkpoint', { jobId, operationId: 'mcp-1', ...body({ summary: 'another summary' }) });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent.code, 'checkpoint_conflict');
  const audit = await fs.readFile(path.join(stateRoot, 'access', 'audit.jsonl'), 'utf8');
  assert.ok(!audit.includes('quokka'));
  assert.ok(!audit.includes(token));
  const lines = audit.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.slice(-4).map(l => l.tool), ['memory_recall', 'memory_begin', 'memory_checkpoint', 'memory_checkpoint']);
  assert.equal(lines.at(-1).code, 'checkpoint_conflict');
  const bare = await startAccessServer({ service: access, toolTimeoutMs: 5000 });
  t.after(bare.close);
  const none = await (await fetch(bare.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'memory_begin', arguments: { jobId, operationId: 'x' } } }) })).json();
  assert.equal(none.result.structuredContent.code, 'memory_unavailable');
});

test('CLI parses the memory subcommands', () => {
  assert.equal(parseArgs(['access', 'memory', 'recall', '--principal', 'grok', '--job', 'job-1', '--question', 'what?', '--top-k', '3']).values['top-k'], '3');
  assert.equal(parseArgs(['access', 'memory', 'begin', '--principal', 'grok', '--session', 's', '--operation', 'op']).command, 'access memory begin');
  assert.equal(parseArgs(['access', 'memory', 'checkpoint', '--principal', 'grok', '--session', 's', '--operation', 'op', '--file', 'c.json']).values.file, 'c.json');
  assert.equal(parseArgs(['access', 'memory', 'pending']).command, 'access memory pending');
  assert.equal(parseArgs(['access', 'principal', 'create', '--id', 'g', '--project', '/p', '--kind', 'grok']).values.kind, 'grok');
});

test('review regressions: replay goes through the provider, incarnations never continue each other, frozen bytes are durable before the send, transport words are not thrown, blank or mismatched receipts are protocol errors', async t => {
  // 1. A saved operation replayed after a remote clear is answered by Memy (denied), never by the local receipt.
  const p1 = new ScriptedProvider();
  const a = await setup(t, { provider: p1 });
  const j1 = await a.access.submit(a.principal, job(a.project));
  await a.memory.begin(a.principal, { jobId: j1.job.id, operationId: 'saved-op' });
  assert.equal((await a.memory.checkpoint(a.principal, { jobId: j1.job.id, operationId: 'saved-op', ...body() })).status, 'saved');
  p1.script.save = { status: 'denied', reason: 'collection_changed' };
  const before = p1.calls.length;
  const replay = await a.memory.checkpoint(a.principal, { jobId: j1.job.id, operationId: 'saved-op' });
  assert.equal(replay.status, 'denied');
  assert.equal(replay.reason, 'collection_changed');
  assert.equal(p1.calls.length, before + 1, 'the replay was sent to the provider');
  // 2. A principal id removed and created again is a new incarnation: it cannot take over a pending operation or its target.
  const p2 = new ScriptedProvider({ save: { status: 'pending', reason: 'offline' } });
  const b = await setup(t, { provider: p2 });
  const j2 = await b.access.submit(b.principal, job(b.project));
  await b.memory.begin(b.principal, { jobId: j2.job.id, operationId: 'pending-op' });
  assert.equal((await b.memory.checkpoint(b.principal, { jobId: j2.job.id, operationId: 'pending-op', ...body() })).status, 'pending');
  await b.sessions.create(sessionRecord(b.project, b.principal));
  await b.principals.remove('grok');
  const reborn = (await b.principals.create({ id: 'grok', projects: [b.project], agents: ['claude', 'codex'], permissions: { sessions: true }, kind: 'human' })).principal;
  assert.notEqual(reborn.incarnation, b.principal.incarnation);
  p2.script.save = null;
  const saves = p2.calls.filter(c => c.tool === 'save').length;
  await assert.rejects(b.memory.checkpoint(reborn, { jobId: j2.job.id, operationId: 'pending-op' }), e => e.code === 'job_not_found', 'the job belongs to the earlier incarnation');
  await assert.rejects(b.memory.begin(reborn, { sessionId: 'ses-1', operationId: 'pending-op' }), e => e.code === 'session_not_found');
  assert.equal(p2.calls.filter(c => c.tool === 'save').length, saves, 'the former principal’s bytes were never sent');
  // 3. The frozen document is on disk before the provider is called, so a crash after acceptance cannot change the retry.
  let durableAtSend = null; let c;
  const p3 = new ScriptedProvider({ save: async () => { durableAtSend = await fs.stat(path.join(c.stateRoot, 'access', 'memory', 'pending', `${crypto.createHash('sha256').update('crash-op').digest('hex')}.json`)).then(() => true, () => false); return { status: 'pending', reason: 'timeout' }; } });
  c = await setup(t, { provider: p3 });
  const j3 = await c.access.submit(c.principal, job(c.project));
  await c.memory.begin(c.principal, { jobId: j3.job.id, operationId: 'crash-op' });
  await c.memory.checkpoint(c.principal, { jobId: j3.job.id, operationId: 'crash-op', ...body() });
  assert.equal(durableAtSend, true);
  const first = p3.calls.filter(x => x.tool === 'save')[0].input;
  p3.script.save = { status: 'saved', memoryIds: ['m'], deduplicated: false, writeGeneration: 3, projectId: 'p-1' };
  await new Promise(r => setTimeout(r, 5));
  await c.memory.checkpoint(c.principal, { jobId: j3.job.id, operationId: 'crash-op', ...body() });
  const second = p3.calls.filter(x => x.tool === 'save')[1].input;
  assert.equal(second.canonical, first.canonical);
  assert.equal(second.document.observed_at, first.document.observed_at);
  // 4. Transport words from a provider are retryable statuses, not thrown errors.
  const p4 = new ScriptedProvider({ begin: { status: 'unavailable', reason: 'offline' }, save: { status: 'offline' } });
  const d = await setup(t, { provider: p4 });
  const j4 = await d.access.submit(d.principal, job(d.project));
  const begun = await d.memory.begin(d.principal, { jobId: j4.job.id, operationId: 'u' });
  assert.equal(begun.status, 'timeout');
  assert.equal(begun.reason, 'offline');
  const p4b = new ScriptedProvider({ save: { status: 'offline' } });
  const d2 = await setup(t, { provider: p4b });
  const j4b = await d2.access.submit(d2.principal, job(d2.project));
  await d2.memory.begin(d2.principal, { jobId: j4b.job.id, operationId: 'u2' });
  const off = await d2.memory.checkpoint(d2.principal, { jobId: j4b.job.id, operationId: 'u2', ...body() });
  assert.equal(off.status, 'pending');
  assert.equal(off.reason, 'offline');
  // 5. A success envelope without the contract's fields is a protocol error, never a success with blanks.
  const response = (sub, status, extra = {}) => ({ code: ['admitted', 'saved'].includes(status) ? 0 : 1, stdout: JSON.stringify({ schema: 'memy.handoff.v1', command: sub, status, ...extra }) });
  const malformed = new MemyHandoffCliProvider({ command: async argv => response(argv[2], argv[2] === 'begin' ? 'admitted' : 'saved') });
  const e = await setup(t, { provider: malformed });
  const j5 = await e.access.submit(e.principal, job(e.project));
  const mb = await e.memory.begin(e.principal, { jobId: j5.job.id, operationId: 'malformed-op' });
  assert.equal(mb.status, 'error');
  assert.equal(mb.reason, 'protocol');
  await assert.rejects(e.memory.checkpoint(e.principal, { jobId: j5.job.id, operationId: 'malformed-op', ...body() }), x => x.code === 'not_begun', 'a blank admission admits nothing');
  const wrongOp = new MemyHandoffCliProvider({ command: async argv => response(argv[2], 'admitted', { operation_id: '00000000-0000-5000-8000-000000000000', project_id: '11111111-1111-4111-8111-111111111111', write_generation: 0 }) });
  const e2 = await setup(t, { provider: wrongOp });
  const j5b = await e2.access.submit(e2.principal, job(e2.project));
  assert.equal((await e2.memory.begin(e2.principal, { jobId: j5b.job.id, operationId: 'other-op' })).reason, 'protocol', 'an admission for another operation is refused');
  // 6. A receipt that names a different Project or generation than the admission is not recorded as saved.
  const p6 = new ScriptedProvider({ save: { status: 'saved', memoryIds: ['m'], deduplicated: false, writeGeneration: 9, projectId: 'p-2' } });
  const f6 = await setup(t, { provider: p6 });
  const j6 = await f6.access.submit(f6.principal, job(f6.project));
  await f6.memory.begin(f6.principal, { jobId: j6.job.id, operationId: 'mm' });
  const mismatch = await f6.memory.checkpoint(f6.principal, { jobId: j6.job.id, operationId: 'mm', ...body() });
  assert.equal(mismatch.status, 'pending');
  assert.equal(mismatch.reason, 'protocol');
  assert.equal((await f6.memory.pending(f6.principal)).pending.length, 1);
});

test('review regressions: a frozen pending checkpoint survives a missing CLI and a strict receipt is required', async t => {
  // A pending operation keeps its bytes while the provider is unconfigured, and resends them unchanged later.
  const gap = new ScriptedProvider({ save: { status: 'pending', reason: 'timeout' } });
  const g = await setup(t, { provider: gap });
  const jg = await g.access.submit(g.principal, job(g.project));
  await g.memory.begin(g.principal, { jobId: jg.job.id, operationId: 'gap' });
  assert.equal((await g.memory.checkpoint(g.principal, { jobId: jg.job.id, operationId: 'gap', ...body() })).status, 'pending');
  const first = gap.calls.filter(c => c.tool === 'save')[0].input;
  gap.script.save = { status: 'unconfigured', reason: 'setup_unavailable' };
  const during = await g.memory.checkpoint(g.principal, { jobId: jg.job.id, operationId: 'gap' });
  assert.equal(during.status, 'unconfigured');
  assert.equal((await g.memory.pending(g.principal)).pending.length, 1, 'the frozen document is kept while the CLI is missing');
  gap.script.save = { status: 'invalid', reason: 'too_large' };
  assert.equal((await g.memory.checkpoint(g.principal, { jobId: jg.job.id, operationId: 'gap' })).status, 'invalid');
  assert.equal((await g.memory.pending(g.principal)).pending.length, 1, 'an invalid answer does not discard the frozen document either');
  gap.script.save = { status: 'saved', memoryIds: ['m'], deduplicated: false, writeGeneration: 3, projectId: 'p-1' };
  await new Promise(r => setTimeout(r, 5));
  assert.equal((await g.memory.checkpoint(g.principal, { jobId: jg.job.id, operationId: 'gap' })).status, 'saved');
  const last = gap.calls.filter(c => c.tool === 'save').at(-1).input;
  assert.equal(last.canonical, first.canonical, 'the bytes after the gap are the first attempt’s');
  assert.equal(last.document.observed_at, first.document.observed_at);
  assert.equal((await g.memory.pending(g.principal)).pending.length, 0);
  // Receipts must carry UUID identifiers as the contract promises.
  const response = (sub, extra) => ({ code: 0, stdout: JSON.stringify({ schema: 'memy.handoff.v1', command: sub, status: sub === 'begin' ? 'admitted' : 'saved', reason: null, ...extra }) });
  const uuid = '11111111-1111-4111-8111-111111111111';
  const loose = new MemyHandoffCliProvider({ command: async argv => { const op = argv[argv.indexOf('--operation-id') + 1]; return response(argv[2], argv[2] === 'begin' ? { operation_id: op, project_id: uuid, write_generation: 0 } : { operation_id: op, project_id: uuid, write_generation: 0, memory_ids: ['not-a-uuid'], deduplicated: false }); } });
  const project = g.project;
  assert.equal((await loose.begin({ project, agent: 'claude', operationId: 'x' })).status, 'admitted');
  const bad = await loose.save({ project, agent: 'claude', operationId: 'x', canonical: '{}', document: {} });
  assert.equal(bad.status, 'error');
  assert.equal(bad.reason, 'protocol');
  const badProject = new MemyHandoffCliProvider({ command: async argv => response(argv[2], { operation_id: argv[argv.indexOf('--operation-id') + 1], project_id: 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz', write_generation: 0 }) });
  assert.equal((await badProject.begin({ project, agent: 'claude', operationId: 'y' })).reason, 'protocol');
});

test('gate regressions: memory operations re-check the current agent scope and stay bound to the session binding they started with', async t => {
  for (const agent of ['claude', 'codex']) {
    const { memory, principal, principals, sessions, project, provider } = await setup(t, { provider: new ScriptedProvider({ save: { status: 'pending', reason: 'offline' } }) });
    await sessions.create(sessionRecord(project, principal, { agent: { kind: agent, pid: 1, startedAt: 'x', comm: agent }, bindingId: 'original' }));
    const input = { sessionId: 'ses-1', operationId: `scope-${agent}` };
    assert.equal((await memory.begin(principal, input)).status, 'admitted');
    assert.equal((await memory.checkpoint(principal, { ...input, ...body() })).status, 'pending');
    await principals.update(principal.id, { agents: [agent === 'claude' ? 'codex' : 'claude'] });
    const before = provider.calls.length;
    provider.script.save = null;
    await assert.rejects(memory.recall(principal, { sessionId: 'ses-1', question: 'what was decided?' }), e => e.code === 'agent_not_allowed');
    await assert.rejects(memory.begin(principal, input), e => e.code === 'agent_not_allowed');
    await assert.rejects(memory.checkpoint(principal, input), e => e.code === 'agent_not_allowed');
    assert.equal(provider.calls.length, before, 'nothing reaches the provider after the agent scope changed');
  }
  // A session unbound and bound again under the same id is a new binding: the old operation cannot continue on it.
  const { memory, principal, sessions, project, provider } = await setup(t, { provider: new ScriptedProvider({ save: { status: 'pending', reason: 'offline' } }) });
  await sessions.create(sessionRecord(project, principal, { bindingId: 'original' }));
  const input = { sessionId: 'ses-1', operationId: 'binding-op' };
  await memory.begin(principal, input);
  assert.equal((await memory.checkpoint(principal, { ...input, ...body() })).status, 'pending');
  await sessions.remove('ses-1');
  await sessions.create(sessionRecord(project, principal, { bindingId: 'replacement', paneId: '%99' }));
  const before = provider.calls.length;
  provider.script.save = null;
  await assert.rejects(memory.begin(principal, input), e => e.code === 'operation_conflict');
  await assert.rejects(memory.checkpoint(principal, input), e => e.code === 'operation_conflict');
  assert.equal(provider.calls.length, before);
  assert.equal((await memory.begin(principal, { sessionId: 'ses-1', operationId: 'binding-op-2' })).status, 'admitted', 'a new operation works for the new binding');
});

test('memory authority is fixed at begin: the orchestrator carrier needs the host flag and an event-based attestation, never a borrowed agent grant', async t => {
  const { memory, principal, access, project, stateRoot, principals, orchestrator, provider } = await setup(t);
  const coop = new CoopService({ root: stateRoot, principals, jobs: access.jobs, orchestrator });
  await coop.store.init();
  const submitted = await access.submit(principal, job(project));
  const otherJob = await access.submit(principal, job(project, { idempotencyKey: 'req-2' }));
  // Without the host flag the orchestrator carrier is explicitly unavailable; the provider is not asked and no agent grant stands in.
  const off = await memory.begin(principal, { jobId: submitted.job.id, operationId: 'oc', authority: 'orchestrator' });
  assert.equal(off.status, 'unconfigured');
  assert.equal(off.reason, 'orchestrator_carrier_unavailable');
  assert.equal(provider.calls.filter(c => c.tool === 'begin').length, 0);
  await assert.rejects(memory.begin(principal, { jobId: submitted.job.id, operationId: 'oc', authority: 'owner' }), e => e.code === 'invalid_memory_request');
  // With the flag, begin is carried by the orchestrator grant and the authority is frozen.
  const enabled = new MemoryService({ root: stateRoot, provider, principals, jobs: access.jobs, orchestrator, coop, orchestratorCarrier: true, timeoutMs: 600 });
  const begun = await enabled.begin(principal, { jobId: submitted.job.id, operationId: 'oc', authority: 'orchestrator' });
  assert.equal(begun.status, 'admitted');
  assert.equal(begun.authority, 'orchestrator');
  assert.equal(provider.calls.at(-1).input.agent, 'orchestrator');
  await assert.rejects(enabled.begin(principal, { jobId: submitted.job.id, operationId: 'oc', authority: 'agent' }), e => e.code === 'operation_conflict', 'an admitted operation never switches authority');
  await assert.rejects(enabled.checkpoint(principal, { jobId: submitted.job.id, operationId: 'oc', ...body() }), e => e.code === 'attestation_required');
  await assert.rejects(enabled.checkpoint(principal, { jobId: submitted.job.id, operationId: 'oc', ...body(), attestationEventId: '00000000-0000-4000-8000-000000000000' }), e => e.code === 'attestation_invalid');
  const foreign = await coop.report(principal, { idempotencyKey: 'other-task', type: 'work.reported', task: { ref: `harnessorbit:job/${otherJob.job.id}` }, payload: {} });
  await assert.rejects(enabled.checkpoint(principal, { jobId: submitted.job.id, operationId: 'oc', ...body(), attestationEventId: foreign.event.eventId }), e => e.code === 'attestation_invalid', 'an event about another task is no attestation for this one');
  const mine = await coop.report(principal, { idempotencyKey: 'mine', type: 'work.reported', task: { ref: `harnessorbit:job/${submitted.job.id}` }, payload: { summary: 'done' } });
  const saved = await enabled.checkpoint(principal, { jobId: submitted.job.id, operationId: 'oc', ...body(), attestationEventId: mine.event.eventId });
  assert.equal(saved.status, 'saved');
  const sent = provider.calls.filter(c => c.tool === 'save').at(-1).input;
  assert.equal(sent.agent, 'orchestrator', 'the CLI carrier is the orchestrator grant');
  assert.equal(sent.document.session.agent, 'claude_code', 'the work source stays the real actor');
  assert.equal(sent.document.attested_by, undefined, 'no attestation fields at the top level');
  assert.equal(sent.document.session.attested_by, `principal:grok@${principal.incarnation}`);
  assert.equal(sent.document.session.attestation_ref, `harnessorbit:event/${mine.event.eventId}`);
  assert.equal(sent.document.participants[0].kind, 'grok');
  // Recall can use the orchestrator carrier only through the same host flag, never a borrowed grant.
  assert.equal((await memory.recall(principal, { jobId: submitted.job.id, question: 'what was decided?', authority: 'orchestrator' })).reason, 'orchestrator_carrier_unavailable');
  const recalled = await enabled.recall(principal, { jobId: submitted.job.id, question: 'what was decided?', authority: 'orchestrator' });
  assert.equal(recalled.status, 'ok'); assert.equal(recalled.authority, 'orchestrator');
  assert.equal(provider.calls.filter(c => c.tool === 'recall').at(-1).input.agent, 'orchestrator');
  assert.equal((await enabled.recall(principal, { jobId: submitted.job.id, question: 'what was decided?' })).authority, 'agent');
  // Turning the host flag off afterwards does not rewrite the admission: a retry still goes through the orchestrator carrier, never the agent grant.
  const later = new MemoryService({ root: stateRoot, provider, principals, jobs: access.jobs, orchestrator, coop, orchestratorCarrier: false, timeoutMs: 600 });
  const replay = await later.checkpoint(principal, { jobId: submitted.job.id, operationId: 'oc' });
  assert.equal(replay.status, 'deduplicated');
  assert.equal(provider.calls.filter(c => c.tool === 'save').at(-1).input.agent, 'orchestrator');
  // An agent-carried operation stays agent-carried and needs no attestation.
  assert.equal((await enabled.begin(principal, { jobId: submitted.job.id, operationId: 'ag' })).authority, 'agent');
  assert.equal((await enabled.checkpoint(principal, { jobId: submitted.job.id, operationId: 'ag', ...body() })).status, 'saved');
  assert.equal(provider.calls.filter(c => c.tool === 'save').at(-1).input.agent, 'claude');
  assert.equal(provider.calls.filter(c => c.tool === 'save').at(-1).input.document.session.attested_by, undefined);
});

test('the fake memy CLI exposes the orchestrator carrier only when the host enabled it', async t => {
  const f = await fixture(); t.after(f.remove);
  const project = await fs.realpath(f.project);
  const env = { ...process.env, FAKE_MEMY_LOG: path.join(f.base, 'memy.log'), FAKE_MEMY_STATE: path.join(f.base, 'memy-state.json') };
  const cli = extra => new MemyHandoffCliProvider({ argv: [process.execPath, FAKE_MEMY], timeoutMs: 1500, command: (argv, opts) => import('../src/process.mjs').then(m => m.runCommand(argv, { ...opts, env: { ...env, ...extra } })) });
  assert.equal((await cli({}).begin({ project, agent: 'orchestrator', operationId: 'o' })).reason, 'agent_unsupported');
  assert.equal((await cli({ FAKE_MEMY_ORCHESTRATOR: '1' }).begin({ project, agent: 'orchestrator', operationId: 'o' })).status, 'admitted');
  const log = (await fs.readFile(env.FAKE_MEMY_LOG, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.ok(log.every(l => l.flags.agent === 'orchestrator'));
});

test('an attestation event must match the exact target instance frozen in the admission: not an earlier session binding, not an earlier job attempt', async t => {
  const { principal, access, project, stateRoot, principals, provider } = await setup(t);
  let revision = 1;
  const fakeOrchestrator = { inspect: async () => ({ attempt: { id: `a${revision}`, number: revision, status: 'running' } }) };
  const sessions = new SessionStore({ root: stateRoot });
  const coop = new CoopService({ root: stateRoot, principals, jobs: access.jobs, sessions, orchestrator: fakeOrchestrator });
  await coop.store.init();
  const memory = new MemoryService({ root: stateRoot, provider, principals, jobs: access.jobs, sessions, orchestrator: fakeOrchestrator, coop, orchestratorCarrier: true, timeoutMs: 600 });
  // Session: event under binding b-1, then the same session id re-bound as b-2.
  await sessions.create(sessionRecord(project, principal, { bindingId: 'b-1' }));
  const old = await coop.report(principal, { idempotencyKey: 'old-binding', type: 'handoff.offered', task: { ref: 'harnessorbit:session/ses-1' }, payload: {} });
  assert.equal(old.event.source.binding, 'b-1');
  await sessions.remove('ses-1'); await sessions.create(sessionRecord(project, principal, { bindingId: 'b-2', paneId: '%10' }));
  assert.equal((await memory.begin(principal, { sessionId: 'ses-1', operationId: 'new-binding', authority: 'orchestrator' })).status, 'admitted');
  await assert.rejects(memory.checkpoint(principal, { sessionId: 'ses-1', operationId: 'new-binding', ...body(), attestationEventId: old.event.eventId }), e => e.code === 'attestation_invalid');
  assert.equal(provider.calls.filter(c => c.tool === 'save').length, 0);
  const fresh = await coop.report(principal, { idempotencyKey: 'new-binding-event', type: 'handoff.offered', task: { ref: 'harnessorbit:session/ses-1' }, payload: {} });
  assert.equal((await memory.checkpoint(principal, { sessionId: 'ses-1', operationId: 'new-binding', ...body(), attestationEventId: fresh.event.eventId })).status, 'saved');
  // Job: event at attempt 1, then the job moves to attempt 2.
  const submitted = await access.submit(principal, job(project));
  const first = await coop.report(principal, { idempotencyKey: 'rev1', type: 'work.reported', task: { ref: `harnessorbit:job/${submitted.job.id}` }, payload: {} });
  assert.equal(first.event.task.intentRevision, 1);
  revision = 2;
  assert.equal((await memory.begin(principal, { jobId: submitted.job.id, operationId: 'new-intent', authority: 'orchestrator' })).status, 'admitted');
  await assert.rejects(memory.checkpoint(principal, { jobId: submitted.job.id, operationId: 'new-intent', ...body(), attestationEventId: first.event.eventId }), e => e.code === 'attestation_invalid');
  const current = await coop.report(principal, { idempotencyKey: 'rev2', type: 'work.reported', task: { ref: `harnessorbit:job/${submitted.job.id}` }, payload: {} });
  assert.equal(current.event.task.intentRevision, 2);
  assert.equal((await memory.checkpoint(principal, { jobId: submitted.job.id, operationId: 'new-intent', ...body(), attestationEventId: current.event.eventId })).status, 'saved');
  // The job moving on after admission makes the operation itself stale.
  await memory.begin(principal, { jobId: submitted.job.id, operationId: 'stale-op' });
  revision = 3;
  await assert.rejects(memory.checkpoint(principal, { jobId: submitted.job.id, operationId: 'stale-op', ...body() }), e => e.code === 'operation_conflict');
});

test('the fake memy CLI applies the strict checkpoint shape: top-level attestation or a carrier actor is invalid, attestation inside session under the orchestrator carrier is accepted', async t => {
  const f = await fixture(); t.after(f.remove);
  const project = await fs.realpath(f.project);
  const env = { ...process.env, FAKE_MEMY_LOG: path.join(f.base, 'memy.log'), FAKE_MEMY_STATE: path.join(f.base, 'memy-state.json'), FAKE_MEMY_ORCHESTRATOR: '1' };
  const cli = new MemyHandoffCliProvider({ argv: [process.execPath, FAKE_MEMY], timeoutMs: 1500, command: (argv, opts) => import('../src/process.mjs').then(m => m.runCommand(argv, { ...opts, env })) });
  const base = { schema: 'memy.handoff.checkpoint.v1', observed_at: '2026-10-21T10:00:00.000Z', summary: 's', goals: [], decisions: [], constraints: [], open_questions: [], task: { id: 't' }, participants: [], orchestrator: { name: 'harnessorbit', version: '0.4.0' }, evidence: [] };
  const save = async (operationId, document) => cli.save({ project, agent: 'orchestrator', operationId, canonical: JSON.stringify(document), document });
  assert.equal((await cli.begin({ project, agent: 'orchestrator', operationId: 'x' })).status, 'admitted');
  assert.equal((await save('x', { ...base, session: { id: 's', agent: 'claude_code' }, attested_by: 'principal:grok@1', attestation_ref: 'harnessorbit:event/e' })).reason, 'invalid_checkpoint', 'top-level attestation fields are unknown fields');
  assert.equal((await save('x', { ...base, session: { id: 's', agent: 'orchestrator', attested_by: 'principal:grok@1', attestation_ref: 'harnessorbit:event/e' } })).reason, 'invalid_checkpoint', 'the carrier is not an actor');
  assert.equal((await save('x', { ...base, session: { id: 's', agent: 'claude_code' } })).reason, 'invalid_checkpoint', 'an orchestrator-carried save needs its attestation');
  assert.equal((await save('x', { ...base, session: { id: 's', agent: 'claude_code', attested_by: 'principal:grok@1', attestation_ref: 'harnessorbit:event/e' } })).status, 'saved');
});
