import { OrchestratorError } from './errors.mjs';
import { explainShadowRoute } from './shadow-routing.mjs';
import { taskDigest, validateTask } from './task.mjs';
import { createDecisionRequest, decideWithFallback } from './decision-provider.mjs';

const SCHEMA_VERSION = 1;
const PREFERENCES = new Set(['balanced', 'fastest', 'subscription-first', 'quality-first']);
const PUBLIC_RESOURCE_KEYS = new Set(['id', 'agent', 'kind', 'profileId', 'providerId', 'requestedModel', 'endpoint', 'effort', 'fingerprint', 'quotaGroup', 'capabilities']);
const CONFLICT_FLAGS = new Set([
  '--model', '-m',
  '--provider',
  '--effort', '--thinking',
  '--api-key',
  '--profile', '-p',
  '--setting-sources',
  '--models',
  '--resume', '-r',
  '--session', '--session-id',
  '--session-dir',
  '--continue',
  '--config', '-c',
  '--settings',
]);
const TERMINAL_OUTCOMES = new Set(['accepted', 'integrated', 'failed', 'timed_out', 'cancelled']);
const SUCCESS_OUTCOMES = new Set(['accepted', 'integrated']);
const FAILURE_OUTCOMES = new Set(['failed', 'timed_out', 'cancelled']);
const MIN_HISTORY_SAMPLES = 3;

function adaptiveError(code, message, details = {}) {
  return new OrchestratorError(code, message, details);
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function rawExplicitAgent(input, fixedAgent) {
  const taskAgent = typeof input?.agent === 'string' && input.agent && input.agent !== 'auto' ? input.agent : null;
  const callerAgent = typeof fixedAgent === 'string' && fixedAgent && fixedAgent !== 'auto' ? fixedAgent : null;
  if (taskAgent && callerAgent && taskAgent !== callerAgent) {
    throw adaptiveError('adaptive_selector_conflict', 'Caller fixedAgent conflicts with the explicit task agent.', {
      fixedAgent: callerAgent,
      taskAgent,
    });
  }
  if (callerAgent) return callerAgent;
  if (taskAgent) return taskAgent;
  return null;
}

function normalizeInput(input) {
  if (!plain(input)) throw adaptiveError('invalid_adaptive_input', 'Adaptive selection requires a task object.');
  return validateTask(input);
}

function safeInputDigest(task) {
  return taskDigest(task);
}

function resourceList(inventory) {
  return Array.isArray(inventory?.resources) ? inventory.resources.filter(plain) : [];
}

function findResource(inventory, id) {
  return resourceList(inventory).find(resource => resource.id === id) || null;
}

function sanitizeResource(resource) {
  if (!plain(resource)) return null;
  const out = {};
  for (const key of PUBLIC_RESOURCE_KEYS) {
    if (resource[key] !== undefined) out[key] = clone(resource[key]);
  }
  return out.id ? out : null;
}

function sanitizeDecision(decision) {
  return {
    schemaVersion: decision.schemaVersion,
    mode: 'shadow',
    applied: false,
    selected: clone(decision.selected),
    reasons: Array.isArray(decision.reasons) ? [...decision.reasons] : [],
    candidates: Array.isArray(decision.candidates) ? decision.candidates.map(candidate => ({
      executorKind: candidate.executorKind,
      resourceId: candidate.resourceId ?? null,
      eligible: candidate.eligible === true,
      reasons: Array.isArray(candidate.reasons) ? [...candidate.reasons] : [],
      evidence: plain(candidate.evidence) ? clone(candidate.evidence) : {},
      ...(candidate.agent ? { agent: candidate.agent } : {}),
      ...(candidate.profileId ? { profileId: candidate.profileId } : {}),
    })) : [],
    evidence: plain(decision.evidence) ? clone(decision.evidence) : {},
    taskId: decision.taskId ?? null,
    taskDigest: decision.taskDigest ?? null,
    observedAt: decision.observedAt ?? null,
  };
}

function executionProfileAllowlist(task) {
  const profiles = task.execution?.profiles;
  if (!Array.isArray(profiles)) return null;
  return new Set(profiles);
}

function mergedAllowedResourceIds({ allowedResourceIds, task, inventory }) {
  let ids = null;
  const profileAllowlist = executionProfileAllowlist(task);
  if (profileAllowlist) {
    ids = new Set();
    for (const resource of resourceList(inventory)) {
      if (resource.profileId && profileAllowlist.has(resource.profileId)) ids.add(resource.id);
    }
  }
  if (task.execution?.native === true) {
    const nativeIds = new Set(resourceList(inventory).filter(resource => resource.kind === 'native').map(resource => resource.id));
    ids = ids ? new Set([...ids].filter(id => nativeIds.has(id))) : nativeIds;
  }
  if (!ids) return allowedResourceIds;
  if (allowedResourceIds !== undefined) {
    const caller = new Set(Array.isArray(allowedResourceIds) ? allowedResourceIds : []);
    ids = new Set([...ids].filter(id => caller.has(id)));
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function executionFixedProfile(task, fixedProfileId) {
  return fixedProfileId || task.execution?.profile || null;
}

function hasExplicitExternalChoice({ fixedProfileId, fixedAgent, fixedExecutorKind, task }) {
  return fixedExecutorKind === 'external' || Boolean(fixedProfileId || (fixedAgent && fixedAgent !== 'codex') || task.execution?.profile || task.execution?.profiles || task.execution?.native);
}

function hostId(hostAvailable) {
  return typeof hostAvailable === 'string' && hostAvailable ? hostAvailable : 'host';
}

function validateHostSelection(input, fixedExecutorKind) {
  if (input?.isolation === 'worktree') {
    if (fixedExecutorKind === 'host') {
      throw adaptiveError('adaptive_selector_conflict', 'Current host execution cannot use worktree isolation.');
    }
    return false;
  }
  if (input.execution !== undefined) return false;
  return true;
}

function hostTask(task) {
  const { execution, agentArgs, ...rest } = task;
  return validateTask({ ...rest, agent: 'codex', isolation: 'checkout', agentArgs: [] });
}

function selectorExecution(task) {
  return {
    ...(Array.isArray(task.execution?.requireCapabilities) ? { requireCapabilities: [...task.execution.requireCapabilities] } : {}),
    ...(task.execution?.allowShared === true ? { allowShared: true } : {}),
  };
}

function managedTask(task, resource) {
  const profile = resource.profileId;
  if (!profile) throw adaptiveError('adaptive_resource_invalid', 'Managed external resource is missing a profile id.', { resourceId: resource.id });
  const next = {
    ...task,
    agent: resource.agent || task.agent,
    execution: { ...selectorExecution(task), profile },
  };
  return validateTask(next);
}

function flagName(arg) {
  if (typeof arg !== 'string') return null;
  const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
  if (/^-[^-]/.test(name) && name.length > 2 && CONFLICT_FLAGS.has(name.slice(0, 2))) return name.slice(0, 2);
  return name;
}

function rejectNativeArgConflicts(task, resource) {
  for (const arg of task.agentArgs || []) {
    const name = flagName(arg);
    if (CONFLICT_FLAGS.has(name)) {
      throw adaptiveError('adaptive_argument_conflict', `Native ${resource.agent} selection owns ${name}; remove this conflicting agent argument.`, {
        resourceId: resource.id,
        flag: name,
      });
    }
  }
}

function nativeArgs(task, resource) {
  rejectNativeArgConflicts(task, resource);
  const args = [...task.agentArgs];
  if (resource.providerId && resource.agent === 'pi') args.push('--provider', resource.providerId);
  if (resource.requestedModel) args.push('--model', resource.requestedModel);
  if (resource.effort && resource.agent === 'pi') args.push('--thinking', resource.effort);
  if (resource.effort && resource.agent === 'claude') args.push('--effort', resource.effort);
  if (resource.effort && resource.agent === 'codex') args.push('-c', `model_reasoning_effort="${resource.effort}"`);
  return args;
}

function nativeTask(task, resource) {
  const next = {
    ...task,
    agent: resource.agent || task.agent,
    agentArgs: nativeArgs(task, resource),
    execution: { native: true },
  };
  return validateTask(next);
}

function effectiveTaskForSelection({ selected, task, input, resource, fixedExecutorKind, hostAvailable }) {
  if (!selected) return null;
  if (selected.executorKind === 'host') {
    if (!hostAvailable) return null;
    if (!validateHostSelection(input, fixedExecutorKind)) return null;
    return hostTask(task);
  }
  if (!resource) return null;
  if (resource.kind === 'native') return nativeTask(task, resource);
  return managedTask(task, resource);
}

function historyElapsed(record) {
  return Number.isFinite(record?.elapsedMs) && record.elapsedMs >= 0 ? record.elapsedMs : null;
}

function taskKind(task) {
  return typeof task.brief?.taskKind === 'string' ? task.brief.taskKind : null;
}

function historyStats(history, task, resource) {
  if (!Array.isArray(history) || !resource?.fingerprint) return null;
  const kind = taskKind(task);
  if (!kind) return null;
  const rows = history.filter(record => {
    if (!plain(record)) return false;
    if (record.fingerprint !== resource.fingerprint) return false;
    if (record.taskKind !== kind) return false;
    if (!TERMINAL_OUTCOMES.has(record.status)) return false;
    return historyElapsed(record) !== null;
  });
  if (rows.length < MIN_HISTORY_SAMPLES) return null;
  const elapsed = rows.reduce((sum, record) => sum + historyElapsed(record), 0) / rows.length;
  const success = rows.filter(record => SUCCESS_OUTCOMES.has(record.status)).length;
  const failed = rows.filter(record => FAILURE_OUTCOMES.has(record.status)).length;
  const integrated = rows.filter(record => record.status === 'integrated').length;
  return { samples: rows.length, elapsedMs: elapsed, success, failed, integrated };
}

function reorderCandidatesWithHistory(decision, { history, task, inventory, preference }) {
  if (decision.selected?.executorKind !== 'external') {
    return { decision, proof: { source: 'deterministic-insufficient' } };
  }
  if (!['fastest', 'quality-first'].includes(preference)) {
    return { decision, proof: { source: 'deterministic-insufficient' } };
  }
  const resources = new Map(resourceList(inventory).map(resource => [resource.id, resource]));
  const ranked = decision.candidates.map((candidate, index) => ({
    candidate,
    index,
    stats: historyStats(history, task, resources.get(candidate.resourceId)),
  }));
  if (ranked.filter(row => row.candidate.eligible && row.stats).length < 2) {
    return { decision, proof: { source: 'deterministic-insufficient' } };
  }
  ranked.sort((a, b) => {
    if (a.candidate.eligible !== b.candidate.eligible) return a.candidate.eligible ? -1 : 1;
    if (a.candidate.eligible && a.stats && b.stats) {
      const ar = a.stats.success / a.stats.samples;
      const br = b.stats.success / b.stats.samples;
      if (ar !== br) return br - ar;
      if (preference === 'quality-first' && a.stats.integrated !== b.stats.integrated) return b.stats.integrated - a.stats.integrated;
      if (a.stats.elapsedMs !== b.stats.elapsedMs) return a.stats.elapsedMs - b.stats.elapsedMs;
      if (a.stats.samples !== b.stats.samples) return b.stats.samples - a.stats.samples;
    } else if (a.candidate.eligible && Boolean(a.stats) !== Boolean(b.stats)) {
      return 0;
    }
    return a.index - b.index;
  });
  const candidates = ranked.map(row => row.candidate);
  const selectedCandidate = candidates.find(candidate => candidate.eligible);
  return {
    decision: {
      ...decision,
      selected: selectedCandidate ? { executorKind: 'external', resourceId: selectedCandidate.resourceId } : decision.selected,
      candidates,
      reasons: [...new Set([...(decision.reasons || []), 'history_matched_fingerprint_task_kind'])],
    },
    proof: { source: 'history', matchedCandidates: ranked.filter(row => row.candidate.eligible && row.stats).map(row => ({
      resourceId: row.candidate.resourceId,
      samples: row.stats.samples,
      success: row.stats.success,
      failed: row.stats.failed,
      elapsedMs: Math.round(row.stats.elapsedMs),
      timeBasis: 'all_terminal_outcomes',
      integrated: row.stats.integrated,
    })) },
  };
}

function selectedResourceFromDecision(decision, inventory, hostAvailable) {
  if (decision.selected?.executorKind === 'host') {
    return { id: hostId(hostAvailable), kind: 'host', agent: 'codex', profileId: null, providerId: null, requestedModel: null, fingerprint: null, quotaGroup: null, capabilities: { values: [], source: 'host', unverified: false } };
  }
  return sanitizeResource(findResource(inventory, decision.selected?.resourceId));
}

function adjustedSelection(decision, { task, input, fixedExecutorKind, hostAvailable, explicitExternal }) {
  if (decision.selected?.executorKind === 'host' && !validateHostSelection(input, fixedExecutorKind)) {
    return { ...decision, selected: null, reasons: [...new Set([...(decision.reasons || []), 'host_not_allowed_for_active_task'])] };
  }
  if (decision.selected?.executorKind === 'external' && task.brief?.risk === 'high' && !explicitExternal) {
    if (hostAvailable && validateHostSelection(input, fixedExecutorKind)) {
      return { ...decision, selected: { executorKind: 'host', resourceId: null }, reasons: [...new Set([...(decision.reasons || []), 'active_high_risk_prefers_host'])] };
    }
    return { ...decision, selected: null, reasons: [...new Set([...(decision.reasons || []), 'active_high_risk_requires_explicit_external'])] };
  }
  return decision;
}

export async function planAdaptive({
  input,
  inventory,
  preference = 'balanced',
  allowedResourceIds,
  fixedProfileId,
  fixedAgent,
  fixedExecutorKind,
  hostAvailable = true,
  history = [],
  now = Date.now(),
  decisionProvider = null,
  decisionMode = 'shadow',
} = {}) {
  if (!PREFERENCES.has(preference)) throw adaptiveError('invalid_adaptive_preference', 'Adaptive selection preference is invalid.', { preference });
  if (fixedExecutorKind !== undefined && !['host', 'external'].includes(fixedExecutorKind)) throw adaptiveError('invalid_adaptive_executor', 'Executor must be host or external.');
  const task = normalizeInput(input);
  const inputDigest = safeInputDigest(task);
  const explicitAgent = rawExplicitAgent(input, fixedAgent);
  const fixedProfile = executionFixedProfile(task, fixedProfileId);
  const mergedAllowed = mergedAllowedResourceIds({ allowedResourceIds, task, inventory });
  const profileAllowlist = executionProfileAllowlist(task);

  if (fixedExecutorKind === 'host' && input?.isolation === 'worktree') {
    throw adaptiveError('adaptive_selector_conflict', 'Current host execution cannot use worktree isolation.');
  }
  if (fixedExecutorKind === 'host' && (fixedProfile || (explicitAgent && explicitAgent !== 'codex') || input.execution !== undefined)) {
    throw adaptiveError('adaptive_selector_conflict', 'Current host execution cannot use an external profile, execution selector, or non-host agent.');
  }

  const shadowTask = { ...task, ...(explicitAgent ? { agent: explicitAgent } : { agent: 'auto' }) };
  if (task.execution?.native === true) delete shadowTask.execution;
  const shadow = await explainShadowRoute({
    task: shadowTask,
    inventory,
    preference,
    hostAvailable: input.isolation !== 'worktree' && (hostAvailable === true || typeof hostAvailable === 'string'),
    allowedResourceIds: mergedAllowed,
    fixedProfileId,
    fixedAgent: explicitAgent,
    fixedExecutorKind: (profileAllowlist || task.execution?.native === true) && fixedExecutorKind === undefined ? 'external' : fixedExecutorKind,
    now,
  });
  const historyAdjusted = reorderCandidatesWithHistory(shadow, { history, task, inventory, preference });
  const explicitExternal = hasExplicitExternalChoice({ fixedProfileId: fixedProfile, fixedAgent: explicitAgent, fixedExecutorKind, task });
  const decision = adjustedSelection(historyAdjusted.decision, { task, input, fixedExecutorKind, hostAvailable, explicitExternal });
  const selectedResource = selectedResourceFromDecision(decision, inventory, hostAvailable);
  const rawResource = findResource(inventory, decision.selected?.resourceId);
  const effectiveTask = effectiveTaskForSelection({ selected: decision.selected, task, input, resource: rawResource, fixedExecutorKind, hostAvailable: hostAvailable === true || typeof hostAvailable === 'string' });
  let decisionReceipt = null;
  if (decisionProvider) {
    const providerRequest = createDecisionRequest({
      kind: 'adaptive.route',
      state: {
        phase: 'selection',
        risk: task.brief?.risk || 'unknown',
        taskKind: task.brief?.taskKind || 'unknown',
        selectedExecutor: decision.selected?.executorKind || null,
        candidateCount: decision.candidates?.length || 0,
      },
      candidates: (decision.candidates || []).map(candidate => ({
        id: candidate.resourceId || `${candidate.executorKind || 'candidate'}:none`,
        eligible: candidate.eligible === true,
        score: candidate.score,
        kind: candidate.executorKind,
      })),
      runId: input.runId,
      taskId: task.id,
      mode: decisionMode,
      lowRisk: task.brief?.risk === 'low',
      eligibility: { approved: task.brief?.risk === 'low' && decision.applied !== true, reason: 'deterministic-selection-complete' },
    });
    decisionReceipt = await decideWithFallback(providerRequest, { provider: decisionProvider, mode: decisionMode });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    mode: 'adaptive',
    applied: false,
    decision: sanitizeDecision(decision),
    selectedResource,
    effectiveTask,
    inputDigest,
    reason: decision.selected ? 'selected' : 'no_eligible_selection',
    evidence: {
      ...clone(decision.evidence),
      activeSelection: true,
      proof: historyAdjusted.proof,
      decisionProvider: decisionReceipt,
    },
  };
}

export default planAdaptive;
