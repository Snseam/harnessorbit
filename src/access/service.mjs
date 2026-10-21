import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OrchestratorError, invariant } from '../errors.mjs';
import { validateTask, assessScope } from '../task.mjs';
import * as git from '../git.mjs';
import { Supervisor } from '../supervisor/index.mjs';
import { PrincipalStore } from './principals.mjs';
import { JobStore, JOB_TASK_ID } from './jobs.mjs';

export const ACCESS_SCHEMA_VERSION = 1;
export const ACCESS_VERSION = '0.1.0';
export const TOOL_TIMEOUT_MS = 20000;
const SUBMIT_KEYS = new Set(['idempotencyKey', 'project', 'objective', 'context', 'agent', 'allowedPaths', 'checks', 'maxAttempts', 'brief', 'conversationKey']);
const RUNNING = new Set(['preparing', 'launching', 'ready', 'sending', 'running', 'collecting', 'uncertain', 'submitted', 'verifying', 'integrating', 'cancelling']);
const RETRYABLE = new Set(['rework', 'failed', 'timed_out', 'interrupted']);
const ADVANCEABLE = new Set(['running', 'sending', 'uncertain', 'submitted']);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const serializeError = e => ({ code: e.code || 'error', message: e.message, ...(e.details && Object.keys(e.details).length ? { details: e.details } : {}) });

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
      integrate: 'A verified candidate is waiting. Approve integration or let the host operator integrate it.',
      input: 'The worker stopped without an acceptable result. Inspect the message and answer or retry.',
      out_of_scope_write: 'The worker changed files outside allowedPaths. Cancel and submit a new job with a wider scope.',
      retry: 'The attempt failed or needs rework. Retry with feedback or revise the objective.',
      integration_recovery: 'Integration stopped half-way. Only the host operator can recover it.',
    },
    nextActions: ['status', 'approve', 'answer', 'retry', 'result', 'operator', 'none'],
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
  constructor({ root, orchestrator, principals, jobs, driver = 'inline', supervisor } = {}) {
    invariant(typeof root === 'string' && root.length > 0, 'invalid_state_root', 'Access service root is required.');
    invariant(orchestrator && typeof orchestrator.dispatch === 'function', 'invalid_orchestrator', 'Access service requires an orchestrator.');
    invariant(['inline', 'background'].includes(driver), 'invalid_driver', 'driver must be inline or background.');
    this.root = path.resolve(root);
    this.orchestrator = orchestrator;
    this.principals = principals || new PrincipalStore({ root: this.root });
    this.jobs = jobs || new JobStore({ root: this.root });
    this.supervisor = supervisor || new Supervisor({ orchestrator });
    this.driver = driver;
    this.inflight = new Map();
  }

  describe(principal) {
    return {
      schemaVersion: ACCESS_SCHEMA_VERSION, service: 'harnessorbit-access', version: ACCESS_VERSION,
      principal: { id: principal.id, projects: principal.projects, agents: principal.agents, permissions: principal.permissions, rateLimitPerMinute: principal.rateLimitPerMinute },
      tools: ['describe', 'submit', 'status'],
      limits: { toolTimeoutMs: TOOL_TIMEOUT_MS, objectiveChars: 4000, contextChars: 8000, idempotencyKeyChars: 128, maxAttempts: 20 },
      submit: {
        required: ['idempotencyKey', 'project', 'objective', 'context', 'checks'],
        optional: ['agent', 'allowedPaths', 'maxAttempts', 'brief', 'conversationKey'],
        note: 'Reuse the same idempotencyKey when retrying a call that timed out; the original job is returned instead of a duplicate dispatch. Work runs in an isolated Git worktree; nothing reaches the project checkout until integration is approved.',
      },
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
    return { idempotencyKey, project, agent, task, conversationKey, request: { objective, context, allowedPaths: task.allowedPaths, checks: task.checks, maxAttempts: task.maxAttempts } };
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
      catch (error) { await this.jobs.update(id, j => { j.dispatchError = serializeError(error); }); }
      return { ...(await this.jobs.get(id)), reused: false };
    });
    return this._view(principal, job, { reused: job.reused });
  }

  async status(principal, { jobId, advance = true } = {}) {
    const job = await this._owned(principal, jobId);
    if (advance) await this._advance(job);
    return this._view(principal, job);
  }

  async _owned(principal, jobId) {
    invariant(typeof jobId === 'string' && jobId.length > 0, 'invalid_job', 'jobId is required.');
    const job = await this.jobs.get(jobId);
    invariant(job && job.principalId === principal.id, 'job_not_found', `Job ${jobId} does not exist.`);
    return job;
  }

  // Moves collect and verify forward. Inline callers wait; the MCP server runs it in the
  // background so a tool call returns well inside the caller's timeout window.
  async _advance(job) {
    if (job.dispatchError) return null;
    let attempt;
    try { attempt = (await this.orchestrator.inspect(job.runId, job.taskId)).attempt; }
    catch { return null; }
    if (!ADVANCEABLE.has(attempt.status)) return null;
    if (this.inflight.has(job.runId)) return this.driver === 'inline' ? this.inflight.get(job.runId) : null;
    // One supervisor step performs one stage (collect, then verify), so follow a submitted
    // candidate straight into verification instead of making the caller poll twice.
    const progress = (async () => {
      let last = null;
      for (let round = 0; round < 3; round++) {
        last = await this.supervisor.step(job.runId, { integrate: false });
        const next = (await this.orchestrator.inspect(job.runId, job.taskId)).attempt;
        if (next.status !== 'submitted') break;
      }
      return last;
    })().catch(error => ({ reason: 'error', code: error.code || 'error' })).finally(() => this.inflight.delete(job.runId));
    this.inflight.set(job.runId, progress);
    return this.driver === 'inline' ? progress : null;
  }

  async _view(principal, job, { reused = false } = {}) {
    const base = {
      schemaVersion: ACCESS_SCHEMA_VERSION,
      job: { id: job.id, principalId: job.principalId, project: job.project, agent: job.agent, runId: job.runId, taskId: job.taskId, idempotencyKey: job.idempotencyKey, conversationKey: job.conversationKey, createdAt: job.createdAt, updatedAt: job.updatedAt, reused },
      request: job.request,
    };
    if (job.dispatchError) return { ...base, state: 'attention', attempt: null, attention: [{ kind: 'retry', code: job.dispatchError.code, target: job.dispatchError.message, risk: 'low', how: 'Dispatch failed before any worker started. Fix the request and submit with a new idempotencyKey.' }], attention_pending: 1, next_action: 'retry' };
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
    if (attempt.status === 'needs_input') {
      const scope = attempt.lastError?.code === 'scope_violation' || attempt.outsideScope?.length;
      attention.push(scope
        ? { kind: 'out_of_scope_write', code: 'scope_violation', target: attempt.outsideScope || [], risk: 'high', since, how: 'Cancel this job and submit a new one whose allowedPaths cover these files.' }
        : { kind: 'input', code: attempt.lastError?.code || 'worker_blocked', target: summary.lastError?.message || 'Worker is waiting.', risk, since, how: 'Inspect the message; the answer tool is not available yet, so retry with feedback or ask the host operator.' });
    } else if (attempt.status === 'accepted') {
      attention.push({ kind: 'integrate', code: 'accepted', target: attempt.changedPaths || [], risk, since, how: principal.permissions.integrate ? 'Call approve with kind=integrate once it is available; until then the host operator integrates.' : 'This principal cannot integrate. The host operator runs integrate on the host.' });
    } else if (['integration_failed', 'integration_cancelled'].includes(attempt.status)) {
      attention.push({ kind: 'integration_recovery', code: attempt.status, target: attempt.changedPaths || [], risk: 'high', since, how: 'Only the host operator can run recover for this task.' });
    } else if (RETRYABLE.has(attempt.status)) {
      attention.push({ kind: 'retry', code: attempt.lastError?.code || attempt.status, target: summary.lastError?.message || attempt.status, risk, since, how: retryAdvice ? `Suggested: ${retryAdvice.action} (${retryAdvice.reason}).` : 'Retry with feedback or revise the objective in a new job.' });
    }
    const state = attempt.status === 'integrated' ? 'integrated' : attempt.status === 'cancelled' ? 'cancelled' : attention.length ? 'attention' : RUNNING.has(attempt.status) ? 'running' : 'attention';
    const next = state === 'integrated' ? 'result' : state === 'cancelled' ? 'none' : state === 'running' ? 'status'
      : { integrate: 'approve', input: 'answer', out_of_scope_write: 'retry', retry: 'retry', integration_recovery: 'operator' }[attention[0]?.kind] || 'status';
    return { ...base, state, attempt: summary, attention, attention_pending: attention.length, next_action: next };
  }
}
