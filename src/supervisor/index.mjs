import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as state from '../state.mjs';

const ACTIVE_WORKER = new Set(['preparing', 'launching', 'ready', 'sending', 'running', 'uncertain', 'needs_input', 'submitted']);
const COLLECTABLE = new Set(['running', 'sending', 'uncertain', 'needs_input']);
const CONTROLLER_ACTIVE = new Set(['preparing', 'launching', 'verifying', 'integrating']);
const HOLD = new Set(['rework', 'failed', 'interrupted', 'cancelled', 'integration_failed', 'integration_cancelled']);
const FINAL = new Set(['integrated']);
const REPORT_ERRORS = new Set(['missing_result', 'invalid_result', 'state_invalid_json']);
const NO_PROGRESS_MS = 5 * 60 * 1000;
const WAIT_NOTE = 'waitMs bounds foreground polling and starting another supervisor action cycle; in-flight verification and integration finish under their own check timeouts and task deadlines.';

const iso = (ms) => new Date(ms).toISOString();
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const current = (task) => task?.attempts?.find((attempt) => attempt.id === task.currentAttempt) || null;
const errorCode = (error) => error?.code || 'error';

function clampWait(waitMs) {
  if (!Number.isInteger(waitMs) || waitMs < 0) throw new TypeError('waitMs must be a non-negative integer.');
  return Math.min(waitMs, 45000);
}

function isExpired(attempt, task, now) {
  const deadlineAt = attempt?.deadlineAt || task?.definition?.deadlineAt;
  if (!deadlineAt) return false;
  const deadline = Date.parse(deadlineAt);
  return Number.isFinite(deadline) && deadline <= now;
}

function hasOpenOwnedWorker(attempt) {
  return Boolean(attempt?.paneId && !attempt.workerClosed);
}

function shouldCancelForDeadline(attempt) {
  if (!attempt || ['accepted', 'integrated'].includes(attempt.status) || HOLD.has(attempt.status)) return false;
  if (!ACTIVE_WORKER.has(attempt.status)) return false;
  return hasOpenOwnedWorker(attempt) || ['preparing', 'launching'].includes(attempt.status);
}

function canIntegrate(snapshot, integrate) {
  return Boolean(integrate && snapshot.status === 'accepted' && snapshot.isolation === 'worktree' && !snapshot.expired);
}

function needsAnotherCycle(snapshot, integrate) {
  return ['running', 'sending', 'uncertain', 'submitted'].includes(snapshot.status) || canIntegrate(snapshot, integrate);
}

function canProgressImmediately(snapshot, integrate) {
  return snapshot.status === 'submitted' || canIntegrate(snapshot, integrate);
}

function attentionItem(snapshot, reason) {
  return {
    key: `${snapshot.taskId}:${snapshot.attemptId}:${reason}`,
    taskId: snapshot.taskId,
    attemptId: snapshot.attemptId,
    reason,
  };
}

export class Supervisor {
  constructor({ orchestrator, now = Date.now, sleep = defaultSleep } = {}) {
    if (!orchestrator || typeof orchestrator !== 'object') throw new TypeError('Supervisor requires an orchestrator.');
    if (typeof orchestrator.root !== 'string') throw new TypeError('Supervisor orchestrator must expose root.');
    this.orchestrator = orchestrator;
    this.now = now;
    this.sleep = sleep;
  }

  async step(runId, { integrate = false, repairReports = false } = {}) {
    state.validateId(runId);
    return this.#withSupervisor(runId, (owner) => this.#cycle(runId, { integrate, repairReports }, owner), { timeoutMs: 0 });
  }

  async supervise(runId, { integrate = false, repairReports = false, waitMs = 30000, pollMs = 1000, onEvent } = {}) {
    state.validateId(runId);
    const boundedWait = clampWait(waitMs);
    if (!Number.isInteger(pollMs) || pollMs <= 0) throw new TypeError('pollMs must be a positive integer.');
    const deadline = this.now() + boundedWait;

    return this.#withSupervisor(runId, async (owner) => {
      let last = null;
      const finish = (result) => ({ ...result, waitBudgetMs: boundedWait, note: WAIT_NOTE });
      while (true) {
        if (last && this.now() >= deadline) return finish({ ...last, reason: 'timeout' });
        last = await this.#cycle(runId, { integrate, repairReports }, owner);
        for (const event of last.events) await onEvent?.(event);
        if (['complete', 'attention'].includes(last.reason)) return finish(last);
        if (last.reason === 'idle' && !last.snapshots.some((snapshot) => needsAnotherCycle(snapshot, integrate))) return finish(last);
        if (last.snapshots.some((snapshot) => canProgressImmediately(snapshot, integrate))) continue;
        const remaining = deadline - this.now();
        if (remaining <= 0) return finish({ ...last, reason: 'timeout' });
        await this.sleep(Math.min(pollMs, remaining));
      }
    }, { timeoutMs: 0 });
  }

  async #withSupervisor(runId, fn, { timeoutMs }) {
    await this.#loadRun(runId);
    const lockPath = path.join(state.runPath(this.orchestrator.root, runId), '.supervisor.lock');
    const owner = this.#newOwner();
    return state.withLock(lockPath, async () => {
      await this.#setOwner(runId, owner);
      try {
        return await fn(owner);
      } finally {
        await this.#clearOwner(runId, owner);
      }
    }, { timeoutMs });
  }

  async #cycle(runId, options, owner) {
    const events = [{ type: 'supervisor.started', runId, owner: owner.epoch, at: owner.heartbeatAt }];
    await this.#heartbeat(runId, owner);
    const initial = await this.#loadRun(runId);
    for (const task of Object.values(initial.tasks || {})) {
      try {
        await this.#reconcileTask(runId, task.definition.id, options, events);
      } catch (error) {
        events.push({ type: 'task.reconcile_failed', runId, taskId: task.definition.id, errorCode: errorCode(error) });
      }
      await this.#heartbeat(runId, owner);
    }
    const run = await this.#loadRun(runId);
    const snapshots = Object.values(run.tasks || {}).map((task) => this.#snapshot(task));
    const attention = await this.#recordAttention(runId, snapshots, events);
    const reason = this.#reason(snapshots, attention, events, options);
    events.push({ type: 'supervisor.finished', runId, reason, at: iso(this.now()) });
    return { runId, reason, projectAcceptance: 'unknown', snapshots, events };
  }

  #newOwner() {
    const at = iso(this.now());
    return {
      pid: process.pid,
      hostname: os.hostname(),
      epoch: crypto.randomUUID(),
      startedAt: at,
      heartbeatAt: at,
    };
  }

  async #loadRun(runId) {
    const run = await state.loadRun(this.orchestrator.root, runId);
    if (!run) {
      const error = new Error(`Run ${runId} does not exist.`);
      error.code = 'run_not_found';
      throw error;
    }
    return run;
  }

  async #mutateRun(runId, mutator) {
    return state.withLock(path.join(state.runPath(this.orchestrator.root, runId), '.lock'), async () => {
      const run = await this.#loadRun(runId);
      await mutator(run);
      run.updatedAt = iso(this.now());
      await state.saveRun(this.orchestrator.root, run);
      return run;
    });
  }

  async #setOwner(runId, owner) {
    await this.#mutateRun(runId, (run) => {
      run.supervisor ||= {};
      run.supervisor.owner = owner;
    });
  }

  async #heartbeat(runId, owner) {
    await this.#mutateRun(runId, (run) => {
      if (run.supervisor?.owner?.epoch === owner.epoch) run.supervisor.owner.heartbeatAt = iso(this.now());
    });
  }

  async #clearOwner(runId, owner) {
    await this.#mutateRun(runId, (run) => {
      if (run.supervisor?.owner?.epoch === owner.epoch) delete run.supervisor.owner;
    });
  }

  async #reconcileTask(runId, taskId, options, events) {
    const before = await this.orchestrator.inspect(runId, taskId);
    const attempt = before.attempt;
    const task = { definition: before.task };
    const expired = isExpired(attempt, task, this.now());

    if (attempt.executorKind === 'host') {
      if (expired && ['running', 'needs_input', 'submitted'].includes(attempt.status)) {
        await this.orchestrator.cancel(runId, taskId, { reason: 'deadline' });
        events.push({ type: 'task.attention', taskId, attemptId: attempt.id, reason: 'host_stop_required' });
      } else if (attempt.status === 'submitted') {
        const result = await this.orchestrator.hostVerify(runId, taskId);
        events.push({ type: 'task.verified', taskId, attemptId: attempt.id, to: result.attempt.status });
      } else if (attempt.status !== 'accepted') events.push({ type: 'task.attention', taskId, attemptId: attempt.id, reason: 'host_report_required' });
      return;
    }

    if (expired && shouldCancelForDeadline(attempt)) {
      try {
        const result = await this.orchestrator.cancel(runId, taskId, { reason: 'deadline' });
        events.push({ type: 'task.cancelled_for_deadline', runId, taskId, attemptId: attempt.id, status: result.attempt.status });
      } catch (error) {
        events.push({ type: 'task.cancel_failed', runId, taskId, attemptId: attempt.id, errorCode: errorCode(error) });
      }
      return;
    }

    if (expired && attempt.status === 'accepted') {
      events.push({ type: 'task.attention', runId, taskId, attemptId: attempt.id, reason: 'deadline_accepted' });
      return;
    }

    if (CONTROLLER_ACTIVE.has(attempt.status)) {
      events.push({ type: 'task.attention', runId, taskId, attemptId: attempt.id, reason: `active_${attempt.status}` });
      return;
    }

    if (attempt.status === 'ready' && !attempt.submissionStartedAt) {
      events.push({ type: 'task.attention', runId, taskId, attemptId: attempt.id, reason: 'ready_unsubmitted' });
      return;
    }

    if (COLLECTABLE.has(attempt.status)) {
      const result = await this.orchestrator.collect(runId, taskId, { waitMs: 0 });
      events.push({ type: 'task.collected', runId, taskId, attemptId: attempt.id, from: attempt.status, to: result.attempt.status });
      await this.#maybeRequestReport(runId, taskId, result.attempt, options, events);
      return;
    }

    if (attempt.status === 'submitted') {
      const result = await this.orchestrator.verify(runId, taskId);
      events.push({ type: 'task.verified', runId, taskId, attemptId: attempt.id, from: attempt.status, to: result.attempt.status });
      return;
    }

    if (attempt.status === 'accepted') {
      if (options.integrate && task.definition.isolation === 'worktree') {
        const result = await this.orchestrator.integrate(runId, taskId);
        events.push({ type: 'task.integrated', runId, taskId, attemptId: attempt.id, from: attempt.status, to: result.attempt.status });
      } else {
        events.push({ type: 'task.accepted_hold', runId, taskId, attemptId: attempt.id });
      }
    }
  }

  async #maybeRequestReport(runId, taskId, attempt, options, events) {
    if (!options.repairReports) return;
    if (attempt.status !== 'needs_input' || !REPORT_ERRORS.has(attempt.lastError?.code)) return;
    if (typeof this.orchestrator.requestReport !== 'function') {
      events.push({ type: 'task.report_repair_unavailable', runId, taskId, attemptId: attempt.id });
      return;
    }
    try {
      const result = await this.orchestrator.requestReport(runId, taskId);
      events.push({ type: 'task.report_requested', runId, taskId, attemptId: attempt.id, requested: Boolean(result?.requested) });
    } catch (error) {
      events.push({ type: 'task.report_request_failed', runId, taskId, attemptId: attempt.id, errorCode: errorCode(error) });
    }
  }

  #snapshot(task) {
    const attempt = current(task);
    const deadlineAt = attempt?.deadlineAt || task.definition.deadlineAt || null;
    return {
      taskId: task.definition.id,
      attemptId: attempt?.id || null,
      status: attempt?.status || 'missing',
      isolation: task.definition.isolation,
      executorKind: attempt?.executorKind || 'external',
      deadlineAt,
      expired: deadlineAt ? Date.parse(deadlineAt) <= this.now() : false,
      workerClosed: Boolean(attempt?.workerClosed),
      errorCode: attempt?.lastError?.code || null,
      childStatuses: (attempt?.report?.children || []).map((child) => ({ status: child?.status })),
      performance: attempt?.performance?.lastProgressAt ? { lastProgressAt: attempt.performance.lastProgressAt } : null,
    };
  }

  async #recordAttention(runId, snapshots, events) {
    const attention = snapshots.flatMap((snapshot) => this.#attentionFor(snapshot));
    if (!attention.length) return attention;

    await this.#mutateRun(runId, (run) => {
      run.supervisor ||= {};
      run.supervisor.attention ||= {};
      const at = iso(this.now());
      for (const item of attention) {
        const existing = run.supervisor.attention[item.key];
        if (existing) {
          existing.lastAt = at;
          existing.count = (existing.count || 1) + 1;
          continue;
        }
        run.supervisor.attention[item.key] = { ...item, firstAt: at, lastAt: at, count: 1 };
        events.push({ type: 'supervisor.attention', runId, ...item });
      }
    });

    return attention;
  }

  #attentionFor(snapshot) {
    const items = [];
    if (snapshot.executorKind === 'host' && !['accepted', 'submitted'].includes(snapshot.status)) {
      items.push({ key: `${snapshot.taskId}:${snapshot.attemptId}:host`, taskId: snapshot.taskId, attemptId: snapshot.attemptId, reason: 'host_report_or_stop_required' });
    }
    if (HOLD.has(snapshot.status) || ['needs_input', 'cancelling'].includes(snapshot.status)) {
      items.push(attentionItem(snapshot, snapshot.errorCode || snapshot.status));
    }
    for (let index = 0; index < snapshot.childStatuses.length; index++) {
      const child = snapshot.childStatuses[index];
      if (['running', 'unknown'].includes(child?.status)) {
        items.push({ key: `${snapshot.taskId}:${snapshot.attemptId}:child:${index}:${child.status}`, taskId: snapshot.taskId, attemptId: snapshot.attemptId, reason: `child_${child.status}` });
      }
    }
    if (snapshot.status === 'ready') {
      items.push({ key: `${snapshot.taskId}:${snapshot.attemptId}:ready_unsubmitted`, taskId: snapshot.taskId, attemptId: snapshot.attemptId, reason: 'ready_unsubmitted' });
    }
    if (snapshot.status === 'accepted' && snapshot.expired) {
      items.push({ key: `${snapshot.taskId}:${snapshot.attemptId}:deadline_accepted`, taskId: snapshot.taskId, attemptId: snapshot.attemptId, reason: 'deadline_accepted' });
    }
    if (ACTIVE_WORKER.has(snapshot.status) && snapshot.performance?.lastProgressAt) {
      const lastProgress = Date.parse(snapshot.performance.lastProgressAt);
      if (Number.isFinite(lastProgress) && this.now() - lastProgress >= NO_PROGRESS_MS) {
        items.push({ key: `${snapshot.taskId}:${snapshot.attemptId}:no_progress`, taskId: snapshot.taskId, attemptId: snapshot.attemptId, reason: 'no_progress' });
      }
    }
    if (CONTROLLER_ACTIVE.has(snapshot.status)) {
      items.push({ key: `${snapshot.taskId}:${snapshot.attemptId}:active:${snapshot.status}`, taskId: snapshot.taskId, attemptId: snapshot.attemptId, reason: `active_${snapshot.status}` });
    }
    return items;
  }

  #reason(snapshots, attention, events, options) {
    if (attention.length || events.some((event) => event.type?.endsWith('_failed'))) return 'attention';
    if (!snapshots.length) return 'complete';
    if (snapshots.some((snapshot) => needsAnotherCycle(snapshot, options.integrate))) return 'idle';
    if (snapshots.every((snapshot) => FINAL.has(snapshot.status) || snapshot.status === 'accepted')) return 'complete';
    return 'idle';
  }
}
