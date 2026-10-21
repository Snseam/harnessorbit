import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Orchestrator } from '../src/orchestrator.mjs';
import { PrincipalStore } from '../src/access/principals.mjs';
import { AccessService } from '../src/access/service.mjs';
import { startAccessServer, TOOLS } from '../src/access/server.mjs';
import { parseArgs } from '../bin/cao.mjs';
import { fixture, FakeHerdr } from './helpers.mjs';

const checks = [{ name: 'math', argv: [process.execPath, '--test', 'tests/math.test.mjs'], timeoutMs: 10000 }];
const job = (project, extra = {}) => ({
  idempotencyKey: 'req-1', project, objective: 'Fix add to add its two inputs; preserve the existing tests.',
  context: 'The caller noticed add() subtracts. Tests already encode the expected behaviour.', allowedPaths: ['src/math.mjs'], checks, ...extra,
});

async function setup(t, runtime = new FakeHerdr()) {
  const f = await fixture(); t.after(f.remove);
  f.project = await fs.realpath(f.project);
  const orchestrator = new Orchestrator({ stateRoot: f.stateRoot, herdr: runtime });
  const principals = new PrincipalStore({ root: f.stateRoot });
  const created = await principals.create({ id: 'grok', projects: [f.project], agents: ['claude', 'codex'] });
  const service = new AccessService({ root: f.stateRoot, orchestrator, principals, driver: 'inline' });
  return { ...f, orchestrator, principals, service, principal: created.principal, token: created.token, runtime };
}

async function rpc(endpoint, body, { token = null, method = 'POST' } = {}) {
  const response = await fetch(endpoint, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: method === 'POST' ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('principal tokens are shown once, stored hashed, and authenticate in constant form', async t => {
  const { principals, principal, token, stateRoot } = await setup(t);
  assert.match(token, /^hoa_/);
  assert.equal(principal.permissions.integrate, false);
  assert.equal(principal.tokenHash, undefined);
  const stored = JSON.parse(await fs.readFile(path.join(stateRoot, 'access', 'principals.json'), 'utf8'));
  assert.equal(stored.principals.grok.tokenHash.length, 64);
  assert.ok(!JSON.stringify(stored).includes(token));
  assert.equal((await principals.authenticate(token)).id, 'grok');
  assert.equal(await principals.authenticate(`${token}x`), null);
  assert.equal(await principals.authenticate('hoa_short'), null);
  assert.equal(await principals.authenticate(null), null);
  await assert.rejects(principals.create({ id: 'grok', projects: [principal.projects[0]] }), e => e.code === 'principal_exists');
  await assert.rejects(principals.create({ id: 'bad', projects: ['relative/path'] }), e => e.code === 'invalid_principal');
  assert.equal(await principals.remove('grok'), true);
  assert.equal(await principals.authenticate(token), null);
});

test('submit dispatches one isolated job and the same idempotency key returns it instead of a duplicate', async t => {
  const { service, principal, project, runtime, orchestrator } = await setup(t);
  const first = await service.submit(principal, job(project));
  assert.equal(first.state, 'running');
  assert.equal(first.job.reused, false);
  assert.equal(first.attempt.status, 'running');
  assert.equal(first.next_action, 'status');
  assert.equal(first.attention_pending, 0);
  const again = await service.submit(principal, job(project, { objective: 'Something else entirely' }));
  assert.equal(again.job.id, first.job.id);
  assert.equal(again.job.reused, true);
  assert.equal(runtime.starts, 1);
  const run = await orchestrator.status(first.job.runId);
  assert.equal(run.project, project);
  assert.equal(run.tasks[0].isolation, 'worktree');
  assert.match((await fs.readFile(path.join(project, 'src/math.mjs'), 'utf8')), /a - b/);
});

test('status advances collection and verification and reports an integrate attention item', async t => {
  const { service, principal, project } = await setup(t);
  const submitted = await service.submit(principal, job(project));
  const status = await service.status(principal, { jobId: submitted.job.id });
  assert.equal(status.state, 'attention');
  assert.equal(status.attempt.status, 'accepted');
  assert.equal(status.attempt.verification.checks[0].status, 'passed');
  assert.deepEqual(status.attempt.changedPaths, ['src/math.mjs']);
  assert.equal(status.attention_pending, 1);
  assert.equal(status.attention[0].kind, 'integrate');
  assert.deepEqual(status.attention[0].target, ['src/math.mjs']);
  assert.equal(status.next_action, 'approve');
  assert.match(status.attention[0].how, /host operator/);
  assert.match(await fs.readFile(path.join(project, 'src/math.mjs'), 'utf8'), /a - b/, 'nothing reaches the checkout without integration');
  const quiet = await service.status(principal, { jobId: submitted.job.id, advance: false });
  assert.equal(quiet.state, 'attention');
});

test('submit enforces principal scope and the request contract', async t => {
  const { service, principal, project, base } = await setup(t);
  const other = path.join(base, 'elsewhere'); await fs.mkdir(other);
  await assert.rejects(service.submit(principal, job(other)), e => e.code === 'project_not_allowed');
  await assert.rejects(service.submit(principal, job(project, { agent: 'pi' })), e => e.code === 'agent_not_allowed');
  await assert.rejects(service.submit(principal, job(project, { context: undefined })), e => e.code === 'invalid_job' && e.details.field === 'context');
  await assert.rejects(service.submit(principal, job(project, { checks: [] })), e => e.code === 'invalid_task');
  await assert.rejects(service.submit(principal, job(project, { allowedPaths: ['src'] })), e => e.code === 'directory_scope_missing_slash');
  assert.equal((await service.jobs.list({ principalId: principal.id })).length, 0, 'rejected requests create no job');
  await assert.rejects(service.submit(principal, job(project, { extra: true })), e => e.code === 'invalid_job');
  await assert.rejects(service.status(principal, { jobId: 'job-missing' }), e => e.code === 'job_not_found');
  const stranger = { ...principal, id: 'dot' };
  const mine = await service.submit(principal, job(project));
  await assert.rejects(service.status(stranger, { jobId: mine.job.id }), e => e.code === 'job_not_found');
});

test('a dispatch failure after submission is reported as a retry attention item, not lost', async t => {
  const { service, principal, project, runtime } = await setup(t);
  runtime.ensureServer = async () => { throw new Error('herdr unavailable'); };
  const view = await service.submit(principal, job(project));
  assert.equal(view.state, 'attention');
  assert.equal(view.attention[0].kind, 'retry');
  assert.equal(view.next_action, 'retry');
  const again = await service.submit(principal, job(project));
  assert.equal(again.job.id, view.job.id);
  assert.equal(again.state, 'attention');
});

test('MCP server authenticates principals and serves initialize, tools/list and tools/call', async t => {
  const { service, token, project } = await setup(t);
  const started = await startAccessServer({ service, toolTimeoutMs: 15000 });
  t.after(started.close);
  assert.match(started.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal((await rpc(started.endpoint, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
  assert.equal((await rpc(started.endpoint, { jsonrpc: '2.0', id: 1, method: 'ping' }, { token: 'hoa_wrong-token-value-here' })).status, 401);
  assert.equal((await rpc(started.endpoint, null, { token, method: 'GET' })).status, 405);

  const init = await rpc(started.endpoint, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }, { token });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, '2025-03-26');
  assert.equal(init.body.result.serverInfo.name, 'harnessorbit-access');
  assert.equal((await rpc(started.endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' }, { token })).status, 202);

  const list = await rpc(started.endpoint, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { token });
  assert.deepEqual(list.body.result.tools.map(tool => tool.name), ['describe', 'submit', 'status']);
  assert.equal(list.body.result.tools.length, TOOLS.length);

  const describe = await rpc(started.endpoint, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'describe', arguments: {} } }, { token });
  assert.equal(describe.body.result.isError, false);
  assert.equal(describe.body.result.structuredContent.principal.id, 'grok');
  assert.deepEqual(describe.body.result.structuredContent.principal.projects, [project]);
  assert.equal(JSON.parse(describe.body.result.content[0].text).service, 'harnessorbit-access');

  const submit = await rpc(started.endpoint, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'submit', arguments: job(project) } }, { token });
  assert.equal(submit.body.result.isError, false);
  const jobId = submit.body.result.structuredContent.job.id;
  assert.match(jobId, /^job-/);

  const bad = await rpc(started.endpoint, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'submit', arguments: { ...job(project), idempotencyKey: 'req-2', project: '/nope' } } }, { token });
  assert.equal(bad.body.result.isError, true);
  assert.equal(bad.body.result.structuredContent.code, 'project_not_allowed');

  const status = await rpc(started.endpoint, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'status', arguments: { jobId } } }, { token });
  assert.equal(status.body.result.isError, false);
  assert.ok(['running', 'attention'].includes(status.body.result.structuredContent.state));

  assert.equal((await rpc(started.endpoint, { jsonrpc: '2.0', id: 7, method: 'resources/list' }, { token })).body.error.code, -32601);
  assert.equal((await rpc(started.endpoint, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope' } }, { token })).body.error.code, -32602);
  assert.equal((await rpc(started.endpoint, [{ jsonrpc: '2.0', id: 9, method: 'ping' }], { token })).status, 400);
  const audit = await fs.readFile(path.join(service.root, 'access', 'audit.jsonl'), 'utf8');
  assert.ok(audit.split('\n').filter(Boolean).length >= 4);
  assert.ok(!audit.includes(token));
});

test('CLI parses the three-level access principal commands', () => {
  const parsed = parseArgs(['access', 'principal', 'create', '--id', 'grok', '--project', '/tmp/p', '--allow-integrate']);
  assert.equal(parsed.command, 'access principal create');
  assert.equal(parsed.values['allow-integrate'], true);
  assert.equal(parseArgs(['access', 'status', '--principal', 'grok', '--job', 'job-1', '--no-advance']).values['no-advance'], true);
  assert.throws(() => parseArgs(['access', 'serve', '--bogus']), e => e.code === 'invalid_arguments');
});
