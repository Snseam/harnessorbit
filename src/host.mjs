import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { invariant } from './errors.mjs';
import { validateTask, outsideScope } from './task.mjs';
import { validateResult } from './results.mjs';
import { validateId, runPath, withLock, writeJsonAtomic } from './state.mjs';
import * as git from './git.mjs';

const now = () => new Date().toISOString();
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function hostThread(orchestrator, explicit) {
  const thread = explicit || orchestrator.coordinatorId;
  invariant(thread, 'thread_unavailable', 'Host work requires its current conversation id.');
  validateId(thread);
  invariant(!orchestrator.coordinatorId || thread === orchestrator.coordinatorId, 'host_owner_mismatch', 'Explicit thread differs from the current conversation.');
  return thread;
}

export function assertHostOwner(orchestrator, attempt, thread) {
  invariant(attempt.executorKind === 'host', 'not_host_task', 'This attempt belongs to an external worker.');
  const owner = hostThread(orchestrator, thread);
  invariant(attempt.ownerThreadId === owner, 'host_owner_mismatch', 'Host task belongs to another conversation.');
  return owner;
}

export async function startHostTask(orchestrator, runId, input, { thread, retry = false, routeDecision = null } = {}) {
  const ownerThreadId = hostThread(orchestrator, thread);
  invariant(input && !input.execution && (!input.agent || input.agent === 'codex') && (!input.isolation || input.isolation === 'checkout'), 'invalid_host_task', 'Host tasks use the current Codex and checkout; external profiles are not applied.');
  const definition = validateTask({ ...input, agent: 'codex', isolation: 'checkout' });
  invariant(!definition.agentArgs.length, 'invalid_host_task', 'Host work cannot launch CLI arguments.');
  invariant(!definition.deadlineAt || Date.parse(definition.deadlineAt) > Date.now(), 'deadline_exceeded', 'Host task deadline has passed.');
  const run = await orchestrator._loadRun(runId);
  await orchestrator._assertDirectoryScope(run.project, definition);
  const reserved = await orchestrator._reserve(runId, definition, '', retry, { executorKind: 'host', ownerThreadId, routeDecision });
  if (reserved.duplicate) return { ...(await orchestrator.inspect(runId, definition.id)), duplicate: true };
  const { attempt } = reserved;
  try {
    await fs.mkdir(attempt.directory, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(path.join(attempt.directory, 'task.json'), definition);
  } catch (error) {
    const unchanged = (await git.snapshot(attempt.cwd)).hash === attempt.baseline.hash;
    await orchestrator._update(runId, definition.id, attempt.id, a => {
      a.status = 'failed'; a.checkoutReleased = unchanged;
      a.hostStoppedEvidence = { source: 'controller-before-host-work', at: now() };
      a.lastError = { code: 'host_setup_failed', message: 'Host task files could not be prepared.' };
    });
    throw error;
  }
  return orchestrator.inspect(runId, definition.id);
}

export async function reportHostTask(orchestrator, runId, taskId, value, { thread } = {}) {
  await orchestrator._attempt(runId, taskId);
  return withLock(path.join(runPath(orchestrator.root, runId), `verify-${taskId}.lock`), async () => {
    const { task, attempt } = await orchestrator._attempt(runId, taskId);
    assertHostOwner(orchestrator, attempt, thread);
    validateResult(value, task.definition, attempt);
    invariant(value.hostStopped === true, 'host_not_stopped', 'Report hostStopped:true only after editing and owned children have stopped.');
    invariant(value.children.every(child => ['completed', 'cancelled'].includes(child.status)), 'children_unfinished', 'Running or unknown children prevent host submission.');
    const snapshot = await git.snapshot(attempt.cwd);
    if (attempt.reportHash === hash(value) && ['submitted', 'accepted'].includes(attempt.status) && snapshot.hash === attempt.snapshot?.hash) return { ...(await orchestrator.inspect(runId, taskId)), duplicate: true };
    invariant(['running', 'needs_input'].includes(attempt.status) && !attempt.cancelRequested, 'host_report_not_allowed', 'Start a host retry for rework, or release a cancelled host task.');
    const changedPaths = git.changedPaths(attempt.baseline, snapshot);
    const unexpected = outsideScope(changedPaths, task.definition.allowedPaths);
    // Persist the report as evidence, never as an assertion of acceptance.
    await writeJsonAtomic(attempt.resultFile, value);
    await orchestrator._update(runId, taskId, attempt.id, a => {
      invariant(['running', 'needs_input'].includes(a.status) && !a.cancelRequested, 'host_report_not_allowed', 'Host task changed during submission.');
      a.report = value; a.reportHash = hash(value); a.snapshot = snapshot; a.changedPaths = changedPaths; a.outsideScope = unexpected;
      a.hostStoppedEvidence = { source: 'host-reported', at: now(), ownerThreadId: a.ownerThreadId };
      a.collectedAt = now(); a.observedAt = now();
      a.status = unexpected.length || value.unresolved.length || value.status === 'needs_input' ? 'needs_input' : 'submitted';
      if (unexpected.length) a.lastError = { code: 'scope_violation', message: 'Host changed files outside its declared scope.' };
      else if (a.status === 'needs_input') a.lastError = { code: 'host_blocked', message: 'Host reported unresolved work.' };
      else delete a.lastError;
    });
    return orchestrator.inspect(runId, taskId);
  });
}

export async function releaseHostTask(orchestrator, runId, taskId, { thread, ackStopped = false, children } = {}) {
  const { run } = await orchestrator._attempt(runId, taskId);
  const projectKey = crypto.createHash('sha256').update(run.project).digest('hex');
  return withLock(path.join(orchestrator.root, 'locks', `project-${projectKey}`), () =>
    withLock(path.join(runPath(orchestrator.root, runId), `verify-${taskId}.lock`), async () => {
      const { task, attempt } = await orchestrator._attempt(runId, taskId);
      assertHostOwner(orchestrator, attempt, thread);
      invariant(ackStopped, 'host_stop_confirmation_required', 'Confirm that host editing and owned children have stopped.');
      invariant(!['accepted', 'integrated', 'verifying'].includes(attempt.status), 'host_release_not_allowed', 'Accepted work is already delivered; an active verifier must finish before release.');
      const reported = children ?? attempt.report?.children ?? [];
      validateResult({ taskId, attemptId: attempt.id, nonce: attempt.nonce, status: 'needs_input', summary: '', changedFiles: [], checks: [], unresolved: [], children: reported }, task.definition, attempt);
      invariant(reported.every(child => ['completed', 'cancelled'].includes(child.status)), 'children_unfinished', 'Unknown or running native children cannot be released.');
      const ids = new Set(reported.map(child => child.id));
      invariant((attempt.report?.children || []).every(child => ids.has(child.id)), 'children_unfinished', 'Do not omit previously reported children.');
      const unchanged = (await git.snapshot(attempt.cwd)).hash === attempt.baseline.hash;
      await orchestrator._update(runId, taskId, attempt.id, a => {
        a.hostStoppedEvidence = { source: 'host-reported', at: now(), ownerThreadId: a.ownerThreadId };
        a.releasedChildren = reported; a.cancelRequested = true; a.status = 'cancelled';
        a.checkoutReleased = unchanged;
      });
      return orchestrator.inspect(runId, taskId);
    }));
}
