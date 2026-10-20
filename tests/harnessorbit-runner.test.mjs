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

test('HarnessOrbit runner records a content-bound decision digest and honours the injected spawner', async t => {
  const { EventEmitter } = await import('node:events');
  const { fixture } = await import('./helpers.mjs');
  const { runHarnessOrbit } = await import('../src/harnessorbit-runner.mjs');
  const crypto = await import('node:crypto');
  const f = await fixture();
  t.after(f.remove);
  const spawned = [];
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    spawned.push({ command, args });
    setImmediate(() => { child.stdout.emit('data', 'ok'); child.emit('close', 0, null); });
    return child;
  };
  const result = await runHarnessOrbit({ cwd: f.project, prompt: 'Fix add', stateRoot: f.stateRoot, codexCommand: 'fake-codex', env: { PATH: '/bin' }, spawnImpl });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, 'fake-codex');
  assert.equal(result.outcome, 'accepted');
  assert.match(result.harnessOrbit.decisionDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(result.harnessOrbit.decisionDigest, crypto.createHash('sha256').update('[object Object]').digest('hex'));
});
