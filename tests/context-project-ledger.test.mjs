import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { contextDigest, createContextPacket } from '../src/context-packet.mjs';
import { ProjectLedger, initProjectLedger } from '../src/project-ledger.mjs';

async function gitProject(t) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-context-project-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', project]);
  execFileSync('git', ['-C', project, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', project, 'config', 'user.name', 'CAO Test']);
  await fs.mkdir(path.join(project, 'src'));
  await fs.writeFile(path.join(project, 'src', 'index.js'), 'export const answer = 42;\n');
  await fs.writeFile(path.join(project, 'README.md'), '# test\n');
  execFileSync('git', ['-C', project, 'add', '.']);
  execFileSync('git', ['-C', project, 'commit', '-qm', 'fixture']);
  return project;
}

test('ContextPacket contains bounded Git provenance and no file contents', async t => {
  const project = await gitProject(t);
  const packet = createContextPacket({ project, includePaths: ['src/'], now: () => '2026-09-24T00:00:00.000Z' });
  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.project.root, await fs.realpath(project));
  assert.equal(packet.files['src/index.js'].type, 'file');
  assert.equal(packet.files['README.md'], undefined);
  assert.equal(packet.provenance[0].source, 'git.snapshot');
  assert.match(contextDigest(packet), /^[a-f0-9]{64}$/);
  assert.equal(packet.packetDigest, contextDigest(packet));
  assert.ok(!JSON.stringify(packet).includes('answer = 42'));
});

test('ProjectLedger is external, append-only bounded and records context and decisions', async t => {
  const project = await gitProject(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-ledger-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const initialized = await initProjectLedger({ root, project });
  assert.equal(initialized.ledger.schemaVersion, 1);
  assert.equal(initialized.ledger.entries.length, 2);
  assert.equal(initialized.ledger.entries[0].type, 'project.initialized');
  assert.equal(initialized.ledger.entries[1].type, 'context.packet');
  const ledger = new ProjectLedger({ root, project });
  await ledger.recordDecision({ provider: { id: 'deterministic' }, inputDigest: 'a'.repeat(64), fallback: { used: true } });
  await ledger.append({ type: 'test.metadata', metadata: { safe: 'kept', prompt: 'private prompt', nested: { token: 'private token' } } });
  const loaded = await ledger.load();
  assert.equal(loaded.entries.at(-2).type, 'decision.receipt');
  assert.ok(loaded.entries.every(entry => !JSON.stringify(entry).includes('private prompt')));
  assert.ok(loaded.entries.every(entry => !JSON.stringify(entry).includes('private token')));
  assert.equal(loaded.project, await fs.realpath(project));
});

test('ProjectLedger refuses state roots inside the project working tree', async t => {
  const project = await gitProject(t);
  const stateTarget = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-ledger-state-target-'));
  t.after(() => fs.rm(stateTarget, { recursive: true, force: true }));
  const symlinkRoot = path.join(os.tmpdir(), `cao-ledger-state-link-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.symlink(project, symlinkRoot);
  t.after(() => fs.unlink(symlinkRoot).catch(() => {}));
  assert.throws(
    () => new ProjectLedger({ root: path.join(project, '.cao-state'), project }),
    error => error.code === 'state_inside_project',
  );
  assert.throws(
    () => new ProjectLedger({ root: symlinkRoot, project }),
    error => error.code === 'state_inside_project',
  );
  assert.doesNotThrow(() => new ProjectLedger({ root: stateTarget, project }));
});

test('ProjectLedger refuses a symlinked project-key directory', async t => {
  const project = await gitProject(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-ledger-state-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-ledger-outside-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const ledger = new ProjectLedger({ root, project });
  await fs.mkdir(path.dirname(path.dirname(ledger.file)), { recursive: true });
  await fs.symlink(outside, path.dirname(ledger.file));
  await assert.rejects(() => ledger.append({ type: 'test.symlink' }), error => ['ledger_path_symlink', 'ledger_path_escape'].includes(error.code));
  assert.equal((await fs.readdir(outside)).length, 0);
});

test('ProjectLedger validates persisted identity and preserves append-only history at its bound', async t => {
  const project = await gitProject(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-ledger-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ledger = new ProjectLedger({ root, project });
  await fs.mkdir(path.dirname(ledger.file), { recursive: true });
  await fs.writeFile(ledger.file, JSON.stringify({ schemaVersion: 999, project, projectKey: 'wrong', entries: [] }));
  await assert.rejects(() => ledger.load(), error => error.code === 'ledger_invalid_file');

  await fs.rm(ledger.file);
  for (let i = 0; i < 256; i += 1) await ledger.append({ type: `entry.${String(i).padStart(3, '0')}` });
  const loaded = await ledger.load();
  assert.equal(loaded.entries.length, 256);
  assert.equal(loaded.entries[0].type, 'entry.000');
  await assert.rejects(() => ledger.append({ type: 'entry.overflow' }), error => error.code === 'ledger_full');
  assert.equal((await ledger.load()).entries[0].type, 'entry.000');
});
