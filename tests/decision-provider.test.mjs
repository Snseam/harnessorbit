import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DECISION_SCHEMA_VERSION,
  DeterministicDecisionProvider,
  JevDecisionProvider,
  MockDecisionProvider,
  assertDecisionReceipt,
  createDecisionRequest,
  decideWithFallback,
  decisionDigest,
} from '../src/decision-provider.mjs';

function request(extra = {}) {
  return createDecisionRequest({
    kind: 'route.candidate',
    state: { phase: 'dispatch', risk: 'low', taskKind: 'feature', secretToken: 'must-not-leak' },
    candidates: [{ id: 'alpha', eligible: true, score: 2 }, { id: 'beta', eligible: true, score: 1 }],
    ...extra,
  });
}

test('decision request is bounded, deterministic and excludes nested secret-shaped fields', () => {
  const first = request();
  const second = request();
  assert.equal(first.inputDigest, second.inputDigest);
  assert.equal(first.state.secretToken, undefined);
  assert.equal(first.schemaVersion, DECISION_SCHEMA_VERSION);
  assert.ok(first.inputDigest.match(/^[0-9a-f]{64}$/));
  assert.ok(JSON.stringify(first).includes('route.candidate'));
  assert.ok(!JSON.stringify(first).includes('must-not-leak'));
  const nested = request({ state: { nested: { prompt: 'private prompt', safe: 'kept' }, values: [{ token: 'private token', id: 'ok' }] } });
  assert.equal(nested.state.nested, undefined);
  assert.equal(nested.state.values, undefined);
  assert.ok(!JSON.stringify(nested).includes('private prompt'));
  const disguised = request({ state: { phase: 'dispatch', context: 'raw private context', taskKind: 'feature with raw prompt' } });
  assert.equal(disguised.state.context, undefined);
  assert.equal(disguised.state.taskKind, undefined);
  assert.throws(() => request({ candidates: [{ id: 'raw candidate with source' }] }), /candidate id/i);
});

test('deterministic provider returns advisory ranking with no state transition authority', async () => {
  const result = await new DeterministicDecisionProvider().decide(request());
  assert.equal(result.provider.id, 'deterministic');
  assert.deepEqual(result.recommendation, { action: 'route', candidateId: 'alpha' });
  assert.equal(result.applied, false);
  assert.equal(result.threshold, 0.75);
  assert.equal(result.finalLocalAction, 'none');
  assert.equal(result.fallback.used, false);
  assertDecisionReceipt(result);
  assert.ok(decisionDigest(result).match(/^[0-9a-f]{64}$/));
  assert.equal(result.accepted, undefined);
  assert.equal(result.integrated, undefined);
});

test('no eligible candidate abstains instead of selecting a fallback resource', async () => {
  const result = await new DeterministicDecisionProvider().decide(request({ candidates: [{ id: 'blocked', eligible: false }] }));
  assert.equal(result.abstained, true);
  assert.equal(result.recommendation.action, 'hold');
  assert.equal(result.recommendation.candidateId, null);
  assert.ok(result.reasonCodes.includes('no_eligible_candidate'));
});

test('Jev adapter sends only sanitized state and never exposes its key in errors or receipts', async () => {
  const calls = [];
  const provider = new JevDecisionProvider({
    endpoint: 'https://example.invalid/jev',
    apiKey: 'unit-test-secret',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, async json() { return { action: 'route', candidateId: 'beta', confidence: 0.8 }; } };
    },
  });
  const result = await provider.decide(request());
  assert.equal(result.provider.id, 'jev');
  assert.deepEqual(result.recommendation, { action: 'route', candidateId: 'beta' });
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.state.secretToken, undefined);
  assert.equal(calls[0].init.headers.authorization, 'Bearer unit-test-secret');
  assert.ok(!JSON.stringify(result).includes('unit-test-secret'));
});

test('Jev adapter accepts the official evaluation answer and records bounded usage metadata', async () => {
  const calls = [];
  const provider = new JevDecisionProvider({
    endpoint: 'https://example.invalid/v1/evaluate',
    apiKey: 'unit-test-secret',
    model: 'typesafe-ai/jev',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            model: 'typesafe-ai/jev',
            answers: { decision: { type: 'choice', choice: 'beta', probabilities: { hold: 0.1, alpha: 0.2, beta: 0.7 } } },
            usage: { inputTokens: 275, outputTokens: 20 },
            providerMetadata: { gateway: { gatewayCost: '0.00001155' } },
          };
        },
      };
    },
  });
  const result = await provider.decide(request());
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'typesafe-ai/jev');
  assert.equal(body.questions.decision.type, 'choice');
  assert.equal(body.questions.decision.criteria.hold !== undefined, true);
  assert.deepEqual(result.recommendation, { action: 'route', candidateId: 'beta' });
  assert.equal(result.confidence, 0.7);
  assert.deepEqual(result.usage, { inputTokens: 275, outputTokens: 20, cost: 0.00001155 });
  assert.ok(!JSON.stringify(result).includes('unit-test-secret'));
});

test('Jev adapter accepts the direct TypeSafe System One response shape', async () => {
  const provider = new JevDecisionProvider({
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    apiKey: 'unit-test-secret',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          model: 'jev-1.13.0',
          answers: { decision: { type: 'choice', choice: 'alpha', confidence: 0.91, probabilities: { alpha: 0.91, beta: 0.06, hold: 0.03 } } },
          usage: { input_tokens: 373, output_tokens: 38 },
        };
      },
    }),
  });
  const result = await provider.decide(request());
  assert.deepEqual(result.recommendation, { action: 'route', candidateId: 'alpha' });
  assert.equal(result.confidence, 0.91);
  assert.deepEqual(result.usage, { inputTokens: 373, outputTokens: 38, cost: null });
});

test('provider unavailable, timeout and invalid response use deterministic fallback', async () => {
  const fallback = new DeterministicDecisionProvider();
  const unavailable = await decideWithFallback(request(), {
    provider: new JevDecisionProvider({ endpoint: '', apiKey: '' }),
    fallback,
  });
  assert.equal(unavailable.fallback.used, true);
  assert.equal(unavailable.fallback.providerId, 'deterministic');
  assert.equal(unavailable.fallback.reasonCode, 'provider_unavailable');
  assert.deepEqual(unavailable.recommendation, { action: 'route', candidateId: 'alpha' });

  const invalid = await decideWithFallback(request(), {
    provider: new JevDecisionProvider({ endpoint: 'https://example.invalid', apiKey: 'secret', fetchImpl: async () => ({ ok: true, async json() { return { action: 'integrate' }; } }) }),
    fallback,
  });
  assert.equal(invalid.fallback.reasonCode, 'provider_invalid_response');
  assert.equal(invalid.recommendation.action, 'route');
});

test('online mode refuses unapproved or high-risk use and shadow mode never applies provider output', async () => {
  const mock = new MockDecisionProvider({ decide: { action: 'route', candidateId: 'alpha', confidence: 1 } });
  const unapproved = await decideWithFallback(request({ mode: 'online', lowRisk: true, eligibility: { approved: false } }), { provider: mock, mode: 'online', applied: true });
  assert.equal(unapproved.fallback.used, true);
  assert.equal(unapproved.applied, false);

  const shadow = await decideWithFallback(request({ mode: 'shadow', lowRisk: true, eligibility: { approved: true } }), { provider: mock, mode: 'shadow', applied: true });
  assert.equal(shadow.applied, false);

  const approved = await decideWithFallback(request({ mode: 'online', lowRisk: true, eligibility: { approved: true } }), { provider: mock, mode: 'online', applied: true });
  assert.equal(approved.applied, true);
  assert.equal(approved.finalLocalAction, 'advisory_rank_applied');

  const disabled = await decideWithFallback(request({ mode: 'online', lowRisk: true, eligibility: { approved: true } }), { provider: mock, mode: 'online', enabled: false, applied: true });
  assert.equal(disabled.fallback.reasonCode, 'provider_disabled');
  assert.equal(disabled.applied, false);
});

test('provider boundary validates candidate eligibility and strips untrusted receipt fields', async () => {
  const onlineRequest = request({ mode: 'online', lowRisk: true, eligibility: { approved: true } });
  const provider = {
    id: 'untrusted',
    async decide(input) {
      return {
        schemaVersion: 1,
        receiptSchemaVersion: 1,
        provider: { id: 'untrusted', version: '1' },
        kind: input.kind,
        mode: input.mode,
        recommendation: { action: 'route', candidateId: 'blocked' },
        confidence: 1,
        inputDigest: input.inputDigest,
        prompt: 'must not escape',
      };
    },
  };
  const result = await decideWithFallback(onlineRequest, { provider, mode: 'online', applied: true });
  assert.equal(result.fallback.used, true);
  assert.equal(result.fallback.reasonCode, 'decision_invalid_response');
  assert.equal(result.applied, false);
  assert.equal('prompt' in result, false);
});

test('provider errors and probability metadata cannot carry raw secrets into receipts', async () => {
  const input = request();
  const malformed = new MockDecisionProvider({ decide: {
    action: 'route', candidateId: 'alpha', confidence: 0.9,
    probabilities: { route: 0.9, prompt: 'private prompt', rank: { secret: 'private' } },
    reasonCodes: ['good_code', 'raw private reason'],
  } });
  const result = await decideWithFallback(input, { provider: malformed });
  assert.deepEqual(Object.keys(result.probabilities).sort(), ['hold', 'rank', 'review', 'route']);
  assert.ok(!JSON.stringify(result).includes('private'));
  const failed = await decideWithFallback(input, { provider: { decide() { throw Object.assign(new Error('failed'), { code: 'private secret value' }); } } });
  assert.equal(failed.fallback.reasonCode, 'provider_failed');
});

test('hold receipts clear candidates, sanitize reasons and normalize probabilities', async () => {
  const input = request();
  const provider = new MockDecisionProvider({ decide: {
    action: 'hold', candidateId: 'secret-token-value', confidence: 0.5,
    probabilities: { route: 1, rank: 1, review: 1, hold: 1 },
    reasonCodes: ['secret_token', 'safe_reason'],
  } });
  const result = await decideWithFallback(input, { provider });
  assert.equal(result.recommendation.candidateId, null);
  assert.deepEqual(result.reasonCodes, ['safe_reason']);
  assert.equal(Object.values(result.probabilities).reduce((sum, value) => sum + value, 0), 1);
});

test('decision digest covers material receipt fields', async () => {
  const input = request();
  const result = await new DeterministicDecisionProvider().decide(input);
  const original = decisionDigest(result);
  for (const [field, value] of [
    ['threshold', result.threshold + 0.01],
    ['probabilities', { ...result.probabilities, route: 0.01 }],
    ['mode', 'online'],
    ['responseDigest', 'a'.repeat(64)],
    ['latencyMs', result.latencyMs + 1],
    ['finalLocalAction', 'advisory_rank_applied'],
    ['usage', { inputTokens: 999, outputTokens: 1, cost: 0.01 }],
  ]) {
    assert.notEqual(decisionDigest({ ...result, [field]: value }), original, field);
  }
});
