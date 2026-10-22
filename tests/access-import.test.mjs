import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Orchestrator } from '../src/orchestrator.mjs';
import { PrincipalStore } from '../src/access/principals.mjs';
import { AccessService, ACCESS_TOOLS } from '../src/access/service.mjs';
import { SessionStore } from '../src/access/sessions.mjs';
import { CoopService, CoopStore, HISTORICAL_TYPES, IMPORT_CAPS } from '../src/access/coop.mjs';
import { MemoryService, NullMemoryProvider } from '../src/access/memory.mjs';
import { startAccessServer } from '../src/access/server.mjs';
import { runPath } from '../src/state.mjs';
import { parseArgs } from '../bin/cao.mjs';
import { fixture, FakeHerdr } from './helpers.mjs';

// Fixture-level evidence for the host-only importer (phase 2B): a job submitted through the inline
// driver, a synthetic run event log written by the test, a store initialised by the test. No real
// agent, no old job, no pilot root.

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const EMPTY_SHA = sha('');
const checks = [{ name: 'math', argv: [process.execPath, '--test', 'tests/math.test.mjs'], timeoutMs: 10000 }];
const job = (project, extra = {}) => ({ idempotencyKey: 'req-1', project, objective: 'Fix add to add its two inputs; preserve the existing tests.', context: 'Tests already encode the expected behaviour.', allowedPaths: ['src/math.mjs'], checks, ...extra });

async function setup(t) {
  const f = await fixture(); t.after(f.remove);
  f.project = await fs.realpath(f.project);
  const orchestrator = new Orchestrator({ stateRoot: f.stateRoot, herdr: new FakeHerdr() });
  const principals = new PrincipalStore({ root: f.stateRoot });
  const grok = (await principals.create({ id: 'grok', projects: [f.project], agents: ['claude', 'codex'], permissions: { sessions: true }, kind: 'grok' })).principal;
  const codex = (await principals.create({ id: 'codex', projects: [f.project], agents: ['claude', 'codex'], kind: 'codex' })).principal;
  const access = new AccessService({ root: f.stateRoot, orchestrator, principals, driver: 'inline' });
  const sessions = new SessionStore({ root: f.stateRoot });
  const coop = new CoopService({ root: f.stateRoot, principals, jobs: access.jobs, sessions, orchestrator });
  await coop.store.init();
  const submitted = (await access.submit(grok, job(f.project))).job;
  const record = await access.jobs.get(submitted.id);
  const events = path.join(runPath(f.stateRoot, record.runId), 'events.jsonl');
  await fs.mkdir(path.dirname(events), { recursive: true });
  const row = (eventId, extra = {}) => `${JSON.stringify({ schemaVersion: 1, runId: record.runId, eventId, type: 'attempt.state', timestamp: '2026-10-20T00:00:01.000Z', taskId: record.taskId, attemptId: 'att-1', from: 'running', to: 'submitted', sequence: 1, ...extra })}\n`;
  const dir = path.join(f.stateRoot, 'access', 'coop');
  const files = { journal: path.join(dir, 'journal.jsonl'), receipts: path.join(dir, 'receipts.jsonl'), recipients: path.join(dir, 'recipients.json'), intent: path.join(dir, 'recipients.intent.json'), store: path.join(dir, 'store.json'), events, job: path.join(f.stateRoot, 'access', 'jobs', `${record.id}.json`) };
  const snapshot = async () => { const out = {}; for (const [k, p] of Object.entries(files)) out[k] = await fs.readFile(p).then(b => b.toString('hex'), e => e.code); return out; };
  const receipts = async () => (await new CoopStore({ root: f.stateRoot }).load()).receipts.filter(r => r.kind.startsWith('import.'));
  const journal = async () => (await new CoopStore({ root: f.stateRoot }).load()).records;
  return { ...f, orchestrator, principals, grok, codex, access, sessions, coop, jobId: record.id, record, events, row, files, snapshot, receipts, journal };
}

test('A/B with limit 1 advances once per run and the third run writes nothing: bounded progress with a durable checkpoint', async t => {
  const { coop, jobId, events, row, receipts, journal } = await setup(t);
  await fs.writeFile(events, row('e-A') + row('e-B', { to: 'accepted', sequence: 2 }));
  const first = await coop.importRunEvents({ jobId, limit: 1 });
  assert.equal(first.ok, true); assert.equal(first.mode, 'fresh'); assert.equal(first.committed, 1); assert.equal(first.more, true);
  assert.deepEqual(first.wrote, ['import.prepare', 'import.checkpoint']);
  assert.equal(first.rows[0].sourceEventId, 'e-A'); assert.equal(first.rows[0].outcome, 'new');
  const second = await coop.importRunEvents({ jobId, limit: 1 });
  assert.equal(second.committed, 1); assert.equal(second.rows[0].sourceEventId, 'e-B'); assert.equal(second.prior.rows, 1); assert.equal(second.more, false); assert.equal(second.complete, true);
  const third = await coop.importRunEvents({ jobId, limit: 1 });
  assert.equal(third.consumed, 0); assert.equal(third.committed, 0); assert.deepEqual(third.wrote, []); assert.equal(third.bound, true);
  const recs = await receipts();
  assert.deepEqual(recs.map(r => r.kind), ['import.prepare', 'import.checkpoint', 'import.prepare', 'import.checkpoint'], 'two batches, two plans, no record for the empty third run');
  assert.equal(recs[1].planId, recs[0].planId); assert.equal(recs[3].planId, recs[2].planId); assert.notEqual(recs[0].planId, recs[2].planId);
  assert.equal(recs[2].prior.planId, recs[0].planId); assert.equal(recs[2].prior.bytes, recs[1].checkpoint.bytes); assert.equal(recs[2].prior.sha, recs[1].checkpoint.sha);
  assert.equal(recs[3].checkpoint.bytes, (await fs.stat(events)).size);
  assert.equal(recs[3].checkpoint.sha, sha(await fs.readFile(events)));
  const imported = (await journal()).filter(r => r.event.type === 'history.imported');
  assert.equal(imported.length, 2);
  assert.deepEqual(imported.map(r => r.event.legacyRef.eventId), ['e-A', 'e-B']);
  assert.equal((await coop.importRunEvents({ jobId, limit: 1 })).consumed, 0, 'EOF repeated: still nothing written');
  assert.equal((await receipts()).length, 4);
});

test('same batch A/A reuses one UUID and A/A-prime conflicts at row 2; the dry run predicts both with its overlay and writes nothing', async t => {
  const { coop, jobId, events, row, receipts, journal, snapshot } = await setup(t);
  await fs.writeFile(events, row('e-A') + row('e-A'));
  const dry = await coop.importRunEvents({ jobId, dryRun: true });
  assert.equal(dry.mode, 'dry_run'); assert.deepEqual(dry.rows.map(r => [r.outcome, r.planned ?? null]), [['new', null], ['reused', true]]); assert.equal(dry.wouldCommit, 1);
  const real = await coop.importRunEvents({ jobId });
  assert.equal(real.committed, 1); assert.equal(real.reused, 1);
  assert.equal(real.rows[1].committedEventId, real.rows[0].committedEventId, 'the second identical row reuses the UUID committed moments before in the same lock');
  assert.equal((await journal()).filter(r => r.event.type === 'history.imported').length, 1);
  // A/A′: identical identity, changed body (sequence) later in the file.
  await fs.appendFile(events, row('e-A', { sequence: 2 }));
  const before = await snapshot();
  const dry2 = await coop.importRunEvents({ jobId, dryRun: true });
  assert.equal(dry2.gap.reason, 'conflict'); assert.equal(dry2.gap.row, 3); assert.equal(dry2.consumed, 0);
  assert.deepEqual(await snapshot(), before, 'dry run: every domain file byte-identical');
  const conflict = await coop.importRunEvents({ jobId });
  assert.equal(conflict.ok, true); assert.equal(conflict.consumed, 0); assert.equal(conflict.gap.reason, 'conflict'); assert.deepEqual(conflict.wrote, []);
  assert.equal((await journal()).filter(r => r.event.type === 'history.imported').length, 1, 'no second UUID for the changed body');
  assert.equal((await receipts()).at(-1).checkpoint.rows, 2, 'progress stays before the conflicting row');
  assert.equal((await coop.importRunEvents({ jobId })).gap.reason, 'conflict', 'the same gap repeated writes nothing more');
  assert.equal((await receipts()).length, 2);
});

test('source identity: job remap, another job claiming the run, and a foreign-run row are refused with nothing written', async t => {
  const { coop, access, grok, project, jobId, record, events, row, receipts, journal } = await setup(t);
  await fs.writeFile(events, row('e-A'));
  assert.equal((await coop.importRunEvents({ jobId })).committed, 1);
  const other = (await access.submit(grok, job(project, { idempotencyKey: 'req-2' }))).job;
  const otherRecord = await access.jobs.get(other.id);
  const otherEvents = path.join(runPath(coop.root, otherRecord.runId), 'events.jsonl');
  await fs.writeFile(otherEvents, `${JSON.stringify({ schemaVersion: 1, runId: otherRecord.runId, eventId: 'e-X', type: 'attempt.state', timestamp: 't', taskId: otherRecord.taskId, attemptId: 'a', from: 'running', to: 'submitted' })}\n`);
  const journalBefore = (await journal()).length; const receiptsBefore = (await receipts()).length;
  // 1. The first job's runId moves to the (legitimate, unbound) second run.
  await access.jobs.update(jobId, j => { j.runId = otherRecord.runId; });
  const remapped = await coop.importRunEvents({ jobId });
  assert.equal(remapped.ok, false); assert.equal(remapped.status, 'source_remapped'); assert.equal(remapped.frozen.runId, record.runId);
  await access.jobs.update(jobId, j => { j.runId = record.runId; });
  // 2. Another job pointing at the bound run.
  await access.jobs.update(other.id, j => { j.runId = record.runId; });
  const claimed = await coop.importRunEvents({ jobId: other.id });
  assert.equal(claimed.ok, false); assert.equal(claimed.status, 'source_claimed'); assert.equal(claimed.boundJob, jobId);
  await access.jobs.update(other.id, j => { j.runId = otherRecord.runId; });
  // 3. A row from another run inside this run's file is a gap, not a fact of this run.
  await fs.appendFile(events, row('e-F', { runId: otherRecord.runId }));
  const foreign = await coop.importRunEvents({ jobId });
  assert.equal(foreign.gap.reason, 'foreign_run'); assert.equal(foreign.consumed, 0);
  assert.equal((await journal()).length, journalBefore); assert.equal((await receipts()).length, receiptsBefore);
});

test('first-event crash before the checkpoint: resume reuses the committed UUID under the frozen source constraint; a replaced or remapped source is refused and keeps plan and events', async t => {
  const { coop, access, jobId, record, events, row, receipts, journal, stateRoot, project } = await setup(t);
  await fs.writeFile(events, row('e-A') + row('e-B', { sequence: 2 }));
  const die = new Error('simulated kill'); die.code = 'simulated_kill';
  await assert.rejects(coop.importRunEvents({ jobId, hooks: { afterEventCommit: async n => { if (n === 1) throw die; } } }), e => e.code === 'simulated_kill');
  let recs = await receipts();
  assert.deepEqual(recs.map(r => r.kind), ['import.prepare'], 'prepare committed, no checkpoint');
  const committedA = (await journal()).filter(r => r.event.type === 'history.imported');
  assert.equal(committedA.length, 1);
  // Changed source after the crash: refused, E1 kept, no new id, plan preserved.
  const original = await fs.readFile(events);
  await fs.writeFile(events, row('e-A2') + row('e-B2', { sequence: 2 }));
  const replaced = await coop.importRunEvents({ jobId });
  assert.equal(replaced.ok, false); assert.equal(replaced.status, 'source_replaced'); assert.equal(replaced.mode, 'resume'); assert.equal(replaced.planPending, recs[0].planId);
  assert.equal((await journal()).filter(r => r.event.type === 'history.imported').length, 1);
  assert.deepEqual((await receipts()).map(r => r.kind), ['import.prepare']);
  // Remapped job while the plan is pending: refused, plan preserved.
  const other = (await access.submit(coop.principals && (await coop.principals.get('grok')), job(project, { idempotencyKey: 'req-3' }))).job;
  await fs.writeFile(events, original);
  const otherRunId = (await access.jobs.get(other.id)).runId;
  await access.jobs.update(jobId, j => { j.runId = otherRunId; });
  assert.equal((await coop.importRunEvents({ jobId })).status, 'source_remapped');
  await access.jobs.update(jobId, j => { j.runId = record.runId; });
  // Unchanged source: resume settles the same plan; E1 reused, E2 imported, checkpoint tied to the plan.
  const dry = await coop.importRunEvents({ jobId, dryRun: true });
  assert.equal(dry.status, 'plan_pending'); assert.equal(dry.sourceVerified, true); assert.equal(dry.wouldReuse, 1); assert.equal(dry.wouldCommit, 1);
  const resumed = await coop.importRunEvents({ jobId });
  assert.equal(resumed.mode, 'resume'); assert.equal(resumed.reused, 1); assert.equal(resumed.committed, 1); assert.equal(resumed.planId, recs[0].planId);
  assert.equal(resumed.rows[0].committedEventId, committedA[0].event.eventId);
  recs = await receipts();
  assert.deepEqual(recs.map(r => r.kind), ['import.prepare', 'import.checkpoint']); assert.equal(recs[1].planId, recs[0].planId);
  assert.equal(recs[1].checkpoint.sha, recs[0].range.sha);
  // Control: the same window after an existing checkpoint.
  await fs.appendFile(events, row('e-C', { sequence: 3 }) + row('e-D', { sequence: 4 }));
  await assert.rejects(coop.importRunEvents({ jobId, hooks: { afterEventCommit: async n => { if (n === 1) throw die; } } }), e => e.code === 'simulated_kill');
  assert.equal((await receipts()).at(-1).kind, 'import.prepare');
  const settled = await coop.importRunEvents({ jobId });
  assert.equal(settled.mode, 'resume'); assert.equal(settled.reused, 1); assert.equal(settled.committed, 1);
  assert.deepEqual((await journal()).filter(r => r.event.type === 'history.imported').map(r => r.event.legacyRef.eventId), ['e-A', 'e-B', 'e-C', 'e-D']);
  // Real child killed with SIGKILL right after its first imported event commit; the parent resumes.
  const childRoot = path.join(stateRoot, '..', 'child-state');
  const script = `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { Orchestrator } from ${JSON.stringify(path.resolve('src/orchestrator.mjs'))};
    import { PrincipalStore } from ${JSON.stringify(path.resolve('src/access/principals.mjs'))};
    import { AccessService } from ${JSON.stringify(path.resolve('src/access/service.mjs'))};
    import { CoopService } from ${JSON.stringify(path.resolve('src/access/coop.mjs'))};
    import { runPath } from ${JSON.stringify(path.resolve('src/state.mjs'))};
    import { FakeHerdr } from ${JSON.stringify(path.resolve('tests/helpers.mjs'))};
    const root = ${JSON.stringify(childRoot)};
    const orchestrator = new Orchestrator({ stateRoot: root, herdr: new FakeHerdr() });
    const principals = new PrincipalStore({ root });
    const grok = (await principals.create({ id: 'grok', projects: [${JSON.stringify(project)}], agents: ['claude', 'codex'], kind: 'grok' })).principal;
    const access = new AccessService({ root, orchestrator, principals, driver: 'inline' });
    const coop = new CoopService({ root, principals, jobs: access.jobs, orchestrator });
    await coop.store.init();
    const submitted = (await access.submit(grok, ${JSON.stringify(job(project))})).job;
    const rec = await access.jobs.get(submitted.id);
    const row = (id, seq) => JSON.stringify({ schemaVersion: 1, runId: rec.runId, eventId: id, type: 'attempt.state', timestamp: 't', taskId: rec.taskId, attemptId: 'a', from: 'running', to: 'submitted', sequence: seq }) + String.fromCharCode(10);
    await fs.writeFile(path.join(runPath(root, rec.runId), 'events.jsonl'), row('c-1', 1) + row('c-2', 2));
    process.stdout.write('JOB ' + submitted.id + String.fromCharCode(10));
    await coop.importRunEvents({ jobId: submitted.id, hooks: { afterEventCommit: async () => { process.stdout.write('COMMITTED' + String.fromCharCode(10)); process.kill(process.pid, 'SIGKILL'); } } });
  `;
  const child = await new Promise(resolve => { const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; }); p.on('exit', (code, signal) => resolve({ code, signal, out, err })); });
  assert.equal(child.signal, 'SIGKILL', `child did not die by SIGKILL: ${child.err}`);
  assert.match(child.out, /COMMITTED/);
  const childJob = /JOB (\S+)/.exec(child.out)[1];
  const childPrincipals = new PrincipalStore({ root: childRoot });
  const childAccess = new AccessService({ root: childRoot, orchestrator: new Orchestrator({ stateRoot: childRoot, herdr: new FakeHerdr() }), principals: childPrincipals, driver: 'inline' });
  const childCoop = new CoopService({ root: childRoot, principals: childPrincipals, jobs: childAccess.jobs });
  const after = await childCoop.importRunEvents({ jobId: childJob });   // recovers the dead lock, resumes
  assert.equal(after.mode, 'resume'); assert.equal(after.reused, 1); assert.equal(after.committed, 1);
  const childRecs = (await new CoopStore({ root: childRoot }).load()).receipts.filter(r => r.kind.startsWith('import.'));
  assert.deepEqual(childRecs.map(r => r.kind), ['import.prepare', 'import.checkpoint']);
  assert.equal((await new CoopStore({ root: childRoot }).load()).records.filter(r => r.event.type === 'history.imported').length, 2);
});

test('verified prefix: shortening and same-length replacement are refused; a replacement after capture still yields a checkpoint of the captured bytes; a concurrent append is the next batch', async t => {
  const { coop, jobId, events, row, receipts, journal } = await setup(t);
  const a = row('e-A'); const b = row('e-B', { sequence: 2 });
  await fs.writeFile(events, a + b);
  assert.equal((await coop.importRunEvents({ jobId })).committed, 2);
  const cp = (await receipts()).at(-1).checkpoint;
  assert.equal(cp.bytes, Buffer.byteLength(a + b)); assert.equal(cp.sha, sha(a + b));
  await fs.writeFile(events, a);
  const short = await coop.importRunEvents({ jobId });
  assert.equal(short.ok, false); assert.equal(short.status, 'source_shortened');
  const replacement = (a + b).replace('"to":"submitted"', '"to":"xubmitted"');
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(a + b));
  await fs.writeFile(events, replacement);
  const rep = await coop.importRunEvents({ jobId });
  assert.equal(rep.ok, false); assert.equal(rep.status, 'source_replaced');
  assert.equal((await receipts()).length, 2); assert.equal((await journal()).filter(r => r.event.type === 'history.imported').length, 2);
  await fs.writeFile(events, a + b);
  // Replacement injected after the image was captured: the checkpoint names the captured image, and
  // the next run reports the replacement rather than endorsing it.
  const c = row('e-C', { sequence: 3 });
  await fs.writeFile(events, a + b + c);
  const captured = await coop.importRunEvents({ jobId, hooks: { afterCapture: async () => fs.writeFile(events, a + b + c.replace('"sequence":3', '"sequence":9')) } });
  assert.equal(captured.committed, 1);
  assert.equal((await receipts()).at(-1).checkpoint.sha, sha(a + b + c), 'the checkpoint hashes the bytes the event came from');
  assert.equal((await coop.importRunEvents({ jobId })).status, 'source_replaced');
  await fs.writeFile(events, a + b + c);
  // Normal append-only concurrency: bytes after the captured end are simply the next batch.
  const d = row('e-D', { sequence: 4 });
  const next = await coop.importRunEvents({ jobId, hooks: { afterCapture: async () => fs.appendFile(events, d) } });
  assert.equal(next.consumed, 0);
  assert.equal((await coop.importRunEvents({ jobId })).committed, 1);
  assert.deepEqual((await journal()).filter(r => r.event.type === 'history.imported').map(r => r.event.legacyRef.eventId), ['e-A', 'e-B', 'e-C', 'e-D']);
});

test('zero-range cases: a first gap binds custody without a verified prefix and recovers after a crash between its prepare and checkpoint; EOF and unsupported-only batches behave as specified', async t => {
  const { coop, jobId, record, events, row, receipts, journal, access } = await setup(t);
  await fs.writeFile(events, 'not json\n' + row('e-A'));
  const first = await coop.importRunEvents({ jobId });
  assert.equal(first.consumed, 0); assert.equal(first.gap.reason, 'malformed_row'); assert.deepEqual(first.wrote, ['import.prepare', 'import.checkpoint']); assert.equal(first.bound, true);
  let recs = await receipts();
  assert.equal(recs[0].range.toByte, 0); assert.equal(recs[0].range.sha, EMPTY_SHA); assert.equal(recs[1].checkpoint.bytes, 0); assert.equal(recs[1].checkpoint.sha, EMPTY_SHA);
  assert.equal((await coop.importRunEvents({ jobId })).consumed, 0);
  assert.equal((await receipts()).length, 2, 'the same first gap repeated appends nothing');
  // Bound with zero progress: a remap is now refused.
  const other = (await access.submit(await coop.principals.get('grok'), job(coop.root.replace(/.*/, record.project), { idempotencyKey: 'req-4' }))).job;
  await access.jobs.update(jobId, j => { j.runId = other.id; });
  assert.equal((await coop.importRunEvents({ jobId })).status, 'source_remapped');
  await access.jobs.update(jobId, j => { j.runId = record.runId; });
  // Restoring the row imports it from byte 0.
  await fs.writeFile(events, row('e-A'));
  const restored = await coop.importRunEvents({ jobId });
  assert.equal(restored.committed, 1); assert.equal(restored.prior.bytes, 0);
  // Crash between a zero-range prepare and its checkpoint (persisted as null sha, as an earlier record might be): resume completes.
  const t2 = await setup(t);
  await fs.writeFile(t2.events, 'garbage\n');
  const binding = await t2.coop.importRunEvents({ jobId: t2.jobId });
  assert.deepEqual(binding.wrote, ['import.prepare', 'import.checkpoint']);
  // Rewrite the receipts to the crash shape: prepare only, with range.sha null, then let open() verify the chain by re-appending through the store.
  const store = new CoopStore({ root: t2.stateRoot });
  await store.lock(async () => {
    const state = await store.open();
    const prepare = state.receipts.find(r => r.kind === 'import.prepare');
    const nullPrepare = { ...prepare, planId: crypto.randomUUID(), range: { ...prepare.range, sha: null }, prior: { ...prepare.prior, sha: null } };
    delete nullPrepare.prev; delete nullPrepare.sha;
    await store.appendReceipt(state, nullPrepare);
  });
  // The index now sees an unresolved zero-range plan with null hashes (two plans for the source is invalid, so remove the first pair's effect by using a fresh source: a new job).
  const fresh = await setup(t);
  await fs.writeFile(fresh.events, 'garbage\n');
  await fresh.coop.store.lock(async () => {
    const state = await fresh.coop.store.open();
    const custody = await fresh.coop._custody(fresh.jobId);
    await fresh.coop.store.appendReceipt(state, { v: 1, kind: 'import.prepare', planId: crypto.randomUUID(), at: 'x', lineage: 'harnessorbit.run-events.v1', sourceId: `harnessorbit:run/${custody.tuple.runId}`, job: custody.tuple, prior: { planId: null, rows: 0, bytes: 0, sha: null }, range: { fromByte: 0, toByte: 0, lines: 0, sha: null }, limit: 50, gapAt: { row: 1, byte: 0, reason: 'malformed_row' } });
  });
  const resumed = await fresh.coop.importRunEvents({ jobId: fresh.jobId });
  assert.equal(resumed.ok, true); assert.equal(resumed.mode, 'resume'); assert.equal(resumed.consumed, 0); assert.deepEqual(resumed.wrote, ['import.checkpoint']);
  const freshRecs = await fresh.receipts();
  assert.deepEqual(freshRecs.map(r => r.kind), ['import.prepare', 'import.checkpoint']); assert.equal(freshRecs[1].checkpoint.sha, EMPTY_SHA);
  await fs.writeFile(fresh.events, fresh.row('e-Z'));
  assert.equal((await fresh.coop.importRunEvents({ jobId: fresh.jobId })).committed, 1, 'the otherwise valid source is not permanently refused');
  // Unsupported-only batch advances with no events; EOF repeated writes nothing.
  const u = await setup(t);
  await fs.writeFile(u.events, u.row('u-1', { type: 'run.created' }) + u.row('u-2', { type: 'performance.observed' }));
  const uns = await u.coop.importRunEvents({ jobId: u.jobId });
  assert.equal(uns.consumed, 2); assert.equal(uns.committed, 0); assert.deepEqual(uns.skipped, { unsupported_type: 2 }); assert.deepEqual(uns.wrote, ['import.prepare', 'import.checkpoint']);
  assert.equal((await u.journal()).filter(r => r.event.type === 'history.imported').length, 0);
  assert.equal((await u.coop.importRunEvents({ jobId: u.jobId })).consumed, 0); assert.equal((await u.receipts()).length, 2);
  void journal; void recs;
});

test('prefix cap: a row ending beyond the verification cap is never prepared; rows within it are, and the next run reports the cap without consuming a partial row', async t => {
  const { coop, jobId, events, row, receipts } = await setup(t);
  const a = row('e-A'); const b = row('e-B', { sequence: 2 });
  await fs.writeFile(events, a + b);
  const caps = { ...IMPORT_CAPS, maxPrefixBytes: Buffer.byteLength(a) + 5 };
  const first = await coop.importRunEvents({ jobId, caps });
  assert.equal(first.committed, 1); assert.equal(first.capReached, true); assert.equal(first.more, true);
  assert.equal((await receipts()).at(-1).checkpoint.bytes, Buffer.byteLength(a));
  const blocked = await coop.importRunEvents({ jobId, caps });
  assert.equal(blocked.ok, false); assert.equal(blocked.status, 'source_prefix_cap'); assert.equal(blocked.cap, caps.maxPrefixBytes);
  assert.equal((await receipts()).length, 2, 'no plan written for a blocked batch');
  assert.equal((await coop.importRunEvents({ jobId, caps, dryRun: true })).status, 'source_prefix_cap');
  // The default caps continue from the same checkpoint and import B.
  assert.equal((await coop.importRunEvents({ jobId })).committed, 1);
  const tooLarge = await coop.importRunEvents({ jobId, caps: { ...IMPORT_CAPS, maxPrefixBytes: 10 } });
  assert.equal(tooLarge.status, 'source_too_large');
});

test('dry run with a pending intent or torn tail reports recovery_pending and preserves every file; custody refusals write nothing and a mid-batch revocation keeps the truthful prefix', async t => {
  const { coop, principals, jobId, events, row, files, snapshot, receipts, journal, base, project } = await setup(t);
  await fs.writeFile(events, row('e-A') + row('e-B', { sequence: 2 }));
  await fs.writeFile(files.intent, JSON.stringify({ schema: 'harnessorbit.coop.intent.v1', bogus: true }));
  const before = await snapshot();
  const pending = await coop.importRunEvents({ jobId, dryRun: true });
  assert.equal(pending.status, 'recovery_pending'); assert.ok(pending.pendingRecovery.recipients);
  assert.deepEqual(await snapshot(), before, 'intent and all other files preserved');
  await fs.unlink(files.intent);
  await fs.appendFile(files.journal, '{"torn');
  const torn = await coop.importRunEvents({ jobId, dryRun: true });
  assert.equal(torn.status, 'recovery_pending'); assert.ok(torn.pendingRecovery.journal);
  assert.ok((await fs.readFile(files.journal, 'utf8')).endsWith('{"torn'), 'the dry run did not repair the tail');
  await coop.store.load(); // Gate A repairs it
  // Custody refusals before any mutation.
  const clean = await snapshot();
  await fs.mkdir(path.join(base, 'elsewhere'));
  await principals.update('grok', { projects: [path.join(base, 'elsewhere')] });
  await assert.rejects(coop.importRunEvents({ jobId }), e => e.code === 'permission_denied');
  await principals.update('grok', { projects: [project], agents: ['codex'] });
  await assert.rejects(coop.importRunEvents({ jobId }), e => e.code === 'permission_denied');
  await principals.update('grok', { agents: ['claude', 'codex'] });
  assert.deepEqual(await snapshot(), clean, 'nothing written by refused imports');
  // Revocation after the first committed row: committed: 1, plan pending; restoring custody resumes with row 1 reused.
  const revoked = await coop.importRunEvents({ jobId, hooks: { afterEventCommit: async n => { if (n === 1) await principals.update('grok', { agents: ['codex'] }); } } });
  assert.equal(revoked.ok, false); assert.equal(revoked.status, 'permission_denied'); assert.equal(revoked.committed, 1); assert.ok(revoked.planPending);
  assert.equal((await journal()).filter(r => r.event.type === 'history.imported').length, 1);
  await principals.update('grok', { agents: ['claude', 'codex'] });
  const resumed = await coop.importRunEvents({ jobId });
  assert.equal(resumed.mode, 'resume'); assert.equal(resumed.reused, 1); assert.equal(resumed.committed, 1); assert.equal(resumed.planId, revoked.planPending);
  // A recreated owner is not the custodian; a legacy job is refused without adoption.
  await principals.remove('grok'); await principals.create({ id: 'grok', projects: [project], agents: ['claude', 'codex'], kind: 'grok' });
  await assert.rejects(coop.importRunEvents({ jobId }), e => e.code === 'permission_denied');
  await coop.jobs.update(jobId, j => { delete j.principalIncarnation; });
  await assert.rejects(coop.importRunEvents({ jobId }), e => e.code === 'legacy_migration_required');
  assert.equal((await receipts()).length, 2);
});

test('historical opt-in and surfaces: wildcard recipients receive nothing, explicit ones do, the type cannot be reported or used as attestation, no MCP tool exists, and no job action runs', async t => {
  const { coop, principals, codex, grok, jobId, record, events, row, access, orchestrator, stateRoot, files } = await setup(t);
  await coop.registerRecipient({ id: 'wild', kind: 'inbox', principalId: 'codex' });
  const explicit = await coop.registerRecipient({ id: 'hist', kind: 'grok-native-webhook', endpoint: 'https://hooks.example.invalid/h', secretFile: '/nonexistent/secret', types: ['history.imported', 'work.reported'] });
  await fs.writeFile(events, row('e-A', { extra: { nested: 'value' } }));
  const jobBefore = await fs.readFile(files.job, 'utf8');
  const inspect = orchestrator.inspect.bind(orchestrator); let inspected = 0; orchestrator.inspect = async (...a) => { inspected++; return inspect(...a); };
  const imported = await coop.importRunEvents({ jobId });
  assert.equal(imported.committed, 1);
  assert.deepEqual(imported.rows[0].deliveries, ['hist'], 'only the explicit registration is frozen into the delivery');
  assert.equal(inspected, 0, 'the orchestrator is never consulted');
  assert.equal(await fs.readFile(files.job, 'utf8'), jobBefore, 'the job record is untouched');
  assert.equal((await coop.inbox(codex, {})).events.length, 0, 'wildcard inbox: nothing');
  const pending = await coop.pendingDeliveries();
  assert.deepEqual(pending.map(d => [d.consumerId, d.epoch, d.state]), [['hist', explicit.epoch, 'pending']]);
  const event = (await new CoopStore({ root: stateRoot }).load()).records.at(-1).event;
  assert.equal(event.type, 'history.imported'); assert.equal(event.source.via, 'import'); assert.equal(event.task.intentRevision, null);
  assert.equal(event.legacyRef.timestamp, '2026-10-20T00:00:01.000Z'); assert.notEqual(event.createdAt, event.legacyRef.timestamp);
  assert.equal(event.payload.extraFields, 1); assert.equal(JSON.stringify(event).includes('nested'), false, 'extra field values are hashed, never displayed');
  assert.deepEqual(event.evidenceRefs.map(e => e.label), ['reported']);
  await assert.rejects(coop.report(grok, { idempotencyKey: 'h', type: 'history.imported', task: { ref: `harnessorbit:job/${jobId}` }, payload: {} }), e => e.code === 'authority_denied');
  // The attestation rule itself: an imported historical event, although recorded under the owner's
  // identity and about this job, attests nothing for an orchestrator-carried checkpoint.
  const memory = new MemoryService({ root: stateRoot, provider: new NullMemoryProvider(), principals, jobs: access.jobs, orchestrator, coop, orchestratorCarrier: true });
  const current = await principals.get('grok');
  await assert.rejects(memory._attestation(current, { kind: 'job', id: jobId, intentRevision: null }, event.eventId, { target: { intentRevision: null } }), e => e.code === 'attestation_invalid');
  const own = await coop.report(grok, { idempotencyKey: 'own', type: 'work.reported', task: { ref: `harnessorbit:job/${jobId}` }, payload: {} });
  assert.equal((await memory._attestation(current, { kind: 'job', id: jobId, intentRevision: own.event.task.intentRevision }, own.event.eventId, { target: { intentRevision: own.event.task.intentRevision } })).attestation_ref, `harnessorbit:event/${own.event.eventId}`, 'control: the owner’s own report still attests');
  assert.ok(!ACCESS_TOOLS.some(t => /import/.test(t)));
  const server = await startAccessServer({ service: access, coop, port: 0 }); t.after(() => server.close());
  const token = (await principals.create({ id: 'lister', projects: [record.project], agents: ['claude'], kind: 'other' })).token;
  const listed = await (await fetch(server.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) })).json();
  assert.ok(!listed.result.tools.some(tool => /import/.test(tool.name)), 'no remote import surface');
  await assert.rejects(coop.importRunEvents({ jobId: '../runs/x' }), e => e.code === 'invalid_id');
  await assert.rejects(coop.importRunEvents({ jobId: 'no-such-job' }), e => e.code === 'job_not_found');
  assert.deepEqual(parseArgs(['access', 'coop', 'import', 'run-events', '--job', 'j1', '--limit', '5', '--dry-run']).values, { job: 'j1', limit: '5', 'dry-run': true });
  assert.throws(() => parseArgs(['access', 'coop', 'import', 'run-events', '--path', '/etc']), e => e.code === 'invalid_arguments');
});

test('canonical body: a sequence-only change and an extra-field change both conflict; anonymous, foreign-task, oversized and missing-attempt rows are gaps; a partial tail waits; a missing file is source_missing', async t => {
  const { coop, jobId, events, row, receipts, journal } = await setup(t);
  await fs.writeFile(events, row('e-A'));
  assert.equal((await coop.importRunEvents({ jobId })).committed, 1);
  const cp = (await receipts()).at(-1).checkpoint;
  for (const changed of [row('e-A', { sequence: 2 }), row('e-A', { note: 'x' })]) {
    await fs.writeFile(events, row('e-A') + changed);
    const r = await coop.importRunEvents({ jobId });
    assert.equal(r.gap.reason, 'conflict'); assert.notEqual(r.gap.sourceBodyHash, r.gap.committedBodyHash);
  }
  for (const [reason, line] of [['anonymous_row', `${JSON.stringify({ runId: 'r', type: 'attempt.state', timestamp: 't' })}\n`], ['foreign_task', row('e-T', { taskId: 'other-task' })], ['missing_attempt_identity', row('e-M', { attemptId: undefined })], ['oversized_row', row('e-O', { pad: 'x'.repeat(70000) })], ['malformed_row', '{\n']]) {
    await fs.writeFile(events, row('e-A') + line);
    const r = await coop.importRunEvents({ jobId });
    assert.equal(r.gap?.reason, reason, `expected ${reason}`); assert.equal(r.consumed, 0);
  }
  await fs.writeFile(events, row('e-A') + row('e-B', { sequence: 2 }).slice(0, -3));
  const partial = await coop.importRunEvents({ jobId });
  assert.equal(partial.partialTail, true); assert.equal(partial.consumed, 0); assert.equal(partial.gap, null);
  assert.equal((await receipts()).at(-1).checkpoint.bytes, cp.bytes, 'no progress while rows are unverifiable');
  assert.equal((await journal()).filter(r => r.event.type === 'history.imported').length, 1);
  await fs.unlink(events);
  assert.equal((await coop.importRunEvents({ jobId })).status, 'source_missing');
  assert.ok(HISTORICAL_TYPES.includes('history.imported'));
});
