import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { evaluateBenchmark } from '../benchmarks/evaluator.mjs';

export const REAL_BENCHMARK_SCHEMA_VERSION = 1;
export const REAL_BENCHMARK_ARMS = Object.freeze([
  { id: 'codex-baseline', label: 'Pure Codex baseline' },
  { id: 'codex-harnessorbit', label: 'Codex + HarnessOrbit' },
]);
export const DEFAULT_DEADLINE_MS = 15 * 60 * 1000;

const SAFE_ID = /^[A-Za-z0-9_.:@/-]+$/;
const MAX_EVIDENCE_LOG = 32 * 1024;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function now() {
  return new Date().toISOString();
}

function redactLog(value) {
  let text = typeof value === 'string' ? value : value == null ? '' : String(value);
  const configuredSecrets = [process.env.JEV_JBSD_API_KEY, process.env.JEV_JBSD_APIKEY, process.env.JEV_API_KEY]
    .filter(secret => typeof secret === 'string' && secret.length >= 8);
  for (const secret of configuredSecrets) text = text.split(secret).join('[REDACTED_SECRET]');
  text = text.replace(/(bearer\s+)[^\s\r\n]+/gi, '$1[REDACTED_SECRET]');
  text = text.replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED_SECRET]');
  return text.slice(0, MAX_EVIDENCE_LOG);
}

function safeId(value, fallback) {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : fallback;
}

function parseCommand(command) {
  if (Array.isArray(command) && command.length > 0 && command.every(item => typeof item === 'string' && item.length > 0)) {
    return { command: command[0], args: command.slice(1) };
  }
  if (typeof command !== 'string' || command.trim() === '') return null;
  const parts = command.trim().split(/\s+/);
  return { command: parts[0], args: parts.slice(1) };
}

function identity({ cohortId, taskId, armId, repetition }) {
  return `${cohortId}/${taskId}/${armId}/${repetition}`;
}

function plannedRows(plan) {
  return plan.cohorts.flatMap(cohort => cohort.tasks.flatMap(task => plan.repetitions.flatMap(repetition => plan.arms.map(arm => ({
    cohortId: cohort.id,
    taskId: task.id,
    armId: arm.id,
    repetition,
  })))));
}

export function createRealBenchmarkPlan({
  experimentId = 'cao-codex-harnessorbit-real-pilot-v1',
  deadlineMs = DEFAULT_DEADLINE_MS,
  repetitions = [1],
  tasks = [{ id: 'fixture-task', cohort: 'pilot', prompt: null }],
  baseCommit = 'unknown',
  checks = ['declared-checks-unavailable'],
} = {}) {
  const normalizedTasks = tasks.map((task, index) => ({
    id: safeId(task?.id, `task-${index + 1}`),
    cohort: safeId(task?.cohort, 'pilot'),
    prompt: typeof task?.prompt === 'string' && task.prompt.length > 0 ? task.prompt : null,
    definitionDigest: task?.definitionDigest || sha256(task?.prompt || `missing-task-definition:${index + 1}`),
  }));
  const cohortIds = [...new Set(normalizedTasks.map(task => task.cohort))];
  return {
    schemaVersion: REAL_BENCHMARK_SCHEMA_VERSION,
    experimentId,
    deadlineMs,
    cohorts: cohortIds.map(id => ({ id, tasks: normalizedTasks.filter(task => task.cohort === id).map(task => ({ id: task.id })) })),
    arms: REAL_BENCHMARK_ARMS.map(arm => ({ ...arm })),
    repetitions: [...repetitions],
    controls: {
      sameTaskDefinition: true,
      taskDefinitionDigest: sha256(normalizedTasks.map(task => `${task.id}:${task.definitionDigest}`).join('|')),
      sameBaseCommit: baseCommit,
      sameChecks: [...checks],
      sameDeadlineMs: deadlineMs,
      pairingKey: 'cohort/task/repetition',
    },
    taskDefinitions: normalizedTasks.map(({ prompt, ...task }) => ({ ...task, promptPresent: Boolean(prompt) })),
  };
}

async function runProcess(command, args = [], { cwd, timeoutMs = 30_000, input = null, env = process.env } = {}) {
  const startedAt = Date.now();
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve({ ...result, command, args, cwd, stdout, stderr, durationMs: Math.max(1, Date.now() - startedAt) });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ exitCode: null, signal: 'SIGTERM', timedOut: true });
    }, Math.max(1, timeoutMs));
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      finish({ exitCode: null, signal: null, timedOut: false, error: error.message, errorCode: error.code || 'spawn_error' });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      finish({ exitCode, signal, timedOut: false });
    });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function probeCommand(spec, { cwd, timeoutMs = 30_000, args = ['--version'] } = {}) {
  const parsed = parseCommand(spec);
  if (!parsed) return { available: false, reason: 'command_not_configured', command: null };
  const result = await runProcess(parsed.command, [...parsed.args, ...args], { cwd, timeoutMs });
  if (result.timedOut) return { available: false, reason: 'probe_timeout', command: [parsed.command, ...parsed.args], durationMs: result.durationMs };
  if (result.exitCode !== 0) return { available: false, reason: result.errorCode || `probe_exit_${result.exitCode}`, command: [parsed.command, ...parsed.args], stderr: result.stderr.slice(0, 512), durationMs: result.durationMs };
  return {
    available: true,
    command: [parsed.command, ...parsed.args],
    version: result.stdout.trim().split(/\r?\n/)[0].slice(0, 256) || result.stderr.trim().split(/\r?\n/)[0].slice(0, 256),
    durationMs: result.durationMs,
  };
}

export async function probeCodex({ cwd = process.cwd(), command = 'codex', timeoutMs = 30_000, live = true } = {}) {
  const version = await probeCommand(command, { cwd, timeoutMs });
  if (!version.available || !live) return { ...version, live: false };
  const parsed = parseCommand(command);
  const prompt = 'Return exactly the word READY and do not use tools.';
  const result = await runProcess(parsed.command, [...parsed.args, 'exec', '--ephemeral', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', cwd, prompt], { cwd, timeoutMs });
  const succeeded = result.exitCode === 0 && /"type":"agent_message"[\s\S]*"text":"READY"/.test(result.stdout);
  return {
    ...version,
    available: succeeded,
    live: true,
    reason: succeeded ? null : result.timedOut ? 'live_probe_timeout' : result.errorCode || 'live_probe_failed',
    liveProbe: {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      responseObserved: succeeded,
      stderr: result.stderr.slice(0, 512),
    },
  };
}

export async function detectRealBenchmarkRuntime({
  cwd = process.cwd(),
  codexCommand = 'codex',
  harnessOrbitCommand = process.env.HARNESSORBIT_COMMAND,
  timeoutMs = 30_000,
  liveCodexProbe = true,
  probes = {},
} = {}) {
  const codex = probes.codex ? await probes.codex({ cwd, timeoutMs }) : await probeCodex({ cwd, command: codexCommand, timeoutMs, live: liveCodexProbe });
  const orbit = probes.harnessOrbit
    ? await probes.harnessOrbit({ cwd, timeoutMs })
    : await probeCommand(harnessOrbitCommand, { cwd, timeoutMs });
  return {
    codex,
    harnessOrbit: orbit,
    ready: codex.available === true && orbit.available === true,
    blockedReasons: [
      ...(codex.available ? [] : [`codex:${codex.reason || 'unavailable'}`]),
      ...(orbit.available ? [] : [`harnessOrbit:${orbit.reason || 'unavailable'}`]),
    ],
  };
}

async function gitSnapshot(cwd) {
  const head = await runProcess('git', ['rev-parse', 'HEAD'], { cwd, timeoutMs: 10_000 });
  const status = await runProcess('git', ['status', '--porcelain=v1'], { cwd, timeoutMs: 10_000 });
  return {
    available: head.exitCode === 0 && status.exitCode === 0,
    head: head.exitCode === 0 ? head.stdout.trim() : null,
    dirty: status.exitCode === 0 ? status.stdout.length > 0 : null,
    status: status.exitCode === 0 ? status.stdout : null,
    error: head.exitCode === 0 && status.exitCode === 0 ? null : (head.error || status.error || 'git_snapshot_failed'),
  };
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function trialDirectory(evidenceRoot, row) {
  const root = path.resolve(evidenceRoot);
  const dir = path.join(root, `trial-${sha256(identity(row)).slice(0, 32)}`);
  if (!inside(root, dir)) throw new Error('trial_evidence_path_escape');
  return dir;
}

function safeCheckRows(checks) {
  return Array.isArray(checks) ? checks.slice(0, 128).map(check => ({
    name: typeof check?.name === 'string' ? check.name.slice(0, 256) : 'check',
    status: check?.status === 'passed' ? 'passed' : 'failed',
    code: Number.isInteger(check?.code) ? check.code : null,
    durationMs: Number.isSafeInteger(check?.durationMs) ? check.durationMs : null,
    error: redactLog(check?.error || null) || null,
  })) : [];
}

async function writeTrialEvidence({ evidenceRoot, row, raw, preSnapshot, postSnapshot }) {
  const dir = trialDirectory(evidenceRoot, row);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const receipt = await writeJson(path.join(dir, 'receipt.json'), {
    schemaVersion: 1,
    observedAt: now(),
    identity: identity(row),
    outcome: raw.outcome,
    durationMs: raw.durationMs,
    exitCode: raw.exitCode ?? null,
    signal: raw.signal ?? null,
    timedOut: raw.timedOut === true,
    error: redactLog(raw.error || null) || null,
  });
  const commit = await writeJson(path.join(dir, 'commit.json'), { schemaVersion: 1, pre: preSnapshot, post: postSnapshot, baseCommit: preSnapshot.head });
  const checks = await writeJson(path.join(dir, 'checks.json'), { schemaVersion: 1, declared: safeCheckRows(raw.checks), status: raw.checkStatus || 'missing' });
  const snapshot = await writeJson(path.join(dir, 'snapshot.json'), { schemaVersion: 1, pre: preSnapshot, post: postSnapshot });
  const stdout = path.join(dir, 'stdout.txt');
  const stderr = path.join(dir, 'stderr.txt');
  await fs.writeFile(stdout, redactLog(raw.stdout || ''), { mode: 0o600 });
  await fs.writeFile(stderr, redactLog(raw.stderr || ''), { mode: 0o600 });
  return {
    receiptRef: receipt,
    commitRef: commit,
    checksRef: checks,
    snapshotRef: snapshot,
    evidenceRefs: [receipt, commit, checks, snapshot, stdout, stderr],
  };
}

export function createCommandRunner({ command, args = [], appendPrompt = true, sandbox = 'workspace-write', env = process.env } = {}) {
  return async ({ task, cwd, deadlineMs }) => {
    const parsed = parseCommand(command);
    if (!parsed || !task.prompt) return { outcome: 'unjudged', reason: 'task_or_command_missing' };
    const resolvedArgs = typeof args === 'function' ? args({ task, cwd, deadlineMs, sandbox }) : [...args];
    const result = await runProcess(parsed.command, [...parsed.args, ...resolvedArgs, ...(appendPrompt ? [task.prompt] : [])], { cwd, timeoutMs: deadlineMs, env });
    return {
      outcome: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'accepted' : 'failed',
      projectAcceptance: result.exitCode === 0 && !result.timedOut,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error || null,
      checks: [],
      checkStatus: 'not-run',
    };
  };
}

export function createCheckRunner({ checks = [] } = {}) {
  return async ({ cwd, deadlineMs }) => {
    const rows = [];
    for (const specification of checks) {
      const parsed = parseCommand(specification);
      if (!parsed) return { passed: false, status: 'invalid', checks: [{ name: String(specification), status: 'failed', error: 'invalid_check_command' }] };
      const result = await runProcess(parsed.command, parsed.args, { cwd, timeoutMs: deadlineMs });
      rows.push({
        name: String(specification),
        status: result.exitCode === 0 && !result.timedOut ? 'passed' : 'failed',
        code: result.exitCode,
        durationMs: result.durationMs,
        error: result.error || (result.timedOut ? 'check_timeout' : null),
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
    return { passed: rows.length === checks.length && rows.every(row => row.status === 'passed'), status: rows.every(row => row.status === 'passed') ? 'passed' : 'failed', checks: rows };
  };
}

async function createTrialWorkspace({ sourceCwd, baseCommit, root, row }) {
  const directory = path.join(path.resolve(root), `worktree-${sha256(identity(row)).slice(0, 32)}`);
  if (!inside(root, directory)) throw new Error('trial_worktree_path_escape');
  await fs.mkdir(path.resolve(root), { recursive: true, mode: 0o700 });
  const result = await runProcess('git', ['worktree', 'add', '--detach', directory, baseCommit], { cwd: sourceCwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`trial_worktree_create_failed:${result.errorCode || result.stderr.slice(0, 160) || result.exitCode}`);
  return { directory };
}

async function removeTrialWorkspace({ sourceCwd, directory }) {
  const result = await runProcess('git', ['worktree', 'remove', '--force', directory], { cwd: sourceCwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
}

export async function runRealBenchmark({
  plan = createRealBenchmarkPlan(),
  cwd = process.cwd(),
  evidenceRoot = path.resolve('work/real-benchmark'),
  runtime = null,
  execute = false,
  runners = {},
  tasks = null,
  baseSnapshot = null,
  enforceBaseSnapshot = true,
  checkRunner = null,
  checkers = {},
  isolateTrials = true,
} = {}) {
  const taskDefinitions = tasks || plan.taskDefinitions.map(task => ({ ...task, prompt: null }));
  const taskById = new Map(taskDefinitions.map(task => [task.id, task]));
  const effectiveRuntime = runtime || await detectRealBenchmarkRuntime({ cwd });
  const blockedReasons = [...effectiveRuntime.blockedReasons];
  if (!execute) blockedReasons.push('execution_not_requested');
  if (taskDefinitions.some(task => !task.prompt)) blockedReasons.push('task_definition_missing');
  const base = baseSnapshot || await gitSnapshot(cwd);
  if (enforceBaseSnapshot && !base.available) blockedReasons.push('base_snapshot_unavailable');
  if (enforceBaseSnapshot && base.dirty === true) blockedReasons.push('base_worktree_dirty');
  const declaredChecks = Array.isArray(plan.controls.sameChecks) ? plan.controls.sameChecks : [];
  if (declaredChecks.length > 0 && typeof checkRunner !== 'function' && Object.values(checkers).every(candidate => typeof candidate !== 'function')) {
    blockedReasons.push('checks_unavailable');
  }
  const trialResults = [];
  const expectedBaseCommit = plan.controls.sameBaseCommit === 'unknown' ? base.head : plan.controls.sameBaseCommit;
  if (execute && effectiveRuntime.ready && !blockedReasons.includes('task_definition_missing')
    && !blockedReasons.includes('base_snapshot_unavailable') && !blockedReasons.includes('base_worktree_dirty')) {
    await fs.mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
    for (const row of plannedRows(plan)) {
      const task = taskById.get(row.taskId) || {};
      const runner = runners[row.armId];
      if (typeof runner !== 'function') continue;
      let workspace = null;
      let trialCwd = cwd;
      if (isolateTrials) {
        try {
          workspace = await createTrialWorkspace({ sourceCwd: cwd, baseCommit: expectedBaseCommit, root: path.join(evidenceRoot, '.worktrees'), row });
          trialCwd = workspace.directory;
        } catch (error) {
          if (!blockedReasons.includes('trial_workspace_unavailable')) blockedReasons.push('trial_workspace_unavailable');
        }
      }
      try {
        const pre = workspace ? await gitSnapshot(trialCwd) : await gitSnapshot(cwd);
        let raw;
        if (!workspace && isolateTrials) {
          raw = { outcome: 'unjudged', projectAcceptance: false, durationMs: null, error: 'trial_workspace_unavailable', checks: [], checkStatus: 'missing' };
        } else if (enforceBaseSnapshot && (!pre.available || pre.head !== expectedBaseCommit || pre.dirty === true)) {
          if (!blockedReasons.includes('base_control_violation')) blockedReasons.push('base_control_violation');
          raw = { outcome: 'unjudged', projectAcceptance: false, durationMs: null, error: 'base_control_violation', checks: [], checkStatus: 'missing' };
        } else {
          try {
            raw = await runner({ ...row, task, cwd: trialCwd, deadlineMs: plan.deadlineMs });
            const checker = checkers[row.armId] || checkers.default || checkRunner;
            if (declaredChecks.length > 0) {
              if (typeof checker !== 'function') {
                raw = { ...raw, outcome: 'unjudged', projectAcceptance: false, error: 'checks_unavailable', checks: [], checkStatus: 'missing' };
                if (!blockedReasons.includes('checks_unavailable')) blockedReasons.push('checks_unavailable');
              } else {
                const checked = await checker({ ...row, task, cwd: trialCwd, deadlineMs: plan.deadlineMs });
                const passed = checked?.passed === true && checked?.status === 'passed' && Array.isArray(checked.checks);
                raw = { ...raw, outcome: passed ? raw.outcome : raw.outcome === 'accepted' ? 'failed' : raw.outcome, projectAcceptance: raw.projectAcceptance === true && passed, checks: checked?.checks || [], checkStatus: checked?.status || 'failed' };
              }
            } else {
              raw = { ...raw, checks: raw.checks || [], checkStatus: raw.checkStatus || 'not-required' };
            }
          } catch (error) {
            raw = { outcome: 'failed', projectAcceptance: false, durationMs: 1, error: error.message, stderr: error.stack || '', checks: [], checkStatus: declaredChecks.length > 0 ? 'failed' : 'not-required' };
          }
        }
        const post = workspace ? await gitSnapshot(trialCwd) : await gitSnapshot(cwd);
        const normalized = {
          ...row,
          outcome: ['accepted', 'failed', 'timeout', 'unjudged', 'cancelled'].includes(raw.outcome) ? raw.outcome : 'unjudged',
          durationMs: Number.isSafeInteger(raw.durationMs) && raw.durationMs > 0 ? raw.durationMs : null,
          projectAcceptance: raw.projectAcceptance === true,
          ...await writeTrialEvidence({ evidenceRoot, row, raw, preSnapshot: pre, postSnapshot: post }),
        };
        trialResults.push(normalized);
      } finally {
        if (workspace) await removeTrialWorkspace({ sourceCwd: cwd, directory: workspace.directory });
      }
    }
  }
  const evaluator = evaluateBenchmark(plan, {
    schemaVersion: REAL_BENCHMARK_SCHEMA_VERSION,
    experimentId: plan.experimentId,
    trials: trialResults,
  });
  const controls = {
    ...plan.controls,
    sameBaseCommit: plan.controls.sameBaseCommit === 'unknown' ? (base.head || 'unknown') : plan.controls.sameBaseCommit,
  };
  return {
    schemaVersion: REAL_BENCHMARK_SCHEMA_VERSION,
    experimentId: plan.experimentId,
    dataKind: 'real-controlled-pilot',
    status: effectiveRuntime.ready && execute && blockedReasons.length === 0 && trialResults.length === plannedRows(plan).length ? 'completed' : 'blocked',
    claimEligible: false,
    claimReason: 'Real paired evidence is exploratory until independently reviewed; this harness never enables claims by default.',
    blockedReasons,
    preflight: effectiveRuntime,
    controls,
    baseSnapshot: base,
    evidenceRoot: path.resolve(evidenceRoot),
    trials: trialResults,
    evaluator,
  };
}
