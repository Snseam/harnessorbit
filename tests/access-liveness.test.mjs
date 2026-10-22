import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Event-loop liveness of awaited waits in the access layer, checked in real child processes: a
// caller awaiting a timeout or an interval must receive it even when nothing else keeps the
// process alive. These are plain `node` children with their true exit codes, no test runner.
const run = promisify(execFile);
const here = path.resolve('.');
const src = name => path.join(here, 'src', 'access', name);

async function child(script, { timeoutMs = 20000 } = {}) {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await run(process.execPath, ['--input-type=module', '-e', script], { cwd: here, timeout: timeoutMs, maxBuffer: 1048576 });
    return { code: 0, stdout, stderr, ms: Date.now() - startedAt };
  } catch (error) {
    return { code: error.code ?? null, signal: error.signal ?? null, stdout: error.stdout || '', stderr: error.stderr || '', ms: Date.now() - startedAt };
  }
}

test('a MemoryService caller whose provider never settles receives status timeout before the process exits', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-liveness-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await child(`
    import fs from 'node:fs/promises';
    import { PrincipalStore } from ${JSON.stringify(src('principals.mjs'))};
    import { MemoryService } from ${JSON.stringify(src('memory.mjs'))};
    const root = ${JSON.stringify(root)};
    const project = await fs.realpath(await fs.mkdtemp(root + '/p-'));
    const principals = new PrincipalStore({ root });
    const { principal } = await principals.create({ id: 'p', projects: [project], agents: ['claude'] });
    const jobs = { get: async () => ({ id: 'j', principalId: 'p', principalIncarnation: principal.incarnation, project, agent: 'claude', runId: 'j', taskId: 'main' }) };
    const provider = { name: 'never', configured: true, recall: () => { console.log('PROVIDER_CALLED'); return new Promise(() => {}); }, begin: () => new Promise(() => {}), save: () => new Promise(() => {}) };
    const memory = new MemoryService({ root, provider, principals, jobs, timeoutMs: 600 });
    const result = await memory.recall(principal, { jobId: 'j', question: 'anything known?' });
    console.log('TIMEOUT_RETURNED status=' + result.status + ' reason=' + result.reason);
  `);
  assert.equal(result.code, 0, `child exit ${result.code} ${result.signal || ''}\n${result.stderr}`);
  assert.match(result.stdout, /PROVIDER_CALLED/);
  assert.match(result.stdout, /TIMEOUT_RETURNED status=timeout reason=timeout/);
  assert.ok(result.ms >= 600, 'the timeout actually elapsed');
});

test('a never-settling begin or save is answered with timeout/pending, not a silent exit', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-liveness-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await child(`
    import fs from 'node:fs/promises';
    import { PrincipalStore } from ${JSON.stringify(src('principals.mjs'))};
    import { MemoryService } from ${JSON.stringify(src('memory.mjs'))};
    const root = ${JSON.stringify(root)};
    const project = await fs.realpath(await fs.mkdtemp(root + '/p-'));
    const principals = new PrincipalStore({ root });
    const { principal } = await principals.create({ id: 'p', projects: [project], agents: ['claude'] });
    const jobs = { get: async () => ({ id: 'j', principalId: 'p', principalIncarnation: principal.incarnation, project, agent: 'claude', runId: 'j', taskId: 'main' }) };
    const orchestrator = { inspect: async () => ({ attempt: { id: 'a1', number: 1, status: 'running' } }) };
    let saves = 0;
    const provider = { name: 'slow', configured: true, recall: async () => ({ status: 'ok', items: [] }), begin: async () => ({ status: 'admitted', projectId: 'p-1', writeGeneration: 1 }), save: () => { saves++; return new Promise(() => {}); } };
    const memory = new MemoryService({ root, provider, principals, jobs, orchestrator, timeoutMs: 500 });
    console.log('BEGIN ' + (await memory.begin(principal, { jobId: 'j', operationId: 'op' })).status);
    const saved = await memory.checkpoint(principal, { jobId: 'j', operationId: 'op', summary: 'liveness probe' });
    console.log('SAVE status=' + saved.status + ' reason=' + saved.reason + ' saves=' + saves);
  `);
  assert.equal(result.code, 0, `child exit ${result.code}\n${result.stderr}`);
  assert.match(result.stdout, /BEGIN admitted/);
  assert.match(result.stdout, /SAVE status=pending reason=timeout saves=1/);
});

test('SessionObserver.run({ ticks: 2 }) completes both ticks in a standalone process', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-liveness-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await child(`
    import fs from 'node:fs/promises';
    import { PrincipalStore } from ${JSON.stringify(src('principals.mjs'))};
    import { SessionStore, SessionService } from ${JSON.stringify(src('sessions.mjs'))};
    import { CoopService } from ${JSON.stringify(src('coop.mjs'))};
    import { SessionObserver } from ${JSON.stringify(src('observer.mjs'))};
    const root = ${JSON.stringify(root)};
    const project = await fs.realpath(await fs.mkdtemp(root + '/p-'));
    const principals = new PrincipalStore({ root });
    const { principal } = await principals.create({ id: 'p', projects: [project], agents: ['claude'], permissions: { sessions: true } });
    const sessions = new SessionStore({ root });
    await sessions.create({ id: 's', bindingId: 'b', principalId: 'p', principalIncarnation: principal.incarnation, label: null, paneId: '%1', target: 'x:0.0', panePid: 1, tmuxSocket: null, agent: { kind: 'claude', pid: 1, startedAt: 'x', comm: 'claude' }, project, allowKeys: false, messages: [], createdAt: 'x', updatedAt: 'x' });
    const proc = { pid: 1, ppid: 0, pgid: 1, tpgid: 1, stat: 'S+', startedAt: 'x', comm: 'claude', args: 'claude' };
    const pane = { paneId: '%1', target: 'x:0.0', panePid: 1, dead: false, currentCommand: 'claude', currentPath: project, historySize: 0 };
    let ticks = 0;
    const tmux = { socket: null, pane: async () => pane, listPanes: async () => [pane], captureScreen: async () => { ticks++; return ticks === 1 ? ['✻ Working…'] : ['❯ ']; }, captureHistory: async () => [], sendText: async () => { throw new Error('never'); }, sendKeys: async () => { throw new Error('never'); } };
    const live = new SessionService({ root, principals, sessions, tmux, processes: { table: async () => new Map([[1, proc]]), agentUnder: async () => ({ ...proc, kind: 'claude' }), cwd: async () => project }, settleMs: 0 });
    const coop = new CoopService({ root, principals, sessions });
    await coop.store.init();
    const observer = new SessionObserver({ root, sessions: live, coop, intervalMs: 1000 });
    await observer.run({ ticks: 2 });
    console.log('TICKS ' + ticks);
  `);
  assert.equal(result.code, 0, `child exit ${result.code}\n${result.stderr}`);
  assert.match(result.stdout, /TICKS 2/);
  assert.ok(result.ms >= 1000, 'the interval between ticks actually elapsed');
});

test('the background settle window and the send confirmation wait keep the loop alive', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-liveness-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await child(`
    import fs from 'node:fs/promises';
    import { PrincipalStore } from ${JSON.stringify(src('principals.mjs'))};
    import { SessionStore, SessionService } from ${JSON.stringify(src('sessions.mjs'))};
    const root = ${JSON.stringify(root)};
    const project = await fs.realpath(await fs.mkdtemp(root + '/p-'));
    const principals = new PrincipalStore({ root });
    const { principal } = await principals.create({ id: 'p', projects: [project], agents: ['claude'], permissions: { sessions: true } });
    const sessions = new SessionStore({ root });
    await sessions.create({ id: 's', bindingId: 'b', principalId: 'p', principalIncarnation: principal.incarnation, label: null, paneId: '%1', target: 'x:0.0', panePid: 1, tmuxSocket: null, agent: { kind: 'claude', pid: 1, startedAt: 'x', comm: 'claude' }, project, allowKeys: false, messages: [], createdAt: 'x', updatedAt: 'x' });
    const proc = { pid: 1, ppid: 0, pgid: 1, tpgid: 1, stat: 'S+', startedAt: 'x', comm: 'claude', args: 'claude' };
    const pane = { paneId: '%1', target: 'x:0.0', panePid: 1, dead: false, currentCommand: 'claude', currentPath: project, historySize: 0 };
    // The screen never echoes the message and never shows a spinner, so the send must wait out settleMs and report uncertain.
    const tmux = { socket: null, pane: async () => pane, listPanes: async () => [pane], captureScreen: async () => ['❯ '], captureHistory: async () => [], sendText: async () => {}, sendKeys: async () => {} };
    const live = new SessionService({ root, principals, sessions, tmux, processes: { table: async () => new Map([[1, proc]]), agentUnder: async () => ({ ...proc, kind: 'claude' }), cwd: async () => project }, settleMs: 700 });
    const sent = await live.send(principal, { sessionId: 's', idempotencyKey: 'k', text: 'hello' });
    console.log('SEND outcome=' + sent.message.outcome);
  `);
  assert.equal(result.code, 0, `child exit ${result.code}\n${result.stderr}`);
  assert.match(result.stdout, /SEND outcome=uncertain/);
  assert.ok(result.ms >= 700);
});

test('SessionObserver.stop() ends the wait between ticks immediately', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-liveness-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await child(`
    import { PrincipalStore } from ${JSON.stringify(src('principals.mjs'))};
    import { SessionStore, SessionService } from ${JSON.stringify(src('sessions.mjs'))};
    import { CoopService } from ${JSON.stringify(src('coop.mjs'))};
    import { SessionObserver } from ${JSON.stringify(src('observer.mjs'))};
    const root = ${JSON.stringify(root)};
    const principals = new PrincipalStore({ root });
    const sessions = new SessionStore({ root });
    const live = new SessionService({ root, principals, sessions, tmux: { socket: null, listPanes: async () => [], pane: async () => null, captureScreen: async () => [], captureHistory: async () => [], sendText: async () => {}, sendKeys: async () => {} }, processes: { table: async () => new Map(), agentUnder: async () => null, cwd: async () => null } });
    const observer = new SessionObserver({ root, sessions: live, coop: new CoopService({ root, principals, sessions }), intervalMs: 60000 });
    const started = Date.now();
    setTimeout(() => observer.stop(), 200);
    await observer.run();
    console.log('STOPPED_AFTER_MS ' + (Date.now() - started));
  `);
  assert.equal(result.code, 0, `child exit ${result.code}\n${result.stderr}`);
  const ms = Number(/STOPPED_AFTER_MS (\d+)/.exec(result.stdout)?.[1]);
  assert.ok(ms >= 100 && ms < 5000, `stop() cancelled the 60 s interval wait (took ${ms} ms); timers may fire a millisecond early`);
});
