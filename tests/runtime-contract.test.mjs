import test from 'node:test';
import assert from 'node:assert/strict';
import { OrchestratorError } from '../src/errors.mjs';
import {
  ATTEMPT_STATES,
  RUNTIME_EVENT_SCHEMA_VERSION,
  assertRuntimeEvent,
  attemptSnapshot,
  createAttemptEvent,
  normalizeRuntimeEvent,
  summarizeRun,
} from '../src/runtime-contract.mjs';

test('runtime attempt event has a stable schema and bounded error code', () => {
  const event = createAttemptEvent({ runId: 'run1', taskId: 'task1', attemptId: 'attempt1', from: 'running', to: 'failed', errorCode: 'provider_timeout', phase: 'collect' });
  assert.equal(event.schemaVersion, RUNTIME_EVENT_SCHEMA_VERSION);
  assert.equal(event.type, 'attempt.state');
  assert.equal(event.errorCode, 'provider_timeout');
  assert.equal(assertRuntimeEvent(event), true);
});

test('runtime contract rejects unknown state and unbounded error code', () => {
  assert.throws(() => createAttemptEvent({ runId: 'r', taskId: 't', attemptId: 'a', from: 'running', to: 'not-a-state' }), OrchestratorError);
  assert.throws(() => createAttemptEvent({ runId: 'r', taskId: 't', attemptId: 'a', from: 'running', to: 'failed', errorCode: 'bad code' }), OrchestratorError);
});

test('attempt snapshots and run summaries expose state without raw reports or prompts', () => {
  const snapshot = attemptSnapshot({
    runId: 'run1', taskId: 'task1',
    task: { definition: { deadlineAt: '2026-09-24T00:00:00.000Z' } },
    attempt: { id: 'a1', status: 'accepted', number: 1, executorKind: 'external', workerClosed: true, lastError: { code: 'secret-token' }, baseline: { digest: 'abc' } },
  });
  assert.equal(snapshot.status, 'accepted');
  assert.equal(snapshot.lastErrorCode, null);
  assert.equal(snapshot.baselineDigest, 'abc');
  const summary = summarizeRun({ id: 'run1', project: '/tmp/project', tasks: {
    task1: { attempts: [{ id: 'a1', status: 'accepted' }], currentAttempt: 'a1' },
    task2: { attempts: [{ id: 'a2', status: 'failed' }], currentAttempt: 'a2' },
  } });
  assert.equal(summary.authoritativeState, 'run.json');
  assert.equal(summary.taskCount, 2);
  assert.equal(summary.counts.accepted, 1);
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.invalidCurrentAttemptCount, 0);
  assert.deepEqual(Object.keys(summary.counts).sort(), [...ATTEMPT_STATES].sort());
});

test('run summaries do not substitute an old attempt for an invalid current pointer', () => {
  const summary = summarizeRun({ id: 'run1', project: '/tmp/project', tasks: {
    task1: { attempts: [{ id: 'old', status: 'accepted' }], currentAttempt: 'missing' },
  } });
  assert.equal(summary.counts.accepted, 0);
  assert.equal(summary.invalidCurrentAttemptCount, 1);
});

test('runtime event normalization keeps legacy events compatible and bounded', () => {
  const event = normalizeRuntimeEvent({
    type: 'attempt.state', taskId: 'task1', attemptId: 'a1',
    from: 'running', to: 'accepted', secret: 'must not survive',
  }, { runId: 'run1', eventId: 'legacy:1' });
  assert.deepEqual(event, {
    schemaVersion: 1,
    eventId: 'legacy:1',
    type: 'attempt.state',
    runId: 'run1',
    taskId: 'task1',
    attemptId: 'a1',
    from: 'running',
    to: 'accepted',
  });
});

test('runtime event normalization rejects events from a different run', () => {
  assert.throws(
    () => normalizeRuntimeEvent({ schemaVersion: 1, eventId: 'event-1', type: 'run.created', runId: 'run-2', project: '/tmp/project' }, { runId: 'run-1' }),
    error => error.code === 'invalid_event',
  );
  assert.throws(
    () => normalizeRuntimeEvent({ schemaVersion: 1, eventId: 'event-2', type: 'run.created', runId: 'r'.repeat(129), project: '/tmp/project' }, { runId: 'run-1' }),
    error => error.code === 'invalid_event',
  );
});
