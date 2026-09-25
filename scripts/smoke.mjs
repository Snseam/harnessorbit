#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../src/process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (!args.includes('--live')) {
  console.log('Live smoke uses your configured Claude Code through an owned Herdr session.');
  console.log('Run: npm run smoke -- --live [--happy] [--resume /absolute/path/to/smoke.json]');
  console.log('It creates an isolated fixture, injects one failed candidate, retries, verifies and integrates.');
  process.exit(0);
}
const resumeIndex = args.indexOf('--resume');
if (args.some((a, i) => !['--live', '--happy', '--resume'].includes(a) && !(resumeIndex >= 0 && i === resumeIndex + 1)) || (resumeIndex >= 0 && !args[resumeIndex + 1])) throw new Error('Unknown or incomplete smoke arguments.');
let journal, file;
const save = () => fs.writeFile(file, JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 });
const log = event => { journal.events.push({ at: new Date().toISOString(), ...event }); console.log(JSON.stringify(event)); };
const command = async argv => {
  const result = await runCommand(argv, { timeoutMs: 60000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
};
const cao = async (...argv) => JSON.parse(await command([process.execPath, path.join(root, 'bin/harnessorbit.mjs'), ...argv, '--state-dir', journal.stateRoot])).data;

if (resumeIndex >= 0) {
  file = path.resolve(args[resumeIndex + 1]); journal = JSON.parse(await fs.readFile(file, 'utf8'));
  delete journal.paused;
  delete journal.error;
  if (journal.passed) { console.log(JSON.stringify({ phase: 'already_passed', journal: file })); process.exit(0); }
} else {
  await fs.mkdir(path.join(root, 'work'), { recursive: true });
  const base = await fs.mkdtemp(path.join(root, 'work', 'live-smoke-'));
  file = path.join(base, 'smoke.json');
  journal = { schemaVersion: 1, base, project: path.join(base, 'project'), stateRoot: path.join(base, 'state'), startedAt: new Date().toISOString(), faultInjection: 'First attempt submits unchanged broken add; subsequent attempt must fix it.', events: [] };
  journal.happy = args.includes('--happy');
  if (journal.happy) journal.faultInjection = false;
  await fs.mkdir(path.join(journal.project, 'src'), { recursive: true });
  await fs.mkdir(path.join(journal.project, 'tests'));
  await fs.writeFile(path.join(journal.project, 'src/math.mjs'), 'export const add = (a, b) => a - b;\n');
  await fs.writeFile(path.join(journal.project, 'tests/math.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.mjs';\ntest('adds positive and negative numbers', () => { assert.equal(add(3, 4), 7); assert.equal(add(-3, 2), -1); assert.equal(add(0, 0), 0); });\n");
  for (const commandArgs of [['init', '-b', 'main'], ['add', '.'], ['-c', 'user.name=CAO Smoke', '-c', 'user.email=cao@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Establish a disposable smoke fixture']]) await command(['git', '-C', journal.project, ...commandArgs]);
  journal.originalHead = (await command(['git', '-C', journal.project, 'rev-parse', 'HEAD'])).trim();
  const task = {
    id: 'fix-add', agent: 'claude', role: 'implementer', isolation: 'worktree', maxAttempts: 2, maxChildren: 0,
    objective: 'This is a controlled recovery test. On attempt number 1 ONLY: inspect src/math.mjs, run the stated test, leave all source and tests unchanged, and submit a truthful result recording the expected test failure. Use status submitted and unresolved [] because the failure is deliberately injected for the controller to detect; do not fix it on attempt 1. On attempt number 2: fix add(a,b) to return the sum, run the stated test and submit the repaired implementation. Never modify the tests. Do not ask questions; follow the attempt number in metadata.',
    allowedPaths: ['src/math.mjs'], checks: [{ name: 'math', argv: [process.execPath, '--test', 'tests/math.test.mjs'], timeoutMs: 10000 }],
    agentArgs: ['--tools', 'Read,Write,Edit,Bash', '--allowedTools', 'Read,Write,Edit,Bash', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
  };
  if (journal.happy) task.objective = 'Fix src/math.mjs so add(a,b) returns their sum. Run the stated test and submit the result contract. Preserve the tests.';
  journal.taskFile = path.join(base, 'task.json');
  await fs.writeFile(journal.taskFile, JSON.stringify(task, null, 2));
  const run = await cao('init', '--project', journal.project, '--max-parallel', '2');
  journal.runId = run.id; journal.session = run.herdrSession;
  await save();
  log({ phase: 'created', runId: run.id, session: run.herdrSession, journal: file });
  await cao('dispatch', '--run', run.id, '--file', journal.taskFile);
}

const taskArgs = ['--run', journal.runId, '--task', 'fix-add'];
const until = Date.now() + 8 * 60000;
try {
  while (Date.now() < until) {
    let { attempt } = await cao('inspect', ...taskArgs);
    log({ phase: attempt.status, attempt: attempt.number });
    if (attempt.status === 'needs_input' || (!attempt.submissionStartedAt && attempt.status === 'ready')) {
      ({ attempt } = await cao('resume', ...taskArgs));
      if (['running', 'submitted'].includes(attempt.status)) continue;
      const view = await cao('inspect', ...taskArgs, '--output');
      journal.paused = { status: attempt.status, output: view.output, error: attempt.lastError };
      log({ phase: 'paused', journal: file, output: view.output, error: attempt.lastError });
      await save(); process.exitCode = 2; break;
    }
    if (['running', 'uncertain', 'sending'].includes(attempt.status)) {
      await cao('collect', ...taskArgs, '--wait-ms', '30000');
    } else if (attempt.status === 'submitted') {
      await cao('verify', ...taskArgs);
    } else if (attempt.status === 'rework' && attempt.number === 1) {
      if (attempt.verification?.passed || attempt.changedPaths.length !== 0) throw new Error('Fault injection did not produce the expected unchanged failed candidate.');
      journal.firstFailure = attempt.verification;
      await save();
      await cao('retry', ...taskArgs);
    } else if (attempt.status === 'accepted') {
      if (!journal.happy && (attempt.number !== 2 || !journal.firstFailure)) throw new Error('Recovery test requires a failed first attempt and successful second attempt.');
      if (!(await fs.readFile(path.join(journal.project, 'src/math.mjs'), 'utf8')).includes('a - b')) throw new Error('Worker modified the original project before integration.');
      journal.isolationVerified = true;
      journal.finalVerification = attempt.verification;
      await cao('integrate', ...taskArgs);
    } else if (attempt.status === 'integrated') {
      journal.integration = attempt.integration;
      journal.finalHead = (await command(['git', '-C', journal.project, 'rev-parse', 'HEAD'])).trim();
      if (journal.originalHead !== journal.finalHead) throw new Error('Smoke unexpectedly created a project commit.');
      journal.cleanup = await cao('cleanup', '--run', journal.runId);
      journal.passed = true; journal.finishedAt = new Date().toISOString(); delete journal.paused;
      log({ phase: 'passed', journal: file }); await save(); break;
    } else throw new Error(`Unexpected state ${attempt.status}; retained for inspection.`);
    await save();
  }
  if (!journal.passed && !journal.paused) throw new Error('Smoke time limit reached; use the saved run to inspect, cancel or resume.');
} catch (error) {
  journal.error = error.message; await save();
  console.error(JSON.stringify({ phase: 'error', journal: file, error: error.message })); process.exitCode = 1;
}
