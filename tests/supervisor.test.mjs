import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Supervisor } from '../src/supervisor/index.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import * as state from '../src/state.mjs';
import { fixture, FakeHerdr, task as realTask } from './helpers.mjs';

const time = '2026-09-17T00:00:00.000Z';
const now = () => Date.parse(time);
const taskId = 'task-one';

function definition(extra = {}) {
  return {
    id: taskId,
    objective: 'Do the work.',
    agent: 'claude',
    role: 'implementer',
    allowedPaths: ['src/file.mjs'],
    checks: [{ name: 'unit', argv: [process.execPath, '-e', ''] }],
    isolation: 'worktree',
    agentArgs: [],
    nativeInstructions: '',
    maxChildren: 0,
    maxAttempts: 3,
    dependsOn: [],
    ...extra,
  };
}

function task(status, attemptExtra = {}, definitionExtra = {}) {
  const attempt = {
    id: `${taskId}-a1`,
    taskId,
    number: 1,
    nonce: 'nonce',
    directory: '/tmp/attempt',
    resultFile: '/tmp/attempt/result.json',
    status,
    createdAt: time,
    cwd: '/tmp/project',
    baseline: null,
    workerName: 'worker',
    paneId: 'pane-1',
    terminalId: 'term-1',
    submissionStartedAt: time,
    workerClosed: false,
    cancelRequested: false,
    feedback: '',
    previousAttempt: null,
    launcherPid: process.pid,
    launcherHost: os.hostname(),
    launchFinishedAt: time,
    coordinatorThreadId: null,
    ...attemptExtra,
  };
  return {
    definition: definition(definitionExtra),
    digest: 'digest',
    attempts: [attempt],
    currentAttempt: attempt.id,
  };
}

async function makeRun(t, tasks = { [taskId]: task('running') }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-supervisor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = {
    schemaVersion: 1,
    id: 'run-one',
    project: '/tmp/project',
    baseCommit: 'HEAD',
    baseline: {},
    initiallyDirty: false,
    herdrSession: 'session',
    coordinatorThreadId: null,
    createdAt: time,
    updatedAt: time,
    maxParallel: 4,
    server: null,
    tasks,
  };
  await state.createRun(root, run);
  return { root, runId: run.id };
}

function current(run, id = taskId) {
  const record = run.tasks[id];
  return record.attempts.find((attempt) => attempt.id === record.currentAttempt);
}

class FakeOrchestrator {
  constructor(root) {
    this.root = root;
    this.calls = { inspect: 0, collect: 0, verify: 0, integrate: 0, cancel: 0, requestReport: 0 };
  }

  async mutate(runId, mutator) {
    return state.withLock(path.join(state.runPath(this.root, runId), '.lock'), async () => {
      const run = await state.loadRun(this.root, runId);
      mutator(run);
      await state.saveRun(this.root, run);
      return run;
    });
  }

  async inspect(runId, id) {
    this.calls.inspect++;
    const run = await state.loadRun(this.root, runId);
    const record = run.tasks[id];
    return { runId, task: structuredClone(record.definition), attempt: structuredClone(current(run, id)) };
  }

  async collect(runId, id, options) {
    this.calls.collect++;
    this.lastCollect = options;
    await this.mutate(runId, (run) => {
      const attempt = current(run, id);
      if (this.collectTo) Object.assign(attempt, this.collectTo(attempt));
    });
    return this.inspect(runId, id);
  }

  async verify(runId, id) {
    this.calls.verify++;
    await this.mutate(runId, (run) => {
      current(run, id).status = 'accepted';
    });
    return this.inspect(runId, id);
  }

  async integrate(runId, id) {
    this.calls.integrate++;
    await this.mutate(runId, (run) => {
      current(run, id).status = 'integrated';
    });
    return this.inspect(runId, id);
  }

  async cancel(runId, id, options) {
    this.calls.cancel++;
    this.lastCancel = options;
    if (this.cancelError) throw this.cancelError;
    await this.mutate(runId, (run) => {
      const attempt = current(run, id);
      attempt.cancelRequested = true;
      attempt.status = 'cancelled';
      attempt.workerClosed = true;
    });
    return this.inspect(runId, id);
  }

  async requestReport(runId, id) {
    this.calls.requestReport++;
    this.lastReportRequest = { runId, id };
    return { requested: true };
  }
}

test('running and uncertain attempts are collected without resending or repairing by default', async (t) => {
  const { root, runId } = await makeRun(t, { [taskId]: task('uncertain') });
  const orchestrator = new FakeOrchestrator(root);
  orchestrator.collectTo = () => ({
    status: 'needs_input',
    lastError: { code: 'missing_result', message: 'missing result' },
  });

  const result = await new Supervisor({ orchestrator, now }).step(runId);

  assert.equal(orchestrator.calls.collect, 1);
  assert.deepEqual(orchestrator.lastCollect, { waitMs: 0 });
  assert.equal(orchestrator.calls.requestReport, 0);
  assert.equal(result.reason, 'attention');
  assert.equal(result.snapshots[0].status, 'needs_input');
  assert.equal(result.snapshots[0].errorCode, 'missing_result');
  assert.equal(result.snapshots[0].lastError, undefined);
  assert.equal(result.projectAcceptance, 'unknown');
});

test('report repair is opt in and uses requestReport for missing or invalid reports', async (t) => {
  const { root, runId } = await makeRun(t);
  const orchestrator = new FakeOrchestrator(root);
  orchestrator.collectTo = () => ({
    status: 'needs_input',
    lastError: { code: 'invalid_result', message: 'bad report' },
  });

  await new Supervisor({ orchestrator, now }).step(runId, { repairReports: true });

  assert.equal(orchestrator.calls.collect, 1);
  assert.equal(orchestrator.calls.requestReport, 1);
  assert.deepEqual(orchestrator.lastReportRequest, { runId, id: taskId });
});

test('report repair refuses stale nonce results and accepts state JSON parse failures', async (t) => {
  const { root, runId } = await makeRun(t);
  const orchestrator = new FakeOrchestrator(root);
  orchestrator.collectTo = () => ({
    status: 'needs_input',
    lastError: { code: 'stale_result', message: 'stale nonce' },
  });

  await new Supervisor({ orchestrator, now }).step(runId, { repairReports: true });
  assert.equal(orchestrator.calls.requestReport, 0);

  orchestrator.collectTo = () => ({
    status: 'needs_input',
    lastError: { code: 'state_invalid_json', message: 'bad json' },
  });
  await new Supervisor({ orchestrator, now }).step(runId, { repairReports: true });
  assert.equal(orchestrator.calls.requestReport, 1);
});

test('submitted attempts are verified and accepted attempts are not integrated by default', async (t) => {
  const submitted = task('submitted');
  const accepted = task('accepted');
  accepted.definition = definition({ id: 'accepted-task' });
  accepted.attempts[0].id = 'accepted-task-a1';
  accepted.attempts[0].taskId = 'accepted-task';
  accepted.currentAttempt = 'accepted-task-a1';
  const { root, runId } = await makeRun(t, { [taskId]: submitted, 'accepted-task': accepted });
  const orchestrator = new FakeOrchestrator(root);

  const result = await new Supervisor({ orchestrator, now }).step(runId);

  assert.equal(orchestrator.calls.verify, 1);
  assert.equal(orchestrator.calls.integrate, 0);
  assert.equal(result.snapshots.find((snapshot) => snapshot.taskId === taskId).status, 'accepted');
  assert.equal(result.snapshots.find((snapshot) => snapshot.taskId === 'accepted-task').status, 'accepted');
});

test('accepted attempts integrate only when explicitly requested', async (t) => {
  const { root, runId } = await makeRun(t, { [taskId]: task('accepted') });
  const orchestrator = new FakeOrchestrator(root);

  const result = await new Supervisor({ orchestrator, now }).step(runId, { integrate: true });

  assert.equal(orchestrator.calls.integrate, 1);
  assert.equal(result.reason, 'complete');
  assert.equal(result.snapshots[0].status, 'integrated');
});

test('checkout accepted attempts are not integrated even when integration is requested', async (t) => {
  const { root, runId } = await makeRun(t, { [taskId]: task('accepted', {}, { isolation: 'checkout' }) });
  const orchestrator = new FakeOrchestrator(root);

  const result = await new Supervisor({ orchestrator, now }).step(runId, { integrate: true });

  assert.equal(orchestrator.calls.integrate, 0);
  assert.equal(result.reason, 'complete');
  assert.equal(result.snapshots[0].status, 'accepted');
});

test('expired accepted worktree requires attention instead of integration', async (t) => {
  const expired = '2026-09-16T00:00:00.000Z';
  const { root, runId } = await makeRun(t, { [taskId]: task('accepted', { deadlineAt: expired }) });
  const orchestrator = new FakeOrchestrator(root);

  const result = await new Supervisor({ orchestrator, now }).step(runId, { integrate: true });

  assert.equal(orchestrator.calls.integrate, 0);
  assert.equal(result.reason, 'attention');
  assert.equal(result.events.some((event) => event.reason === 'deadline_accepted'), true);
});

test('expired deadlines cancel only active owned workers', async (t) => {
  const expired = '2026-09-16T00:00:00.000Z';
  const accepted = task('accepted', { deadlineAt: expired });
  accepted.definition = definition({ id: 'done' });
  accepted.attempts[0].id = 'done-a1';
  accepted.attempts[0].taskId = 'done';
  accepted.currentAttempt = 'done-a1';
  const failed = task('failed', { deadlineAt: expired });
  failed.definition = definition({ id: 'failed' });
  failed.attempts[0].id = 'failed-a1';
  failed.attempts[0].taskId = 'failed';
  failed.currentAttempt = 'failed-a1';
  const { root, runId } = await makeRun(t, {
    [taskId]: task('running', { deadlineAt: expired }),
    done: accepted,
    failed,
  });
  const orchestrator = new FakeOrchestrator(root);

  const result = await new Supervisor({ orchestrator, now }).step(runId);

  assert.equal(orchestrator.calls.cancel, 1);
  assert.deepEqual(orchestrator.lastCancel, { reason: 'deadline' });
  assert.equal(result.snapshots.find((snapshot) => snapshot.taskId === taskId).status, 'cancelled');
  assert.equal(result.snapshots.find((snapshot) => snapshot.taskId === 'done').status, 'accepted');
  assert.equal(result.snapshots.find((snapshot) => snapshot.taskId === 'failed').status, 'failed');
});

test('cancel failure is reported as attention and does not hide the task state', async (t) => {
  const expired = '2026-09-16T00:00:00.000Z';
  const { root, runId } = await makeRun(t, { [taskId]: task('running', { deadlineAt: expired }) });
  const orchestrator = new FakeOrchestrator(root);
  orchestrator.cancelError = Object.assign(new Error('identity changed'), { code: 'identity_changed' });

  const result = await new Supervisor({ orchestrator, now }).step(runId);

  assert.equal(orchestrator.calls.cancel, 1);
  assert.equal(result.reason, 'attention');
  assert.equal(result.events.some((event) => event.type === 'task.cancel_failed' && event.errorCode === 'identity_changed'), true);
  assert.equal(result.snapshots[0].status, 'running');
});

test('stale active controller states produce attention without duplicate operations', async (t) => {
  const { root, runId } = await makeRun(t, { [taskId]: task('verifying') });
  const orchestrator = new FakeOrchestrator(root);

  const result = await new Supervisor({ orchestrator, now }).step(runId);

  assert.equal(orchestrator.calls.collect, 0);
  assert.equal(orchestrator.calls.verify, 0);
  assert.equal(orchestrator.calls.cancel, 0);
  assert.equal(result.reason, 'attention');
  assert.equal(result.events.some((event) => event.reason === 'active_verifying'), true);
});

test('ready unsubmitted assignments and stale progress produce attention', async (t) => {
  const stale = '2026-09-16T23:54:59.000Z';
  const ready = task('ready', { submissionStartedAt: null });
  const slow = task('running', { performance: { lastProgressAt: stale } });
  slow.definition = definition({ id: 'slow-task' });
  slow.attempts[0].id = 'slow-task-a1';
  slow.attempts[0].taskId = 'slow-task';
  slow.currentAttempt = 'slow-task-a1';
  const { root, runId } = await makeRun(t, { [taskId]: ready, 'slow-task': slow });
  const orchestrator = new FakeOrchestrator(root);

  const result = await new Supervisor({ orchestrator, now }).step(runId);

  assert.equal(result.reason, 'attention');
  assert.equal(result.events.some((event) => event.reason === 'ready_unsubmitted'), true);
  assert.equal(result.events.some((event) => event.reason === 'no_progress'), true);
});

test('a blocked sibling does not prevent normal sibling progress', async (t) => {
  const blocked = task('needs_input', {
    report: { children: [{ id: 'secret-child-id', status: 'running' }] },
    lastError: { code: 'missing_result', message: 'secret terminal output', details: { token: 'secret' } },
  });
  const submitted = task('submitted');
  submitted.definition = definition({ id: 'submitted-task' });
  submitted.attempts[0].id = 'submitted-task-a1';
  submitted.attempts[0].taskId = 'submitted-task';
  submitted.currentAttempt = 'submitted-task-a1';
  const { root, runId } = await makeRun(t, { [taskId]: blocked, 'submitted-task': submitted });
  const orchestrator = new FakeOrchestrator(root);

  const result = await new Supervisor({ orchestrator, now }).step(runId);

  assert.equal(orchestrator.calls.verify, 1);
  assert.equal(result.reason, 'attention');
  assert.equal(result.snapshots.find((snapshot) => snapshot.taskId === 'submitted-task').status, 'accepted');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('failed HOLD attention is keyed by lastError code', async (t) => {
  const { root, runId } = await makeRun(t, {
    [taskId]: task('failed', {
      lastError: { code: 'unsupported_submodule', message: 'secret git details', details: { token: 'secret' } },
      paneId: null,
    }),
  });
  const result = await new Supervisor({ orchestrator: new FakeOrchestrator(root), now }).step(runId);
  const event = result.events.find((item) => item.type === 'supervisor.attention' && item.reason === 'unsupported_submodule');
  assert.ok(event);
  assert.equal(event.key, `${taskId}:${taskId}-a1:unsupported_submodule`);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('same attention is emitted once across repeated supervisor calls', async (t) => {
  const { root, runId } = await makeRun(t, {
    [taskId]: task('needs_input', {
      report: { children: [{ id: 'child-one', status: 'running' }] },
    }),
  });
  const orchestrator = new FakeOrchestrator(root);
  orchestrator.collectTo = () => ({ status: 'needs_input' });
  const supervisor = new Supervisor({ orchestrator, now });

  const first = await supervisor.step(runId);
  const second = await supervisor.step(runId);

  assert.equal(first.events.filter((event) => event.type === 'supervisor.attention').length, 2);
  assert.equal(second.events.filter((event) => event.type === 'supervisor.attention').length, 0);
  const run = await state.loadRun(root, runId);
  assert.equal(Object.values(run.supervisor.attention).every((item) => item.count === 2), true);
});

test('controller lock allows only one supervisor for a run at a time', async (t) => {
  const { root, runId } = await makeRun(t);
  const orchestrator = new FakeOrchestrator(root);
  let release;
  const entered = new Promise((resolve) => {
    orchestrator.collectTo = () => {
      resolve();
      return { status: 'running' };
    };
  });
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const originalCollect = orchestrator.collect.bind(orchestrator);
  orchestrator.collect = async (...args) => {
    const result = await originalCollect(...args);
    await hold;
    return result;
  };
  const supervisor = new Supervisor({ orchestrator, now });

  const first = supervisor.step(runId);
  await entered;
  await assert.rejects(supervisor.step(runId), (error) => error.code === 'lock_timeout');
  release();
  await first;

  const run = await state.loadRun(root, runId);
  assert.equal(run.supervisor.owner, undefined);
});

test('supervise is bounded and returns timeout while work remains active', async (t) => {
  const { root, runId } = await makeRun(t);
  const orchestrator = new FakeOrchestrator(root);
  orchestrator.collectTo = () => ({ status: 'running' });
  let clock = Date.parse(time);
  const supervisor = new Supervisor({
    orchestrator,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });

  const result = await supervisor.supervise(runId, { waitMs: 10, pollMs: 5 });

  assert.equal(result.reason, 'timeout');
  assert.equal(orchestrator.calls.collect >= 2, true);
});

test('unknown run does not create a run directory while acquiring supervisor lock', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-supervisor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const orchestrator = new FakeOrchestrator(root);

  await assert.rejects(new Supervisor({ orchestrator, now }).step('missing'), (error) => error.code === 'run_not_found');
  await assert.rejects(fs.stat(path.join(root, 'runs', 'missing')), (error) => error.code === 'ENOENT');
});

test('real orchestrator supervise continues from dispatch through integration', async (t) => {
  const f = await fixture();
  t.after(f.remove);
  const service = new Orchestrator({ stateRoot: f.stateRoot, herdr: new FakeHerdr() });
  const run = await service.init({ project: f.project });
  await service.dispatch(run.id, realTask());

  const result = await new Supervisor({ orchestrator: service }).supervise(run.id, { integrate: true, waitMs: 5000, pollMs: 10 });

  assert.equal(result.reason, 'complete');
  assert.equal(result.snapshots[0].status, 'integrated');
});

test('real checkout accepted task is settled but never integrated by supervisor', async (t) => {
  const f = await fixture();
  t.after(f.remove);
  const service = new Orchestrator({ stateRoot: f.stateRoot, herdr: new FakeHerdr() });
  const run = await service.init({ project: f.project });
  const input = realTask({ isolation: 'checkout' });
  await service.dispatch(run.id, input);

  const result = await new Supervisor({ orchestrator: service }).supervise(run.id, { integrate: true, waitMs: 5000, pollMs: 10 });

  assert.equal(result.reason, 'complete');
  assert.equal(result.snapshots[0].status, 'accepted');
});
