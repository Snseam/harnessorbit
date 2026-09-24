import test from 'node:test';
import assert from 'node:assert/strict';
import { createInternalBenchmarkPlan, runInternalBenchmark, simulateInternalTrials } from '../src/internal-benchmark.mjs';

test('internal benchmark pairs pure Codex and Codex plus HarnessOrbit across declared failure modes', () => {
  const plan = createInternalBenchmarkPlan({ repetitions: [1, 2] });
  assert.deepEqual(plan.controls, {
    sameTaskDefinition: true,
    sameBaseCommit: 'fixture-base-commit',
    sameChecks: ['contract-checks-v1'],
    sameDeadlineMs: 6000,
    pairingKey: 'cohort/task/repetition',
  });
  const report = runInternalBenchmark({ plan });
  assert.equal(report.dataKind, 'deterministic-contract-simulation');
  assert.equal(report.claimEligible, false);
  assert.deepEqual(report.measurement, {
    source: 'synthetic-contract-fixture',
    observed: false,
    requiredEvidence: ['attempt.receipt', 'base.commit', 'check.log', 'snapshot', 'verification', 'integration'],
  });
  assert.equal(report.metrics['codex-baseline'].observed, false);
  assert.equal(report.evaluator.trialCount, 28);
  assert.equal(report.metrics['codex-baseline'].denominator, 14);
  assert.equal(report.metrics['codex-harnessorbit'].denominator, 14);
  assert.equal(report.metrics['codex-harnessorbit'].providerFailureRecovered, 2);
  assert.equal(report.metrics['codex-baseline'].highRiskMisses, 0);
  assert.equal(report.metrics['codex-harnessorbit'].highRiskMisses, 0);
  assert.equal(report.metrics['codex-baseline'].acceptedCount, 4);
  assert.equal(report.metrics['codex-harnessorbit'].integratedCount, 4);
  assert.equal(report.metrics['codex-baseline'].projectAcceptanceUnknownCount, 4);
  assert.equal(report.metrics['codex-harnessorbit'].projectAcceptanceUnknownCount, 0);
  assert.equal(report.metrics['codex-baseline'].meanTimeToAcceptedMs, 1660);
  assert.equal(report.metrics['codex-harnessorbit'].meanTimeToIntegratedMs, 1320);
});

test('internal benchmark keeps timeouts, failures and safety rows in the denominator', () => {
  const plan = createInternalBenchmarkPlan({ repetitions: [1] });
  const trials = simulateInternalTrials({ plan });
  const report = runInternalBenchmark({ plan, trials });
  const baseline = report.evaluator.sensitivities.userCancelsIncluded.overall.arms['codex-baseline'];
  assert.equal(baseline.denominator, 7);
  assert.ok((baseline.byClassification.timeout || 0) >= 2);
  assert.equal(report.metrics['codex-baseline'].highRiskMisses, 0);
  assert.equal(report.evaluator.rollout.enableAdaptiveByDefault, false);
});
