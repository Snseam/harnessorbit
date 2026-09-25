import { evaluateBenchmark } from '../benchmarks/evaluator.mjs';

export const INTERNAL_BENCHMARK_SCHEMA_VERSION = 1;
export const INTERNAL_CASES = Object.freeze([
  { id: 'normal-feature', cohort: 'normal', risk: 'low', kind: 'normal', baseline: 'accepted', orbit: 'accepted' },
  { id: 'blocked-permission', cohort: 'blocked', risk: 'low', kind: 'blocked', baseline: 'timeout', orbit: 'failed' },
  { id: 'provider-saturation', cohort: 'provider-saturation', risk: 'low', kind: 'provider-saturation', baseline: 'timeout', orbit: 'failed' },
  { id: 'retry-after-check', cohort: 'retry', risk: 'low', kind: 'retry', baseline: 'accepted', orbit: 'accepted' },
  { id: 'scope-violation', cohort: 'scope', risk: 'medium', kind: 'scope', baseline: 'failed', orbit: 'failed' },
  { id: 'verification-failure', cohort: 'verification', risk: 'medium', kind: 'verification', baseline: 'failed', orbit: 'failed' },
  { id: 'high-risk-change', cohort: 'high-risk', risk: 'high', kind: 'high-risk', baseline: 'failed', orbit: 'failed' },
]);

function duration(caseDefinition, armId, repetition) {
  const armOffset = armId === 'codex-harnessorbit' ? -80 : 0;
  const repetitionOffset = (repetition - 1) * 20;
  if (caseDefinition.kind === 'blocked') return armId === 'codex-harnessorbit' ? 850 + repetitionOffset : 5000 + repetitionOffset;
  if (caseDefinition.kind === 'provider-saturation') return armId === 'codex-harnessorbit' ? 1200 + repetitionOffset : 4800 + repetitionOffset;
  if (caseDefinition.kind === 'retry') return armId === 'codex-harnessorbit' ? 1300 + repetitionOffset : 1900 + repetitionOffset;
  return Math.max(100, 1400 + armOffset + repetitionOffset);
}

export function createInternalBenchmarkPlan({ repetitions = [1, 2, 3], deadlineMs = 6000, experimentId = 'cao-codex-harnessorbit-internal-v1' } = {}) {
  return {
    schemaVersion: 1,
    experimentId,
    deadlineMs,
    cohorts: [...new Set(INTERNAL_CASES.map(item => item.cohort))].map(cohort => ({ id: cohort, tasks: INTERNAL_CASES.filter(item => item.cohort === cohort).map(item => ({ id: item.id })) })),
    arms: [
      { id: 'codex-baseline', label: 'Pure Codex baseline' },
      { id: 'codex-harnessorbit', label: 'Codex + HarnessOrbit contract' },
    ],
    repetitions,
    controls: {
      sameTaskDefinition: true,
      sameBaseCommit: 'fixture-base-commit',
      sameChecks: ['contract-checks-v1'],
      sameDeadlineMs: deadlineMs,
      pairingKey: 'cohort/task/repetition',
    },
  };
}

export function simulateInternalTrials({ plan = createInternalBenchmarkPlan() } = {}) {
  const trials = [];
  for (const caseDefinition of INTERNAL_CASES) {
    for (const repetition of plan.repetitions) {
      for (const arm of plan.arms) {
        const isOrbit = arm.id === 'codex-harnessorbit';
        const outcome = isOrbit ? caseDefinition.orbit : caseDefinition.baseline;
        const unsafeAcceptance = caseDefinition.risk === 'high' && outcome === 'accepted';
        const providerFailure = caseDefinition.kind === 'provider-saturation';
        const providerFailureRecovered = providerFailure && isOrbit;
        const attempts = caseDefinition.kind === 'retry' && !isOrbit ? 2 : 1;
        const durationMs = duration(caseDefinition, arm.id, repetition);
        trials.push({
          cohortId: caseDefinition.cohort,
          taskId: caseDefinition.id,
          armId: arm.id,
          repetition,
          outcome,
          durationMs,
          projectAcceptance: outcome === 'accepted',
          projectAcceptanceState: outcome === 'accepted' ? 'accepted' : outcome === 'timeout' ? 'unknown' : 'blocked',
          integrated: outcome === 'accepted',
          timeToFirstUsefulResultMs: outcome === 'timeout' ? null : durationMs,
          timeToAcceptedMs: outcome === 'accepted' ? durationMs : null,
          timeToIntegratedMs: outcome === 'accepted' ? durationMs : null,
          metricSource: 'synthetic-contract-fixture',
          evidenceReferences: [],
          risk: caseDefinition.risk,
          kind: caseDefinition.kind,
          attempts,
          rework: Math.max(0, attempts - 1),
          blockedDurationMs: caseDefinition.kind === 'blocked' ? duration(caseDefinition, arm.id, repetition) : 0,
          humanInterventions: caseDefinition.kind === 'blocked' && !isOrbit ? 1 : 0,
          providerFailure,
          providerFailureRecovered,
          highRiskMiss: unsafeAcceptance,
          decisionLatencyMs: isOrbit ? 25 : 0,
          contextSize: isOrbit ? 4 : 0,
          inputTokens: isOrbit ? 180 : 0,
          costCents: isOrbit ? 2 : 0,
        });
      }
    }
  }
  return trials;
}

function mean(values) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function operationalMetrics(trials, armId) {
  const rows = trials.filter(trial => trial.armId === armId);
  const denominator = rows.length;
  const providerRows = rows.filter(row => row.providerFailure);
  const acceptedCount = rows.filter(row => row.projectAcceptanceState === 'accepted').length;
  const integratedCount = rows.filter(row => row.integrated === true).length;
  const unknownCount = rows.filter(row => row.projectAcceptanceState === 'unknown').length;
  const ratio = count => denominator ? Number((count / denominator).toFixed(4)) : null;
  return {
    metricSource: 'synthetic-contract-fixture',
    observed: false,
    denominator,
    meanDurationMs: mean(rows.map(row => row.durationMs).filter(Number.isFinite)),
    meanTimeToFirstUsefulResultMs: mean(rows.map(row => row.timeToFirstUsefulResultMs).filter(Number.isFinite)),
    meanTimeToAcceptedMs: mean(rows.map(row => row.timeToAcceptedMs).filter(Number.isFinite)),
    meanTimeToIntegratedMs: mean(rows.map(row => row.timeToIntegratedMs).filter(Number.isFinite)),
    meanAttempts: mean(rows.map(row => row.attempts).filter(Number.isFinite)),
    acceptedCount,
    acceptedRate: ratio(acceptedCount),
    integratedCount,
    integratedRate: ratio(integratedCount),
    projectAcceptanceUnknownCount: unknownCount,
    projectAcceptanceUnknownRate: ratio(unknownCount),
    blockedDurationMs: rows.reduce((sum, row) => sum + (row.blockedDurationMs || 0), 0),
    humanInterventions: rows.reduce((sum, row) => sum + (row.humanInterventions || 0), 0),
    providerFailureDenominator: providerRows.length,
    providerFailureRecovered: providerRows.filter(row => row.providerFailureRecovered).length,
    highRiskMisses: rows.filter(row => row.highRiskMiss).length,
    meanDecisionLatencyMs: mean(rows.map(row => row.decisionLatencyMs).filter(Number.isFinite)),
    meanContextSize: mean(rows.map(row => row.contextSize).filter(Number.isFinite)),
    totalInputTokens: rows.reduce((sum, row) => sum + (row.inputTokens || 0), 0),
    totalCostCents: rows.reduce((sum, row) => sum + (row.costCents || 0), 0),
  };
}

export function runInternalBenchmark({ plan = createInternalBenchmarkPlan(), trials = null } = {}) {
  const rawTrials = trials || simulateInternalTrials({ plan });
  const report = evaluateBenchmark(plan, { schemaVersion: 1, experimentId: plan.experimentId, trials: rawTrials });
  const metrics = Object.fromEntries(plan.arms.map(arm => [arm.id, operationalMetrics(rawTrials, arm.id)]));
  return {
    schemaVersion: INTERNAL_BENCHMARK_SCHEMA_VERSION,
    experimentId: plan.experimentId,
    dataKind: 'deterministic-contract-simulation',
    claimEligible: false,
    claimReason: 'Synthetic fixture validates measurement and safety gates; real controlled Codex runs are required for product-benefit claims.',
    measurement: {
      source: 'synthetic-contract-fixture',
      observed: false,
      requiredEvidence: ['attempt.receipt', 'base.commit', 'check.log', 'snapshot', 'verification', 'integration'],
    },
    plan,
    metrics,
    evaluator: report,
  };
}
