import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Orchestrator } from '../src/orchestrator.mjs';
import { OrchestratorError } from '../src/errors.mjs';
import { fixture, FakeHerdr, writeResult, promptData, task } from './helpers.mjs';

async function setup(t, runtime = new FakeHerdr()) {
  const f = await fixture(); t.after(f.remove);
  const service = new Orchestrator({ stateRoot: f.stateRoot, herdr: runtime });
  const run = await service.init({ project: f.project });
  return { ...f, service, run, runtime };
}

test('worktree task is verified independently and integrated without a commit', async t => {
  const { service, run, project, runtime } = await setup(t);
  const launched = await service.dispatch(run.id, task());
  assert.equal(launched.attempt.status, 'running');
  assert.match(await fs.readFile(path.join(project, 'src/math.mjs'), 'utf8'), /a - b/);
  assert.equal((await service.collect(run.id, task().id)).attempt.status, 'submitted');
  const verified = await service.verify(run.id, task().id);
  assert.equal(verified.attempt.status, 'accepted');
  assert.equal(verified.attempt.verification.checks[0].status, 'passed');
  assert.equal(verified.attempt.workerClosed, true);
  assert.equal((await service.integrate(run.id, task().id)).attempt.status, 'integrated');
  assert.match(await fs.readFile(path.join(project, 'src/math.mjs'), 'utf8'), /a \+ b/);
  await service.cleanup(run.id);
  assert.deepEqual(runtime.stops, [run.herdrSession]);
});

test('concurrent duplicate dispatch is idempotent and rejects changed definitions', async t => {
  const { service, run, runtime } = await setup(t);
  const results = await Promise.all([service.dispatch(run.id, task()), service.dispatch(run.id, task())]);
  assert.equal(runtime.starts, 1); assert.equal(runtime.prompts.length, 1);
  assert.equal(results.filter(x => x.duplicate).length, 1);
  await assert.rejects(service.dispatch(run.id, task({ objective: 'Different task' })), e => e.code === 'task_conflict');
});

test('timeout after delivery is reconciled without submitting again', async t => {
  const runtime = new FakeHerdr(async prompt => { await writeResult(prompt); throw new OrchestratorError('command_timeout', 'response lost'); });
  const { service, run } = await setup(t, runtime);
  assert.equal((await service.dispatch(run.id, task())).attempt.status, 'uncertain');
  const restarted = new Orchestrator({ stateRoot: service.root, herdr: runtime });
  assert.equal((await restarted.resume(run.id, task().id)).attempt.status, 'submitted');
  assert.equal(runtime.prompts.length, 1);
});

test('stale result cannot enter verification', async t => {
  const { service, run } = await setup(t, new FakeHerdr(p => writeResult(p, { overrides: { nonce: 'old-attempt' } })));
  await service.dispatch(run.id, task());
  const result = await service.collect(run.id, task().id);
  assert.equal(result.attempt.status, 'needs_input');
  assert.equal(result.attempt.lastError.code, 'stale_result');
  await assert.rejects(service.verify(run.id, task().id), e => e.code === 'not_submitted');
});

test('reported running children and out-of-scope changes block submission', async t => {
  const child = await setup(t, new FakeHerdr(p => writeResult(p, { overrides: { children: [{ id: 'child', status: 'running' }] } })));
  await child.service.dispatch(child.run.id, task({ maxChildren: 1 }));
  assert.equal((await child.service.collect(child.run.id, task().id)).attempt.status, 'needs_input');
  const scope = await setup(t, new FakeHerdr(async p => { const d = await writeResult(p); await fs.writeFile(path.join(d.cwd, 'unexpected.txt'), 'outside'); }));
  await scope.service.dispatch(scope.run.id, task());
  const result = await scope.service.collect(scope.run.id, task().id);
  assert.equal(result.attempt.status, 'needs_input');
  assert.deepEqual(result.attempt.outsideScope, ['unexpected.txt']);
});

test('missing directory slash fails before reserving an attempt', async t => {
  const { service, run } = await setup(t);
  await assert.rejects(service.preflight(run.id, task({ allowedPaths: ['src'] })), e => {
    assert.equal(e.code, 'directory_scope_missing_slash');
    assert.equal(e.details.scope.root, false);
    assert.deepEqual(e.details.scope.ambiguousDirectories, ['src']);
    return true;
  });
  await assert.rejects(service.dispatch(run.id, task({ allowedPaths: ['src'] })), e => e.code === 'directory_scope_missing_slash');
  assert.equal((await service.status(run.id)).tasks.length, 0);
  const ready = await service.preflight(run.id, task({ allowedPaths: ['src/'] }));
  assert.equal(ready.authentication, 'not_checked');
  assert.equal(ready.modelCall, false);
  assert.equal(ready.scope.root, false);
});

test('worktree scope leftovers cannot retry while checkout retry remains legal', async t => {
  const worktree = await setup(t, new FakeHerdr(async p => { const d = await writeResult(p); await fs.writeFile(path.join(d.cwd, 'unexpected.txt'), 'outside'); }));
  await worktree.service.dispatch(worktree.run.id, task());
  const blocked = await worktree.service.collect(worktree.run.id, task().id);
  assert.equal(blocked.attempt.status, 'needs_input');
  assert.deepEqual(blocked.retryAdvice, { action: 'dispatch_new_task', reason: 'scope_violation' });
  assert.equal((await worktree.service.cancel(worktree.run.id, task().id)).attempt.status, 'cancelled');
  await assert.rejects(worktree.service.retry(worktree.run.id, task().id), e => e.code === 'scope_retry_forbidden');
  assert.equal((await worktree.service.inspect(worktree.run.id, task().id)).attempt.status, 'cancelled');

  const checkout = await setup(t, new FakeHerdr(async p => { const d = await writeResult(p); await fs.writeFile(path.join(d.cwd, 'unexpected.txt'), 'outside'); }));
  await checkout.service.dispatch(checkout.run.id, task({ isolation: 'checkout' }));
  const checkoutBlocked = await checkout.service.collect(checkout.run.id, task().id);
  assert.deepEqual(checkoutBlocked.retryAdvice, { action: 'retry_with_feedback', reason: 'scope_violation' });
  assert.equal((await checkout.service.cancel(checkout.run.id, task().id)).attempt.status, 'cancelled');
  const retried = await checkout.service.retry(checkout.run.id, task().id);
  assert.notEqual(retried.attempt.id, checkoutBlocked.attempt.id);
  assert.equal(retried.attempt.status, 'running');
});

test('failed verification starts a distinct retry preserving partial work', async t => {
  let calls = 0;
  const { service, run } = await setup(t, new FakeHerdr(p => writeResult(p, { fix: ++calls > 1 })));
  const first = await service.dispatch(run.id, task());
  await service.collect(run.id, task().id);
  assert.equal((await service.verify(run.id, task().id)).attempt.status, 'rework');
  const next = await service.retry(run.id, task().id, 'The independent test still fails. Fix the implementation.');
  assert.notEqual(next.attempt.id, first.attempt.id);
  assert.notEqual(next.attempt.nonce, first.attempt.nonce);
  assert.equal(next.attempt.cwd, first.attempt.cwd);
  await service.collect(run.id, task().id);
  assert.equal((await service.verify(run.id, task().id)).attempt.status, 'accepted');
});

test('checkout write lease applies across runs and preserves user changes', async t => {
  const { service, run, project } = await setup(t, new FakeHerdr(async (_, worker) => { worker.agent_status = 'working'; worker.interactive_ready = false; }));
  await fs.writeFile(path.join(project, 'notes.txt'), 'existing user work');
  await service.dispatch(run.id, task({ isolation: 'checkout' }));
  const another = await service.init({ project });
  await assert.rejects(service.dispatch(another.id, task({ id: 'another', isolation: 'checkout' })), e => e.code === 'checkout_busy');
  assert.equal(await fs.readFile(path.join(project, 'notes.txt'), 'utf8'), 'existing user work');
  await service.cancel(run.id, task().id);
  assert.equal((await service.inspect(run.id, task().id)).attempt.status, 'cancelled');
});

test('dirty project baseline is carried into worktree and integration preserves it', async t => {
  const { service, run, project } = await setup(t);
  await fs.writeFile(path.join(project, 'user-note.txt'), 'uncommitted user note');
  await service.dispatch(run.id, task());
  await service.collect(run.id, task().id);
  await service.verify(run.id, task().id);
  assert.equal((await service.integrate(run.id, task().id)).attempt.status, 'integrated');
  assert.equal(await fs.readFile(path.join(project, 'user-note.txt'), 'utf8'), 'uncommitted user note');
});

test('candidate mutation and patch tampering refuse integration', async t => {
  const { service, run } = await setup(t);
  await service.dispatch(run.id, task());
  await service.collect(run.id, task().id);
  const result = await service.verify(run.id, task().id);
  await fs.appendFile(result.attempt.patchFile, '\nmalicious replacement');
  await assert.rejects(service.integrate(run.id, task().id), e => e.code === 'patch_changed');
  await fs.appendFile(path.join(result.attempt.cwd, 'src/math.mjs'), '// later mutation\n');
  await assert.rejects(service.integrate(run.id, task().id), e => e.code === 'candidate_changed');
});

test('changed target refuses integration and leaves user edit intact', async t => {
  const { service, run, project } = await setup(t);
  await service.dispatch(run.id, task()); await service.collect(run.id, task().id); await service.verify(run.id, task().id);
  await fs.writeFile(path.join(project, 'src/math.mjs'), 'user changed this file\n');
  await assert.rejects(service.integrate(run.id, task().id), e => e.code === 'integration_conflict');
  assert.equal(await fs.readFile(path.join(project, 'src/math.mjs'), 'utf8'), 'user changed this file\n');
});

test('verification cannot make source edits and still accept', async t => {
  const { service, run } = await setup(t);
  const input = task({ checks: [{ name: 'bad verifier', argv: [process.execPath, '-e', "require('fs').writeFileSync('src/math.mjs','changed')"] }] });
  await service.dispatch(run.id, input); await service.collect(run.id, input.id);
  const result = await service.verify(run.id, input.id);
  assert.equal(result.attempt.status, 'rework');
  assert.equal(result.attempt.verification.error.code, 'verification_mutated_tree');
});

test('replacement terminal is not adopted or closed', async t => {
  const { service, run, runtime } = await setup(t);
  const launch = await service.dispatch(run.id, task());
  runtime.workers.get(launch.attempt.workerName).terminal_id = 'a-different-terminal';
  assert.equal((await service.collect(run.id, task().id)).attempt.lastError.code, 'identity_changed');
  const cancelled = await service.cancel(run.id, task().id);
  assert.equal(cancelled.attempt.status, 'cancelling');
  assert.equal(runtime.closed.length, 0);
});

test('cancellation during workspace creation never delivers the task', async t => {
  let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const runtime = new FakeHerdr(); runtime.beforeCreate = async () => { entered(); await gate; };
  const { service, run } = await setup(t, runtime);
  const pending = service.dispatch(run.id, task());
  await started;
  assert.equal((await service.cancel(run.id, task().id)).attempt.status, 'cancelling');
  release();
  assert.equal((await pending).attempt.status, 'cancelled');
  assert.equal(runtime.prompts.length, 0);
  assert.equal(runtime.panes.size, 0);
});

test('cancellation aborts verification and waits for its process to exit', async t => {
  const { service, run } = await setup(t);
  const input = task({ checks: [{ name: 'long check', argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], timeoutMs: 10000 }] });
  await service.dispatch(run.id, input); await service.collect(run.id, input.id);
  const pending = service.verify(run.id, input.id);
  while ((await service.inspect(run.id, input.id)).attempt.status !== 'verifying') await new Promise(r => setTimeout(r, 10));
  const cancellation = await service.cancel(run.id, input.id);
  assert.equal(cancellation.attempt.status, 'cancelling');
  const final = await pending;
  assert.equal(final.attempt.status, 'cancelled');
  assert.equal(final.attempt.verification.passed, false);
});

test('unknown run and unsafe identifiers fail without creating run directories', async t => {
  const { service, stateRoot } = await setup(t);
  await assert.rejects(service.status('missing'), e => e.code === 'run_not_found');
  await assert.rejects(service.verify('missing', '../../bad'), e => e.code === 'invalid_id');
  await assert.rejects(fs.stat(path.join(stateRoot, 'runs', 'missing')), e => e.code === 'ENOENT');
});
