import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PrincipalStore } from '../src/access/principals.mjs';
import { SessionService, Tmux, classifyScreen, agentKindOf } from '../src/access/sessions.mjs';
import { AccessService, ACCESS_TOOLS } from '../src/access/service.mjs';
import { startAccessServer } from '../src/access/server.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { parseArgs } from '../bin/cao.mjs';
import { fixture, FakeHerdr } from './helpers.mjs';

// These tests drive real tmux on a private server socket (-L cao-test-…) with fake agents
// that reproduce only the screen markers of Claude Code and Codex. They never touch the
// operator's tmux server. A real model is not involved; see docs/access.md for what that
// validation would add.
const HAVE_TMUX = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'pipe' }); return true; } catch { return false; } })();
const FIXTURE_BIN = path.resolve('tests/fixtures/live-agents/bin');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, { timeoutMs = 8000, every = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) { last = await fn(); if (last) return last; await sleep(every); }
  throw new Error(`condition not met in ${timeoutMs} ms (last: ${JSON.stringify(last)})`);
}

async function live(t, { kind = 'claude', busyMs = 900, shellOnly = false } = {}) {
  const f = await fixture(); t.after(f.remove);
  f.project = await fs.realpath(f.project);
  const socket = `cao-test-${crypto.randomBytes(4).toString('hex')}`;
  const tmux = new Tmux({ socket });
  const command = shellOnly ? ['sh'] : [process.execPath, path.join(FIXTURE_BIN, `${kind}.mjs`)];
  execFileSync('tmux', ['-L', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'live', '-x', '140', '-y', '40', '-c', f.project, '-e', `FAKE_BUSY_MS=${busyMs}`, command.join(' ')], { stdio: 'pipe' });
  t.after(() => { try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'pipe' }); } catch { /* already gone */ } });
  const pane = (await tmux.listPanes())[0];
  if (!shellOnly) await waitFor(async () => classifyScreen(kind, await tmux.captureScreen(pane.paneId)).state === 'idle');
  const principals = new PrincipalStore({ root: f.stateRoot });
  const { principal } = await principals.create({ id: 'grok', projects: [f.project], agents: ['claude', 'codex'], permissions: { sessions: true } });
  const service = new SessionService({ root: f.stateRoot, principals, tmux, settleMs: 4000 });
  return { ...f, socket, tmux, pane, principals, principal, service, kind };
}

test('classifyScreen tells idle, draft, busy, waiting and unknown apart for both agents', () => {
  assert.equal(classifyScreen('claude', ['⏺ done', '─────', '❯ ', '─────', '  ➜  repo | ctx 1%']).state, 'idle');
  assert.equal(classifyScreen('claude', ['─────', '❯ half a message typed by the operator', '─────']).state, 'draft');
  assert.equal(classifyScreen('claude', ['❯ fix it', '✻ Brewing… (esc to interrupt)']).state, 'busy');
  assert.equal(classifyScreen('claude', ['Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel']).state, 'waiting_input');
  assert.equal(classifyScreen('claude', ['Welcome to Claude Code', 'Security notes:', 'Press Enter to continue']).state, 'waiting_input');
  assert.equal(classifyScreen('claude', ['some log line', 'another']).state, 'unknown', 'no marker is never idle');
  assert.equal(classifyScreen('codex', ['› ', '  codex | tokens 1']).state, 'idle');
  assert.equal(classifyScreen('codex', ['› Ask Codex to do anything']).state, 'idle', 'placeholder counts as empty');
  assert.equal(classifyScreen('codex', ['› draft text']).state, 'draft');
  assert.equal(classifyScreen('codex', ['• Working (esc to interrupt)']).state, 'busy');
  assert.equal(classifyScreen('codex', ['Allow command? [y/n]']).state, 'waiting_input');
  assert.equal(classifyScreen('pi', ['>']).state, 'unknown');
});

test('agentKindOf recognises the agents and refuses shells', () => {
  assert.equal(agentKindOf({ comm: 'claude', args: 'claude' }), 'claude');
  assert.equal(agentKindOf({ comm: '/opt/homebrew/lib/node_modules/@openai/codex/vendor/bin/codex', args: 'codex' }), 'codex');
  assert.equal(agentKindOf({ comm: 'node', args: `node ${FIXTURE_BIN}/claude.mjs` }), 'claude');
  assert.equal(agentKindOf({ comm: 'node', args: `node ${FIXTURE_BIN}/codex.mjs` }), 'codex');
  assert.equal(agentKindOf({ comm: '/bin/zsh', args: '-zsh' }), 'shell');
  assert.equal(agentKindOf({ comm: 'node', args: 'node server.mjs' }), 'other');
});

test('CLI parses the session and memory subcommands', () => {
  assert.equal(parseArgs(['access', 'session', 'bind', '--principal', 'grok', '--pane', '%3', '--allow-keys']).command, 'access session bind');
  assert.equal(parseArgs(['access', 'session', 'send', '--principal', 'grok', '--session', 's', '--key', 'k', '--text', 'hi']).values.key, 'k');
  assert.equal(parseArgs(['access', 'principal', 'update', '--id', 'grok', '--allow-sessions']).values['allow-sessions'], true);
  assert.throws(() => parseArgs(['access', 'session', 'read', '--principal', 'grok', '--session', 's', '--bogus']), e => e.code === 'invalid_arguments');
});

test('a bound Claude session is continued: idle → send → busy → reply, with idempotent and incremental reads', { skip: !HAVE_TMUX && 'tmux not installed' }, async t => {
  const { service, principal, principals, pane, project, stateRoot } = await live(t);
  const denied = (await principals.create({ id: 'dot', projects: [project], agents: ['claude'] })).principal;
  await assert.rejects(service.list(denied), e => e.code === 'permission_denied', 'submit permission does not imply sessions');
  await assert.rejects(service.bind({ principalId: 'dot', pane: pane.paneId }), e => e.code === 'permission_denied');
  const bound = await service.bind({ principalId: principal.id, pane: pane.paneId, id: 'claude-main', label: 'main session' });
  assert.equal(bound.session.agent, 'claude');
  assert.equal(bound.session.project, project);
  assert.equal(bound.session.allowKeys, false);
  await assert.rejects(service.bind({ principalId: principal.id, pane: pane.paneId }), e => e.code === 'pane_already_bound');
  const listed = await service.list(principal);
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].identity.ok, true);
  const status = await service.status(principal, { sessionId: 'claude-main' });
  assert.equal(status.state, 'idle');
  assert.equal(status.next_action, 'send');
  assert.equal(status.verification, 'none');

  const sent = await service.send(principal, { sessionId: 'claude-main', idempotencyKey: 'm1', text: 'hello from grok' });
  assert.equal(sent.message.outcome, 'sent');
  assert.equal(sent.message.reused, false);
  assert.equal(sent.message.text, undefined, 'the message body is never stored');
  await assert.rejects(service.send(principal, { sessionId: 'claude-main', idempotencyKey: 'm2', text: 'too soon' }), e => e.code === 'session_busy');
  const again = await service.send(principal, { sessionId: 'claude-main', idempotencyKey: 'm1', text: 'hello from grok' });
  assert.equal(again.message.reused, true);
  await assert.rejects(service.send(principal, { sessionId: 'claude-main', idempotencyKey: 'm1', text: 'different body' }), e => e.code === 'idempotency_conflict');

  const first = await waitFor(async () => { const r = await service.read(principal, { sessionId: 'claude-main' }); return r.state === 'idle' && r.lines.some(l => l.includes('reply(claude): hello from grok')) ? r : null; });
  assert.equal(first.completion.promptReady, true);
  assert.equal(first.completion.executionFinished, 'unknown', 'idle is prompt-ready, never proof of completion');
  assert.equal(first.completion.verified, false);
  assert.equal(first.lastMessage.outcome, 'sent');
  const second = await service.read(principal, { sessionId: 'claude-main', cursor: first.cursor });
  assert.deepEqual(second.lines, [], 'nothing new after the cursor');
  assert.equal(second.reset, false);
  assert.equal(second.cursor, first.cursor);

  const record = JSON.parse(await fs.readFile(path.join(stateRoot, 'access', 'sessions', 'claude-main.json'), 'utf8'));
  assert.equal(record.messages.length, 1);
  assert.ok(!JSON.stringify(record).includes('hello from grok'), 'the binding record holds hashes, not text');
});

test('a Codex session shows its own markers and the same contract', { skip: !HAVE_TMUX && 'tmux not installed' }, async t => {
  const { service, principal, pane } = await live(t, { kind: 'codex' });
  const bound = await service.bind({ principalId: principal.id, pane: pane.paneId, id: 'codex-main' });
  assert.equal(bound.session.agent, 'codex');
  assert.equal((await service.status(principal, { sessionId: 'codex-main' })).state, 'idle');
  const sent = await service.send(principal, { sessionId: 'codex-main', idempotencyKey: 'c1', text: 'rename the helper' });
  assert.equal(sent.message.outcome, 'sent');
  const done = await waitFor(async () => { const r = await service.read(principal, { sessionId: 'codex-main' }); return r.lines.some(l => l.includes('reply(codex): rename the helper')) ? r : null; });
  assert.ok(done.lines.some(l => /›\s*rename the helper/.test(l)), 'the Codex echo marker is recorded');
});

test('incremental reads page a long reply in order without loss or repeats, and a foreign cursor resets', { skip: !HAVE_TMUX && 'tmux not installed' }, async t => {
  const { service, principal, pane } = await live(t, { busyMs: 300 });
  await service.bind({ principalId: principal.id, pane: pane.paneId, id: 's' });
  const before = await service.read(principal, { sessionId: 's' });
  await service.send(principal, { sessionId: 's', idempotencyKey: 'spam', text: 'spam 300' });
  await waitFor(async () => (await service.status(principal, { sessionId: 's' })).state === 'idle');
  const seen = []; let cursor = before.cursor; let page; let pages = 0;
  do { page = await service.read(principal, { sessionId: 's', cursor, maxLines: 50 }); seen.push(...page.lines); cursor = page.cursor; pages++; } while (page.more && pages < 20);
  assert.ok(pages >= 6, `paged in ${pages} reads`);
  const numbered = seen.filter(l => /^line \d+ of 300 for claude$/.test(l)).map(l => Number(/^line (\d+)/.exec(l)[1]));
  assert.equal(numbered.length, 300);
  assert.deepEqual(numbered, Array.from({ length: 300 }, (_, i) => i + 1));
  const foreign = Buffer.from(JSON.stringify({ v: 1, n: 3, a: ['0000000000000000', '1111111111111111', '2222222222222222'] })).toString('base64url');
  const reset = await service.read(principal, { sessionId: 's', cursor: foreign, maxLines: 20 });
  assert.equal(reset.reset, true);
  assert.equal(reset.lines.length, 20, 'a reset returns the tail, bounded');
  await assert.rejects(service.read(principal, { sessionId: 's', cursor: 'not-a-cursor' }), e => e.code === 'invalid_cursor');
  await assert.rejects(service.read(principal, { sessionId: 's', maxLines: 0 }), e => e.code === 'invalid_message');
});

test('a prompt waiting for input refuses text, and keys only with an explicit binding allowance', { skip: !HAVE_TMUX && 'tmux not installed' }, async t => {
  const { service, principal, pane, tmux } = await live(t);
  await service.bind({ principalId: principal.id, pane: pane.paneId, id: 'nokeys' });
  await service.send(principal, { sessionId: 'nokeys', idempotencyKey: 'b1', text: 'block' });
  const waiting = await waitFor(async () => { const s = await service.status(principal, { sessionId: 'nokeys' }); return s.state === 'waiting_input' ? s : null; });
  assert.equal(waiting.next_action, 'operator');
  await assert.rejects(service.send(principal, { sessionId: 'nokeys', idempotencyKey: 'b2', text: 'yes please' }), e => e.code === 'session_waiting_input');
  await assert.rejects(service.send(principal, { sessionId: 'nokeys', idempotencyKey: 'b3', keys: ['y'] }), e => e.code === 'keys_not_allowed', 'no approval keys without operator allowance');
  // Re-bind with keys allowed and answer the prompt.
  await service.unbind(principal, { sessionId: 'nokeys' });
  await service.bind({ principalId: principal.id, pane: pane.paneId, id: 'keys', allowKeys: true });
  await assert.rejects(service.send(principal, { sessionId: 'keys', idempotencyKey: 'b4', keys: ['rm -rf'] }), e => e.code === 'invalid_message');
  const answered = await service.send(principal, { sessionId: 'keys', idempotencyKey: 'b5', keys: ['y'] });
  assert.equal(answered.message.outcome, 'sent');
  assert.equal(answered.message.confirmedBy, 'prompt_cleared');
  assert.equal((await service.status(principal, { sessionId: 'keys' })).state, 'idle');
  await assert.rejects(service.send(principal, { sessionId: 'keys', idempotencyKey: 'b6', keys: ['Enter'] }), e => e.code === 'keys_not_applicable', 'keys only while a prompt is showing');
  // Operator-typed draft text blocks sends until cleared.
  await tmux.sendKeys(pane.paneId, ['-l', 'half typed']);
  await waitFor(async () => (await service.status(principal, { sessionId: 'keys' })).state === 'draft');
  await assert.rejects(service.send(principal, { sessionId: 'keys', idempotencyKey: 'b7', text: 'over the draft' }), e => e.code === 'session_draft');
});

test('identity changes are refused: exited agent, replaced pane process, shell pane, unverifiable cwd', { skip: !HAVE_TMUX && 'tmux not installed' }, async t => {
  const { service, principal, pane, tmux, socket } = await live(t);
  await service.bind({ principalId: principal.id, pane: pane.paneId, id: 's' });
  // Replace the agent with a shell in the same pane: pane_pid changes, the agent is gone.
  execFileSync('tmux', ['-L', socket, 'respawn-pane', '-k', '-t', pane.paneId, 'sh'], { stdio: 'pipe' });
  await sleep(300);
  await assert.rejects(service.send(principal, { sessionId: 's', idempotencyKey: 'x', text: 'to the shell?' }), e => ['session_replaced', 'session_exited', 'session_gone'].includes(e.code));
  const list = await service.list(principal);
  assert.equal(list.sessions[0].identity.ok, false);
  assert.equal(list.sessions[0].next_action, 'operator');
  await assert.rejects(service.bind({ principalId: principal.id, pane: pane.paneId, id: 'shell' }), e => e.code === 'not_an_agent_pane', 'a shell pane cannot be bound');
  await service.unbind(principal, { sessionId: 's' });
  // A bound agent whose cwd cannot be verified fails closed.
  const strict = new SessionService({ root: service.root, principals: service.principals, tmux, settleMs: 1000, processes: Object.assign(Object.create(Object.getPrototypeOf(service.processes)), service.processes, { cwd: async () => null }) });
  execFileSync('tmux', ['-L', socket, 'respawn-pane', '-k', '-t', pane.paneId, `${process.execPath} ${path.join(FIXTURE_BIN, 'claude.mjs')}`], { stdio: 'pipe' });
  await waitFor(async () => classifyScreen('claude', await tmux.captureScreen(pane.paneId)).state === 'idle');
  await service.bind({ principalId: principal.id, pane: pane.paneId, id: 'again' });
  await assert.rejects(strict.send(principal, { sessionId: 'again', idempotencyKey: 'y', text: 'hi' }), e => e.code === 'session_unverified');
  // The session itself is gone once the pane is killed.
  execFileSync('tmux', ['-L', socket, 'kill-pane', '-t', pane.paneId], { stdio: 'pipe' });
  await assert.rejects(service.status(principal, { sessionId: 'again' }).catch(e => { throw e; }), e => ['session_gone', 'tmux_failed'].includes(e.code));
});

test('ownership, revocation and concurrency: another principal cannot touch the session, revoked permission stops sends, parallel sends serialize', { skip: !HAVE_TMUX && 'tmux not installed' }, async t => {
  const { service, principal, principals, pane, project } = await live(t, { busyMs: 1200 });
  const other = (await principals.create({ id: 'dot', projects: [project], agents: ['claude'], permissions: { sessions: true } })).principal;
  await service.bind({ principalId: principal.id, pane: pane.paneId, id: 's' });
  await assert.rejects(service.status(other, { sessionId: 's' }), e => e.code === 'session_not_found');
  await assert.rejects(service.send(other, { sessionId: 's', idempotencyKey: 'o1', text: 'mine now' }), e => e.code === 'session_not_found');
  await assert.rejects(service.unbind(other, { sessionId: 's' }), e => e.code === 'session_not_found');
  const results = await Promise.allSettled([
    service.send(principal, { sessionId: 's', idempotencyKey: 'p1', text: 'first' }),
    service.send(principal, { sessionId: 's', idempotencyKey: 'p2', text: 'second' }),
  ]);
  const sent = results.filter(r => r.status === 'fulfilled');
  const busy = results.filter(r => r.status === 'rejected');
  assert.equal(sent.length, 1, 'exactly one parallel send goes through');
  assert.equal(busy[0].reason.code, 'session_busy');
  await waitFor(async () => (await service.status(principal, { sessionId: 's' })).state === 'idle');
  await principals.update(principal.id, { permissions: { sessions: false } });
  await assert.rejects(service.send(principal, { sessionId: 's', idempotencyKey: 'p3', text: 'after revoke' }), e => e.code === 'permission_denied', 'the stale principal object does not help');
  await principals.update(principal.id, { permissions: { sessions: true } });
  assert.equal((await service.send(principal, { sessionId: 's', idempotencyKey: 'p3', text: 'after regrant' })).message.outcome, 'sent');
});

test('MCP serves the session tools with audit lines that carry the session id but never the text', { skip: !HAVE_TMUX && 'tmux not installed' }, async t => {
  const f = await live(t);
  const orchestrator = new Orchestrator({ stateRoot: f.stateRoot, herdr: new FakeHerdr() });
  const access = new AccessService({ root: f.stateRoot, orchestrator, principals: f.principals, driver: 'inline' });
  const token = (await f.principals.create({ id: 'mcp', projects: [f.project], agents: ['claude'], permissions: { sessions: true } })).token;
  await f.service.bind({ principalId: 'mcp', pane: f.pane.paneId, id: 'live' });
  const started = await startAccessServer({ service: access, sessions: f.service, toolTimeoutMs: 15000 });
  t.after(started.close);
  const call = async (id, name, args = {}) => (await (await fetch(started.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
  const list = await (await fetch(started.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }) })).json();
  assert.deepEqual(list.result.tools.map(tool => tool.name), [...ACCESS_TOOLS]);
  const sessions = await call(1, 'sessions');
  assert.equal(sessions.structuredContent.sessions[0].session.id, 'live');
  const sent = await call(2, 'session_send', { sessionId: 'live', idempotencyKey: 'k1', text: 'secret phrase quokka' });
  assert.equal(sent.isError, false);
  assert.equal(sent.structuredContent.message.outcome, 'sent');
  const read = await call(3, 'session_read', { sessionId: 'live', maxLines: 50 });
  assert.equal(read.isError, false);
  assert.equal(read.structuredContent.completion.verified, false);
  const unbound = await call(4, 'session_unbind', { sessionId: 'live' });
  assert.equal(unbound.structuredContent.removed, true);
  const audit = await fs.readFile(path.join(f.stateRoot, 'access', 'audit.jsonl'), 'utf8');
  const lines = audit.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(l => l.tool), ['sessions', 'session_send', 'session_read', 'session_unbind']);
  assert.ok(lines.slice(1).every(l => l.sessionId === 'live'));
  assert.ok(!audit.includes('quokka'), 'audit never carries message text');
  assert.ok(!audit.includes(token));
  // Without a session service the tools report unavailable instead of pretending.
  const bare = await startAccessServer({ service: access, toolTimeoutMs: 5000 });
  t.after(bare.close);
  const none = await (await fetch(bare.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'sessions', arguments: {} } }) })).json();
  assert.equal(none.result.structuredContent.code, 'sessions_unavailable');
});

// Review regressions (no tmux): a fake pane whose screen the test scripts, with a stable process
// identity, so authorization and locking can be exercised deterministically.
function fakePane(project) {
  const proc = { pid: 101, ppid: 1, pgid: 101, tpgid: 101, stat: 'S+', startedAt: 'stable-start', comm: 'claude', args: 'claude' };
  const pane = { paneId: '%98', target: 'fake:0.0', panePid: 101, dead: false, currentCommand: 'claude', currentPath: project, historySize: 1 };
  const tmux = {
    socket: 'fake-only', screen: ['❯ '], sent: [], beforeCapture: null,
    pane: async () => pane, listPanes: async () => [pane],
    async captureScreen() { if (this.beforeCapture) { const f = this.beforeCapture; this.beforeCapture = null; await f(); } return [...this.screen]; },
    captureHistory: async () => ['ARTIFICIAL_TRANSCRIPT_A'],
    async sendText(paneId, text) { this.sent.push({ paneId, text }); this.screen = [`> ${text}`, '❯ ']; },
    sendKeys: async () => { throw new Error('never use keys'); },
  };
  const processes = { table: async () => new Map([[101, proc]]), agentUnder: async () => ({ ...proc, kind: 'claude' }), process: async () => proc, cwd: async () => project };
  return { tmux, processes, pane };
}

test('review regressions: spinner glyphs and real drafts are never idle', () => {
  assert.equal(classifyScreen('claude', ['✽ Working…', '❯ ']).state, 'busy');
  assert.equal(classifyScreen('claude', ['⠋ Thinking…', '❯ ']).state, 'busy');
  assert.equal(classifyScreen('claude', ['❯ Type a migration that renames account_id']).state, 'draft');
  assert.equal(classifyScreen('codex', ['› Type a migration that renames account_id']).state, 'draft');
  assert.equal(classifyScreen('codex', ['› Ask Codex to do anything']).state, 'idle');
  assert.equal(classifyScreen('claude', ['❯ Try "fix the failing test"']).state, 'idle');
  assert.equal(classifyScreen('claude', ['❯ / for commands']).state, 'draft', 'anything not known to be a placeholder fails closed');
});

test('review regressions: every session tool re-checks the principal’s current project and agent scope, and a recreated principal id is a stranger', async t => {
  const f = await fixture(); t.after(f.remove);
  const projectA = await fs.realpath(f.project);
  const projectB = await fs.realpath(await fs.mkdtemp(path.join(f.base, 'B-')));
  const principals = new PrincipalStore({ root: f.stateRoot });
  let created = await principals.create({ id: 'review', projects: [projectA], agents: ['claude', 'codex'], permissions: { sessions: true } });
  const { tmux, processes, pane } = fakePane(projectA);
  const sessions = new SessionService({ root: f.stateRoot, principals, tmux, processes, settleMs: 0 });
  await sessions.bind({ principalId: 'review', pane: pane.paneId, id: 'bound' });
  const orchestrator = new Orchestrator({ stateRoot: f.stateRoot, herdr: new FakeHerdr() });
  const access = new AccessService({ root: f.stateRoot, orchestrator, principals, driver: 'inline' });
  const started = await startAccessServer({ service: access, sessions, toolTimeoutMs: 5000 });
  t.after(started.close);
  const call = async (token, name, args = {}) => (await (await fetch(started.endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()).result;
  assert.equal((await call(created.token, 'session_status', { sessionId: 'bound' })).structuredContent.state, 'idle');
  await principals.update('review', { agents: ['codex'] });
  const sent = await call(created.token, 'session_send', { sessionId: 'bound', idempotencyKey: 'after-agent-change', text: 'artificial-send' });
  assert.equal(sent.isError, true);
  assert.equal(sent.structuredContent.code, 'agent_not_allowed');
  assert.equal(tmux.sent.length, 0, 'nothing reaches the pane after the agent scope changed');
  await principals.update('review', { agents: ['claude', 'codex'], projects: [projectB] });
  const listed = (await call(created.token, 'sessions')).structuredContent.sessions;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].authorized, false);
  assert.equal(listed[0].session.project, undefined, 'an out-of-scope binding reveals no checkout');
  for (const tool of ['session_status', 'session_read']) {
    const r = await call(created.token, tool, { sessionId: 'bound' });
    assert.equal(r.isError, true, tool);
    assert.equal(r.structuredContent.code, 'project_not_allowed');
    assert.equal(r.structuredContent.lines, undefined);
  }
  await principals.update('review', { projects: [projectA] });
  assert.equal((await call(created.token, 'session_read', { sessionId: 'bound' })).isError, false, 'scope restored, access restored');
  await principals.remove('review');
  created = await principals.create({ id: 'review', projects: [projectA], agents: ['claude'], permissions: { sessions: true } });
  assert.equal((await call(created.token, 'sessions')).structuredContent.sessions.length, 0, 'the new incarnation sees no bindings of the old one');
  const stranger = await call(created.token, 'session_send', { sessionId: 'bound', idempotencyKey: 'k2', text: 'x' });
  assert.equal(stranger.structuredContent.code, 'session_not_found');
  assert.equal(tmux.sent.length, 0);
});

test('review regressions: operator unbind and a rebind serialize with an in-flight send; nothing crosses bindings', async t => {
  const f = await fixture(); t.after(f.remove);
  const project = await fs.realpath(f.project);
  const principals = new PrincipalStore({ root: f.stateRoot });
  const p = (await principals.create({ id: 'review', projects: [project], agents: ['claude'], permissions: { sessions: true } })).principal;
  await principals.create({ id: 'next', projects: [project], agents: ['claude'], permissions: { sessions: true } });
  const { tmux, processes, pane } = fakePane(project);
  const sessions = new SessionService({ root: f.stateRoot, principals, tmux, processes, settleMs: 0 });
  await sessions.bind({ principalId: 'review', pane: pane.paneId, id: 'bound' });
  let signal; let release;
  const captured = new Promise(r => { signal = r; }); const gate = new Promise(r => { release = r; });
  tmux.beforeCapture = async () => { signal(); await gate; };
  const inFlight = sessions.send(p, { sessionId: 'bound', idempotencyKey: 'racing', text: 'old-principal-payload' });
  await captured;
  let unbound = false;
  const unbinding = sessions.unbindAsOperator('bound').then(result => { unbound = true; return result; });
  await new Promise(r => setTimeout(r, 150));
  assert.equal(unbound, false, 'operator unbind waits behind the in-flight send');
  release();
  const outcome = await inFlight;
  assert.equal(outcome.message.outcome, 'sent');
  assert.equal(outcome.session.principalId, 'review');
  assert.equal(await unbinding, true);
  const rebound = await sessions.bind({ principalId: 'next', pane: pane.paneId, id: 'bound' });
  assert.equal(rebound.session.principalId, 'next');
  assert.equal(rebound.session.messages, 0, 'the new binding starts without the old principal’s messages');
  await assert.rejects(sessions.send(p, { sessionId: 'bound', idempotencyKey: 'again', text: 'stale' }), e => e.code === 'session_not_found');
  assert.equal(tmux.sent.length, 1, 'exactly one message ever reached the pane');
});

test('review regressions: a request authenticated before the principal id was recreated cannot act on the new binding', async t => {
  assert.equal(classifyScreen('claude', ['earlier transcript line', '✽ Working…', '❯ ']).state, 'busy', 'the spinner is recognised on any row');
  const f = await fixture(); t.after(f.remove);
  const project = await fs.realpath(f.project);
  const principals = new PrincipalStore({ root: f.stateRoot });
  const old = (await principals.create({ id: 'review', projects: [project], agents: ['claude'], permissions: { sessions: true } })).principal;
  const { tmux, processes, pane } = fakePane(project);
  const sessions = new SessionService({ root: f.stateRoot, principals, tmux, processes, settleMs: 0 });
  await sessions.bind({ principalId: 'review', pane: pane.paneId, id: 'bound' });
  // The old request already passed authentication (it holds the old principal snapshot). Before it
  // acts, the operator removes the id, recreates it and binds the same pane under the same session id.
  await sessions.unbindAsOperator('bound');
  await principals.remove('review');
  await principals.create({ id: 'review', projects: [project], agents: ['claude'], permissions: { sessions: true } });
  await sessions.bind({ principalId: 'review', pane: pane.paneId, id: 'bound' });
  await assert.rejects(sessions.send(old, { sessionId: 'bound', idempotencyKey: 'stale-token', text: 'from the old incarnation' }), e => e.code === 'permission_denied');
  await assert.rejects(sessions.read(old, { sessionId: 'bound' }), e => e.code === 'permission_denied');
  await assert.rejects(sessions.list(old), e => e.code === 'permission_denied');
  assert.equal(tmux.sent.length, 0);
  await assert.rejects(sessions.send({ ...old, incarnation: undefined }, { sessionId: 'bound', idempotencyKey: 'no-identity', text: 'x' }), e => e.code === 'permission_denied', 'a request without an incarnation is refused');
  // A binding written without identity fields is refused until the operator re-binds it.
  await sessions.sessions.update('bound', r => { delete r.bindingId; });
  const fresh = await principals.get('review');
  await assert.rejects(sessions.status(fresh, { sessionId: 'bound' }), e => e.code === 'session_rebind_required');
});

test('review regressions: a pre-identity principal cannot use live sessions until the operator migrates it', async t => {
  const f = await fixture(); t.after(f.remove);
  const project = await fs.realpath(f.project);
  const principals = new PrincipalStore({ root: f.stateRoot });
  await principals.create({ id: 'review', projects: [project], agents: ['claude'], permissions: { sessions: true } });
  const file = path.join(f.stateRoot, 'access', 'principals.json');
  const store = JSON.parse(await fs.readFile(file, 'utf8'));
  delete store.principals.review.incarnation;
  await fs.writeFile(file, JSON.stringify(store));
  const { tmux, processes, pane } = fakePane(project);
  const sessions = new SessionService({ root: f.stateRoot, principals, tmux, processes, settleMs: 0 });
  const legacy = await principals.get('review');
  await assert.rejects(sessions.list(legacy), e => e.code === 'legacy_migration_required');
  await assert.rejects(sessions.bind({ principalId: 'review', pane: pane.paneId, id: 'bound' }), e => e.code === 'legacy_migration_required', 'binding also waits for migration');
  await principals.migrate('review');
  const ready = await principals.get('review');
  await sessions.bind({ principalId: 'review', pane: pane.paneId, id: 'bound' });
  assert.equal((await sessions.status(ready, { sessionId: 'bound' })).state, 'idle');
  assert.equal(tmux.sent.length, 0);
});
