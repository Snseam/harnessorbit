import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, lstatSync, readFileSync, readlinkSync, existsSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { OrchestratorError } from './errors.mjs';

const GIT_ENV_OVERRIDES = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_QUARANTINE_PATH',
  'GIT_WORK_TREE',
];

function gitEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of GIT_ENV_OVERRIDES) delete env[name];
  return { ...env, ...overrides };
}

function git(args, { cwd, env = {} } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      env: gitEnv(env),
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = error.stderr?.toString('utf8') ?? '';
    const stdout = error.stdout?.toString('utf8') ?? '';
    throw new OrchestratorError('git_command_failed', `git ${args.join(' ')} failed`, {
      args,
      cwd,
      code: error.status ?? null,
      stdout,
      stderr,
    });
  }
}

function gitText(args, options) {
  return git(args, options).toString('utf8');
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function splitNul(output) {
  return output.split('\0').filter(Boolean);
}

function toAbsolute(path) {
  return isAbsolute(path) ? path : resolve(path);
}

function fileMode(stat, type) {
  if (type === 'symlink') return '120000';
  return (stat.mode & 0o111) !== 0 ? '100755' : '100644';
}

function assertSafeRelativePath(root, relativePath) {
  if (isAbsolute(relativePath) || relativePath.split('/').includes('..')) {
    throw new OrchestratorError('unsafe_git_path', 'Git reported an unsafe path', { root, relativePath });
  }

  const parts = relativePath.split('/').filter(Boolean);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new OrchestratorError('symlink_ancestor', 'Refusing to snapshot a path through a symlink ancestor', {
        root,
        relativePath,
        ancestor: current,
      });
    }
  }
}

function parseGitlinks(output) {
  return splitNul(output).flatMap((entry) => {
    const match = /^(160000) ([0-9a-f]+) \d+\t(.+)$/.exec(entry);
    return match ? [{ sha: match[2], path: match[3] }] : [];
  });
}

function listGitlinks(root, env = {}) {
  return parseGitlinks(gitText(['-C', root, 'ls-files', '-s', '-z'], { env }));
}

function uniqueGitlinkPaths(...groups) {
  return [...new Set(groups.flat().map((entry) => entry.path))].sort();
}

function gitlinkExcludes(paths) {
  return paths.flatMap((relativePath) => [`:(exclude)${relativePath}`, `:(exclude)${relativePath}/**`]);
}

function removeIndexPaths(root, env, paths) {
  if (paths.length === 0) return;
  git(['-C', root, 'update-index', '--force-remove', '--', ...paths], { env });
}

function addWorktreeExcept(root, env, excludedPaths) {
  git(['-C', root, 'add', '-A', '--', '.', ...gitlinkExcludes(excludedPaths)], { env });
}

function pinGitlinks(root, env, gitlinks) {
  for (const entry of gitlinks) {
    git(['-C', root, 'update-index', '--add', '--cacheinfo', '160000', entry.sha, entry.path], { env });
  }
}

function snapshotPaths(root) {
  const tracked = splitNul(gitText(['-C', root, 'ls-files', '-z']));
  const untracked = splitNul(gitText(['-C', root, 'ls-files', '--others', '--exclude-standard', '-z']));
  const relativePaths = [...new Set([...tracked, ...untracked])].sort();
  for (const relativePath of relativePaths) {
    if (relativePath === '.git' || relativePath.startsWith('.git/')) continue;
    assertSafeRelativePath(root, relativePath);
  }
  return relativePaths;
}

function withTemporaryIndex(fn) {
  const tempDirectory = mkdtempSync(resolve(tmpdir(), 'cao-git-index-'));
  const temporaryIndex = resolve(tempDirectory, 'index');
  const env = { GIT_INDEX_FILE: temporaryIndex };

  try {
    return fn(env);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

function gitCwd(project) {
  const absolute = toAbsolute(project);
  try {
    return lstatSync(absolute).isDirectory() ? absolute : dirname(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return absolute;
    throw error;
  }
}

function worktreeRoot(project) {
  const output = gitText(['-C', gitCwd(project), 'rev-parse', '--show-toplevel']).trim();
  if (!output) {
    throw new OrchestratorError('git_not_worktree', 'Project is not inside a git worktree', { project });
  }
  return realpathSync(output);
}

function assertDestinationAvailable(destination) {
  if (existsSync(destination)) {
    throw new OrchestratorError('worktree_destination_exists', 'Worktree destination already exists', { destination });
  }
}

function statusPorcelain(root) {
  return gitText(['-C', root, 'status', '--porcelain=v1', '--untracked-files=all']);
}

export function getProjectInfo(project) {
  const root = worktreeRoot(project);
  const head = gitText(['-C', root, 'rev-parse', '--verify', 'HEAD']).trim();
  const dirty = statusPorcelain(root).length > 0;
  return { root, head, dirty };
}

export function snapshot(project) {
  const root = worktreeRoot(project);
  const relativePaths = snapshotPaths(root);
  const files = {};
  const gitlinks = listGitlinks(root);
  const gitlinkPaths = new Set(gitlinks.map((entry) => entry.path));

  for (const entry of gitlinks) {
    files[entry.path] = {
      hash: hashBuffer(Buffer.from(entry.sha)),
      mode: '160000',
      type: 'gitlink',
    };
  }

  for (const relativePath of relativePaths) {
    if (relativePath === '.git' || relativePath.startsWith('.git/')) continue;
    if (gitlinkPaths.has(relativePath)) continue;

    const absolutePath = resolve(root, relativePath);
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }

    if (stat.isDirectory()) continue;

    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolutePath);
      files[relativePath] = {
        hash: hashBuffer(Buffer.from(target)),
        mode: '120000',
        type: 'symlink',
      };
      continue;
    }

    if (!stat.isFile()) continue;

    files[relativePath] = {
      hash: hashBuffer(readFileSync(absolutePath)),
      mode: fileMode(stat, 'file'),
      type: 'file',
    };
  }

  const serialized = JSON.stringify(files);
  return { hash: hashBuffer(Buffer.from(serialized)), files };
}

export function snapshotTree(project) {
  const root = worktreeRoot(project);
  snapshotPaths(root);

  return withTemporaryIndex((env) => {
    git(['-C', root, 'read-tree', 'HEAD'], { env });
    const headGitlinks = listGitlinks(root, env);
    const liveGitlinks = listGitlinks(root);
    const excluded = uniqueGitlinkPaths(headGitlinks, liveGitlinks);
    removeIndexPaths(root, env, headGitlinks.map((entry) => entry.path));
    addWorktreeExcept(root, env, excluded);
    return gitText(['-C', root, 'write-tree'], { env }).trim();
  });
}

export function changedPaths(before, after) {
  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  return [...paths].filter((path) => {
    const left = before.files[path];
    const right = after.files[path];
    return !left || !right || left.hash !== right.hash || left.mode !== right.mode || left.type !== right.type;
  }).sort();
}

export function createWorktree(project, destination, baseCommit, baseTree = undefined) {
  const info = getProjectInfo(project);
  const absoluteDestination = toAbsolute(destination);
  const commit = baseCommit ?? info.head;
  assertDestinationAvailable(absoluteDestination);

  if (info.dirty && commit !== info.head) {
    throw new OrchestratorError('dirty_source_worktree', 'Refusing to create worktree from a dirty source without an explicit current HEAD base', {
      root: info.root,
      head: info.head,
      baseCommit: commit,
    });
  }

  const addArgs = ['-C', info.root, 'worktree', 'add', '--detach'];
  if (baseTree !== undefined) addArgs.push('--no-checkout');
  addArgs.push(absoluteDestination, commit);
  git(addArgs);
  const created = realpathSync(absoluteDestination);
  if (baseTree !== undefined) {
    git(['-C', created, 'read-tree', '--reset', '-u', baseTree]);
  }
  return created;
}

export function makePatch(worktree, patchPath, baseTree = 'HEAD') {
  const root = worktreeRoot(worktree);
  snapshotPaths(root);
  const absolutePatchPath = toAbsolute(patchPath);
  mkdirSync(dirname(absolutePatchPath), { recursive: true });

  withTemporaryIndex((env) => {
    git(['-C', root, 'read-tree', baseTree], { env });
    const baseGitlinks = listGitlinks(root, env);
    const liveGitlinks = listGitlinks(root);
    addWorktreeExcept(root, env, uniqueGitlinkPaths(baseGitlinks, liveGitlinks));
    pinGitlinks(root, env, liveGitlinks);
    const patch = git(['-C', root, 'diff', '--no-ext-diff', '--cached', '--binary', baseTree], { env });
    writeFileSync(absolutePatchPath, patch);
  });

  return absolutePatchPath;
}

export function applyPatch(project, patchPath) {
  const root = worktreeRoot(project);
  const absolutePatchPath = toAbsolute(patchPath);
  if (readFileSync(absolutePatchPath).length === 0) return;
  git(['-C', root, 'apply', '--check', absolutePatchPath]);
  git(['-C', root, 'apply', absolutePatchPath]);
}

export function removeWorktree(project, worktree) {
  const projectRoot = worktreeRoot(project);
  const worktreeRootPath = worktreeRoot(worktree);
  const dirty = statusPorcelain(worktreeRootPath).length > 0;

  if (dirty) {
    throw new OrchestratorError('dirty_worktree', 'Refusing to remove dirty worktree', { worktree: worktreeRootPath });
  }

  statSync(worktreeRootPath);
  git(['-C', projectRoot, 'worktree', 'remove', worktreeRootPath]);
}
