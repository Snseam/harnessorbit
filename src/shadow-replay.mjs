import crypto from 'node:crypto';
import { invariant } from './errors.mjs';
import { createDecisionRequest, decideWithFallback, DeterministicDecisionProvider, decisionDigest } from './decision-provider.mjs';

export const SHADOW_REPLAY_SCHEMA_VERSION = 1;
const MAX_TRACES = 500;
const MAX_IDS = 32;

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function boundedTrace(trace, index) {
  invariant(trace && typeof trace === 'object' && !Array.isArray(trace), 'replay_invalid_trace', 'Trace must be an object.', { index });
  const id = typeof trace.id === 'string' && trace.id.length <= 128 ? trace.id : `trace-${index + 1}`;
  const state = trace.state && typeof trace.state === 'object' && !Array.isArray(trace.state) ? {
    phase: typeof trace.state.phase === 'string' ? trace.state.phase.slice(0, 64) : 'unknown',
    risk: typeof trace.state.risk === 'string' ? trace.state.risk.slice(0, 32) : 'unknown',
    taskKind: typeof trace.state.taskKind === 'string' ? trace.state.taskKind.slice(0, 64) : 'unknown',
    status: typeof trace.state.status === 'string' ? trace.state.status.slice(0, 64) : 'unknown',
    errorCode: typeof trace.state.errorCode === 'string' ? trace.state.errorCode.slice(0, 96) : null,
  } : {};
  const candidates = (Array.isArray(trace.candidates) ? trace.candidates : []).slice(0, MAX_IDS).map((candidate, candidateIndex) => ({
    id: typeof candidate?.id === 'string' ? candidate.id.slice(0, 160) : `candidate-${candidateIndex + 1}`,
    eligible: candidate?.eligible !== false,
    score: typeof candidate?.score === 'number' && Number.isFinite(candidate.score) ? candidate.score : null,
    kind: typeof candidate?.kind === 'string' ? candidate.kind.slice(0, 64) : null,
  }));
  return {
    traceId: id,
    category: ['route', 'context', 'failure'].includes(trace.category) ? trace.category : 'route',
    state,
    candidates,
    expectedAction: typeof trace.expectedAction === 'string' ? trace.expectedAction.slice(0, 32) : null,
    inputDigest: digest({ id, state, candidates }),
  };
}

export function boundReplayTraces(traces) {
  invariant(Array.isArray(traces), 'replay_invalid_traces', 'Shadow replay traces must be an array.');
  return traces.slice(0, MAX_TRACES).map(boundedTrace);
}

export async function replayShadowTraces({ traces, provider, fallback = new DeterministicDecisionProvider() } = {}) {
  const bounded = boundReplayTraces(traces);
  const rows = [];
  for (const trace of bounded) {
    const request = createDecisionRequest({
      kind: `replay.${trace.category}`,
      state: trace.state,
      candidates: trace.candidates,
      mode: 'shadow',
      lowRisk: trace.state.risk === 'low',
    });
    const result = await decideWithFallback(request, { provider: provider || fallback, fallback, mode: 'shadow' });
    rows.push({
      traceId: trace.traceId,
      category: trace.category,
      inputDigest: trace.inputDigest,
      decisionDigest: decisionDigest(result),
      providerId: result.provider.id,
      action: result.recommendation.action,
      candidateId: result.recommendation.candidateId,
      abstained: result.abstained,
      fallback: result.fallback,
      expectedAction: trace.expectedAction,
    });
  }
  const counts = Object.fromEntries(['route', 'context', 'failure'].map(category => [category, rows.filter(row => row.category === category).length]));
  return {
    schemaVersion: SHADOW_REPLAY_SCHEMA_VERSION,
    replayId: crypto.randomUUID(),
    traceCount: rows.length,
    bounded: bounded.length === rows.length,
    counts,
    fallbackCount: rows.filter(row => row.fallback.used).length,
    abstainCount: rows.filter(row => row.abstained).length,
    rows,
  };
}
