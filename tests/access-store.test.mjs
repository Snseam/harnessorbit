import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Orchestrator } from '../src/orchestrator.mjs';
import { PrincipalStore } from '../src/access/principals.mjs';
import { AccessService } from '../src/access/service.mjs';
import { SessionStore } from '../src/access/sessions.mjs';
import { CoopService, CoopStore, STORE_SCHEMA, encodeCursor, decodeCursor, jsonFileBytes } from '../src/access/coop.mjs';
import { Dispatcher } from '../src/access/dispatch.mjs';
import { parseArgs } from '../bin/cao.mjs';
import { fixture, FakeHerdr } from './helpers.mjs';

// Fixture-level evidence for the cooperation store protocol (phase 2A): store identity, the
// committed recovery boundary over events, receipts and recipients, stopped-writer migration of
// a pre-protocol store, and the two cursor modes. Synthetic roots only; no live pilot root, no
// transport, no model.

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const v1Line = record => `${JSON.stringify({ ...record, sha: sha(JSON.stringify(record)) })}\n`;
const checks = [{ name: 'math', argv: [process.execPath, '--test', 'tests/math.test.mjs'], timeoutMs: 10000 }];
const job = (project, extra = {}) => ({ idempotencyKey: 'req-1', project, objective: 'Fix add to add its two inputs; preserve the existing tests.', context: 'Tests already encode the expected behaviour.', allowedPaths: ['src/math.mjs'], checks, ...extra });
const report = (jobId, extra = {}) => ({ idempotencyKey: 'r-1', type: 'work.reported', task: { ref: `harnessorbit:job/${jobId}` }, payload: { summary: 'add() now adds' }, ...extra });

async function setup(t, { init = true, clock } = {}) {
  const f = await fixture(); t.after(f.remove);
  f.project = await fs.realpath(f.project);
  const orchestrator = new Orchestrator({ stateRoot: f.stateRoot, herdr: new FakeHerdr() });
  const principals = new PrincipalStore({ root: f.stateRoot });
  const grok = (await principals.create({ id: 'grok', projects: [f.project], agents: ['claude', 'codex'], permissions: { sessions: true }, kind: 'grok' })).principal;
  const codex = (await principals.create({ id: 'codex', projects: [f.project], agents: ['claude', 'codex'], kind: 'codex' })).principal;
  const access = new AccessService({ root: f.stateRoot, orchestrator, principals, driver: 'inline' });
  const sessions = new SessionStore({ root: f.stateRoot });
  const coop = new CoopService({ root: f.stateRoot, principals, jobs: access.jobs, sessions, orchestrator, ...(clock ? { now: clock } : {}) });
  if (init) await coop.store.init();
  const jobId = (await access.submit(grok, job(f.project))).job.id;
  const dir = path.join(f.stateRoot, 'access', 'coop');
  const files = { journal: path.join(dir, 'journal.jsonl'), receipts: path.join(dir, 'receipts.jsonl'), recipients: path.join(dir, 'recipients.json'), intent: path.join(dir, 'recipients.intent.json'), store: path.join(dir, 'store.json') };
  const control = async () => JSON.parse(await fs.readFile(files.store, 'utf8'));
  return { ...f, orchestrator, principals, grok, codex, access, sessions, coop, jobId, dir, files, control };
}

// A pre-protocol (212cfb1 / 8a986f5 shaped) store: two events delivered to codex's inbox and a
// webhook, one ack, one unresolved `sending` attempt, no store.json.
async function writeLegacyRoot({ dir, codex, jobId, grok }, { tornTail = false, missingDelimiter = false } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const epoch = 'aaaaaaaaaaaaaaaa', hookEpoch = 'bbbbbbbbbbbbbbbb';
  const recipients = { schemaVersion: 1, recipients: {
    'codex-inbox': { id: 'codex-inbox', kind: 'inbox', epoch, label: null, scope: { taskRefs: [], sources: [], types: [] }, createdAt: '2026-10-20T00:00:00.000Z', revokedAt: null, principalId: 'codex', principalIncarnation: codex.incarnation },
    'grok-hook': { id: 'grok-hook', kind: 'grok-native-webhook', epoch: hookEpoch, label: null, scope: { taskRefs: [], sources: [], types: [] }, createdAt: '2026-10-20T00:00:00.000Z', revokedAt: null, transport: { endpoint: 'https://hooks.example.invalid/x', secretFile: '/nonexistent/secret' } },
  } };
  const event = (seq, id, key) => ({ v: 1, kind: 'event', seq, event: { schema: 'harnessorbit.coop.event.v1', eventId: id, seq, createdAt: '2026-10-20T00:00:01.000Z', type: 'work.reported', source: { principalId: 'grok', incarnation: grok.incarnation, kind: 'grok', via: 'cli', binding: null }, task: { ref: `harnessorbit:job/${jobId}`, kind: 'job', id: jobId, intentRevision: 1 }, conversationRef: null, correlationId: null, causationId: null, hop: 0, payload: { summary: `legacy ${seq}` }, evidenceRefs: [] }, idempotency: { principalId: 'grok', incarnation: grok.incarnation, keyHash: sha(key), bodyHash: sha(`body-${seq}`) }, deliveries: [{ consumerId: 'codex-inbox', kind: 'inbox', epoch, principalId: 'codex', principalIncarnation: codex.incarnation, state: 'pending' }, { consumerId: 'grok-hook', kind: 'grok-native-webhook', epoch: hookEpoch, principalId: null, principalIncarnation: null, state: 'pending' }] });
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  let journal = v1Line(event(1, ids[0], 'k1')) + v1Line(event(2, ids[1], 'k2'));
  if (missingDelimiter) journal = journal.slice(0, -1);
  if (tornTail) journal += '{"v":1,"kind":"event","seq":3,"event":{"eventId":"to';
  const receipts = v1Line({ v: 1, kind: 'ack', eventId: ids[0], consumerId: 'codex-inbox', epoch, at: '2026-10-20T00:00:02.000Z', principalId: 'codex', incarnation: codex.incarnation })
    + v1Line({ v: 1, kind: 'attempt', eventId: ids[0], consumerId: 'grok-hook', epoch: hookEpoch, outcome: 'sending', detail: 'in flight', attempts: 1, nextAttemptAt: null, unresolved: false, receipt: null, at: '2026-10-20T00:00:03.000Z' });
  await fs.writeFile(path.join(dir, 'journal.jsonl'), journal);
  await fs.writeFile(path.join(dir, 'receipts.jsonl'), receipts);
  await fs.writeFile(path.join(dir, 'recipients.json'), jsonFileBytes(recipients));
  return { ids, epoch, hookEpoch, journalBytes: Buffer.byteLength(journal), receiptBytes: Buffer.byteLength(receipts) };
}

test('store identity: a fresh root refuses every remote call until the host initialises it, and init is explicit and non-destructive', async t => {
  const { coop, grok, codex, jobId, files, control } = await setup(t, { init: false });
  for (const call of [() => coop.report(grok, report(jobId)), () => coop.inbox(codex, {}), () => coop.ack(codex, { eventId: '11111111-1111-4111-8111-111111111111', epoch: 'x' }), () => coop.pendingDeliveries(), () => coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex' })]) {
    await assert.rejects(call(), e => e.code === 'store_uninitialized' && /store init/.test(e.details.operatorAction));
  }
  assert.equal((await coop.store.inspect()).status, 'store_uninitialized');
  const init = await coop.store.init();
  assert.match(init.generation, /^[0-9a-f-]{36}$/);
  const c = await control();
  assert.equal(c.schema, STORE_SCHEMA); assert.equal(c.generation, init.generation); assert.equal(c.migration.state, 'none');
  assert.deepEqual([c.boundary.eventSeq, c.boundary.eventLines, c.boundary.eventBytes, c.boundary.receiptLines, c.boundary.recipientsRevision, c.boundary.retentionFloor], [0, 0, 0, 0, 0, 0]);
  assert.equal(c.boundary.recipientsSha, sha(await fs.readFile(files.recipients)), 'the boundary names the exact recipients file');
  await assert.rejects(coop.store.init(), e => e.code === 'store_initialized');
  await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex' });
  const r = await coop.report(grok, report(jobId));
  assert.equal(r.event.seq, 1);
  const after = await control();
  assert.equal(after.generation, init.generation, 'the generation is a lineage identifier; it never rotates on ordinary mutations');
  assert.deepEqual([after.boundary.eventSeq, after.boundary.eventLines, after.boundary.recipientsRevision], [1, 1, 1]);
  assert.equal(after.boundary.eventBytes, (await fs.stat(files.journal)).size);
  assert.equal(after.boundary.eventLastSha, JSON.parse((await fs.readFile(files.journal, 'utf8')).trim()).sha);
  assert.equal(JSON.parse((await fs.readFile(files.journal, 'utf8')).trim()).prev, `genesis:${init.generation}`, 'the first line of a truly empty log anchors at genesis');
  // Deleting the control record of an initialised store is metadata loss, never an empty store.
  await fs.unlink(files.store);
  await assert.rejects(coop.inbox(codex, {}), e => e.code === 'store_metadata_missing');
  await assert.rejects(coop.store.init(), e => e.code === 'store_not_empty');
  await assert.rejects(coop.store.migrate({ fromV1: true }), e => e.code === 'store_metadata_missing');
  assert.equal((await coop.store.inspect()).status, 'store_metadata_missing');
});

test('upgrade: a nonempty pre-protocol store is migrated in place with identical bytes, ids, epochs, acks and the unresolved attempt; one generation; resume replays only the saved plan', async t => {
  const f = await setup(t, { init: false });
  const { coop, grok, codex, jobId, files, control } = f;
  const legacy = await writeLegacyRoot(f);
  const journalBefore = await fs.readFile(files.journal);
  const receiptsBefore = await fs.readFile(files.receipts);
  // Before migration every remote call names the required host action; init refuses a populated root.
  await assert.rejects(coop.inbox(codex, {}), e => e.code === 'legacy_migration_required' && /migrate --from-v1/.test(e.details.operatorAction));
  await assert.rejects(coop.report(grok, report(jobId, { idempotencyKey: 'k3' })), e => e.code === 'legacy_migration_required');
  await assert.rejects(coop.store.init(), e => e.code === 'store_not_empty');
  await assert.rejects(coop.store.migrate({}), e => e.code === 'invalid_arguments');
  await assert.rejects(coop.store.migrate({ resume: true }), e => e.code === 'migration_not_started');
  const migrated = await coop.store.migrate({ fromV1: true });
  assert.equal(migrated.migrated, true);
  assert.deepEqual(migrated.baseline, { events: 2, lastSeq: 2, receipts: 2, recipients: 2 });
  assert.ok(Buffer.compare(journalBefore, await fs.readFile(files.journal)) === 0, 'legacy journal bytes are untouched');
  assert.ok(Buffer.compare(receiptsBefore, await fs.readFile(files.receipts)) === 0, 'legacy receipt bytes are untouched');
  const c = await control();
  assert.equal(c.migration.state, 'complete'); assert.equal(c.generation, migrated.generation);
  assert.deepEqual([c.boundary.eventSeq, c.boundary.eventLines, c.boundary.eventBytes, c.boundary.receiptLines, c.boundary.recipientsRevision], [2, 2, legacy.journalBytes, 2, 1]);
  const recipientsDoc = JSON.parse(await fs.readFile(files.recipients, 'utf8'));
  assert.equal(recipientsDoc.generation, migrated.generation); assert.equal(recipientsDoc.revision, 1);
  assert.equal(recipientsDoc.recipients['codex-inbox'].epoch, legacy.epoch, 'epochs are carried, not regenerated');
  assert.equal(recipientsDoc.recipients['grok-hook'].epoch, legacy.hookEpoch);
  // Same UUIDs, bodies, sequence, delivery epochs; the ack stands; the unresolved attempt stands and is not resent.
  const inbox = await coop.inbox(codex, {});
  assert.deepEqual(inbox.events.map(e => [e.seq, e.eventId, e.payload.summary, e.delivery.epoch, e.delivery.acknowledgedAt !== null]), [[1, legacy.ids[0], 'legacy 1', legacy.epoch, true], [2, legacy.ids[1], 'legacy 2', legacy.epoch, false]]);
  assert.equal(inbox.cursorMode, 'bootstrap'); assert.equal(inbox.generation, migrated.generation);
  assert.equal((await coop.ack(codex, { eventId: legacy.ids[0], epoch: legacy.epoch })).repeated, true, 'the legacy ack is the same receipt');
  const pending = await coop.pendingDeliveries();
  assert.deepEqual(pending.map(d => [d.eventId, d.state]), [[legacy.ids[0], 'sending'], [legacy.ids[1], 'pending']]);
  // A new event chains to the last legacy line; the legacy prefix stays byte-identical.
  const r3 = await coop.report(grok, report(jobId, { idempotencyKey: 'k3', payload: { summary: 'post-migration' } }));
  assert.equal(r3.event.seq, 3);
  const lines = (await fs.readFile(files.journal, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[2]).prev, JSON.parse(lines[1]).sha, 'the first new line chains to the last legacy line, not to genesis');
  assert.ok(Buffer.compare(journalBefore, (await fs.readFile(files.journal)).subarray(0, legacy.journalBytes)) === 0);
  // Legacy numeric cursor N maps to the same sequence in the verified lineage; N ahead is refused.
  const page = await coop.inbox(codex, { cursor: 2 });
  assert.deepEqual(page.events.map(e => e.seq), [3]); assert.equal(page.cursorMode, 'legacy_numeric'); assert.equal(page.limitations.length, 2);
  await assert.rejects(coop.inbox(codex, { cursor: 4 }), e => e.code === 'cursor_ahead');
  await assert.rejects(coop.store.migrate({ fromV1: true }), e => e.code === 'store_initialized');
  assert.equal((await coop.store.inspect()).status, 'ok');
});

test('upgrade: an interrupted migration is resumable with the same generation and frozen baseline, blocks on drift, and keeps every other call out until complete', async t => {
  const f = await setup(t, { init: false });
  const { coop, codex, grok, jobId, files, control } = f;
  const legacy = await writeLegacyRoot(f, { tornTail: true });
  // Prepare only (crash right after the plan was persisted): simulate by running the preparation and
  // then restoring the files to their pre-repair state before resume runs.
  const original = { journal: await fs.readFile(files.journal), recipients: await fs.readFile(files.recipients) };
  const first = await coop.store.migrate({ fromV1: true });
  const plan = await control();
  assert.equal(plan.migration.repair.journal.droppedLine, 3, 'the torn legacy tail was planned away');
  assert.equal(plan.boundary.eventBytes, legacy.journalBytes - Buffer.byteLength('{"v":1,"kind":"event","seq":3,"event":{"eventId":"to'));
  // Rewind to "crash after prepare": plan persisted as in_progress, files untouched.
  await fs.writeFile(files.store, JSON.stringify({ ...plan, migration: { ...plan.migration, state: 'in_progress', phase: 'prepared', completedAt: null }, boundary: null }));
  await fs.writeFile(files.journal, original.journal); await fs.writeFile(files.recipients, original.recipients);
  for (const call of [() => coop.inbox(codex, {}), () => coop.report(grok, report(jobId, { idempotencyKey: 'k9' })), () => coop.pendingDeliveries()]) await assert.rejects(call(), e => e.code === 'migration_in_progress' && /--resume/.test(e.details.operatorAction));
  await assert.rejects(coop.store.migrate({ fromV1: true }), e => e.code === 'migration_in_progress');
  assert.equal((await coop.store.inspect()).status, 'migration_in_progress');
  const resumed = await coop.store.migrate({ resume: true });
  assert.equal(resumed.generation, first.generation, 'resume reuses the one generation minted at preparation');
  assert.equal(resumed.repaired.journal.droppedTornTail, true);
  assert.deepEqual((await control()).boundary, plan.boundary === null ? (await control()).boundary : { ...plan.boundary, updatedAt: (await control()).boundary.updatedAt, sha: (await control()).boundary.sha });
  assert.deepEqual((await coop.inbox(codex, {})).events.map(e => e.seq), [1, 2]);
  // Crash after recipients were replaced but before completion: resume completes from the post-image.
  const done = await control();
  await fs.writeFile(files.store, JSON.stringify({ ...done, migration: { ...done.migration, state: 'in_progress', phase: 'recipients_replaced', completedAt: null }, boundary: null }));
  const again = await coop.store.migrate({ resume: true });
  assert.equal(again.generation, first.generation);
  assert.equal(JSON.parse(await fs.readFile(files.recipients, 'utf8')).recipients['codex-inbox'].epoch, legacy.epoch);
  // Drift during a paused migration: a log that no longer matches the frozen images blocks; nothing is adopted as a new baseline.
  await fs.writeFile(files.store, JSON.stringify({ ...done, migration: { ...done.migration, state: 'in_progress', phase: 'prepared', completedAt: null }, boundary: null }));
  await fs.appendFile(files.journal, v1Line({ v: 1, kind: 'event', seq: 3, event: { eventId: '33333333-3333-4333-8333-333333333333' }, idempotency: {}, deliveries: [] }));
  await assert.rejects(coop.store.migrate({ resume: true }), e => e.code === 'migration_blocked' && e.details.file === 'journal.jsonl');
  assert.equal((await control()).migration.state, 'in_progress', 'still blocked, not silently completed');
});

test('upgrade refusals: a complete legacy row with a bad checksum, a broken sequence, or chained rows without store.json never migrate', async t => {
  const f = await setup(t, { init: false });
  const { coop, files } = f;
  await writeLegacyRoot(f);
  const good = await fs.readFile(files.journal, 'utf8');
  await fs.writeFile(files.journal, good.replace('"legacy 2"', '"tampered"'));
  await assert.rejects(coop.store.migrate({ fromV1: true }), e => e.code === 'legacy_prefix_invalid');
  assert.equal(await fs.readFile(files.store, 'utf8').catch(e => e.code), 'ENOENT', 'nothing was written');
  const [l1, l2] = good.trim().split('\n');
  await fs.writeFile(files.journal, `${l2}\n${l1}\n`);
  await assert.rejects(coop.store.migrate({ fromV1: true }), e => e.code === 'legacy_prefix_invalid' && /contiguous/.test(e.message));
  await fs.writeFile(files.journal, good);
  await fs.appendFile(files.receipts, v1Line({ v: 1, kind: 'ack', eventId: 'x', consumerId: 'y', prev: 'deadbeef' }));
  await assert.rejects(coop.store.migrate({ fromV1: true }), e => e.code === 'store_metadata_missing');
});

test('crash windows: appended but uncommitted rows are adopted under the lock exactly once; retries reuse the UUID, repeat the ack, and leave the attempt unresolved', async t => {
  const { coop, grok, codex, jobId, files, control } = await setup(t);
  await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex' });
  await coop.registerRecipient({ id: 'hook', kind: 'grok-native-webhook', endpoint: 'https://hooks.example.invalid/h', secretFile: '/nonexistent/secret' });
  const a = await coop.report(grok, report(jobId, { idempotencyKey: 'a' }));
  // 1. Event line appended, process died before the boundary commit.
  const pre = await control();
  const key = 'b';
  const ghost = { v: 1, kind: 'event', seq: 2, event: { ...a.event, eventId: '0b5a4b5a-5c7e-4f1e-9a1a-00000000000b', seq: 2, payload: { summary: 'crashed' } }, idempotency: { principalId: 'grok', incarnation: grok.incarnation, keyHash: sha(key), bodyHash: sha(JSON.stringify({ type: 'work.reported', task: `harnessorbit:job/${jobId}`, intentRevision: 1, payload: { summary: 'crashed' }, evidenceRefs: [], conversationRef: null, correlationId: null, causationId: null })) }, deliveries: [{ consumerId: 'codex-inbox', kind: 'inbox', epoch: (await coop.store.recipients())['codex-inbox'].epoch, principalId: 'codex', principalIncarnation: codex.incarnation, state: 'pending' }] };
  await coop.store.journal.append(ghost, pre.boundary.eventLastSha);
  assert.equal((await control()).boundary.eventSeq, 1, 'not yet committed');
  const inbox = await coop.inbox(codex, {});
  assert.deepEqual(inbox.events.map(e => e.seq), [1, 2], 'the chained row is adopted on open');
  assert.deepEqual(inbox.recovered.journal, { adoptedLines: 1 });
  const post = await control();
  assert.deepEqual([post.boundary.eventSeq, post.boundary.eventLines, post.boundary.eventBytes], [2, 2, (await fs.stat(files.journal)).size]);
  assert.equal(post.lastRecovery.journal.adoptedLines, 1);
  const retry = await coop.report(grok, report(jobId, { idempotencyKey: key, payload: { summary: 'crashed' } }));
  assert.equal(retry.reused, true); assert.equal(retry.event.eventId, ghost.event.eventId, 'the caller’s retry finds the adopted event by its idempotency key');
  assert.equal((await coop.inbox(codex, {})).recovered, null, 'adoption happened once');
  // 2. Ack appended, boundary not committed: adopted; the ack retry is a repeat.
  const b1 = await control();
  await coop.store.receipts.append({ v: 1, kind: 'ack', eventId: a.event.eventId, consumerId: 'codex-inbox', epoch: inbox.events[0].delivery.epoch, at: '2026-10-22T00:00:00.000Z', principalId: 'codex', incarnation: codex.incarnation }, b1.boundary.receiptLines ? b1.boundary.receiptLastSha : `genesis:${b1.generation}`);
  const ack = await coop.ack(codex, { eventId: a.event.eventId, epoch: inbox.events[0].delivery.epoch });
  assert.equal(ack.repeated, true); assert.equal(ack.acknowledgedAt, '2026-10-22T00:00:00.000Z');
  assert.equal((await control()).boundary.receiptLines, 1);
  // 3. `sending` attempt appended, boundary not committed: the delivery is unresolved, never pending again.
  const b2 = await control();
  await coop.store.receipts.append({ v: 1, kind: 'attempt', eventId: a.event.eventId, consumerId: 'hook', epoch: (await coop.store.recipients()).hook.epoch, outcome: 'sending', detail: 'in flight', attempts: 1, nextAttemptAt: null, unresolved: false, receipt: null, at: '2026-10-22T00:00:01.000Z' }, b2.boundary.receiptLastSha);
  const pending = (await coop.pendingDeliveries()).find(d => d.eventId === a.event.eventId && d.consumerId === 'hook');
  assert.equal(pending.state, 'sending');
  assert.equal((await control()).boundary.receiptLines, 2);
  // The dispatcher treats it as unresolved and, with a transport that cannot query receipts, does not send.
  let sent = 0;
  const dispatcher = new Dispatcher({ root: files.store.replace(/\/access\/coop\/store\.json$/, ''), coop, principals: coop.principals, adapters: { 'grok-native-webhook': { canReconcile: false, deliver: async () => { sent++; return { outcome: 'accepted' }; } } } });
  const results = await dispatcher.tick();
  assert.equal(results.find(r => r.key === `${a.event.eventId}:hook`).outcome, 'unknown');
  assert.equal(sent, 0, 'no blind resend of an unresolved delivery');
});

test('recipient replacement: the mutation intent rolls forward from the pre-image, completes from the post-image, and refuses foreign content; rollback without intent fails closed', async t => {
  const { coop, grok, codex, jobId, files, control } = await setup(t);
  const first = await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex' });
  const committedBytes = await fs.readFile(files.recipients);
  assert.equal(sha(committedBytes), (await control()).boundary.recipientsSha);
  assert.equal(await fs.readFile(files.intent, 'utf8').catch(e => e.code), 'ENOENT', 'no intent remains after a completed replacement');
  // 1. Crash after the intent was written, before the replacement: roll forward with the frozen epoch.
  const pre = await control();
  const content = { schemaVersion: 1, generation: pre.generation, revision: pre.boundary.recipientsRevision + 1, recipients: { ...JSON.parse(committedBytes.toString()).recipients, hook: { id: 'hook', kind: 'grok-native-webhook', epoch: 'cafebabecafebabe', label: null, scope: { taskRefs: [], sources: [], types: [] }, createdAt: 'x', revokedAt: null, transport: { endpoint: 'https://h.example.invalid/x', secretFile: '/nonexistent' } } } };
  const post = { revision: content.revision, sha: sha(jsonFileBytes(content)), content };
  await fs.writeFile(files.intent, JSON.stringify({ schema: 'harnessorbit.coop.intent.v1', generation: pre.generation, at: 'x', pre: { revision: pre.boundary.recipientsRevision, sha: pre.boundary.recipientsSha }, post }));
  const r = await coop.report(grok, report(jobId, { idempotencyKey: 'after-intent' }));
  assert.deepEqual(r.deliveries.map(d => [d.consumerId, d.epoch]).sort(), [['codex-inbox', first.epoch], ['hook', 'cafebabecafebabe']], 'the rolled-forward registration is frozen into the delivery with its frozen epoch');
  assert.equal(sha(await fs.readFile(files.recipients)), post.sha);
  const after1 = await control();
  assert.equal(after1.boundary.recipientsRevision, post.revision); assert.equal(after1.boundary.recipientsSha, post.sha);
  assert.equal(after1.lastRecovery.recipients.rolledForward, true);
  assert.equal(await fs.readFile(files.intent, 'utf8').catch(e => e.code), 'ENOENT');
  // 2. Crash after the replacement, before the boundary: completion from the post-image.
  const pre2 = await control();
  const content2 = { ...content, revision: pre2.boundary.recipientsRevision + 1, recipients: { ...content.recipients, hook: { ...content.recipients.hook, revokedAt: 'now' } } };
  const post2 = { revision: content2.revision, sha: sha(jsonFileBytes(content2)), content: content2 };
  await fs.writeFile(files.intent, JSON.stringify({ schema: 'harnessorbit.coop.intent.v1', generation: pre2.generation, at: 'x', pre: { revision: pre2.boundary.recipientsRevision, sha: pre2.boundary.recipientsSha }, post: post2 }));
  await fs.writeFile(files.recipients, jsonFileBytes(content2));
  const inbox = await coop.inbox(codex, {});
  assert.deepEqual(inbox.recovered.recipients, { completed: true, revision: post2.revision });
  assert.equal((await control()).boundary.recipientsSha, post2.sha);
  assert.equal((await coop.listRecipients()).recipients.find(x => x.id === 'hook').revokedAt, 'now');
  // 3. Intent present but the file matches neither image: corruption, fail closed, nothing written.
  const pre3 = await control();
  await fs.writeFile(files.intent, JSON.stringify({ schema: 'harnessorbit.coop.intent.v1', generation: pre3.generation, at: 'x', pre: { revision: pre3.boundary.recipientsRevision, sha: pre3.boundary.recipientsSha }, post: { ...post2, revision: pre3.boundary.recipientsRevision + 1 } }));
  const good = await fs.readFile(files.recipients);
  await fs.writeFile(files.recipients, jsonFileBytes({ ...content2, recipients: {} }));
  await assert.rejects(coop.inbox(codex, {}), e => e.code === 'recipients_corrupt');
  await assert.rejects(coop.report(grok, report(jobId, { idempotencyKey: 'blocked' })), e => e.code === 'recipients_corrupt');
  assert.deepEqual((await control()).boundary, pre3.boundary, 'the boundary did not move');
  await fs.writeFile(files.recipients, good); await fs.unlink(files.intent);
  // 4. An older recipients file restored without an intent: rolled back, fail closed; no delivery is computed from the revived registration.
  await fs.writeFile(files.recipients, committedBytes);
  await assert.rejects(coop.inbox(codex, {}), e => e.code === 'recipients_rolled_back' && /restore recipients.json/.test(e.details.operatorAction));
  await assert.rejects(coop.pendingDeliveries(), e => e.code === 'recipients_rolled_back');
  await assert.rejects(coop.report(grok, report(jobId, { idempotencyKey: 'blocked-2' })), e => e.code === 'recipients_rolled_back');
  assert.equal((await coop.store.inspect()).status, 'rolled_back');
  await fs.writeFile(files.recipients, good);
  assert.equal((await coop.store.inspect()).status, 'ok');
});

test('rollback and loss inside the committed boundary fail closed for every file; nothing is truncated, resurrected or re-sent', async t => {
  const { coop, grok, codex, jobId, files, control } = await setup(t);
  await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex' });
  await coop.registerRecipient({ id: 'hook', kind: 'grok-native-webhook', endpoint: 'https://hooks.example.invalid/h', secretFile: '/nonexistent/secret' });
  const a = await coop.report(grok, report(jobId, { idempotencyKey: 'a' }));
  const b = await coop.report(grok, report(jobId, { idempotencyKey: 'b' }));
  const epoch = (await coop.inbox(codex, {})).events[0].delivery.epoch;
  await coop.ack(codex, { eventId: a.event.eventId, epoch });
  await coop.recordAttempt({ eventId: b.event.eventId, consumerId: 'hook', epoch: (await coop.store.recipients()).hook.epoch, outcome: 'unknown', unresolved: true });
  const good = { journal: await fs.readFile(files.journal), receipts: await fs.readFile(files.receipts) };
  const boundary = (await control()).boundary;
  // Journal truncated below the boundary (an older copy restored).
  await fs.writeFile(files.journal, good.journal.subarray(0, good.journal.indexOf('\n') + 1));
  await assert.rejects(coop.inbox(codex, {}), e => e.code === 'store_rolled_back');
  await assert.rejects(coop.report(grok, report(jobId, { idempotencyKey: 'c' })), e => e.code === 'store_rolled_back');
  assert.equal((await fs.stat(files.journal)).size, good.journal.indexOf('\n') + 1, 'nothing was appended to a rolled-back journal');
  await fs.writeFile(files.journal, good.journal);
  // Receipts deleted: the ack must not come back as unacknowledged and the unknown delivery must not become pending.
  await fs.unlink(files.receipts);
  await assert.rejects(coop.inbox(codex, {}), e => e.code === 'receipts_rolled_back');
  await assert.rejects(coop.ack(codex, { eventId: a.event.eventId, epoch }), e => e.code === 'receipts_rolled_back');
  await assert.rejects(coop.pendingDeliveries(), e => e.code === 'receipts_rolled_back');
  let sent = 0;
  const dispatcher = new Dispatcher({ root: path.dirname(path.dirname(path.dirname(files.store))), coop, principals: coop.principals, adapters: { 'grok-native-webhook': { canReconcile: false, deliver: async () => { sent++; return { outcome: 'accepted' }; } } } });
  await assert.rejects(dispatcher.tick(), e => e.code === 'receipts_rolled_back');
  assert.equal(sent, 0);
  await fs.writeFile(files.receipts, good.receipts.subarray(0, good.receipts.indexOf('\n') + 1));
  await assert.rejects(coop.inbox(codex, {}), e => e.code === 'receipts_rolled_back');
  await fs.writeFile(files.receipts, good.receipts);
  assert.deepEqual((await control()).boundary, boundary, 'the boundary never moved during the failures');
  const inbox = await coop.inbox(codex, {});
  assert.equal(inbox.events[0].delivery.acknowledgedAt !== null, true);
  assert.equal((await coop.pendingDeliveries()).find(d => d.eventId === b.event.eventId).state, 'unknown');
  // A tampered store.json boundary is invalid metadata.
  const c = await control();
  await fs.writeFile(files.store, JSON.stringify({ ...c, boundary: { ...c.boundary, eventSeq: 99 } }));
  await assert.rejects(coop.inbox(codex, {}), e => e.code === 'store_metadata_invalid');
  await fs.writeFile(files.store, JSON.stringify(c));
  assert.equal((await coop.inbox(codex, {})).events.length, 2);
});

test('chain discipline beyond the boundary: a complete bad row is corruption, an unchained row is a nonconforming write, only an incomplete fragment is removed, and committed bytes are never touched', async t => {
  const { coop, grok, codex, jobId, files, control } = await setup(t);
  await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex' });
  await coop.report(grok, report(jobId, { idempotencyKey: 'a' }));
  const committed = await fs.readFile(files.journal);
  const { boundary, generation } = await control();
  const row = (record, prev) => { const body = { ...record, prev }; return JSON.stringify({ ...body, sha: sha(JSON.stringify(body)) }); };
  const record = { v: 1, kind: 'event', seq: 2, event: { eventId: '0b5a4b5a-5c7e-4f1e-9a1a-0000000000c1', seq: 2 }, idempotency: { principalId: 'grok', incarnation: grok.incarnation, keyHash: 'k', bodyHash: 'b' }, deliveries: [] };
  // Complete row, valid checksum, wrong prev (what an old or foreign writer would produce): corruption, not truncation.
  await fs.appendFile(files.journal, `${row(record, 'not-the-previous-sha')}\n`);
  await assert.rejects(coop.inbox(codex, {}), e => e.code === 'journal_corrupt' && /does not chain/.test(e.message));
  assert.equal((await coop.store.inspect()).status, 'corrupt');
  await fs.writeFile(files.journal, committed);
  // Complete row, bad checksum, terminated: corruption.
  await fs.appendFile(files.journal, `${row(record, boundary.eventLastSha).replace('"seq":2', '"seq":3')}\n`);
  await assert.rejects(coop.inbox(codex, {}), e => e.code === 'journal_corrupt' && /bad checksum/.test(e.message));
  await fs.writeFile(files.journal, committed);
  // A v1-style row without prev appended by an old binary after migration is equally nonconforming.
  await fs.appendFile(files.journal, v1Line(record));
  await assert.rejects(coop.inbox(codex, {}), e => e.code === 'journal_corrupt');
  await fs.writeFile(files.journal, committed);
  // Incomplete fragment: removed; committed bytes identical afterwards.
  await fs.appendFile(files.journal, row(record, boundary.eventLastSha).slice(0, 40));
  const inbox = await coop.inbox(codex, {});
  assert.deepEqual(inbox.recovered.journal, { droppedTornTail: true, line: 2 });
  assert.ok(Buffer.compare(await fs.readFile(files.journal), committed) === 0);
  assert.deepEqual((await control()).boundary, { ...boundary, updatedAt: (await control()).boundary.updatedAt, sha: (await control()).boundary.sha });
  // The committed row itself is never modified by any recovery: tamper inside the boundary → rolled back, bytes left alone.
  const tampered = Buffer.from(committed.toString().replace('"a"', '"z"'));
  if (Buffer.compare(tampered, committed) !== 0) {
    await fs.writeFile(files.journal, tampered);
    await assert.rejects(coop.inbox(codex, {}), e => e.code === 'store_rolled_back');
    assert.ok(Buffer.compare(await fs.readFile(files.journal), tampered) === 0);
    await fs.writeFile(files.journal, committed);
  }
  assert.equal(JSON.parse(committed.toString().trim()).prev, `genesis:${generation}`);
});

test('cursors: explicit mode selection, strict scoped validation with no fallback, legacy numeric compatibility, and order preserved across equal timestamps and restart', async t => {
  const fixed = () => '2026-10-22T00:00:00.000Z';
  const { coop, grok, codex, jobId, principals, stateRoot, control } = await setup(t, { clock: fixed });
  const reg = await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex' });
  const ids = [];
  for (const k of ['a', 'b', 'c']) ids.push((await coop.report(grok, report(jobId, { idempotencyKey: k }))).event.eventId);
  const boot = await coop.inbox(codex, { limit: 2 });
  assert.equal(boot.cursorMode, 'bootstrap');
  assert.deepEqual(boot.events.map(e => [e.seq, e.createdAt]), [[1, fixed()], [2, fixed()]]);
  assert.equal(boot.nextCursor, 2); assert.equal(boot.more, true);
  assert.deepEqual(decodeCursor(boot.nextCursorV2), { generation: boot.generation, seq: 2, consumerId: 'codex-inbox', incarnation: codex.incarnation, epoch: reg.epoch });
  assert.equal(boot.limitations, undefined);
  // Both modes at once is refused before any default applies.
  await assert.rejects(coop.inbox(codex, { cursor: 0, cursorV2: boot.nextCursorV2 }), e => e.code === 'invalid_cursor' && e.details.status === 'cursor_mode_conflict');
  // Scoped token continues; legacy numeric continues to the same place with limitations stated.
  const scoped = await coop.inbox(codex, { cursorV2: boot.nextCursorV2 });
  assert.deepEqual(scoped.events.map(e => e.seq), [3]); assert.equal(scoped.cursorMode, 'scoped');
  const numeric = await coop.inbox(codex, { cursor: 2 });
  assert.deepEqual(numeric.events.map(e => e.seq), [3]); assert.equal(numeric.cursorMode, 'legacy_numeric'); assert.equal(numeric.limitations.length, 2);
  assert.equal(numeric.nextCursorV2, scoped.nextCursorV2);
  // Strict validation, each a structured refusal, never a fallback to numeric mode or a jump to the head.
  const mk = patch => encodeCursor({ generation: boot.generation, seq: 1, consumerId: 'codex-inbox', incarnation: codex.incarnation, epoch: reg.epoch, ...patch });
  await assert.rejects(coop.inbox(codex, { cursorV2: mk({ generation: '00000000-0000-4000-8000-000000000000' }) }), e => e.code === 'cursor_wrong_generation');
  await assert.rejects(coop.inbox(codex, { cursorV2: mk({ consumerId: 'other-inbox' }) }), e => e.code === 'cursor_namespace_mismatch');
  await assert.rejects(coop.inbox(codex, { cursorV2: mk({ incarnation: 'stale' }) }), e => e.code === 'cursor_namespace_mismatch');
  await assert.rejects(coop.inbox(codex, { cursorV2: mk({ epoch: 'ffffffffffffffff' }) }), e => e.code === 'cursor_namespace_mismatch');
  await assert.rejects(coop.inbox(codex, { cursorV2: mk({ seq: 4 }) }), e => e.code === 'cursor_ahead' && e.details.committedSeq === 3);
  await assert.rejects(coop.inbox(codex, { cursor: 4 }), e => e.code === 'cursor_ahead');
  for (const bad of ['not-base64url!', Buffer.from('{"v":1,"g":"x","s":0}').toString('base64url'), Buffer.from(JSON.stringify({ v: 2, g: boot.generation, s: -1, c: 'codex-inbox', i: codex.incarnation, e: reg.epoch })).toString('base64url'), Buffer.from(JSON.stringify({ v: 2, g: boot.generation, s: 1.5, c: 'codex-inbox', i: codex.incarnation, e: reg.epoch })).toString('base64url'), Buffer.from(JSON.stringify({ v: 2, g: boot.generation, s: 1, c: 'codex-inbox' })).toString('base64url'), '']) {
    await assert.rejects(coop.inbox(codex, { cursorV2: bad }), e => e.code === 'invalid_cursor' && e.details.status === 'cursor_malformed');
  }
  await assert.rejects(coop.inbox(codex, { cursor: -1 }), e => e.code === 'invalid_cursor');
  await assert.rejects(coop.inbox(codex, { cursor: 1.5 }), e => e.code === 'invalid_cursor');
  // Expired: the retention floor raised in the fixture only (pruning stays disabled in the product).
  await coop.store.lock(async () => { const state = await coop.store.open(); await coop.store._commit(state.control, { retentionFloor: 1 }); });
  await assert.rejects(coop.inbox(codex, { cursor: 0 }), e => e.code === 'cursor_expired' && e.details.retentionFloor === 1);
  await assert.rejects(coop.inbox(codex, { cursorV2: mk({ seq: 0 }) }), e => e.code === 'cursor_expired');
  assert.equal((await coop.inbox(codex, { cursor: 1 })).retentionFloor, 1);
  await coop.store.lock(async () => { const state = await coop.store.open(); await coop.store._commit(state.control, { retentionFloor: 0 }); });
  // Re-registration (new epoch) and a recreated principal each start from their own position; the old token is refused, never rebased.
  await coop.revokeRecipient('codex-inbox');
  const reg2 = await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex' });
  await assert.rejects(coop.inbox(codex, { cursorV2: scoped.nextCursorV2 }), e => e.code === 'cursor_namespace_mismatch');
  const fresh = await coop.inbox(codex, {});
  assert.equal(decodeCursor(fresh.nextCursorV2).epoch, reg2.epoch);
  // Restart over the same files: the same generation, order and tokens.
  const restarted = new CoopService({ root: stateRoot, principals, jobs: coop.jobs, sessions: coop.sessions, orchestrator: coop.orchestrator, now: fixed });
  const replay = await restarted.inbox(codex, { cursor: 0 });
  assert.deepEqual(replay.events.map(e => [e.seq, e.eventId]), ids.map((id, i) => [i + 1, id]));
  assert.equal(replay.generation, boot.generation);
  assert.equal(replay.nextCursorV2, fresh.nextCursorV2);
  assert.equal((await control()).generation, boot.generation);
});

test('CLI parses the store and cursor commands', () => {
  assert.deepEqual(parseArgs(['access', 'coop', 'store', 'init']).command, 'access coop store init');
  assert.deepEqual(parseArgs(['access', 'coop', 'store', 'migrate', '--from-v1', '--resume']).values, { 'from-v1': true, resume: true });
  assert.deepEqual(parseArgs(['access', 'coop', 'store', 'inspect']).command, 'access coop store inspect');
  assert.deepEqual(parseArgs(['access', 'coop', 'inbox', '--principal', 'codex', '--cursor-v2', 'abc']).values, { principal: 'codex', 'cursor-v2': 'abc' });
  assert.throws(() => parseArgs(['access', 'coop', 'store', 'drop']), e => e.code === 'invalid_arguments');
});
