import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
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

const row = (type, extra = {}) => JSON.stringify({ type, uuid: `u-${Math.random().toString(36).slice(2)}`, timestamp: '2026-10-22T00:00:00.000Z', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', isSidechain: false, ...extra }) + '\n';
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
  await fs.appendFile(transcript, assistant('msg_2', 'end_turn', { timestamp: '2026-10-22T00:01:00.000Z' }) + assistant('msg_2', 'end_turn', { timestamp: '2026-10-22T00:01:00.100Z' }));
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
  assert.equal(event.payload.providerTimestamp, '2026-10-22T00:01:00.000Z');
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
