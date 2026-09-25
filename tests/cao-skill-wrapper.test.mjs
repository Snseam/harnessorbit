import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installCaoSkill } from '../src/skills.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('installed skill wrapper resolves its physical checkout and preserves project argv/cwd', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-wrapper-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, '项目 with spaces');
  const skillsDir = path.join(root, 'skills with spaces');
  await fs.mkdir(project);
  const installed = await installCaoSkill({ skillsDir });
  const script = path.join(installed.skillPath, 'scripts/cao.mjs');
  const run = args => spawnSync(process.execPath, ['--preserve-symlinks-main', script, ...args], { cwd: project, encoding:'utf8' });

  const located = run(['--paths']);
  assert.equal(located.status, 0, located.stderr);
  const paths = JSON.parse(located.stdout);
  assert.equal(paths.repository, await fs.realpath(repository));
  await fs.access(paths.profilesGuide);
  await fs.access(paths.workflow);

  const enabled = run(['mode', 'enable', '--thread', 'wrapper-test', '--project', '.', '--state-dir', path.join(root, 'state'), '--max-parallel', '3']);
  assert.equal(enabled.status, 0, enabled.stderr);
  const mode = JSON.parse(enabled.stdout).data;
  assert.equal(mode.project, await fs.realpath(project));
  assert.equal(mode.maxParallel, 3);
  assert.equal(mode.enabled, true);
  assert.deepEqual(await fs.readdir(project), []);

  const rejected = run(['mode', 'enable', '--thread', 'bad$(touch injected)', '--state-dir', path.join(root, 'state')]);
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stderr).error.code, 'invalid_thread');
  assert.deepEqual(await fs.readdir(project), []);
});

test('README install paste uses exact-path stats and SKILL locate stays loaded-dir plus --paths', async () => {
  const readme = await fs.readFile(path.join(repository, 'README.md'), 'utf8');
  const readmeZh = await fs.readFile(path.join(repository, 'README.zh-CN.md'), 'utf8');
  const skill = await fs.readFile(path.join(repository, 'skills/cao/SKILL.md'), 'utf8');
  assert.match(readme, /\$CODEX_HOME\/skills\/cao/);
  assert.match(readme, /~\/\.codex\/skills\/cao/);
  assert.match(readme, /~\/\.agents\/skills\/cao/);
  assert.match(readme, /Do not list parent directories/);
  assert.match(readme, /Do not walk ~\/\.codex\/sessions/);
  assert.match(readme, /Do not open jsonl or sqlite/);
  assert.doesNotMatch(readme, /Find and reuse my local CAO checkout/);
  assert.doesNotMatch(readme, /Read its README\.md and skills\/cao\/SKILL\.md/);
  assert.match(readmeZh, /\$CODEX_HOME\/skills\/cao/);
  assert.match(readmeZh, /不要列出父目录/);
  assert.match(readmeZh, /不要遍历 ~\/\.codex\/sessions/);
  assert.doesNotMatch(readmeZh, /先查找并复用本机已有的 CAO 仓库/);
  assert.doesNotMatch(skill, /\$CODEX_HOME\/skills\/cao/);
  assert.doesNotMatch(skill, /~\/\.codex\/skills\/cao/);
  assert.doesNotMatch(skill, /~\/\.agents\/skills\/cao/);
  assert.match(skill, /loaded `SKILL\.md`/);
  assert.match(skill, /--paths/);
});
