import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Orchestrator } from '../src/orchestrator.mjs';
import { PrincipalStore } from '../src/access/principals.mjs';
import { AccessService } from '../src/access/service.mjs';
import { SessionStore, SessionService } from '../src/access/sessions.mjs';
import { CoopService } from '../src/access/coop.mjs';
import { SessionObserver, claudeTranscriptPath } from '../src/access/observer.mjs';
import { fixture, FakeHerdr } from './helpers.mjs';

// Fixture evidence for the native end-turn signal: a transcript file in the Claude Code layout
// (projects/<encoded cwd>/<session>.jsonl) written by the test, a fake pane. No real Claude, no
// real transcript of this host is read.

// Transcript timestamps are relative to the wall clock: the observer treats rows older than its
// baseline as history, so a fixed date would turn into history once the real clock passed it.
const T0 = Date.now() + 3600_000;
const ts = ms => new Date(T0 + ms).toISOString();
const row = (type, extra = {}) => JSON.stringify({ type, uuid: `u-${Math.random().toString(36).slice(2)}`, timestamp: ts(0), sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', isSidechain: false, ...extra }) + '\n';
const assistant = (messageId, stopReason, extra = {}) => row('assistant', { message: { id: messageId, role: 'assistant', stop_reason: stopReason, content: [{ type: 'text', text: 'SECRET BODY NEVER LEAVES' }] }, ...extra });

async function setup(t) {
  const f = await fixture(); t.after(f.remove);
  f.project = await fs.realpath(f.project);
  const claudeHome = path.join(f.base, 'claude-home');
  const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const transcript = claudeTranscriptPath(claudeHome, f.project, sessionId);
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  const orchestrator = new Orchestrator({ stateRoot: f.stateRoot, herdr: new FakeHerdr() });
  const principals = new PrincipalStore({ root: f.stateRoot });
  const grok = (await principals.create({ id: 'grok', projects: [f.project], agents: ['claude'], permissions: { sessions: true }, kind: 'grok' })).principal;
  const codex = (await principals.create({ id: 'codex', projects: [f.project], agents: ['claude'], kind: 'codex' })).principal;
  const access = new AccessService({ root: f.stateRoot, orchestrator, principals, driver: 'inline' });
  const sessions = new SessionStore({ root: f.stateRoot });
  const coop = new CoopService({ root: f.stateRoot, principals, jobs: access.jobs, sessions, orchestrator });
  await coop.store.init();
  await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex', types: ['agent.turn_finished', 'session.ready'] });
  await sessions.create({ id: 'ses-1', bindingId: 'b-1', principalId: 'grok', principalIncarnation: grok.incarnation, label: null, paneId: '%9', target: 'live:0.0', panePid: 1, tmuxSocket: null, agent: { kind: 'claude', pid: 1, startedAt: 'x', comm: 'claude' }, project: f.project, allowKeys: false, messages: [], createdAt: 'x', updatedAt: 'x', providerSession: { kind: 'claude', sessionId, source: 'process_args', transcriptPath: null } });
  const proc = { pid: 1, ppid: 0, pgid: 1, tpgid: 1, stat: 'S+', startedAt: 'x', comm: 'claude', args: `claude --resume ${sessionId}` };
  const pane = { paneId: '%9', target: 'live:0.0', panePid: 1, dead: false, currentCommand: 'claude', currentPath: f.project, historySize: 0 };
  const tmux = { socket: null, screen: ['❯ '], pane: async () => pane, listPanes: async () => [pane], captureScreen: async () => [...tmux.screen], captureHistory: async () => [], sendText: async () => { throw new Error('never'); }, sendKeys: async () => { throw new Error('never'); } };
  const live = new SessionService({ root: f.stateRoot, principals, sessions, tmux, processes: { table: async () => new Map([[1, proc]]), agentUnder: async () => ({ ...proc, kind: 'claude' }), cwd: async () => f.project }, settleMs: 0 });
  const observer = new SessionObserver({ root: f.stateRoot, sessions: live, coop, intervalMs: 1000, claudeHome });
  return { ...f, transcript, sessionId, grok, codex, coop, sessions, tmux, observer, live, claudeHome };
}

test('the native end-turn signal: one agent.turn_finished per provider message id, no history replay, partial tails wait, shrinking resets, screen readiness stays a separate session.ready', async t => {
  const { transcript, codex, coop, tmux, observer, stateRoot } = await setup(t);
  await fs.writeFile(transcript, assistant('msg_old', 'end_turn'));
  let results = await observer.tick();
  assert.equal(results[0].native, 'baseline');
  assert.equal(results[0].emitted, null, 'history before observation started is never replayed');
  await fs.appendFile(transcript, assistant('msg_1', 'tool_use') + assistant('msg_1', 'tool_use') + row('user', {}));
  results = await observer.tick();
  assert.equal(results[0].native, 'read');
  assert.equal(results[0].emitted, null, 'tool_use rows are not turn boundaries, even while the screen looks ready');
  await fs.appendFile(transcript, assistant('msg_2', 'end_turn', { timestamp: ts(60000) }) + assistant('msg_2', 'end_turn', { timestamp: ts(60100) }));
  results = await observer.tick();
  assert.equal(results[0].emitted.length, 1, 'two content rows with one message id are one logical turn');
  const turn = results[0].emitted[0];
  assert.equal(turn.type, 'agent.turn_finished');
  assert.equal(turn.reused, false);
  assert.equal((await observer.tick())[0].emitted, null, 'no repeat on the next poll');
  const inbox = await coop.inbox(codex, {});
  assert.equal(inbox.events.length, 1);
  const event = inbox.events[0];
  assert.equal(event.type, 'agent.turn_finished');
  assert.equal(event.payload.observation, 'native_end_turn');
  assert.equal(event.payload.providerMessageId, 'msg_2');
  assert.equal(event.payload.providerSessionId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(event.payload.providerTimestamp, ts(60000));
  assert.ok(!JSON.stringify(event).includes('SECRET BODY'), 'message bodies never leave the file');
  // A torn tail is left for the next read; completing it emits exactly once.
  const partial = assistant('msg_3', 'end_turn');
  await fs.appendFile(transcript, partial.slice(0, 40));
  results = await observer.tick();
  assert.equal(results[0].native, 'partial');
  assert.equal(results[0].emitted, null);
  await fs.appendFile(transcript, partial.slice(40));
  results = await observer.tick();
  assert.equal(results[0].emitted[0].type, 'agent.turn_finished');
  assert.equal((await coop.inbox(codex, {})).events.filter(e => e.type === 'agent.turn_finished').length, 2);
  // A restart re-derives the same identities and emits nothing new.
  const restarted = new SessionObserver({ root: stateRoot, sessions: observer.sessions, coop, intervalMs: 1000, claudeHome: observer.claudeHome });
  assert.equal((await restarted.tick())[0].emitted, null);
  // A rotated or truncated transcript is an explicit reset, never an invented completion.
  await fs.writeFile(transcript, assistant('msg_rot', 'end_turn'));
  results = await restarted.tick();
  assert.equal(results[0].native, 'reset');
  assert.equal(results[0].emitted, null);
  const state = JSON.parse(await fs.readFile(path.join(stateRoot, 'access', 'coop', 'observations', 'ses-1.json'), 'utf8'));
  assert.equal(state.nativeResets, 1);
  assert.equal((await restarted.tick())[0].native, 'unchanged');
  // Screen working → ready is still reported, as session.ready, labelled as a screen observation.
  tmux.screen = ['✻ Working…']; await restarted.tick();
  tmux.screen = ['❯ '];
  results = await restarted.tick();
  assert.equal(results[0].emitted[0].type, 'session.ready');
  const ready = (await coop.inbox(codex, {})).events.find(e => e.type === 'session.ready');
  assert.equal(ready.payload.observation, 'working_to_ready');
  assert.match(ready.payload.meaning, /Not a provider turn boundary/);
});

test('a missing provider session falls back to screen readiness only, and a missing transcript is reported without inventing a signal', async t => {
  const f = await setup(t);
  await f.sessions.update('ses-1', r => { r.providerSession = null; });
  f.tmux.screen = ['✻ Working…']; await f.observer.tick();
  f.tmux.screen = ['❯ '];
  const results = await f.observer.tick();
  assert.equal(results[0].native, 'unavailable');
  assert.equal(results[0].emitted[0].type, 'session.ready');
  await f.sessions.update('ses-1', r => { r.providerSession = { kind: 'claude', sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', source: 'operator', transcriptPath: null }; });
  const missing = await f.observer.tick();
  assert.equal(missing[0].native, 'missing');
  assert.equal(missing[0].emitted, null);
  assert.equal(SessionService.providerSessionFor({ kind: 'claude', args: 'claude --resume AAAAAAAA-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }).sessionId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(SessionService.providerSessionFor({ kind: 'claude', args: 'claude' }), null);
  assert.equal(SessionService.providerSessionFor({ kind: 'codex', args: 'codex resume x' }), null);
  assert.equal(SessionService.providerSessionFor({ kind: 'claude', args: 'claude' }, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').source, 'operator');
  assert.throws(() => SessionService.providerSessionFor({ kind: 'claude', args: 'claude' }, 'not-a-uuid'), e => e.code === 'invalid_session');
});

test('review regressions: first-pilot observation state migrates without losing pending work or duplicating a committed event, and never becomes native proof', async t => {
  const { coop, codex, grok, tmux, observer, stateRoot } = await setup(t);
  const dir = path.join(stateRoot, 'access', 'coop', 'observations');
  await fs.mkdir(dir, { recursive: true });
  // Fixture 1: an uncommitted old pending screen transition.
  const pendingId = 'a'.repeat(32);
  await fs.writeFile(path.join(dir, 'ses-1.json'), JSON.stringify({ bindingId: 'b-1', lastState: 'idle', lastBusyAt: '2026-10-21T00:00:00.000Z', pendingTransition: { transitionId: pendingId, busyAt: '2026-10-21T00:00:00.000Z', readyAt: '2026-10-21T00:00:05.000Z' }, lastEmittedTransitionId: null, observations: 7 }));
  let results = await observer.tick();
  assert.equal(results[0].emitted.length, 1);
  assert.equal(results[0].emitted[0].type, 'session.ready', 'a legacy screen transition is screen-grade readiness, not native evidence');
  assert.equal(results[0].emitted[0].reused, false);
  const migrated = JSON.parse(await fs.readFile(path.join(dir, 'ses-1.json'), 'utf8'));
  assert.equal(migrated.version, 2); assert.equal(migrated.migratedFrom, 1); assert.deepEqual(migrated.pending, []); assert.ok(migrated.lastEmitted[pendingId]);
  assert.equal(migrated.observations, 8, 'history counters carry over');
  assert.equal((await observer.tick())[0].emitted, null);
  // Fixture 2: an old transition whose event the old pilot already committed under the untyped key.
  const committedId = 'b'.repeat(32);
  const oldKeyHash = crypto.createHash('sha256').update(`observer:b-1:${committedId}`).digest('hex');
  const oldEvent = { schema: 'harnessorbit.coop.event.v1', eventId: 'a63ffda5-3fd3-4a97-9eae-ad1854b46933', seq: 2, createdAt: '2026-10-21T00:01:00.000Z', type: 'agent.turn_finished', source: { principalId: 'grok', incarnation: grok.incarnation, kind: 'orchestrator', via: 'observer', binding: 'b-1', observer: 'harnessorbit' }, task: { ref: 'harnessorbit:session/ses-1', kind: 'session', id: 'ses-1', intentRevision: null }, conversationRef: null, correlationId: null, causationId: null, hop: 0, payload: { observation: 'working_to_ready' }, evidenceRefs: [] };
  const inboxEpoch = (await coop.store.recipients())['codex-inbox'].epoch;
  await coop.store.lock(async () => { const state = await coop.store.open(); await coop.store.appendEvent(state, { v: 1, kind: 'event', seq: 2, event: oldEvent, idempotency: { principalId: 'grok', incarnation: grok.incarnation, keyHash: oldKeyHash, bodyHash: 'legacy' }, deliveries: [{ consumerId: 'codex-inbox', kind: 'inbox', epoch: inboxEpoch, principalId: 'codex', principalIncarnation: codex.incarnation, state: 'pending' }] }); });
  await fs.writeFile(path.join(dir, 'ses-1.json'), JSON.stringify({ bindingId: 'b-1', lastState: 'idle', lastBusyAt: '2026-10-21T00:00:50.000Z', pendingTransition: { transitionId: committedId, busyAt: '2026-10-21T00:00:50.000Z', readyAt: '2026-10-21T00:01:00.000Z' }, lastEmittedTransitionId: pendingId, observations: 9 }));
  const before = (await coop.store.load()).records.length;
  results = await observer.tick();
  assert.equal(results[0].emitted[0].reused, true, 'the committed old event is found by its old identity');
  assert.equal(results[0].emitted[0].eventId, 'a63ffda5-3fd3-4a97-9eae-ad1854b46933');
  assert.equal((await coop.store.load()).records.length, before, 'no duplicate event');
  const inbox = await coop.inbox(codex, {});
  assert.equal(inbox.events.filter(e => e.eventId === 'a63ffda5-3fd3-4a97-9eae-ad1854b46933').length, 1);
  assert.equal(inbox.events.filter(e => e.type === 'agent.turn_finished' && e.payload.observation === 'native_end_turn').length, 0, 'nothing legacy became native proof');
  void tmux;
});

test('review regressions: an oversized complete line is skipped with a recorded count and later turns still arrive', async t => {
  const { transcript, codex, coop, observer, stateRoot } = await setup(t);
  await fs.writeFile(transcript, '');
  assert.equal((await observer.tick())[0].native, 'baseline');
  const huge = JSON.stringify({ type: 'assistant', uuid: 'u-huge', timestamp: ts(1000), sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', isSidechain: false, message: { id: 'msg_huge', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'X'.repeat(8 * 1048576 + 4096) }] } }) + '\n';
  await fs.appendFile(transcript, huge + assistant('msg_after', 'end_turn', { timestamp: ts(2000) }));
  const first = await observer.tick();
  assert.equal(first[0].native, 'skipped_oversized');
  assert.equal(first[0].emitted, null);
  const second = await observer.tick();
  assert.equal(second[0].native, 'read');
  assert.equal(second[0].emitted[0].type, 'agent.turn_finished');
  const state = JSON.parse(await fs.readFile(path.join(stateRoot, 'access', 'coop', 'observations', 'ses-1.json'), 'utf8'));
  assert.equal(state.oversizedSkipped, 1);
  assert.equal((await coop.inbox(codex, {})).events.filter(e => e.payload.providerMessageId === 'msg_after').length, 1);
  assert.equal((await observer.tick())[0].native, 'unchanged');
});

test('review regressions: a same-size replacement is a new source generation (reset), its post-baseline turn is recovered once, and narrowed project or agent scope blocks native emission', async t => {
  const { transcript, codex, coop, observer, stateRoot, sessions, grok, project, base } = await setup(t);
  const principals = new PrincipalStore({ root: stateRoot });
  await fs.writeFile(transcript, assistant('msg_a', 'end_turn', { timestamp: ts(0), pad: 'x'.repeat(200) }));
  assert.equal((await observer.tick())[0].native, 'baseline');
  const baselineSize = (await fs.stat(transcript)).size;
  // Rotate: rename the file away and write a replacement of exactly the same size with a new post-baseline turn.
  await fs.rename(transcript, `${transcript}.old`);
  const exactly = (obj, size) => { let text = ''; for (let padLen = Math.max(0, size - Buffer.byteLength(`${JSON.stringify({ ...obj, pad: '' })}\n`)); padLen >= 0; padLen--) { text = `${JSON.stringify({ ...obj, pad: 'p'.repeat(padLen) })}\n`; if (Buffer.byteLength(text) === size) return text; } throw new Error('cannot pad to size'); };
  await fs.writeFile(transcript, exactly(JSON.parse(assistant('msg_b', 'end_turn', { timestamp: '2099-01-01T00:00:00.000Z' })), baselineSize));
  assert.equal((await fs.stat(transcript)).size, baselineSize, 'same size as the baseline');
  const rotated = await observer.tick();
  assert.equal(rotated[0].native, 'reset', 'a changed inode is a reset, not unchanged');
  assert.equal(rotated[0].emitted?.[0]?.type, 'agent.turn_finished', 'the replacement’s post-baseline turn is recovered');
  const st = JSON.parse(await fs.readFile(path.join(stateRoot, 'access', 'coop', 'observations', 'ses-1.json'), 'utf8'));
  assert.equal(st.nativeResets, 1);
  assert.equal((await observer.tick())[0].native, 'unchanged');
  // A replacement containing only pre-baseline rows emits nothing.
  await fs.rename(transcript, `${transcript}.old2`);
  await fs.writeFile(transcript, assistant('msg_old', 'end_turn', { timestamp: '2000-01-01T00:00:00.000Z' }));
  const historic = await observer.tick();
  assert.equal(historic[0].native, 'reset'); assert.equal(historic[0].emitted, null, 'history before the observation baseline is never emitted');
  // Narrowed scope: project moved away, then agent narrowed; neither lets a native end_turn out.
  const other = path.join(base, 'elsewhere'); await fs.mkdir(other);
  await principals.update('grok', { projects: [other] });
  await fs.appendFile(transcript, assistant('msg_scope1', 'end_turn', { timestamp: '2099-01-02T00:00:00.000Z' }));
  let blocked = await observer.tick();
  assert.equal(blocked[0].emitted[0].error, 'permission_denied');
  await principals.update('grok', { projects: [project], agents: ['codex'] });
  await fs.appendFile(transcript, assistant('msg_scope2', 'end_turn', { timestamp: '2099-01-03T00:00:00.000Z' }));
  blocked = await observer.tick();
  assert.equal(blocked[0].emitted[0].error, 'permission_denied');
  await principals.update('grok', { agents: ['claude'] });
  const events = (await coop.inbox(codex, {})).events.filter(e => e.type === 'agent.turn_finished').map(e => e.payload.providerMessageId);
  assert.deepEqual(events, ['msg_b'], 'only the in-scope recovered turn was emitted');
  void sessions; void grok;
});
