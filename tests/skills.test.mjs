import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OrchestratorError } from '../src/errors.mjs';
import { installCaoSkill, statusCaoSkill, uninstallCaoSkill } from '../src/skills.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-skill-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, '源 skill with spaces');
  await fs.mkdir(path.join(source, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '# CAO\n');
  await fs.writeFile(path.join(source, 'scripts', 'cao.mjs'), '#!/usr/bin/env node\n');
  return { root, source, skillsDir: path.join(root, 'Codex Skills') };
}

test('install creates a reusable symlink and status reports source and CLI paths', async t => {
  const { source, skillsDir } = await fixture(t);

  const first = await installCaoSkill({ skillsDir, sourceDir: source });
  assert.equal(first.installed, true);
  assert.equal(first.link, true);
  assert.equal(first.reused, false);
  assert.equal(first.source, source);
  assert.equal(first.cliPath, path.join(source, 'scripts', 'cao.mjs'));
  assert.equal(first.hint.canonical, '$cao');
  assert.equal(first.hint.desktop, 'Type /HarnessOrbit, select HarnessOrbit, then send the skill mention. The legacy /CAO command remains available.');
  assert.equal(first.hint.cli, '$cao or /skills');

  const linkStats = await fs.lstat(path.join(skillsDir, 'cao'));
  assert.equal(linkStats.isSymbolicLink(), true);

  const second = await installCaoSkill({ skillsDir, sourceDir: source });
  assert.equal(second.installed, true);
  assert.equal(second.reused, true);

  const status = await statusCaoSkill({ skillsDir, sourceDir: source });
  assert.equal(status.installed, true);
  assert.equal(status.linked, true);
  assert.equal(status.usable, true);
  assert.equal(status.sourceExists, true);
  assert.equal(status.codexReloaded, false);
});

test('install refuses real paths and links to a different target', async t => {
  const { root, source, skillsDir } = await fixture(t);
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.mkdir(path.join(skillsDir, 'cao'));
  await assert.rejects(
    installCaoSkill({ skillsDir, sourceDir: source }),
    error => error instanceof OrchestratorError && error.code === 'skill_conflict',
  );

  const otherSkills = path.join(root, 'other skills');
  const otherSource = path.join(root, 'other-source');
  await fs.mkdir(otherSkills);
  await fs.mkdir(otherSource);
  await fs.symlink(otherSource, path.join(otherSkills, 'cao'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    installCaoSkill({ skillsDir: otherSkills, sourceDir: source }),
    error => error instanceof OrchestratorError && error.code === 'skill_conflict',
  );
});

test('uninstall removes only this exact source link and handles a missing source', async t => {
  const { root, source, skillsDir } = await fixture(t);
  await installCaoSkill({ skillsDir, sourceDir: source });
  await fs.rm(source, { recursive: true, force: true });

  const stale = await statusCaoSkill({ skillsDir, sourceDir: source });
  assert.equal(stale.sourceExists, false);
  assert.equal(stale.linked, true);
  assert.equal(stale.usable, false);
  assert.equal(stale.installed, false);

  const removed = await uninstallCaoSkill({ skillsDir, sourceDir: source });
  assert.equal(removed.removed, true);
  assert.equal(removed.installed, false);

  const foreignSource = path.join(root, 'foreign');
  await fs.mkdir(foreignSource);
  await fs.symlink(foreignSource, path.join(skillsDir, 'cao'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    uninstallCaoSkill({ skillsDir, sourceDir: source }),
    error => error instanceof OrchestratorError && error.code === 'skill_conflict',
  );
});

test('install validates the source bundle before creating links', async t => {
  const { root, skillsDir } = await fixture(t);
  const missing = path.join(root, 'missing-source');
  await assert.rejects(
    installCaoSkill({ skillsDir, sourceDir: missing }),
    error => error instanceof OrchestratorError && error.code === 'skill_source_missing',
  );
  await assert.rejects(fs.lstat(path.join(skillsDir, 'cao')), { code: 'ENOENT' });

  const empty = path.join(root, 'empty-source');
  await fs.mkdir(empty);
  await assert.rejects(
    installCaoSkill({ skillsDir, sourceDir: empty }),
    error => error instanceof OrchestratorError && error.code === 'skill_source_invalid',
  );

  const incomplete = path.join(root, 'incomplete-source');
  await fs.mkdir(incomplete);
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.symlink(incomplete, path.join(skillsDir, 'cao'), process.platform === 'win32' ? 'junction' : 'dir');
  const status = await statusCaoSkill({ skillsDir, sourceDir: incomplete });
  assert.equal(status.linked, true);
  assert.equal(status.usable, false);
  assert.equal(status.installed, false);
  assert.match(status.sourceInvalid.join('\n'), /SKILL\.md/);
  assert.match(status.sourceInvalid.join('\n'), /scripts\/cao\.mjs/);
});

test('install refuses recursive targets inside the source, including symlinked parent paths', async t => {
  const { root, source } = await fixture(t);

  await assert.rejects(
    installCaoSkill({ skillsDir: path.join(source, 'nested-skills'), sourceDir: source }),
    error => error instanceof OrchestratorError && error.code === 'skill_target_recursive',
  );

  const alias = path.join(root, 'source-alias');
  await fs.symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(
    installCaoSkill({ skillsDir: path.join(alias, 'nested-skills'), sourceDir: source }),
    error => error instanceof OrchestratorError && error.code === 'skill_target_recursive',
  );
});
