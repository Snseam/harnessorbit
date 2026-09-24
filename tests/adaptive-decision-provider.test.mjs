import test from 'node:test';
import assert from 'node:assert/strict';
import { planAdaptive } from '../src/adaptive-selection.mjs';
import { MockDecisionProvider } from '../src/decision-provider.mjs';

const NOW = Date.parse('2026-09-17T02:00:00.000Z');

test('adaptive selection records a Jev shadow receipt without changing deterministic selection', async () => {
  const input = {
    id: 'shadow-task',
    objective: 'bounded objective',
    allowedPaths: ['src/'],
    checks: [{ name: 'unit', argv: ['node', '--test'] }],
    isolation: 'checkout',
    brief: { taskKind: 'feature', risk: 'low', independent: true },
  };
  const inventory = {
    schemaVersion: 1,
    resources: [{
      id: 'profile-codex', kind: 'profile', agent: 'codex', profileId: 'codex', installed: true, configured: true,
      authentication: { state: 'observed', source: 'test' },
      quota: { state: 'available', remainingTokens: 10, observedAt: NOW - 60_000, expiresAt: NOW + 600_000 },
      capabilities: { values: [], source: 'test', unverified: true },
      callVerification: { state: 'verified', observedAt: NOW - 60_000, expiresAt: NOW + 600_000, qualityStatus: 'passed' },
    }],
  };
  const result = await planAdaptive({
    input,
    inventory,
    fixedExecutorKind: 'external',
    hostAvailable: false,
    now: NOW,
    decisionProvider: new MockDecisionProvider({ decide: { action: 'route', candidateId: 'profile-codex', confidence: 0.9 } }),
  });
  assert.equal(result.selectedResource.id, 'profile-codex');
  assert.equal(result.applied, false);
  assert.equal(result.evidence.decisionProvider.provider.id, 'mock');
  assert.equal(result.evidence.decisionProvider.applied, false);
  assert.equal(result.evidence.decisionProvider.recommendation.candidateId, 'profile-codex');
});
