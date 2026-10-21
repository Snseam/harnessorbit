import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Orchestrator } from '../src/orchestrator.mjs';
import { PrincipalStore } from '../src/access/principals.mjs';
import { AccessService, ACCESS_TOOLS } from '../src/access/service.mjs';
import { SessionStore, SessionService } from '../src/access/sessions.mjs';
import { CoopService, CoopStore, COOP_SCHEMA } from '../src/access/coop.mjs';
import { SessionObserver } from '../src/access/observer.mjs';
import { MemoryService } from '../src/access/memory.mjs';
import { startAccessServer } from '../src/access/server.mjs';
import { parseArgs } from '../bin/cao.mjs';
import { fixture, FakeHerdr } from './helpers.mjs';

// Fixture-level evidence for the cooperation event store: fake Herdr, fake panes, scripted
// clocks. No real agent, Grok webhook or Codex runtime is involved.

const checks = [{ name: 'math', argv: [process.execPath, '--test', 'tests/math.test.mjs'], timeoutMs: 10000 }];
const job = (project, extra = {}) => ({ idempotencyKey: 'req-1', project, objective: 'Fix add to add its two inputs; preserve the existing tests.', context: 'Tests already encode the expected behaviour.', allowedPaths: ['src/math.mjs'], checks, ...extra });
const report = (jobId, extra = {}) => ({ idempotencyKey: 'r-1', type: 'work.reported', task: { ref: `harnessorbit:job/${jobId}` }, payload: { summary: 'add() now adds; tests pass locally', changed: ['src/math.mjs'] }, evidenceRefs: [{ label: 'reported', ref: 'worker:output', summary: 'local test run' }], ...extra });

async function setup(t, { clock } = {}) {
  const f = await fixture(); t.after(f.remove);
  f.project = await fs.realpath(f.project);
  const orchestrator = new Orchestrator({ stateRoot: f.stateRoot, herdr: new FakeHerdr() });
  const principals = new PrincipalStore({ root: f.stateRoot });
  const grok = await principals.create({ id: 'grok', projects: [f.project], agents: ['claude', 'codex'], permissions: { sessions: true }, kind: 'grok' });
  const codex = await principals.create({ id: 'codex', projects: [f.project], agents: ['claude', 'codex'], kind: 'codex' });
  const access = new AccessService({ root: f.stateRoot, orchestrator, principals, driver: 'inline' });
  const sessions = new SessionStore({ root: f.stateRoot });
  const coop = new CoopService({ root: f.stateRoot, principals, jobs: access.jobs, sessions, orchestrator, ...(clock ? { now: clock } : {}) });
  const submitted = await access.submit(grok.principal, job(f.project));
  return { ...f, orchestrator, principals, grok: grok.principal, grokToken: grok.token, codex: codex.principal, codexToken: codex.token, access, sessions, coop, jobId: submitted.job.id };
}

const bound = (project, principal, extra = {}) => ({ id: 'ses-1', bindingId: 'b-1', principalId: principal.id, principalIncarnation: principal.incarnation, label: null, paneId: '%9', target: 'live:0.0', panePid: 1, tmuxSocket: null, agent: { kind: 'claude', pid: 1, startedAt: 'x', comm: 'claude' }, project, allowKeys: false, messages: [], createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z', ...extra });

test('report records once, delivers to registered inboxes, and ack is a receipt bound to the delivery epoch', async t => {
  const { coop, grok, codex, jobId, principals } = await setup(t);
  await assert.rejects(coop.inbox(codex, {}), e => e.code === 'consumer_not_registered');
  const registered = await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex', types: ['work.reported', 'task.blocked', 'agent.turn_finished'] });
  assert.equal(registered.kind, 'inbox');
  assert.match(registered.epoch, /^[0-9a-f]{16}$/);
  await coop.registerRecipient({ id: 'grok-inbox', kind: 'inbox', principalId: 'grok' });
  const first = await coop.report(grok, report(jobId));
  assert.equal(first.event.schema, COOP_SCHEMA);
  assert.match(first.event.eventId, /^[0-9a-f-]{36}$/);
  assert.equal(first.event.seq, 1);
  assert.equal(first.event.source.principalId, 'grok');
  assert.equal(first.event.source.incarnation, grok.incarnation);
  assert.equal(first.event.source.kind, 'grok');
  assert.equal(first.event.task.ref, `harnessorbit:job/${jobId}`);
  assert.equal(first.event.task.intentRevision, 1);
  assert.equal(first.event.evidenceRefs[0].issuer, 'principal:grok', 'evidence stays attributed to the reporter');
  assert.deepEqual(first.deliveries.map(d => [d.consumerId, d.state]), [['codex-inbox', 'pending']], 'a reporter does not receive its own report');
  assert.equal(first.reused, false);
  const again = await coop.report(grok, report(jobId));
  assert.equal(again.reused, true);
  assert.equal(again.event.eventId, first.event.eventId);
  await assert.rejects(coop.report(grok, report(jobId, { payload: { summary: 'different body' } })), e => e.code === 'event_conflict');
  await assert.rejects(coop.report(grok, report(jobId, { idempotencyKey: 'r-2', type: 'verification.passed' })), e => e.code === 'authority_denied');
  await assert.rejects(coop.report(grok, report(jobId, { idempotencyKey: 'r-2', type: 'agent.turn_finished' })), e => e.code === 'authority_denied');
  await assert.rejects(coop.report(grok, report(jobId, { idempotencyKey: 'r-2', evidenceRefs: [{ label: 'verified', ref: 'x' }] })), e => e.code === 'authority_denied');
  await assert.rejects(coop.report(grok, report(jobId, { idempotencyKey: 'r-2', task: { ref: 'harnessorbit:job/job-not-mine' } })), e => e.code === 'task_not_found');
  await assert.rejects(coop.report(codex, report(jobId, { idempotencyKey: 'r-2' })), e => e.code === 'task_not_found', 'another principal cannot report on this job');
  await assert.rejects(coop.report(grok, report(jobId, { idempotencyKey: 'r-2', payload: { big: 'x'.repeat(3000) } })), e => e.code === 'invalid_event');
  await assert.rejects(coop.report(grok, report(jobId, { idempotencyKey: 'r-2', causationId: crypto.randomUUID() })), e => e.code === 'invalid_event');
  const inbox = await coop.inbox(codex, {});
  assert.equal(inbox.events.length, 1);
  assert.equal(inbox.events[0].eventId, first.event.eventId);
  assert.equal(inbox.events[0].delivery.current, true);
  assert.equal(inbox.events[0].delivery.acknowledgedAt, null);
  assert.equal(inbox.nextCursor, 1);
  assert.equal(inbox.trust, 'untrusted_external_data');
  assert.equal((await coop.inbox(codex, { cursor: 1 })).events.length, 0, 'reading does not advance anything; the cursor is the caller’s');
  assert.equal((await coop.inbox(grok, {})).events.length, 0);
  await assert.rejects(coop.ack(codex, { eventId: first.event.eventId, epoch: 'deadbeefdeadbeef' }), e => e.code === 'epoch_mismatch');
  await assert.rejects(coop.ack(codex, { eventId: crypto.randomUUID(), epoch: registered.epoch }), e => e.code === 'event_not_delivered');
  await assert.rejects(coop.ack(grok, { eventId: first.event.eventId, epoch: registered.epoch }), e => e.code === 'event_not_delivered', 'the reporter cannot ack an event not delivered to it');
  const acked = await coop.ack(codex, { eventId: first.event.eventId, epoch: registered.epoch });
  assert.equal(acked.repeated, false);
  assert.equal(acked.meaning, 'receipt');
  assert.equal((await coop.ack(codex, { eventId: first.event.eventId, epoch: registered.epoch })).repeated, true);
  assert.equal((await coop.inbox(codex, {})).events[0].delivery.acknowledgedAt, acked.acknowledgedAt);
  assert.deepEqual((await coop.report(grok, report(jobId))).deliveries[0].state, 'acknowledged');
  await principals.update('grok', { permissions: { submit: false, sessions: false } });
  await assert.rejects(coop.report(grok, report(jobId, { idempotencyKey: 'r-3' })), e => e.code === 'permission_denied', 'permission is read fresh');
});

test('the journal is the commit boundary: a torn tail is dropped on load, the next report appends cleanly, and a restart replays identical events', async t => {
  const fixedClock = () => '2026-10-22T00:00:00.000Z';
  const { coop, grok, codex, jobId, stateRoot } = await setup(t, { clock: fixedClock });
  await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex' });
  const a = await coop.report(grok, report(jobId, { idempotencyKey: 'a' }));
  const b = await coop.report(grok, report(jobId, { idempotencyKey: 'b', type: 'task.blocked', payload: { reason: 'needs a decision' } }));
  assert.equal(b.event.seq, 2);
  const journal = path.join(stateRoot, 'access', 'coop', 'journal.jsonl');
  await fs.appendFile(journal, '{"v":1,"kind":"event","seq":3,"event":{"eventId":"torn');
  const store = new CoopStore({ root: stateRoot });
  const loaded = await store.load();
  assert.equal(loaded.records.length, 2);
  assert.deepEqual(loaded.recovered.journal, { droppedTornTail: true, line: 3 });
  const inbox = await coop.inbox(codex, {});
  assert.deepEqual(inbox.events.map(e => e.eventId), [a.event.eventId, b.event.eventId]);
  assert.ok(inbox.recovered.journal.droppedTornTail, 'recovery is reported, not hidden');
  const c = await coop.report(grok, report(jobId, { idempotencyKey: 'c', type: 'question.asked', payload: { question: 'which branch?' } }));
  assert.equal(c.event.seq, 3, 'the torn line never became an event; the sequence continues from the last intact one');
  const after = await store.load();
  assert.equal(after.records.length, 3);
  assert.equal(after.recovered.journal, null, 'the torn tail was repaired before appending');
  // Restart: a fresh service over the same files replays the same UUIDs, payloads and order even with equal timestamps.
  const restarted = new CoopService({ root: stateRoot, principals: coop.principals, jobs: coop.jobs, sessions: coop.sessions, orchestrator: coop.orchestrator, now: fixedClock });
  const replay = await restarted.inbox(codex, {});
  assert.deepEqual(replay.events.map(e => [e.seq, e.eventId, e.createdAt]), [[1, a.event.eventId, fixedClock()], [2, b.event.eventId, fixedClock()], [3, c.event.eventId, fixedClock()]]);
  assert.deepEqual(replay.events[1].payload, { reason: 'needs a decision' });
  const paged = await restarted.inbox(codex, { cursor: 0, limit: 2 });
  assert.equal(paged.more, true);
  assert.equal(paged.nextCursor, 2);
  assert.equal((await restarted.inbox(codex, { cursor: 2, limit: 2 })).events[0].seq, 3);
  // Same key, same body after restart is the same event; a changed body is still a conflict.
  assert.equal((await restarted.report(grok, report(jobId, { idempotencyKey: 'a' }))).event.eventId, a.event.eventId);
  await assert.rejects(restarted.report(grok, report(jobId, { idempotencyKey: 'a', payload: { summary: 'changed' } })), e => e.code === 'event_conflict');
});

test('registration epochs and principal incarnations are frozen into deliveries: re-registration never redirects, recreation never inherits, revocation while waiting is honoured', async t => {
  const { coop, grok, codex, jobId, principals, stateRoot } = await setup(t);
  const first = await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex' });
  await assert.rejects(coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex' }), e => e.code === 'recipient_exists');
  const e1 = await coop.report(grok, report(jobId, { idempotencyKey: 'e1' }));
  assert.equal((await coop.revokeRecipient('codex-inbox')).revoked, true);
  await assert.rejects(coop.inbox(codex, {}), e => e.code === 'consumer_not_registered');
  const second = await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex' });
  assert.notEqual(second.epoch, first.epoch);
  const inbox = await coop.inbox(codex, {});
  assert.equal(inbox.events[0].delivery.epoch, first.epoch);
  assert.equal(inbox.events[0].delivery.current, false, 'the old delivery is visible as history but not current');
  await assert.rejects(coop.ack(codex, { eventId: e1.event.eventId, epoch: first.epoch }), e => e.code === 'epoch_mismatch');
  await assert.rejects(coop.ack(codex, { eventId: e1.event.eventId, epoch: second.epoch }), e => e.code === 'epoch_mismatch', 'an old delivery cannot be acknowledged under the new registration');
  const e2 = await coop.report(grok, report(jobId, { idempotencyKey: 'e2' }));
  assert.equal(e2.deliveries[0].epoch, second.epoch);
  assert.equal((await coop.ack(codex, { eventId: e2.event.eventId, epoch: second.epoch })).repeated, false);
  // Recreating the consumer principal id leaves the registration bound to the earlier incarnation.
  await principals.remove('codex');
  const reborn = (await principals.create({ id: 'codex', projects: [grok.projects[0]], agents: ['claude'], kind: 'codex' })).principal;
  await assert.rejects(coop.inbox(reborn, {}), e => e.code === 'consumer_not_registered');
  await assert.rejects(coop.inbox(codex, {}), e => e.code === 'permission_denied', 'the old snapshot is refused');
  // Scope narrowed while a report waits for the store lock: checked again inside the lock.
  let release; const gate = new Promise(r => { release = r; });
  const holding = coop.store.lock(() => gate);
  await new Promise(r => setTimeout(r, 30));
  const waiting = coop.report(grok, report(jobId, { idempotencyKey: 'while-waiting' }));
  await new Promise(r => setTimeout(r, 30));
  await principals.update('grok', { permissions: { submit: false, sessions: false } });
  release(); await holding;
  await assert.rejects(waiting, e => e.code === 'permission_denied');
  const records = (await new CoopStore({ root: stateRoot }).load()).records;
  assert.equal(records.length, 2, 'nothing was journaled for the refused report');
  await principals.update('grok', { permissions: { submit: true, sessions: true } });
  // Verifier types cannot be registered as something a caller sends; recipients can still subscribe to them.
  const verifierOnly = await coop.registerRecipient({ id: 'verifier-feed', kind: 'inbox', principalId: 'grok', types: ['verification.passed'] });
  assert.deepEqual(verifierOnly.scope.types, ['verification.passed']);
  assert.equal((await coop.report(grok, report(jobId, { idempotencyKey: 'e3' }))).deliveries.some(d => d.consumerId === 'verifier-feed'), false);
});

test('operator registration fixes destinations: webhooks need an exact https endpoint and a secret file path that is never echoed; pending non-inbox deliveries are listed, revoked on epoch change, and tracked through unknown outcomes', async t => {
  const { coop, grok, jobId, base } = await setup(t);
  await assert.rejects(coop.registerRecipient({ id: 'g', kind: 'grok-native-webhook', endpoint: 'http://insecure.example/hook', secretFile: path.join(base, 's') }), e => e.code === 'invalid_recipient');
  await assert.rejects(coop.registerRecipient({ id: 'g', kind: 'grok-native-webhook', endpoint: 'https://hooks.example/orbit?x=1', secretFile: path.join(base, 's') }), e => e.code === 'invalid_recipient', 'no query strings');
  await assert.rejects(coop.registerRecipient({ id: 'g', kind: 'grok-native-webhook', endpoint: 'https://hooks.example/orbit', secretFile: 'relative/secret' }), e => e.code === 'invalid_recipient');
  await assert.rejects(coop.registerRecipient({ id: 'c', kind: 'codex-app-server', socketPath: '/tmp/x.sock' }), e => e.code === 'invalid_recipient', 'a thread id is required');
  await assert.rejects(coop.registerRecipient({ id: 'c', kind: 'other' }), e => e.code === 'invalid_recipient');
  const webhook = await coop.registerRecipient({ id: 'grok-hook', kind: 'grok-native-webhook', endpoint: 'https://hooks.example/orbit', secretFile: path.join(base, 'grok.secret'), types: ['work.reported'] });
  assert.equal(webhook.transport.secretFile, '<redacted path>');
  assert.ok(!JSON.stringify(await coop.listRecipients()).includes('grok.secret'));
  const codexRt = await coop.registerRecipient({ id: 'codex-desktop', kind: 'codex-app-server', socketPath: '/tmp/codex-control.sock', threadId: 'thread-1' });
  assert.equal(codexRt.transport.threadId, 'thread-1');
  const e = await coop.report(grok, report(jobId));
  assert.deepEqual(e.deliveries.map(d => [d.consumerId, d.kind, d.state]), [['grok-hook', 'grok-native-webhook', 'pending'], ['codex-desktop', 'codex-app-server', 'pending']]);
  let pending = await coop.pendingDeliveries();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].state, 'pending');
  await coop.recordAttempt({ eventId: e.event.eventId, consumerId: 'grok-hook', epoch: webhook.epoch, outcome: 'unknown', detail: 'socket closed before response', attempts: 1, nextAttemptAt: '2026-10-22T00:01:00.000Z' });
  pending = await coop.pendingDeliveries();
  assert.equal(pending.find(d => d.consumerId === 'grok-hook').state, 'unknown', 'unknown is its own state, not failed and not accepted');
  assert.equal(pending.find(d => d.consumerId === 'grok-hook').nextAttemptAt, '2026-10-22T00:01:00.000Z');
  await coop.revokeRecipient('codex-desktop');
  await coop.registerRecipient({ id: 'codex-desktop', kind: 'codex-app-server', socketPath: '/tmp/codex-control.sock', threadId: 'thread-2' });
  pending = await coop.pendingDeliveries();
  const codexDelivery = pending.find(d => d.consumerId === 'codex-desktop');
  assert.equal(codexDelivery.state, 'revoked', 'the frozen delivery is not redirected to the new registration');
  assert.equal(codexDelivery.recipient, null);
  await coop.recordAttempt({ eventId: e.event.eventId, consumerId: 'grok-hook', epoch: webhook.epoch, outcome: 'accepted', attempts: 2 });
  assert.equal((await coop.pendingDeliveries()).some(d => d.consumerId === 'grok-hook'), false, 'transport acceptance ends dispatch; it is still not an acknowledgement');
  assert.equal((await coop.report(grok, report(jobId))).deliveries.find(d => d.consumerId === 'grok-hook').state, 'accepted');
});

test('the observer emits agent.turn_finished only on an observed working → ready transition, once per transition, across restarts and rebinds, and never for an initial idle snapshot', async t => {
  const { coop, grok, codex, sessions, project, stateRoot, principals } = await setup(t);
  await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex', types: ['agent.turn_finished'] });
  await sessions.create(bound(project, grok));
  const proc = { pid: 101, ppid: 1, pgid: 101, tpgid: 101, stat: 'S+', startedAt: 'x', comm: 'claude', args: 'claude' };
  const pane = { paneId: '%9', target: 'live:0.0', panePid: 1, dead: false, currentCommand: 'claude', currentPath: project, historySize: 0 };
  const tmux = { socket: null, screen: ['❯ '], pane: async () => pane, listPanes: async () => [pane], captureScreen: async () => [...tmux.screen], captureHistory: async () => [], sendText: async () => { throw new Error('observer never sends'); }, sendKeys: async () => { throw new Error('observer never sends'); } };
  const processes = { table: async () => new Map([[1, { ...proc, pid: 1, ppid: 0 }]]), agentUnder: async () => ({ ...proc, pid: 1, kind: 'claude' }), cwd: async () => project };
  const live = new SessionService({ root: stateRoot, principals, sessions, tmux, processes, settleMs: 0 });
  const observer = new SessionObserver({ root: stateRoot, sessions: live, coop, intervalMs: 1000 });
  let results = await observer.tick();
  assert.deepEqual(results, [{ sessionId: 'ses-1', state: 'idle', emitted: null }], 'an initial idle snapshot is not a transition');
  tmux.screen = ['> fix it', '✻ Working… (esc to interrupt)'];
  results = await observer.tick();
  assert.equal(results[0].state, 'busy');
  assert.equal(results[0].emitted, null);
  tmux.screen = ['⏺ done', '❯ '];
  results = await observer.tick();
  assert.equal(results[0].state, 'idle');
  assert.ok(results[0].emitted?.eventId, 'working → ready emits once');
  const first = results[0].emitted;
  assert.equal((await observer.tick())[0].emitted, null, 'staying idle emits nothing');
  const restarted = new SessionObserver({ root: stateRoot, sessions: live, coop, intervalMs: 1000 });
  assert.equal((await restarted.tick())[0].emitted, null, 'a restarted observer does not re-emit the persisted transition');
  const inbox = await coop.inbox(codex, {});
  assert.equal(inbox.events.length, 1);
  const event = inbox.events[0];
  assert.equal(event.type, 'agent.turn_finished');
  assert.equal(event.source.via, 'observer');
  assert.equal(event.source.principalId, 'grok', 'attributed to the binding’s principal as an observation about its session');
  assert.equal(event.source.binding, 'b-1');
  assert.equal(event.payload.observation, 'working_to_ready');
  assert.match(event.payload.meaning, /not task completion/);
  assert.equal(JSON.stringify(event).includes('fix it'), false, 'no screen text leaves the host');
  // A second cycle is a new transition; a replay of the same transition identity is deduplicated.
  tmux.screen = ['✻ Working…']; await observer.tick();
  tmux.screen = ['❯ ']; const second = (await observer.tick())[0].emitted;
  assert.notEqual(second.eventId, first.eventId);
  assert.equal((await coop.observe({ sessionId: 'ses-1', bindingId: 'b-1', transitionId: second.transitionId, observedAt: 'x', fromState: 'busy', toState: 'idle' })).reused, true);
  await assert.rejects(coop.observe({ sessionId: 'ses-1', bindingId: 'b-1', transitionId: 'ab'.repeat(8), observedAt: 'x', fromState: 'idle', toState: 'idle' }), e => e.code === 'invalid_event');
  // Rebinding resets observation state: the first idle seen for the new binding is not a transition.
  await sessions.remove('ses-1'); await sessions.create(bound(project, grok, { bindingId: 'b-2' }));
  tmux.screen = ['✻ Working…']; assert.equal((await observer.tick())[0].emitted, null);
  await assert.rejects(coop.observe({ sessionId: 'ses-1', bindingId: 'b-1', transitionId: 'ab'.repeat(8), observedAt: 'x', fromState: 'busy', toState: 'idle' }), e => e.code === 'session_not_found', 'an observation for the old binding is refused');
  // Revoking the binding principal's sessions permission stops observations from being recorded.
  await principals.update('grok', { permissions: { sessions: false } });
  tmux.screen = ['❯ '];
  assert.equal((await observer.tick())[0].emitted?.error, 'permission_denied');
  assert.equal((await coop.inbox(codex, {})).events.length, 2);
});

test('memory outages neither lose nor acknowledge events, and MCP serves the three tools with audit lines free of payload text', async t => {
  const f = await setup(t);
  const { coop, grok, codex, codexToken, grokToken, jobId, access, stateRoot } = f;
  const registered = await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex' });
  const memory = new MemoryService({ root: stateRoot, principals: f.principals, jobs: access.jobs, orchestrator: f.orchestrator });
  assert.equal((await memory.begin(grok, { jobId, operationId: 'op' })).status, 'unconfigured', 'memory is unavailable on this host');
  const started = await startAccessServer({ service: access, coop, memory, toolTimeoutMs: 10000 });
  t.after(started.close);
  const call = async (token, id, name, args = {}) => (await (await fetch(started.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
  const list = await (await fetch(started.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${grokToken}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }) })).json();
  assert.deepEqual(list.result.tools.map(tool => tool.name), [...ACCESS_TOOLS]);
  assert.equal((await call(grokToken, 1, 'describe')).structuredContent.cooperation.schema, COOP_SCHEMA);
  const reported = await call(grokToken, 2, 'coop_report', report(jobId, { payload: { summary: 'quokka secret summary' } }));
  assert.equal(reported.isError, false, JSON.stringify(reported.structuredContent));
  assert.equal(reported.structuredContent.event.source.via, 'mcp');
  const eventId = reported.structuredContent.event.eventId;
  const inbox = await call(codexToken, 3, 'coop_inbox', {});
  assert.equal(inbox.structuredContent.events[0].eventId, eventId);
  assert.equal(inbox.structuredContent.events[0].delivery.acknowledgedAt, null, 'a memory call did not acknowledge anything');
  const bad = await call(codexToken, 4, 'coop_ack', { eventId, epoch: 'wrong' });
  assert.equal(bad.structuredContent.code, 'epoch_mismatch');
  const acked = await call(codexToken, 5, 'coop_ack', { eventId, epoch: registered.epoch });
  assert.equal(acked.structuredContent.repeated, false);
  const audit = await fs.readFile(path.join(stateRoot, 'access', 'audit.jsonl'), 'utf8');
  assert.ok(!audit.includes('quokka'));
  assert.ok(!audit.includes(grokToken) && !audit.includes(codexToken));
  const lines = audit.trim().split('\n').map(l => JSON.parse(l)).filter(l => l.tool.startsWith('coop_'));
  assert.deepEqual(lines.map(l => l.tool), ['coop_report', 'coop_inbox', 'coop_ack', 'coop_ack']);
  const bare = await startAccessServer({ service: access, toolTimeoutMs: 5000 });
  t.after(bare.close);
  const none = await (await fetch(bare.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${codexToken}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'coop_inbox', arguments: {} } }) })).json();
  assert.equal(none.result.structuredContent.code, 'coop_unavailable');
});

test('CLI parses the recipient, coop and observe subcommands', () => {
  assert.equal(parseArgs(['access', 'recipient', 'register', '--id', 'x', '--kind', 'inbox', '--principal', 'codex', '--types', 'work.reported']).command, 'access recipient register');
  assert.equal(parseArgs(['access', 'coop', 'report', '--principal', 'grok', '--key', 'k', '--type', 'work.reported', '--task', 'harnessorbit:job/j']).values.task, 'harnessorbit:job/j');
  assert.equal(parseArgs(['access', 'coop', 'inbox', '--principal', 'codex', '--cursor', '3']).values.cursor, '3');
  assert.equal(parseArgs(['access', 'coop', 'ack', '--principal', 'codex', '--event', 'e', '--epoch', 'p']).command, 'access coop ack');
  assert.equal(parseArgs(['access', 'observe', '--once', '--interval-ms', '2000']).values.once, true);
});

test('crash regressions: a torn journal tail is truncated before the next append, and the observer neither loses a signal on a transient failure nor repeats it after a crash between event and state save', async t => {
  const { coop, grok, codex, jobId, stateRoot, sessions, project, principals } = await setup(t);
  await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex', types: ['work.reported', 'agent.turn_finished'] });
  // 1. valid → torn tail → append → append: every record intact, no corruption, no silent drop.
  await coop.report(grok, report(jobId, { idempotencyKey: 'one' }));
  const journal = path.join(stateRoot, 'access', 'coop', 'journal.jsonl');
  await fs.appendFile(journal, '{"v":1,"kind":"event","seq":2,"event":{"eventId":"to');
  const two = await coop.report(grok, report(jobId, { idempotencyKey: 'two', payload: { n: 2 } }));
  const three = await coop.report(grok, report(jobId, { idempotencyKey: 'three', payload: { n: 3 } }));
  assert.deepEqual([two.event.seq, three.event.seq], [2, 3]);
  const loaded = await new CoopStore({ root: stateRoot }).load();
  assert.equal(loaded.records.length, 3);
  assert.equal(loaded.recovered.journal, null);
  assert.deepEqual((await coop.inbox(codex, {})).events.map(e => e.seq), [1, 2, 3]);
  // 2. Observer: transient store failure keeps the transition pending and emits it on the next tick with the same identity.
  await sessions.create(bound(project, grok));
  const proc = { pid: 1, ppid: 0, pgid: 1, tpgid: 1, stat: 'S+', startedAt: 'x', comm: 'claude', args: 'claude' };
  const pane = { paneId: '%9', target: 'live:0.0', panePid: 1, dead: false, currentCommand: 'claude', currentPath: project, historySize: 0 };
  const tmux = { socket: null, screen: ['❯ '], pane: async () => pane, listPanes: async () => [pane], captureScreen: async () => [...tmux.screen], captureHistory: async () => [], sendText: async () => { throw new Error('never'); }, sendKeys: async () => { throw new Error('never'); } };
  const live = new SessionService({ root: stateRoot, principals, sessions, tmux, processes: { table: async () => new Map([[1, proc]]), agentUnder: async () => ({ ...proc, kind: 'claude' }), cwd: async () => project }, settleMs: 0 });
  const observer = new SessionObserver({ root: stateRoot, sessions: live, coop, intervalMs: 1000 });
  await observer.tick();                       // idle snapshot
  tmux.screen = ['✻ Working…']; await observer.tick();
  const observe = coop.observe.bind(coop);
  let failures = 0;
  coop.observe = async input => { if (failures++ === 0) { const e = new Error('lock busy'); e.code = 'lock_timeout'; throw e; } return observe(input); };
  tmux.screen = ['❯ '];
  const failed = (await observer.tick())[0].emitted;
  assert.equal(failed.error, 'lock_timeout');
  assert.equal(failed.retry, true);
  const retried = (await observer.tick())[0].emitted;   // still idle; the pending transition is retried, not lost
  assert.equal(retried.transitionId, failed.transitionId);
  assert.equal(retried.reused, false);
  assert.equal((await observer.tick())[0].emitted, null, 'once confirmed, nothing more is emitted for this transition');
  const turnEvents = (await coop.inbox(codex, {})).events.filter(e => e.type === 'agent.turn_finished');
  assert.equal(turnEvents.length, 1);
  coop.observe = observe;
  // 3. Crash after the event was journaled but before the observation state was saved: the restart re-derives the same identity and the store answers reused.
  tmux.screen = ['✻ Working…']; await observer.tick();
  const state = JSON.parse(await fs.readFile(path.join(stateRoot, 'access', 'coop', 'observations', 'ses-1.json'), 'utf8'));
  const expected = SessionObserver.transitionId('b-1', state.lastBusyAt);
  const direct = await coop.observe({ sessionId: 'ses-1', bindingId: 'b-1', transitionId: expected, observedAt: 'crashed-before-save', fromState: 'busy', toState: 'idle' });
  assert.equal(direct.reused, false, 'simulates the event the crashed process had already journaled');
  tmux.screen = ['❯ '];
  const after = (await new SessionObserver({ root: stateRoot, sessions: live, coop, intervalMs: 1000 }).tick())[0].emitted;
  assert.equal(after.transitionId, expected);
  assert.equal(after.reused, true, 'the restarted observer re-derives the same transition and does not create a second event');
  assert.equal((await coop.inbox(codex, {})).events.filter(e => e.type === 'agent.turn_finished').length, 2);
});

test('crash regression: a complete checksummed record without its final newline is kept and given its delimiter, never truncated', async t => {
  const { coop, grok, codex, jobId, stateRoot } = await setup(t);
  await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex' });
  const one = await coop.report(grok, report(jobId, { idempotencyKey: 'one' }));
  const journal = path.join(stateRoot, 'access', 'coop', 'journal.jsonl');
  const text = await fs.readFile(journal, 'utf8');
  assert.ok(text.endsWith('\n'));
  await fs.writeFile(journal, text.slice(0, -1)); // the newline never reached disk
  const loaded = await new CoopStore({ root: stateRoot }).load();
  assert.equal(loaded.records.length, 1, 'the record is complete and intact');
  const two = await coop.report(grok, report(jobId, { idempotencyKey: 'two', payload: { n: 2 } }));
  const three = await coop.report(grok, report(jobId, { idempotencyKey: 'three', payload: { n: 3 } }));
  assert.deepEqual([one.event.seq, two.event.seq, three.event.seq], [1, 2, 3]);
  const after = await new CoopStore({ root: stateRoot }).load();
  assert.deepEqual(after.records.map(r => r.event.eventId), [one.event.eventId, two.event.eventId, three.event.eventId]);
  assert.equal(after.recovered.journal, null);
  assert.deepEqual((await coop.inbox(codex, {})).events.map(e => e.seq), [1, 2, 3]);
  assert.ok((await fs.readFile(journal, 'utf8')).endsWith('\n'));
});

test('review regressions: a recreated consumer inherits no old payloads, and ack and report re-check authority after waiting for the store lock', async t => {
  const { coop, grok, codex, jobId, principals, project, base, access, stateRoot } = await setup(t);
  const first = await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex' });
  const old = await coop.report(grok, report(jobId, { idempotencyKey: 'old', payload: { summary: 'PROJECT_A_SECRET' } }));
  // 1. Recreate the consumer principal and re-register the same recipient id: the new owner sees nothing of the old inbox.
  await principals.remove('codex');
  const other = path.join(base, 'B'); await fs.mkdir(other);
  const reborn = (await principals.create({ id: 'codex', projects: [other], agents: ['codex'], kind: 'codex' })).principal;
  await coop.revokeRecipient('codex-inbox');
  const second = await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex' });
  const inbox = await coop.inbox(reborn, {});
  assert.equal(inbox.events.length, 0, 'the earlier owner’s delivery is not surfaced');
  assert.equal(inbox.withheld, 1, 'but its existence is counted, not hidden');
  assert.ok(!JSON.stringify(inbox).includes('PROJECT_A_SECRET'));
  await assert.rejects(coop.ack(reborn, { eventId: old.event.eventId, epoch: second.epoch }), e => e.code === 'event_not_delivered');
  await assert.rejects(coop.ack(reborn, { eventId: old.event.eventId, epoch: first.epoch }), e => e.code === 'event_not_delivered');
  // A new event for the new recipient works normally.
  const fresh = await coop.report(grok, report(jobId, { idempotencyKey: 'fresh' }));
  assert.equal((await coop.inbox(reborn, {})).events[0].eventId, fresh.event.eventId);
  assert.equal((await coop.ack(reborn, { eventId: fresh.event.eventId, epoch: second.epoch })).repeated, false);
  // 2. ACK waits for the lock while the operator re-registers the recipient under a new epoch
  // (done inside the held lock, as the operator CLI would under its own lock): the stale epoch is refused.
  const e2 = await coop.report(grok, report(jobId, { idempotencyKey: 'e2' }));
  let release2; const gate2 = new Promise(r => { release2 = r; });
  let third;
  const holding2 = coop.store.lock(async () => { await gate2; const recipients = await coop.store.recipients(); third = { ...recipients['codex-inbox'], epoch: 'feedfacefeedface', createdAt: new Date().toISOString() }; recipients['codex-inbox'] = third; await coop.store.saveRecipients(recipients); });
  await new Promise(r => setTimeout(r, 30));
  const waitingAck = coop.ack(reborn, { eventId: e2.event.eventId, epoch: second.epoch });
  await new Promise(r => setTimeout(r, 30));
  release2(); await holding2;
  await assert.rejects(waitingAck, e => e.code === 'epoch_mismatch');
  // ACK waits while the consumer principal is recreated: the stale request is refused.
  let release3; const gate3 = new Promise(r => { release3 = r; });
  const holding3 = coop.store.lock(() => gate3);
  await new Promise(r => setTimeout(r, 30));
  const e3 = await (async () => { release3(); await holding3; return coop.report(grok, report(jobId, { idempotencyKey: 'e3' })); })();
  let release4; const gate4 = new Promise(r => { release4 = r; });
  const holding4 = coop.store.lock(() => gate4);
  await new Promise(r => setTimeout(r, 30));
  const stale = coop.ack(reborn, { eventId: e3.event.eventId, epoch: third.epoch });
  await new Promise(r => setTimeout(r, 30));
  await principals.remove('codex');
  await principals.create({ id: 'codex', projects: [other], agents: ['codex'], kind: 'codex' });
  release4(); await holding4;
  await assert.rejects(stale, e => e.code === 'permission_denied');
  const receipts = (await new CoopStore({ root: stateRoot }).load()).acks;
  assert.equal([...receipts.keys()].filter(k => k.endsWith(':codex-inbox')).length, 1, 'only the one legitimate receipt exists');
  // 3. A report waits while the reporter's project or agent scope is narrowed: refused, zero events journaled.
  const before = (await new CoopStore({ root: stateRoot }).load()).records.length;
  for (const change of [{ projects: [other] }, { agents: ['codex'] }]) {
    let rel; const g = new Promise(r => { rel = r; });
    const h = coop.store.lock(() => g);
    await new Promise(r => setTimeout(r, 30));
    const waiting = coop.report(grok, report(jobId, { idempotencyKey: `narrow-${Object.keys(change)[0]}` }));
    await new Promise(r => setTimeout(r, 30));
    await principals.update('grok', change);
    rel(); await h;
    await assert.rejects(waiting, e => ['permission_denied', 'task_not_found'].includes(e.code));
    await principals.update('grok', { projects: [project], agents: ['claude', 'codex'] });
  }
  assert.equal((await new CoopStore({ root: stateRoot }).load()).records.length, before, 'nothing was journaled for the narrowed reports');
  assert.equal((await coop.report(grok, report(jobId, { idempotencyKey: 'still-ok' }))).reused, false, 'an unchanged authorized report still succeeds');
});
