import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createRealBenchmarkPlan,
  runRealBenchmark,
} from '../src/real-benchmark.mjs';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cao-real-benchmark-'));
}

async function gitFixture(t) {
  const root = await tempDir();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'CAO Test']);
  await fs.writeFile(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
  return root;
}

test('real pilot plan fixes task, base, checks, deadline and paired arms', () => {
  const plan = createRealBenchmarkPlan({
    deadlineMs: 1234,
    repetitions: [1, 2],
    baseCommit: 'abc123',
    checks: ['npm test'],
    tasks: [{ id: 'task-a', cohort: 'normal', prompt: 'Do the task.' }],
  });
  assert.deepEqual(plan.controls, {
    sameTaskDefinition: true,
    taskDefinitionDigest: plan.controls.taskDefinitionDigest,
    sameBaseCommit: 'abc123',
    sameChecks: ['npm test'],
    sameDeadlineMs: 1234,
    pairingKey: 'cohort/task/repetition',
  });
  assert.equal(plan.arms.length, 2);
  assert.equal(plan.cohorts[0].tasks[0].id, 'task-a');
  assert.equal(plan.taskDefinitions[0].promptPresent, true);
});

test('blocked preflight produces an explicit missing denominator and no claim', async () => {
  const report = await runRealBenchmark({
    plan: createRealBenchmarkPlan({ tasks: [{ id: 'task-a', cohort: 'pilot', prompt: null }] }),
    runtime: {
      codex: { available: true, version: 'codex-test' },
      harnessOrbit: { available: false, reason: 'command_not_configured' },
      ready: false,
      blockedReasons: ['harnessOrbit:command_not_configured'],
    },
    execute: false,
    evidenceRoot: await tempDir(),
  });
  assert.equal(report.status, 'blocked');
  assert.equal(report.claimEligible, false);
  assert.ok(report.blockedReasons.includes('harnessOrbit:command_not_configured'));
  assert.equal(report.evaluator.trialCount, 2);
  assert.equal(report.evaluator.sensitivities.userCancelsIncluded.overall.arms['codex-baseline'].missing, 1);
  assert.equal(report.evaluator.sensitivities.userCancelsIncluded.overall.arms['codex-harnessorbit'].missing, 1);
});

test('real runner records accepted, failed and timeout rows with raw evidence references', async () => {
  const evidenceRoot = await tempDir();
  const plan = createRealBenchmarkPlan({
    deadlineMs: 200,
    checks: [],
    tasks: [{ id: 'task-a', cohort: 'pilot', prompt: 'Do the task.' }],
  });
  const report = await runRealBenchmark({
    plan,
    runtime: {
      codex: { available: true },
      harnessOrbit: { available: true },
      ready: true,
      blockedReasons: [],
    },
    execute: true,
    enforceBaseSnapshot: false,
    isolateTrials: false,
    tasks: [{ id: 'task-a', cohort: 'pilot', prompt: 'Do the task.' }],
    evidenceRoot,
    runners: {
      'codex-baseline': async () => ({ outcome: 'failed', projectAcceptance: false, durationMs: 20, stderr: 'failed' }),
      'codex-harnessorbit': async () => ({ outcome: 'timeout', projectAcceptance: false, durationMs: 200, timedOut: true }),
    },
  });
  assert.equal(report.status, 'completed');
  assert.equal(report.claimEligible, false);
  assert.equal(report.trials.length, 2);
  for (const trial of report.trials) {
    assert.ok(trial.receiptRef.endsWith('/receipt.json'));
    assert.ok(trial.commitRef.endsWith('/commit.json'));
    assert.ok(trial.checksRef.endsWith('/checks.json'));
    assert.ok(trial.snapshotRef.endsWith('/snapshot.json'));
    assert.equal(trial.evidenceRefs.length, 6);
    await fs.access(trial.receiptRef);
  }
  const arms = report.evaluator.sensitivities.userCancelsIncluded.overall.arms;
  assert.equal(arms['codex-baseline'].denominator, 1);
  assert.equal(arms['codex-baseline'].byClassification.failed, 1);
  assert.equal(arms['codex-harnessorbit'].byClassification.timeout, 1);
});

test('one missing arm remains in the denominator when the other arm records a result', async () => {
  const report = await runRealBenchmark({
    plan: createRealBenchmarkPlan({ checks: [], tasks: [{ id: 'task-a', cohort: 'pilot', prompt: 'Do the task.' }] }),
    runtime: {
      codex: { available: true },
      harnessOrbit: { available: true },
      ready: true,
      blockedReasons: [],
    },
    execute: true,
    enforceBaseSnapshot: false,
    isolateTrials: false,
    tasks: [{ id: 'task-a', cohort: 'pilot', prompt: 'Do the task.' }],
    evidenceRoot: await tempDir(),
    runners: {
      'codex-baseline': async () => ({ outcome: 'accepted', projectAcceptance: true, durationMs: 10 }),
    },
  });
  const arms = report.evaluator.sensitivities.userCancelsIncluded.overall.arms;
  assert.equal(arms['codex-baseline'].completed, 1);
  assert.equal(arms['codex-harnessorbit'].missing, 1);
  assert.equal(report.evaluator.sensitivities.userCancelsIncluded.overall.comparisons[0].missingPairMembers, 1);
  assert.equal(report.evaluator.sensitivities.userCancelsIncluded.overall.comparisons[0].benefitClaim, null);
});

test('real pilot marks a base control violation blocked instead of completed', async () => {
  const evidenceRoot = await tempDir();
  const plan = createRealBenchmarkPlan({ checks: [], tasks: [{ id: 'task-a', cohort: 'pilot', prompt: 'Do the task.' }] });
  const report = await runRealBenchmark({
    plan,
    runtime: { codex: { available: true }, harnessOrbit: { available: true }, ready: true, blockedReasons: [] },
    execute: true,
    isolateTrials: false,
    tasks: [{ id: 'task-a', cohort: 'pilot', prompt: 'Do the task.' }],
    evidenceRoot,
    runners: {
      'codex-baseline': async () => ({ outcome: 'accepted', projectAcceptance: true, durationMs: 10 }),
      'codex-harnessorbit': async () => ({ outcome: 'accepted', projectAcceptance: true, durationMs: 10 }),
    },
    baseSnapshot: { available: true, head: 'base', dirty: false, status: null },
  });
  assert.equal(report.status, 'blocked');
  assert.ok(report.blockedReasons.includes('base_control_violation'));
  assert.equal(report.trials[0].outcome, 'unjudged');
  assert.equal(report.trials[1].outcome, 'unjudged');
});

test('real pilot refuses acceptance when declared checks are unavailable', async () => {
  const report = await runRealBenchmark({
    plan: createRealBenchmarkPlan({ checks: ['required-check'], tasks: [{ id: 'task-a', cohort: 'pilot', prompt: 'Do the task.' }] }),
    runtime: { codex: { available: true }, harnessOrbit: { available: true }, ready: true, blockedReasons: [] },
    execute: true,
    enforceBaseSnapshot: false,
    isolateTrials: false,
    tasks: [{ id: 'task-a', cohort: 'pilot', prompt: 'Do the task.' }],
    evidenceRoot: await tempDir(),
    runners: { 'codex-baseline': async () => ({ outcome: 'accepted', projectAcceptance: true, durationMs: 10 }) },
  });
  assert.equal(report.status, 'blocked');
  assert.ok(report.blockedReasons.includes('checks_unavailable'));
  assert.equal(report.trials.length, 1);
  assert.equal(report.trials[0].outcome, 'unjudged');
  assert.equal(report.trials[0].projectAcceptance, false);
});

test('real pilot hashes trial evidence paths and keeps arms separate', async () => {
  const evidenceRoot = await tempDir();
  const report = await runRealBenchmark({
    plan: createRealBenchmarkPlan({ checks: [], tasks: [{ id: 'foo/../../escaped', cohort: 'pilot', prompt: 'Do the task.' }] }),
    runtime: { codex: { available: true }, harnessOrbit: { available: true }, ready: true, blockedReasons: [] },
    execute: true,
    enforceBaseSnapshot: false,
    isolateTrials: false,
    tasks: [{ id: 'foo/../../escaped', cohort: 'pilot', prompt: 'Do the task.' }],
    evidenceRoot,
    runners: {
      'codex-baseline': async () => ({ outcome: 'accepted', projectAcceptance: true, durationMs: 10 }),
      'codex-harnessorbit': async () => ({ outcome: 'accepted', projectAcceptance: true, durationMs: 10 }),
    },
  });
  assert.equal(report.status, 'completed');
  assert.equal(new Set(report.trials.map(trial => trial.receiptRef)).size, 2);
  assert.ok(report.trials.every(trial => trial.receiptRef.startsWith(path.resolve(evidenceRoot) + path.sep)));
});

test('real pilot gives each arm a clean detached worktree at the same base', async t => {
  const project = await gitFixture(t);
  const evidenceRoot = await tempDir();
  t.after(() => fs.rm(evidenceRoot, { recursive: true, force: true }));
  const seenCwds = [];
  const plan = createRealBenchmarkPlan({ checks: [], tasks: [{ id: 'task-a', cohort: 'pilot', prompt: 'Do the task.' }] });
  const runner = async ({ cwd }) => {
    seenCwds.push(cwd);
    return { outcome: 'accepted', projectAcceptance: true, durationMs: 10 };
  };
  const report = await runRealBenchmark({
    plan,
    cwd: project,
    runtime: { codex: { available: true }, harnessOrbit: { available: true }, ready: true, blockedReasons: [] },
    execute: true,
    evidenceRoot,
    tasks: [{ id: 'task-a', cohort: 'pilot', prompt: 'Do the task.' }],
    runners: { 'codex-baseline': runner, 'codex-harnessorbit': runner },
  });
  assert.equal(report.status, 'completed');
  assert.deepEqual(report.blockedReasons, []);
  assert.equal(new Set(seenCwds).size, 2);
  assert.ok(seenCwds.every(cwd => cwd !== project));
  for (const trial of report.trials) {
    const commit = JSON.parse(await fs.readFile(trial.commitRef, 'utf8'));
    assert.equal(commit.pre.head, report.controls.sameBaseCommit);
    assert.equal(commit.pre.dirty, false);
  }
});
