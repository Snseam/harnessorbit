import crypto from 'node:crypto';
import { invariant } from './errors.mjs';

export const RUNTIME_EVENT_SCHEMA_VERSION = 1;
export const ATTEMPT_STATES = Object.freeze([
  'preparing', 'launching', 'running', 'needs_input', 'ready', 'collecting', 'sending', 'uncertain',
  'submitted', 'verifying', 'accepted', 'integrating', 'integrated', 'integration_failed', 'integration_cancelled',
  'rework', 'failed', 'interrupted', 'cancelling', 'cancelled', 'timed_out',
]);
const STATE_SET = new Set(ATTEMPT_STATES);
const MAX_CODE = 128;
const MAX_TEXT = 256;
const MAX_PATH = 2048;
const ERROR_RE = /^[a-z][a-z0-9_.-]{0,127}$/;
const EVENT_RE = /^[a-z][a-z0-9_.-]{1,127}$/;

function clip(value, max = MAX_TEXT) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function cleanCode(value) {
  return typeof value === 'string' && ERROR_RE.test(value) && !/(secret|token|password|credential|authorization)/i.test(value) ? value : null;
}

function cleanId(value) {
  return clip(value, MAX_CODE);
}

function cleanSequence(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function cleanNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function copyCommon(event, { runId = null, eventId = null } = {}) {
  invariant(event && typeof event === 'object' && !Array.isArray(event), 'invalid_event', 'Runtime event must be an object.');
  invariant(typeof event.type === 'string' && EVENT_RE.test(event.type), 'invalid_event', 'Runtime event type is invalid.');
  const requestedRunProvided = runId !== null && runId !== undefined;
  const requestedRunId = cleanId(runId);
  invariant(!requestedRunProvided || requestedRunId, 'invalid_event', 'Requested runtime event runId is invalid.');
  const eventRunProvided = event.runId !== null && event.runId !== undefined;
  const eventRunId = cleanId(event.runId);
  invariant(!eventRunProvided || eventRunId, 'invalid_event', 'Runtime event runId is invalid.');
  invariant(!requestedRunId || !eventRunId || requestedRunId === eventRunId, 'invalid_event', 'Runtime event runId does not match the requested run.');
  const safeRunId = eventRunId || requestedRunId;
  const safeEventId = cleanId(event.eventId) || cleanId(eventId);
  invariant(safeEventId, 'invalid_event', 'Runtime event id is required.');
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: safeEventId,
    type: event.type,
    ...(safeRunId ? { runId: safeRunId } : {}),
    ...(typeof event.timestamp === 'string' ? { timestamp: event.timestamp } : {}),
  };
}

function copyTaskAttempt(event, output) {
  const taskId = cleanId(event.taskId);
  const attemptId = cleanId(event.attemptId);
  invariant(taskId && attemptId, 'invalid_event', 'Runtime task and attempt ids are required.');
  output.taskId = taskId;
  output.attemptId = attemptId;
  return output;
}

function cleanDurations(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const durations = {};
  for (const [key, duration] of Object.entries(value)) {
    if (!ERROR_RE.test(key)) continue;
    const safeDuration = cleanNumber(duration);
    if (safeDuration !== null) durations[key] = safeDuration;
  }
  return Object.keys(durations).length ? durations : null;
}

function cleanObservedAttempt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const taskId = cleanId(value.taskId);
  const attemptId = cleanId(value.attemptId);
  const status = isAttemptState(value.status) ? value.status : null;
  if (!taskId || !attemptId || !status) return null;
  const durationsMs = cleanDurations(value.durationsMs);
  const blockedMs = cleanNumber(value.blockedMs);
  return {
    taskId,
    attemptId,
    status,
    ...(clip(value.phase, MAX_CODE) ? { phase: clip(value.phase, MAX_CODE) } : {}),
    ...(durationsMs ? { durationsMs } : {}),
    ...(blockedMs !== null ? { blockedMs } : {}),
    ...(typeof value.lastProgressAt === 'string' ? { lastProgressAt: value.lastProgressAt } : {}),
  };
}

export function isAttemptState(value) {
  return STATE_SET.has(value);
}

export function createAttemptEvent({
  runId,
  taskId,
  attemptId,
  from,
  to,
  errorCode = null,
  phase = null,
  source = 'orchestrator',
  sequence = null,
} = {}) {
  invariant(typeof runId === 'string' && runId.length > 0, 'invalid_event', 'runId is required.');
  invariant(typeof taskId === 'string' && taskId.length > 0, 'invalid_event', 'taskId is required.');
  invariant(typeof attemptId === 'string' && attemptId.length > 0, 'invalid_event', 'attemptId is required.');
  invariant(isAttemptState(from) && isAttemptState(to), 'invalid_event', 'Attempt state transition is invalid.', { from, to });
  const safeError = errorCode === null ? null : cleanCode(errorCode);
  invariant(errorCode === null || safeError, 'invalid_event', 'errorCode is invalid.');
  const safePhase = phase === null ? null : clip(phase, MAX_CODE);
  const safeSource = clip(source, MAX_CODE) || 'orchestrator';
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId: crypto.randomUUID(),
    type: 'attempt.state',
    runId,
    taskId,
    attemptId,
    from,
    to,
    ...(safeError ? { errorCode: safeError } : {}),
    ...(safePhase ? { phase: safePhase } : {}),
    source: safeSource,
    ...(Number.isInteger(sequence) && sequence >= 0 ? { sequence } : {}),
  };
}

export function assertRuntimeEvent(event) {
  invariant(event && typeof event === 'object' && !Array.isArray(event), 'invalid_event', 'Runtime event must be an object.');
  invariant(event.schemaVersion === RUNTIME_EVENT_SCHEMA_VERSION, 'invalid_event', 'Unsupported runtime event schema.');
  invariant(typeof event.eventId === 'string' && event.eventId.length > 0, 'invalid_event', 'Runtime event id is required.');
  invariant(typeof event.type === 'string' && EVENT_RE.test(event.type), 'invalid_event', 'Runtime event type is invalid.');
  if (event.type === 'attempt.state') {
    invariant(isAttemptState(event.from) && isAttemptState(event.to), 'invalid_event', 'Runtime transition states are invalid.');
    invariant(event.errorCode === undefined || cleanCode(event.errorCode), 'invalid_event', 'Runtime event errorCode is invalid.');
  }
  return true;
}

export function normalizeRuntimeEvent(event, options = {}) {
  const output = copyCommon(event, options);
  const sequence = cleanSequence(event.sequence);
  if (sequence !== null) output.sequence = sequence;

  if (event.type === 'run.created') {
    const project = clip(event.project, MAX_PATH);
    if (project) output.project = project;
  } else if (event.type === 'attempt.reserved') {
    copyTaskAttempt(event, output);
  } else if (event.type === 'worker.input') {
    copyTaskAttempt(event, output);
    invariant(['keys', 'text'].includes(event.inputKind), 'invalid_event', 'Runtime input kind is invalid.');
    output.inputKind = event.inputKind;
  } else if (event.type === 'attempt.state') {
    copyTaskAttempt(event, output);
    invariant(isAttemptState(event.from) && isAttemptState(event.to), 'invalid_event', 'Runtime transition states are invalid.');
    output.from = event.from;
    output.to = event.to;
    const errorCode = cleanCode(event.errorCode);
    const phase = clip(event.phase, MAX_CODE);
    const source = clip(event.source, MAX_CODE);
    if (errorCode) output.errorCode = errorCode;
    if (phase) output.phase = phase;
    if (source) output.source = source;
  } else if (event.type === 'performance.observed') {
    if (event.ownerEpoch === null || typeof event.ownerEpoch === 'string' || Number.isInteger(event.ownerEpoch)) output.ownerEpoch = event.ownerEpoch;
    const attempts = Array.isArray(event.attempts) ? event.attempts.map(cleanObservedAttempt).filter(Boolean) : null;
    invariant(attempts && attempts.length > 0, 'invalid_event', 'Runtime performance event attempts are invalid.');
    output.attempts = attempts;
  }

  assertRuntimeEvent(output);
  return output;
}

export function attemptSnapshot({ runId, taskId, task, attempt } = {}) {
  invariant(attempt && typeof attempt === 'object', 'invalid_attempt', 'Attempt is required.');
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    runId: clip(runId, 128),
    taskId: clip(taskId || attempt.taskId, 128),
    attemptId: clip(attempt.id, 128),
    status: isAttemptState(attempt.status) ? attempt.status : 'failed',
    number: Number.isInteger(attempt.number) ? attempt.number : null,
    executorKind: attempt.executorKind === 'host' ? 'host' : 'external',
    workerClosed: attempt.workerClosed === true,
    lastErrorCode: cleanCode(attempt.lastError?.code),
    deadlineAt: typeof attempt.deadlineAt === 'string' ? attempt.deadlineAt : task?.definition?.deadlineAt || null,
    baselineDigest: typeof attempt.baseline?.digest === 'string' ? attempt.baseline.digest : null,
  };
}

export function summarizeRun(run) {
  const counts = Object.fromEntries(ATTEMPT_STATES.map(state => [state, 0]));
  const tasks = Object.values(run?.tasks || {});
  let invalidCurrentAttemptCount = 0;
  for (const task of tasks) {
    const attempt = task?.attempts?.find(item => item.id === task.currentAttempt);
    if (Array.isArray(task?.attempts) && task.attempts.length > 0 && !attempt) invalidCurrentAttemptCount += 1;
    if (attempt && counts[attempt.status] !== undefined) counts[attempt.status]++;
  }
  return {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    runId: typeof run?.id === 'string' ? run.id : null,
    project: typeof run?.project === 'string' ? run.project : null,
    taskCount: tasks.length,
    counts,
    invalidCurrentAttemptCount,
    authoritativeState: 'run.json',
  };
}
