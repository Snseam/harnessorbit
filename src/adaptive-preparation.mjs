import { OrchestratorError, invariant } from './errors.mjs';
import { validateTask } from './task.mjs';
import { planAdaptive } from './adaptive-selection.mjs';

const POLICIES = new Set(['off', 'on-demand']);
const MAX_PROBE_BUDGET_MS = 60000;
const DEFAULT_PROBE_BUDGET_MS = 30000;
const PREPARABLE_REASONS = new Set(['call_verification_not_verified', 'call_verification_stale']);
const PREFLIGHT_BLOCKING_CODES = new Set(['run_closed', 'dependency_not_ready', 'dependency_not_integrated', 'capacity_exceeded', 'checkout_busy', 'integration_recovery_required', 'deadline_exceeded', 'unsupported_submodule', 'execution_required', 'route_unavailable', 'directory_scope_missing_slash']);

function nowMs(now) {
  const value = typeof now === 'function' ? now() : now;
  return Number.isFinite(value) ? value : Date.now();
}

function preparationError(code, message, details = {}) {
  return new OrchestratorError(code, message, details);
}

function resourceList(inventory) {
  return Array.isArray(inventory?.resources) ? inventory.resources.filter(resource => resource && typeof resource === 'object') : [];
}

function findResource(inventory, id) {
  return resourceList(inventory).find(resource => resource.id === id) || null;
}

function freshQuotaExhausted(resource) {
  return resource?.quota?.fresh === true && (resource.quota.state === 'exhausted' || resource.quota.remainingTokens === 0);
}

function isPreparableCandidate(candidate, resource) {
  if (!candidate || candidate.eligible) return false;
  if (!resource) return false;
  const reasons = Array.isArray(candidate.reasons) ? candidate.reasons : [];
  if (reasons.length === 0 || reasons.some(reason => !PREPARABLE_REASONS.has(reason))) return false;
  if (resource.probe?.supported !== true) return false;
  if (resource.installed !== true || resource.configured !== true) return false;
  if (resource.authentication?.state === 'missing') return false;
  if (freshQuotaExhausted(resource)) return false;
  if (resource.callVerification?.state === 'unavailable' && candidate.evidence?.callVerificationFresh === true) return false;
  return true;
}

function candidateTask(task, resource) {
  if (resource.kind === 'profile' && resource.profileId) {
    return validateTask({ ...task, agent: resource.agent || task.agent, execution: { profile: resource.profileId } });
  }
  if (resource.kind === 'native') {
    return validateTask({ ...task, agent: resource.agent || task.agent, execution: { native: true } });
  }
  return validateTask({ ...task, agent: resource.agent || task.agent });
}

function sanitizeAttempt(item) {
  return {
    resourceId: item.resourceId,
    status: item.status,
    ...(item.reason ? { reason: item.reason } : {}),
    ...(item.errorCode ? { errorCode: item.errorCode } : {}),
    ...(Number.isFinite(item.wallMs) ? { wallMs: Math.max(0, Math.round(item.wallMs)) } : {}),
    ...(item.cached === true ? { cached: true } : {}),
  };
}

function sanitizeEvidence(evidence) {
  return {
    schemaVersion: 1,
    policy: evidence.policy,
    startedAt: evidence.startedAt,
    finishedAt: evidence.finishedAt,
    budgetMs: evidence.budgetMs,
    usedMs: Math.max(0, Math.round(evidence.usedMs)),
    result: evidence.result,
    candidatesConsidered: evidence.candidatesConsidered,
    attempts: evidence.attempts.slice(0, 4).map(sanitizeAttempt),
    ...(evidence.reason ? { reason: evidence.reason } : {}),
  };
}

export function normalizePreparationOptions({ calibrationPolicy = 'off', probeBudgetMs = DEFAULT_PROBE_BUDGET_MS } = {}) {
  if (!POLICIES.has(calibrationPolicy)) {
    throw preparationError('invalid_adaptive_calibration_policy', 'Adaptive calibration policy must be off or on-demand.', { calibrationPolicy });
  }
  if (!Number.isInteger(probeBudgetMs) || probeBudgetMs <= 0 || probeBudgetMs > MAX_PROBE_BUDGET_MS) {
    throw preparationError('invalid_adaptive_probe_budget', 'Adaptive probe budget must be an integer from 1 to 60000 milliseconds.', { probeBudgetMs });
  }
  return { calibrationPolicy, probeBudgetMs };
}

export function preparationRequestFields(options = {}) {
  const normalized = normalizePreparationOptions(options);
  if (normalized.calibrationPolicy === 'off' && normalized.probeBudgetMs === DEFAULT_PROBE_BUDGET_MS) return {};
  return normalized;
}

export function preparationCandidates({ plan, inventory }) {
  const candidates = Array.isArray(plan?.decision?.candidates) ? plan.decision.candidates : [];
  const selected = [];
  for (const candidate of candidates) {
    if (selected.length >= 2) break;
    const resource = findResource(inventory, candidate.resourceId);
    if (isPreparableCandidate(candidate, resource)) selected.push({ candidate, resource });
  }
  return selected;
}

export async function prepareAdaptiveResources({
  input,
  inventory,
  plan,
  selection,
  resources,
  runner,
  preflight,
  now = Date.now,
} = {}) {
  const task = validateTask(input);
  invariant(resources?.discover, 'invalid_adaptive_preparation', 'Adaptive preparation requires resource discovery.');
  invariant(runner?.run, 'invalid_adaptive_preparation', 'Adaptive preparation requires a calibration runner.');
  const options = normalizePreparationOptions(selection);
  const startedMs = nowMs(now);
  const deadlineMs = task.deadlineAt ? Date.parse(task.deadlineAt) : null;
  const deadlineBudget = Number.isFinite(deadlineMs) ? deadlineMs - startedMs : options.probeBudgetMs;
  const budgetMs = Math.max(0, Math.min(options.probeBudgetMs, deadlineBudget));
  const evidence = {
    policy: options.calibrationPolicy,
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: null,
    budgetMs,
    usedMs: 0,
    result: 'not_run',
    candidatesConsidered: 0,
    attempts: [],
  };

  const finish = (result, reason = null, nextPlan = plan, nextInventory = inventory) => {
    const finishedMs = nowMs(now);
    evidence.finishedAt = new Date(finishedMs).toISOString();
    evidence.usedMs = finishedMs - startedMs;
    evidence.result = result;
    if (reason) evidence.reason = reason;
    return { inventory: nextInventory, plan: nextPlan, evidence: sanitizeEvidence(evidence) };
  };

  if (options.calibrationPolicy === 'off') return finish('disabled', 'policy_off');
  if (plan?.decision?.selected) return finish('skipped', 'route_already_selected');
  if (budgetMs <= 0) return finish('skipped', 'probe_budget_exhausted');

  const candidates = preparationCandidates({ plan, inventory });
  evidence.candidatesConsidered = candidates.length;
  if (candidates.length === 0) return finish('skipped', 'no_preparable_candidate');

  for (const { resource } of candidates) {
    try {
      if (preflight) await preflight(candidateTask(task, resource));
      const elapsed = nowMs(now) - startedMs;
      const remaining = budgetMs - elapsed;
      if (remaining <= 0) {
        evidence.attempts.push({ resourceId: resource.id, status: 'skipped', reason: 'probe_budget_exhausted' });
        return finish('budget_exhausted', 'probe_budget_exhausted');
      }
      const before = nowMs(now);
      const result = await runner.run({
        resourceIds: [resource.id],
        suite: 'quick',
        budgetMs: Math.min(remaining, MAX_PROBE_BUDGET_MS),
        timeoutMs: Math.min(remaining, DEFAULT_PROBE_BUDGET_MS),
      });
      const record = Array.isArray(result?.results) ? result.results[0] : null;
      evidence.attempts.push({
        resourceId: resource.id,
        status: record?.record?.status || (record?.skipped ? 'skipped' : 'unknown'),
        reason: record?.skipped || null,
        errorCode: record?.record?.errorCode || null,
        cached: record?.cached === true,
        wallMs: nowMs(now) - before,
      });
    } catch (error) {
      evidence.attempts.push({
        resourceId: resource.id,
        status: 'error',
        errorCode: error?.code || 'calibration_failed',
        wallMs: 0,
      });
      if (PREFLIGHT_BLOCKING_CODES.has(error?.code)) return finish('preflight_blocked', error.code);
      continue;
    }

    const nextInventory = await resources.discover();
    const nextPlan = await planAdaptive({ input, inventory: nextInventory, ...selection });
    if (nextPlan.decision.selected) return finish('selected_after_probe', null, nextPlan, nextInventory);
    inventory = nextInventory;
    plan = nextPlan;
  }

  return finish('no_route_after_probe', 'prepared_candidates_still_ineligible', plan, inventory);
}

export default prepareAdaptiveResources;
