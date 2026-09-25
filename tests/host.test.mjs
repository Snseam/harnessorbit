import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Orchestrator } from '../src/orchestrator.mjs';
import { Supervisor } from '../src/supervisor/index.mjs';
import { fixture, task, FakeHerdr } from './helpers.mjs';
import { enableConversationMode, statusConversationMode, disableConversationMode } from '../src/conversation-mode.mjs';

const hostTask = extra => task({ agent: 'codex', isolation: 'checkout', ...extra });
function report(attempt, extra = {}) {
  return { taskId: attempt.taskId, attemptId: attempt.id, nonce: attempt.nonce, status: 'submitted', summary: 'Host candidate', changedFiles: [], checks: [], children: [], unresolved: [], hostStopped: true, ...extra };
}
async function setup(t) {
  const f = await fixture(); t.after(f.remove);
  let runtimeCalls = 0;
  const herdr = new Proxy({}, { get: () => () => { runtimeCalls++; throw new Error('Host must not call Herdr'); } });
  const service = new Orchestrator({ stateRoot: f.stateRoot, coordinatorId: 'thread-a', herdr });
  const run = await service.init({ project: f.project, maxParallel: 1 });
  return { ...f, service, run, runtimeCalls: () => runtimeCalls };
}
const fix = f => fs.writeFile(path.join(f.project, 'src/math.mjs'), 'export const add = (a,b) => a+b;\n');

test('host start/report/verify uses in-place checks and no external runtime', async t => {
  const f = await setup(t);
  const start = await f.service.hostStart(f.run.id, hostTask());
  assert.equal(start.attempt.executorKind, 'host');
  assert.equal(Object.hasOwn(start.attempt, 'paneId'), false);
  assert.equal(Object.hasOwn(start.attempt, 'workerClosed'), false);
  await fix(f);
  assert.equal((await f.service.hostReport(f.run.id, start.task.id, report(start.attempt))).attempt.status, 'submitted');
  const verified = await f.service.hostVerify(f.run.id, start.task.id);
  assert.equal(verified.attempt.status, 'accepted');
  assert.equal(verified.attempt.deliveryMode, 'in-place');
  assert.equal(verified.attempt.patchFile, undefined);
  await assert.rejects(f.service.integrate(f.run.id, start.task.id));
  await f.service.cleanup(f.run.id);
  assert.equal(f.runtimeCalls(), 0);
});

test('host scope and user baseline are checked independently of self-reported checks', async t => {
  const f = await setup(t);
  await fs.writeFile(path.join(f.project, 'user.txt'), 'keep');
  const start = await f.service.hostStart(f.run.id, hostTask());
  await f.service.hostReport(f.run.id, start.task.id, report(start.attempt, { checks: [{ status: 'passed' }] }));
  const verified = await f.service.hostVerify(f.run.id, start.task.id);
  assert.equal(verified.attempt.status, 'rework');
  assert.equal(await fs.readFile(path.join(f.project, 'user.txt'), 'utf8'), 'keep');
  const retry = await f.service.hostStart(f.run.id, hostTask(), { retry: true });
  assert.notEqual(retry.attempt.nonce, start.attempt.nonce);
  await fix(f);
  await fs.writeFile(path.join(f.project, 'outside.txt'), 'unexpected');
  const submitted = await f.service.hostReport(f.run.id, retry.task.id, report(retry.attempt));
  assert.equal(submitted.attempt.status, 'needs_input');
  assert.deepEqual(submitted.attempt.outsideScope, ['outside.txt']);
  assert.deepEqual(submitted.retryAdvice, { action: 'retry_with_feedback', reason: 'scope_violation' });
});

test('host start rejects missing directory slash before reserving', async t => {
  const f = await setup(t);
  await assert.rejects(f.service.hostStart(f.run.id, hostTask({ allowedPaths: ['src'] })), e => {
    assert.equal(e.code, 'directory_scope_missing_slash');
    assert.equal(e.details.scope.root, false);
    return true;
  });
  assert.equal((await f.service.status(f.run.id)).tasks.length, 0);
});

test('host ownership, nonce, stopped declaration and child completion are enforced', async t => {
  const f = await setup(t);
  const start = await f.service.hostStart(f.run.id, hostTask({ maxChildren: 1 }));
  const other = new Orchestrator({ stateRoot: f.stateRoot, coordinatorId: 'thread-b' });
  await assert.rejects(other.hostReport(f.run.id, start.task.id, report(start.attempt)), e => e.code === 'host_owner_mismatch');
  await assert.rejects(other.hostStart(f.run.id, start.task), e => e.code === 'host_owner_mismatch');
  await assert.rejects(f.service.hostReport(f.run.id, start.task.id, report(start.attempt, { nonce: 'wrong' })), e => e.code === 'stale_result');
  await assert.rejects(f.service.hostReport(f.run.id, start.task.id, report(start.attempt, { hostStopped: false })), e => e.code === 'host_not_stopped');
  await assert.rejects(f.service.hostReport(f.run.id, start.task.id, report(start.attempt, { children: [{ id: 'child', status: 'unknown' }] })), e => e.code === 'children_unfinished');
  await assert.rejects(f.service.hostRelease(f.run.id, start.task.id, { ackStopped: true, children: [{ id: 'child', status: 'running' }] }), e => e.code === 'children_unfinished');
});

test('duplicate host start/report does not launch again and post-report edits cannot pass', async t => {
  const f = await setup(t);
  const started = await Promise.all([f.service.hostStart(f.run.id, hostTask()), f.service.hostStart(f.run.id, hostTask())]);
  assert.equal(started.filter(x => x.duplicate).length, 1);
  await fix(f);
  const r = report(started[0].attempt);
  await f.service.hostReport(f.run.id, r.taskId, r);
  assert.equal((await f.service.hostReport(f.run.id, r.taskId, r)).duplicate, true);
  await fs.appendFile(path.join(f.project, 'src/math.mjs'), '// changed\n');
  await assert.rejects(f.service.hostVerify(f.run.id, r.taskId), e => e.code === 'candidate_changed');
});

test('cancel requests host stop and retains checkout until acknowledgment and recovery', async t => {
  const f = await setup(t);
  const start = await f.service.hostStart(f.run.id, hostTask());
  await fix(f);
  const cancelled = await f.service.cancel(f.run.id, start.task.id);
  assert.equal(cancelled.attempt.status, 'cancelling');
  assert.equal(cancelled.attempt.hostStoppedEvidence, null);
  const otherRun = await f.service.init({ project: f.project });
  await assert.rejects(f.service.hostStart(otherRun.id, hostTask({ id: 'other' })), e => e.code === 'checkout_busy');
  const released = await f.service.hostRelease(f.run.id, start.task.id, { ackStopped: true });
  assert.equal(released.attempt.status, 'cancelled');
  assert.equal(released.attempt.checkoutReleased, false);
  await assert.rejects(f.service.hostStart(otherRun.id, hostTask({ id: 'other' })), e => e.code === 'checkout_busy');
  assert.equal((await f.service.recover(f.run.id, start.task.id, { hostThread: 'thread-a' })).attempt.status, 'accepted');
  assert.equal((await f.service.hostStart(otherRun.id, hostTask({ id: 'other' }))).attempt.status, 'running');
  assert.equal(f.runtimeCalls(), 0);
});

test('unchanged host cancellation releases without discarding project files', async t => {
  const f = await setup(t);
  const start = await f.service.hostStart(f.run.id, hostTask());
  await assert.rejects(f.service.hostRelease(f.run.id, start.task.id), e => e.code === 'host_stop_confirmation_required');
  assert.equal((await f.service.hostRelease(f.run.id, start.task.id, { ackStopped: true })).attempt.checkoutReleased, true);
});

test('host and external execution paths cannot silently substitute each other', async t => {
  const f = await setup(t);
  const start = await f.service.hostStart(f.run.id, hostTask());
  await assert.rejects(f.service.dispatch(f.run.id, hostTask()), e => e.code === 'executor_conflict');
  for (const method of ['collect', 'requestReport', 'resume', 'retry']) await assert.rejects(f.service[method](f.run.id, start.task.id), e => e.code === 'host_command_required');
  await assert.rejects(f.service.hostStart(f.run.id, task()), e => e.code === 'invalid_host_task');
});

test('host work does not consume external run capacity but still owns checkout', async t => {
  const f = await fixture(); t.after(f.remove);
  const runtime = new FakeHerdr(async (_p, w) => { w.agent_status = 'working'; w.interactive_ready = false; });
  const service = new Orchestrator({ stateRoot: f.stateRoot, coordinatorId: 'thread-a', herdr: runtime });
  const run = await service.init({ project: f.project, maxParallel: 1 });
  await service.dispatch(run.id, task());
  assert.equal((await service.hostStart(run.id, hostTask({ id: 'host' }))).attempt.status, 'running');
  await assert.rejects(service.hostStart(run.id, hostTask({ id: 'host2' })), e => e.code === 'checkout_busy');
});

test('supervisor never collects a host terminal and can verify stopped host reports', async t => {
  const f = await setup(t);
  const start = await f.service.hostStart(f.run.id, hostTask());
  const supervisor = new Supervisor({ orchestrator: f.service });
  assert.equal((await supervisor.step(f.run.id)).reason, 'attention');
  await fix(f);
  await f.service.hostReport(f.run.id, start.task.id, report(start.attempt));
  const settled = await supervisor.supervise(f.run.id, { integrate: true, waitMs: 1000 });
  assert.equal(settled.reason, 'complete');
  assert.equal((await f.service.inspect(f.run.id, start.task.id)).attempt.status, 'accepted');
  assert.equal(f.runtimeCalls(), 0);
});

test('mode schema migration preserves legacy behavior and rejects unknown active strategy', async t => {
  const f = await setup(t), opts = { stateRoot: f.stateRoot, thread: 'mode-thread' };
  assert.equal((await enableConversationMode(opts)).schemaVersion, 1);
  const enabled = await enableConversationMode({ ...opts, strategy: 'shadow', preference: 'subscription-first' });
  assert.equal(enabled.schemaVersion, 2); assert.equal(enabled.strategy, 'shadow');
  await disableConversationMode(opts);
  assert.equal((await statusConversationMode(opts)).preference, 'subscription-first');
  assert.equal((await enableConversationMode(opts)).strategy, 'shadow');
  assert.equal((await enableConversationMode({ ...opts, strategy: 'adaptive' })).strategy, 'adaptive');
  await assert.rejects(enableConversationMode({ ...opts, strategy: 'unknown' }), e => e.code === 'invalid_arguments');
});

test('host CLI performs real independent checks in a temporary project', async t => {
  const f = await setup(t);
  const file = path.join(f.base, 'task.json'); await fs.writeFile(file, JSON.stringify(hostTask()));
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, ['bin/cao.mjs', ...args, '--state-dir', f.stateRoot], { encoding: 'utf8', env: { ...process.env, CODEX_THREAD_ID: 'thread-a', CODEX_SESSION_ID: '' } })).data;
  const started = cli('host', 'start', '--run', f.run.id, '--file', file);
  await fix(f);
  const resultFile = path.join(f.base, 'report.json'); await fs.writeFile(resultFile, JSON.stringify(report(started.attempt)));
  cli('host', 'report', '--run', f.run.id, '--task', started.task.id, '--file', resultFile);
  assert.equal(cli('host', 'verify', '--run', f.run.id, '--task', started.task.id).attempt.status, 'accepted');
});

test('host retry cannot change attempt limits, scope or checks', async t => {
  const f = await setup(t), definition = hostTask({ maxAttempts: 1 });
  const started = await f.service.hostStart(f.run.id, definition);
  await f.service.hostRelease(f.run.id, started.task.id, { ackStopped: true });
  for (const change of [{ maxAttempts: 20 }, { allowedPaths: ['.'] }, { checks: [{ name: 'bypass', argv: [process.execPath, '-e', 'process.exit(0)'] }] }]) {
    await assert.rejects(f.service.hostStart(f.run.id, { ...definition, ...change }, { retry: true }), e => e.code === 'task_conflict');
  }
  await assert.rejects(f.service.hostStart(f.run.id, definition, { retry: true }), e => e.code === 'attempt_limit');
});

test('shadow CLI records an unapplied recommendation without dispatch or capacity changes', async t => {
  const f = await setup(t);
  const input = task({ brief: { risk: 'high', contextDependency: 'high', independent: false } }); delete input.agent;
  const file = path.join(f.base, 'shadow-task.json'); await fs.writeFile(file, JSON.stringify(input));
  const result = JSON.parse(execFileSync(process.execPath, ['bin/cao.mjs', 'route', 'shadow', '--file', file, '--record', '--thread', 'thread-a', '--state-dir', f.stateRoot], {
    encoding: 'utf8', env: { ...process.env, HOME: f.base, CODEX_THREAD_ID: 'thread-a' },
  })).data;
  assert.equal(result.applied, false); assert.equal(result.mode, 'shadow');
  assert.equal(result.selected.executorKind, 'host');
  assert.equal((await f.service.status(f.run.id)).tasks.length, 0);
  await assert.rejects(fs.stat(path.join(f.stateRoot, 'routing', 'reservations.json')), e => e.code === 'ENOENT');
  assert.doesNotMatch(await fs.readFile(path.join(f.stateRoot, 'shadow-routing', 'threads', 'thread-a.json'), 'utf8'), /Fix add to add/);
  await fs.writeFile(file, JSON.stringify(hostTask()));
  const hostDecision = JSON.parse(execFileSync(process.execPath, ['bin/cao.mjs', 'route', 'shadow', '--file', file, '--executor', 'host', '--state-dir', f.stateRoot], { encoding: 'utf8', env: { ...process.env, HOME: f.base } })).data;
  assert.equal(hostDecision.selected.executorKind, 'host');
});

test('adaptive CLI host dispatch requires adaptive flag or mode and does not start Herdr', async t => {
  const f = await setup(t);
  const file = path.join(f.base, 'host-task.json');
  await fs.writeFile(file, JSON.stringify(hostTask()));
  const env = { ...process.env, HOME: f.base, CODEX_THREAD_ID: 'thread-a', CODEX_SESSION_ID: '' };
  const denied = spawnSync(process.execPath, ['bin/cao.mjs', 'dispatch', '--run', f.run.id, '--file', file, '--preference', 'fastest', '--state-dir', f.stateRoot], { encoding: 'utf8', env });
  assert.equal(denied.status, 2);
  assert.equal(JSON.parse(denied.stderr).error.code, 'invalid_arguments');
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, ['bin/cao.mjs', ...args, '--state-dir', f.stateRoot], { encoding: 'utf8', env })).data;
  const started = cli('dispatch', '--run', f.run.id, '--file', file, '--adaptive', '--executor', 'host');
  assert.equal(started.adaptive, true);
  assert.equal(started.attempt.executorKind, 'host');
  assert.equal(started.attempt.routeDecision.mode, 'adaptive');
  assert.equal(f.runtimeCalls(), 0);
  await f.service.hostRelease(f.run.id, started.task.id, { ackStopped: true });
  cli('mode', 'enable', '--strategy', 'adaptive', '--thread', 'thread-a');
  const viaMode = cli('dispatch', '--run', f.run.id, '--file', file, '--executor', 'host', '--thread', 'thread-a');
  assert.equal(viaMode.adaptive, true);
  assert.equal(viaMode.attempt.executorKind, 'host');
  assert.equal(f.runtimeCalls(), 0);
});
