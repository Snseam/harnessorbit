import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderSaturation } from '../src/provider-observation.mjs';

test('classifyProviderSaturation matches saturation after auth exclusions', () => {
  assert.equal(classifyProviderSaturation('Selected model is at capacity'), 'provider_saturated');
  assert.equal(classifyProviderSaturation('HTTP 429 rate limit'), 'provider_rate_limited');
  assert.equal(classifyProviderSaturation('resource-exhausted'), 'provider_rate_limited');
  assert.equal(classifyProviderSaturation('proxy_error from gateway'), 'provider_proxy_unavailable');
  assert.equal(classifyProviderSaturation('502 bad gateway via proxy'), 'provider_proxy_unavailable');
  assert.equal(classifyProviderSaturation('model is at capacity'), null);
  assert.equal(classifyProviderSaturation('401 unauthorized Selected model is at capacity'), null);
  assert.equal(classifyProviderSaturation('invalid.api.key'), null);
  assert.equal(classifyProviderSaturation('403 forbidden'), null);
  assert.equal(classifyProviderSaturation('insufficient credits'), null);
  assert.equal(classifyProviderSaturation('quota exceeded'), null);
  assert.equal(classifyProviderSaturation(''), null);
});
