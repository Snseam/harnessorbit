import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Orchestrator } from '../src/orchestrator.mjs';
import { OrchestratorError } from '../src/errors.mjs';
import { submitResult } from '../src/results.mjs';
import { executableAvailable } from '../src/preflight.mjs';
import { validateTask, taskDigest } from '../src/task.mjs';
import { fixture, FakeHerdr, writeResult, task } from './helpers.mjs';

async function setup(t, runtime = new FakeHerdr()) {
  const f = await fixture(); t.after(f.remove);
  const service = new Orchestrator({ stateRoot: f.stateRoot, herdr: runtime });
  const run = await service.init({ project: f.project });
  return { ...f, service, run, runtime };
}

test('optional absolute deadline is strict, canonical and leaves legacy task digests unchanged', () => {
  const plain = validateTask(task());
  assert.equal(Object.hasOwn(plain, 'deadlineAt'), false);
  assert.equal(taskDigest(task()), taskDigest(plain));
  assert.equal(validateTask(task({ deadlineAt: '2030-01-02T03:04:05Z' })).deadlineAt, '2030-01-02T03:04:05.000Z');
  for (const deadlineAt of [42, '', 'tomorrow', '2030-02-30T03:04:05Z', '2030-01-01', '2030-01-02T24:04:05Z']) {
    assert.throws(() => validateTask(task({ deadlineAt })), e => e.code === 'invalid_task');
  }
});

test('preflight and dispatch treat cacheinfo gitlinks as opaque pointers', async t => {
  const { service, run, project, runtime } = await setup(t);
  const head = execFileSync('git', ['-C', project, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', project, 'update-index', '--add', '--cacheinfo', `160000,${head},nested`]);
  await service.preflight(run.id, task());
  assert.equal((await service.status(run.id)).tasks.length, 0);
  const dispatched = await service.dispatch(run.id, task());
  assert.notEqual(dispatched.attempt.lastError?.code, 'unsupported_submodule');
  assert.notEqual(dispatched.attempt.status, 'failed');
  assert.ok(runtime.starts > 0);
});

test('missing runtime and expired task fail before worker launch and do not hold untouched checkout', async t => {
  const runtime = new FakeHerdr();
  runtime.preflight = async () => ({ herdr: { available: true }, agent: { available: false } });
  const { service, run } = await setup(t, runtime);
  const failed = await service.dispatch(run.id, task({ isolation: 'checkout' }));
  assert.equal(failed.attempt.lastError.code, 'preflight_unavailable');
  assert.equal(failed.attempt.checkoutReleased, true);
  assert.equal(runtime.starts, 0);
  delete runtime.preflight;
  const expired = await service.dispatch(run.id, task({ id: 'expired', deadlineAt: '2000-01-01T00:00:00Z' }));
  assert.equal(expired.attempt.lastError.code, 'deadline_exceeded');
  const good = await service.dispatch(run.id, task({ id: 'good', isolation: 'checkout' }));
  assert.equal(good.attempt.status, 'running');
});

test('executable discovery does not run programs or expose environment', async t => {
  const f = await fixture(); t.after(f.remove);
  const probe = path.join(f.base, 'probe');
  await fs.writeFile(probe, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  assert.equal(await executableAvailable('probe', { env: { PATH: f.base } }), true);
  assert.equal(await executableAvailable('missing', { env: { PATH: f.base } }), false);
  assert.equal(await executableAvailable(f.base), false);
});

test('atomic result submission checks identity and still requires independent verification', async t => {
  const { service, run } = await setup(t, new FakeHerdr(async () => {}));
  const { attempt } = await service.dispatch(run.id, task());
  const report = { taskId: task().id, attemptId: attempt.id, nonce: attempt.nonce, status: 'submitted', summary: 'claims finished', changedFiles: [], checks: [{ status: 'passed' }], children: [], unresolved: [] };
  await assert.rejects(submitResult(attempt.directory, { ...report, nonce: 'stale' }), e => e.code === 'stale_result');
  const submitted = await submitResult(attempt.directory, report);
  assert.equal(submitted.accepted, false);
  assert.equal((await service.collect(run.id, task().id)).attempt.status, 'submitted');
  assert.equal((await service.verify(run.id, task().id)).attempt.status, 'rework');
});

test('atomic submit refuses symlink result and oversize serialization', async t => {
  const { service, run, base } = await setup(t, new FakeHerdr(async () => {}));
  const { attempt } = await service.dispatch(run.id, task());
  const report = { taskId: task().id, attemptId: attempt.id, nonce: attempt.nonce, status: 'submitted', summary: '', changedFiles: [], checks: [], children: [], unresolved: [] };
  await assert.rejects(submitResult(attempt.directory, { ...report, summary: 'x'.repeat(131072) }), e => e.code === 'invalid_result');
  const unrelated = path.join(base, 'unrelated.json');
  await fs.writeFile(unrelated, 'keep');
  await fs.symlink(unrelated, attempt.resultFile);
  await assert.rejects(submitResult(attempt.directory, report), e => e.code === 'invalid_result');
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep');
});

test('report repair is claimed once, even with concurrent callers and lost acknowledgement', async t => {
  let first;
  const runtime = new FakeHerdr(async prompt => { first ||= prompt; });
  const { service, run } = await setup(t, runtime);
  const { attempt } = await service.dispatch(run.id, task());
  await service._update(run.id, task().id, attempt.id, a => { a.status = 'needs_input'; a.lastError = { code: 'missing_result' }; });
  runtime.onPrompt = async () => { await writeResult(first); throw new OrchestratorError('command_timeout', 'ack lost'); };
  const results = await Promise.all([service.requestReport(run.id, task().id), service.requestReport(run.id, task().id)]);
  assert.equal(runtime.prompts.length, 2);
  assert.equal(results.filter(r => r.duplicate).length, 1);
  assert.equal((await service.inspect(run.id, task().id)).attempt.reportRequest.state, 'uncertain');
  assert.equal((await service.collect(run.id, task().id)).attempt.status, 'submitted');
  assert.equal(runtime.prompts.length, 2);
});

test('report repair never replays stale assignment, permission wait or running children', async t => {
  const { service, run, runtime } = await setup(t, new FakeHerdr(async () => {}));
  const { attempt } = await service.dispatch(run.id, task({ maxChildren: 1 }));
  for (const code of ['stale_result', 'permission_required', 'children_unfinished']) {
    await service._update(run.id, task().id, attempt.id, a => { a.status = 'needs_input'; a.lastError = { code }; });
    await assert.rejects(service.requestReport(run.id, task().id), e => e.code === 'report_request_not_allowed');
  }
  assert.equal(runtime.prompts.length, 1);
});

test('state changes retain phase telemetry across controllers and mere observations do not prove progress', async t => {
  const { service, run, runtime } = await setup(t, new FakeHerdr(async (_prompt, worker) => { worker.agent_status = 'working'; worker.interactive_ready = false; }));
  const { attempt } = await service.dispatch(run.id, task());
  assert.ok(attempt.performance);
  const first = await service.collect(run.id, task().id);
  const restarted = new Orchestrator({ stateRoot: service.root, herdr: runtime });
  const second = await restarted.collect(run.id, task().id);
  assert.equal(first.attempt.performance.lastProgressAt, second.attempt.performance.lastProgressAt);
  assert.ok(second.attempt.observedAt);
  const report = await restarted.performance(run.id);
  assert.equal(JSON.stringify(report).includes(attempt.nonce), false);
});

test('expired verification is bounded while explicit recover can recheck retained checkout', async t => {
  const { service, run } = await setup(t);
  await service.dispatch(run.id, task({ isolation: 'checkout' }));
  const { attempt } = await service.collect(run.id, task().id);
  await service._update(run.id, task().id, attempt.id, a => { a.deadlineAt = new Date(Date.now() + 500).toISOString(); });
  service.command = async (_argv, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new OrchestratorError('command_cancelled', 'aborted')), { once: true });
  });
  const failed = await service.verify(run.id, task().id);
  assert.equal(failed.attempt.status, 'rework');
  assert.equal(failed.attempt.verification.error.code, 'deadline_exceeded');
  assert.ok(failed.attempt.deadlineExceededAt);
  service.command = async () => ({ code: 0, stdout: '', stderr: '' });
  assert.equal((await service.recover(run.id, task().id)).attempt.status, 'accepted');
});

test('collect stamps blocked lastError and restores running after the wait ends', async t => {
  const { service, run, runtime } = await setup(t);
  const dispatched = await service.dispatch(run.id, task());
  const worker = runtime.workers.get(dispatched.attempt.workerName);
  worker.agent_status = 'blocked';
  runtime.readAgent = async () => 'Yes, I trust this folder SECRET';
  const blocked = await service.collect(run.id, task().id);
  assert.equal(blocked.attempt.status, 'needs_input');
  assert.equal(blocked.attempt.lastError.code, 'permission_required');
  assert.equal(JSON.stringify(blocked.attempt.lastError).includes('SECRET'), false);
  await assert.rejects(service.requestReport(run.id, task().id), e => e.code === 'report_request_not_allowed');
  worker.agent_status = 'working';
  worker.interactive_ready = true;
  const resumed = await service.collect(run.id, task().id);
  assert.equal(resumed.attempt.status, 'running');
  assert.equal(resumed.attempt.lastError, undefined);
});

test('unclassified Herdr blocked waits use worker_blocked without auto-approving', async t => {
  const { service, run, runtime } = await setup(t);
  const dispatched = await service.dispatch(run.id, task());
  const worker = runtime.workers.get(dispatched.attempt.workerName);
  worker.agent_status = 'blocked';
  runtime.readAgent = async () => 'pane is waiting on an unknown dialog';
  const blocked = await service.collect(run.id, task().id);
  assert.equal(blocked.attempt.lastError.code, 'worker_blocked');
  await assert.rejects(service.requestReport(run.id, task().id), e => e.code === 'report_request_not_allowed');
});

test('provider saturation annotates collect without replacing lastError', async t => {
  const { service, run, runtime } = await setup(t);
  const dispatched = await service.dispatch(run.id, task());
  const worker = runtime.workers.get(dispatched.attempt.workerName);
  worker.agent_status = 'blocked';
  runtime.readAgent = async () => 'Selected model is at capacity';
  const blocked = await service.collect(run.id, task().id);
  assert.equal(blocked.attempt.lastError.code, 'worker_blocked');
  assert.equal(blocked.attempt.providerObservation.code, 'provider_saturated');
  assert.equal(JSON.stringify(blocked.attempt.lastError).includes('capacity'), false);
  await assert.rejects(service.requestReport(run.id, task().id), e => e.code === 'report_request_not_allowed');
  worker.agent_status = 'working';
  worker.interactive_ready = true;
  const resumed = await service.collect(run.id, task().id);
  assert.equal(resumed.attempt.status, 'running');
  assert.equal(resumed.attempt.lastError, undefined);
  assert.equal(resumed.attempt.providerObservation.code, 'provider_saturated');
});

test('idle missing result keeps missing_result when pane shows saturation', async t => {
  const runtime = new FakeHerdr(async () => {});
  const { service, run } = await setup(t, runtime);
  const dispatched = await service.dispatch(run.id, task());
  const worker = runtime.workers.get(dispatched.attempt.workerName);
  worker.agent_status = 'idle';
  worker.interactive_ready = true;
  runtime.readAgent = async () => 'Selected model is at capacity';
  await service._update(run.id, task().id, dispatched.attempt.id, a => {
    a.submissionStartedAt = new Date(Date.now() - 6000).toISOString();
  });
  const collected = await service.collect(run.id, task().id, { waitMs: 0 });
  assert.equal(collected.attempt.status, 'needs_input');
  assert.equal(collected.attempt.lastError.code, 'missing_result');
  assert.equal(collected.attempt.providerObservation.code, 'provider_saturated');
});

test('failed startup writes bounded errorCode on attempt.state events', async t => {
  const runtime = new FakeHerdr();
  runtime.preflight = async () => ({ herdr: { available: true }, agent: { available: false } });
  const { service, run } = await setup(t, runtime);
  const failed = await service.dispatch(run.id, task({ isolation: 'checkout' }));
  assert.equal(failed.attempt.lastError.code, 'preflight_unavailable');
  const file = path.join(service.root, 'runs', run.id, 'events.jsonl');
  const events = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(e => e.type === 'attempt.state' && e.to === 'failed');
  assert.equal(events.at(-1).errorCode, 'preflight_unavailable');
  assert.equal(Object.hasOwn(events.at(-1), 'message'), false);
  assert.equal(Object.hasOwn(events.at(-1), 'details'), false);
});

test('performance events follow committed state and event append failure marks incomplete coverage', async t => {
  const { service, run } = await setup(t);
  const { attempt } = await service.dispatch(run.id, task());
  const file = path.join(service.root, 'runs', run.id, 'events.jsonl');
  const events = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(e => e.type === 'performance.observed');
  assert.ok(events.length);
  assert.equal(new Set(events.map(e => e.eventId)).size, events.length);
  assert.ok(events.every((e, i) => e.sequence === i + 1));
  assert.equal(JSON.stringify(events).includes(attempt.nonce), false);
  await fs.rename(file, `${file}.saved`);
  await fs.mkdir(file);
  await service._update(run.id, task().id, attempt.id, a => { a.executionPhase = 'collect'; });
  const retained = await service._loadRun(run.id);
  assert.equal(retained.performanceEventsIncomplete, true);
  assert.equal((await service.inspect(run.id, task().id)).attempt.executionPhase, 'collect');
});

test('CLI supervises a stopped submitted fixture through independent checks and integration', async t => {
  const { service, run, runtime, project } = await setup(t);
  const { attempt } = await service.dispatch(run.id, task());
  await service.collect(run.id, task().id);
  await runtime.closePane(run.herdrSession, attempt.paneId);
  await service._update(run.id, task().id, attempt.id, a => { a.workerClosed = true; });
  const argv = ['bin/cao.mjs', 'supervise', '--run', run.id, '--state-dir', service.root, '--integrate', '--wait-ms', '3000', '--poll-ms', '10'];
  const result = JSON.parse(execFileSync(process.execPath, argv, { encoding: 'utf8' }));
  assert.equal(result.ok, true);
  assert.equal((await service.inspect(run.id, task().id)).attempt.status, 'integrated');
  assert.match(await fs.readFile(path.join(project, 'src/math.mjs'), 'utf8'), /a \+ b/);
  const report = JSON.parse(execFileSync(process.execPath, ['bin/cao.mjs', 'performance', 'report', '--run', run.id, '--state-dir', service.root], { encoding: 'utf8' })).data;
  assert.equal(report.outcomes.projectAcceptance, 'unknown');
  assert.equal(report.totals.integratedAttempts, 1);
});
