import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Orchestrator } from '../src/orchestrator.mjs';
import { PrincipalStore } from '../src/access/principals.mjs';
import { AccessService } from '../src/access/service.mjs';
import { SessionStore } from '../src/access/sessions.mjs';
import { CoopService } from '../src/access/coop.mjs';
import { Dispatcher, GrokNativeWebhookAdapter, CodexAppServerAdapter, UnixWebSocket, backoffMs } from '../src/access/dispatch.mjs';
import { parseArgs } from '../bin/cao.mjs';
import { fixture, FakeHerdr } from './helpers.mjs';

// Fixture-level evidence for the transport milestone: a fake fetch and a real loopback HTTP server
// stand in for Grok's native routine endpoint; a fake WebSocket-over-Unix-socket runtime stands in
// for the Codex app-server. No real Grok Bot, Codex runtime or model is involved.

const checks = [{ name: 'math', argv: [process.execPath, '--test', 'tests/math.test.mjs'], timeoutMs: 10000 }];
const job = (project, extra = {}) => ({ idempotencyKey: 'req-1', project, objective: 'Fix add to add its two inputs; preserve the existing tests.', context: 'Tests already encode the expected behaviour.', allowedPaths: ['src/math.mjs'], checks, ...extra });
const report = (jobId, extra = {}) => ({ idempotencyKey: 'r-1', type: 'work.reported', task: { ref: `harnessorbit:job/${jobId}` }, payload: { summary: 'add() now adds' }, ...extra });

async function setup(t) {
  const f = await fixture(); t.after(f.remove);
  f.project = await fs.realpath(f.project);
  let ms = Date.parse('2026-10-22T00:00:00.000Z');
  const clock = { now: () => new Date(ms).toISOString(), advance: delta => { ms += delta; } };
  const orchestrator = new Orchestrator({ stateRoot: f.stateRoot, herdr: new FakeHerdr() });
  const principals = new PrincipalStore({ root: f.stateRoot });
  const grok = (await principals.create({ id: 'grok', projects: [f.project], agents: ['claude', 'codex'], kind: 'grok' })).principal;
  const access = new AccessService({ root: f.stateRoot, orchestrator, principals, driver: 'inline' });
  const coop = new CoopService({ root: f.stateRoot, principals, jobs: access.jobs, sessions: new SessionStore({ root: f.stateRoot }), orchestrator, now: clock.now });
  await coop.store.init();
  const jobId = (await access.submit(grok, job(f.project))).job.id;
  const secretFile = path.join(f.base, 'grok.secret');
  await fs.writeFile(secretFile, 'grok_native_secret_123\n', { mode: 0o600 });
  return { ...f, clock, principals, grok, access, coop, jobId, secretFile };
}

// A fetch stand-in: records every call and answers from a script.
function fakeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const step = script.shift() || { status: 200 };
    if (step.abort) return new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
    if (step.throw) throw step.throw;
    return new Response(step.body ?? '', { status: step.status, headers: step.headers || {} });
  };
  return { fn, calls };
}

test('the Grok native-webhook adapter posts a bounded delivery with a bearer secret, follows no redirects, and maps each response to transport state only', async t => {
  const { secretFile } = await setup(t);
  const recipient = { id: 'grok-hook', epoch: 'e1', transport: { endpoint: 'https://hooks.example/orbit', secretFile } };
  const envelope = { eventId: crypto.randomUUID(), type: 'work.reported', payload: { summary: 'x' } };
  const script = [{ status: 202 }, { status: 302, headers: { location: 'https://elsewhere.example' } }, { status: 401 }, { status: 429 }, { status: 503 }, { status: 404 }, { abort: true }, { throw: Object.assign(new Error('connect ECONNREFUSED'), { cause: { code: 'ECONNREFUSED' } }) }];
  const { fn, calls } = fakeFetch(script);
  const adapter = new GrokNativeWebhookAdapter({ fetch: fn, timeoutMs: 300 });
  const accepted = await adapter.deliver(envelope, recipient);
  assert.equal(accepted.outcome, 'accepted');
  assert.match(accepted.meaning, /not an acknowledgement/);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers.authorization, 'Bearer grok_native_secret_123');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.schema, 'harnessorbit.coop.delivery.v1');
  assert.equal(body.deliveryId, `${envelope.eventId}:grok-hook:e1`);
  assert.equal(body.event.eventId, envelope.eventId);
  const redirect = await adapter.deliver(envelope, recipient);
  assert.equal(redirect.outcome, 'failed'); assert.equal(redirect.reason, 'redirect_refused'); assert.equal(redirect.terminal, true);
  assert.equal(calls.length, 2, 'the redirect target was never requested');
  assert.deepEqual([(await adapter.deliver(envelope, recipient)).reason, (await adapter.deliver(envelope, recipient)).reason, (await adapter.deliver(envelope, recipient)).reason], ['unauthorized', 'rate_limited', 'receiver_error']);
  const rejected = await adapter.deliver(envelope, recipient);
  assert.equal(rejected.reason, 'rejected'); assert.equal(rejected.terminal, true);
  const timeout = await adapter.deliver(envelope, recipient);
  assert.equal(timeout.outcome, 'unknown'); assert.equal(timeout.reason, 'timeout');
  const refused = await adapter.deliver(envelope, recipient);
  assert.equal(refused.outcome, 'failed'); assert.equal(refused.reason, 'unreachable');
  for (const r of [accepted, redirect, rejected, timeout, refused]) assert.ok(!JSON.stringify(r).includes('grok_native_secret_123'), 'the secret never appears in outcomes');
  assert.equal((await adapter.deliver(envelope, { ...recipient, transport: { endpoint: 'http://hooks.example/orbit', secretFile } })).reason, 'insecure_endpoint');
  assert.equal((await adapter.deliver(envelope, { ...recipient, transport: { endpoint: 'https://hooks.example/orbit', secretFile: '/nonexistent/secret' } })).outcome, 'deferred');
});

test('on a real loopback receiver the wire format is one JSON POST with the bearer header and the event id headers', async t => {
  const { secretFile } = await setup(t);
  const seen = [];
  const server = http.createServer((req, res) => { let body = ''; req.on('data', c => { body += c; }); req.on('end', () => { seen.push({ headers: req.headers, body: JSON.parse(body) }); res.writeHead(200); res.end('ok'); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const adapter = new GrokNativeWebhookAdapter({ allowHttpLoopback: true, timeoutMs: 2000 });
  const envelope = { eventId: crypto.randomUUID(), type: 'task.blocked', payload: {} };
  const out = await adapter.deliver(envelope, { id: 'hook', epoch: 'e9', transport: { endpoint: `http://127.0.0.1:${server.address().port}/orbit`, secretFile } });
  assert.equal(out.outcome, 'accepted');
  assert.equal(seen[0].headers.authorization, 'Bearer grok_native_secret_123');
  assert.equal(seen[0].headers['x-harnessorbit-event-id'], envelope.eventId);
  assert.equal(seen[0].headers['x-harnessorbit-delivery'], 'hook:e9');
  assert.equal(seen[0].body.event.type, 'task.blocked');
  assert.equal((await new GrokNativeWebhookAdapter({ timeoutMs: 2000 }).deliver(envelope, { id: 'hook', epoch: 'e9', transport: { endpoint: `http://127.0.0.1:${server.address().port}/orbit`, secretFile } })).reason, 'insecure_endpoint', 'plain http is refused unless explicitly allowed for loopback tests');
});

// A fake Codex app-server: WebSocket over a Unix socket, JSON-RPC, scripted thread state.
function fakeCodexRuntime(socketPath, behaviour) {
  const received = [];
  const server = net.createServer(conn => {
    let buf = Buffer.alloc(0); let upgraded = false;
    const sendText = text => { const payload = Buffer.from(text); const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.concat([Buffer.from([0x81, 126]), Buffer.from([payload.length >> 8, payload.length & 0xff])]); conn.write(Buffer.concat([header, payload])); };
    conn.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n'); if (end < 0) return;
        const head = buf.subarray(0, end).toString(); buf = buf.subarray(end + 4);
        if (behaviour.refuseUpgrade) { conn.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n'); return; }
        const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(`${head}\r\n`)[1].trim();
        const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        conn.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        upgraded = true;
      }
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f; const second = buf[1]; const masked = (second & 0x80) !== 0; let len = second & 0x7f; let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const mask = masked ? buf.subarray(off, off + 4) : null; if (masked) off += 4;
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len)); if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buf = buf.subarray(off + len);
        if (opcode === 0x8) { conn.end(); return; }
        if (opcode !== 0x1) continue;
        const message = JSON.parse(payload.toString()); received.push(message);
        const result = behaviour.handle(message);
        if (result === null) continue; // deliberately unanswered
        sendText(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      }
    });
    conn.on('error', () => {});
  });
  return { server, received, listen: () => new Promise(r => server.listen(socketPath, r)), close: () => new Promise(r => server.close(r)) };
}

test('the Codex app-server adapter confirms thread ownership before acting: notLoaded defers as wrong_runtime, an owning runtime gets turn/start with orbit_event tool output, an unconfirmed turn is reconciled before any resend', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-codex-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, 'control.sock');
  const envelope = { eventId: crypto.randomUUID(), type: 'work.reported', payload: { summary: 'x' } };
  const recipient = { id: 'codex-desktop', epoch: 'e1', transport: { socketPath, threadId: 'thread-1' } };
  let mode = 'notLoaded'; const items = [];
  const runtime = fakeCodexRuntime(socketPath, { handle: msg => {
    if (msg.method === 'initialize') return { serverInfo: { name: 'fake-app-server' } };
    if (msg.method === 'thread/read') return mode === 'notLoaded' ? { status: 'notLoaded' } : mode === 'busy' ? { loaded: true, busy: true, items } : mode === 'nestedBusy' ? { thread: { loaded: true, status: 'running', busy: true, items } } : mode === 'vague' ? { id: msg.params.threadId } : { loaded: true, status: 'idle', items };
    if (msg.method === 'turn/start') { const held = { type: 'toolOutput', toolOutput: { name: 'orbit_event', namespace: 'harnessorbit', eventId: msg.params.toolOutput.eventId } }; if (mode === 'silent') { items.push(held); return null; } if (mode === 'emptyTurn') { items.push(held); return {}; } items.push(held); return { turnId: 't-1' }; }
    return {};
  } });
  await runtime.listen(); t.after(() => runtime.close());
  const adapter = new CodexAppServerAdapter({ timeoutMs: 500 });
  const wrong = await adapter.deliver(envelope, recipient);
  assert.equal(wrong.outcome, 'deferred'); assert.equal(wrong.reason, 'wrong_runtime');
  assert.ok(!runtime.received.some(m => m.method === 'turn/start'), 'nothing is started on a runtime that does not own the thread');
  mode = 'vague';
  assert.equal((await adapter.deliver(envelope, recipient)).reason, 'capability_unavailable', 'an ownership answer that does not say loaded/notLoaded is not guessed');
  mode = 'busy';
  assert.equal((await adapter.deliver(envelope, recipient)).reason, 'thread_busy');
  mode = 'nestedBusy';
  assert.equal((await adapter.deliver(envelope, recipient)).reason, 'thread_busy', 'nested thread state is inspected too');
  assert.ok(!runtime.received.some(m => m.method === 'turn/start'), 'a busy thread never gets a turn/start');
  mode = 'emptyTurn';
  const empty = await adapter.deliver({ ...envelope, eventId: crypto.randomUUID() }, recipient);
  assert.equal(empty.outcome, 'unknown', 'an empty turn/start reply is not acceptance evidence');
  assert.equal(empty.reason, 'turn_unconfirmed');
  mode = 'loaded';
  const accepted = await adapter.deliver(envelope, recipient);
  assert.equal(accepted.outcome, 'accepted'); assert.match(accepted.detail, /turn t-1/);
  const start = runtime.received.filter(m => m.method === 'turn/start').at(-1);
  assert.deepEqual(start.params.input, [], 'no human message is spoofed');
  assert.equal(start.params.threadId, 'thread-1');
  assert.equal(start.params.toolOutput.name, 'orbit_event'); assert.equal(start.params.toolOutput.namespace, 'harnessorbit');
  assert.equal(JSON.parse(start.params.toolOutput.output).event.eventId, envelope.eventId);
  mode = 'silent'; items.length = 0;
  const second = { ...envelope, eventId: crypto.randomUUID() };
  const unconfirmed = await adapter.deliver(second, recipient);
  assert.equal(unconfirmed.outcome, 'unknown'); assert.equal(unconfirmed.reason, 'turn_unconfirmed');
  mode = 'loaded';
  assert.equal((await adapter.reconcile(second, recipient)).known, true, 'the runtime already holds the structured orbit_event record; no second turn/start is needed');
  const stranger = crypto.randomUUID();
  items.push({ type: 'userMessage', text: `someone pasted ${stranger} into the chat` });
  assert.equal((await adapter.reconcile({ eventId: stranger }, recipient)).known, false, 'text that merely mentions the UUID is not our structured record');
  mode = 'notLoaded';
  assert.equal((await adapter.reconcile(second, recipient)).known, null, 'the wrong runtime cannot answer');
  mode = 'loaded';
  await runtime.close();
  assert.equal((await adapter.deliver(envelope, recipient)).reason, 'runtime_unavailable');
  const refusing = fakeCodexRuntime(path.join(dir, 'refuse.sock'), { refuseUpgrade: true, handle: () => ({}) });
  await refusing.listen(); t.after(() => refusing.close());
  assert.equal((await adapter.deliver(envelope, { ...recipient, transport: { socketPath: path.join(dir, 'refuse.sock'), threadId: 'thread-1' } })).reason, 'capability_unavailable');
  await assert.rejects(new UnixWebSocket({ socketPath: path.join(dir, 'missing.sock'), timeoutMs: 300 }).connect());
});

test('the dispatcher retries with backoff, dead-letters terminal failures, defers wrong runtimes, revokes expired authority, and reconciles unknown outcomes before resending', async t => {
  const { coop, grok, jobId, principals, clock, secretFile, stateRoot } = await setup(t);
  const hook = await coop.registerRecipient({ id: 'grok-hook', kind: 'grok-native-webhook', endpoint: 'https://hooks.example/orbit', secretFile, types: ['work.reported'] });
  const { fn, calls } = fakeFetch([{ status: 401 }, { status: 401 }, { status: 200 }]);
  const adapters = { 'grok-native-webhook': new GrokNativeWebhookAdapter({ fetch: fn, timeoutMs: 300 }) };
  const dispatcher = new Dispatcher({ root: stateRoot, coop, principals, adapters, maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 60000, now: clock.now, random: () => 0 });
  const e1 = await coop.report(grok, report(jobId));
  let results = await dispatcher.tick();
  assert.deepEqual(results.map(r => [r.outcome, r.reason, r.attempts]), [['failed', 'unauthorized', 1]]);
  assert.equal(results[0].nextAttemptAt, '2026-10-22T00:00:01.000Z', 'backoff base × 2^0 with zero jitter');
  assert.deepEqual((await dispatcher.tick()).map(r => r.outcome), ['waiting'], 'not before nextAttemptAt');
  assert.equal(calls.length, 1);
  clock.advance(1000);
  results = await dispatcher.tick();
  assert.deepEqual([results[0].outcome, results[0].attempts, results[0].nextAttemptAt], ['failed', 2, '2026-10-22T00:00:03.000Z']);
  clock.advance(2000);
  results = await dispatcher.tick();
  assert.equal(results[0].outcome, 'accepted');
  assert.equal((await coop.pendingDeliveries()).length, 0);
  assert.equal((await coop.report(grok, report(jobId))).deliveries[0].state, 'accepted');
  // Terminal failure (redirect) is dead-lettered on the first attempt; the budget is not spent on it.
  const { fn: fn2 } = fakeFetch([{ status: 302, headers: { location: 'https://x' } }]);
  adapters['grok-native-webhook'] = new GrokNativeWebhookAdapter({ fetch: fn2, timeoutMs: 300 });
  await coop.report(grok, report(jobId, { idempotencyKey: 'r-2' }));
  assert.deepEqual((await dispatcher.tick()).map(r => r.outcome), ['dead']);
  // An unknown outcome on a transport without a receipt query is never resent on its own: it stays
  // unresolved for the operator, who can settle it as accepted or authorize exactly one resend.
  const { fn: fn3, calls: calls3 } = fakeFetch([{ abort: true }, { status: 200 }]);
  adapters['grok-native-webhook'] = new GrokNativeWebhookAdapter({ fetch: fn3, timeoutMs: 100 });
  const r3 = await coop.report(grok, report(jobId, { idempotencyKey: 'r-3' }));
  let unresolved = (await dispatcher.tick()).find(x => x.key.endsWith(':grok-hook') && x.outcome !== 'waiting');
  assert.equal(unresolved.outcome, 'unknown');
  for (let i = 0; i < 3; i++) { clock.advance(600000); unresolved = (await dispatcher.tick()).find(x => x.key.endsWith(':grok-hook')); assert.equal(unresolved.outcome, 'unknown'); assert.equal(unresolved.unresolved, true); }
  assert.equal(calls3.length, 1, 'the body was sent exactly once; a stable eventId is not receiver-side deduplication');
  const listed = (await coop.pendingDeliveries()).find(d => d.eventId === r3.event.eventId);
  assert.equal(listed.state, 'unknown'); assert.equal(listed.unresolved, true);
  await assert.rejects(coop.resolveDelivery({ eventId: r3.event.eventId, consumerId: 'grok-hook', as: 'drop' }), e => e.code === 'invalid_event');
  await coop.resolveDelivery({ eventId: r3.event.eventId, consumerId: 'grok-hook', as: 'resend', note: 'operator confirmed nothing arrived' });
  assert.equal((await dispatcher.tick()).find(x => x.key.endsWith(':grok-hook')).outcome, 'accepted');
  assert.equal(calls3.length, 2, 'exactly one authorized resend');
  const { fn: fn3b } = fakeFetch([{ abort: true }]);
  adapters['grok-native-webhook'] = new GrokNativeWebhookAdapter({ fetch: fn3b, timeoutMs: 100 });
  const r3b = await coop.report(grok, report(jobId, { idempotencyKey: 'r-3b' }));
  await dispatcher.tick();
  await coop.resolveDelivery({ eventId: r3b.event.eventId, consumerId: 'grok-hook', as: 'accepted', note: 'seen in the receiver log' });
  assert.equal((await coop.pendingDeliveries()).some(d => d.eventId === r3b.event.eventId), false);
  await assert.rejects(coop.resolveDelivery({ eventId: r3b.event.eventId, consumerId: 'grok-hook', as: 'resend' }), e => e.code === 'delivery_not_unresolved');
  // The in-flight boundary is journaled before the adapter runs: a crash inside deliver leaves `sending`.
  const crashing = { kind: 'grok-native-webhook', canReconcile: false, deliver: async () => { throw Object.assign(new Error('simulated crash'), { code: 'EPIPE' }); } };
  adapters['grok-native-webhook'] = crashing;
  const r3c = await coop.report(grok, report(jobId, { idempotencyKey: 'r-3c' }));
  assert.equal((await dispatcher.tick()).find(x => x.key.endsWith(':grok-hook')).outcome, 'unknown');
  const receipts = (await coop.store.receipts.load()).records.filter(r => r.eventId === r3c.event.eventId);
  assert.deepEqual(receipts.map(r => r.outcome), ['sending', 'unknown'], 'sending was durable before the external call');
  // A recipient without an adapter on this host is deferred, not failed.
  await coop.registerRecipient({ id: 'codex-desktop', kind: 'codex-app-server', socketPath: '/tmp/none.sock', threadId: 'thread-1', types: ['task.blocked'] });
  await coop.report(grok, report(jobId, { idempotencyKey: 'r-4', type: 'task.blocked' }));
  const deferred = (await dispatcher.tick()).find(r => r.key.endsWith(':codex-desktop'));
  assert.equal(deferred.outcome, 'deferred'); assert.equal(deferred.reason, 'no_adapter');
  // Source authority expired before dispatch: the frozen delivery is revoked, the adapter is never called.
  const { fn: fn4, calls: calls4 } = fakeFetch([{ status: 200 }]);
  adapters['grok-native-webhook'] = new GrokNativeWebhookAdapter({ fetch: fn4, timeoutMs: 300 });
  await coop.report(grok, report(jobId, { idempotencyKey: 'r-5' }));
  await principals.update('grok', { agents: ['codex'] });
  clock.advance(120000);
  const revoked = (await dispatcher.tick()).find(r => r.key.endsWith(':grok-hook'));
  assert.equal(revoked.outcome, 'revoked'); assert.equal(revoked.reason, 'permission_denied');
  assert.equal(calls4.length, 0);
  await principals.update('grok', { agents: ['claude', 'codex'] });
  // Recipient epoch changed under a frozen delivery: revoked, never redirected.
  await coop.report(grok, report(jobId, { idempotencyKey: 'r-6' }));
  await coop.revokeRecipient('grok-hook');
  await coop.registerRecipient({ id: 'grok-hook', kind: 'grok-native-webhook', endpoint: 'https://hooks.example/orbit2', secretFile, types: ['work.reported'] });
  const stale = (await dispatcher.tick()).find(r => r.key.endsWith(':grok-hook'));
  assert.equal(stale.outcome, 'revoked');
  assert.equal(calls4.length, 0, 'the new endpoint never received the old payload');
  assert.ok(hook.epoch);
  // Unknown outcome on a transport that can reconcile: the next tick asks first and resends nothing.
  let answer = { known: true };
  const reconciling = { kind: 'codex-app-server', canReconcile: true, delivers: 0, deliver: async () => { reconciling.delivers++; return { outcome: 'unknown', reason: 'turn_unconfirmed' }; }, reconcile: async () => (typeof answer === 'function' ? answer() : answer) };
  const dispatcher2 = new Dispatcher({ root: stateRoot, coop, principals, adapters: { 'codex-app-server': reconciling }, maxAttempts: 3, baseDelayMs: 1000, now: clock.now, random: () => 0 });
  clock.advance(120000);
  const first = (await dispatcher2.tick()).find(r => r.key.endsWith(':codex-desktop'));
  assert.equal(first.outcome, 'unknown');
  clock.advance(5000);
  const second = (await dispatcher2.tick()).find(r => r.key.endsWith(':codex-desktop'));
  assert.equal(second.outcome, 'accepted'); assert.equal(second.reconciled, true);
  assert.equal(reconciling.delivers, 1, 'no second turn/start after reconciliation');
  // known:null keeps the delivery unresolved; nothing is resent.
  await coop.report(grok, report(jobId, { idempotencyKey: 'r-7', type: 'task.blocked' }));
  clock.advance(120000);
  assert.equal((await dispatcher2.tick()).find(r => r.key.endsWith(':codex-desktop')).outcome, 'unknown');
  answer = { known: null, reason: 'wrong_runtime' };
  clock.advance(120000);
  const stuck = (await dispatcher2.tick()).find(r => r.key.endsWith(':codex-desktop'));
  assert.equal(stuck.outcome, 'unknown'); assert.equal(stuck.reason, 'wrong_runtime');
  assert.equal(reconciling.delivers, 2, 'an unanswered reconciliation never authorizes a resend');
  // known:false authorizes one resend, but only after authority is re-read across the await: a recipient
  // re-registered during reconciliation gets nothing.
  answer = async () => { await coop.revokeRecipient('codex-desktop'); await coop.registerRecipient({ id: 'codex-desktop', kind: 'codex-app-server', socketPath: '/tmp/none.sock', threadId: 'thread-3', types: ['task.blocked'] }); return { known: false, reason: 'structured_record_absent' }; };
  clock.advance(120000);
  const raced = (await dispatcher2.tick()).find(r => r.key.endsWith(':codex-desktop'));
  assert.equal(raced.outcome, 'revoked'); assert.equal(raced.reason, 'recipient_epoch_changed');
  assert.equal(reconciling.delivers, 2, 'the re-registered recipient did not receive the old payload');
  // Source scope narrowed during reconciliation is caught the same way.
  await coop.report(grok, report(jobId, { idempotencyKey: 'r-8', type: 'task.blocked' }));
  clock.advance(120000);
  answer = { known: false };
  await dispatcher2.tick(); // first attempt: unknown
  answer = async () => { await principals.update('grok', { agents: ['codex'] }); return { known: false }; };
  clock.advance(120000);
  const narrowed = (await dispatcher2.tick()).find(r => r.key.endsWith(':codex-desktop'));
  assert.equal(narrowed.outcome, 'revoked');
  assert.equal(reconciling.delivers, 3);
  await principals.update('grok', { agents: ['claude', 'codex'] });
  // A clean known:false after an unresolved attempt resends exactly once.
  await coop.report(grok, report(jobId, { idempotencyKey: 'r-9', type: 'task.blocked' }));
  clock.advance(120000); answer = { known: false }; await dispatcher2.tick();
  clock.advance(120000); const resent = (await dispatcher2.tick()).find(r => r.key.endsWith(':codex-desktop'));
  assert.equal(resent.outcome, 'unknown'); assert.equal(reconciling.delivers, 5, 'unresolved → known:false → one resend');
  assert.equal(backoffMs(1, { baseMs: 1000, random: () => 0 }), 1000);
  assert.equal(backoffMs(4, { baseMs: 1000, maxMs: 5000, random: () => 0.5 }), 5000);
});

test('CLI parses the dispatch subcommand', () => {
  assert.equal(parseArgs(['access', 'coop', 'dispatch', '--once', '--allow-http-loopback']).values['allow-http-loopback'], true);
  assert.equal(parseArgs(['access', 'coop', 'dispatch', '--interval-ms', '3000']).command, 'access coop dispatch');
});
