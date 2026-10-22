import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Orchestrator } from '../src/orchestrator.mjs';
import { PrincipalStore } from '../src/access/principals.mjs';
import { AccessService } from '../src/access/service.mjs';
import { SessionStore, SessionService, ProcessInspector, codexRolloutFromOpenFiles, parseCodexRolloutHeader } from '../src/access/sessions.mjs';
import { CoopService } from '../src/access/coop.mjs';
import { SessionObserver } from '../src/access/observer.mjs';
import { fixture, FakeHerdr } from './helpers.mjs';

// Fixture evidence for the Codex CLI native completion adapter. The rollout rows follow the schema
// sampled from a real, owned Codex CLI 0.163.0 session (collaboration review
// codex-native-signal-capture-20261021-234834-619faf): session_meta header, event_msg task_started /
// task_complete with native turn ids, a response_item assistant message with a msg_* id, item and
// token rows. No real Codex runs here; failure and cancellation rows were never sampled and are
// therefore only asserted to be ignored.

const SESSION = '01a160de-aae9-7c90-b909-58f5938585ce';
const OTHER_SESSION = '01a160de-ffff-7c90-b909-000000000000';
const T0 = Date.now() + 3600_000;
const ts = ms => new Date(T0 + ms).toISOString();
const line = obj => `${JSON.stringify(obj)}\n`;
const header = (cwd, id = SESSION) => line({ timestamp: ts(-1000), ordinal: 0, type: 'session_meta', payload: { creator_account_id: 'ACCOUNT_NEVER_COPIED', session_id: id, id, timestamp: ts(-1000), cwd, originator: 'codex-tui', cli_version: '0.163.0', source: 'cli', thread_source: 'cli', model_provider: 'openai', base_instructions: 'SECRET INSTRUCTIONS NEVER COPIED', history_mode: 'paginated' } });
const started = (turnId, ms) => line({ timestamp: ts(ms), ordinal: 1, type: 'event_msg', payload: { type: 'task_started', turn_attribution: { turn_id: turnId, root_turn_id: turnId }, turn_id: turnId, root_turn_id: turnId, started_at: 1792626568, model_context_window: 400000 } });
const context = turnId => line({ timestamp: ts(0), type: 'turn_context', payload: { turn_id: turnId, cwd: '/x', model: 'gpt' } });
const message = (msgId, ms) => line({ timestamp: ts(ms), type: 'response_item', payload: { type: 'message', id: msgId, role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'SECRET MODEL BODY NEVER LEAVES' }] } });
const itemDone = turnId => line({ timestamp: ts(0), type: 'event_msg', payload: { type: 'item_completed', thread_id: SESSION, turn_id: turnId, item: { type: 'agent_message', text: 'SECRET' } } });
const tokens = turnId => line({ timestamp: ts(0), type: 'event_msg', payload: { type: 'token_count', turn_id: turnId, info: { total_token_usage: { input_tokens: 10 } } } });
const complete = (turnId, ms, extra = {}) => line({ timestamp: ts(ms), ordinal: 15, type: 'event_msg', payload: { type: 'task_complete', root_turn_id: turnId, turn_id: turnId, started_at: 1792626568, completed_at: 1792626572, duration_ms: 4356, time_to_first_token_ms: 4215, last_agent_message: 'SECRET LAST MESSAGE NEVER LEAVES', ...extra } });
const TURN_1 = '01a160de-ab82-7df0-8638-a094165c505e', TURN_2 = '01a160e0-8333-7112-9368-cda8ceb8846b';

async function setup(t, { bindNative = true } = {}) {
  const f = await fixture(); t.after(f.remove);
  f.project = await fs.realpath(f.project);
  const codexHome = path.join(f.base, 'codex-home');
  const rollout = path.join(codexHome, 'sessions', '2026', '10', '21', `rollout-2026-10-21T19-49-27-${SESSION}.jsonl`);
  const lock = path.join(codexHome, 'thread-writer-locks', `${SESSION}.lock`);
  await fs.mkdir(path.dirname(rollout), { recursive: true }); await fs.mkdir(path.dirname(lock), { recursive: true });
  await fs.writeFile(lock, '');
  await fs.writeFile(rollout, header(f.project));
  const orchestrator = new Orchestrator({ stateRoot: f.stateRoot, herdr: new FakeHerdr() });
  const principals = new PrincipalStore({ root: f.stateRoot });
  const grok = (await principals.create({ id: 'grok', projects: [f.project], agents: ['codex'], permissions: { sessions: true }, kind: 'grok' })).principal;
  const codex = (await principals.create({ id: 'codex', projects: [f.project], agents: ['codex'], kind: 'codex' })).principal;
  const access = new AccessService({ root: f.stateRoot, orchestrator, principals, driver: 'inline' });
  const sessions = new SessionStore({ root: f.stateRoot });
  const coop = new CoopService({ root: f.stateRoot, principals, jobs: access.jobs, sessions, orchestrator });
  await coop.store.init();
  await coop.registerRecipient({ id: 'codex-inbox', kind: 'inbox', principalId: 'codex', types: ['agent.turn_finished', 'session.ready'] });
  // Process chain under the pane: shell (1) → node entry point (2, the agent process) → native codex binary (3, holds the rollout open).
  const procs = new Map([
    [1, { pid: 1, ppid: 0, pgid: 1, tpgid: 2, stat: 'S', startedAt: 'a', comm: 'zsh', args: '-zsh' }],
    [2, { pid: 2, ppid: 1, pgid: 2, tpgid: 2, stat: 'S+', startedAt: 'b', comm: 'node', args: '/opt/homebrew/bin/node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js --no-daemon' }],
    [3, { pid: 3, ppid: 2, pgid: 2, tpgid: 2, stat: 'S+', startedAt: 'c', comm: 'codex', args: '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex' }],
  ]);
  const openFiles = { 3: [path.join(codexHome, 'state_5.sqlite'), lock, rollout], 2: [], 1: [] };
  const processes = { table: async () => new Map(procs), agentUnder: async () => ({ ...procs.get(2), kind: 'codex', depth: 1 }), cwd: async () => f.project, openFiles: async pid => (openFiles[pid] === undefined ? [] : openFiles[pid]), descendants: (pid, table) => ProcessInspector.prototype.descendants.call(null, pid, table) };
  const pane = { paneId: '%9', target: 'live:0.0', panePid: 1, dead: false, currentCommand: 'node', currentPath: f.project, historySize: 0 };
  const tmux = { socket: null, screen: ['› '], pane: async () => pane, listPanes: async () => [pane], captureScreen: async () => [...tmux.screen], captureHistory: async () => [], sendText: async () => { throw new Error('never'); }, sendKeys: async () => { throw new Error('never'); } };
  const live = new SessionService({ root: f.stateRoot, principals, sessions, tmux, processes, settleMs: 0 });
  let bound = null;
  if (bindNative) bound = await live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1' });
  const observer = new SessionObserver({ root: f.stateRoot, sessions: live, coop, intervalMs: 1000, claudeHome: path.join(f.base, 'claude-home') });
  const observation = async () => JSON.parse(await fs.readFile(path.join(f.stateRoot, 'access', 'coop', 'observations', 'ses-1.json'), 'utf8'));
  const inbox = async () => (await coop.inbox(codex, {})).events;
  return { ...f, rollout, lock, codexHome, grok, codex, coop, sessions, tmux, live, observer, processes, openFiles, bound, observation, inbox, principals };
}

test('bind discovers the Codex native source only from the live process chain: one open rollout with its writer lock and a header naming this session and checkout; every other case is a diagnostic, never a guess', async t => {
  const { live, sessions, bound, rollout, project, openFiles, codexHome, lock } = await setup(t);
  assert.deepEqual(bound.native, { kind: 'codex', sessionId: SESSION, source: 'open_files' });
  const record = await sessions.get('ses-1');
  assert.equal(record.providerSession.kind, 'codex'); assert.equal(record.providerSession.sessionId, SESSION); assert.equal(record.providerSession.transcriptPath, rollout);
  assert.equal(record.providerSession.identity.cliVersion, '0.163.0'); assert.equal(record.providerSession.identity.writerPid, 3);
  assert.ok(!JSON.stringify(record).includes('SECRET') && !JSON.stringify(record).includes('ACCOUNT_NEVER'), 'only identity fields of the header are kept');
  // Operator uuid must match the discovered one; it never replaces discovery.
  await sessions.remove('ses-1');
  assert.deepEqual((await live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1', providerSessionId: SESSION })).native, { kind: 'codex', sessionId: SESSION, source: 'operator+open_files' });
  await sessions.remove('ses-1');
  let r = await live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1', providerSessionId: OTHER_SESSION });
  assert.equal(r.native.status, 'source_unavailable'); assert.equal(r.native.reason, 'operator_session_mismatch'); assert.equal((await sessions.get('ses-1')).providerSession, null);
  const cases = [
    ['no_open_rollout', async () => { openFiles[3] = [lock]; }],
    ['writer_lock_mismatch', async () => { openFiles[3] = [rollout]; }],
    ['ambiguous_rollouts', async () => { const second = path.join(codexHome, 'sessions', '2026', '10', '21', `rollout-x-${OTHER_SESSION}.jsonl`); await fs.writeFile(second, header(project, OTHER_SESSION)); openFiles[3] = [lock, rollout, second]; }],
    ['lsof_unavailable', async () => { for (const k of Object.keys(openFiles)) openFiles[k] = null; }],
    ['header_session_mismatch', async () => { for (const k of [1, 2]) openFiles[k] = []; openFiles[3] = [lock, rollout]; await fs.writeFile(rollout, header(project, OTHER_SESSION)); }],
    ['header_cwd_mismatch', async () => { await fs.writeFile(rollout, header('/somewhere/else')); }],
    ['header_not_session_meta', async () => { await fs.writeFile(rollout, started(TURN_1, 0)); }],
    ['header_incomplete', async () => { await fs.writeFile(rollout, '{"type":"session_meta"'); }],
  ];
  for (const [reason, arrange] of cases) {
    await sessions.remove('ses-1'); await arrange();
    r = await live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1' });
    assert.equal(r.native.status, 'source_unavailable', reason); assert.equal(r.native.reason, reason);
    assert.equal((await sessions.get('ses-1')).providerSession, null); assert.equal((await sessions.get('ses-1')).nativeDiagnostic.reason, reason);
  }
  // A rollout that merely exists under sessions/ but is not held open is never picked.
  await sessions.remove('ses-1'); await fs.writeFile(rollout, header(project)); openFiles[3] = [path.join(codexHome, 'state_5.sqlite')];
  assert.equal((await live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1' })).native.reason, 'no_open_rollout');
  // Pure helpers.
  assert.deepEqual(codexRolloutFromOpenFiles([rollout, lock]), { status: 'ok', transcriptPath: rollout, sessionId: SESSION });
  assert.equal(codexRolloutFromOpenFiles([rollout]).reason, 'writer_lock_mismatch');
  assert.equal(parseCodexRolloutHeader('nope', { sessionId: SESSION }).reason, 'header_unparseable');
  assert.equal(parseCodexRolloutHeader(header(project).trim(), { sessionId: SESSION }).identity.originator, 'codex-tui');
});

test('the observer emits one agent.turn_finished per native task_complete turn id and nothing for starts, messages, items, tokens, duplicates, missing ids or unsampled terminals; no model text leaves the rollout', async t => {
  const { rollout, observer, inbox, observation, codex, coop } = await setup(t);
  // History before observation started is never replayed.
  await fs.appendFile(rollout, started('01a160de-0000-7df0-8638-000000000000', -7_200_000) + complete('01a160de-0000-7df0-8638-000000000000', -7_100_000));
  let results = await observer.tick();
  assert.equal(results[0].native, 'baseline'); assert.equal(results[0].emitted, null);
  await fs.appendFile(rollout, started(TURN_1, 100) + context(TURN_1) + message('msg_abc123', 200) + itemDone(TURN_1) + tokens(TURN_1));
  results = await observer.tick();
  assert.equal(results[0].native, 'read'); assert.equal(results[0].emitted, null, 'a completed assistant message, item or token row is not a turn boundary');
  await fs.appendFile(rollout, complete(TURN_1, 300));
  results = await observer.tick();
  assert.equal(results[0].emitted.length, 1); assert.equal(results[0].emitted[0].type, 'agent.turn_finished'); assert.equal(results[0].emitted[0].reused, false);
  assert.equal((await observer.tick())[0].emitted, null, 'no repeat on the next poll');
  await fs.appendFile(rollout, complete(TURN_1, 300));
  assert.equal((await observer.tick())[0].emitted, null, 'the same terminal record twice is one turn');
  await fs.appendFile(rollout, complete(TURN_2, 400));
  assert.equal((await observer.tick())[0].emitted.length, 1, 'a distinct native turn id is a second turn');
  await fs.appendFile(rollout, complete('', 500) + line({ timestamp: ts(500), type: 'event_msg', payload: { type: 'task_complete', root_turn_id: 'x' } }));
  assert.equal((await observer.tick())[0].emitted, null, 'task_complete without a non-empty turn_id is unsupported, not a turn');
  await fs.appendFile(rollout, line({ timestamp: ts(600), type: 'event_msg', payload: { type: 'turn_aborted', turn_id: TURN_2 } }) + line({ timestamp: ts(600), type: 'event_msg', payload: { type: 'error', message: 'SECRET ERROR' } }));
  assert.equal((await observer.tick())[0].emitted, null, 'unsampled terminal variants never become success');
  assert.equal((await observation()).unverifiedTerminals, 2);
  const events = await inbox();
  assert.deepEqual(events.map(e => [e.type, e.payload.observation, e.payload.provider, e.payload.providerTurnId, e.payload.providerSessionId, e.payload.outcome]), [
    ['agent.turn_finished', 'native_task_complete', 'codex', TURN_1, SESSION, 'completed'],
    ['agent.turn_finished', 'native_task_complete', 'codex', TURN_2, SESSION, 'completed'],
  ]);
  assert.equal(events[0].payload.providerTimestamp, ts(300));
  assert.equal(events[0].payload.providerMessageId, undefined, 'a msg_* id is never presented as a turn id');
  assert.equal(events[0].payload.nativeTerminal, 'event_msg:task_complete');
  assert.ok(!JSON.stringify(events).includes('SECRET') && !JSON.stringify(events).includes('msg_abc123'));
  // The same identity through coop.observe directly is reused, and a Codex signal without a turn id is refused.
  const direct = await coop.observe({ sessionId: 'ses-1', bindingId: (await coop.sessions.get('ses-1')).bindingId, transitionId: SessionObserver.turnId((await coop.sessions.get('ses-1')).bindingId, `codex:${SESSION}:${TURN_1}`), observedAt: 'x', type: 'agent.turn_finished', signal: { source: 'native_task_complete', provider: 'codex', providerSessionId: SESSION, providerTurnId: TURN_1 } });
  assert.equal(direct.reused, true); assert.equal(direct.event.eventId, events[0].eventId);
  await assert.rejects(coop.observe({ sessionId: 'ses-1', bindingId: (await coop.sessions.get('ses-1')).bindingId, transitionId: 'a'.repeat(32), observedAt: 'x', type: 'agent.turn_finished', signal: { source: 'native_task_complete', provider: 'codex', providerSessionId: SESSION, providerTurnId: '  ' } }), e => e.code === 'invalid_event');
  void codex;
});

test('source discipline: a partial tail waits, an oversized line is skipped with a count, a shrunk rollout resets, a replacement with this session’s header is re-validated without replaying history, and a replacement naming another session is a fail-closed mismatch', async t => {
  const { rollout, observer, observation, inbox, project } = await setup(t);
  assert.equal((await observer.tick())[0].native, 'baseline');
  const torn = complete(TURN_1, 100).slice(0, -5);
  await fs.appendFile(rollout, torn);
  assert.equal((await observer.tick())[0].native, 'partial'); assert.equal((await observer.tick())[0].emitted, null);
  await fs.appendFile(rollout, complete(TURN_1, 100).slice(-5));
  assert.equal((await observer.tick())[0].emitted.length, 1, 'completed once the line is whole');
  await fs.appendFile(rollout, line({ timestamp: ts(150), type: 'response_item', payload: { type: 'message', id: 'msg_huge', content: [{ type: 'output_text', text: 'X'.repeat(8 * 1048576 + 1024) }] } }) + complete(TURN_2, 200));
  assert.equal((await observer.tick())[0].native, 'skipped_oversized');
  assert.equal((await observer.tick())[0].emitted[0].type, 'agent.turn_finished'); assert.equal((await observation()).oversizedSkipped, 1);
  // Shrunk: reset, nothing emitted, header still this session.
  await fs.writeFile(rollout, header(project));
  const shrunk = await observer.tick();
  assert.equal(shrunk[0].native, 'reset'); assert.equal(shrunk[0].emitted, null); assert.equal((await observation()).nativeResets, 1);
  // Replacement (new inode) still carrying this session's header: a reset; rows older than the baseline are history, a new turn is emitted once.
  const T3 = '01a160e9-0000-7112-9368-000000000003';
  await fs.rename(rollout, `${rollout}.old`);
  await fs.writeFile(rollout, header(project) + complete('01a160de-0000-7df0-8638-000000000000', -7_200_000) + complete(T3, 900)); // the first row is stamped an hour before observation began
  const replaced = await observer.tick();
  assert.equal(replaced[0].native, 'reset'); assert.equal(replaced[0].emitted.length, 1);
  assert.deepEqual((await inbox()).map(e => e.payload.providerTurnId), [TURN_1, TURN_2, T3]);
  // Replacement naming another session or another checkout: identity mismatch, nothing read, cursor kept, operator rebinds.
  const before = await observation();
  await fs.rename(rollout, `${rollout}.old2`);
  await fs.writeFile(rollout, header(project, OTHER_SESSION) + complete('01a160de-9999-7df0-8638-000000000009', 1000));
  const mismatch = await observer.tick();
  assert.equal(mismatch[0].native, 'source_identity_mismatch:header_session_mismatch'); assert.equal(mismatch[0].emitted, null);
  const after = await observation();
  assert.equal(after.nativeCursor, before.nativeCursor); assert.deepEqual(after.nativeIdentity, before.nativeIdentity); assert.equal(after.nativeMismatch.reason, 'header_session_mismatch');
  await fs.writeFile(rollout, header('/elsewhere') + complete('01a160de-9999-7df0-8638-000000000009', 1000));
  assert.equal((await observer.tick())[0].native, 'source_identity_mismatch:header_cwd_mismatch');
  assert.equal((await inbox()).length, 3, 'no event from a foreign rollout');
  // Review regression (d05a6b7): same inode, truncate and rewrite to an equal or larger final size with a
  // foreign session or foreign cwd header. Neither a new inode nor a shrink is visible; the header is
  // re-verified from the same handle on every incremental read, nothing is consumed, cursor and pending
  // stay, and a legitimate continuation afterwards still works.
  await fs.rename(rollout, `${rollout}.old3`);
  await fs.writeFile(rollout, header(project));
  assert.equal((await observer.tick())[0].native, 'reset');
  await fs.appendFile(rollout, complete('01a160e9-0000-7112-9368-00000000000b', 1100));
  assert.equal((await observer.tick())[0].emitted.length, 1);
  const legit = await fs.readFile(rollout);
  const legitState = await observation();
  for (const [label, foreignHeader] of [['session', header(project, OTHER_SESSION)], ['cwd', header('/elsewhere')]]) {
    for (const pad of [0, 300]) {
      const foreign = complete(`01a160de-7777-7df0-8638-00000000${label === 'session' ? '0a' : '0b'}${pad ? '1' : '0'}`, 1200 + pad, { pad: 'p'.repeat(pad) });
      let rewritten = Buffer.concat([Buffer.from(foreignHeader), Buffer.from(foreign)]);
      if (rewritten.length < legit.length) rewritten = Buffer.concat([Buffer.from(foreignHeader), Buffer.from(complete(`01a160de-7777-7df0-8638-00000000${label === 'session' ? '0a' : '0b'}${pad ? '1' : '0'}`, 1200 + pad, { pad: 'p'.repeat(pad + (legit.length - rewritten.length)) }))]);
      assert.ok(rewritten.length >= legit.length, 'equal or larger than before');
      const inoBefore = (await fs.stat(rollout)).ino;
      await fs.writeFile(rollout, rewritten); // truncate + rewrite in place
      assert.equal((await fs.stat(rollout)).ino, inoBefore, 'same inode');
      const r = await observer.tick();
      assert.equal(r[0].native, `source_identity_mismatch:header_${label}_mismatch`, `${label} pad ${pad}`); assert.equal(r[0].emitted, null);
      const st = await observation();
      assert.equal(st.nativeCursor, legitState.nativeCursor); assert.deepEqual(st.pending, []);
      await fs.writeFile(rollout, legit); // restore the legitimate bytes
      assert.equal((await observer.tick())[0].native, 'unchanged');
    }
  }
  await fs.appendFile(rollout, complete('01a160e9-0000-7112-9368-00000000000c', 1500));
  assert.equal((await observer.tick())[0].emitted.length, 1, 'a legitimate append after the rewrites is read normally');
  assert.deepEqual((await inbox()).map(e => e.payload.providerTurnId).slice(-2), ['01a160e9-0000-7112-9368-00000000000b', '01a160e9-0000-7112-9368-00000000000c']);
  assert.ok(!(await inbox()).some(e => e.payload.providerTurnId.startsWith('01a160de-7777')), 'no foreign record was attributed to this binding');
  // The screen fallback is untouched by native mismatches: still a session.ready on working → ready.
  const { tmux } = await setup(t, { bindNative: false });
  void tmux;
});

test('durability and authority: a transient store failure retries the same identity, a crash between event and state save is reused on restart, a rebind drops the old pending, a narrowed scope or recreated owner blocks emission, and a binding without a native source keeps the screen-grade session.ready', async t => {
  const { rollout, observer, coop, inbox, observation, live, sessions, principals, project, base, stateRoot, tmux } = await setup(t);
  assert.equal((await observer.tick())[0].native, 'baseline');
  await fs.appendFile(rollout, complete(TURN_1, 100));
  const observe = coop.observe.bind(coop); let failures = 0;
  coop.observe = async input => { if (failures++ === 0) { const e = new Error('lock busy'); e.code = 'lock_timeout'; throw e; } return observe(input); };
  const failed = (await observer.tick())[0].emitted[0];
  assert.equal(failed.error, 'lock_timeout'); assert.equal(failed.retry, true);
  const retried = (await observer.tick())[0].emitted[0];
  assert.equal(retried.transitionId, failed.transitionId); assert.equal(retried.reused, false);
  coop.observe = observe;
  // Crash after the event was journaled but before the observation state was saved.
  await fs.appendFile(rollout, complete(TURN_2, 200));
  const bindingId = (await sessions.get('ses-1')).bindingId;
  const expected = SessionObserver.turnId(bindingId, `codex:${SESSION}:${TURN_2}`);
  const direct = await coop.observe({ sessionId: 'ses-1', bindingId, transitionId: expected, observedAt: 'crashed-before-save', type: 'agent.turn_finished', signal: { source: 'native_task_complete', provider: 'codex', providerSessionId: SESSION, providerTurnId: TURN_2 } });
  assert.equal(direct.reused, false);
  const restarted = new SessionObserver({ root: stateRoot, sessions: live, coop, intervalMs: 1000, claudeHome: path.join(base, 'claude-home') });
  const after = (await restarted.tick())[0].emitted[0];
  assert.equal(after.transitionId, expected); assert.equal(after.reused, true, 'the restarted observer re-derives the same turn identity; no second event');
  assert.equal((await inbox()).length, 2);
  // Scope narrowing blocks native emission with permission_denied; restoring resumes.
  const other = path.join(base, 'elsewhere'); await fs.mkdir(other);
  await principals.update('grok', { projects: [other] });
  await fs.appendFile(rollout, complete('01a160e9-0000-7112-9368-000000000003', 300));
  assert.equal((await observer.tick())[0].emitted[0].error, 'permission_denied');
  await principals.update('grok', { projects: [project] });
  // A turn completed while the scope was narrowed is dropped, not deferred: restoring the scope does
  // not resurrect it, and the next turn after restoration is emitted normally.
  assert.equal((await observer.tick())[0].emitted, null);
  await fs.appendFile(rollout, complete('01a160e9-0000-7112-9368-00000000000a', 350));
  assert.equal((await observer.tick())[0].emitted[0].reused, false);
  assert.deepEqual((await inbox()).map(e => e.payload.providerTurnId).slice(-2), [TURN_2, '01a160e9-0000-7112-9368-00000000000a'], 'the dropped turn never reached the inbox');
  // Rebind: a new binding id; a pending signal for the old binding is dropped as session_not_found and nothing from the old pending leaks.
  await fs.appendFile(rollout, complete('01a160e9-0000-7112-9368-000000000004', 400));
  const oldState = await observation();
  await sessions.remove('ses-1');
  const rebound = await live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1' });
  assert.equal(rebound.native.kind, 'codex');
  const fresh = (await observer.tick())[0];
  assert.equal(fresh.native, 'baseline', 'a new binding takes a new baseline; the old pending identity belongs to the old binding');
  assert.notEqual((await observation()).bindingId, oldState.bindingId);
  assert.equal((await inbox()).length, 3);
  // Recreated owner: the binding's incarnation is stale; nothing is emitted.
  await fs.appendFile(rollout, complete('01a160e9-0000-7112-9368-000000000005', 500));
  await principals.remove('grok'); await principals.create({ id: 'grok', projects: [project], agents: ['codex'], permissions: { sessions: true }, kind: 'grok' });
  const stale = (await observer.tick())[0];
  assert.ok(stale.skipped || stale.emitted?.[0]?.error === 'permission_denied', JSON.stringify(stale));
  assert.equal((await inbox()).length, 3);
  // No native source: a codex binding without a discovered rollout still reports screen-grade readiness only.
  const f2 = await setup(t, { bindNative: false });
  f2.openFiles[3] = [];
  const b2 = await f2.live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1' });
  assert.equal(b2.native.status, 'source_unavailable');
  await f2.observer.tick();
  f2.tmux.screen = ['• Working (esc to interrupt)']; await f2.observer.tick();
  f2.tmux.screen = ['› '];
  const ready = (await f2.observer.tick())[0];
  assert.equal(ready.native, 'unavailable:no_open_rollout'); assert.equal(ready.emitted[0].type, 'session.ready');
  assert.deepEqual((await f2.inbox()).map(e => e.type), ['session.ready']);
  void tmux;
});
