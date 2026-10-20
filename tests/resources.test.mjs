import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ResourceService } from '../src/resources/index.mjs';
import { ProfileStore } from '../src/profiles.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'cao-resources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  const bin = path.join(root, 'bin');
  await mkdir(home, { recursive: true });
  await mkdir(state, { recursive: true });
  await mkdir(bin, { recursive: true });
  return { root, home, state, bin };
}

async function writeExecutable(file) {
  await writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

test('readable but non-executable PATH files are not installed agents', { skip: process.platform === 'win32' }, async t => {
  const { home, state, bin } = await fixture(t);
  await writeFile(path.join(bin, 'pi'), 'not executable', { mode: 0o600 });
  const inventory = await new ResourceService({ root: state, home, environment: { PATH: bin } }).discover({ agents: ['pi'] });
  assert.equal(inventory.resources.find(r => r.id === 'native-pi').installed, false);
});

test('Pi command and unresolved credential expressions do not advertise probe support', async t => {
  const { home, state, bin } = await fixture(t);
  await writeExecutable(path.join(bin, 'pi'));
  await mkdir(path.join(home, '.pi', 'agent'), { recursive: true });
  const providers = Object.fromEntries([['command','!secret-command'],['missing','$NO_SUCH_KEY'],['mixed','${PREFIX}_${SUFFIX}'],['ready','$KNOWN_KEY'],['literal','PLAIN_LITERAL']].map(([id, apiKey]) => [id, { api: 'anthropic-messages', baseUrl: 'https://example.test', apiKey, models: [{ id: 'm' }] }]));
  await writeFile(path.join(home, '.pi', 'agent', 'models.json'), JSON.stringify({ providers }));
  const rows = (await new ResourceService({ root: state, home, environment: { PATH: bin, KNOWN_KEY: 'private-env-value' } }).discover({ agents: ['pi'] })).resources;
  for (const providerId of ['command','missing','mixed']) assert.equal(rows.find(r => r.providerId === providerId).probe.supported, false);
  for (const providerId of ['ready','literal']) assert.equal(rows.find(r => r.providerId === providerId).probe.supported, true);
  assert.doesNotMatch(JSON.stringify(rows), /private-env-value|secret-command|PLAIN_LITERAL/);
});

function profile(id, extra = {}) {
  return {
    id,
    name: id,
    agent: 'claude',
    model: `${id}-model`,
    protocol: 'anthropic',
    endpoint: 'https://api.anthropic.example/v1',
    credential: { type: 'env', name: 'ANTHROPIC_API_KEY' },
    source: { type: 'native' },
    capabilities: ['coding'],
    account: { id: 'anthropic-main', maxParallel: 2 },
    quota: { state: 'available', observedAt: '2026-09-17T00:50:00.000Z', expiresAt: '2026-09-18T00:00:00.000Z', remainingTokens: 123 },
    ...extra,
  };
}

test('discover returns native resources without executing commands and omits raw secrets', async t => {
  const { home, state, bin } = await fixture(t);
  await writeExecutable(path.join(bin, 'claude'));
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    model: 'claude-public-model',
    env: {
      ANTHROPIC_MODEL: 'claude-env-model',
      ANTHROPIC_API_KEY: 'settings-secret-never-leaks',
      ANTHROPIC_BASE_URL: 'https://user:secret@api.anthropic.example/v1?token=bad',
    },
  }));

  const calls = [];
  const service = new ResourceService({
    root: state,
    home,
    environment: {
      PATH: bin,
      ANTHROPIC_API_KEY: 'env-secret-never-leaks',
      ANTHROPIC_MODEL: 'env-public-model',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.example/v1?api_key=bad',
    },
    runner: async argv => { calls.push(argv); throw new Error('should not execute'); },
    now: () => Date.parse('2026-09-17T01:00:00.000Z'),
  });

  const inventory = await service.discover();
  assert.deepEqual(calls, []);
  assert.equal(inventory.schemaVersion, 1);
  const claude = inventory.resources.find(resource => resource.id === 'native-claude');
  assert.equal(claude.installed, true);
  assert.equal(claude.executable, path.join(bin, 'claude'));
  assert.equal(claude.executableDiscoverySource, 'PATH');
  assert.equal(claude.requestedModel, 'env-public-model');
  assert.equal(claude.authentication.state, 'observed');
  assert.equal(claude.version, null);
  assert.equal(claude.probe.supported, true);
  assert.equal(inventory.resources.find(resource => resource.id === 'native-pi').installed, false);
  const serialized = JSON.stringify(inventory);
  assert.doesNotMatch(serialized, /env-secret-never-leaks|settings-secret-never-leaks|api_key=bad|token=bad|user:secret/);
});

test('native Claude settings env auth supports probes without exposing the value', async t => {
  const { home, state, bin } = await fixture(t);
  await writeExecutable(path.join(bin, 'claude'));
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_API_KEY: 'settings-only-secret-never-leaks' },
  }));
  const service = new ResourceService({
    root: state,
    home,
    environment: { PATH: bin },
  });

  const inventory = await service.discover({ agents: ['claude'] });
  const claude = inventory.resources.find(resource => resource.id === 'native-claude');
  assert.equal(claude.authentication.state, 'observed');
  assert.equal(claude.authentication.source, 'settings.env');
  assert.equal(claude.probe.supported, true);
  assert.doesNotMatch(JSON.stringify(inventory), /settings-only-secret-never-leaks/);
});

test('PATH-missing Pi installation is discovered from newest NVM version and safe agent config', async t => {
  const { home, state } = await fixture(t);
  const oldBin = path.join(home, '.nvm', 'versions', 'node', 'v20.1.0', 'bin');
  const newBin = path.join(home, '.nvm', 'versions', 'node', 'v22.22.0', 'bin');
  await mkdir(oldBin, { recursive: true });
  await mkdir(newBin, { recursive: true });
  await writeExecutable(path.join(oldBin, 'pi'));
  await writeExecutable(path.join(newBin, 'pi'));
  await mkdir(path.join(home, '.pi', 'agent'), { recursive: true });
  await writeFile(path.join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({
    defaultProvider: 'kimi-coding',
    defaultModel: 'k3',
    defaultThinkingLevel: 'medium',
    apiKey: 'pi-settings-secret-never-leaks',
  }));
  await writeFile(path.join(home, '.pi', 'agent', 'models.json'), JSON.stringify({
    providers: {
      'kimi-coding': {
        api: 'anthropic-messages',
        apiKey: 'pi-models-secret-never-leaks',
        models: [
          { id: 'k3', contextWindow: 1_000_000, maxOutputTokens: 128_000 },
        ],
      },
      'cc-switch-kimi-for-coding': {
        api: 'anthropic-messages',
        apiKey: 'cc-switch-secret-never-leaks',
        models: [
          { id: 'k3', contextWindow: 1_000_000, maxOutputTokens: 128_000 },
        ],
      },
      'cc-switch-zhipu-glm': {
        api: 'openai-completions',
        models: {
          'glm-5.3': { contextWindow: 200_000, maxOutputTokens: 131_072 },
          'glm-5.3-flash': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
        },
      },
    },
  }));
  await writeFile(path.join(home, '.pi', 'agent', 'auth.json'), JSON.stringify({
    providers: {
      'openai-codex': { type: 'oauth' },
      xai: 'literal-token-never-type',
      'kimi-coding': { type: 'api_key' },
    },
  }));
  const calls = [];
  const service = new ResourceService({
    root: state,
    home,
    environment: { PATH: '', NVM_DIR: path.join(home, '.nvm') },
    runner: async (argv, options) => {
      calls.push({ argv, options });
      return { code: 0, stdout: 'pi-coding-agent 0.9.8\n', stderr: '', truncated: false };
    },
    now: () => Date.parse('2026-09-17T01:00:00.000Z'),
  });

  const inventory = await service.discover({ check: true, agents: ['pi'] });
  const pi = inventory.resources.find(resource => resource.id === 'native-pi');
  assert.equal(pi.installed, true);
  assert.equal(pi.executable, path.join(newBin, 'pi'));
  assert.equal(pi.executableDiscoverySource, 'nvm');
  assert.equal(pi.providerId, 'kimi-coding');
  assert.equal(pi.version, '0.9.8');
  assert.equal(pi.requestedModel, 'k3');
  assert.equal(pi.effort, 'medium');
  assert.equal(pi.authentication.state, 'observed');
  assert.equal(pi.probe.supported, true);
  assert.deepEqual(calls.map(call => call.argv), [[path.join(newBin, 'pi'), '--version']]);
  const piModelResources = inventory.resources.filter(resource => resource.id.startsWith('native-pi-'));
  assert.equal(piModelResources.length, 4);
  assert.equal(piModelResources.some(resource => resource.providerId === 'kimi-coding' && resource.requestedModel === 'k3'), true);
  assert.equal(piModelResources.some(resource => resource.providerId === 'cc-switch-kimi-for-coding' && resource.requestedModel === 'k3'), true);
  assert.notEqual(
    piModelResources.find(resource => resource.providerId === 'kimi-coding' && resource.requestedModel === 'k3').id,
    piModelResources.find(resource => resource.providerId === 'cc-switch-kimi-for-coding' && resource.requestedModel === 'k3').id,
  );
  assert.equal(piModelResources.find(resource => resource.providerId === 'cc-switch-zhipu-glm' && resource.requestedModel === 'glm-5.3').capabilities.model.contextWindow, 200_000);
  assert.equal(JSON.stringify(inventory).includes('literal-token-never-type'), false);
  assert.equal(JSON.stringify(inventory).includes('pi.auth.json.literal-token-never-type'), false);
  assert.doesNotMatch(JSON.stringify(inventory), /pi-settings-secret-never-leaks|pi-models-secret-never-leaks|cc-switch-secret-never-leaks/);
});

test('environment config directory overrides are honored for Claude Codex and Pi', async t => {
  const { home, state, root, bin } = await fixture(t);
  await writeExecutable(path.join(bin, 'claude'));
  await writeExecutable(path.join(bin, 'codex'));
  await writeExecutable(path.join(bin, 'pi'));
  const claudeDir = path.join(root, 'claude-config');
  const codexDir = path.join(root, 'codex-home');
  const piDir = path.join(root, 'pi-agent');
  await mkdir(claudeDir, { recursive: true });
  await mkdir(codexDir, { recursive: true });
  await mkdir(piDir, { recursive: true });
  await writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'override-claude' } }));
  await writeFile(path.join(codexDir, 'config.toml'), 'model = "override-codex"\nmodel_reasoning_effort = "xhigh"\n');
  await writeFile(path.join(piDir, 'settings.json'), JSON.stringify({ defaultProvider: 'override-provider', defaultModel: 'override-pi' }));

  const service = new ResourceService({
    root: state,
    home,
    environment: {
      PATH: bin,
      CLAUDE_CONFIG_DIR: claudeDir,
      CODEX_HOME: codexDir,
      PI_CODING_AGENT_DIR: piDir,
    },
  });
  const inventory = await service.discover();
  assert.equal(inventory.resources.find(resource => resource.id === 'native-claude').requestedModel, 'override-claude');
  assert.equal(inventory.resources.find(resource => resource.id === 'native-codex').requestedModel, 'override-codex');
  assert.equal(inventory.resources.find(resource => resource.id === 'native-codex').effort, 'xhigh');
  assert.equal(inventory.resources.find(resource => resource.id === 'native-pi').requestedModel, 'override-pi');
});

test('native config JSON reads reject symlinks and do not leak linked contents', async t => {
  const { home, state, root } = await fixture(t);
  await mkdir(path.join(home, '.pi', 'agent'), { recursive: true });
  const target = path.join(root, 'linked-secret.json');
  await writeFile(target, JSON.stringify({ defaultProvider: 'secret-provider-never-leaks', defaultModel: 'secret-model-never-leaks' }));
  await symlink(target, path.join(home, '.pi', 'agent', 'settings.json'));

  const service = new ResourceService({
    root: state,
    home,
    environment: { PATH: '' },
  });
  const inventory = await service.discover({ agents: ['pi'] });
  const pi = inventory.resources.find(resource => resource.id === 'native-pi');
  assert.equal(pi.requestedModel, null);
  assert.equal(pi.providerId, null);
  assert.doesNotMatch(JSON.stringify(inventory), /secret-provider-never-leaks|secret-model-never-leaks/);
});

test('profile resources share managed quota groups and report credential freshness without leaking env values', async t => {
  const { home, state } = await fixture(t);
  await mkdir(path.join(home, '.local', 'bin'), { recursive: true });
  await writeExecutable(path.join(home, '.local', 'bin', 'claude'));
  const store = new ProfileStore({ root: state });
  await store.put(profile('claude-main'));
  await store.put(profile('claude-backup', { account: { id: 'anthropic-main', maxParallel: 1 }, quota: { state: 'unknown', observedAt: null, expiresAt: null, remainingTokens: null } }));

  const service = new ResourceService({
    root: state,
    home,
    environment: { PATH: '', ANTHROPIC_API_KEY: 'profile-secret-never-leaks' },
    profiles: store,
    now: () => Date.parse('2026-09-17T01:00:00.000Z'),
  });
  const inventory = await service.discover({ agents: ['claude'] });
  const resources = inventory.resources.filter(resource => resource.kind === 'profile');
  assert.deepEqual(resources.map(resource => resource.id), ['profile-claude-backup', 'profile-claude-main']);
  assert.equal(resources[0].quotaGroup.id, 'account:anthropic-main');
  assert.equal(resources[1].quotaGroup.id, 'account:anthropic-main');
  assert.equal(resources[0].installed, true);
  assert.equal(resources[0].executable, path.join(home, '.local', 'bin', 'claude'));
  assert.equal(resources.find(resource => resource.id === 'profile-claude-main').quota.fresh, true);
  assert.equal(resources.find(resource => resource.id === 'profile-claude-main').probe.supported, true);
  assert.deepEqual(
    inventory.quotaGroups.find(group => group.id === 'account:anthropic-main').resourceIds.sort(),
    ['profile-claude-backup', 'profile-claude-main'],
  );
  assert.doesNotMatch(JSON.stringify(inventory), /profile-secret-never-leaks/);
});

test('quota freshness uses a short TTL and endpoint quota groups match routing buckets conservatively', async t => {
  const { home, state } = await fixture(t);
  const store = new ProfileStore({ root: state });
  await store.put(profile('fresh-profile', { account: { id: null, maxParallel: 1 } }));
  await store.put(profile('stale-profile', {
    endpoint: 'https://other.anthropic.example/v1',
    account: { id: null, maxParallel: 1 },
    quota: { state: 'available', observedAt: '2026-09-17T00:30:00.000Z', expiresAt: '2026-09-18T00:00:00.000Z', remainingTokens: 10 },
  }));
  await store.put(profile('future-profile', {
    endpoint: 'https://future.anthropic.example/v1',
    account: { id: 'future-account', maxParallel: 1 },
    quota: { state: 'available', observedAt: '2026-09-17T01:10:00.000Z', expiresAt: '2026-09-18T00:00:00.000Z', remainingTokens: 10 },
  }));
  await store.put(profile('account-profile', {
    endpoint: 'https://api.anthropic.example/v1',
    account: { id: 'must-not-be-borrowed', maxParallel: 1 },
  }));

  const service = new ResourceService({
    root: state,
    home,
    environment: {
      PATH: '',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.example/v1?ignored=true',
    },
    profiles: store,
    now: () => Date.parse('2026-09-17T01:00:00.000Z'),
  });
  const inventory = await service.discover({ agents: ['claude'] });

  assert.equal(inventory.resources.find(resource => resource.id === 'profile-fresh-profile').quota.fresh, true);
  assert.equal(inventory.resources.find(resource => resource.id === 'profile-stale-profile').quota.fresh, false);
  assert.equal(inventory.resources.find(resource => resource.id === 'profile-future-profile').quota.fresh, false);
  assert.equal(inventory.resources.find(resource => resource.id === 'profile-fresh-profile').quotaGroup.id, 'endpoint:https://api.anthropic.example');
  assert.equal(inventory.resources.find(resource => resource.id === 'native-claude').quotaGroup.id, 'endpoint:https://api.anthropic.example');
  assert.equal(inventory.resources.find(resource => resource.id === 'native-claude').quotaGroup.source, 'native.endpoint');
  assert.notEqual(inventory.resources.find(resource => resource.id === 'native-claude').quotaGroup.id, 'account:must-not-be-borrowed');
});

test('check mode runs bounded probes, parses strict auth state, and persists sanitized inventory', async t => {
  const { home, state, bin } = await fixture(t);
  await writeExecutable(path.join(bin, 'claude'));
  await writeExecutable(path.join(bin, 'codex'));
  const calls = [];
  const runner = async (argv, options) => {
    calls.push({ argv, options });
    assert.equal(options.timeoutMs, 2000);
    assert.equal(options.maxBytes, 4096);
    const command = path.basename(argv[0]);
    if (command === 'claude' && argv[1] === '--version') return { code: 0, stdout: 'Claude Code 1.2.3\n', stderr: '', truncated: false };
    if (command === 'claude') return { code: 0, stdout: '{"authenticated":true,"email":"secret@example.test"}', stderr: '', truncated: false };
    if (command === 'codex' && argv[1] === '--version') return { code: 0, stdout: 'codex-cli 4.5.6\n', stderr: '', truncated: false };
    if (command === 'codex') return { code: 0, stdout: 'Logged in', stderr: '', truncated: false };
    return { code: 1, stdout: '', stderr: 'secret stderr should not leak', truncated: false };
  };
  const service = new ResourceService({
    root: state,
    home,
    environment: { PATH: bin, ANTHROPIC_API_KEY: 'probe-secret-never-leaks' },
    runner,
    now: () => Date.parse('2026-09-17T01:00:00.000Z'),
  });

  const inventory = await service.discover({ check: true, agents: ['claude', 'codex'] });
  assert.deepEqual(calls.map(call => call.argv), [
    [path.join(bin, 'claude'), '--version'],
    [path.join(bin, 'claude'), 'auth', 'status', '--json'],
    [path.join(bin, 'codex'), '--version'],
    [path.join(bin, 'codex'), 'login', 'status'],
  ]);
  assert.equal(inventory.resources.find(resource => resource.id === 'native-claude').version, '1.2.3');
  assert.equal(inventory.resources.find(resource => resource.id === 'native-claude').authentication.state, 'observed');
  assert.equal(inventory.resources.find(resource => resource.id === 'native-codex').authentication.state, 'observed');
  const persisted = await readFile(path.join(state, 'resources', 'inventory.json'), 'utf8');
  assert.deepEqual(JSON.parse(persisted), inventory);
  assert.doesNotMatch(persisted, /probe-secret-never-leaks|secret@example.test|secret stderr/);

  const listService = new ResourceService({
    root: state,
    home,
    environment: { PATH: bin, ANTHROPIC_API_KEY: 'probe-secret-never-leaks' },
    runner: async () => { throw new Error('plain discovery must reuse persisted version without probing'); },
    now: () => Date.parse('2026-09-17T01:01:00.000Z'),
  });
  const listed = await listService.discover({ agents: ['claude'] });
  const checkedClaude = inventory.resources.find(resource => resource.id === 'native-claude');
  const listedClaude = listed.resources.find(resource => resource.id === 'native-claude');
  assert.equal(listedClaude.version, '1.2.3');
  assert.equal(listedClaude.versionObservation.fresh, true);
  assert.equal(listedClaude.fingerprint, checkedClaude.fingerprint);

  const nullVersionService = new ResourceService({
    root: path.join(state, 'null-version'),
    home,
    environment: { PATH: bin },
    runner: async () => ({ code: 0, stdout: 'no semantic version here\n', stderr: '', truncated: false }),
    now: () => Date.parse('2026-09-17T01:00:00.000Z'),
  });
  const nullVersion = await nullVersionService.discover({ check: true, agents: ['opencode'] });
  const opencode = nullVersion.resources.find(resource => resource.id === 'native-opencode');
  assert.equal(opencode.version, null);
  assert.equal(opencode.versionObservation.fresh, false);

  const staleStored = JSON.parse(persisted);
  staleStored.resources.find(resource => resource.id === 'native-claude').versionObservation.observedAt = '2026-09-15T01:00:00.000Z';
  await writeFile(path.join(state, 'resources', 'inventory.json'), `${JSON.stringify(staleStored, null, 2)}\n`);
  const staleListed = await listService.discover({ agents: ['claude'] });
  assert.equal(staleListed.resources.find(resource => resource.id === 'native-claude').version, null);
});

test('codex partial config parsing changes fingerprint when selected config metadata drifts', async t => {
  const { home, state, bin } = await fixture(t);
  await writeExecutable(path.join(bin, 'codex'));
  await mkdir(path.join(home, '.codex'), { recursive: true });
  const configFile = path.join(home, '.codex', 'config.toml');
  await writeFile(configFile, 'model = "gpt-5.5"\nreasoning_effort = "high"\n[provider.secret]\napi_key = "never-hashed"\n');

  const service = new ResourceService({
    root: state,
    home,
    environment: { PATH: bin },
    now: () => Date.parse('2026-09-17T01:00:00.000Z'),
  });
  const first = await service.discover({ agents: ['codex'] });
  const codex = first.resources.find(resource => resource.id === 'native-codex');
  assert.equal(codex.requestedModel, 'gpt-5.5');
  assert.equal(codex.effort, 'high');
  assert.doesNotMatch(JSON.stringify(first), /never-hashed/);

  const before = await stat(configFile);
  await writeFile(configFile, 'model = "gpt-5.5"\nreasoning_effort = "high"\n# selected metadata changed\n[provider.secret]\napi_key = "new-secret"\n');
  const after = await stat(configFile);
  assert.notEqual(after.size, before.size);
  const second = await service.discover({ agents: ['codex'] });
  assert.notEqual(second.resources[0].fingerprint, codex.fingerprint);
  assert.doesNotMatch(JSON.stringify(second), /new-secret/);
});

test('get selects exact id and reports typed not found errors', async t => {
  const { home, state } = await fixture(t);
  const service = new ResourceService({ root: state, home, environment: { PATH: '' } });
  assert.equal((await service.get('native-pi')).id, 'native-pi');
  await assert.rejects(
    service.get('profile-missing'),
    error => error.code === 'resource_not_found' && error.details.id === 'profile-missing',
  );
});

test('profile resource fingerprints stay stable across repeated checks and list mode reuses observed authentication', async t => {
  const { home, state, bin } = await fixture(t);
  await writeExecutable(path.join(bin, 'claude'));
  const store = new ProfileStore({ root: state });
  await store.put(profile('claude-main', { credential: { type: 'none' }, endpoint: 'http://127.0.0.1:9/v1' }));
  const runner = async (argv) => {
    if (argv[1] === '--version') return { code: 0, stdout: 'Claude Code 1.2.3\n', stderr: '', truncated: false };
    return { code: 0, stdout: '{"authenticated":true}', stderr: '', truncated: false };
  };
  const first = await new ResourceService({ root: state, home, environment: { PATH: bin }, profiles: store, runner, now: () => Date.parse('2026-09-17T01:00:00.000Z') })
    .discover({ check: true, agents: ['claude'] });
  const second = await new ResourceService({ root: state, home, environment: { PATH: bin }, profiles: store, runner, now: () => Date.parse('2026-09-17T01:05:00.000Z') })
    .discover({ check: true, agents: ['claude'] });
  const pick = (inventory, id) => inventory.resources.find(resource => resource.id === id);
  assert.equal(pick(first, 'profile-claude-main').fingerprint, pick(second, 'profile-claude-main').fingerprint);
  assert.equal(pick(second, 'native-claude').authentication.state, 'observed');
  assert.equal(pick(second, 'native-claude').configured, true);

  const listed = await new ResourceService({
    root: state, home, environment: { PATH: bin }, profiles: store,
    runner: async () => { throw new Error('list mode must not probe'); },
    now: () => Date.parse('2026-09-17T01:10:00.000Z'),
  }).discover({ agents: ['claude'] });
  assert.equal(pick(listed, 'native-claude').authentication.state, 'observed');
  assert.equal(pick(listed, 'native-claude').configured, true);
  assert.equal(pick(listed, 'native-claude').fingerprint, pick(second, 'native-claude').fingerprint);
});
