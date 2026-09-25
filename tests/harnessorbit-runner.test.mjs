import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGovernedPrompt, childEnvironment, HARNESSORBIT_RUNNER_VERSION, parseTaskPrompt } from '../src/harnessorbit-runner.mjs';

test('HarnessOrbit runner parses the benchmark prompt and keeps governance visible', () => {
  assert.equal(parseTaskPrompt(['--flag', 'task prompt']), 'task prompt');
  const prompt = buildGovernedPrompt('Add the bounded fixture marker.', {
    context: { project: { root: '/tmp/project', head: 'abc' }, baseline: { fileCount: 3, snapshotDigest: 'd'.repeat(64) } },
    decision: { recommendation: { action: 'hold' } },
  });
  assert.match(prompt, /HarnessOrbit governed execution/);
  assert.match(prompt, /independent verification/);
  assert.match(prompt, /Add the bounded fixture marker/);
});

test('HarnessOrbit runner exposes a versioned first-party runtime identity', () => {
  assert.match(HARNESSORBIT_RUNNER_VERSION, /^0\.1\.0$/);
});

test('HarnessOrbit runner never forwards provider credentials to the Codex child', () => {
  const env = childEnvironment({ JEV_JBSD_API_KEY: 'private', JEV_ENDPOINT: 'https://example.invalid', PATH: '/bin' });
  assert.deepEqual(env, { PATH: '/bin' });
});
