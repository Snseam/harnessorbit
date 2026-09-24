import test from 'node:test';
import assert from 'node:assert/strict';
import { MockDecisionProvider } from '../src/decision-provider.mjs';
import { boundReplayTraces, replayShadowTraces } from '../src/shadow-replay.mjs';

const traces = [
  { id: 'route-1', category: 'route', state: { phase: 'dispatch', risk: 'low', taskKind: 'feature' }, candidates: [{ id: 'alpha', score: 2 }, { id: 'beta', score: 1 }], expectedAction: 'route' },
  { id: 'context-1', category: 'context', state: { phase: 'collect', risk: 'medium', taskKind: 'docs' }, candidates: [{ id: 'context-small', score: 1 }], expectedAction: 'rank' },
  { id: 'failure-1', category: 'failure', state: { phase: 'verify', risk: 'high', taskKind: 'bug', errorCode: 'check_failed' }, candidates: [], expectedAction: 'hold' },
];

test('shadow replay bounds historical traces and compares route/context/failure decisions', async () => {
  const result = await replayShadowTraces({ traces, provider: new MockDecisionProvider({ decide: request => {
    const candidate = request.candidates.find(item => item.eligible);
    return candidate ? { action: 'route', candidateId: candidate.id, confidence: 0.8 } : { action: 'hold', abstained: true, confidence: 0.8 };
  } }) });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.traceCount, 3);
  assert.deepEqual(result.counts, { route: 1, context: 1, failure: 1 });
  assert.equal(result.fallbackCount, 0);
  assert.equal(result.rows[0].candidateId, 'alpha');
  assert.ok(result.rows.every(row => /^[a-f0-9]{64}$/.test(row.inputDigest)));
});

test('shadow replay records provider fallback and never includes raw state', async () => {
  const result = await replayShadowTraces({ traces: [{ ...traces[0], state: { ...traces[0].state, prompt: 'private prompt' } }], provider: new MockDecisionProvider({ decide: () => { throw Object.assign(new Error('down'), { code: 'provider_unavailable' }); } }) });
  assert.equal(result.fallbackCount, 1);
  assert.equal(result.rows[0].providerId, 'deterministic');
  assert.ok(!JSON.stringify(result).includes('private prompt'));
  assert.equal(boundReplayTraces(Array.from({ length: 600 }, (_, i) => ({ id: `t${i}`, state: {} }))).length, 500);
});
