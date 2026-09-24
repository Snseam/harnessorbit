import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createContextPacket } from './context-packet.mjs';
import {
  createDecisionRequest,
  decideWithFallback,
  DeterministicDecisionProvider,
  JevDecisionProvider,
} from './decision-provider.mjs';
import { ProjectLedger } from './project-ledger.mjs';

export const HARNESSORBIT_RUNNER_VERSION = '0.1.0';

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeStateRoot(value, cwd) {
  const configured = typeof value === 'string' && value.length > 0 ? value : path.join(os.tmpdir(), 'cao-harnessorbit-runtime');
  const root = path.resolve(configured);
  if (root === path.resolve(cwd) || root.startsWith(`${path.resolve(cwd)}${path.sep}`)) {
    return path.join(os.tmpdir(), 'cao-harnessorbit-runtime');
  }
  return root;
}

export function parseTaskPrompt(argv = []) {
  const values = argv.filter(value => typeof value === 'string' && value.length > 0);
  return values.at(-1) || null;
}

export function buildGovernedPrompt(prompt, { context, decision } = {}) {
  const task = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : null;
  if (!task) return null;
  const packet = context?.project && context?.baseline
    ? `Bounded project context: root=${context.project.root}; head=${context.project.head || 'unknown'}; fileCount=${context.baseline.fileCount}; snapshotDigest=${context.baseline.snapshotDigest}.`
    : 'Bounded project context is unavailable; inspect only the current checkout.';
  const decisionLine = decision?.recommendation?.action === 'hold'
    ? 'The advisory decision is hold; continue only with deterministic local checks and stop if the task is ambiguous or unsafe.'
    : 'The advisory decision is informational only; deterministic local rules remain authoritative.';
  return [
    'HarnessOrbit governed execution.',
    packet,
    decisionLine,
    'Work only in the current checkout. Keep changes within the task scope. Do not access credentials, private transcripts, or unrelated repositories.',
    'Implement the user task below. Before finishing, inspect the diff and leave the checkout ready for an independent verification command.',
    `User task: ${task}`,
  ].join('\n');
}

function spawnCodex({ command, cwd, prompt, timeoutMs = 900_000, env = process.env, spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn(command, [
      'exec', '--ephemeral', '--json', '--sandbox', 'workspace-write',
      '--skip-git-repo-check', '-C', cwd, prompt,
    ], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, durationMs: Math.max(1, Date.now() - startedAt) });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({ exitCode: null, signal: 'SIGTERM', timedOut: true });
    }, Math.max(1, timeoutMs));
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish({ exitCode: null, signal: null, timedOut: false, errorCode: error.code || 'spawn_error' }));
    child.on('close', (exitCode, signal) => finish({ exitCode, signal, timedOut: false }));
  });
}

export function childEnvironment(env = process.env) {
  const result = { ...env };
  for (const key of ['JEV_JBSD_API_KEY', 'JEV_JBSD_APIKEY', 'JEV_API_KEY', 'JEV_ENDPOINT', 'JEV_MODEL']) delete result[key];
  return result;
}

export async function runHarnessOrbit({
  cwd = process.cwd(),
  prompt,
  codexCommand = process.env.HARNESSORBIT_CODEX_COMMAND || 'codex',
  timeoutMs = 900_000,
  stateRoot = process.env.HARNESSORBIT_STATE_ROOT,
  env = process.env,
  spawnImpl = spawn,
  decisionProvider = null,
  fallbackProvider = new DeterministicDecisionProvider(),
} = {}) {
  const task = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : null;
  if (!task) return { outcome: 'unjudged', reason: 'task_or_command_missing' };
  const project = path.resolve(cwd);
  const packet = createContextPacket({ project, includePaths: ['src/', 'scripts/', 'tests/', 'docs/'] });
  const request = createDecisionRequest({
    kind: 'route.candidate',
    state: { phase: 'dispatch', risk: 'low', taskKind: 'feature', candidateCount: 2 },
    candidates: [
      { id: 'codex', eligible: true, score: 1 },
      { id: 'hold', eligible: true, score: 0 },
    ],
    mode: 'shadow',
  });
  const provider = decisionProvider || (env.JEV_ENDPOINT && (env.JEV_JBSD_API_KEY || env.JEV_JBSD_APIKEY)
    ? new JevDecisionProvider({ endpoint: env.JEV_ENDPOINT, apiKey: env.JEV_JBSD_API_KEY || env.JEV_JBSD_APIKEY, timeoutMs: 1200 })
    : fallbackProvider);
  const decision = await decideWithFallback(request, { provider, fallback: fallbackProvider, mode: 'shadow' });
  const ledger = new ProjectLedger({ root: safeStateRoot(stateRoot, project), project });
  await ledger.recordContext(packet, [{ kind: 'task', digest: digest(task) }]);
  await ledger.recordDecision(decision, [{ kind: 'task', digest: digest(task) }]);
  const governedPrompt = buildGovernedPrompt(task, { context: packet, decision });
  const result = await spawnCodex({ command: codexCommand, cwd: project, prompt: governedPrompt, timeoutMs, env: childEnvironment(env), spawnImpl });
  return {
    outcome: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'accepted' : 'failed',
    projectAcceptance: result.exitCode === 0 && !result.timedOut,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.errorCode || null,
    checks: [],
    checkStatus: 'not-run',
    harnessOrbit: {
      version: HARNESSORBIT_RUNNER_VERSION,
      contextDigest: packet.packetDigest,
      decisionDigest: digest(decision),
      finalLocalAction: decision.finalLocalAction,
    },
  };
}
