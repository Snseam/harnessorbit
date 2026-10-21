import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OrchestratorError, invariant } from '../errors.mjs';
import { validateTask, assessScope } from '../task.mjs';
import * as git from '../git.mjs';
import { readJson, runPath } from '../state.mjs';
import { Supervisor } from '../supervisor/index.mjs';
import { PrincipalStore } from './principals.mjs';
import { JobStore, JOB_TASK_ID } from './jobs.mjs';

export const ACCESS_SCHEMA_VERSION = 1;
export const ACCESS_VERSION = '0.3.0';
export const TOOL_TIMEOUT_MS = 20000;
export const ACCESS_TOOLS = Object.freeze(['describe', 'submit', 'status', 'approve', 'answer', 'cancel', 'retry', 'events', 'result']);
export const MAX_EVENTS = 200;
const MAX_EVENT_JOBS = 50;
// Run events a principal has no use for: periodic observations and supervisor bookkeeping.
const HIDDEN_EVENTS = new Set(['performance.observed', 'supervisor.started', 'supervisor.finished']);
const EVENT_FIELDS = ['taskId', 'attemptId', 'from', 'to', 'errorCode', 'inputKind', 'phase', 'reason', 'status'];
const CURSOR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\/[A-Za-z0-9:_.-]{1,160}$/;
const SUBMIT_KEYS = new Set(['idempotencyKey', 'project', 'objective', 'context', 'agent', 'allowedPaths', 'checks', 'maxAttempts', 'brief', 'conversationKey']);
const RUNNING = new Set(['preparing', 'launching', 'ready', 'sending', 'running', 'collecting', 'uncertain', 'submitted', 'verifying', 'integrating', 'cancelling']);
const RETRYABLE = new Set(['rework', 'failed', 'timed_out', 'interrupted']);
const ADVANCEABLE = new Set(['running', 'sending', 'uncertain', 'submitted']);
// Integration failures a new job on the current baseline fixes; everything else needs the host operator.
const RESUBMITTABLE = new Set(['integration_conflict', 'candidate_changed', 'patch_changed']);
const MAX_PATCH_BYTES = 262144;
const EVIDENCE_TAIL = 4000;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const serializeError = e => ({ code: e.code || 'error', message: e.message, ...(e.details && Object.keys(e.details).length ? { details: e.details } : {}) });
const now = () => new Date().toISOString();
const tail = (value, max) => typeof value === 'string' && value.length > max ? value.slice(-max) : (value ?? '');
const sleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
// The principal answered after the attempt was last collected, so the worker's reaction is still unobserved.
const answeredSince = (job, attempt) => {
  const last = (job.answers || []).filter(a => a.attemptId === attempt.id).at(-1);
  return Boolean(last && (!attempt.collectedAt || last.at > attempt.collectedAt));
};

function text(value, field, max, { required = true } = {}) {
  if (value === undefined) {
    invariant(!required, 'invalid_job', `${field} is required.`, { field });
    return undefined;
  }
  invariant(typeof value === 'string', 'invalid_job', `${field} must be a string.`, { field });
  const trimmed = value.trim();
  invariant(!required || trimmed.length > 0, 'invalid_job', `${field} must be nonempty.`, { field });
  invariant(trimmed.length <= max, 'invalid_job', `${field} must be at most ${max} characters.`, { field, max });
  invariant(!CONTROL.test(trimmed), 'invalid_job', `${field} must not contain control characters.`, { field });
  return trimmed;
}

export function lifecycle() {
  return {
    states: ['dispatching', 'running', 'attention', 'integrated', 'cancelled'],
    attentionKinds: {
      integrate: 'A verified candidate is waiting. Call approve (needs the integrate permission) or let the host operator integrate it.',
      input: 'The worker stopped without an acceptable result. Inspect the message and call answer with text or keys.',
      out_of_scope_write: 'The worker changed files outside allowedPaths. Cancel and submit a new job with a wider scope.',
      retry: 'The attempt failed, needs rework, or never dispatched. Call retry with feedback for the next attempt, or cancel.',
      integration_recovery: 'Integration stopped half-way. Only the host operator can recover it.',
      operation_failed: 'The last approve, answer, cancel, or retry did not complete on the host. Read code; resubmit or ask the host operator.',
    },
    nextActions: ['status', 'approve', 'answer', 'retry', 'resubmit', 'cancel', 'result', 'operator', 'none'],
    nextActionMeaning: { retry: 'call the retry tool on this job', resubmit: 'submit a new job with a new idempotencyKey', cancel: 'call cancel, then submit a new job', operator: 'only the host operator can continue' },
    note: 'HarnessOrbit state on the host is authoritative. Every tool returns attention_pending and next_action so callers poll only when needed.',
  };
}

// Writes one bounded line per access call so the host operator can audit what a principal did.
export class AccessAudit {
  constructor({ root } = {}) { this.file = path.join(path.resolve(root), 'access', 'audit.jsonl'); }
  async record(entry) {
    const line = {
      at: new Date().toISOString(), principalId: entry.principalId || null, transport: entry.transport || 'cli',
      tool: entry.tool || null, jobId: entry.jobId || null, ok: entry.ok !== false,
      ...(entry.code ? { code: String(entry.code).slice(0, 80) } : {}), durationMs: Number.isFinite(entry.durationMs) ? Math.round(entry.durationMs) : null,
    };
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await fs.appendFile(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch { /* auditing never blocks the call */ }
  }
}

export class AccessService {
  constructor({ root, orchestrator, principals, jobs, driver = 'inline', supervisor, settleMs = 8000 } = {}) {
    invariant(typeof root === 'string' && root.length > 0, 'invalid_state_root', 'Access service root is required.');
    invariant(orchestrator && typeof orchestrator.dispatch === 'function', 'invalid_orchestrator', 'Access service requires an orchestrator.');
    invariant(['inline', 'background'].includes(driver), 'invalid_driver', 'driver must be inline or background.');
    invariant(Number.isInteger(settleMs) && settleMs >= 0 && settleMs < TOOL_TIMEOUT_MS, 'invalid_driver', `settleMs must be an integer below ${TOOL_TIMEOUT_MS}.`);
    this.root = path.resolve(root);
    this.orchestrator = orchestrator;
    this.principals = principals || new PrincipalStore({ root: this.root });
    this.jobs = jobs || new JobStore({ root: this.root });
    this.supervisor = supervisor || new Supervisor({ orchestrator });
    this.driver = driver;
    this.settleMs = settleMs;
    this.inflight = new Map();
  }

  describe(principal) {
    return {
      schemaVersion: ACCESS_SCHEMA_VERSION, service: 'harnessorbit-access', version: ACCESS_VERSION,
      principal: { id: principal.id, projects: principal.projects, agents: principal.agents, permissions: principal.permissions, rateLimitPerMinute: principal.rateLimitPerMinute },
      tools: [...ACCESS_TOOLS],
      limits: { toolTimeoutMs: TOOL_TIMEOUT_MS, objectiveChars: 4000, contextChars: 8000, idempotencyKeyChars: 128, maxAttempts: 20, answerChars: 8000, patchBytes: MAX_PATCH_BYTES },
      submit: {
        required: ['idempotencyKey', 'project', 'objective', 'context', 'checks'],
        optional: ['agent', 'allowedPaths', 'maxAttempts', 'brief', 'conversationKey'],
        note: 'Reuse the same idempotencyKey when retrying a call that timed out; the original job is returned instead of a duplicate dispatch. Work runs in an isolated Git worktree; nothing reaches the project checkout until integration is approved.',
      },
      approve: { kinds: ['integrate'], permission: 'integrate', allowed: principal.permissions.integrate === true, note: 'Applies the verified patch to the project checkout and reruns the checks there. Only an accepted candidate can be approved.' },
      answer: { input: 'text or keys', note: 'Delivers a reply to a worker that stopped and needs input. Text goes to the worker as a prompt; keys are terminal key names such as Enter or y.' },
      cancel: { permission: 'cancel', allowed: principal.permissions.cancel !== false, note: 'Stops the worker and withdraws the job. An accepted candidate is withdrawn without touching the project.' },
      result: { note: 'Returns the worker report, verification evidence tails, and, with includePatch, the verified patch.' },
      retry: { input: 'optional feedback', note: 'Starts the next attempt of a failed, reworked, interrupted, or cancelled job with your feedback, or dispatches again when the first dispatch failed. Bounded by the job’s maxAttempts.' },
      events: { input: 'optional jobId, since, limit', limit: MAX_EVENTS, note: 'Lists what happened to your jobs in order. Pass next_since from the previous call as since to read only new events.' },
      lifecycle: lifecycle(),
    };
  }

  async _validateSubmit(principal, input) {
    invariant(input && typeof input === 'object' && !Array.isArray(input), 'invalid_job', 'submit input must be an object.');
    const unknown = Object.keys(input).filter(key => !SUBMIT_KEYS.has(key));
    invariant(!unknown.length, 'invalid_job', 'submit input contains unknown keys.', { unknown });
    const idempotencyKey = text(input.idempotencyKey, 'idempotencyKey', 128);
    invariant(typeof input.project === 'string' && input.project.length > 0, 'invalid_job', 'project is required.', { field: 'project' });
    let project;
    try { project = await fs.realpath(input.project); }
    catch { invariant(false, 'project_not_allowed', 'Project is not available to this principal.', { project: input.project }); }
    invariant(principal.projects.includes(project), 'project_not_allowed', 'Project is not available to this principal.', { project: input.project });
    const agent = input.agent === undefined ? principal.agents[0] : input.agent;
    invariant(principal.agents.includes(agent), 'agent_not_allowed', 'Agent is not available to this principal.', { agent, allowed: principal.agents });
    const objective = text(input.objective, 'objective', 4000);
    const context = text(input.context, 'context', 8000);
    const conversationKey = text(input.conversationKey, 'conversationKey', 128, { required: false }) ?? null;
    const task = validateTask({
      id: JOB_TASK_ID, objective, agent, isolation: 'worktree',
      allowedPaths: input.allowedPaths === undefined ? ['.'] : input.allowedPaths,
      checks: input.checks,
      nativeInstructions: `Context supplied by principal ${principal.id}:\n${context}`,
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
      ...(input.brief === undefined ? {} : { brief: input.brief }),
    });
    // Fail on an ambiguous directory scope before any run exists, exactly as dispatch would.
    const scope = assessScope(task.allowedPaths, (await git.snapshot(project)).files);
    invariant(!scope.ambiguousDirectories.length, 'directory_scope_missing_slash', 'Directory scopes must end with a trailing slash so files under them stay in scope. Use `dir/` or list exact files.', { ambiguousDirectories: scope.ambiguousDirectories });
    return { idempotencyKey, project, agent, task, conversationKey, request: { objective, context, allowedPaths: task.allowedPaths, checks: task.checks, maxAttempts: task.maxAttempts, ...(task.brief ? { brief: task.brief } : {}) } };
  }

  // Rebuilds the task a job was accepted with, for dispatching again after a failed dispatch.
  _taskFor(job, feedback = null) {
    const { request } = job;
    return validateTask({
      id: job.taskId, objective: request.objective, agent: job.agent, isolation: 'worktree', allowedPaths: request.allowedPaths, checks: request.checks,
      nativeInstructions: `Context supplied by principal ${job.principalId}:\n${request.context}${feedback ? `\n\nFeedback from principal ${job.principalId} after a failed dispatch:\n${feedback}` : ''}`,
      ...(request.maxAttempts === undefined ? {} : { maxAttempts: request.maxAttempts }),
      ...(request.brief === undefined ? {} : { brief: request.brief }),
    });
  }

  async submit(principal, input) {
    invariant(principal?.permissions?.submit !== false, 'permission_denied', 'This principal may not submit work.');
    const prepared = await this._validateSubmit(principal, input);
    const job = await this.jobs.locked(principal.id, async () => {
      const existing = await this.jobs.findByKey(principal.id, prepared.idempotencyKey);
      if (existing) return { ...existing, reused: true };
      const id = `job-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
      await this.orchestrator.init({ project: prepared.project, id, maxParallel: 1 });
      const created = await this.jobs.create({
        id, principalId: principal.id, idempotencyKey: prepared.idempotencyKey, project: prepared.project, agent: prepared.agent,
        runId: id, taskId: JOB_TASK_ID, conversationKey: prepared.conversationKey, request: prepared.request, dispatchError: null,
      });
      try { await this.orchestrator.dispatch(id, prepared.task); }
      catch (error) { await this.jobs.update(id, j => { j.dispatchError = { at: now(), ...serializeError(error) }; }); }
      return { ...(await this.jobs.get(id)), reused: false };
    });
    return this._view(principal, job, { reused: job.reused });
  }

  async status(principal, { jobId, advance = true } = {}) {
    const job = await this._owned(principal, jobId);
    if (advance) await this._advance(job);
    return this._view(principal, await this.jobs.get(job.id));
  }

  // Integrates an accepted candidate into the project checkout. The permission bit is the
  // gate here because this is the one call that changes files outside a worktree.
  async approve(principal, { jobId, kind = 'integrate' } = {}) {
    invariant(kind === 'integrate', 'invalid_approval', 'kind must be integrate.', { kind });
    invariant(principal?.permissions?.integrate === true, 'permission_denied', 'This principal may not integrate. The host operator runs integrate on the host.');
    const job = await this._owned(principal, jobId);
    invariant(!job.dispatchError && !job.withdrawnAt, 'not_accepted', 'This job has no accepted candidate.');
    await this._settled(job, 'approve');
    const attempt = await this._attempt(job, 'not_accepted');
    invariant(attempt.status === 'accepted', 'not_accepted', `Only an accepted candidate can be integrated; the attempt is ${attempt.status}.`, { status: attempt.status });
    await this.jobs.update(job.id, j => { j.approvals = [...(j.approvals || []), { kind, at: now(), attemptId: attempt.id }]; j.operationError = null; });
    await this._run(job, 'approve', attempt, () => this.orchestrator.integrate(job.runId, job.taskId));
    return this._view(principal, await this.jobs.get(job.id));
  }

  // Delivers a reply to a worker that stopped for input, then observes its reaction.
  async answer(principal, { jobId, text: reply, keys } = {}) {
    invariant(principal?.permissions?.submit !== false, 'permission_denied', 'This principal may not drive work.');
    const answer = reply === undefined ? undefined : text(reply, 'text', 8000);
    if (keys !== undefined) {
      invariant(Array.isArray(keys) && keys.length > 0 && keys.length <= 8, 'invalid_answer', 'keys must be a list of 1 to 8 key names.', { field: 'keys' });
      for (const key of keys) invariant(typeof key === 'string' && /^[A-Za-z0-9+_-]{1,32}$/.test(key), 'invalid_answer', 'Each key must be a short key name such as Enter, y, or C-c.', { field: 'keys' });
    }
    invariant(Boolean(answer) !== Boolean(keys), 'invalid_answer', 'Supply either text or keys.');
    const job = await this._owned(principal, jobId);
    invariant(!job.dispatchError && !job.withdrawnAt, 'answer_not_allowed', 'This job has no live worker.');
    await this._settled(job, 'answer');
    const attempt = await this._attempt(job, 'answer_not_allowed');
    invariant(attempt.status === 'needs_input', 'answer_not_allowed', `Answer is accepted only while the worker needs input; the attempt is ${attempt.status}.`, { status: attempt.status });
    invariant(!attempt.outsideScope?.length, 'scope_violation', 'The worker wrote outside allowedPaths. Cancel this job and submit a new one with a wider scope.', { outsideScope: attempt.outsideScope });
    await this.orchestrator.input(job.runId, job.taskId, answer ? { text: answer } : { keys });
    await this.jobs.update(job.id, j => { j.answers = [...(j.answers || []), { at: now(), attemptId: attempt.id, kind: answer ? 'text' : 'keys' }]; j.operationError = null; });
    await this._run(job, 'answer', attempt, () => this.orchestrator.collect(job.runId, job.taskId, { waitMs: 0 }));
    return this._view(principal, await this.jobs.get(job.id));
  }

  // Stops the worker and withdraws the job. The orchestrator leaves accepted candidates alone,
  // so the job records the withdrawal itself and stops reporting the integrate attention.
  async cancel(principal, { jobId, reason } = {}) {
    invariant(principal?.permissions?.cancel !== false, 'permission_denied', 'This principal may not cancel work.');
    const why = text(reason, 'reason', 512, { required: false }) ?? null;
    const job = await this._owned(principal, jobId);
    const withdraw = j => { j.withdrawnAt ||= now(); j.withdrawReason ??= why; j.operationError = null; };
    if (job.dispatchError) { await this.jobs.update(job.id, withdraw); return this._view(principal, await this.jobs.get(job.id)); }
    const attempt = await this._attempt(job, 'job_not_started');
    invariant(attempt.status !== 'integrated', 'already_integrated', 'The candidate is already integrated; nothing is left to cancel.');
    if (['integrating', 'integration_failed', 'integration_cancelled'].includes(attempt.status)) {
      invariant(attempt.status === 'integrating', 'integration_recovery_required', 'Integration stopped half-way; only the host operator can recover it.');
    }
    try { await this.orchestrator.cancel(job.runId, job.taskId, { reason: 'user' }); }
    catch (error) {
      if (!(error instanceof OrchestratorError)) throw error;
      await this.jobs.update(job.id, j => { j.operationError = { tool: 'cancel', at: now(), attemptId: attempt.id, attemptStatus: attempt.status, ...serializeError(error) }; });
      throw error;
    }
    await this.jobs.update(job.id, withdraw);
    return this._view(principal, await this.jobs.get(job.id));
  }

  // Returns what the worker produced and what verification saw. Available once an attempt
  // has been collected; the patch only after verification passed.
  async result(principal, { jobId, includePatch = false } = {}) {
    invariant(typeof includePatch === 'boolean', 'invalid_job', 'includePatch must be a boolean.', { field: 'includePatch' });
    const job = await this._owned(principal, jobId);
    invariant(!job.dispatchError, 'result_not_ready', 'This job never started a worker.');
    const attempt = await this._attempt(job, 'result_not_ready');
    invariant(attempt.report || attempt.verification, 'result_not_ready', `No collected result yet; the attempt is ${attempt.status}. Poll status.`, { status: attempt.status });
    const checks = [];
    for (const check of attempt.verification?.checks || []) {
      let record = null;
      try { record = await readJson(check.evidence); } catch { record = null; }
      checks.push({ name: check.name, status: check.status, code: check.code ?? null, argv: check.argv, stdout: tail(record?.stdout, EVIDENCE_TAIL), stderr: tail(record?.stderr, EVIDENCE_TAIL), error: check.error || record?.error || null });
    }
    let patch = null;
    if (includePatch) {
      invariant(attempt.patchFile, 'patch_unavailable', 'A patch exists only after verification passed.', { status: attempt.status });
      const info = await fs.stat(attempt.patchFile);
      invariant(info.size <= MAX_PATCH_BYTES, 'patch_too_large', `The patch is ${info.size} bytes; the limit is ${MAX_PATCH_BYTES}. Review it on the host.`, { bytes: info.size, limit: MAX_PATCH_BYTES });
      patch = { bytes: info.size, text: await fs.readFile(attempt.patchFile, 'utf8') };
    }
    const view = await this._view(principal, job);
    const report = attempt.report ? { status: attempt.report.status, summary: attempt.report.summary ?? null, changedFiles: attempt.report.changedFiles || [], checks: attempt.report.checks || [], unresolved: attempt.report.unresolved || [], children: attempt.report.children || [] } : null;
    const verification = attempt.verification ? { passed: attempt.verification.passed, finishedAt: attempt.verification.finishedAt, error: attempt.verification.error || null, checks } : null;
    return { ...view, result: { report, verification, changedPaths: attempt.changedPaths || [], outsideScope: attempt.outsideScope || [], integrated: attempt.status === 'integrated', patch } };
  }

  // Starts the next attempt with the principal's feedback, or dispatches again when the first
  // dispatch never produced a worker. The orchestrator keeps the task definition and the
  // attempt limit; this only decides which of the two paths applies.
  async retry(principal, { jobId, feedback } = {}) {
    invariant(principal?.permissions?.submit !== false, 'permission_denied', 'This principal may not drive work.');
    const note = text(feedback, 'feedback', 8000, { required: false }) ?? null;
    const job = await this._owned(principal, jobId);
    await this._settled(job, 'retry');
    const revive = (j, attemptId) => { j.retries = [...(j.retries || []), { at: now(), attemptId, feedback: Boolean(note) }]; j.withdrawnAt = null; j.withdrawReason = null; j.operationError = null; j.dispatchError = null; };
    let inspected = null;
    try { inspected = await this.orchestrator.inspect(job.runId, job.taskId); }
    catch (error) { if (!(error instanceof OrchestratorError)) throw error; }
    if (!inspected) {
      invariant(job.dispatchError, 'retry_not_allowed', 'The job has not started an attempt yet. Poll status.');
      try { await this.orchestrator.dispatch(job.runId, this._taskFor(job, note)); }
      catch (error) {
        await this.jobs.update(job.id, j => { j.dispatchError = { at: now(), ...serializeError(error) }; });
        throw error;
      }
      await this.jobs.update(job.id, j => revive(j, null));
      return this._view(principal, await this.jobs.get(job.id));
    }
    const { attempt, task } = inspected;
    invariant(['rework', 'failed', 'interrupted', 'cancelled'].includes(attempt.status), 'retry_not_allowed', `Retry is accepted only after an attempt ended in rework, failed, interrupted, or cancelled; the attempt is ${attempt.status}.`, { status: attempt.status });
    invariant(!attempt.outsideScope?.length, 'scope_retry_forbidden', 'The worker wrote outside allowedPaths. Cancel this job and submit a new one with a wider scope.', { outsideScope: attempt.outsideScope });
    invariant(!(Number.isInteger(task.maxAttempts) && attempt.number >= task.maxAttempts), 'attempt_limit', `The attempt limit (${task.maxAttempts}) is reached. Submit a new job with a new idempotencyKey.`, { maxAttempts: task.maxAttempts, attempts: attempt.number });
    await this.jobs.update(job.id, j => revive(j, attempt.id));
    await this._run(job, 'retry', attempt, () => this.orchestrator.retry(job.runId, job.taskId, note || ''));
    return this._view(principal, await this.jobs.get(job.id));
  }

  // Lists what happened to the principal's jobs, oldest first, as one ordered stream. The cursor
  // is `<at>/<id>` of the last event returned, so equal timestamps never lose or repeat events.
  async events(principal, { jobId, since, limit = 100 } = {}) {
    invariant(Number.isInteger(limit) && limit >= 1 && limit <= MAX_EVENTS, 'invalid_job', `limit must be an integer from 1 to ${MAX_EVENTS}.`, { field: 'limit' });
    invariant(since === undefined || since === null || (typeof since === 'string' && CURSOR_RE.test(since)), 'invalid_cursor', 'since must be a next_since value from a previous events call.', { field: 'since' });
    const jobs = jobId === undefined || jobId === null ? (await this.jobs.list({ principalId: principal.id })).slice(-MAX_EVENT_JOBS) : [await this._owned(principal, jobId)];
    const all = [];
    for (const job of jobs) {
      for (const event of this._jobEvents(job)) all.push(event);
      for (const event of await this._runEvents(job)) all.push(event);
    }
    const key = event => `${event.at}/${event.id}`;
    const fresh = all.filter(event => !since || key(event) > since).sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
    const page = fresh.slice(0, limit);
    return { schemaVersion: ACCESS_SCHEMA_VERSION, events: page, more: fresh.length > page.length, next_since: page.length ? key(page.at(-1)) : (since || null), jobs: jobs.length };
  }

  // Events the access layer itself knows about, derived from the job record.
  _jobEvents(job) {
    const events = [{ id: `${job.id}:created`, at: job.createdAt, job: job.id, type: 'job.submitted', agent: job.agent }];
    if (job.dispatchError?.at) events.push({ id: `${job.id}:dispatch_failed`, at: job.dispatchError.at, job: job.id, type: 'job.dispatch_failed', errorCode: job.dispatchError.code });
    (job.answers || []).forEach((entry, i) => events.push({ id: `${job.id}:answer:${i + 1}`, at: entry.at, job: job.id, type: 'job.answered', attemptId: entry.attemptId, inputKind: entry.kind }));
    (job.approvals || []).forEach((entry, i) => events.push({ id: `${job.id}:approval:${i + 1}`, at: entry.at, job: job.id, type: 'job.approved', attemptId: entry.attemptId, kind: entry.kind }));
    (job.retries || []).forEach((entry, i) => events.push({ id: `${job.id}:retry:${i + 1}`, at: entry.at, job: job.id, type: 'job.retried', attemptId: entry.attemptId, feedback: entry.feedback }));
    if (job.withdrawnAt) events.push({ id: `${job.id}:withdrawn`, at: job.withdrawnAt, job: job.id, type: 'job.withdrawn', ...(job.withdrawReason ? { reason: job.withdrawReason.slice(0, 200) } : {}) });
    if (job.operationError?.at) events.push({ id: `${job.id}:operation_failed:${job.operationError.at}`, at: job.operationError.at, job: job.id, type: 'job.operation_failed', tool: job.operationError.tool, errorCode: job.operationError.code });
    return events;
  }

  // The run's own event log, reduced to the fields a principal can act on.
  async _runEvents(job) {
    let text;
    try { text = await fs.readFile(path.join(runPath(this.root, job.runId), 'events.jsonl'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const events = [];
    text.split('\n').forEach((line, index) => {
      if (!line) return;
      let raw;
      try { raw = JSON.parse(line); } catch { return; }
      if (!raw || typeof raw.type !== 'string' || HIDDEN_EVENTS.has(raw.type) || typeof raw.timestamp !== 'string') return;
      const event = { id: typeof raw.eventId === 'string' && raw.eventId.length <= 160 ? raw.eventId : `${job.runId}:${index + 1}`, at: raw.timestamp, job: job.id, type: raw.type };
      for (const field of EVENT_FIELDS) if (typeof raw[field] === 'string' || Number.isInteger(raw[field])) event[field] = typeof raw[field] === 'string' ? raw[field].slice(0, 200) : raw[field];
      events.push(event);
    });
    return events;
  }

  async _owned(principal, jobId) {
    invariant(typeof jobId === 'string' && jobId.length > 0, 'invalid_job', 'jobId is required.');
    const job = await this.jobs.get(jobId);
    invariant(job && job.principalId === principal.id, 'job_not_found', `Job ${jobId} does not exist.`);
    return job;
  }

  async _attempt(job, code) {
    try { return (await this.orchestrator.inspect(job.runId, job.taskId)).attempt; }
    catch (error) {
      if (!(error instanceof OrchestratorError)) throw error;
      invariant(false, code, 'The job has not started an attempt yet. Poll status.');
    }
  }

  // A control call must not race a stage that is still running for the same job.
  async _settled(job, tool) {
    const pending = this.inflight.get(job.runId);
    if (!pending) return;
    if (this.driver === 'inline') { await pending; return; }
    invariant(false, 'job_busy', `A stage is still running for this job; call status before ${tool}.`);
  }

  // Runs one host operation for a job. Inline callers wait for it and see its error; the
  // server lets it finish in the background after a short settle window and records a
  // failure on the job so the next status call can report it.
  _run(job, tool, attempt, fn) {
    const progress = fn()
      .then(result => ({ result }))
      .catch(error => ({ error: error instanceof OrchestratorError ? error : new OrchestratorError('internal_error', 'Host operation failed.') }))
      .finally(() => this.inflight.delete(job.runId));
    this.inflight.set(job.runId, progress);
    const outcome = progress.then(async ({ result, error }) => {
      if (error && attempt) await this.jobs.update(job.id, j => { j.operationError = { tool, at: now(), attemptId: attempt.id, attemptStatus: attempt.status, ...serializeError(error) }; }).catch(() => {});
      return { result, error };
    });
    if (this.driver === 'inline') return outcome.then(({ error }) => { if (error) throw error; });
    return Promise.race([outcome, sleep(this.settleMs)]).then(() => undefined);
  }

  // Moves collect and verify forward. Inline callers wait; the MCP server lets the stage run
  // in the background after the settle window so a tool call stays inside the caller's timeout.
  async _advance(job) {
    if (job.dispatchError || job.withdrawnAt) return;
    let attempt;
    try { attempt = (await this.orchestrator.inspect(job.runId, job.taskId)).attempt; }
    catch { return; }
    const answered = attempt.status === 'needs_input' && answeredSince(job, attempt);
    if (!ADVANCEABLE.has(attempt.status) && !answered) return;
    if (this.inflight.has(job.runId)) { if (this.driver === 'inline') await this.inflight.get(job.runId); return; }
    // One supervisor step performs one stage (collect, then verify), so follow a submitted
    // candidate straight into verification instead of making the caller poll twice.
    await this._run(job, 'status', null, async () => {
      let last = null;
      for (let round = 0; round < 3; round++) {
        last = await this.supervisor.step(job.runId, { integrate: false });
        const next = (await this.orchestrator.inspect(job.runId, job.taskId)).attempt;
        if (next.status !== 'submitted') break;
      }
      return last;
    }).catch(() => {});
  }

  async _view(principal, job, { reused = false } = {}) {
    const base = {
      schemaVersion: ACCESS_SCHEMA_VERSION,
      job: { id: job.id, principalId: job.principalId, project: job.project, agent: job.agent, runId: job.runId, taskId: job.taskId, idempotencyKey: job.idempotencyKey, conversationKey: job.conversationKey, createdAt: job.createdAt, updatedAt: job.updatedAt, reused },
      request: job.request,
    };
    if (job.withdrawnAt) base.job.withdrawnAt = job.withdrawnAt;
    if (job.dispatchError) {
      if (job.withdrawnAt) return { ...base, state: 'cancelled', attempt: null, attention: [], attention_pending: 0, next_action: 'none' };
      return { ...base, state: 'attention', attempt: null, attention: [{ kind: 'retry', code: job.dispatchError.code, target: job.dispatchError.message, risk: 'low', since: job.dispatchError.at || job.updatedAt, how: 'Dispatch failed before any worker started. Call retry to dispatch again once the host is ready, or cancel.' }], attention_pending: 1, next_action: 'retry' };
    }
    let inspected;
    try { inspected = await this.orchestrator.inspect(job.runId, job.taskId); }
    catch (error) {
      if (!(error instanceof OrchestratorError)) throw error;
      return { ...base, state: 'dispatching', attempt: null, attention: [], attention_pending: 0, next_action: 'status' };
    }
    const { attempt, task, retryAdvice } = inspected;
    const verification = attempt.verification ? { status: attempt.verification.status || null, checks: (attempt.verification.checks || []).map(c => ({ name: c.name, status: c.status })) } : null;
    const summary = {
      id: attempt.id, number: attempt.number, status: attempt.status, createdAt: attempt.createdAt,
      lastError: attempt.lastError ? { code: attempt.lastError.code, message: String(attempt.lastError.message || '').slice(0, 512) } : null,
      changedPaths: attempt.changedPaths || [], outsideScope: attempt.outsideScope || [],
      reportSummary: attempt.report?.summary ? String(attempt.report.summary).slice(0, 1024) : null,
      verification, retryAdvice: retryAdvice || null,
    };
    const risk = task.brief?.risk || 'medium';
    const attention = [];
    const since = attempt.collectedAt || attempt.observedAt || attempt.createdAt;
    const failed = job.operationError && job.operationError.attemptId === attempt.id && job.operationError.attemptStatus === attempt.status ? job.operationError : null;
    // A withdrawn job hides the candidate from the principal; an integration that already ran or
    // stopped half-way still wins because the project checkout was touched.
    const withdrawn = job.withdrawnAt && !['integrated', 'integrating', 'integration_failed', 'integration_cancelled'].includes(attempt.status);
    if (withdrawn) {
      // nothing to attend to; the state below becomes cancelled
    } else if (attempt.status === 'needs_input') {
      const scope = attempt.lastError?.code === 'scope_violation' || attempt.outsideScope?.length;
      if (scope) attention.push({ kind: 'out_of_scope_write', code: 'scope_violation', target: attempt.outsideScope || [], risk: 'high', since, how: 'Cancel this job and submit a new one whose allowedPaths cover these files.' });
      else if (!(answeredSince(job, attempt) && attempt.lastObservedState !== 'blocked')) attention.push({ kind: 'input', code: attempt.lastError?.code || 'worker_blocked', target: summary.lastError?.message || 'Worker is waiting.', risk, since, how: 'Read the message and call answer with text (a reply) or keys (for example ["Enter"]). Cancel if the job no longer makes sense.' });
    } else if (attempt.status === 'accepted') {
      attention.push({ kind: 'integrate', code: 'accepted', target: attempt.changedPaths || [], risk, since, how: principal.permissions.integrate ? 'Call result to review the patch, then approve with kind=integrate.' : 'This principal cannot integrate. The host operator runs integrate on the host.' });
    } else if (['integration_failed', 'integration_cancelled'].includes(attempt.status)) {
      attention.push({ kind: 'integration_recovery', code: attempt.status, target: attempt.changedPaths || [], risk: 'high', since, how: 'Only the host operator can run recover for this task.' });
    } else if (RETRYABLE.has(attempt.status)) {
      const exhausted = Number.isInteger(task.maxAttempts) && attempt.number >= task.maxAttempts;
      const advice = retryAdvice ? `Suggested: ${retryAdvice.action} (${retryAdvice.reason}). ` : '';
      attention.push({ kind: 'retry', code: attempt.lastError?.code || attempt.status, target: summary.lastError?.message || attempt.status, risk, since, exhausted, how: exhausted ? `${advice}The attempt limit (${task.maxAttempts}) is reached. Submit a new job with a new idempotencyKey, or cancel.` : `${advice}Call retry with feedback that tells the next attempt what went wrong, or cancel.` });
    }
    if (failed && !withdrawn) attention.unshift({ kind: 'operation_failed', code: failed.code, target: failed.message, risk: 'medium', since: failed.at, how: RESUBMITTABLE.has(failed.code) ? `${failed.tool} failed because the candidate no longer matches the project. Submit a new job on the current baseline.` : `${failed.tool} failed on the host. Call status again; if it persists, the host operator must look.` });
    const state = attempt.status === 'integrated' ? 'integrated' : (withdrawn || attempt.status === 'cancelled') ? 'cancelled' : attention.length ? 'attention' : RUNNING.has(attempt.status) || attempt.status === 'needs_input' ? 'running' : 'attention';
    const next = state === 'integrated' ? 'result' : state === 'cancelled' ? 'none' : state === 'running' ? 'status'
      : { integrate: 'approve', input: 'answer', out_of_scope_write: 'cancel', retry: attention[0]?.exhausted ? 'resubmit' : 'retry', integration_recovery: 'operator', operation_failed: RESUBMITTABLE.has(failed?.code) ? 'resubmit' : 'operator' }[attention[0]?.kind] || 'status';
    return { ...base, state, attempt: summary, attention, attention_pending: attention.length, next_action: next };
  }
}
