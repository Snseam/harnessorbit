#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createCommandRunner,
  createCheckRunner,
  createRealBenchmarkPlan,
  detectRealBenchmarkRuntime,
  runRealBenchmark,
} from '../src/real-benchmark.mjs';

function value(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
}

function has(argv, name) {
  return argv.includes(name);
}

function parseTasks(argv) {
  const prompt = value(argv, '--task');
  return [{ id: value(argv, '--task-id', 'pilot-task'), cohort: value(argv, '--cohort', 'pilot'), prompt }];
}

export async function main(argv = process.argv.slice(2)) {
  const evidenceRoot = path.resolve(value(argv, '--evidence-dir', 'work/real-benchmark'));
  const deadlineMs = Number(value(argv, '--deadline-ms', 15 * 60 * 1000));
  const repetitions = String(value(argv, '--repetitions', '1')).split(',').map(Number);
  const tasks = parseTasks(argv);
  const plan = createRealBenchmarkPlan({
    experimentId: value(argv, '--experiment-id', undefined) || undefined,
    deadlineMs,
    repetitions,
    tasks,
    baseCommit: value(argv, '--base-commit', 'unknown'),
    checks: String(value(argv, '--checks', 'declared-checks-unavailable')).split(','),
  });
  const runtime = await detectRealBenchmarkRuntime({
    cwd: process.cwd(),
    codexCommand: value(argv, '--codex-command', 'codex'),
    harnessOrbitCommand: value(argv, '--harnessorbit-command', process.env.HARNESSORBIT_COMMAND),
    liveCodexProbe: !has(argv, '--version-only'),
  });
  const runners = {};
  if (has(argv, '--execute')) {
    runners['codex-baseline'] = createCommandRunner({
      command: value(argv, '--codex-command', 'codex'),
      args: ({ cwd }) => ['exec', '--ephemeral', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', cwd],
    });
    const orbitCommand = value(argv, '--harnessorbit-command', process.env.HARNESSORBIT_COMMAND);
    if (orbitCommand) runners['codex-harnessorbit'] = createCommandRunner({ command: orbitCommand });
  }
  const declaredChecks = plan.controls.sameChecks.filter(check => check !== 'declared-checks-unavailable');
  const checkRunner = declaredChecks.length > 0 ? createCheckRunner({ checks: declaredChecks }) : null;
  const report = await runRealBenchmark({
    plan,
    cwd: process.cwd(),
    evidenceRoot,
    runtime,
    execute: has(argv, '--execute'),
    runners,
    tasks,
    checkRunner,
  });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = value(argv, '--output');
  if (outputPath) {
    const file = path.resolve(outputPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, output, { mode: 0o600 });
  } else {
    process.stdout.write(output);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 2;
  });
}
