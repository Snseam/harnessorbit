import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayManager } from '../src/gateway/manager.mjs';
import { writeJsonAtomic } from '../src/state.mjs';
import { OrchestratorError } from '../src/errors.mjs';
import { discoverCCSwitch } from '../src/config-sources/cc-switch.mjs';

function baseProfile(id, endpoint, extra = {}) {
  return {
    schemaVersion: 1,
    revision: `rev-${id}`,
    id,
    name: id,
    agent: 'codex',
    model: `${id}-model`,
    protocol: 'openai-responses',
    endpoint,
    credential: { type: 'stored', ref: `stored:${id}-secret` },
    source: { type: 'native' },
    enabled: true,
    capabilities: ['coding'],
    priority: 0,
    account: { id: null, maxParallel: 1 },
    quota: { state: 'unknown', observedAt: null, expiresAt: null, remainingTokens: null },
    quality: null,
    speed: null,
    costPerMillion: null,
    modelMap: { 'client-model': `${id}-mapped` },
    fallbacks: [],
    ...extra,
  };
}

class FakeProfileStore {
  constructor(profiles, { secrets = {} } = {}) {
    this.profiles = new Map(profiles.map((profile) => [profile.id, profile]));
    this.secretValues = secrets;
    this.secrets = [];
    this.sourceChecks = [];
    this.resolveCalls = [];
  }
  async resolve(id) {
    this.resolveCalls.push(id);
    return structuredClone(this.profiles.get(id));
  }
  async resolveProfileSecret(snapshot) {
    this.secrets.push(snapshot.id);
    if (Object.hasOwn(this.secretValues, snapshot.id)) return this.secretValues[snapshot.id];
    return `secret-for-${snapshot.id}-secret`;
  }
  async resolveSecret(ref) {
    this.secrets.push(ref);
    return `secret-for-${ref.split(':').at(-1)}`;
  }
  async assertSourceCurrent(snapshot) {
    this.sourceChecks.push(snapshot.id);
  }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.kills = [];
  }
  kill(signal) {
    this.kills.push(signal);
    this.emit('exit', null, signal);
    return true;
  }
  unref() {}
}

async function withTemp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'cao-gateway-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function fakeUpstream(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body = null;
    if (bodyText) { try { body = JSON.parse(bodyText); } catch { body = bodyText; } }
    const record = { method: req.method, url: req.url, headers: req.headers, body };
    requests.push(record);
    await handler(req, res, record, requests.length);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  return {
    endpoint,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function createCCSwitchDatabase(directory) {
  const sqlite = await import('node:sqlite');
  const db = new sqlite.DatabaseSync(join(directory, 'cc-switch.sqlite'));
  db.exec(`
    PRAGMA user_version = 18;
    CREATE TABLE providers(
      id TEXT PRIMARY KEY,
      app_type TEXT NOT NULL,
      name TEXT NOT NULL,
      settings_config TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      meta TEXT NOT NULL,
      is_current INTEGER DEFAULT 0
    );
    CREATE TABLE proxy_config(
      app_type TEXT PRIMARY KEY,
      listen_address TEXT,
      listen_port INTEGER,
      enabled INTEGER DEFAULT 0,
      proxy_enabled INTEGER DEFAULT 0,
      auto_failover_enabled INTEGER DEFAULT 0,
      live_takeover_active INTEGER DEFAULT 0
    );
  `);
  db.prepare(`
    INSERT INTO providers(id, app_type, name, settings_config, provider_type, meta, is_current)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'claude-main',
    'claude',
    'Claude Main',
    JSON.stringify({
      env: {
        ANTHROPIC_API_KEY: 'synthetic-token-not-selected',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/v1',
        ANTHROPIC_MODEL: 'claude-synthetic',
      },
    }),
    'anthropic',
    '{}',
    1,
  );
  db.close();
}

async function mutateCCSwitchModel(directory, model) {
  const sqlite = await import('node:sqlite');
  const db = new sqlite.DatabaseSync(join(directory, 'cc-switch.sqlite'));
  db.prepare('UPDATE providers SET settings_config = ? WHERE id = ?').run(
    JSON.stringify({
      env: {
        ANTHROPIC_API_KEY: 'synthetic-token-not-selected',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/v1',
        ANTHROPIC_MODEL: model,
      },
    }),
    'claude-main',
  );
  db.close();
}

async function readToken(handle) {
  return (await readFile(handle.tokenFile, 'utf8')).trim();
}

async function waitForIdle(manager, id) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const status = await manager.status(id);
    if (status?.health?.activeRequests === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startGateway(root, profiles) {
  const store = new FakeProfileStore(profiles);
  const manager = new GatewayManager({ root, profiles: store });
  const handle = await manager.start({
    id: 'gw1',
    profileIds: profiles.map((profile) => profile.id),
    requireCapabilities: ['coding'],
  });
  return { store, manager, handle, token: await readToken(handle) };
}

test('Gateway accepts Anthropic native x-api-key local token but rejects missing or wrong caller auth', async () => {
  await withTemp(async (root) => {
    const upstream = await fakeUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'anthropic-ok' }));
    });
    try {
      const profile = baseProfile('claude', upstream.endpoint, {
        agent: 'claude',
        protocol: 'anthropic',
        model: 'claude-model',
        modelMap: { 'client-model': 'claude-mapped' },
      });
      const { manager, handle, token } = await startGateway(root, [profile]);
      const missing = await fetch(`${handle.endpoint}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'client-model', messages: [] }),
      });
      assert.equal(missing.status, 401);

      const wrong = await fetch(`${handle.endpoint}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': 'wrong-local-token', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'client-model', messages: [] }),
      });
      assert.equal(wrong.status, 401);

      const ok = await fetch(`${handle.endpoint}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': token, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'client-model', messages: [] }),
      });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).id, 'anthropic-ok');
      assert.equal(upstream.requests.length, 1);
      assert.equal(upstream.requests[0].url, '/v1/messages');
      assert.equal(upstream.requests[0].body.model, 'claude-mapped');
      assert.equal(upstream.requests[0].headers['x-api-key'], 'secret-for-claude-secret');

      const privateHandle = JSON.parse(await readFile(join(root, 'gateways', 'gw1', 'handle.json'), 'utf8'));
      const ownerOnly = await fetch(`${handle.endpoint}/v1/messages`, {
        method: 'POST',
        headers: { 'x-cao-owner-nonce': privateHandle.ownerNonce, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'client-model', messages: [] }),
      });
      assert.equal(ownerOnly.status, 401);
      await waitForIdle(manager, 'gw1');
      await manager.stop('gw1');
    } finally {
      await upstream.close();
    }
  });
});

test('GatewayManager starts an owned authenticated relay with private token and sanitized config', async () => {
  await withTemp(async (root) => {
    const upstream = await fakeUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'ok' }));
    });
    try {
      const { store, manager, handle, token } = await startGateway(root, [baseProfile('p1', upstream.endpoint)]);
      assert.match(handle.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(handle.protocol, 'openai-responses');
      assert.ok(handle.tokenFile.endsWith('/token'));
      assert.equal(Object.hasOwn(handle, 'ownerNonce'), false);
      assert.notEqual(token.length, 0);
      assert.deepEqual(store.sourceChecks, ['p1']);
      assert.deepEqual(store.secrets, ['p1']);

      const mode = (await stat(handle.tokenFile)).mode & 0o777;
      assert.equal(mode, 0o600);
      const configText = await readFile(handle.configFile, 'utf8');
      assert.doesNotMatch(configText, /secret-for-p1-secret/);
      const config = JSON.parse(configText);
      assert.equal(config.profiles[0].credential.ref, 'stored:p1-secret');

      const healthWithoutToken = await fetch(`${handle.endpoint}/__cao/health`);
      assert.equal(healthWithoutToken.status, 401);
      const tokenHealth = await fetch(`${handle.endpoint}/__cao/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(tokenHealth.status, 200);
      const tokenHealthBody = await tokenHealth.json();
      assert.equal(Object.hasOwn(tokenHealthBody, 'ownerNonce'), false);
      assert.equal(typeof tokenHealthBody.ownerProof, 'string');
      const health = await manager.status('gw1');
      assert.equal(health.running, true);
      assert.equal(Object.hasOwn(health, 'ownerNonce'), false);
      assert.equal(Object.hasOwn(health.health, 'ownerNonce'), false);
      assert.equal(Object.hasOwn(health.health, 'ownerProof'), false);
      assert.deepEqual(store.resolveCalls, ['p1']);
      await waitForIdle(manager, 'gw1');
      await manager.stop('gw1');
    } finally {
      await upstream.close();
    }
  });
});

test('GatewayManager isolates profile secret env names and rejects header-unsafe secrets', async () => {
  await withTemp(async (root) => {
    const first = await fakeUpstream((req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'retry' }));
    });
    const second = await fakeUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'ok' }));
    });
    try {
      const profiles = [baseProfile('p-a', first.endpoint), baseProfile('p_a', second.endpoint)];
      const { manager, handle, token } = await startGateway(root, profiles);
      const response = await fetch(`${handle.endpoint}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'client-model', input: 'hello' }),
      });
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(first.requests[0].headers.authorization, 'Bearer secret-for-p-a-secret');
      assert.equal(second.requests[0].headers.authorization, 'Bearer secret-for-p_a-secret');
      await waitForIdle(manager, 'gw1');
      await manager.stop('gw1');

      const badManager = new GatewayManager({
        root,
        profiles: new FakeProfileStore([baseProfile('bad-secret', second.endpoint)], {
          secrets: { 'bad-secret': 'secret-with-crlf\r\n' },
        }),
      });
      await assert.rejects(
        badManager.start({ id: 'bad-secret-gw', profileIds: ['bad-secret'] }),
        (error) => error instanceof OrchestratorError && error.code === 'gateway_secret_unavailable',
      );
    } finally {
      await first.close();
      await second.close();
    }
  });
});

test('Gateway rewrites models, strips caller auth headers, and appends /v1 paths correctly', async () => {
  await withTemp(async (root) => {
    const upstream = await fakeUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'ok' }));
    });
    try {
      const { manager, handle, token } = await startGateway(root, [baseProfile('p1', upstream.endpoint)]);
      const response = await fetch(`${handle.endpoint}/v1/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-api-key': 'caller-secret',
          'proxy-authorization': 'caller-proxy-secret',
          connection: 'keep-alive',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'client-model', input: 'hello' }),
      });
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(upstream.requests.length, 1);
      assert.equal(upstream.requests[0].url, '/v1/responses');
      assert.equal(upstream.requests[0].body.model, 'p1-mapped');
      assert.equal(upstream.requests[0].headers.authorization, 'Bearer secret-for-p1-secret');
      assert.equal(upstream.requests[0].headers['x-api-key'], undefined);
      assert.equal(upstream.requests[0].headers['proxy-authorization'], undefined);

      const privateHandle = JSON.parse(await readFile(join(root, 'gateways', 'gw1', 'handle.json'), 'utf8'));
      const ownerOnly = await fetch(`${handle.endpoint}/v1/responses`, {
        method: 'POST',
        headers: { 'x-cao-owner-nonce': privateHandle.ownerNonce, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'client-model', input: 'owner should not route' }),
      });
      assert.equal(ownerOnly.status, 401);
      await waitForIdle(manager, 'gw1');
      await manager.stop('gw1');
    } finally {
      await upstream.close();
    }
  });
});

test('Gateway falls back only before delivering a response', async () => {
  await withTemp(async (root) => {
    const first = await fakeUpstream((req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'temporary' }));
    });
    const second = await fakeUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'fallback-ok' }));
    });
    try {
      const profiles = [baseProfile('p1', first.endpoint), baseProfile('p2', second.endpoint)];
      const { manager, handle, token } = await startGateway(root, profiles);
      const response = await fetch(`${handle.endpoint}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'client-model', input: 'hello' }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).id, 'fallback-ok');
      assert.equal(first.requests.length, 1);
      assert.equal(second.requests.length, 1);
      const log = await readFile(handle.logFile, 'utf8');
      assert.match(log, /fallback_selected/);
      assert.doesNotMatch(log, /hello/);
      await waitForIdle(manager, 'gw1');
      await manager.stop('gw1');
    } finally {
      await first.close();
      await second.close();
    }
  });
});

test('Gateway falls back on pre-connect network failure only before upstream can receive the request', async () => {
  await withTemp(async (root) => {
    const second = await fakeUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'fallback-after-connect-failure' }));
    });
    try {
      const profiles = [
        baseProfile('p1', 'http://127.0.0.1:9/v1'),
        baseProfile('p2', second.endpoint),
      ];
      const { manager, handle, token } = await startGateway(root, profiles);
      const response = await fetch(`${handle.endpoint}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'client-model', input: 'safe to retry' }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).id, 'fallback-after-connect-failure');
      assert.equal(second.requests.length, 1);
      const log = await readFile(handle.logFile, 'utf8');
      assert.match(log, /fallback_selected/);
      await waitForIdle(manager, 'gw1');
      await manager.stop('gw1');
    } finally {
      await second.close();
    }
  });
});

test('Gateway blocks fallback when upstream disconnects after receiving the request', async () => {
  await withTemp(async (root) => {
    const first = await fakeUpstream((req) => {
      req.socket.destroy();
    });
    const second = await fakeUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'must-not-run' }));
    });
    try {
      const profiles = [baseProfile('p1', first.endpoint), baseProfile('p2', second.endpoint)];
      const { manager, handle, token } = await startGateway(root, profiles);
      const response = await fetch(`${handle.endpoint}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'client-model', input: 'maybe created upstream' }),
      });
      assert.equal(response.status, 502);
      const body = await response.json();
      assert.equal(body.error.code, 'upstream_result_uncertain');
      assert.deepEqual(body.error.tried, ['p1']);
      assert.equal(first.requests.length, 1);
      assert.equal(second.requests.length, 0);
      const log = await readFile(handle.logFile, 'utf8');
      assert.match(log, /fallback_blocked_after_upstream_write/);
      assert.doesNotMatch(log, /maybe created upstream/);
      await waitForIdle(manager, 'gw1');
      await manager.stop('gw1');
    } finally {
      await first.close();
      await second.close();
    }
  });
});

test('Gateway does not fallback after streaming response delivery begins', async () => {
  await withTemp(async (root) => {
    const first = await fakeUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      res.end();
    });
    const second = await fakeUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'should-not-run' }));
    });
    try {
      const { manager, handle, token } = await startGateway(root, [baseProfile('p1', first.endpoint), baseProfile('p2', second.endpoint)]);
      await fetch(`${handle.endpoint}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'client-model', stream: true }),
      }).then(async (response) => response.text()).catch(() => {});
      assert.equal(first.requests.length, 1);
      assert.equal(second.requests.length, 0);
      await waitForIdle(manager, 'gw1');
      await manager.stop('gw1');
    } finally {
      await first.close();
      await second.close();
    }
  });
});

test('Gateway blocks fallback across endpoints for previous_response_id requests', async () => {
  await withTemp(async (root) => {
    const first = await fakeUpstream((req, res) => {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'quota' }));
    });
    const second = await fakeUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'should-not-run' }));
    });
    try {
      const { manager, handle, token } = await startGateway(root, [baseProfile('p1', first.endpoint), baseProfile('p2', second.endpoint)]);
      const response = await fetch(`${handle.endpoint}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'client-model', previous_response_id: 'resp_1', input: 'continue' }),
      });
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.error.code, 'stateful_fallback_blocked');
      assert.equal(first.requests.length, 1);
      assert.equal(second.requests.length, 0);
      await waitForIdle(manager, 'gw1');
      await manager.stop('gw1');
    } finally {
      await first.close();
      await second.close();
    }
  });
});

test('Gateway validates profile compatibility and loopback credential-none rule', async () => {
  await withTemp(async (root) => {
    const upstream = await fakeUpstream((req, res) => res.end('{}'));
    try {
      const manager = new GatewayManager({
        root,
        profiles: new FakeProfileStore([
          baseProfile('p1', upstream.endpoint, { credential: { type: 'none' } }),
          baseProfile('p2', upstream.endpoint, { protocol: 'openai-chat' }),
        ]),
      });
      await assert.rejects(
        manager.start({ id: 'bad1', profileIds: ['p1', 'p2'] }),
        (error) => error instanceof OrchestratorError && error.code === 'invalid_gateway_profile',
      );

      const remoteManager = new GatewayManager({
        root,
        profiles: new FakeProfileStore([
          baseProfile('remote', 'https://example.invalid/v1', { credential: { type: 'none' } }),
        ]),
      });
      await assert.rejects(
        remoteManager.start({ id: 'bad2', profileIds: ['remote'] }),
        (error) => error instanceof OrchestratorError && error.code === 'invalid_gateway_profile',
      );

      const unavailableManager = new GatewayManager({
        root,
        profiles: new FakeProfileStore([
          baseProfile('disabled', upstream.endpoint, { enabled: false }),
          baseProfile('quota', upstream.endpoint, { quota: { state: 'exhausted', observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() } }),
        ]),
      });
      await assert.rejects(
        unavailableManager.start({ id: 'disabled-gw', profileIds: ['disabled'] }),
        (error) => error instanceof OrchestratorError && error.code === 'invalid_gateway_profile',
      );
      await assert.rejects(
        unavailableManager.start({ id: 'quota-gw', profileIds: ['quota'] }),
        (error) => error instanceof OrchestratorError && error.code === 'invalid_gateway_profile',
      );

      const staleQuotaManager = new GatewayManager({
        root,
        profiles: new FakeProfileStore([
          baseProfile('stale-quota', upstream.endpoint, {
            quota: {
              state: 'exhausted',
              observedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
              expiresAt: null,
              remainingTokens: 0,
            },
          }),
        ]),
      });
      const staleHandle = await staleQuotaManager.start({ id: 'stale-quota-gw', profileIds: ['stale-quota'] });
      await waitForIdle(staleQuotaManager, 'stale-quota-gw');
      assert.equal((await staleQuotaManager.stop(staleHandle.id)).running, false);
    } finally {
      await upstream.close();
    }
  });
});

test('Gateway sanitizes non-2xx upstream response bodies while preserving retry-after', async () => {
  await withTemp(async (root) => {
    const upstream = await fakeUpstream((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json', 'retry-after': '7' });
      res.end(JSON.stringify({ error: 'leaked-api-key secret-for-p1-secret' }));
    });
    try {
      const { manager, handle, token } = await startGateway(root, [baseProfile('p1', upstream.endpoint)]);
      const response = await fetch(`${handle.endpoint}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'client-model', input: 'hello' }),
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('retry-after'), '7');
      const text = await response.text();
      assert.doesNotMatch(text, /leaked-api-key|secret-for-p1-secret/);
      const body = JSON.parse(text);
      assert.equal(body.error.code, 'upstream_failed');
      assert.equal(upstream.requests.length, 1);
      const log = await readFile(handle.logFile, 'utf8');
      assert.doesNotMatch(log, /leaked-api-key|secret-for-p1-secret/);
      await waitForIdle(manager, 'gw1');
      await manager.stop('gw1');
    } finally {
      await upstream.close();
    }
  });
});

test('GatewayManager refuses stop while active attempts reference the gateway', async () => {
  await withTemp(async (root) => {
    const upstream = await fakeUpstream((req, res) => res.end('{}'));
    try {
      const { manager } = await startGateway(root, [baseProfile('p1', upstream.endpoint)]);
      const runDirectory = join(root, 'runs', 'run1');
      await mkdir(runDirectory, { recursive: true });
      const run = {
        id: 'run1',
        tasks: {
          task1: {
            definition: { id: 'task1' },
            currentAttempt: 'a1',
            attempts: [{ id: 'a1', gatewayId: 'gw1', workerClosed: false }],
          },
        },
      };
      await writeJsonAtomic(join(runDirectory, 'run.json'), run);
      await assert.rejects(
        manager.stop('gw1'),
        (error) => error instanceof OrchestratorError && error.code === 'gateway_busy',
      );
      run.tasks.task1.attempts[0].workerClosed = true;
      await writeJsonAtomic(join(runDirectory, 'run.json'), run);
      await waitForIdle(manager, 'gw1');
      assert.equal((await manager.stop('gw1')).running, false);
    } finally {
      await upstream.close();
    }
  });
});

test('GatewayManager fails fast when the spawned server exits before ready and preserves startup evidence', async () => {
  await withTemp(async (root) => {
    const upstream = await fakeUpstream((req, res) => res.end('{}'));
    try {
      const child = new FakeChild();
      const manager = new GatewayManager({
        root,
        profiles: new FakeProfileStore([baseProfile('p1', upstream.endpoint)]),
        spawnProcess: () => {
          queueMicrotask(() => child.emit('exit', 17, null));
          return child;
        },
        startupTimeoutMs: 1000,
      });
      await assert.rejects(
        manager.start({ id: 'spawn-exit', profileIds: ['p1'] }),
        (error) => error instanceof OrchestratorError
          && error.code === 'gateway_start_failed'
          && error.details.code === 17,
      );
      assert.deepEqual(child.kills, []);
      const failure = JSON.parse(await readFile(join(root, 'gateways', 'spawn-exit', 'startup-failure.json'), 'utf8'));
      assert.equal(failure.error.code, 'gateway_start_failed');
      assert.deepEqual(failure.error.exit, { code: 17, signal: null });
    } finally {
      await upstream.close();
    }
  });
});

test('GatewayManager terminates only the controlled child on startup timeout', async () => {
  await withTemp(async (root) => {
    const upstream = await fakeUpstream((req, res) => res.end('{}'));
    try {
      const child = new FakeChild();
      const manager = new GatewayManager({
        root,
        profiles: new FakeProfileStore([baseProfile('p1', upstream.endpoint)]),
        spawnProcess: () => child,
        startupTimeoutMs: 80,
      });
      await assert.rejects(
        manager.start({ id: 'timeout-gw', profileIds: ['p1'] }),
        (error) => error instanceof OrchestratorError && error.code === 'gateway_start_timeout',
      );
      assert.deepEqual(child.kills, ['SIGTERM']);
      const failure = JSON.parse(await readFile(join(root, 'gateways', 'timeout-gw', 'startup-failure.json'), 'utf8'));
      assert.equal(failure.error.code, 'gateway_start_timeout');
      assert.deepEqual(failure.error.exit, { code: null, signal: 'SIGTERM' });
    } finally {
      await upstream.close();
    }
  });
});

test('GatewayManager refuses to reuse a partial immutable gateway directory', async () => {
  await withTemp(async (root) => {
    const upstream = await fakeUpstream((req, res) => res.end('{}'));
    try {
      await mkdir(join(root, 'gateways', 'partial-gw'), { recursive: true });
      const manager = new GatewayManager({
        root,
        profiles: new FakeProfileStore([baseProfile('p1', upstream.endpoint)]),
      });
      await assert.rejects(
        manager.start({ id: 'partial-gw', profileIds: ['p1'] }),
        (error) => error instanceof OrchestratorError && error.code === 'gateway_exists',
      );
    } finally {
      await upstream.close();
    }
  });
});

test('GatewayManager starts from immutable supplied snapshots without re-resolving profiles', async () => {
  await withTemp(async (root) => {
    const upstream = await fakeUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'ok' }));
    });
    try {
      const snapshot = baseProfile('p1', upstream.endpoint, {
        model: 'snapshot-fixed-model',
        modelMap: {},
      });
      const store = new FakeProfileStore([
        baseProfile('p1', upstream.endpoint, {
          model: 'mutated-store-model',
          modelMap: {},
        }),
      ]);
      const manager = new GatewayManager({ root, profiles: store });
      const handle = await manager.start({
        id: 'snapshot-gw',
        profileIds: ['p1'],
        snapshots: [snapshot],
        requireCapabilities: ['coding'],
      });
      const token = await readToken(handle);
      const response = await fetch(`${handle.endpoint}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'client-model', input: 'hello' }),
      });
      assert.equal(response.status, 200);
      await response.text();
      assert.deepEqual(store.resolveCalls, []);
      assert.deepEqual(store.sourceChecks, ['p1']);
      assert.deepEqual(store.secrets, ['p1']);
      assert.equal(upstream.requests[0].body.model, 'snapshot-fixed-model');
      await waitForIdle(manager, 'snapshot-gw');
      await manager.stop('snapshot-gw');
    } finally {
      await upstream.close();
    }
  });
});

test('GatewayManager serializes concurrent starts for the same gateway id', async () => {
  await withTemp(async (root) => {
    const upstream = await fakeUpstream((req, res) => res.end('{}'));
    try {
      const store = new FakeProfileStore([baseProfile('p1', upstream.endpoint)]);
      const manager = new GatewayManager({ root, profiles: store });
      const starts = await Promise.allSettled([
        manager.start({ id: 'same-id', profileIds: ['p1'], requireCapabilities: ['coding'] }),
        manager.start({ id: 'same-id', profileIds: ['p1'], requireCapabilities: ['coding'] }),
      ]);
      const fulfilled = starts.filter((result) => result.status === 'fulfilled');
      const rejected = starts.filter((result) => result.status === 'rejected');
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].reason.code, 'gateway_exists');
      await waitForIdle(manager, 'same-id');
      await manager.stop('same-id');
    } finally {
      await upstream.close();
    }
  });
});

test('GatewayManager requires explicit allowShared for shared source reuse and checks fallback capabilities', async () => {
  await withTemp(async (root) => {
    const upstream = await fakeUpstream((req, res) => res.end('{}'));
    try {
      const shared = baseProfile('shared', upstream.endpoint, {
        credential: { type: 'none' },
        source: { type: 'cc-switch', route: 'active-proxy', allowShared: false },
      });
      const manager = new GatewayManager({ root, profiles: new FakeProfileStore([shared]) });
      await assert.rejects(
        manager.start({ id: 'shared-denied', profileIds: ['shared'], requireCapabilities: ['coding'] }),
        (error) => error instanceof OrchestratorError && error.code === 'invalid_gateway_profile',
      );
      const handle = await manager.start({
        id: 'shared-allowed',
        profileIds: ['shared'],
        requireCapabilities: ['coding'],
        allowShared: true,
      });
      await waitForIdle(manager, 'shared-allowed');
      await manager.stop('shared-allowed');

      const sourceAllowSharedManager = new GatewayManager({
        root,
        profiles: new FakeProfileStore([
          baseProfile('source-shared', upstream.endpoint, {
            credential: { type: 'none' },
            source: { type: 'external-gateway', allowShared: true },
          }),
        ]),
      });
      await assert.rejects(
        sourceAllowSharedManager.start({ id: 'source-shared-denied', profileIds: ['source-shared'] }),
        (error) => error instanceof OrchestratorError && error.code === 'invalid_gateway_profile',
      );

      const missingCapabilityManager = new GatewayManager({
        root,
        profiles: new FakeProfileStore([
          baseProfile('p1', upstream.endpoint),
          baseProfile('p2', upstream.endpoint, { capabilities: [] }),
        ]),
      });
      await assert.rejects(
        missingCapabilityManager.start({
          id: 'missing-capability',
          profileIds: ['p1', 'p2'],
          requireCapabilities: ['coding'],
        }),
        (error) => error instanceof OrchestratorError && error.code === 'invalid_gateway_profile',
      );
    } finally {
      await upstream.close();
    }
  });
});

test('Gateway rejects the next request when a CC Switch source snapshot drifts while running', async () => {
  await withTemp(async (root) => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'cao-gateway-cc-switch-'));
    const upstream = await fakeUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'should-not-run' }));
    });
    try {
      await createCCSwitchDatabase(sourceDirectory);
      const inventory = await discoverCCSwitch({ directory: sourceDirectory });
      const provider = inventory.providers.find((row) => row.providerId === 'claude-main' && row.app === 'claude');
      const profile = baseProfile('p1', upstream.endpoint, {
        source: {
          type: 'cc-switch',
          directory: sourceDirectory,
          providerId: 'claude-main',
          app: 'claude',
          fingerprint: provider.fingerprint,
          route: 'direct',
          allowShared: false,
        },
      });
      const { manager, handle, token } = await startGateway(root, [profile]);
      await mutateCCSwitchModel(sourceDirectory, 'gpt-public-config-changed');
      const response = await fetch(`${handle.endpoint}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'client-model', input: 'hello' }),
      });
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.error.code, 'profile_source_drift');
      assert.equal(upstream.requests.length, 0);
      await waitForIdle(manager, 'gw1');
      await manager.stop('gw1');
    } finally {
      await upstream.close();
      await rm(sourceDirectory, { recursive: true, force: true });
    }
  });
});

test('Gateway forwards a non-JSON POST body instead of failing with gateway_exception', async () => {
  await withTemp(async (root) => {
    const upstream = await fakeUpstream((req, res) => {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
    });
    try {
      const { manager, handle, token } = await startGateway(root, [baseProfile('p1', upstream.endpoint)]);
      const response = await fetch(`${handle.endpoint}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
        body: 'not json at all',
      });
      assert.equal(response.status, 400);
      await response.text();
      const log = await readFile(join(root, 'gateways', 'gw1', 'gateway.log'), 'utf8');
      assert.doesNotMatch(log, /gateway_exception/);
      assert.match(log, /"resolvedModel":null/);
      await waitForIdle(manager, 'gw1');
      await manager.stop('gw1');
    } finally {
      await upstream.close();
    }
  });
});
