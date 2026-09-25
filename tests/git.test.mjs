import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  applyPatch,
  changedPaths,
  createWorktree,
  getProjectInfo,
  makePatch,
  removeWorktree,
  snapshot,
  snapshotTree,
} from '../src/git.mjs';
import { OrchestratorError } from '../src/errors.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repo() {
  const directory = mkdtempSync(join(tmpdir(), 'cao-git-test-'));
  git(directory, ['init']);
  git(directory, ['config', 'user.name', 'Test User']);
  git(directory, ['config', 'user.email', 'test@example.com']);
  return directory;
}

function commitAll(directory, message = 'commit') {
  git(directory, ['add', '-A']);
  git(directory, ['commit', '-m', message]);
}

function cleanup(directory) {
  rmSync(directory, { recursive: true, force: true });
}

function stagedFingerprint(directory) {
  return git(directory, ['diff', '--cached', '--name-status']);
}

function assertOrchestratorCode(fn, code) {
  assert.throws(fn, (error) => error instanceof OrchestratorError && error.code === code);
}

test('getProjectInfo resolves the worktree root, head, and dirty state', () => {
  const directory = repo();
  try {
    writeFileSync(join(directory, 'file.txt'), 'hello\n');
    commitAll(directory);

    const clean = getProjectInfo(join(directory, 'file.txt'));
    assert.equal(clean.root, realpathSync(resolve(directory)));
    assert.match(clean.head, /^[0-9a-f]{40}$/);
    assert.equal(clean.dirty, false);

    writeFileSync(join(directory, 'new.txt'), 'dirty\n');
    assert.equal(getProjectInfo(directory).dirty, true);
  } finally {
    cleanup(directory);
  }
});

test('snapshot and changedPaths cover tracked, untracked, deleted, binary, executable, and symlink changes', { skip: process.platform === 'win32' }, () => {
  const directory = repo();
  try {
    writeFileSync(join(directory, '.gitignore'), 'ignored.bin\n');
    writeFileSync(join(directory, 'tracked.txt'), 'one\n');
    writeFileSync(join(directory, 'deleted.txt'), 'bye\n');
    writeFileSync(join(directory, 'binary.dat'), Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(directory, 'script.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(join(directory, 'script.sh'), 0o755);
    symlinkSync('tracked.txt', join(directory, 'link.txt'));
    commitAll(directory);

    const before = snapshot(directory);
    assert.equal(before.files['script.sh'].mode, '100755');
    assert.equal(before.files['link.txt'].type, 'symlink');
    assert.equal(before.files['binary.dat'].type, 'file');

    writeFileSync(join(directory, 'tracked.txt'), 'two\n');
    rmSync(join(directory, 'deleted.txt'));
    writeFileSync(join(directory, 'binary.dat'), Buffer.from([0, 9, 2, 255, 7]));
    chmodSync(join(directory, 'script.sh'), 0o644);
    rmSync(join(directory, 'link.txt'));
    symlinkSync('binary.dat', join(directory, 'link.txt'));
    writeFileSync(join(directory, 'untracked.txt'), 'new\n');
    writeFileSync(join(directory, 'ignored.bin'), 'ignore me\n');

    const after = snapshot(directory);
    assert.equal(after.files['script.sh'].mode, '100644');
    assert.equal(after.files['link.txt'].type, 'symlink');
    assert.equal(after.files['ignored.bin'], undefined);
    assert.deepEqual(changedPaths(before, after), [
      'binary.dat',
      'deleted.txt',
      'link.txt',
      'script.sh',
      'tracked.txt',
      'untracked.txt',
    ]);
  } finally {
    cleanup(directory);
  }
});

test('makePatch captures full worktree changes without modifying the real index, and applyPatch applies them', { skip: process.platform === 'win32' }, () => {
  const directory = repo();
  const parent = mkdtempSync(join(tmpdir(), 'cao-git-worktree-'));
  try {
    writeFileSync(join(directory, 'text.txt'), 'base\n');
    writeFileSync(join(directory, 'delete-me.txt'), 'delete\n');
    writeFileSync(join(directory, 'binary.dat'), Buffer.from([1, 2, 3]));
    writeFileSync(join(directory, 'run.sh'), '#!/bin/sh\necho base\n');
    chmodSync(join(directory, 'run.sh'), 0o644);
    commitAll(directory);

    const worktree = createWorktree(directory, join(parent, 'work'), getProjectInfo(directory).head);
    writeFileSync(join(worktree, 'text.txt'), 'changed\n');
    rmSync(join(worktree, 'delete-me.txt'));
    writeFileSync(join(worktree, 'binary.dat'), Buffer.from([9, 8, 7, 0]));
    writeFileSync(join(worktree, 'added.txt'), 'added\n');
    chmodSync(join(worktree, 'run.sh'), 0o755);

    assert.equal(git(worktree, ['diff', '--cached', '--name-only']), '');
    const patchPath = join(parent, 'changes.patch');
    makePatch(worktree, patchPath);
    assert.equal(git(worktree, ['diff', '--cached', '--name-only']), '');

    const patch = readFileSync(patchPath, 'utf8');
    assert.match(patch, /GIT binary patch|Binary files/);
    assert.match(patch, /new file mode 100644/);
    assert.match(patch, /deleted file mode 100644/);
    assert.match(patch, /old mode 100644\nnew mode 100755/);

    applyPatch(directory, patchPath);
    assert.equal(readFileSync(join(directory, 'text.txt'), 'utf8'), 'changed\n');
    assert.equal(readFileSync(join(directory, 'added.txt'), 'utf8'), 'added\n');
    assert.equal(existsSync(join(directory, 'delete-me.txt')), false);
    assert.deepEqual([...readFileSync(join(directory, 'binary.dat'))], [9, 8, 7, 0]);
    assert.equal((git(directory, ['status', '--porcelain=v1']).match(/run\.sh/) ?? []).length, 1);
  } finally {
    cleanup(directory);
    cleanup(parent);
  }
});

test('removeWorktree refuses dirty or untracked worktrees and removes clean ones', () => {
  const directory = repo();
  const parent = mkdtempSync(join(tmpdir(), 'cao-git-remove-'));
  try {
    writeFileSync(join(directory, 'file.txt'), 'base\n');
    commitAll(directory);
    const worktree = createWorktree(directory, join(parent, 'work'), getProjectInfo(directory).head);

    writeFileSync(join(worktree, 'untracked.txt'), 'keep me\n');
    assert.throws(() => removeWorktree(directory, worktree), OrchestratorError);
    assert.equal(existsSync(worktree), true);

    rmSync(join(worktree, 'untracked.txt'));
    removeWorktree(directory, worktree);
    assert.equal(existsSync(worktree), false);
  } finally {
    cleanup(directory);
    cleanup(parent);
  }
});

test('applyPatch checks conflicts before applying and leaves target files unchanged', () => {
  const directory = repo();
  const parent = mkdtempSync(join(tmpdir(), 'cao-git-conflict-'));
  try {
    writeFileSync(join(directory, 'file.txt'), 'base\n');
    commitAll(directory);

    const worktree = createWorktree(directory, join(parent, 'work'), getProjectInfo(directory).head);
    writeFileSync(join(worktree, 'file.txt'), 'from patch\n');
    const patchPath = join(parent, 'conflict.patch');
    makePatch(worktree, patchPath);

    writeFileSync(join(directory, 'file.txt'), 'local conflict\n');
    assert.throws(() => applyPatch(directory, patchPath), OrchestratorError);
    assert.equal(readFileSync(join(directory, 'file.txt'), 'utf8'), 'local conflict\n');
  } finally {
    cleanup(directory);
    cleanup(parent);
  }
});

test('git commands ignore inherited repository override environment', () => {
  const directory = repo();
  const poison = repo();
  const previous = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
  };

  try {
    writeFileSync(join(directory, 'target.txt'), 'target\n');
    commitAll(directory);
    writeFileSync(join(poison, 'poison.txt'), 'poison\n');
    commitAll(poison);

    process.env.GIT_DIR = join(poison, '.git');
    process.env.GIT_WORK_TREE = poison;
    process.env.GIT_INDEX_FILE = join(poison, 'not-the-index');

    assert.equal(getProjectInfo(directory).root, realpathSync(directory));
    assert.deepEqual(Object.keys(snapshot(directory).files), ['target.txt']);

    writeFileSync(join(directory, 'target.txt'), 'changed\n');
    const patchPath = join(mkdtempSync(join(tmpdir(), 'cao-git-env-')), 'change.patch');
    makePatch(directory, patchPath);
    assert.match(readFileSync(patchPath, 'utf8'), /target\.txt/);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    cleanup(directory);
    cleanup(poison);
  }
});

test('snapshot refuses tracked paths that pass through symlink ancestors', { skip: process.platform === 'win32' }, () => {
  const directory = repo();
  const outside = mkdtempSync(join(tmpdir(), 'cao-git-outside-'));
  try {
    mkdirSync(join(directory, 'dir'));
    writeFileSync(join(directory, 'dir', 'file.txt'), 'inside\n');
    commitAll(directory);

    rmSync(join(directory, 'dir'), { recursive: true, force: true });
    writeFileSync(join(outside, 'file.txt'), 'outside secret\n');
    symlinkSync(outside, join(directory, 'dir'));

    assertOrchestratorCode(() => snapshot(directory), 'symlink_ancestor');
  } finally {
    cleanup(directory);
    cleanup(outside);
  }
});

test('snapshot and makePatch treat cacheinfo gitlinks as opaque pointers', () => {
  const directory = repo();
  const parent = mkdtempSync(join(tmpdir(), 'cao-git-submodule-'));
  try {
    writeFileSync(join(directory, 'file.txt'), 'base\n');
    commitAll(directory);
    const head = getProjectInfo(directory).head;
    git(directory, ['update-index', '--add', '--cacheinfo', '160000', head, 'vendor']);
    const indexBefore = stagedFingerprint(directory);

    const recorded = snapshot(directory);
    assert.equal(recorded.files.vendor.type, 'gitlink');
    assert.equal(recorded.files.vendor.mode, '160000');
    assert.equal(stagedFingerprint(directory), indexBefore);

    const patchPath = join(parent, 'submodule.patch');
    makePatch(directory, patchPath);
    assert.equal(existsSync(patchPath), true);
    assert.equal(stagedFingerprint(directory), indexBefore);
  } finally {
    cleanup(directory);
    cleanup(parent);
  }
});

test('committed leftover gitlink that is not a listed worktree still snapshots', () => {
  const directory = repo();
  const parent = mkdtempSync(join(tmpdir(), 'cao-git-leftover-gitlink-'));
  try {
    writeFileSync(join(directory, 'file.txt'), 'base\n');
    commitAll(directory);
    const head = getProjectInfo(directory).head;
    mkdirSync(join(directory, '.claude', 'worktrees', 'bug-audit'), { recursive: true });
    git(directory, ['update-index', '--add', '--cacheinfo', '160000', head, '.claude/worktrees/bug-audit']);
    git(directory, ['commit', '-m', 'leftover gitlink']);

    const listed = git(directory, ['worktree', 'list', '--porcelain']);
    assert.equal(listed.includes('.claude/worktrees/bug-audit'), false);

    const recorded = snapshot(directory);
    assert.equal(recorded.files['.claude/worktrees/bug-audit'].type, 'gitlink');
    assert.equal(recorded.files['.claude/worktrees/bug-audit'].mode, '160000');

    const baseTree = snapshotTree(directory);
    const trees = git(directory, ['ls-tree', '-r', baseTree]);
    assert.equal(/160000/.test(trees), false);
    assert.equal(git(directory, ['cat-file', '-t', baseTree]).trim(), 'tree');

    const worktree = createWorktree(directory, join(parent, 'work'), getProjectInfo(directory).head, baseTree);
    const candidate = snapshot(worktree);
    assert.equal(candidate.files['.claude/worktrees/bug-audit'], undefined);
  } finally {
    cleanup(directory);
    cleanup(parent);
  }
});

test('snapshot, makePatch, and empty applyPatch preserve the existing index', () => {
  const directory = repo();
  const parent = mkdtempSync(join(tmpdir(), 'cao-git-index-'));
  try {
    writeFileSync(join(directory, 'base.txt'), 'base\n');
    commitAll(directory);

    writeFileSync(join(directory, 'staged.txt'), 'staged\n');
    git(directory, ['add', 'staged.txt']);
    const beforeSnapshot = stagedFingerprint(directory);
    snapshot(directory);
    assert.equal(stagedFingerprint(directory), beforeSnapshot);

    git(directory, ['config', 'diff.external', '/bin/false']);
    const patchPath = join(parent, 'index.patch');
    makePatch(directory, patchPath);
    assert.equal(stagedFingerprint(directory), beforeSnapshot);
    assert.match(readFileSync(patchPath, 'utf8'), /staged\.txt/);

    const emptyPatch = join(parent, 'empty.patch');
    writeFileSync(emptyPatch, '');
    applyPatch(directory, emptyPatch);
    assert.equal(stagedFingerprint(directory), beforeSnapshot);
  } finally {
    cleanup(directory);
    cleanup(parent);
  }
});

test('snapshotTree seeds dirty user baseline so patches contain only worker changes', () => {
  const directory = repo();
  const parent = mkdtempSync(join(tmpdir(), 'cao-git-tree-baseline-'));
  try {
    writeFileSync(join(directory, 'tracked.txt'), 'head tracked\n');
    writeFileSync(join(directory, 'untouched.txt'), 'head untouched\n');
    commitAll(directory);

    writeFileSync(join(directory, 'tracked.txt'), 'user tracked baseline\n');
    writeFileSync(join(directory, 'user-untracked.txt'), 'user untracked baseline\n');
    writeFileSync(join(directory, 'staged.txt'), 'user staged baseline\n');
    git(directory, ['add', 'staged.txt']);
    const sourceIndexBefore = stagedFingerprint(directory);

    const baseTree = snapshotTree(directory);
    assert.match(baseTree, /^[0-9a-f]{40,64}$/);
    assert.equal(git(directory, ['cat-file', '-t', baseTree]).trim(), 'tree');
    assert.equal(stagedFingerprint(directory), sourceIndexBefore);

    const head = getProjectInfo(directory).head;
    const worktree = createWorktree(directory, join(parent, 'work'), head, baseTree);
    assert.equal(readFileSync(join(worktree, 'tracked.txt'), 'utf8'), 'user tracked baseline\n');
    assert.equal(readFileSync(join(worktree, 'user-untracked.txt'), 'utf8'), 'user untracked baseline\n');
    assert.equal(readFileSync(join(worktree, 'staged.txt'), 'utf8'), 'user staged baseline\n');

    const worktreeIndexBefore = stagedFingerprint(worktree);
    writeFileSync(join(worktree, 'tracked.txt'), 'worker tracked change\n');
    writeFileSync(join(worktree, 'user-untracked.txt'), 'worker changed prior untracked\n');
    writeFileSync(join(worktree, 'worker-added.txt'), 'worker added file\n');

    const patchPath = join(parent, 'worker.patch');
    makePatch(worktree, patchPath, baseTree);
    assert.equal(stagedFingerprint(worktree), worktreeIndexBefore);

    const patch = readFileSync(patchPath, 'utf8');
    assert.match(patch, /tracked\.txt/);
    assert.match(patch, /user-untracked\.txt/);
    assert.match(patch, /worker-added\.txt/);
    assert.doesNotMatch(patch, /staged\.txt/);
    assert.doesNotMatch(patch, /untouched\.txt/);

    applyPatch(directory, patchPath);
    assert.equal(readFileSync(join(directory, 'tracked.txt'), 'utf8'), 'worker tracked change\n');
    assert.equal(readFileSync(join(directory, 'user-untracked.txt'), 'utf8'), 'worker changed prior untracked\n');
    assert.equal(readFileSync(join(directory, 'worker-added.txt'), 'utf8'), 'worker added file\n');
    assert.equal(readFileSync(join(directory, 'staged.txt'), 'utf8'), 'user staged baseline\n');
    assert.equal(stagedFingerprint(directory), sourceIndexBefore);
  } finally {
    cleanup(directory);
    cleanup(parent);
  }
});
