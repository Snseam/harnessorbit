import crypto from 'node:crypto';
import { OrchestratorError, invariant } from './errors.mjs';

/**
 * Decision providers are advisory. They may rank or classify a bounded,
 * sanitized request, but they never own run state, permissions, retries,
 * acceptance, integration, merge, push, or deployment.
 */
export const DECISION_SCHEMA_VERSION = 1;
export const DECISION_RECEIPT_SCHEMA_VERSION = 1;
const MAX_STATE_KEYS = 32;
const MAX_STRING = 512;
const MAX_ARRAY = 32;
const SAFE_ACTIONS = new Set(['route', 'rank', 'review', 'hold']);
const SECRET_KEY_RE = /(key|token|secret|password|credential|authorization|prompt|answer|stdout|stderr|source(code)?)/i;
const STATE_KEYS = new Set(['phase', 'risk', 'taskKind', 'status', 'errorCode', 'selectedExecutor', 'candidateCount']);
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const REASON_CODE_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const SECRET_REASON_RE = /(secret|token|password|credential|authorization|prompt|private|raw|source|key)/i;

function decisionError(code, message, details = {}) {
  return new OrchestratorError(code, message, details);
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clip(value, max = MAX_STRING) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  return value;
}

function identifier(value, max = MAX_STRING) {
  return clip(value, max) && IDENTIFIER_RE.test(value) ? value : null;
}

function reasonCode(value) {
  return typeof value === 'string' && REASON_CODE_RE.test(value) && !SECRET_REASON_RE.test(value) ? value : null;
}

function stableValue(value, depth = 0) {
  if (depth > 5) return '[depth-limit]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map(item => stableValue(item, depth + 1));
  if (plain(value)) {
    return Object.fromEntries(Object.keys(value).sort().slice(0, MAX_STATE_KEYS).map(key => [key, stableValue(value[key], depth + 1)]));
  }
  return String(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function safeState(state) {
  invariant(plain(state), 'decision_invalid_request', 'Decision state must be an object.');
  const result = {};
  for (const key of Object.keys(state).sort().slice(0, MAX_STATE_KEYS)) {
    if (!STATE_KEYS.has(key) || SECRET_KEY_RE.test(key)) continue;
    const value = state[key];
    if (key === 'candidateCount') {
      if (Number.isSafeInteger(value) && value >= 0 && value <= MAX_ARRAY) result[key] = value;
    } else if (typeof value === 'string') {
      const safe = identifier(value, 96);
      if (safe) result[key] = safe;
    } else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      result[key] = value;
    }
  }
  return result;
}

function safeQuestions(questions) {
  if (questions === undefined) return [];
  invariant(Array.isArray(questions), 'decision_invalid_request', 'Decision questions must be an array.');
  return questions.slice(0, MAX_ARRAY).map((question, index) => {
    invariant(plain(question), 'decision_invalid_request', 'Decision question must be an object.', { index });
    const id = identifier(question.id, 128) || `q${index + 1}`;
    const values = Array.isArray(question.choices) ? question.choices : Array.isArray(question.options) ? question.options : [];
    return {
      id,
      choices: values.slice(0, MAX_ARRAY).map(value => identifier(value, 160)).filter(Boolean),
    };
  });
}

function safeCandidates(candidates) {
  if (candidates === undefined) return [];
  invariant(Array.isArray(candidates), 'decision_invalid_request', 'Decision candidates must be an array.');
  return candidates.slice(0, MAX_ARRAY).map((candidate, index) => {
    invariant(plain(candidate), 'decision_invalid_request', 'Decision candidate must be an object.', { index });
    const id = identifier(candidate.id, 160);
    invariant(id, 'decision_invalid_request', 'Decision candidate id is required.', { index });
    return {
      id,
      eligible: candidate.eligible !== false,
      score: typeof candidate.score === 'number' && Number.isFinite(candidate.score) ? candidate.score : null,
      kind: identifier(candidate.kind, 96),
    };
  });
}

export function createDecisionRequest({
  kind,
  state,
  questions,
  candidates,
  runId,
  taskId,
  mode = 'shadow',
  lowRisk = false,
  eligibility = null,
  threshold = 0.75,
} = {}) {
  invariant(typeof kind === 'string' && /^[a-z][a-z0-9_.-]{1,96}$/.test(kind), 'decision_invalid_request', 'Decision kind is invalid.');
  invariant(mode === 'shadow' || mode === 'online', 'decision_invalid_request', 'Decision mode must be shadow or online.');
  invariant(typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1, 'decision_invalid_request', 'Decision threshold must be between 0 and 1.');
  const sanitized = {
    schemaVersion: DECISION_SCHEMA_VERSION,
    kind,
    state: safeState(state || {}),
    questions: safeQuestions(questions),
    candidates: safeCandidates(candidates),
    runId: identifier(runId, 128),
    taskId: identifier(taskId, 128),
    mode,
    lowRisk: lowRisk === true,
    eligibility: plain(eligibility) ? {
      approved: eligibility.approved === true,
      reason: identifier(eligibility.reason, 160),
    } : null,
    threshold,
  };
  return Object.freeze({ ...sanitized, inputDigest: digest(sanitized) });
}

function probabilityMap(action, confidence, candidates = []) {
  const safeConfidence = Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0));
  const map = { route: 0, rank: 0, review: 0, hold: 0 };
  map[action] = safeConfidence;
  if (safeConfidence < 1) map.hold += 1 - safeConfidence;
  if (candidates.length === 0 && action !== 'hold') map.hold = Math.max(map.hold, 1 - safeConfidence);
  return map;
}

function safeProbabilities(value, action, confidence, candidates = []) {
  if (!plain(value)) return probabilityMap(action, confidence, candidates);
  const fallback = probabilityMap(action, confidence, candidates);
  const clamped = Object.fromEntries(Object.keys(fallback).map(key => {
    const candidate = value[key];
    return [key, typeof candidate === 'number' && Number.isFinite(candidate)
      ? Math.max(0, Math.min(1, candidate))
      : fallback[key]];
  }));
  const total = Object.values(clamped).reduce((sum, item) => sum + item, 0);
  if (!(total > 0)) return fallback;
  return Object.fromEntries(Object.entries(clamped).map(([key, item]) => [key, item / total]));
}

function safeUsage(usage) {
  if (!plain(usage)) return null;
  const rawInputTokens = usage.inputTokens ?? usage.input_tokens;
  const rawOutputTokens = usage.outputTokens ?? usage.output_tokens;
  const inputTokens = Number.isSafeInteger(rawInputTokens) && rawInputTokens >= 0 ? rawInputTokens : null;
  const outputTokens = Number.isSafeInteger(rawOutputTokens) && rawOutputTokens >= 0 ? rawOutputTokens : null;
  const numericCost = typeof usage.cost === 'number' ? usage.cost : typeof usage.cost === 'string' && usage.cost.trim() ? Number(usage.cost) : NaN;
  const cost = Number.isFinite(numericCost) && numericCost >= 0 ? numericCost : null;
  if (inputTokens === null && outputTokens === null && cost === null) return null;
  return { inputTokens, outputTokens, cost };
}

function makeResult(request, {
  providerId,
  providerVersion = '1',
  action = 'hold',
  candidateId = null,
  confidence = 0,
  abstained = false,
  reasonCodes = [],
  probabilities,
  latencyMs = 0,
  mode = request.mode,
  fallback = null,
  responseDigest = null,
  usage = null,
  applied = false,
} = {}) {
  const safeAction = SAFE_ACTIONS.has(action) ? action : 'hold';
  const safeCandidateId = safeAction === 'hold' ? null : identifier(candidateId, 160);
  const result = {
    schemaVersion: DECISION_SCHEMA_VERSION,
    receiptSchemaVersion: DECISION_RECEIPT_SCHEMA_VERSION,
    decisionId: crypto.randomUUID(),
    provider: { id: providerId, version: providerVersion },
    kind: request.kind,
    mode,
    recommendation: { action: safeAction, candidateId: safeCandidateId },
    confidence: Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0)),
    threshold: request.threshold,
    probabilities: safeProbabilities(probabilities, safeAction, confidence, request.candidates),
    abstained: abstained === true,
    reasonCodes: [...new Set(reasonCodes.map(reasonCode).filter(Boolean).slice(0, 12))],
    inputDigest: request.inputDigest,
    responseDigest,
    usage: safeUsage(usage),
    latencyMs: Math.max(0, Math.round(Number.isFinite(latencyMs) ? latencyMs : 0)),
    fallback: fallback ? {
      used: fallback.used === true,
      providerId: clip(fallback.providerId, 96),
      reasonCode: clip(fallback.reasonCode, 128),
    } : { used: false, providerId: null, reasonCode: null },
    // A provider never mutates CAO state. This field only records that a
    // caller explicitly applied an advisory ranking to an eligible list.
    applied: applied === true && mode === 'online' && request.lowRisk && request.eligibility?.approved === true && safeAction !== 'hold',
    createdAt: new Date().toISOString(),
  };
  result.finalLocalAction = result.applied ? 'advisory_rank_applied' : 'none';
  return Object.freeze(result);
}

function elapsed(started) {
  return Math.max(0, Date.now() - started);
}

function normalizeProviderResult(request, result) {
  assertDecisionReceipt(result);
  invariant(result.kind === request.kind, 'decision_invalid_response', 'Decision provider kind does not match the request.');
  invariant(result.mode === request.mode, 'decision_invalid_response', 'Decision provider mode does not match the request.');
  invariant(result.inputDigest === request.inputDigest, 'decision_invalid_response', 'Decision provider input digest does not match the request.');
  const action = result.recommendation.action;
  const candidateId = action === 'hold' ? null : result.recommendation.candidateId || null;
  const candidate = candidateId ? request.candidates.find(item => item.id === candidateId) : null;
  invariant(action === 'hold' || candidate?.eligible === true, 'decision_invalid_response', 'Decision provider selected an ineligible or missing candidate.');
  invariant(action === 'hold' || candidateId, 'decision_invalid_response', 'Decision provider must select a candidate for this action.');
  invariant(typeof result.confidence === 'number' && Number.isFinite(result.confidence), 'decision_invalid_response', 'Decision provider confidence is invalid.');
  return makeResult(request, {
    providerId: identifier(result.provider.id, 96) || 'provider',
    providerVersion: identifier(result.provider.version, 96) || '1',
    action,
    candidateId,
    confidence: result.confidence,
    abstained: result.abstained === true || action === 'hold',
    reasonCodes: Array.isArray(result.reasonCodes) ? result.reasonCodes.map(reasonCode).filter(Boolean) : [],
    probabilities: result.probabilities,
    latencyMs: result.latencyMs,
    mode: request.mode,
    responseDigest: typeof result.responseDigest === 'string' && /^[a-f0-9]{64}$/.test(result.responseDigest) ? result.responseDigest : null,
    usage: result.usage,
  });
}

export class DeterministicDecisionProvider {
  constructor({ id = 'deterministic', version = '1' } = {}) {
    this.id = id;
    this.version = version;
  }

  async decide(request) {
    const started = Date.now();
    const eligible = request.candidates.filter(candidate => candidate.eligible);
    const sorted = [...eligible].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.id.localeCompare(b.id));
    if (sorted.length === 0) {
      return makeResult(request, {
        providerId: this.id,
        providerVersion: this.version,
        action: 'hold',
        confidence: 0.99,
        abstained: true,
        reasonCodes: ['no_eligible_candidate'],
        latencyMs: elapsed(started),
      });
    }
    const action = request.kind.includes('failure') || request.kind.includes('review') ? 'review' : request.kind.includes('route') ? 'route' : 'rank';
    return makeResult(request, {
      providerId: this.id,
      providerVersion: this.version,
      action,
      candidateId: sorted[0].id,
      confidence: sorted.length === 1 ? 0.98 : 0.75,
      reasonCodes: ['deterministic_order'],
      latencyMs: elapsed(started),
    });
  }
}

export class MockDecisionProvider {
  constructor({ id = 'mock', version = '1', decide } = {}) {
    this.id = id;
    this.version = version;
    this.handler = decide;
  }

  async decide(request) {
    const started = Date.now();
    const value = typeof this.handler === 'function' ? await this.handler(request) : this.handler;
    invariant(plain(value), 'decision_invalid_response', 'Mock provider response must be an object.');
    return makeResult(request, {
      providerId: this.id,
      providerVersion: this.version,
      action: value.recommendation?.action || value.action,
      candidateId: value.recommendation?.candidateId || value.candidateId || null,
      confidence: value.confidence,
      abstained: value.abstained,
      reasonCodes: value.reasonCodes || ['mock_response'],
      probabilities: value.probabilities,
      responseDigest: digest(value),
      latencyMs: elapsed(started),
    });
  }
}

export class JevDecisionProvider {
  constructor({
    endpoint = process.env.JEV_ENDPOINT || '',
    apiKey = process.env.JEV_JBSD_API_KEY || process.env.JEV_JBSD_APIKEY || '',
    model = null,
    timeoutMs = 2500,
    fetchImpl = globalThis.fetch,
    id = 'jev',
    version = '1',
  } = {}) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.model = model || process.env.JEV_MODEL || (String(endpoint).includes('ai-gateway.vercel.sh') ? 'typesafe-ai/jev' : 'jev-latest');
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.id = id;
    this.version = version;
  }

  async decide(request) {
    if (!this.endpoint || !this.apiKey) throw decisionError('provider_unavailable', 'Jev provider is not configured.');
    if (typeof this.fetchImpl !== 'function') throw decisionError('provider_unavailable', 'Jev provider requires fetch.');
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const eligible = request.candidates.filter(candidate => candidate.eligible === true);
      if (eligible.length === 0) throw decisionError('provider_abstain', 'Jev provider has no eligible candidate.');
      const criteria = Object.fromEntries([
        ['hold', 'Do not select a candidate; keep the deterministic hold decision.'],
        ...eligible.map(candidate => [candidate.id, `${candidate.kind || 'candidate'} with deterministic score ${candidate.score ?? 'unknown'}.`]),
      ]);
      const body = {
        model: this.model,
        state: request.state,
        questions: {
          decision: {
            type: 'choice',
            instructions: 'Choose the best eligible candidate for this bounded CAO decision, or choose hold when evidence is insufficient.',
            criteria,
          },
        },
      };
      let response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw decisionError('provider_timeout', 'Jev provider timed out.');
        throw decisionError('provider_unavailable', 'Jev provider request failed.', { cause: error?.code || 'request_failed' });
      }
      if (!response?.ok) {
        throw decisionError('provider_unavailable', 'Jev provider returned a non-success response.', { status: Number(response?.status) || 0 });
      }
      let payload;
      try { payload = await response.json(); }
      catch { throw decisionError('provider_invalid_response', 'Jev provider returned invalid JSON.'); }
      const answer = payload?.answers?.decision || payload?.answers?.route || (plain(payload?.answers) ? Object.values(payload.answers)[0] : null);
      const choice = answer?.choice || null;
      const action = payload?.recommendation?.action || payload?.action || (choice === 'hold' || payload?.abstain ? 'hold' : choice ? (request.kind.includes('review') ? 'review' : request.kind.includes('route') ? 'route' : 'rank') : null);
      const candidateId = payload?.recommendation?.candidateId || payload?.candidateId || (choice && choice !== 'hold' ? choice : null);
      const abstained = payload?.abstained === true || payload?.abstain === true || action === 'hold';
      if (!abstained && (!SAFE_ACTIONS.has(action) || !candidateId || !request.candidates.some(candidate => candidate.id === candidateId && candidate.eligible === true))) {
        throw decisionError('provider_invalid_response', 'Jev provider returned an invalid recommendation.');
      }
      return makeResult(request, {
        providerId: this.id,
        providerVersion: this.version,
        action: action || 'hold',
        candidateId,
        confidence: payload?.confidence ?? (answer?.confidence ?? answer?.probability ?? answer?.probabilities?.[choice]),
        abstained,
        reasonCodes: Array.isArray(payload?.reasonCodes) ? payload.reasonCodes : ['jev_response'],
        probabilities: payload?.probabilities || answer?.probabilities,
        responseDigest: digest(payload),
        usage: {
          ...(plain(payload?.usage) ? payload.usage : {}),
          cost: payload?.providerMetadata?.gateway?.gatewayCost ?? payload?.providerMetadata?.gateway?.cost,
        },
        latencyMs: elapsed(started),
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function decideWithFallback(request, {
  provider,
  fallback = new DeterministicDecisionProvider(),
  mode = request.mode,
  applied = false,
  enabled = true,
} = {}) {
  invariant(mode === request.mode, 'decision_invalid_request', 'Decision mode must match the request.');
  invariant(provider && typeof provider.decide === 'function', 'decision_invalid_provider', 'Decision provider must expose decide(request).');
  invariant(fallback && typeof fallback.decide === 'function', 'decision_invalid_provider', 'Fallback provider must expose decide(request).');
  if (enabled === false) {
    const result = normalizeProviderResult({ ...request, mode }, await fallback.decide({ ...request, mode }));
    return Object.freeze({
      ...result,
      mode,
      fallback: { used: true, providerId: fallback.id || 'deterministic', reasonCode: 'provider_disabled' },
      reasonCodes: [...new Set([...(result.reasonCodes || []), 'provider_disabled'])],
      applied: false,
      finalLocalAction: 'none',
    });
  }
  const onlineEligible = mode === 'online' && request.lowRisk === true && request.eligibility?.approved === true;
  if (mode === 'online' && !onlineEligible) {
    const result = normalizeProviderResult({ ...request, mode: 'online' }, await fallback.decide({ ...request, mode: 'online' }));
    return Object.freeze({
      ...result,
      fallback: { used: true, providerId: fallback.id || 'deterministic', reasonCode: 'online_not_eligible' },
      applied: false,
    });
  }
  try {
    const result = normalizeProviderResult(request, await provider.decide(request));
    const appliedResult = Boolean(applied && onlineEligible && !result.abstained);
    return Object.freeze({ ...result, mode, applied: appliedResult, finalLocalAction: appliedResult ? 'advisory_rank_applied' : 'none' });
  } catch (error) {
    const result = normalizeProviderResult(request, await fallback.decide(request));
    const reasonCode = identifier(error?.code, 128) || 'provider_failed';
    return Object.freeze({
      ...result,
      mode,
      fallback: { used: true, providerId: identifier(fallback.id, 96) || 'deterministic', reasonCode },
      reasonCodes: [...new Set([...(result.reasonCodes || []), 'provider_fallback'])],
      applied: false,
    });
  }
}

export function decisionDigest(result) {
  invariant(plain(result), 'decision_invalid_result', 'Decision result must be an object.');
  // decisionId and createdAt are generated per receipt and are intentionally
  // excluded. Every other receipt field is part of this audit digest.
  return digest({
    schemaVersion: result.schemaVersion,
    receiptSchemaVersion: result.receiptSchemaVersion,
    provider: result.provider,
    kind: result.kind,
    mode: result.mode,
    recommendation: result.recommendation,
    confidence: result.confidence,
    threshold: result.threshold,
    probabilities: result.probabilities,
    abstained: result.abstained,
    reasonCodes: result.reasonCodes,
    inputDigest: result.inputDigest,
    responseDigest: result.responseDigest,
    usage: result.usage,
    latencyMs: result.latencyMs,
    fallback: result.fallback,
    applied: result.applied,
    finalLocalAction: result.finalLocalAction,
  });
}

export function assertDecisionReceipt(result) {
  invariant(plain(result), 'decision_invalid_result', 'Decision result must be an object.');
  invariant(result.schemaVersion === DECISION_SCHEMA_VERSION, 'decision_invalid_result', 'Unsupported decision schema version.');
  invariant(result.receiptSchemaVersion === DECISION_RECEIPT_SCHEMA_VERSION, 'decision_invalid_result', 'Unsupported decision receipt schema version.');
  invariant(plain(result.provider) && typeof result.provider.id === 'string', 'decision_invalid_result', 'Decision provider identity is missing.');
  invariant(typeof result.inputDigest === 'string' && /^[0-9a-f]{64}$/.test(result.inputDigest), 'decision_invalid_result', 'Decision input digest is invalid.');
  invariant(plain(result.recommendation) && SAFE_ACTIONS.has(result.recommendation.action), 'decision_invalid_result', 'Decision action is invalid.');
  return true;
}
