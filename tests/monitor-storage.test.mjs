import test from 'node:test';
import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StorageService } from '../src/monitor/storage.mjs';

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'orbit-storage-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'state');
  const work = path.join(root, 'work', 'run1');
  const dir = path.join(root, 'runs', 'run1');
  await Promise.all([mkdir(work, { recursive: true }), mkdir(dir, { recursive: true })]);
  const record = { id: 'run1', closedAt: new Date().toISOString(), baseline: { hash: 'abc' }, tasks: { first: { definition: { id: 'first' }, attempts: [{ id: 'a1' }] } } };
  const authoritative = path.join(dir, 'run.json');
  await writeFile(authoritative, JSON.stringify(record));
  const status = JSON.stringify({ ok: true, data: { ...record, tasks: [], stateDirectory: dir } });
  const file = path.join(work, '123456789000-status.json');
  await writeFile(file, status);
  return { base, root, work, dir, file, record, authoritative, status, service: new StorageService(root) };
}

test('inventory counts allocated bytes and only recognizes closed run command exports', async t => {
  const f = await fixture(t);
  const inspect = { runId: 'run1', stateDirectory: f.dir, task: { id: 'first' }, attempt: { id: 'a1' } };
  await writeFile(path.join(f.work, '123456789001-inspect.json'), JSON.stringify({ ok: true, data: inspect }));
  await writeFile(path.join(f.work, '123456789002-inspect.json'), JSON.stringify({ ok: true, data: { ...inspect, attempt: { id: 'wrong' } } }));
  await writeFile(path.join(f.work, '123456789002-status.json'), 'user attachment');
  await writeFile(path.join(f.work, 'notes-status.json'), f.status);
  await mkdir(path.join(f.work, 'worktree'));
  await writeFile(path.join(f.work, 'worktree', '123456789002-status.json'), f.status);
  await writeFile(path.join(f.base, 'outside'), f.status);
  await symlink(path.join(f.base, 'outside'), path.join(f.work, '123456789004-status.json'));
  await link(path.join(f.base, 'outside'), path.join(f.work, '123456789005-status.json'));
  const audit = await f.service.audit();
  assert.deepEqual(audit.items.filter(i => i.reclaimable).map(i => path.basename(i.label)).sort(), ['123456789000-status.json', '123456789001-inspect.json']);
  assert.equal(audit.reclaimableBytes, (await lstat(f.file)).blocks * 512 + (await lstat(path.join(f.work, '123456789001-inspect.json'))).blocks * 512);
  assert.equal(audit.totalBytes, audit.reclaimableBytes + audit.protectedBytes);
  assert.equal(audit.totalBytes, audit.items.reduce((n, i) => n + i.bytes, 0));
  for (const id of [f.file, audit.items.find(i => !i.reclaimable).id]) await assert.rejects(f.service.plan(id), { code: 'storage_ineligible' });
  const candidate = audit.items.find(i => i.label.endsWith('000-status.json'));
  const plan = await f.service.plan(candidate.id);
  assert.deepEqual(await f.service.execute(plan.id), { releasedBytes: candidate.bytes });
  await assert.rejects(lstat(f.file), { code: 'ENOENT' });
  await assert.rejects(f.service.execute(plan.id), { code: 'storage_plan_expired' });
  assert.equal(await readFile(path.join(f.base, 'outside'), 'utf8'), f.status);
});

test('plans reject a replaced file, symlinked ancestor or changed run', async t => {
  for (const change of ['file', 'ancestor', 'run']) {
    const f = await fixture(t);
    const audit = await f.service.audit();
    const plan = await f.service.plan(audit.items.find(i => i.reclaimable).id);
    if (change === 'file') {
      await rename(f.file, f.file + '.old');
      await writeFile(f.file, f.status);
    } else if (change === 'ancestor') {
      await rename(f.work, path.join(f.base, 'away'));
      await symlink(path.join(f.base, 'away'), f.work);
    } else {
      await writeFile(f.authoritative, JSON.stringify({ ...f.record, closedAt: null }));
    }
    await assert.rejects(f.service.execute(plan.id), { code: 'storage_changed' });
    assert.equal(await readFile(f.file, 'utf8'), f.status);
    if (change !== 'file') assert.equal((await f.service.audit()).reclaimableBytes, 0);
  }
});

test('audit persists bounded UTC daily history and coalesces overlapping requests', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.service.audit(), f.service.audit()]);
  assert.equal(a, b);
  const history = Array.from({ length: 31 }, (_, i) => ({ day: '2000-01-' + String(i + 1).padStart(2, '0'), bytes: i }));
  await writeFile(path.join(f.root, '.storage-monitor', 'history.json'), JSON.stringify(history));
  const refreshed = await new StorageService(f.root).audit();
  assert.equal(refreshed.history.length, 30);
  assert.deepEqual(refreshed.history[0], history[2]);
  assert.deepEqual(refreshed.history.at(-1), { day: new Date().toISOString().slice(0, 10), bytes: refreshed.totalBytes });
});

test('oversized and mismatched exports stay protected and a timed-out plan retains its file', async t => {
  const f = await fixture(t);
  const oversized = path.join(f.work, '101010101010-status.json');
  await writeFile(oversized, '');
  await truncate(oversized, 65 * 1024 * 1024);
  const mismatched = JSON.parse(f.status);
  mismatched.data.stateDirectory = f.base;
  await writeFile(path.join(f.work, '101010101011-status.json'), JSON.stringify(mismatched));
  const audit = await f.service.audit();
  const eligible = audit.items.filter(item => item.reclaimable);
  assert.equal(eligible.length, 1);
  const plan = await f.service.plan(eligible[0].id);
  const deadline = Date.now() + 61_000;
  t.mock.method(Date, 'now', () => deadline);
  await assert.rejects(f.service.execute(plan.id), { code: 'storage_plan_expired' });
  assert.equal(await readFile(f.file, 'utf8'), f.status);
});
