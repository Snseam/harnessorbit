import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { OrchestratorError, invariant } from './errors.mjs';
import * as state from './state.mjs';
import { validateTask, taskDigest, outsideScope, assessScope, retryAdvice } from './task.mjs';
import * as git from './git.mjs';
import { Herdr } from './runtime/herdr.mjs';
import { runCommand } from './process.mjs';
import { buildLaunch, compilePrompt, compileDispatchPrompt } from './adapters.mjs';
import { ProfileStore } from './profiles.mjs';
import { GatewayManager } from './gateway/manager.mjs';
import { selectRoute, reserveExecution, releaseExecution, explainRoute } from './routing.mjs';
import { prepareExecution, cleanupExecution } from './execution-config.mjs';
import { prepareClaudeTelemetry } from './monitor/claude.mjs';
import { trackAttempt, summarizeRun } from './performance/index.mjs';
import { preflightProject } from './preflight.mjs';
import { validateResult } from './results.mjs';
import { startHostTask, reportHostTask, releaseHostTask, assertHostOwner } from './host.mjs';
import { ResourceService } from './resources/index.mjs';
import { checkNativeChildren } from './native-children.mjs';
import { recordTaskEvidence } from './resources/task-evidence.mjs';
import { blockedWaitLastError, shouldClearBlockedWait } from './blocked-output.mjs';
import { providerObservationFromText } from './provider-observation.mjs';
import { createAttemptEvent } from './runtime-contract.mjs';
import { ProjectLedger } from './project-ledger.mjs';
import { RunApi } from './run-api.mjs';

const time = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const active = new Set(['integrating', 'preparing', 'launching', 'ready', 'sending', 'running', 'uncertain', 'needs_input', 'submitted', 'verifying', 'cancelling']);
const integrationHold = a => ['integrating', 'integration_failed', 'integration_cancelled'].includes(a.status) || (a.status === 'cancelling' && a.operation?.kind === 'integration');
const checkoutHold = t => t.definition.isolation === 'checkout' && !['accepted', 'integrated'].includes(current(t).status) && !current(t).checkoutReleased;
const stopped = a => a.executorKind === 'host' ? Boolean(a.hostStoppedEvidence) : a.workerClosed;
const missing = error => ['agent_not_found', 'agent_not_running', 'pane_not_found'].includes(error.code);
const serializeError = e => ({ code: e.code || 'error', message: e.message, details: e.details || {} });
const boundedEventErrorCode = (code) => {
  if (typeof code !== 'string' || !code) return null;
  const bounded = code.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 80);
  return bounded || null;
};
const current = record => record.attempts.find(a => a.id === record.currentAttempt);
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const hashFile = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const nativeProjectMarkers = {
  claude: ['.claude', '.mcp.json', 'CLAUDE.md'],
  pi: ['.pi', 'AGENTS.md', 'CLAUDE.md'],
  codex: ['.codex', 'AGENTS.md', 'AGENTS.override.md'],
  opencode: ['.opencode', 'opencode.json', 'opencode.jsonc', 'AGENTS.md'],
};

async function hasNativeProjectOverrides(agent, directories) {
  for (const directory of new Set(directories.filter(Boolean))) {
    for (const marker of nativeProjectMarkers[agent] || []) {
      try { await fs.lstat(path.join(directory, marker)); return true; }
      catch (error) { if (error.code !== 'ENOENT') return true; }
    }
  }
  return false;
}

export function defaultStateRoot() {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const current = path.join(base, 'harnessorbit');
  const legacy = path.join(base, 'codex-agent-orchestrator');
  // Keep existing legacy state usable after the public product rename. New
  // installations use the HarnessOrbit root; when only the legacy root exists,
  // continue using it so runs and conversation preferences are not stranded.
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
}

export class Orchestrator {
  constructor({ stateRoot = defaultStateRoot(), herdr = new Herdr(), command = runCommand, profiles, gateways, materialize = prepareExecution, telemetry = prepareClaudeTelemetry, resourceResolver, coordinatorId = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || null } = {}) {
    this.root = path.resolve(stateRoot);
    this.runApi = new RunApi({ root: this.root });
    this.herdr = herdr;
    this.command = command;
    this.profiles = profiles || new ProfileStore({ root: this.root });
    this.gateways = gateways || new GatewayManager({ root: this.root, profiles: this.profiles });
    this.materialize = materialize;
    this.telemetry = telemetry;
    this.resourceResolver = resourceResolver || (id => new ResourceService({ root: this.root }).get(id));
    this.coordinatorId = typeof coordinatorId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(coordinatorId) ? coordinatorId : null;
  }

  async _loadRun(id) {
    // init stores canonical owned paths. A later CLI invocation may receive the
    // same root through a symlink (notably macOS /var -> /private/var).
    // Use that same identity for telemetry validation and runtime cleanup.
    try { this.root = await fs.realpath(this.root); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.runApi.root = this.root;
    const run = await this.runApi.get(id);
    invariant(run, 'run_not_found', `Run ${id} does not exist.`);
    invariant(run.schemaVersion === 1 && run.id === id && run.tasks && typeof run.project === 'string', 'invalid_run', 'Run record is invalid or uses an unsupported schema.');
    return run;
  }

  async loadRun(id) { return this._loadRun(id); }
  async reserveTask(...args) { return this._reserve(...args); }
  async currentAttempt(...args) { return this._attempt(...args); }
  async updateAttempt(...args) { return this._update(...args); }

  async _recordLedgerEvidence(run, evidence) {
    if (!run?.project) return;
    try {
      const ledger = new ProjectLedger({ root: this.root, project: run.project });
      await ledger.recordEvidence(evidence);
    } catch (error) {
      await this._markLedgerEvidenceIncomplete(run, error);
    }
  }

  async _recordLedgerDecision(run, result, references = []) {
    if (!run?.project || !result) return;
    try {
      const ledger = new ProjectLedger({ root: this.root, project: run.project });
      await ledger.recordDecision(result, references);
    } catch (error) {
      await this._markLedgerEvidenceIncomplete(run, error);
    }
  }

  async _markLedgerEvidenceIncomplete(run, error) {
    const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_.-]{0,95}$/.test(error.code)
      ? error.code
      : 'ledger_write_failed';
    run.ledgerEvidenceIncomplete = true;
    run.ledgerEvidenceIncompleteReason = code;
    // Hooks can run after an independent _update() has already persisted the
    // authoritative attempt. Re-read before marking the current run so the
    // observability flag is not lost with a stale in-memory snapshot.
    if (!run.id) return;
    try {
      const latest = await this.runApi.get(run.id);
      latest.ledgerEvidenceIncomplete = true;
      latest.ledgerEvidenceIncompleteReason = code;
      latest.updatedAt = time();
      await state.saveRun(this.root, latest);
    } catch {
      // The authoritative run result remains intact; the missing ledger flag
      // is itself bounded by the next successful state write.
    }
  }

  async init({ project, id, maxParallel = 4 }) {
    const info = await git.getProjectInfo(path.resolve(project));
    invariant(!inside(info.root, this.root), 'state_inside_project', 'State directory must be outside the project working tree.');
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    this.root = await fs.realpath(this.root);
    invariant(!inside(info.root, this.root), 'state_inside_project', 'State directory resolves inside the project.');
    invariant(Number.isInteger(maxParallel) && maxParallel > 0 && maxParallel <= 64, 'invalid_capacity', 'maxParallel must be an integer from 1 to 64.');
    const runId = id || `run-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    state.validateId(runId);
    const run = {
      schemaVersion: 1, id: runId, project: info.root, baseCommit: info.head,
      baseline: await git.snapshot(info.root), initiallyDirty: info.dirty,
      herdrSession: `cao-${crypto.randomBytes(10).toString('hex')}`,
      coordinatorThreadId: this.coordinatorId,
      createdAt: time(), updatedAt: time(), maxParallel, server: null, tasks: {},
    };
    await state.createRun(this.root, run);
    await state.appendEvent(this.root, run.id, { type: 'run.created', project: run.project });
    return this.status(run.id);
  }

  async _change(runId, action) {
    await this._loadRun(runId);
    return state.withLock(path.join(state.runPath(this.root, runId), '.lock'), async () => {
      const run = await this._loadRun(runId);
      const previous = new Map(Object.values(run.tasks).flatMap(task => task.attempts.map(attempt => [attempt.id, structuredClone(attempt)])));
      const result = await action(run);
      run.updatedAt = time();
      const changed = [];
      for (const task of Object.values(run.tasks)) {
        for (const attempt of task.attempts) {
          const before = previous.get(attempt.id) || null;
          attempt.performance = trackAttempt(before, attempt, run.updatedAt);
          if (before?.performance?.progressFingerprint !== attempt.performance.progressFingerprint) changed.push({
            taskId: task.definition.id, attemptId: attempt.id, status: attempt.status,
            phase: attempt.performance.phase, durationsMs: attempt.performance.durationsMs,
            blockedMs: attempt.performance.blockedMs, lastProgressAt: attempt.performance.lastProgressAt,
          });
        }
      }
      if (changed.length) run.performanceRevision = (run.performanceRevision || 0) + 1;
      await state.saveRun(this.root, run);
      if (changed.length) {
        try {
          // Projection only: committed run state stays authoritative if append fails.
          await state.appendEvent(this.root, runId, { type: 'performance.observed', schemaVersion: 1,
            eventId: `${runId}:performance:${run.performanceRevision}`, sequence: run.performanceRevision,
            ownerEpoch: run.supervisor?.owner?.epoch || null, attempts: changed });
          run.performanceRecordedRevision = run.performanceRevision;
          await state.saveRun(this.root, run);
        } catch {
          run.performanceEventsIncomplete = true;
          await state.saveRun(this.root, run);
        }
      }
      return result;
    });
  }

  async _attempt(runId, taskId) {
    state.validateId(taskId);
    const run = await this._loadRun(runId);
    const task = Object.hasOwn(run.tasks, taskId) ? run.tasks[taskId] : null;
    invariant(task, 'task_not_found', `Task ${taskId} does not exist.`);
    return { run, task, attempt: current(task) };
  }

  async _update(runId, taskId, attemptId, change) {
    return this._change(runId, async run => {
      const task = Object.hasOwn(run.tasks, taskId) ? run.tasks[taskId] : null;
      invariant(task?.currentAttempt === attemptId, 'stale_attempt', 'The current attempt changed.');
      const attempt = current(task);
      const before = attempt.status;
      await change(attempt, task, run);
      if (before !== attempt.status) {
        const errorCode = boundedEventErrorCode(attempt.lastError?.code);
        const event = createAttemptEvent({
          runId, taskId, attemptId, from: before, to: attempt.status, errorCode,
          phase: attempt.performance?.phase || null,
        });
        const recorded = await state.appendEvent(this.root, runId, event);
        const eventDigest = crypto.createHash('sha256').update(JSON.stringify(recorded)).digest('hex');
        await this._recordLedgerEvidence(run, {
          type: 'attempt.state',
          status: attempt.status,
          digest: eventDigest,
          runId,
          taskId,
          attemptId,
          references: [{ kind: 'runtime-event', id: recorded.eventId || null, digest: eventDigest }],
        });
      }
      return structuredClone(attempt);
    });
  }

  async _reserve(runId, definition, feedback, retry = false, { executorKind = 'external', ownerThreadId = null, routeDecision = null } = {}) {
    const initial = await this._loadRun(runId);
    const key = crypto.createHash('sha256').update(initial.project).digest('hex');
    return state.withLock(path.join(this.root, 'locks', `project-${key}`), () => this._change(runId, async run => {
      invariant(!run.closedAt, 'run_closed', 'This run was cleaned up. Create a new run for more work.');
      let record = Object.hasOwn(run.tasks, definition.id) ? run.tasks[definition.id] : null;
      const digest = taskDigest(definition);
      if (record && !retry) {
        invariant(record.digest === digest, 'task_conflict', 'Task ID already exists with a different definition.');
        invariant((current(record).executorKind || 'external') === executorKind, 'executor_conflict', 'Task belongs to a different execution path.');
        if (executorKind === 'host') invariant(current(record).ownerThreadId === ownerThreadId, 'host_owner_mismatch', 'Host task belongs to another conversation.');
        return { duplicate: true, task: structuredClone(record), run: structuredClone(run) };
      }
      if (retry) {
        invariant(record, 'task_not_found', 'Cannot retry a missing task.');
        invariant(record.digest === digest, 'task_conflict', 'A retry must preserve the original task definition and limits.');
        invariant(['rework', 'failed', 'interrupted', 'cancelled'].includes(current(record).status), 'attempt_active', 'Collect, verify or cancel the current attempt before retrying.');
        invariant(record.attempts.length < definition.maxAttempts, 'attempt_limit', 'The configured attempt limit was reached.');
        invariant((current(record).executorKind || 'external') === executorKind, 'executor_conflict', 'Retry must use the original execution path.');
        invariant(executorKind === 'host' ? stopped(current(record)) : (current(record).workerClosed || !current(record).paneId), 'worker_not_stopped', 'The previous worker must be confirmed stopped before retrying.');
        if (executorKind === 'host') invariant(current(record).ownerThreadId === ownerThreadId, 'host_owner_mismatch', 'Host task belongs to another conversation.');
        invariant(!(definition.isolation === 'worktree' && current(record).outsideScope?.length), 'scope_retry_forbidden', 'A worktree attempt changed files outside allowedPaths. Cancel it and dispatch a new task id; retry would reuse leftover files.');
      }
      for (const dependency of definition.dependsOn) {
        const predecessor = Object.hasOwn(run.tasks, dependency) ? run.tasks[dependency] : null;
        invariant(predecessor && ['accepted', 'integrated'].includes(current(predecessor).status), 'dependency_not_ready', `Dependency ${dependency} is not accepted.`);
        invariant(current(predecessor).status === 'integrated' || definition.isolation === 'checkout', 'dependency_not_integrated', `Integrate ${dependency} before creating a dependent worktree.`);
      }
      const count = Object.values(run.tasks).filter(t => current(t).executorKind !== 'host' && active.has(current(t).status)).length;
      invariant(executorKind === 'host' || count < run.maxParallel, 'capacity_exceeded', 'Run capacity reached. Collect and verify or cancel existing work.');
      for (const other of await state.listRuns(this.root)) {
        if (other.project !== run.project) continue;
        invariant(!Object.values(other.tasks || {}).some(t => integrationHold(current(t))), 'integration_recovery_required', 'The project has an incomplete integration. Inspect and recover it before starting new work.');
        invariant(!Object.values(other.tasks || {}).some(t => checkoutHold(t) && !(retry && other.id === runId && t.definition.id === definition.id)), 'checkout_busy', 'A checkout task owns unverified project changes. Retry or recover that task before starting other work.');
      }
      if (definition.isolation === 'checkout') {
        for (const other of await state.listRuns(this.root)) {
          if (other.project !== run.project) continue;
          for (const task of Object.values(other.tasks || {})) {
            if (other.id === run.id && task.definition.id === definition.id) continue;
            invariant(!(task.definition.isolation === 'checkout' && active.has(current(task).status)), 'checkout_busy', 'Another task owns the shared checkout. Use a worktree for parallel writes.');
          }
        }
      }
      const number = record ? record.attempts.length + 1 : 1;
      const id = `${definition.id}-a${number}-${crypto.randomBytes(4).toString('hex')}`;
      const directory = path.join(state.runPath(this.root, run.id), 'attempts', id);
      const previous = retry ? current(record) : null;
      const attempt = {
        id, taskId: definition.id, number, nonce: crypto.randomUUID(), directory,
        resultFile: path.join(directory, 'result.json'), status: 'preparing', createdAt: time(),
        cwd: previous?.cwd || null, baseline: previous?.baseline || null,
        workerName: `worker-${crypto.randomBytes(8).toString('hex')}`, paneId: null, terminalId: null,
        submissionStartedAt: null, workerClosed: false, cancelRequested: false,
        feedback: feedback || '', previousAttempt: previous?.id || null,
        baselineTree: previous?.baselineTree || null,
        launcherPid: process.pid, launcherHost: os.hostname(), launchFinishedAt: null,
        coordinatorThreadId: this.coordinatorId,
        ...(definition.deadlineAt ? { deadlineAt: definition.deadlineAt } : {}),
      };
      const binding = routeDecision || previous?.routeDecision;
      if (binding) attempt.routeDecision = structuredClone(binding);
      if (executorKind === 'host') {
        Object.assign(attempt, { executorKind, ownerThreadId, deliveryMode: 'in-place', status: 'running',
          cwd: run.project, baseline: previous?.baseline || await git.snapshot(run.project), hostStoppedEvidence: null,
          coordinatorThreadId: ownerThreadId });
        for (const field of ['workerName', 'paneId', 'terminalId', 'workerClosed', 'launcherPid', 'launcherHost', 'launchFinishedAt', 'submissionStartedAt']) delete attempt[field];
      }
      record ||= { definition, digest, attempts: [] };
      record.attempts.push(attempt);
      record.currentAttempt = id;
      run.tasks[definition.id] = record;
      const reservedEvent = await state.appendEvent(this.root, run.id, { type: 'attempt.reserved', taskId: definition.id, attemptId: id });
      const reservedDigest = crypto.createHash('sha256').update(JSON.stringify(reservedEvent)).digest('hex');
      await this._recordLedgerEvidence(run, {
        type: 'attempt.reserved',
        status: attempt.status,
        digest: reservedDigest,
        runId: run.id,
        taskId: definition.id,
        attemptId: id,
        references: [{ kind: 'runtime-event', id: reservedEvent.eventId || null, digest: reservedDigest }],
      });
      if (binding?.evidence?.decisionProvider) {
        await this._recordLedgerDecision(run, binding.evidence.decisionProvider, [
          { kind: 'attempt', id, digest: reservedDigest },
        ]);
      }
      return { duplicate: false, task: structuredClone(record), run: structuredClone(run), attempt: structuredClone(attempt) };
    }));
  }

  async dispatch(runId, input, { routeDecision = null } = {}) {
    const task = validateTask(input);
    await this._assertDirectoryScope((await this._loadRun(runId)).project, task);
    const reserved = await this._reserve(runId, task, '', false, { routeDecision });
    if (reserved.duplicate) return { duplicate: true, ...(await this.inspect(runId, task.id)) };
    await this._launch(reserved);
    return this.inspect(runId, task.id);
  }

  async preflight(runId, input) {
    const run = await this._loadRun(runId);
    const task = validateTask(input);
    const defaultProfile = task.execution ? null : await this.profiles.getDefault();
    const selector = task.execution?.native ? null : task.execution || (defaultProfile ? { profile: defaultProfile.id } : null);
    let agent = task.agent;
    if (selector) {
      const decision = await explainRoute(this.profiles, selector, { agent: agent === 'auto' ? null : agent });
      invariant(decision.selectedProfileId, 'route_unavailable', 'No eligible execution profile.', { decision });
      agent = (await this.profiles.get(decision.selectedProfileId)).agent;
    }
    invariant(agent !== 'auto', 'execution_required', 'agent:auto requires an execution profile.');
    return preflightProject({ project: run.project, task: { ...task, agent }, runtime: this.herdr });
  }

  async performance(runId) {
    return summarizeRun(await this._loadRun(runId));
  }

  async _nativeChildren(runId, task, attempt, report) {
    if (!attempt.submissionStartedAt && !attempt.paneId) return { state: 'verified', complete: true, source: 'controller-no-worker-created', children: [], reasons: [] };
    if (!attempt.submissionStartedAt && attempt.workerClosed) return { state: 'verified', complete: true, source: 'controller-stopped-before-assignment', children: [], reasons: [] };
    const evidence = await checkNativeChildren({ root: this.root, runId, task: this._effectiveTask(task, attempt), attempt, report });
    if (evidence.state === 'unknown' && attempt.routeDecision?.mode !== 'adaptive') return {
      ...evidence, state: 'reported', complete: (report?.children || []).every(child => ['completed', 'cancelled'].includes(child.status)),
      source: 'legacy-report-contract', reasons: [...evidence.reasons, 'legacy_report_contract'],
    };
    return evidence;
  }

  async _observeExecutionResource(run, task, attempt) {
    // Observe before launch; never infer a past configuration from settings read
    // after delivery. Legacy arguments and gateway fallbacks may change identity.
    if (this.herdr.evidenceSource !== 'real') return;
    let resource = attempt.routeDecision?.resource;
    if (!resource && (attempt.execution || task.agentArgs.length)) return;
    if (!resource) {
      if (await hasNativeProjectOverrides(task.agent, [run.project, attempt.cwd])) return;
      try { resource = await this.resourceResolver(`native-${task.agent}`); }
      catch { return; } // Optional feedback must not prevent explicit native work.
    }
    if (!resource?.id || !resource.fingerprint || (!resource.installed && !attempt.routeDecision?.resource)) return;
    const observation = { resourceId: resource.id, fingerprint: resource.fingerprint,
      observedAt: time(), source: 'execution-config', evidenceSource: this.herdr.evidenceSource === 'real' ? 'real' : 'mock' };
    attempt.resourceObservation = observation;
    await this._update(run.id, task.id, attempt.id, a => { a.resourceObservation = observation; });
  }

  async _recordTaskReadiness(runId, taskId) {
    const { task, attempt } = await this._attempt(runId, taskId);
    if (attempt.executorKind === 'host' || !attempt.resourceObservation || attempt.readinessEvidence?.state === 'recorded') return;
    let feedback;
    try {
      const resource = await this.resourceResolver(attempt.resourceObservation.resourceId);
      if (resource?.fingerprint !== attempt.resourceObservation.fingerprint) feedback = { state: 'skipped', reason: 'resource_configuration_changed' };
      else {
        const result = await recordTaskEvidence({ root: this.root, runId, task: task.definition, attempt });
        feedback = { state: result.recorded ? 'recorded' : 'skipped', reason: result.reason || null };
      }
    } catch {
      // Verification is authoritative. Readiness is a best-effort projection.
      feedback = { state: 'unavailable', reason: 'task_evidence_write_failed' };
    }
    try { await this._update(runId, taskId, attempt.id, a => { a.readinessEvidence = feedback; }); }
    catch { /* Accepted run state remains authoritative if feedback persistence fails. */ }
  }

  async hostStart(runId, task, options) { return startHostTask(this, runId, task, options); }
  async hostReport(runId, taskId, report, options) { return reportHostTask(this, runId, taskId, report, options); }
  async hostRelease(runId, taskId, options) { return releaseHostTask(this, runId, taskId, options); }
  async hostVerify(runId, taskId, { thread } = {}) {
    const { attempt } = await this._attempt(runId, taskId);
    assertHostOwner(this, attempt, thread);
    return this.verify(runId, taskId, { hostThread: thread || this.coordinatorId });
  }

  async _cancelCheck(runId, taskId, { ignoreDeadline = false } = {}) {
    const { attempt } = await this._attempt(runId, taskId);
    if (attempt.cancelRequested) throw new OrchestratorError('cancel_requested', 'Attempt was cancelled during launch.');
    if (!ignoreDeadline && attempt.deadlineAt && Date.parse(attempt.deadlineAt) <= Date.now()) {
      await this._update(runId, taskId, attempt.id, a => { a.deadlineExceededAt ||= time(); });
      throw new OrchestratorError('deadline_exceeded', 'Task deadline has passed.');
    }
  }

  async _launch({ run, task, attempt }) {
    const update = fn => this._update(run.id, task.definition.id, attempt.id, fn);
    try {
      await fs.mkdir(attempt.directory, { recursive: true, mode: 0o700 });
      if (attempt.routeDecision?.resource) {
        const currentResource = await this.resourceResolver(attempt.routeDecision.resource.id);
        invariant(currentResource?.fingerprint === attempt.routeDecision.resource.fingerprint, 'resource_configuration_changed', 'Selected resource changed since the routing decision. Re-evaluate before starting work.');
      }
      const preflight = await this.preflight(run.id, task.definition);
      await update(a => { a.preflight = preflight; });
      await this._configureExecution(run, task, attempt);
      await this._cancelCheck(run.id, task.definition.id);
      if (!attempt.cwd) {
        if (task.definition.isolation === 'worktree') {
          const info = await git.getProjectInfo(run.project);
          attempt.baselineTree = await git.snapshotTree(run.project);
          attempt.cwd = await git.createWorktree(run.project, path.join(attempt.directory, 'worktree'), info.head, attempt.baselineTree);
        } else attempt.cwd = run.project;
        attempt.baseline = await git.snapshot(attempt.cwd);
      }
      await update(a => { a.cwd = attempt.cwd; a.baseline = attempt.baseline; a.baselineTree = attempt.baselineTree; });
      await this._observeExecutionResource(run, task.definition, attempt);
      await state.writeJsonAtomic(path.join(attempt.directory, 'task.json'), task.definition);
      await state.writeJsonAtomic(path.join(attempt.directory, 'submission.json'), { schemaVersion: 1, id: attempt.id, nonce: attempt.nonce, resultFile: 'result.json' });
      await fs.writeFile(path.join(attempt.directory, 'prompt.txt'), compilePrompt(this._effectiveTask(task.definition, attempt), attempt), { mode: 0o600 });
      await this._cancelCheck(run.id, task.definition.id);
      if (attempt.execution) {
        const gatewayId = `gw-${crypto.createHash('sha256').update(run.id + attempt.id).digest('hex').slice(0, 24)}`;
        await update(a => { a.execution.gatewayId = gatewayId; });
        const gateway = await this.gateways.start({ id: gatewayId, snapshots: attempt.execution.snapshots, requireCapabilities: task.definition.execution?.requireCapabilities || [], allowShared: attempt.execution.allowShared });
        attempt.execution.gateway = gateway;
        await update(a => { a.execution.gateway = gateway; });
        await this._cancelCheck(run.id, task.definition.id);
        const manifest = await this.materialize({ task: task.definition, attempt, profile: attempt.execution.profile, gateway });
        attempt.launchManifest = manifest;
        await update(a => { a.launchManifest = manifest; a.nativeSession = manifest.nativeSession; });
      }
      let launch = attempt.launchManifest || buildLaunch(task.definition, attempt.directory);
      if (launch.kind === 'claude') {
        const telemetry = await this.telemetry({ root: this.root, runId: run.id, task: task.definition, attempt, launch });
        launch = telemetry.launch;
        attempt.telemetry = telemetry.manifest;
        await update(a => {
          a.telemetry = telemetry.manifest;
          if (!a.nativeSession && telemetry.manifest.enabled && telemetry.manifest.nativeSessionId) a.nativeSession = { id: telemetry.manifest.nativeSessionId, evidence: 'requested-via-native-cli', logRoots: [] };
        });
      }
      const server = await state.withLock(path.join(state.runPath(this.root, run.id), '.server.lock'), () => this.herdr.ensureServer(run.herdrSession, path.join(state.runPath(this.root, run.id), 'herdr-server.log')), { timeoutMs: 15000 });
      await this._change(run.id, r => { r.server ||= server; });
      await this._cancelCheck(run.id, task.definition.id);
      const workspace = await this.herdr.createWorkspace(run.herdrSession, attempt.cwd, attempt.id);
      const pane = workspace.result?.root_pane;
      invariant(pane?.pane_id && pane?.terminal_id, 'invalid_runtime_response', 'Herdr did not return a pane and terminal identity.');
      await update(a => { a.paneId = pane.pane_id; a.terminalId = pane.terminal_id; a.workspaceId = pane.workspace_id; a.status = a.cancelRequested ? 'cancelling' : 'launching'; });
      await this._cancelCheck(run.id, task.definition.id);
      if (attempt.launchManifest) {
        await this.herdr.prepareEnvironment(run.herdrSession, pane.pane_id, attempt.launchManifest);
        await this._cancelCheck(run.id, task.definition.id);
      }
      await this.herdr.startAgent(run.herdrSession, attempt.workerName, launch.kind, pane.pane_id, launch.args);
      await this._captureIdentity(run.id, task.definition.id);
      await this._cancelCheck(run.id, task.definition.id);
      await update(a => { a.status = 'ready'; });
      await this._sendOnce(run.id, task.definition.id);
    } catch (error) {
      const now = await this._attempt(run.id, task.definition.id);
      if (now.attempt.paneId && !now.attempt.submissionStartedAt && !now.attempt.cancelRequested) {
        try { await this._captureIdentity(run.id, task.definition.id); } catch { /* Preserve the original startup failure. */ }
      }
      if (now.attempt.cancelRequested) {
        await this.cancel(run.id, task.definition.id);
      } else {
        await update(a => {
          a.lastError = serializeError(error);
          a.status = !a.paneId ? 'failed' : (a.submissionStartedAt ? 'uncertain' : 'needs_input');
        });
        if (!now.attempt.paneId) {
          await update(a => { a.workerClosed = true; if (!a.cwd) a.checkoutReleased = true; });
          await this._releaseRuntime(run.id, task.definition.id, attempt.id);
        }
      }
    } finally {
      await update(a => { a.launchFinishedAt = time(); if (a.cancelRequested && !a.paneId) { a.workerClosed = true; a.status = 'cancelled'; } });
      const latest = await this._attempt(run.id, task.definition.id);
      if (latest.attempt.workerClosed) await this._releaseRuntime(run.id, task.definition.id, attempt.id);
    }
  }

  _effectiveTask(definition, attempt) {
    return attempt.execution ? { ...definition, agent: attempt.execution.agent } : definition;
  }

  async _configureExecution(run, task, attempt) {
    if (task.definition.execution?.native) {
      const resource = attempt.routeDecision?.resource;
      if (resource) {
        const group = resource.quotaGroup?.id || '';
        const capacity = { id: resource.id, protocol: `native-${resource.agent}`, endpoint: resource.endpoint || undefined,
          account: { id: group.startsWith('account:') ? group.slice(8) : null, maxParallel: 1 } };
        const reservation = await reserveExecution(this.root, capacity, { runId: run.id, taskId: task.definition.id, attemptId: attempt.id });
        attempt.nativeReservation = reservation;
        await this._update(run.id, task.definition.id, attempt.id, a => { a.nativeReservation = reservation; });
      }
      return;
    }
    const defaultProfile = task.definition.execution ? null : await this.profiles.getDefault();
    const selector = task.definition.execution || (defaultProfile ? { profile: defaultProfile.id } : null);
    if (!selector) {
      invariant(task.definition.agent !== 'auto', 'execution_required', 'agent:auto requires an execution selector or a default profile.');
      return;
    }
    const owner = { runId: run.id, taskId: task.definition.id, attemptId: attempt.id };
    const selected = await selectRoute(this.profiles, selector, owner, { agent: task.definition.agent === 'auto' ? null : task.definition.agent });
    const execution = {
      agent: selected.profile.agent, model: selected.profile.model, profileId: selected.profile.id,
      profileRevision: selected.profile.revision, profile: selected.profile, decision: selected.decision,
      selector: structuredClone(selector), selectorSource: task.definition.execution ? 'task' : 'default-profile',
      allowShared: selector.allowShared === true, reservations: [selected.reservation], snapshots: [selected.profile],
      excludedFallbacks: [], gateway: null, configuredAt: time(),
    };
    attempt.execution = execution;
    await this._update(run.id, task.definition.id, attempt.id, a => { a.execution = structuredClone(execution); });
    if (attempt.routeDecision?.mode === 'adaptive') {
      execution.excludedFallbacks = selected.profile.fallbacks.map(profileId => ({ profileId, reason: 'adaptive_attempt_pinned' }));
      await this._update(run.id, task.definition.id, attempt.id, a => { a.execution = structuredClone(execution); });
      return;
    }
    for (const id of selected.profile.fallbacks) {
      if (id === selected.profile.id) continue;
      const decision = await explainRoute(this.profiles, { profile: id, requireCapabilities: selector.requireCapabilities || [], allowShared: execution.allowShared }, { agent: execution.agent });
      invariant(decision.selectedProfileId, 'fallback_unavailable', 'Configured fallback profile is not eligible.', { profileId: id, decision });
      const fallback = await this.profiles.resolve(id);
      invariant(fallback.protocol === selected.profile.protocol, 'fallback_incompatible', 'Fallback protocol must match the selected profile.');
      try {
        const reservation = await reserveExecution(this.root, fallback, owner);
        if (!execution.reservations.some(r => r.id === reservation.id)) execution.reservations.push(reservation);
        execution.snapshots.push(fallback);
      } catch (error) {
        if (error.code !== 'route_capacity_exhausted') throw error;
        execution.excludedFallbacks.push({ profileId: id, reason: 'capacity_exhausted' });
      }
      await this._update(run.id, task.definition.id, attempt.id, a => { a.execution = structuredClone(execution); });
    }
  }

  async _releaseRuntime(runId, taskId, attemptId) {
    const { attempt } = await this._attempt(runId, taskId);
    if (attempt.executorKind === 'host') return;
    if ((!attempt.execution && !attempt.telemetry && !attempt.nativeReservation) || attempt.runtimeReleasedAt) return;
    invariant(attempt.id === attemptId && attempt.workerClosed, 'worker_not_stopped', 'Stop the worker before releasing its execution resources.');
    const { task } = await this._attempt(runId, taskId);
    if (attempt.telemetry?.enabled) {
      const children = await this._nativeChildren(runId, task.definition, attempt, attempt.report);
      await this._update(runId, taskId, attemptId, a => { a.nativeChildren = children; });
      invariant(children.complete, 'native_children_unverified', 'Native children are not confirmed stopped; capacity is retained.');
    }
    try {
      const gatewayId = attempt.execution?.gateway?.id || attempt.execution?.gatewayId;
      if (gatewayId) {
        const deadline = Date.now() + 5000;
        while (true) {
          try { await this.gateways.stop(gatewayId); break; }
          catch (error) { if (error.code !== 'gateway_busy' || Date.now() >= deadline) throw error; await sleep(100); }
        }
      }
      const resources = await cleanupExecution(attempt.launchManifest);
      const telemetryResources = { removed: [], retained: [] };
      if (attempt.telemetry?.enabled) {
        const expected = path.join(this.root, 'monitor', 'claude', runId, taskId, attemptId);
        invariant(attempt.telemetry.directory === expected, 'telemetry_owner_changed', 'Telemetry directory ownership changed.');
        const directory = await fs.lstat(expected);
        invariant(directory.isDirectory() && !directory.isSymbolicLink() && inside(this.root, await fs.realpath(expected)), 'telemetry_owner_changed', 'Telemetry directory was replaced.');
        for (const file of attempt.telemetry.files || []) {
          if (file.path === attempt.telemetry.eventsFile) { telemetryResources.retained.push(file.path); continue; }
          invariant(path.dirname(file.path) === expected, 'telemetry_path_invalid', 'Telemetry resource is outside its owned directory.');
          try {
            const info = await fs.lstat(file.path);
            if (info.isFile() && !info.isSymbolicLink() && await hashFile(file.path) === file.sha256) { await fs.unlink(file.path); telemetryResources.removed.push(file.path); }
            else telemetryResources.retained.push(file.path);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      for (const reservation of attempt.execution?.reservations || []) await releaseExecution(this.root, reservation);
      if (attempt.nativeReservation) await releaseExecution(this.root, attempt.nativeReservation);
      await this._update(runId, taskId, attemptId, a => { a.runtimeReleasedAt = time(); a.executionCleanup = resources; a.telemetryCleanup = telemetryResources; delete a.runtimeCleanupError; });
    } catch (error) {
      await this._update(runId, taskId, attemptId, a => { a.runtimeCleanupError = serializeError(error); });
      throw error;
    }
  }

  async _sendOnce(runId, taskId) {
    let { run, task, attempt } = await this._attempt(runId, taskId);
    await this._cancelCheck(runId, taskId);
    if (!attempt.processIdentity) {
      await this._captureIdentity(runId, taskId);
      ({ run, task, attempt } = await this._attempt(runId, taskId));
    }
    const live = await this._assertIdentity(run, attempt);
    invariant(live.interactive_ready && ['idle', 'done'].includes(live.agent_status), 'agent_not_ready', 'Agent must be ready before submitting a new task.');
    const claimed = await this._update(runId, taskId, attempt.id, a => {
      invariant(!a.submissionStartedAt, 'already_submitted', 'Submission already started; reconcile instead of resending.');
      invariant(!a.cancelRequested, 'cancel_requested', 'Attempt is being cancelled.');
      a.submissionStartedAt = time(); a.status = 'sending';
    });
    try {
      await this.herdr.prompt(run.herdrSession, attempt.workerName, compileDispatchPrompt(this._effectiveTask(task.definition, claimed), claimed), 0);
      await this._update(runId, taskId, attempt.id, a => {
        a.submissionAcknowledgedAt = time();
        a.status = a.cancelRequested ? 'cancelling' : 'running';
        a.executionPhase = 'execute';
        delete a.lastError;
      });
    } catch (error) {
      await this._update(runId, taskId, attempt.id, a => {
        a.status = a.cancelRequested ? 'cancelling' : 'uncertain';
        a.lastError = serializeError(error);
      });
    }
    const latest = await this._attempt(runId, taskId);
    if (latest.attempt.cancelRequested) await this.cancel(runId, taskId);
  }

  async _captureIdentity(runId, taskId) {
    const { run, attempt } = await this._attempt(runId, taskId);
    if (attempt.processIdentity) return this._assertIdentity(run, attempt);
    const live = (await this.herdr.getAgent(run.herdrSession, attempt.workerName)).result?.agent;
    invariant(live?.terminal_id === attempt.terminalId, 'identity_changed', 'The target terminal identity changed.');
    const info = (await this.herdr.getProcessInfo(run.herdrSession, attempt.paneId)).result?.process_info;
    invariant(info?.foreground_process_group_id && info?.shell_pid, 'identity_unavailable', 'Cannot identify the worker process group.');
    await this._update(runId, taskId, attempt.id, a => {
      a.processIdentity = { group: info.foreground_process_group_id, shell: info.shell_pid, agent: live.agent };
    });
  }

  async _assertIdentity(run, attempt) {
    const live = (await this.herdr.getAgent(run.herdrSession, attempt.workerName)).result?.agent;
    invariant(live?.terminal_id === attempt.terminalId && live?.pane_id === attempt.paneId, 'identity_changed', 'The target terminal identity changed.');
    if (attempt.processIdentity) {
      const info = (await this.herdr.getProcessInfo(run.herdrSession, attempt.paneId)).result?.process_info;
      invariant(info?.foreground_process_group_id === attempt.processIdentity.group && info?.shell_pid === attempt.processIdentity.shell && live.agent === attempt.processIdentity.agent, 'identity_changed', 'Worker process identity changed; automatic adoption is refused.');
    }
    return live;
  }

  async inspect(runId, taskId, { output = false } = {}) {
    const { run, task, attempt } = await this._attempt(runId, taskId);
    const result = { runId, task: task.definition, attempt, stateDirectory: state.runPath(this.root, runId) };
    const advice = retryAdvice(task.definition, attempt);
    if (advice) result.retryAdvice = advice;
    if (output && attempt.paneId && !attempt.workerClosed) {
      try { result.output = await this.herdr.readAgent(run.herdrSession, attempt.workerName); }
      catch (error) { result.outputError = serializeError(error); }
    }
    return result;
  }

  async _assertDirectoryScope(project, task) {
    const scope = assessScope(task.allowedPaths, (await git.snapshot(project)).files);
    invariant(!scope.ambiguousDirectories.length, 'directory_scope_missing_slash', 'Directory scopes must end with a trailing slash so files under them stay in scope. Use `dir/` or list exact files.', { scope: { root: scope.root, ambiguousDirectories: scope.ambiguousDirectories, sample: scope.sample } });
    return scope;
  }

  async status(runId) {
    if (!runId) return (await state.listRuns(this.root)).map(r => ({ id: r.id, project: r.project, taskCount: Object.keys(r.tasks || {}).length, createdAt: r.createdAt }));
    const run = await this._loadRun(runId);
    return { ...run, stateDirectory: state.runPath(this.root, runId), tasks: Object.values(run.tasks).map(t => ({ id: t.definition.id, agent: t.definition.agent, isolation: t.definition.isolation, ...current(t) })) };
  }

  async input(runId, taskId, { keys, text } = {}) {
    const { run, attempt } = await this._attempt(runId, taskId);
    invariant(attempt.executorKind !== 'host', 'host_command_required', 'Host work is controlled by its conversation; there is no terminal to address.');
    invariant(!attempt.workerClosed && attempt.paneId, 'worker_not_running', 'No live worker to address.');
    invariant(!attempt.cancelRequested && !['submitted', 'verifying', 'accepted', 'integrated'].includes(attempt.status), 'input_not_allowed', 'Input is disabled after submission or cancellation.');
    await this._assertIdentity(run, attempt);
    invariant(Boolean(keys?.length) !== Boolean(text), 'invalid_input', 'Supply either keys or text.');
    if (keys?.length) await this.herdr.keys(run.herdrSession, attempt.workerName, keys);
    else await this.herdr.prompt(run.herdrSession, attempt.workerName, text, 0);
    await this._change(runId, r => state.appendEvent(this.root, r.id, { type: 'worker.input', taskId, attemptId: attempt.id, inputKind: keys ? 'keys' : 'text' }));
    return this.inspect(runId, taskId);
  }

  async resume(runId, taskId) {
    const { run, attempt } = await this._attempt(runId, taskId);
    invariant(attempt.executorKind !== 'host', 'host_command_required', 'Use host report, host verify, or host start --retry for host work.');
    invariant(!integrationHold(attempt), 'integration_recovery_required', 'Use recover to recheck the current checkout without applying the patch again.');
    invariant(attempt.status !== 'verifying' && !(attempt.status === 'cancelling' && attempt.operation?.kind === 'verification'), 'verification_in_progress', 'Verification owns this candidate. Inspect its process and evidence before recovery; resume never resubmits or reruns these checks.');
    if (!attempt.paneId && ['preparing', 'cancelling'].includes(attempt.status) && attempt.launcherHost === os.hostname() && !alive(attempt.launcherPid)) {
      await this._update(runId, taskId, attempt.id, a => {
        a.status = a.cancelRequested ? 'cancelled' : 'interrupted'; a.workerClosed = true;
        a.lastError = { code: 'startup_interrupted', message: 'Launch process exited before recording a worker. Any empty runtime panes are retained for cleanup.' };
      });
      return this.inspect(runId, taskId);
    }
    invariant(!attempt.cancelRequested, 'cancel_requested', 'Resume cannot undo cancellation; use retry after cancellation completes.');
    invariant(!attempt.workerClosed, 'worker_closed', 'The worker is closed. Use retry with a handoff for further work.');
    if (attempt.submissionStartedAt) return this.collect(runId, taskId);
    invariant(attempt.paneId, 'not_started', 'No worker was created. Use retry to start a new attempt.');
    try { await this._sendOnce(runId, taskId); }
    catch (error) {
      await this._update(runId, taskId, attempt.id, a => { a.lastError = serializeError(error); a.status = missing(error) ? 'interrupted' : 'needs_input'; });
    }
    return this.inspect(runId, taskId);
  }

  _validateResult(value, task, attempt) {
    return validateResult(value, task, attempt);
  }

  async requestReport(runId, taskId) {
    const { attempt: target } = await this._attempt(runId, taskId);
    invariant(target.executorKind !== 'host', 'host_command_required', 'Host work reports through host report.');
    return state.withLock(path.join(state.runPath(this.root, runId), `verify-${taskId}.lock`), async () => {
      const { run, task, attempt } = await this._attempt(runId, taskId);
      if (attempt.reportRequest) return { ...(await this.inspect(runId, taskId)), duplicate: true };
      invariant(attempt.status === 'needs_input' && ['missing_result', 'invalid_result', 'state_invalid_json'].includes(attempt.lastError?.code), 'report_request_not_allowed', 'Only a missing or malformed report can be requested automatically.');
      invariant(!attempt.report?.children?.some(child => !['completed', 'cancelled'].includes(child.status)), 'children_unfinished', 'Resolve native children before requesting a report.');
      await this._cancelCheck(runId, taskId);
      const live = await this._assertIdentity(run, attempt);
      invariant(live.interactive_ready && ['idle', 'done'].includes(live.agent_status), 'agent_not_ready', 'Report request requires an idle, identified worker.');
      // Persist intent before delivery. A lost acknowledgment must never cause a second prompt.
      await this._update(runId, taskId, attempt.id, a => {
        invariant(!a.reportRequest && !a.cancelRequested && a.status === 'needs_input', 'report_request_not_allowed', 'Attempt changed before report request.');
        a.reportRequest = { startedAt: time(), acknowledgedAt: null, state: 'sending' };
      });
      try {
        await this.herdr.prompt(run.herdrSession, attempt.workerName, `Report the current attempt only; do not repeat the implementation or start new work. Read ${JSON.stringify(path.join(attempt.directory, 'prompt.txt'))} for its result contract. Write the current result atomically to ${JSON.stringify(attempt.resultFile)} with taskId ${JSON.stringify(task.definition.id)}, attemptId ${JSON.stringify(attempt.id)}, and nonce ${JSON.stringify(attempt.nonce)}. Include blockers and all actual children; never invent checks or claim acceptance.`, 0);
        await this._update(runId, taskId, attempt.id, a => {
          a.reportRequest.acknowledgedAt = time(); a.reportRequest.state = 'acknowledged';
          if (!a.cancelRequested && a.status === 'needs_input') { a.status = 'running'; delete a.lastError; }
        });
      } catch (error) {
        await this._update(runId, taskId, attempt.id, a => { a.reportRequest.state = 'uncertain'; a.lastError = serializeError(error); if (!a.cancelRequested) a.status = 'uncertain'; });
      }
      return { ...(await this.inspect(runId, taskId)), requested: true };
    });
  }

  async collect(runId, taskId, { waitMs = 0 } = {}) {
    const { attempt } = await this._attempt(runId, taskId);
    invariant(attempt.executorKind !== 'host', 'host_command_required', 'Host work submits via host report, not terminal collection.');
    return state.withLock(path.join(state.runPath(this.root, runId), `verify-${taskId}.lock`), () => this._collect(runId, taskId, { waitMs }));
  }

  async _collect(runId, taskId, { waitMs = 0 } = {}) {
    invariant(Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 45000, 'invalid_timeout', 'collect waitMs must be between 0 and 45000.');
    const deadline = Date.now() + waitMs;
    while (true) {
      const { run, task, attempt } = await this._attempt(runId, taskId);
      if (!['running', 'sending', 'uncertain', 'needs_input'].includes(attempt.status)) return this.inspect(runId, taskId);
      invariant(attempt.submissionStartedAt, 'not_submitted', 'Task has not been submitted. Inspect the worker and resume once it is ready.');
      let live;
      try {
        live = await this._assertIdentity(run, attempt);
      } catch (error) {
        await this._update(runId, taskId, attempt.id, a => { if (!a.cancelRequested) a.status = missing(error) ? 'interrupted' : 'uncertain'; a.lastError = serializeError(error); });
        return this.inspect(runId, taskId);
      }
      await this._update(runId, taskId, attempt.id, a => { a.observedAt = time(); a.lastObservedState = live.agent_status || 'unknown'; });
      if (live.agent_status === 'blocked') {
        let output = '';
        try { output = await this.herdr.readAgent(run.herdrSession, attempt.workerName); }
        catch { output = ''; }
        const lastError = blockedWaitLastError(output);
        const observation = providerObservationFromText(output);
        await this._update(runId, taskId, attempt.id, a => {
          if (!a.cancelRequested) a.status = 'needs_input';
          a.lastObservedState = 'blocked';
          a.lastError = lastError;
          if (observation) a.providerObservation = observation;
        });
        return this.inspect(runId, taskId, { output: true });
      }
      if (shouldClearBlockedWait(attempt, live)) {
        await this._update(runId, taskId, attempt.id, a => { if (!a.cancelRequested) { a.status = 'running'; delete a.lastError; } });
      }
      if (live.interactive_ready && ['idle', 'done'].includes(live.agent_status)) {
        try {
          const stat = await fs.lstat(attempt.resultFile);
          invariant(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 131072, 'invalid_result', 'Result must be a regular file of at most 128 KiB.');
          const report = this._validateResult(await state.readJson(attempt.resultFile), task.definition, attempt);
          const childrenComplete = report.children.every(c => ['completed', 'cancelled'].includes(c.status));
          const nativeChildren = await this._nativeChildren(runId, task.definition, attempt, report);
          const snap = await git.snapshot(attempt.cwd);
          const changed = git.changedPaths(attempt.baseline, snap);
          const unexpected = outsideScope(changed, task.definition.allowedPaths);
          const resultState = report.status === 'needs_input' || !childrenComplete || !nativeChildren.complete || report.unresolved.length || unexpected.length ? 'needs_input' : 'submitted';
          const output = await this.herdr.readAgent(run.herdrSession, attempt.workerName);
          await fs.writeFile(path.join(attempt.directory, 'terminal.txt'), output, { mode: 0o600 });
          await this._update(runId, taskId, attempt.id, a => {
            a.report = report; a.collectedAt = time(); a.snapshot = snap; a.changedPaths = changed;
            a.nativeChildren = nativeChildren;
            a.outsideScope = unexpected; if (!a.cancelRequested) a.status = resultState;
            if (unexpected.length) a.lastError = { code: 'scope_violation', message: 'Reported candidate changed paths outside task scope.' };
            else if (!childrenComplete || !nativeChildren.complete) a.lastError = { code: 'children_unfinished', message: 'Native children are still running or unknown.' };
            else if (report.unresolved.length || report.status === 'needs_input') a.lastError = { code: 'worker_blocked', message: 'Worker reported unresolved work; inspect the report.' };
            else delete a.lastError;
            delete a.executionPhase;
          });
          return this.inspect(runId, taskId);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            await this._update(runId, taskId, attempt.id, a => { if (!a.cancelRequested) a.status = 'needs_input'; a.lastError = serializeError(error); });
            return this.inspect(runId, taskId);
          }
          if (Date.now() >= deadline && Date.now() - Date.parse(attempt.submissionStartedAt) >= 5000) {
            let output = '';
            try { output = await this.herdr.readAgent(run.herdrSession, attempt.workerName); }
            catch { output = ''; }
            const observation = providerObservationFromText(output);
            await this._update(runId, taskId, attempt.id, a => {
              if (!a.cancelRequested) a.status = 'needs_input';
              a.lastError = { code: 'missing_result', message: 'Worker is idle without this attempt’s result file. Inspect output and request a valid report.' };
              if (observation) a.providerObservation = observation;
            });
            return this.inspect(runId, taskId, { output: true });
          }
        }
      }
      if (Date.now() >= deadline) return this.inspect(runId, taskId);
      await sleep(Math.min(1000, deadline - Date.now()));
    }
  }

  async _closeWorker(run, attempt) {
    if (attempt.workerClosed || !attempt.paneId) return;
    try {
      await this._assertIdentity(run, attempt);
    } catch (error) {
      if (!missing(error)) throw error;
      let pane;
      try { pane = (await this.herdr.getPane(run.herdrSession, attempt.paneId)).result?.pane; }
      catch (paneError) { if (paneError.code === 'pane_not_found') return; throw paneError; }
      invariant(pane?.terminal_id === attempt.terminalId, 'identity_changed', 'Refusing to close a replacement pane.');
      if (attempt.processIdentity) {
        const info = (await this.herdr.getProcessInfo(run.herdrSession, attempt.paneId)).result?.process_info;
        invariant(info?.shell_pid === attempt.processIdentity.shell && [attempt.processIdentity.group, info?.shell_pid].includes(info?.foreground_process_group_id), 'identity_changed', 'Refusing to close an unrecognized process.');
      }
    }
    try { await this.herdr.closePane(run.herdrSession, attempt.paneId); }
    catch (error) { if (error.code !== 'pane_not_found') throw error; }
  }

  async verify(runId, taskId, { recovery = false, hostThread = null } = {}) {
    await this._attempt(runId, taskId);
    return state.withLock(path.join(state.runPath(this.root, runId), `verify-${taskId}.lock`), async () => {
      const { run, task, attempt } = await this._attempt(runId, taskId);
      const isHost = attempt.executorKind === 'host';
      if (isHost) {
        assertHostOwner(this, attempt, hostThread);
        invariant(attempt.hostStoppedEvidence, 'host_not_stopped', 'The host must report that all editing has stopped.');
      }
      if (!isHost) {
        const children = await this._nativeChildren(runId, task.definition, attempt, attempt.report);
        await this._update(runId, taskId, attempt.id, a => { a.nativeChildren = children; });
        invariant(children.complete, 'native_children_unverified', 'Native children must be resolved before verification.');
      }
      invariant(['submitted', 'accepted'].includes(attempt.status), 'not_submitted', 'Collect a valid submitted result before verification.');
      invariant(!attempt.outsideScope?.length, 'scope_violation', 'Worker changed files outside its allowed paths.');
      invariant((await git.snapshot(attempt.cwd)).hash === attempt.snapshot.hash, 'candidate_changed', 'Candidate changed since collection; recollect or retry.');
      if (attempt.status === 'accepted') {
        await this._recordTaskReadiness(runId, taskId);
        return this.inspect(runId, taskId);
      }
      if (!isHost) {
        await this._closeWorker(run, attempt);
        await this._update(runId, taskId, attempt.id, a => { a.workerClosed = true; });
      await this._releaseRuntime(runId, taskId, attempt.id);
      }
      await this._update(runId, taskId, attempt.id, a => { invariant(!a.cancelRequested, 'cancel_requested', 'Verification was cancelled.'); a.status = 'verifying'; a.operation = { kind: 'verification', pid: process.pid, host: os.hostname(), finishedAt: null }; });
      const checks = [];
      let validationError;
      try {
        invariant((await git.snapshot(attempt.cwd)).hash === attempt.snapshot.hash, 'candidate_changed', 'Candidate changed while stopping its worker.');
        for (let i = 0; i < task.definition.checks.length; i++) {
          const check = task.definition.checks[i];
          let outcome;
          const startedAt = time();
          try { outcome = await this._checkCommand(runId, taskId, check, attempt.cwd, { ignoreDeadline: recovery }); }
          catch (error) { outcome = { code: null, stdout: '', stderr: error.message, error: serializeError(error) }; }
          const evidence = path.join(attempt.directory, `check-${i + 1}.json`);
          await state.writeJsonAtomic(evidence, { ...check, ...outcome, startedAt, finishedAt: time() });
          checks.push({ name: check.name, argv: check.argv, status: outcome.code === 0 ? 'passed' : 'failed', code: outcome.code, evidence, error: outcome.error || null });
          await this._cancelCheck(runId, taskId, { ignoreDeadline: recovery });
        }
        invariant((await git.snapshot(attempt.cwd)).hash === attempt.snapshot.hash, 'verification_mutated_tree', 'Verification changed source files or the candidate changed concurrently.');
        if (checks.every(c => c.status === 'passed') && task.definition.isolation === 'worktree') await git.makePatch(attempt.cwd, path.join(attempt.directory, 'candidate.patch'), attempt.baselineTree || 'HEAD');
      } catch (error) { validationError = serializeError(error); }
      const passed = !validationError && checks.length === task.definition.checks.length && checks.every(c => c.status === 'passed');
      const verification = { attemptId: attempt.id, snapshotHash: attempt.snapshot.hash, passed, checks, error: validationError || null, finishedAt: time() };
      if (passed && task.definition.isolation === 'worktree') verification.patchHash = await hashFile(path.join(attempt.directory, 'candidate.patch'));
      await state.writeJsonAtomic(path.join(attempt.directory, 'verification.json'), verification);
      await this._update(runId, taskId, attempt.id, a => {
        a.verification = verification; a.status = a.cancelRequested ? 'cancelled' : (passed ? 'accepted' : 'rework');
        a.operation.finishedAt = time();
        if (passed && task.definition.isolation === 'worktree') a.patchFile = path.join(attempt.directory, 'candidate.patch');
      });
      const verificationDigest = crypto.createHash('sha256').update(JSON.stringify(verification)).digest('hex');
      await this._recordLedgerEvidence(run, {
        type: 'verification',
        status: passed ? 'passed' : 'failed',
        digest: verificationDigest,
        runId: run.id,
        taskId: task.definition.id,
        attemptId: attempt.id,
        references: [{ kind: 'verification', id: attempt.id, digest: verificationDigest }],
      });
      if (passed) await this._recordTaskReadiness(runId, taskId);
      return this.inspect(runId, taskId);
    });
  }

  async _checkCommand(runId, taskId, check, cwd, { ignoreDeadline = false } = {}) {
    await this._cancelCheck(runId, taskId, { ignoreDeadline });
    const controller = new AbortController();
    let reading = false;
    const timer = setInterval(async () => {
      if (reading) return;
      reading = true;
      try {
        const { attempt } = await this._attempt(runId, taskId);
        if (attempt.cancelRequested) controller.abort();
        else if (!ignoreDeadline && attempt.deadlineAt && Date.parse(attempt.deadlineAt) <= Date.now()) {
          controller.abort();
          await this._update(runId, taskId, attempt.id, a => { a.deadlineExceededAt ||= time(); });
        }
      }
      catch { controller.abort(); }
      finally { reading = false; }
    }, 100);
    try { return await this.command(check.argv, { cwd, timeoutMs: check.timeoutMs, signal: controller.signal }); }
    finally { clearInterval(timer); }
  }

  async retry(runId, taskId, feedback = '') {
    const { run, task, attempt } = await this._attempt(runId, taskId);
    invariant(attempt.executorKind !== 'host', 'host_command_required', 'Use host start --retry to continue host implementation.');
    invariant(['rework', 'failed', 'interrupted', 'cancelled'].includes(attempt.status), 'attempt_active', 'Verify or cancel before retrying.');
    if (attempt.paneId && !attempt.workerClosed) {
      await this._closeWorker(run, attempt);
      await this._update(runId, taskId, attempt.id, a => { a.workerClosed = true; });
    }
    await this._releaseRuntime(runId, taskId, attempt.id);
    const evidence = [];
    for (const check of attempt.verification?.checks || []) {
      if (check.status === 'passed') continue;
      const record = await state.readJson(check.evidence);
      evidence.push({ name: check.name, code: record.code, stdout: record.stdout?.slice(-12000), stderr: record.stderr?.slice(-12000), error: record.error });
    }
    const detail = [feedback, attempt.report ? JSON.stringify(attempt.report) : '', attempt.verification ? JSON.stringify(attempt.verification) : '', evidence.length ? `Independent failure output:\n${JSON.stringify(evidence)}` : '', attempt.lastError ? JSON.stringify(attempt.lastError) : ''].filter(Boolean).join('\n');
    const reserved = await this._reserve(runId, task.definition, detail, true);
    await this._launch(reserved);
    return this.inspect(runId, taskId);
  }

  async cancel(runId, taskId, { reason = 'user' } = {}) {
    invariant(['user', 'deadline'].includes(reason), 'invalid_cancel_reason', 'Cancellation reason must be user or deadline.');
    const { run, attempt } = await this._attempt(runId, taskId);
    if (['integration_failed', 'integration_cancelled'].includes(attempt.status)) return this.inspect(runId, taskId);
    if (['cancelled', 'accepted', 'integrated'].includes(attempt.status)) {
      if (attempt.workerClosed) await this._releaseRuntime(runId, taskId, attempt.id);
      return this.inspect(runId, taskId);
    }
    await this._update(runId, taskId, attempt.id, a => {
      a.cancelRequested = true; a.status = 'cancelling'; a.cancelReason ||= reason;
      if (reason === 'deadline') a.deadlineExceededAt ||= time();
    });
    if (attempt.executorKind === 'host') return this.inspect(runId, taskId);
    if (['verifying', 'integrating'].includes(attempt.status)) return this.inspect(runId, taskId);
    try {
      await this._closeWorker(run, attempt);
      // An in-flight launch rechecks cancellation after each resource creation.
      if (attempt.paneId || attempt.launchFinishedAt || (attempt.launcherHost === os.hostname() && !alive(attempt.launcherPid))) {
        const unchanged = !attempt.cwd || (attempt.baseline && (await git.snapshot(attempt.cwd)).hash === attempt.baseline.hash);
        await this._update(runId, taskId, attempt.id, a => { a.workerClosed = true; a.status = 'cancelled'; a.checkoutReleased = Boolean(unchanged); });
        await this._releaseRuntime(runId, taskId, attempt.id);
      }
    } catch (error) { await this._update(runId, taskId, attempt.id, a => { a.lastError = serializeError(error); }); }
    return this.inspect(runId, taskId);
  }

  async integrate(runId, taskId) {
    const { run } = await this._attempt(runId, taskId);
    const key = crypto.createHash('sha256').update(run.project).digest('hex');
    return state.withLock(path.join(this.root, 'locks', `project-${key}`), async () => {
      const { task, attempt } = await this._attempt(runId, taskId);
      invariant(attempt.status === 'accepted' && attempt.workerClosed, 'not_accepted', 'Only a verified, stopped attempt can be integrated.');
      invariant(task.definition.isolation === 'worktree' && attempt.patchFile, 'not_worktree', 'Checkout tasks already modify the project directly.');
      invariant((await git.snapshot(attempt.cwd)).hash === attempt.verification.snapshotHash, 'candidate_changed', 'The accepted candidate was modified.');
      invariant(await hashFile(attempt.patchFile) === attempt.verification.patchHash, 'patch_changed', 'The verified patch was modified.');
      const target = await git.snapshot(run.project);
      for (const file of attempt.changedPaths) {
        invariant(JSON.stringify(target.files[file]) === JSON.stringify(attempt.baseline.files[file]), 'integration_conflict', `Project file changed since the candidate baseline: ${file}`);
      }
      for (const other of await state.listRuns(this.root)) {
        if (other.project !== run.project) continue;
        invariant(!Object.values(other.tasks || {}).some(t => integrationHold(current(t))), 'integration_recovery_required', 'Recover the incomplete integration before applying another patch.');
        invariant(!Object.values(other.tasks || {}).some(checkoutHold), 'checkout_busy', 'A checkout task still owns unverified project changes.');
      }
      await this._cancelCheck(runId, taskId);
      await this._update(runId, taskId, attempt.id, a => { a.status = 'integrating'; a.integrationStartedAt = time(); a.integrationBaseline = target; a.operation = { kind: 'integration', pid: process.pid, host: os.hostname(), finishedAt: null }; });
      try { await git.applyPatch(run.project, attempt.patchFile); }
      catch (error) {
        await this._update(runId, taskId, attempt.id, a => { a.status = 'integration_failed'; a.lastError = serializeError(error); a.operation.finishedAt = time(); });
        return this.inspect(runId, taskId);
      }
      return this._verifyIntegration(run, task, attempt);
    });
  }

  async _verifyIntegration(run, task, attempt, { recovery = false } = {}) {
    const before = await git.snapshot(run.project);
    const checks = [];
    for (const check of task.definition.checks) {
      try {
        const result = await this._checkCommand(run.id, task.definition.id, check, run.project, { ignoreDeadline: recovery });
        checks.push({ name: check.name, status: result.code === 0 ? 'passed' : 'failed', ...result });
      } catch (error) { checks.push({ name: check.name, status: 'failed', error: serializeError(error) }); }
    }
    const stable = (await git.snapshot(run.project)).hash === before.hash;
    const passed = stable && checks.every(c => c.status === 'passed');
    const evidence = path.join(attempt.directory, `integration-${crypto.randomBytes(6).toString('hex')}.json`);
    await state.writeJsonAtomic(evidence, { passed, stable, checks, snapshotHash: before.hash });
    await this._update(run.id, task.definition.id, attempt.id, a => {
      a.integration = { passed, stable, snapshotHash: before.hash, evidence };
      a.status = a.cancelRequested ? 'integration_cancelled' : (passed ? 'integrated' : 'integration_failed');
      a.operation.finishedAt = time();
    });
    const integrationEvidence = { passed, stable, snapshotHash: before.hash, evidence };
    const integrationDigest = crypto.createHash('sha256').update(JSON.stringify(integrationEvidence)).digest('hex');
    await this._recordLedgerEvidence(run, {
      type: 'integration',
      status: passed ? 'passed' : 'failed',
      digest: integrationDigest,
      runId: run.id,
      taskId: task.definition.id,
      attemptId: attempt.id,
      references: [{ kind: 'integration', id: attempt.id, digest: integrationDigest }],
    });
    return this.inspect(run.id, task.definition.id);
  }

  async recover(runId, taskId, { hostThread = null } = {}) {
    const { run } = await this._attempt(runId, taskId);
    const key = crypto.createHash('sha256').update(run.project).digest('hex');
    return state.withLock(path.join(this.root, 'locks', `project-${key}`), async () => {
      const { task, attempt } = await this._attempt(runId, taskId);
      if (attempt.executorKind === 'host') assertHostOwner(this, attempt, hostThread);
      if (task.definition.isolation === 'checkout') {
        invariant(['rework', 'failed', 'interrupted', 'cancelled'].includes(attempt.status) && stopped(attempt), 'not_recoverable', 'Stop the failed checkout worker before rechecking the project.');
        invariant(attempt.baseline?.files, 'recovery_evidence_missing', 'Checkout baseline is missing.');
        const candidate = await git.snapshot(run.project);
        const changed = git.changedPaths(attempt.baseline, candidate);
        invariant(!outsideScope(changed, task.definition.allowedPaths).length, 'scope_violation', 'Checkout contains changes outside the task scope.');
        await this._update(runId, taskId, attempt.id, a => { a.snapshot = candidate; a.changedPaths = changed; a.outsideScope = []; a.cancelRequested = false; a.status = 'submitted'; });
        return this.verify(runId, taskId, { recovery: true, hostThread });
      }
      invariant(integrationHold(attempt), 'not_recoverable', 'recover rechecks incomplete integrations only. It never replays a worker or applies a patch.');
      invariant(attempt.operation?.finishedAt || (attempt.operation?.host === os.hostname() && !alive(attempt.operation.pid)), 'operation_alive', 'The original integration controller may still be running.');
      invariant(attempt.integrationBaseline?.files, 'recovery_evidence_missing', 'Integration baseline is missing. Inspect the retained checkout manually.');
      const now = await git.snapshot(run.project);
      invariant(!outsideScope(git.changedPaths(attempt.integrationBaseline, now), task.definition.allowedPaths).length, 'scope_violation', 'Current checkout changed outside this integration’s scope. Review and resolve those edits before recovery.');
      await this._update(runId, taskId, attempt.id, a => {
        a.cancelRequested = false; a.status = 'integrating';
        a.operation = { kind: 'integration', pid: process.pid, host: os.hostname(), finishedAt: null };
      });
      return this._verifyIntegration(run, task, attempt, { recovery: true });
    });
  }

  async cleanup(runId) {
    const run = await this._change(runId, r => {
      invariant(!Object.values(r.tasks).some(t => active.has(current(t).status)), 'run_active', 'Cancel or finish active attempts before cleanup.');
      r.closedAt ||= time();
      return structuredClone(r);
    });
    for (const task of Object.values(run.tasks)) {
      const attempt = current(task);
      if (attempt.workerClosed) await this._releaseRuntime(runId, task.definition.id, attempt.id);
    }
    const hasRuntime = Boolean(Object.values(run.tasks).some(t => t.attempts.some(a => a.executorKind !== 'host')) || run.server);
    if (hasRuntime) {
      await this.herdr.stopServer(run.herdrSession);
      await this._change(runId, r => { r.serverStoppedAt = time(); });
    }
    return { runId, serverStopped: hasRuntime, retained: 'Worktrees, task records and evidence are retained. No project files were removed.' };
  }
}
