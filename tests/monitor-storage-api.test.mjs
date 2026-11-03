import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { main } from '../bin/cao.mjs';
import { startMonitorServer } from '../src/monitor/server.mjs';

const id = 'abbc0000000000000000000000000001';
const planId = '12345678-1234-4123-8123-000000000001';

async function fixture(t, overrides = {}) {
  const calls = [];
  const storageService = {
    async audit() { calls.push('audit'); return { items: [] }; },
    async plan(value) { calls.push(['plan', value]); return { id: planId }; },
    async execute(value) { calls.push(['execute', value]); return { executed: true }; },
  };
  const service = await startMonitorServer({ token: 'read', ownerToken: 'owner', storageToken: 'manage', all: true, storageService, ...overrides });
  t.after(service.close);
  const request = (route, token, body, headers = {}) => fetch(service.endpoint + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...headers },
    body,
  });
  return { calls, request, endpoint: service.endpoint };
}

test('storage routes enforce all scope and separate read, management, and owner privileges', async t => {
  const scoped = await fixture(t, { all: false });
  assert.equal((await scoped.request('/api/storage', 'read')).status, 403);
  assert.equal((await scoped.request('/api/storage/execute', 'manage', JSON.stringify({ planId }))).status, 403);
  assert.deepEqual(scoped.calls, []);
  const view = await fixture(t, { storageToken: null });
  assert.deepEqual(await (await view.request('/api/storage', 'read')).json(), { items: [] });
  assert.equal((await view.request('/api/storage/plan', 'read', JSON.stringify({ id }))).status, 403);
  const { calls, request, endpoint } = await fixture(t);
  for (const wrong of ['manage', 'owner']) assert.equal((await request('/api/storage', wrong)).status, 401);
  for (const wrong of ['read', 'owner']) {
    assert.equal((await request('/api/storage/plan', wrong, JSON.stringify({ id }))).status, 401);
    assert.equal((await request('/api/storage/execute', wrong, JSON.stringify({ planId }))).status, 401);
  }
  assert.equal((await request('/_cao/stop', 'manage', '')).status, 401);
  assert.equal((await request('/api/storage/execute', 'manage')).status, 405);
  assert.equal((await request('/api/storage', 'manage', '{}')).status, 405);
  assert.deepEqual(await (await request('/api/storage/plan', 'manage', JSON.stringify({ id }), { origin: endpoint })).json(), { id: planId });
  assert.deepEqual(await (await request('/api/storage/execute', 'manage', JSON.stringify({ planId }))).json(), { executed: true });
  assert.deepEqual(calls, [['plan', id], ['execute', planId]]);
});

test('rejects cross-origin writes, malformed JSON, caller paths, unexpected fields, and excessive bodies', async t => {
  const { request, calls } = await fixture(t);
  const post = (body, headers) => request('/api/storage/plan', 'manage', body, headers);
  const payload = JSON.stringify({ id });
  assert.equal((await post(payload, { origin: 'https://example.org' })).status, 403);
  assert.equal((await post(payload, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post(payload, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await request('/api/storage/plan?token=manage', 'manage', payload)).status, 400);
  for (const body of ['null', '{}', '{', '{"id":"../outside"}', JSON.stringify({ id, force: true })]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await post(' '.repeat(2048))).status, 413);
  assert.deepEqual(calls, []);
});

test('sanitizes service failures and returns conflict and expired plan statuses', async t => {
  const service = {
    async audit() { throw Error('SECRET path'); },
    async plan() { throw Object.assign(Error('SECRET path'), { code: 'storage_changed' }); },
    async execute() { throw Object.assign(Error('SECRET path'), { code: 'storage_plan_expired' }); },
  };
  const { request } = await fixture(t, { storageService: service });
  const cases = [
    [await request('/api/storage', 'read'), 503, 'storage_unavailable'],
    [await request('/api/storage/plan', 'manage', JSON.stringify({ id })), 409, 'storage_changed'],
    [await request('/api/storage/execute', 'manage', JSON.stringify({ planId })), 410, 'storage_plan_expired'],
  ];
  for (const [response, status, error] of cases) {
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
  }
});

test('CLI management start is explicit and only start returns a management credential', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-storage-cli-'));
  const run = (action, ...args) => main(['monitor', action, '--state-dir', root, ...args]);
  t.after(async () => { await run('stop'); await fs.rm(root, { force: true, recursive: true }); });
  await assert.rejects(run('start', '--manage-storage'), /requires --all/);
  const args = ['--all', '--manage-storage', '--codex-home', path.join(root, 'codex'), '--claude-home', path.join(root, 'claude')];
  const started = await run('start', ...args);
  const configFile = path.join(root, 'monitors', 'default', 'config.json');
  const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal((await fs.stat(configFile)).mode & 0o777, 0o600);
  const url = new URL(started.url);
  const fragment = new URLSearchParams(url.hash.slice(1));
  assert.equal(url.pathname, '/storage.html');
  assert.equal(url.search, '');
  assert.equal(fragment.get('token'), config.token);
  assert.equal(fragment.get('storageToken'), config.storageToken);
  assert.equal(new Set([config.token, config.storageToken, config.ownerToken]).size, 3);
  assert.equal(JSON.stringify(started).includes(config.ownerToken), false);
  const audit = await fetch(started.endpoint + '/api/storage', { headers: { authorization: 'Bearer ' + config.token } });
  assert.equal(audit.status, 200);
  assert.ok(Array.isArray((await audit.json()).items));
  const status = JSON.stringify(await run('status'));
  assert.equal(status.includes(config.storageToken), false);
  assert.equal(status.includes(config.ownerToken), false);
  const reused = await run('start', ...args);
  assert.equal(reused.reused, true);
  assert.equal(reused.url, started.url);
  await assert.rejects(run('start', ...args.filter(x => x !== '--manage-storage')), /another scope/);
});
