import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Orchestrator } from '../src/orchestrator.mjs';
import { PrincipalStore } from '../src/access/principals.mjs';
import { AccessService, ACCESS_TOOLS } from '../src/access/service.mjs';
import { startAccessServer, TOOLS } from '../src/access/server.mjs';
import { parseArgs } from '../bin/cao.mjs';
import { fixture, FakeHerdr, writeResult } from './helpers.mjs';

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
  assert.deepEqual(list.body.result.tools.map(tool => tool.name), [...ACCESS_TOOLS]);
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

test('approve integrates an accepted candidate only for a principal with the integrate permission', async t => {
  const { service, principal, principals, project } = await setup(t);
  const submitted = await service.submit(principal, job(project));
  await service.status(principal, { jobId: submitted.job.id });
  await assert.rejects(service.approve(principal, { jobId: submitted.job.id }), e => e.code === 'permission_denied');
  await assert.rejects(service.approve(principal, { jobId: submitted.job.id, kind: 'merge' }), e => e.code === 'invalid_approval');
  const integrator = (await principals.create({ id: 'ops', projects: [project], agents: ['claude'], permissions: { integrate: true } })).principal;
  await assert.rejects(service.approve(integrator, { jobId: submitted.job.id }), e => e.code === 'job_not_found', 'approval never crosses principals');
  const own = await service.submit(integrator, job(project, { idempotencyKey: 'ops-1' }));
  await assert.rejects(service.approve(integrator, { jobId: own.job.id }), e => e.code === 'not_accepted');
  const ready = await service.status(integrator, { jobId: own.job.id });
  assert.equal(ready.next_action, 'approve');
  assert.match(ready.attention[0].how, /approve/);
  const approved = await service.approve(integrator, { jobId: own.job.id });
  assert.equal(approved.state, 'integrated');
  assert.equal(approved.attempt.status, 'integrated');
  assert.equal(approved.next_action, 'result');
  assert.equal(approved.attention_pending, 0);
  assert.match(await fs.readFile(path.join(project, 'src/math.mjs'), 'utf8'), /a \+ b/);
  await assert.rejects(service.approve(integrator, { jobId: own.job.id }), e => e.code === 'not_accepted');
  await assert.rejects(service.cancel(integrator, { jobId: own.job.id }), e => e.code === 'already_integrated');
  assert.equal((await service.jobs.get(own.job.id)).approvals.length, 1);
});

test('answer replies to a worker that needs input and status follows it through to acceptance', async t => {
  let first = null;
  const runtime = new FakeHerdr(async prompt => {
    if (!first) { first = prompt; await writeResult(prompt, { fix: false, overrides: { status: 'needs_input', unresolved: ['Should add() accept more than two inputs?'] } }); return; }
    await writeResult(first);
  });
  const { service, principal, project } = await setup(t, runtime);
  const submitted = await service.submit(principal, job(project));
  const waiting = await service.status(principal, { jobId: submitted.job.id });
  assert.equal(waiting.state, 'attention');
  assert.equal(waiting.attention[0].kind, 'input');
  assert.equal(waiting.attempt.lastError.code, 'worker_blocked');
  assert.equal(waiting.next_action, 'answer');
  await assert.rejects(service.answer(principal, { jobId: submitted.job.id }), e => e.code === 'invalid_answer');
  await assert.rejects(service.answer(principal, { jobId: submitted.job.id, text: 'x', keys: ['Enter'] }), e => e.code === 'invalid_answer');
  await assert.rejects(service.answer(principal, { jobId: submitted.job.id, keys: ['rm -rf /'] }), e => e.code === 'invalid_answer');
  const answered = await service.answer(principal, { jobId: submitted.job.id, text: 'No. Two inputs only; keep the signature.' });
  assert.equal(runtime.prompts.length, 2);
  assert.match(runtime.prompts[1], /Two inputs only/);
  assert.equal(answered.state, 'running', 'the reply was delivered and the worker is being observed');
  assert.equal(answered.next_action, 'status');
  const accepted = await service.status(principal, { jobId: submitted.job.id });
  assert.equal(accepted.attempt.status, 'accepted');
  assert.equal(accepted.next_action, 'approve');
  await assert.rejects(service.answer(principal, { jobId: submitted.job.id, text: 'again' }), e => e.code === 'answer_not_allowed');
  assert.equal((await service.jobs.get(submitted.job.id)).answers.length, 1);
});

test('cancel stops a running worker, withdraws accepted work, and closes dispatch failures', async t => {
  const { service, principal, project, runtime } = await setup(t);
  const running = await service.submit(principal, job(project));
  await assert.rejects(service.cancel({ ...principal, permissions: { ...principal.permissions, cancel: false } }, { jobId: running.job.id }), e => e.code === 'permission_denied');
  const cancelled = await service.cancel(principal, { jobId: running.job.id, reason: 'User changed their mind' });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.attempt.status, 'cancelled');
  assert.equal(cancelled.next_action, 'none');
  assert.ok(runtime.closed.length >= 1, 'the worker pane is closed');
  await assert.rejects(service.answer(principal, { jobId: running.job.id, text: 'hello' }), e => e.code === 'answer_not_allowed');
  const second = await service.submit(principal, job(project, { idempotencyKey: 'req-2' }));
  assert.equal((await service.status(principal, { jobId: second.job.id })).attempt.status, 'accepted');
  const withdrawn = await service.cancel(principal, { jobId: second.job.id });
  assert.equal(withdrawn.state, 'cancelled');
  assert.equal(withdrawn.attention_pending, 0);
  assert.ok(withdrawn.job.withdrawnAt);
  assert.equal((await service.status(principal, { jobId: second.job.id })).state, 'cancelled');
  assert.match(await fs.readFile(path.join(project, 'src/math.mjs'), 'utf8'), /a - b/, 'withdrawing never touches the checkout');
  runtime.ensureServer = async () => { throw new Error('herdr unavailable'); };
  const broken = await service.submit(principal, job(project, { idempotencyKey: 'req-3' }));
  assert.equal(broken.next_action, 'retry');
  assert.equal((await service.cancel(principal, { jobId: broken.job.id })).state, 'cancelled');
  assert.equal((await service.status(principal, { jobId: broken.job.id })).next_action, 'none');
});

test('result returns the report, verification evidence, and the verified patch on request', async t => {
  const { service, principal, project } = await setup(t);
  const submitted = await service.submit(principal, job(project));
  await assert.rejects(service.result(principal, { jobId: submitted.job.id }), e => e.code === 'result_not_ready');
  await service.status(principal, { jobId: submitted.job.id });
  const plain = await service.result(principal, { jobId: submitted.job.id });
  assert.equal(plain.state, 'attention');
  assert.equal(plain.next_action, 'approve');
  assert.equal(plain.result.report.summary, 'Prepared candidate');
  assert.equal(plain.result.verification.passed, true);
  assert.equal(plain.result.verification.checks[0].name, 'math');
  assert.equal(plain.result.verification.checks[0].code, 0);
  assert.match(plain.result.verification.checks[0].stdout, /pass 1/);
  assert.deepEqual(plain.result.changedPaths, ['src/math.mjs']);
  assert.equal(plain.result.patch, null);
  const withPatch = await service.result(principal, { jobId: submitted.job.id, includePatch: true });
  assert.match(withPatch.result.patch.text, /\+export const add = \(a, b\) => a \+ b;/);
  assert.ok(withPatch.result.patch.bytes > 0);
  await assert.rejects(service.result(principal, { jobId: submitted.job.id, includePatch: 'yes' }), e => e.code === 'invalid_job');
});

test('the background driver returns inside the settle window and reports a failed host operation on the next status', async t => {
  const f = await setup(t);
  const integrator = (await f.principals.create({ id: 'ops', projects: [f.project], agents: ['claude'], permissions: { integrate: true } })).principal;
  const service = new AccessService({ root: f.stateRoot, orchestrator: f.orchestrator, principals: f.principals, driver: 'background', settleMs: 6000 });
  const submitted = await service.submit(integrator, job(f.project));
  const startedAt = Date.now();
  let view = await service.status(integrator, { jobId: submitted.job.id });
  assert.ok(Date.now() - startedAt < 8000);
  for (let i = 0; i < 20 && view.attempt.status !== 'accepted'; i++) { await new Promise(r => setTimeout(r, 250)); view = await service.status(integrator, { jobId: submitted.job.id }); }
  assert.equal(view.attempt.status, 'accepted');
  await fs.writeFile(path.join(f.project, 'src/math.mjs'), 'export const add = (a, b) => a * b;\n'); // the project moved under the candidate
  await service.approve(integrator, { jobId: submitted.job.id });
  let failed = await service.status(integrator, { jobId: submitted.job.id });
  for (let i = 0; i < 20 && !failed.attention.some(a => a.kind === 'operation_failed'); i++) { await new Promise(r => setTimeout(r, 250)); failed = await service.status(integrator, { jobId: submitted.job.id }); }
  assert.equal(failed.attention[0].kind, 'operation_failed');
  assert.equal(failed.attention[0].code, 'integration_conflict');
  assert.equal(failed.next_action, 'resubmit');
  assert.equal(failed.attempt.status, 'accepted');
});

test('MCP server exposes approve, answer, cancel and result with the same error contract', async t => {
  const { service, token, project } = await setup(t);
  const started = await startAccessServer({ service, toolTimeoutMs: 15000 });
  t.after(started.close);
  const call = (id, name, args) => rpc(started.endpoint, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, { token });
  const submit = await call(1, 'submit', job(project));
  const jobId = submit.body.result.structuredContent.job.id;
  const status = await call(2, 'status', { jobId });
  assert.equal(status.body.result.structuredContent.attempt.status, 'accepted');
  const approve = await call(3, 'approve', { jobId });
  assert.equal(approve.body.result.isError, true);
  assert.equal(approve.body.result.structuredContent.code, 'permission_denied');
  const answer = await call(4, 'answer', { jobId, text: 'hello' });
  assert.equal(answer.body.result.structuredContent.code, 'answer_not_allowed');
  const result = await call(5, 'result', { jobId, includePatch: true });
  assert.equal(result.body.result.isError, false);
  assert.match(result.body.result.structuredContent.result.patch.text, /a \+ b/);
  const cancel = await call(6, 'cancel', { jobId, reason: 'done reviewing' });
  assert.equal(cancel.body.result.isError, false);
  assert.equal(cancel.body.result.structuredContent.state, 'cancelled');
  const audit = (await fs.readFile(path.join(service.root, 'access', 'audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(audit.map(entry => entry.tool), ['submit', 'status', 'approve', 'answer', 'result', 'cancel']);
  assert.equal(audit.find(entry => entry.tool === 'approve').code, 'permission_denied');
});

test('CLI parses the control subcommands', () => {
  assert.equal(parseArgs(['access', 'answer', '--principal', 'grok', '--job', 'job-1', '--keys', 'Enter']).values.keys, 'Enter');
  assert.equal(parseArgs(['access', 'result', '--principal', 'grok', '--job', 'job-1', '--patch']).values.patch, true);
  assert.equal(parseArgs(['access', 'cancel', '--principal', 'grok', '--job', 'job-1', '--reason', 'x']).command, 'access cancel');
  assert.throws(() => parseArgs(['access', 'approve', '--principal', 'grok', '--job', 'job-1', '--kind', 'merge']), e => e.code === 'invalid_arguments');
});

test('retry starts the next attempt with feedback and dispatches again after a failed dispatch', async t => {
  let calls = 0;
  const runtime = new FakeHerdr(async prompt => { calls++; await writeResult(prompt, { fix: calls > 1 }); });
  const { service, principal, project } = await setup(t, runtime);
  const submitted = await service.submit(principal, job(project));
  const rework = await service.status(principal, { jobId: submitted.job.id });
  assert.equal(rework.attempt.status, 'rework');
  assert.equal(rework.attention[0].kind, 'retry');
  assert.equal(rework.attention[0].exhausted, false);
  assert.equal(rework.next_action, 'retry');
  const retried = await service.retry(principal, { jobId: submitted.job.id, feedback: 'The test expects add(3, 4) === 7; you left the subtraction in place.' });
  assert.equal(retried.state, 'running');
  assert.equal(retried.attempt.number, 2);
  const promptFile = /Read "([^"]+)" completely/.exec(runtime.prompts[1])[1];
  assert.match(await fs.readFile(promptFile, 'utf8'), /left the subtraction/, 'feedback reaches the next attempt through its prompt file');
  const accepted = await service.status(principal, { jobId: submitted.job.id });
  assert.equal(accepted.attempt.status, 'accepted');
  await assert.rejects(service.retry(principal, { jobId: submitted.job.id }), e => e.code === 'retry_not_allowed');
  assert.equal((await service.jobs.get(submitted.job.id)).retries.length, 1);

  const ensure = runtime.ensureServer;
  runtime.ensureServer = async () => { throw new Error('herdr unavailable'); };
  const broken = await service.submit(principal, job(project, { idempotencyKey: 'req-2' }));
  assert.equal(broken.next_action, 'retry');
  assert.match(broken.attention[0].how, /Call retry/);
  // The orchestrator may surface a launch failure as a thrown error or as a failed attempt; either way the job stays retryable.
  const stillBroken = await service.retry(principal, { jobId: broken.job.id }).catch(error => error);
  if (stillBroken instanceof Error) assert.match(stillBroken.message, /herdr unavailable/);
  else assert.equal(stillBroken.attention[0].kind, 'retry');
  assert.equal((await service.status(principal, { jobId: broken.job.id })).next_action, 'retry', 'a failed retry keeps the job retryable');
  runtime.ensureServer = ensure;
  const revived = await service.retry(principal, { jobId: broken.job.id, feedback: 'Herdr is back.' });
  assert.equal(revived.state, 'running');
  assert.equal((await service.jobs.get(broken.job.id)).dispatchError, null);
  assert.equal((await service.status(principal, { jobId: broken.job.id })).attempt.status, 'accepted');
});

test('retry stops at the attempt limit and the view says to resubmit', async t => {
  const { service, principal, project } = await setup(t, new FakeHerdr(p => writeResult(p, { fix: false })));
  const submitted = await service.submit(principal, job(project, { maxAttempts: 1 }));
  const view = await service.status(principal, { jobId: submitted.job.id });
  assert.equal(view.attempt.status, 'rework');
  assert.equal(view.attention[0].exhausted, true);
  assert.equal(view.next_action, 'resubmit');
  await assert.rejects(service.retry(principal, { jobId: submitted.job.id, feedback: 'again' }), e => e.code === 'attempt_limit');
  assert.equal((await service.jobs.get(submitted.job.id)).retries, undefined, 'a refused retry is not recorded');
});

test('events lists job and run history in order with a cursor that neither loses nor repeats', async t => {
  const { service, principal, project } = await setup(t);
  const a = await service.submit(principal, job(project));
  await service.status(principal, { jobId: a.job.id });
  const b = await service.submit(principal, job(project, { idempotencyKey: 'req-2' }));
  await service.cancel(principal, { jobId: b.job.id, reason: 'not needed' });
  const all = await service.events(principal, {});
  assert.equal(all.more, false);
  assert.equal(all.jobs, 2);
  assert.ok(['run.created', 'job.submitted'].includes(all.events[0].type));
  assert.ok(all.events.some(e => e.type === 'attempt.state' && e.to === 'accepted' && e.job === a.job.id));
  assert.ok(all.events.some(e => e.type === 'job.withdrawn' && e.job === b.job.id && e.reason === 'not needed'));
  assert.ok(!all.events.some(e => e.type === 'performance.observed' || e.type === 'supervisor.started'));
  const key = e => `${e.at}/${e.id}`;
  for (let i = 1; i < all.events.length; i++) assert.ok(key(all.events[i - 1]) < key(all.events[i]), 'events are strictly ordered');
  const seen = []; let since = null; let page;
  do { page = await service.events(principal, { since, limit: 3 }); seen.push(...page.events); since = page.next_since; } while (page.more);
  assert.deepEqual(seen.map(e => e.id), all.events.map(e => e.id));
  const nothing = await service.events(principal, { since: all.next_since });
  assert.equal(nothing.events.length, 0);
  assert.equal(nothing.next_since, all.next_since);
  const only = await service.events(principal, { jobId: b.job.id });
  assert.ok(only.events.length > 0 && only.events.every(e => e.job === b.job.id));
  assert.equal(only.events.at(-1).type, 'job.withdrawn');
  await assert.rejects(service.events(principal, { jobId: 'job-missing' }), e => e.code === 'job_not_found');
  await assert.rejects(service.events({ ...principal, id: 'dot' }, { jobId: b.job.id }), e => e.code === 'job_not_found');
  await assert.rejects(service.events(principal, { since: 'yesterday' }), e => e.code === 'invalid_cursor');
  await assert.rejects(service.events(principal, { limit: 0 }), e => e.code === 'invalid_job');
});

test('MCP server serves retry and events', async t => {
  const { service, token, project } = await setup(t, new FakeHerdr(p => writeResult(p, { fix: false })));
  const started = await startAccessServer({ service, toolTimeoutMs: 15000 });
  t.after(started.close);
  const call = (id, name, args) => rpc(started.endpoint, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, { token });
  const jobId = (await call(1, 'submit', job(project))).body.result.structuredContent.job.id;
  assert.equal((await call(2, 'status', { jobId })).body.result.structuredContent.next_action, 'retry');
  const retry = await call(3, 'retry', { jobId, feedback: 'Fix the sign.' });
  assert.equal(retry.body.result.isError, false);
  assert.equal(retry.body.result.structuredContent.attempt.number, 2);
  const events = await call(4, 'events', { jobId, limit: 50 });
  assert.equal(events.body.result.isError, false);
  assert.ok(events.body.result.structuredContent.events.some(e => e.type === 'job.retried'));
  assert.match(events.body.result.structuredContent.next_since, /Z\//);
  assert.equal((await call(5, 'events', { since: 'nope' })).body.result.structuredContent.code, 'invalid_cursor');
});

test('CLI parses retry and events', () => {
  assert.equal(parseArgs(['access', 'retry', '--principal', 'grok', '--job', 'job-1', '--feedback', 'x']).values.feedback, 'x');
  const events = parseArgs(['access', 'events', '--principal', 'grok', '--since', '2026-01-01T00:00:00.000Z/a', '--limit', '5']);
  assert.equal(events.command, 'access events');
  assert.equal(events.values.limit, '5');
});
