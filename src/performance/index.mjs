const VERSION = 1;

const TRACKED_PHASES = ['prepare', 'launch', 'execute', 'collect', 'verify', 'integrate'];
const DURATION_KEYS = Object.freeze(Object.fromEntries(TRACKED_PHASES.map(phase => [phase, 0])));
const FINISHED_STATUSES = new Set([
  'accepted',
  'integrated',
  'rework',
  'failed',
  'cancelled',
  'canceled',
  'integration_failed',
  'integration_cancelled',
]);
const BLOCKED_STATUSES = new Set(['needs_input', 'uncertain', 'interrupted']);

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function validIso(value) {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function safeIso(value) {
  return validIso(value) ? value : null;
}

function msBetween(startIso, endIso) {
  if (!validIso(startIso) || !validIso(endIso)) return 0;
  return Math.max(0, Date.parse(endIso) - Date.parse(startIso));
}

function emptyDurations() {
  return { ...DURATION_KEYS };
}

function normalizeDurations(value) {
  const durations = emptyDurations();
  if (!isObject(value)) return durations;
  for (const phase of TRACKED_PHASES) {
    const ms = value[phase];
    durations[phase] = Number.isFinite(ms) && ms > 0 ? Math.trunc(ms) : 0;
  }
  return durations;
}

function addDuration(durations, phase, ms) {
  if (!TRACKED_PHASES.includes(phase) || !Number.isFinite(ms) || ms <= 0) return durations;
  return { ...durations, [phase]: durations[phase] + Math.trunc(ms) };
}

function explicitPhase(attempt) {
  const phase = attempt?.executionPhase;
  if (TRACKED_PHASES.includes(phase) || phase === 'blocked' || phase === 'finished' || phase === 'unknown') return phase;
  return null;
}

function inferPhase(attempt) {
  switch (attempt?.status) {
    case 'needs_input':
    case 'uncertain':
    case 'interrupted':
      return 'blocked';
    case 'accepted':
    case 'integrated':
    case 'rework':
    case 'failed':
    case 'cancelled':
    case 'canceled':
    case 'integration_failed':
    case 'integration_cancelled':
      return 'finished';
    default:
      break;
  }
  const phase = explicitPhase(attempt);
  if (phase) return phase;
  switch (attempt?.status) {
    case 'preparing':
      return 'prepare';
    case 'launching':
    case 'ready':
      return 'launch';
    case 'sending':
    case 'running':
      return 'execute';
    case 'submitted':
      return 'collect';
    case 'verifying':
      return 'verify';
    case 'integrating':
      return 'integrate';
    default:
      return 'unknown';
  }
}

function codeOf(value) {
  return typeof value?.code === 'string' && value.code ? value.code : null;
}

function classifyErrorCode(code) {
  if (!code) return 'unknown';
  if (['cancel_requested', 'command_cancelled'].includes(code) || code.includes('cancel')) return 'cancelled';
  if (code.includes('deadline') || code === 'timeout_deadline') return 'deadline';
  if (code.includes('permission') || code.includes('denied') || code === 'eacces') return 'permission';
  if (code.includes('auth') || code.includes('credential') || code.includes('token')) return 'auth';
  if (code.includes('env') || code.includes('environment') || code.includes('profile') || code.includes('materialize')) return 'environment';
  if (['agent_not_found', 'agent_not_running', 'pane_not_found', 'startup_interrupted'].includes(code) || code.includes('interrupted')) return 'runtime_interrupted';
  if (['identity_changed', 'identity_unavailable'].includes(code)) return 'identity';
  if (code.includes('child')) return 'children';
  if (['missing_result', 'invalid_result', 'stale_result'].includes(code) || code.includes('result')) return 'result_contract';
  if (code.includes('timeout') || code.includes('uncertain')) return 'delivery_uncertain';
  if (code.includes('integration')) return 'integration';
  if (code.includes('scope')) return 'scope';
  return 'error';
}

function blockerKind(attempt) {
  if (!BLOCKED_STATUSES.has(attempt?.status)) return null;
  if (attempt.status === 'needs_input') return 'needs_input';
  if (attempt.status === 'uncertain') return 'uncertain';
  return 'interrupted';
}

function blockerFor(attempt) {
  const kind = blockerKind(attempt);
  if (!kind) return null;
  const errorCode = codeOf(attempt.lastError) || (attempt.lastObservedState === 'blocked' ? 'worker_blocked' : null);
  const children = Array.isArray(attempt.report?.children) ? attempt.report.children : [];
  const unresolved = Array.isArray(attempt.report?.unresolved) ? attempt.report.unresolved : [];
  const outsideScope = Array.isArray(attempt.outsideScope) ? attempt.outsideScope : [];
  const openChildren = children.filter(child => ['running', 'unknown'].includes(child?.status)).length;
  const resultStatus = typeof attempt.report?.status === 'string' ? attempt.report.status : null;
  const parts = [
    kind,
    errorCode || 'no_code',
    resultStatus || 'no_result',
    `children:${openChildren}`,
    `unresolved:${unresolved.length}`,
    `scope:${outsideScope.length}`,
  ];
  return {
    kind,
    fingerprint: parts.join('|'),
    category: classifyErrorCode(errorCode),
    errorCode,
    resultStatus,
    unresolvedCount: unresolved.length,
    openChildCount: openChildren,
    outsideScopeCount: outsideScope.length,
  };
}

function checkSummary(check) {
  return {
    name: typeof check?.name === 'string' ? check.name : null,
    status: typeof check?.status === 'string' ? check.status : null,
    code: Number.isInteger(check?.code) ? check.code : null,
    errorCode: codeOf(check?.error),
  };
}

function progressState(attempt) {
  const report = isObject(attempt?.report) ? attempt.report : null;
  const verification = isObject(attempt?.verification) ? attempt.verification : null;
  const integration = isObject(attempt?.integration) ? attempt.integration : null;
  return {
    status: attempt?.status ?? null,
    phase: inferPhase(attempt),
    cancelRequested: attempt?.cancelRequested === true,
    workerClosed: attempt?.workerClosed === true,
    checkoutReleased: attempt?.checkoutReleased === true,
    paneReady: Boolean(attempt?.paneId && attempt?.terminalId),
    submissionStartedAt: safeIso(attempt?.submissionStartedAt),
    submissionAcknowledgedAt: safeIso(attempt?.submissionAcknowledgedAt),
    launchFinishedAt: safeIso(attempt?.launchFinishedAt),
    runtimeReleasedAt: safeIso(attempt?.runtimeReleasedAt),
    snapshotHash: typeof attempt?.snapshot?.hash === 'string' ? attempt.snapshot.hash : null,
    changedPathsCount: Array.isArray(attempt?.changedPaths) ? attempt.changedPaths.length : null,
    outsideScopeCount: Array.isArray(attempt?.outsideScope) ? attempt.outsideScope.length : null,
    reportStatus: report?.status ?? null,
    reportChangedFilesCount: Array.isArray(report?.changedFiles) ? report.changedFiles.length : null,
    reportCheckStatuses: Array.isArray(report?.checks) ? report.checks.map(check => check?.status ?? null) : null,
    reportChildStatuses: Array.isArray(report?.children) ? report.children.map(child => child?.status ?? null) : null,
    reportUnresolvedCount: Array.isArray(report?.unresolved) ? report.unresolved.length : null,
    verification: verification ? {
      passed: verification.passed === true,
      finishedAt: safeIso(verification.finishedAt),
      errorCode: codeOf(verification.error),
      checks: Array.isArray(verification.checks) ? verification.checks.map(checkSummary) : [],
    } : null,
    integration: integration ? {
      passed: integration.passed === true,
      stable: integration.stable === true,
      snapshotHash: typeof integration.snapshotHash === 'string' ? integration.snapshotHash : null,
    } : null,
    operation: isObject(attempt?.operation) ? {
      kind: typeof attempt.operation.kind === 'string' ? attempt.operation.kind : null,
      finishedAt: safeIso(attempt.operation.finishedAt),
    } : null,
    lastErrorCode: codeOf(attempt?.lastError),
    blocker: blockerFor(attempt),
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function progressSource(previousState, currentState) {
  if (!previousState) return 'state';
  if (previousState.status !== currentState.status || previousState.phase !== currentState.phase) return 'state';
  if (stableStringify(previousState.blocker) !== stableStringify(currentState.blocker)) return 'blocker';
  return 'evidence';
}

function initialPhaseStartedAt(attempt, nowIso) {
  return safeIso(attempt?.performance?.phaseStartedAt) ?? nowIso;
}

function unknownPrehistory(previousPerformance, currentAttempt, previousAttempt) {
  const notes = Array.isArray(previousPerformance?.coverage?.notes) ? [...previousPerformance.coverage.notes] : [];
  if (!previousPerformance && previousAttempt) notes.push('legacy_previous_attempt_without_performance');
  return [...new Set(notes)];
}

function maxIso(a, b) {
  if (!validIso(a)) return b;
  if (!validIso(b)) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function minIso(...values) {
  const valid = values.filter(validIso);
  if (!valid.length) return null;
  return valid.reduce((earliest, value) => Date.parse(value) < Date.parse(earliest) ? value : earliest);
}

function effectiveNow(previousPerformance, nowIso) {
  return maxIso(nowIso, previousPerformance?.updatedAt);
}

function mergeCoverage(previousPerformance, currentAttempt, previousAttempt, nowIso, effectiveNowIso) {
  const notes = unknownPrehistory(previousPerformance, currentAttempt, previousAttempt);
  const clockRegression = validIso(nowIso) && validIso(effectiveNowIso) && Date.parse(nowIso) < Date.parse(effectiveNowIso);
  if (clockRegression) notes.push('clock_regression_ignored');
  const startedAt = previousPerformance?.coverage?.startedAt ?? safeIso(currentAttempt?.createdAt) ?? nowIso;
  return {
    startedAt,
    hasLegacyPrehistory: notes.some(note => note.includes('legacy')),
    notes: [...new Set(notes)],
  };
}

function closePreviousPhase(previousPerformance, nextPhase, nowIso) {
  let durationsMs = normalizeDurations(previousPerformance?.durationsMs);
  const previousPhase = previousPerformance?.phase;
  if (previousPhase !== nextPhase && TRACKED_PHASES.includes(previousPhase)) {
    durationsMs = addDuration(durationsMs, previousPhase, msBetween(previousPerformance.phaseStartedAt, nowIso));
  }
  return durationsMs;
}

function updateBlocked(previousPerformance, currentBlocker, nowIso) {
  const previousBlocker = previousPerformance?.blocker ?? null;
  let blockedMs = Number.isFinite(previousPerformance?.blockedMs) && previousPerformance.blockedMs > 0 ? Math.trunc(previousPerformance.blockedMs) : 0;
  let blockedStartedAt = previousPerformance?.blockedStartedAt ?? null;
  if (previousBlocker && (!currentBlocker || currentBlocker.fingerprint !== previousBlocker.fingerprint)) {
    blockedMs += msBetween(blockedStartedAt, nowIso);
    blockedStartedAt = null;
  }
  if (currentBlocker && (!previousBlocker || currentBlocker.fingerprint !== previousBlocker.fingerprint)) {
    blockedStartedAt = nowIso;
  }
  if (!currentBlocker) blockedStartedAt = null;
  return { blockedMs, blockedStartedAt };
}

export function trackAttempt(previousAttempt, currentAttempt, nowIso = new Date().toISOString()) {
  if (!isObject(currentAttempt)) throw new TypeError('currentAttempt must be an object');
  if (!validIso(nowIso)) throw new TypeError('nowIso must be an ISO timestamp with millisecond precision');
  const previousPerformance = isObject(previousAttempt?.performance) ? previousAttempt.performance : null;
  const effectiveNowIso = effectiveNow(previousPerformance, nowIso);
  const currentState = progressState(currentAttempt);
  const previousState = previousPerformance?.progressFingerprint ? previousPerformance.progressState ?? null : null;
  const progressFingerprint = stableStringify(currentState);
  const progressed = progressFingerprint !== previousPerformance?.progressFingerprint;
  const phase = inferPhase(currentAttempt);
  const phaseChanged = previousPerformance?.phase && previousPerformance.phase !== phase;
  const durationsMs = closePreviousPhase(previousPerformance, phase, effectiveNowIso);
  const blocker = currentState.blocker;
  const blocked = updateBlocked(previousPerformance, blocker, effectiveNowIso);
  const lastObservedAt = safeIso(currentAttempt.observedAt) ?? previousPerformance?.lastObservedAt ?? null;
  const phaseStartedAt = previousPerformance
    ? (phaseChanged ? effectiveNowIso : previousPerformance.phaseStartedAt ?? effectiveNowIso)
    : initialPhaseStartedAt(currentAttempt, effectiveNowIso);
  const coverage = mergeCoverage(previousPerformance, currentAttempt, previousAttempt, nowIso, effectiveNowIso);

  return {
    version: VERSION,
    phase,
    phaseStartedAt,
    durationsMs,
    blockedMs: blocked.blockedMs,
    blockedStartedAt: blocked.blockedStartedAt,
    lastObservedAt,
    lastProgressAt: progressed ? effectiveNowIso : previousPerformance?.lastProgressAt ?? effectiveNowIso,
    progressSource: progressed ? progressSource(previousState, currentState) : previousPerformance?.progressSource ?? 'state',
    blocker,
    progressFingerprint,
    progressState: currentState,
    coverage,
    updatedAt: effectiveNowIso,
  };
}

function currentPhaseLiveMs(performance, nowIso, capIso = null) {
  if (!TRACKED_PHASES.includes(performance?.phase)) return 0;
  return msBetween(performance.phaseStartedAt, minIso(nowIso, capIso) ?? nowIso);
}

function currentBlockedLiveMs(performance, nowIso, capIso = null) {
  return performance?.blocker ? msBetween(performance.blockedStartedAt, minIso(nowIso, capIso) ?? nowIso) : 0;
}

function totalDuration(durations) {
  return TRACKED_PHASES.reduce((sum, phase) => sum + (durations[phase] || 0), 0);
}

function attemptOutcome(attempt) {
  const status = attempt?.status ?? 'unknown';
  const errorCode = codeOf(attempt?.lastError);
  const timedOut = attempt?.cancelReason === 'deadline' || safeIso(attempt?.deadlineExceededAt) !== null || classifyErrorCode(errorCode) === 'deadline';
  return {
    status,
    finished: FINISHED_STATUSES.has(status),
    accepted: status === 'accepted' || status === 'integrated',
    integrated: status === 'integrated',
    failed: status === 'failed' || status === 'rework' || status === 'integration_failed',
    cancelled: status === 'cancelled' || status === 'canceled' || status === 'integration_cancelled',
    timedOut,
    unjudged: !FINISHED_STATUSES.has(status) && status !== 'integrated',
  };
}

function completionEvidenceAt(attempt) {
  return minIso(
    attempt?.runtimeReleasedAt,
    attempt?.operation?.finishedAt,
    attempt?.verification?.finishedAt,
    attempt?.integrationStartedAt,
    attempt?.launchFinishedAt,
  );
}

function sanitizedAttempt(attempt, { taskId, nowIso, nextAttemptCreatedAt = null }) {
  const hasPerformance = isObject(attempt?.performance);
  const performance = hasPerformance ? attempt.performance : trackAttempt(attempt, attempt, nowIso);
  const durationsMs = normalizeDurations(performance.durationsMs);
  const outcome = attemptOutcome(attempt);
  const liveCap = minIso(nextAttemptCreatedAt, outcome.finished ? completionEvidenceAt(attempt) : null);
  const livePhaseMs = hasPerformance ? currentPhaseLiveMs(performance, nowIso, liveCap) : 0;
  const liveBlockedMs = hasPerformance ? currentBlockedLiveMs(performance, nowIso, liveCap) : 0;
  const recordedMs = totalDuration(durationsMs) + (performance.blockedMs || 0);
  const knownElapsed = hasPerformance;
  const coverage = clone(performance.coverage) ?? { startedAt: safeIso(attempt?.createdAt), hasLegacyPrehistory: true, notes: [] };
  coverage.withPerformance = hasPerformance;
  coverage.timing = knownElapsed ? 'observed' : 'unknown';
  if (!hasPerformance) {
    coverage.hasLegacyPrehistory = true;
    coverage.notes = [...new Set([...(coverage.notes || []), 'missing_performance'])];
  }
  return {
    id: attempt?.id ?? null,
    taskId: attempt?.taskId ?? taskId ?? null,
    number: Number.isInteger(attempt?.number) ? attempt.number : null,
    previousAttempt: attempt?.previousAttempt ?? null,
    status: attempt?.status ?? null,
    phase: performance.phase,
    phaseStartedAt: performance.phaseStartedAt ?? null,
    durationsMs,
    elapsedMs: {
      recorded: knownElapsed ? recordedMs : null,
      live: livePhaseMs + liveBlockedMs,
      total: knownElapsed ? recordedMs + livePhaseMs + liveBlockedMs : null,
      known: knownElapsed,
    },
    blockedMs: (performance.blockedMs || 0) + liveBlockedMs,
    blocker: performance.blocker ?? null,
    lastObservedAt: performance.lastObservedAt ?? null,
    lastProgressAt: performance.lastProgressAt ?? null,
    progressSource: performance.progressSource ?? null,
    outcome,
    evidence: {
      createdAt: safeIso(attempt?.createdAt),
      deadlineAt: safeIso(attempt?.deadlineAt),
      deadlineExceededAt: safeIso(attempt?.deadlineExceededAt),
      cancelReason: typeof attempt?.cancelReason === 'string' ? attempt.cancelReason : null,
      submissionStartedAt: safeIso(attempt?.submissionStartedAt),
      submissionAcknowledgedAt: safeIso(attempt?.submissionAcknowledgedAt),
      launchFinishedAt: safeIso(attempt?.launchFinishedAt),
      collectedAt: safeIso(attempt?.collectedAt),
      verificationFinishedAt: safeIso(attempt?.verification?.finishedAt),
      integrationStartedAt: safeIso(attempt?.integrationStartedAt),
      operationFinishedAt: safeIso(attempt?.operation?.finishedAt),
      runtimeReleasedAt: safeIso(attempt?.runtimeReleasedAt),
      reportStatus: typeof attempt?.report?.status === 'string' ? attempt.report.status : null,
      verificationPassed: attempt?.verification?.passed === true,
      integrationPassed: attempt?.integration?.passed === true,
      checkStatuses: Array.isArray(attempt?.verification?.checks) ? attempt.verification.checks.map(checkSummary) : [],
      changedPathsCount: Array.isArray(attempt?.changedPaths) ? attempt.changedPaths.length : null,
      outsideScopeCount: Array.isArray(attempt?.outsideScope) ? attempt.outsideScope.length : null,
      lastErrorCode: codeOf(attempt?.lastError),
    },
    coverage,
  };
}

function summarizeTask(task, nowIso) {
  const attempts = Array.isArray(task?.attempts) ? task.attempts : [];
  const sanitizedAttempts = attempts.map((attempt, index) => sanitizedAttempt(attempt, {
    taskId: task?.definition?.id,
    nowIso,
    nextAttemptCreatedAt: safeIso(attempts[index + 1]?.createdAt),
  }));
  const currentAttemptId = typeof task?.currentAttempt === 'string' ? task.currentAttempt : null;
  const currentAttempt = currentAttemptId ? sanitizedAttempts.find(attempt => attempt.id === currentAttemptId) ?? null : null;
  const invalidCurrentAttempt = sanitizedAttempts.length > 0 && !currentAttempt;
  const statuses = new Set(sanitizedAttempts.map(attempt => attempt.status).filter(Boolean));
  return {
    id: task?.definition?.id ?? null,
    agent: task?.definition?.agent ?? null,
    isolation: task?.definition?.isolation ?? null,
    deadlineAt: safeIso(task?.definition?.deadlineAt) ?? safeIso(task?.deadlineAt),
    currentAttempt: currentAttemptId,
    attemptCount: sanitizedAttempts.length,
    attempts: sanitizedAttempts,
    outcome: {
      accepted: sanitizedAttempts.some(attempt => attempt.outcome.accepted),
      integrated: sanitizedAttempts.some(attempt => attempt.outcome.integrated),
      failed: sanitizedAttempts.some(attempt => attempt.outcome.failed) && !sanitizedAttempts.some(attempt => attempt.outcome.accepted),
      cancelled: sanitizedAttempts.some(attempt => attempt.outcome.cancelled) && !sanitizedAttempts.some(attempt => attempt.outcome.accepted),
      timedOut: sanitizedAttempts.some(attempt => attempt.outcome.timedOut),
      unjudged: sanitizedAttempts.some(attempt => attempt.outcome.unjudged),
      statuses: [...statuses],
      currentStatus: currentAttempt?.status ?? null,
      invalidCurrentAttempt,
    },
  };
}

export function summarizeRun(run, { now = new Date().toISOString() } = {}) {
  if (!isObject(run)) throw new TypeError('run must be an object');
  if (!validIso(now)) throw new TypeError('now must be an ISO timestamp with millisecond precision');
  const tasks = Object.values(isObject(run.tasks) ? run.tasks : {}).map(task => summarizeTask(task, now));
  const attempts = tasks.flatMap(task => task.attempts);
  const acceptedAttemptIds = [...new Set(attempts.filter(attempt => attempt.outcome.accepted).map(attempt => attempt.id).filter(Boolean))];
  const integratedAttemptIds = [...new Set(attempts.filter(attempt => attempt.outcome.integrated).map(attempt => attempt.id).filter(Boolean))];
  const finishedAttempts = attempts.filter(attempt => attempt.outcome.finished).length;
  const unjudgedAttempts = attempts.filter(attempt => attempt.outcome.unjudged).length;
  const legacyAttempts = attempts.filter(attempt => attempt.coverage?.hasLegacyPrehistory || attempt.coverage?.notes?.includes('missing_performance')).length;
  const totalElapsedMs = attempts.reduce((sum, attempt) => sum + (Number.isFinite(attempt.elapsedMs.total) ? attempt.elapsedMs.total : 0), 0);
  const totalBlockedMs = attempts.reduce((sum, attempt) => sum + attempt.blockedMs, 0);
  const runWallMs = msBetween(run.createdAt, safeIso(run.closedAt) ?? now);
  const eventLogComplete = run.performanceEventsIncomplete === true
    ? false
    : Number.isInteger(run.performanceRevision)
      ? run.performanceRecordedRevision === run.performanceRevision
      : null;
  return {
    version: VERSION,
    generatedAt: now,
    run: {
      id: run.id ?? null,
      schemaVersion: run.schemaVersion ?? null,
      createdAt: safeIso(run.createdAt),
      updatedAt: safeIso(run.updatedAt),
      closedAt: safeIso(run.closedAt),
      taskCount: tasks.length,
      attemptCount: attempts.length,
    },
    totals: {
      attempts: attempts.length,
      finishedAttempts,
      liveAttempts: attempts.length - finishedAttempts,
      unjudgedAttempts,
      acceptedAttempts: acceptedAttemptIds.length,
      integratedAttempts: integratedAttemptIds.length,
      failedAttempts: attempts.filter(attempt => attempt.outcome.failed).length,
      cancelledAttempts: attempts.filter(attempt => attempt.outcome.cancelled).length,
      timedOutAttempts: attempts.filter(attempt => attempt.outcome.timedOut).length,
      totalElapsedMs,
      totalElapsedMsLabel: 'sum_observed_attempt_durations_ms',
      runWallMs,
      totalBlockedMs,
    },
    outcomes: {
      acceptedAttemptIds,
      integratedAttemptIds,
      projectAcceptance: 'unknown',
      tasksAccepted: tasks.filter(task => task.outcome.accepted).map(task => task.id).filter(Boolean),
      tasksIntegrated: tasks.filter(task => task.outcome.integrated).map(task => task.id).filter(Boolean),
      tasksFailed: tasks.filter(task => task.outcome.failed).map(task => task.id).filter(Boolean),
      tasksCancelled: tasks.filter(task => task.outcome.cancelled).map(task => task.id).filter(Boolean),
      tasksTimedOut: tasks.filter(task => task.outcome.timedOut).map(task => task.id).filter(Boolean),
      tasksUnjudged: tasks.filter(task => task.outcome.unjudged).map(task => task.id).filter(Boolean),
    },
    accuracy: {
      successRate: attempts.length ? acceptedAttemptIds.length / attempts.length : null,
      denominator: attempts.length,
      numerator: acceptedAttemptIds.length,
      includesUnjudged: true,
      note: 'Success rate counts all attempts in the denominator; project acceptance is unknown without an external product acceptance signal.',
    },
    coverage: {
      attempted: attempts.length,
      withPerformance: attempts.filter(attempt => attempt.coverage?.withPerformance).length,
      missingPerformance: attempts.filter(attempt => !attempt.coverage?.withPerformance).length,
      legacyAttempts,
      blockedAttempts: attempts.filter(attempt => attempt.blocker).length,
      eventLogComplete,
      notes: [...new Set(attempts.flatMap(attempt => attempt.coverage?.notes || []))],
    },
    tasks,
  };
}

export function publicPerformance(attempt, { now = new Date().toISOString(), taskId = null } = {}) {
  if (!isObject(attempt)) throw new TypeError('attempt must be an object');
  if (!validIso(now)) throw new TypeError('now must be an ISO timestamp with millisecond precision');
  return sanitizedAttempt(attempt, { taskId, nowIso: now });
}
