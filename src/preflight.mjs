import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import * as git from './git.mjs';
import { invariant } from './errors.mjs';
import { assessScope } from './task.mjs';

// Resolve executables without starting an agent, authenticating, or executing a shell.
export async function executableAvailable(binary, { cwd = process.cwd(), env = process.env } = {}) {
  if (typeof binary !== 'string' || !binary || binary.includes('\0')) return false;
  const hasPath = path.isAbsolute(binary) || binary.includes('/') || binary.includes('\\');
  const candidates = hasPath ? [path.resolve(cwd, binary)] : (env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(cwd, dir, binary));
  for (const candidate of candidates) {
    const names = process.platform === 'win32' && !path.extname(candidate)
      ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map(ext => candidate + ext)
      : [candidate];
    for (const name of names) {
      try {
        if (!(await fs.stat(name)).isFile()) continue;
        await fs.access(name, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return true;
      } catch { /* Try the next executable, never expose environment values. */ }
    }
  }
  return false;
}

export async function preflightProject({ project, task, runtime }) {
  invariant(!task.deadlineAt || Date.parse(task.deadlineAt) > Date.now(), 'deadline_exceeded', 'Task deadline has already passed.');
  const info = await git.getProjectInfo(project);
  // Snapshot performs the same submodule/symlink checks as dispatch, without a worktree.
  const snapshot = await git.snapshot(info.root);
  const scope = assessScope(task.allowedPaths, snapshot.files);
  invariant(!scope.ambiguousDirectories.length, 'directory_scope_missing_slash', 'Directory scopes must end with a trailing slash so files under them stay in scope. Use `dir/` or list exact files.', { scope: { root: scope.root, ambiguousDirectories: scope.ambiguousDirectories, sample: scope.sample } });
  const tools = typeof runtime.preflight === 'function' ? await runtime.preflight(task.agent) : null;
  invariant(!tools || Object.values(tools).every(value => value.available), 'preflight_unavailable', 'A required runtime executable is unavailable.', { tools });
  return { checkedAt: new Date().toISOString(), project: info.root, head: info.head, snapshotHash: snapshot.hash, tools, authentication: 'not_checked', modelCall: false, scope: { root: scope.root } };
}
