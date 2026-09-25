import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicPerformance, summarizeRun, trackAttempt } from '../src/performance/index.mjs';

const at = second => `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;

function withPerformance(attempt, now) {
  return { ...attempt, performance: trackAttempt(null, attempt, now) };
}

test('trackAttempt records phase transitions without mutating attempts', () => {
  const initial = { id: 'a1', taskId: 'task', status: 'preparing', createdAt: at(0) };
  const prepare = trackAttempt(null, initial, at(0));
  const previous = { ...initial, performance: prepare };
  const current = { ...initial, status: 'launching', paneId: 'pane', terminalId: 'term' };
  const tracked = trackAttempt(previous, current, at(1));

  assert.equal(tracked.phase, 'launch');
  assert.equal(tracked.phaseStartedAt, at(1));
  assert.equal(tracked.durationsMs.prepare, 1000);
  assert.equal(previous.performance.phase, 'prepare');
  assert.equal(current.performance, undefined);
});

test('repeated observations are not progress when state and evidence are unchanged', () => {
  const submitted = {
    id: 'a1',
    taskId: 'task',
    status: 'submitted',
    collectedAt: at(2),
    observedAt: at(2),
    snapshot: { hash: 'snapshot-one' },
    report: { status: 'submitted', changedFiles: ['src/a.mjs'], checks: [], children: [], unresolved: [] },
  };
  const first = trackAttempt(null, submitted, at(2));
  const repeated = {
    ...submitted,
    collectedAt: at(3),
    observedAt: at(3),
  };
  const second = trackAttempt({ ...submitted, performance: first }, repeated, at(3));

  assert.equal(second.lastProgressAt, at(2));
  assert.equal(second.lastObservedAt, at(3));
  assert.equal(second.progressFingerprint, first.progressFingerprint);
});

test('clock regressions do not subtract time from phase totals', () => {
  const running = withPerformance({ id: 'a1', taskId: 'task', status: 'running' }, at(10));
  const tracked = trackAttempt(running, { ...running, status: 'submitted' }, at(9));
  const later = trackAttempt({ ...running, status: 'submitted', performance: tracked }, { ...running, status: 'verifying' }, at(11));

  assert.equal(tracked.durationsMs.execute, 0);
  assert.equal(tracked.updatedAt, at(10));
  assert.equal(tracked.phaseStartedAt, at(10));
  assert.equal(later.durationsMs.execute, 0);
  assert.equal(later.durationsMs.collect, 1000);
  assert.ok(tracked.coverage.notes.includes('clock_regression_ignored'));
});

test('new attempts are not legacy and legacy summaries do not fabricate elapsed spans', () => {
  const current = { id: 'a1', taskId: 'task', status: 'running', createdAt: at(0) };
  const tracked = trackAttempt(null, current, at(0));
  const report = summarizeRun({
    id: 'run',
    schemaVersion: 1,
    tasks: { task: { definition: { id: 'task' }, currentAttempt: 'a1', attempts: [current, { id: 'a2', taskId: 'task', status: 'accepted', createdAt: at(2) }, { ...current, id: 'a3', performance: tracked }] } },
  }, { now: at(20) });

  assert.equal(tracked.phaseStartedAt, at(0));
  assert.deepEqual(tracked.coverage.notes, []);
  assert.equal(report.coverage.withPerformance, 1);
  assert.equal(report.coverage.missingPerformance, 2);
  assert.equal(report.tasks[0].attempts[0].elapsedMs.total, null);
  assert.equal(report.tasks[0].attempts[1].elapsedMs.total, null);
  assert.equal(report.tasks[0].attempts[1].coverage.timing, 'unknown');
});

test('blocked time is tracked separately from model execution time', () => {
  const running = withPerformance({ id: 'a1', taskId: 'task', status: 'running' }, at(0));
  const blockedAttempt = {
    ...running,
    status: 'needs_input',
    lastError: { code: 'missing_result', message: 'do not leak this' },
  };
  const blockedPerf = trackAttempt(running, blockedAttempt, at(1));
  const stillBlocked = trackAttempt({ ...blockedAttempt, performance: blockedPerf }, { ...blockedAttempt, observedAt: at(2) }, at(2));
  const resumed = trackAttempt({ ...blockedAttempt, performance: stillBlocked }, { ...blockedAttempt, status: 'running', lastError: null }, at(3));

  assert.equal(blockedPerf.durationsMs.execute, 1000);
  assert.equal(stillBlocked.blockedMs, 0);
  assert.equal(resumed.blockedMs, 2000);
  assert.equal(resumed.durationsMs.execute, 1000);
  assert.equal(resumed.phase, 'execute');
});

test('blocked and terminal statuses override explicit executionPhase', () => {
  const running = withPerformance({ id: 'a1', taskId: 'task', status: 'running', executionPhase: 'execute' }, at(0));
  const blocked = trackAttempt(running, { ...running, status: 'needs_input', executionPhase: 'execute' }, at(1));
  const cancelled = trackAttempt({ ...running, performance: blocked }, { ...running, status: 'cancelled', executionPhase: 'execute' }, at(2));

  assert.equal(blocked.phase, 'blocked');
  assert.equal(blocked.durationsMs.execute, 1000);
  assert.equal(cancelled.phase, 'finished');
  assert.equal(cancelled.blockedMs, 1000);
});

test('historical interrupted retries stop blocked accrual at the next attempt', () => {
  const running = withPerformance({ id: 'a1', taskId: 'task', status: 'running', createdAt: at(0) }, at(0));
  const interruptedAttempt = {
    id: 'a1',
    taskId: 'task',
    status: 'interrupted',
    createdAt: at(0),
    performance: trackAttempt(running, { id: 'a1', taskId: 'task', status: 'interrupted', createdAt: at(0), lastError: { code: 'agent_not_found' } }, at(1)),
  };
  const retry = { id: 'a2', taskId: 'task', status: 'running', createdAt: at(5), performance: trackAttempt(null, { id: 'a2', taskId: 'task', status: 'running', createdAt: at(5) }, at(5)) };
  const report = summarizeRun({
    id: 'run',
    tasks: { task: { definition: { id: 'task' }, currentAttempt: 'a2', attempts: [interruptedAttempt, retry] } },
  }, { now: at(10) });

  assert.equal(report.tasks[0].attempts[0].blockedMs, 4000);
  assert.equal(report.tasks[0].attempts[0].elapsedMs.live, 4000);
  assert.equal(report.totals.totalBlockedMs, 4000);
});

test('summarizeRun preserves retries, failures, cancels, unjudged outcomes, and sanitized details', () => {
  const failedIntegration = {
    id: 'task-a-a1',
    taskId: 'task-a',
    number: 1,
    status: 'integration_failed',
    lastError: { code: 'integration_conflict', message: 'secret error text' },
    execution: { profile: { apiKey: 'secret-profile-token' } },
    performance: trackAttempt(null, { id: 'task-a-a1', taskId: 'task-a', status: 'integration_failed', lastError: { code: 'integration_conflict', message: 'secret error text' } }, at(4)),
  };
  const accepted = {
    id: 'task-b-a1',
    taskId: 'task-b',
    number: 1,
    status: 'accepted',
    verification: { passed: true, finishedAt: at(5), checks: [] },
    performance: trackAttempt(null, { id: 'task-b-a1', taskId: 'task-b', status: 'accepted' }, at(5)),
  };
  const integrated = {
    id: 'task-b-a2',
    taskId: 'task-b',
    number: 2,
    previousAttempt: 'task-b-a1',
    status: 'integrated',
    integration: { passed: true, stable: true, evidence: '/tmp/evidence.json' },
    performance: trackAttempt(null, { id: 'task-b-a2', taskId: 'task-b', status: 'integrated' }, at(8)),
  };
  const cancelled = {
    id: 'task-c-a1',
    taskId: 'task-c',
    number: 1,
    status: 'cancelled',
    performance: trackAttempt(null, { id: 'task-c-a1', taskId: 'task-c', status: 'cancelled' }, at(6)),
  };
  const running = {
    id: 'task-d-a1',
    taskId: 'task-d',
    number: 1,
    status: 'running',
    performance: trackAttempt(null, { id: 'task-d-a1', taskId: 'task-d', status: 'running' }, at(7)),
  };
  const report = summarizeRun({
    id: 'run',
    schemaVersion: 1,
    createdAt: at(0),
    tasks: {
      'task-a': { definition: { id: 'task-a', isolation: 'worktree', deadlineAt: at(59) }, currentAttempt: 'task-a-a1', attempts: [failedIntegration] },
      'task-b': { definition: { id: 'task-b' }, currentAttempt: 'task-b-a2', attempts: [accepted, integrated] },
      'task-c': { definition: { id: 'task-c' }, currentAttempt: 'task-c-a1', attempts: [cancelled] },
      'task-d': { definition: { id: 'task-d' }, currentAttempt: 'task-d-a1', attempts: [running] },
    },
  }, { now: at(10) });
  const serialized = JSON.stringify(report);

  assert.deepEqual(report.outcomes.acceptedAttemptIds.sort(), ['task-b-a1', 'task-b-a2']);
  assert.deepEqual(report.outcomes.integratedAttemptIds, ['task-b-a2']);
  assert.deepEqual(report.outcomes.tasksFailed, ['task-a']);
  assert.deepEqual(report.outcomes.tasksCancelled, ['task-c']);
  assert.deepEqual(report.outcomes.tasksUnjudged, ['task-d']);
  assert.equal(report.accuracy.denominator, 5);
  assert.equal(report.accuracy.numerator, 2);
  assert.equal(report.outcomes.projectAcceptance, 'unknown');
  assert.equal(report.tasks[0].deadlineAt, at(59));
  assert.equal(report.totals.totalElapsedMsLabel, 'sum_observed_attempt_durations_ms');
  assert.equal(report.totals.runWallMs, 10000);
  assert.equal(serialized.includes('secret error text'), false);
  assert.equal(serialized.includes('secret-profile-token'), false);
});

test('summarizeTask does not substitute an old attempt for an invalid current pointer', () => {
  const accepted = {
    id: 'a1',
    taskId: 'task',
    status: 'accepted',
    performance: trackAttempt(null, { id: 'a1', taskId: 'task', status: 'accepted' }, at(1)),
  };
  const report = summarizeRun({
    id: 'run',
    tasks: { task: { definition: { id: 'task' }, currentAttempt: 'missing', attempts: [accepted] } },
  }, { now: at(10) });
  assert.equal(report.tasks[0].outcome.currentStatus, null);
  assert.equal(report.tasks[0].outcome.invalidCurrentAttempt, true);
});

test('accepted idle time before integration is unassigned rather than live model time', () => {
  const accepted = {
    id: 'a1',
    taskId: 'task',
    status: 'accepted',
    performance: trackAttempt(null, { id: 'a1', taskId: 'task', status: 'accepted' }, at(1)),
  };
  const report = summarizeRun({
    id: 'run',
    tasks: { task: { definition: { id: 'task' }, currentAttempt: 'a1', attempts: [accepted] } },
  }, { now: at(10) });

  assert.equal(report.tasks[0].attempts[0].elapsedMs.live, 0);
  assert.equal(report.tasks[0].attempts[0].elapsedMs.total, 0);
});

test('deadline cancellations are reported separately from user cancellations', () => {
  const timedOut = {
    id: 'a1',
    taskId: 'task',
    status: 'cancelled',
    cancelReason: 'deadline',
    deadlineExceededAt: at(9),
    performance: trackAttempt(null, { id: 'a1', taskId: 'task', status: 'cancelled', cancelReason: 'deadline', deadlineExceededAt: at(9) }, at(9)),
  };
  const userCancelled = {
    id: 'a2',
    taskId: 'other',
    status: 'cancelled',
    cancelReason: 'user',
    performance: trackAttempt(null, { id: 'a2', taskId: 'other', status: 'cancelled', cancelReason: 'user' }, at(9)),
  };
  const report = summarizeRun({
    id: 'run',
    tasks: {
      task: { definition: { id: 'task' }, currentAttempt: 'a1', attempts: [timedOut] },
      other: { definition: { id: 'other' }, currentAttempt: 'a2', attempts: [userCancelled] },
    },
  }, { now: at(10) });

  assert.equal(report.totals.cancelledAttempts, 2);
  assert.equal(report.totals.timedOutAttempts, 1);
  assert.deepEqual(report.outcomes.tasksTimedOut, ['task']);
  assert.equal(report.tasks[0].attempts[0].outcome.timedOut, true);
  assert.equal(report.tasks[0].attempts[0].evidence.deadlineExceededAt, at(9));
});

test('coverage reports performance event log completeness without fabricating legacy success', () => {
  const attempt = { id: 'a1', taskId: 'task', status: 'running', performance: trackAttempt(null, { id: 'a1', taskId: 'task', status: 'running' }, at(1)) };
  const incomplete = summarizeRun({
    id: 'run',
    performanceRevision: 3,
    performanceEventsIncomplete: true,
    tasks: { task: { definition: { id: 'task' }, currentAttempt: 'a1', attempts: [attempt] } },
  }, { now: at(2) });
  const complete = summarizeRun({
    id: 'run',
    performanceRevision: 3,
    performanceRecordedRevision: 3,
    tasks: { task: { definition: { id: 'task' }, currentAttempt: 'a1', attempts: [attempt] } },
  }, { now: at(2) });
  const legacy = summarizeRun({
    id: 'run',
    tasks: { task: { definition: { id: 'task' }, currentAttempt: 'a1', attempts: [attempt] } },
  }, { now: at(2) });

  assert.equal(incomplete.coverage.eventLogComplete, false);
  assert.equal(complete.coverage.eventLogComplete, true);
  assert.equal(legacy.coverage.eventLogComplete, null);
  assert.equal(summarizeRun({ id: 'crashed', tasks: {}, performanceRevision: 3, performanceRecordedRevision: 2 }, { now: at(10) }).coverage.eventLogComplete, false);
});

test('publicPerformance exposes sanitized helper output', () => {
  const attempt = {
    id: 'a1',
    taskId: 'task',
    status: 'needs_input',
    deadlineAt: at(20),
    lastError: { code: 'stale_result', message: 'raw prompt content' },
    report: { status: 'needs_input', changedFiles: [], checks: [], children: [{ id: 'child', status: 'running' }], unresolved: ['secret question'] },
  };
  const tracked = { ...attempt, performance: trackAttempt(null, attempt, at(1)) };
  const value = publicPerformance(tracked, { now: at(2) });

  assert.equal(value.blocker.kind, 'needs_input');
  assert.equal(value.blocker.category, 'result_contract');
  assert.equal(value.blocker.openChildCount, 1);
  assert.equal(value.evidence.deadlineAt, at(20));
  assert.equal(JSON.stringify(value).includes('raw prompt content'), false);
  assert.equal(JSON.stringify(value).includes('secret question'), false);
});

test('blocker classification separates permission, auth, env, children, and deadline categories', () => {
  const cases = [
    ['permission_denied', 'permission'],
    ['auth_missing', 'auth'],
    ['environment_invalid', 'environment'],
    ['child_budget_exceeded', 'children'],
    ['deadline_expired', 'deadline'],
  ];
  for (const [code, category] of cases) {
    const value = publicPerformance({
      id: `a-${code}`,
      taskId: 'task',
      status: 'needs_input',
      lastError: { code, message: 'private detail' },
      performance: trackAttempt(null, { id: `a-${code}`, taskId: 'task', status: 'needs_input', lastError: { code, message: 'private detail' } }, at(1)),
    }, { now: at(2) });
    assert.equal(value.blocker.category, category);
    assert.equal(JSON.stringify(value).includes('private detail'), false);
  }
});
