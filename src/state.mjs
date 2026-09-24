import { constants as fsConstants } from 'node:fs';
import { appendFile, mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { OrchestratorError } from './errors.mjs';
import { normalizeRuntimeEvent } from './runtime-contract.mjs';

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function stateError(code, message, details = {}) {
  return new OrchestratorError(code, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function fsyncPath(file) {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (error?.code !== 'EINVAL' && error?.code !== 'ENOENT') throw error;
  } finally {
    await handle?.close();
  }
}

export async function readJson(file, { optional = false } = {}) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw stateError('state_read_failed', `Failed to read JSON file: ${file}`, { file, cause: error.message });
  }

  try {
    const value = JSON.parse(text);
    if (!isPlainObject(value)) {
      throw stateError('state_invalid_json', `JSON file must contain an object: ${file}`, { file });
    }
    return value;
  } catch (error) {
    if (error instanceof OrchestratorError) throw error;
    throw stateError('state_invalid_json', `Failed to parse JSON file: ${file}`, { file, cause: error.message });
  }
}

export async function writeJsonAtomic(file, value) {
  if (!isPlainObject(value)) {
    throw stateError('state_invalid_json', 'writeJsonAtomic value must be an object', { file });
  }

  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const name = path.basename(file);
  const temp = path.join(directory, `.${name}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;

  try {
    const handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(bytes, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
    await fsyncPath(directory);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw stateError('state_write_failed', `Failed to write JSON file atomically: ${file}`, {
      file,
      cause: error.message,
    });
  }
}

function lockOwnerPath(lockDirectory) {
  return path.join(lockDirectory, 'owner.json');
}

function lockReaperPath(lockDirectory) {
  return path.join(lockDirectory, '.reaper');
}

function ownerMatches(a, b) {
  return a?.pid === b?.pid && a?.hostname === b?.hostname && a?.nonce === b?.nonce;
}

function pidIsDefinitelyDead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

async function readLockOwner(lockDirectory) {
  try {
    return await readJson(lockOwnerPath(lockDirectory), { optional: true });
  } catch {
    return null;
  }
}

async function recoverDeadLock(lockDirectory, observedOwner) {
  if (!observedOwner || observedOwner.hostname !== os.hostname()) return false;
  if (!pidIsDefinitelyDead(observedOwner.pid)) return false;

  const reaper = lockReaperPath(lockDirectory);
  try {
    await mkdir(reaper, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOENT') return false;
    throw stateError('lock_recovery_failed', `Failed to mark stale lock for recovery: ${lockDirectory}`, {
      lockDirectory,
      cause: error.message,
    });
  }

  const tombstone = `${lockDirectory}.stale-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const currentOwner = await readLockOwner(lockDirectory);
    if (!ownerMatches(observedOwner, currentOwner)) return false;
    if (!pidIsDefinitelyDead(currentOwner.pid)) return false;

    await rename(lockDirectory, tombstone);
    await rm(tombstone, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw stateError('lock_recovery_failed', `Failed to recover stale lock: ${lockDirectory}`, {
      lockDirectory,
      cause: error.message,
    });
  } finally {
    await rm(tombstone, { recursive: true, force: true }).catch(() => {});
  }
}

async function tryAcquireLock(lockDirectory) {
  const owner = {
    pid: process.pid,
    hostname: os.hostname(),
    nonce: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
  };

  try {
    await mkdir(lockDirectory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw stateError('lock_failed', `Failed to create lock directory: ${lockDirectory}`, {
        lockDirectory,
        cause: error.message,
      });
    }
    return null;
  }

  try {
    await writeJsonAtomic(lockOwnerPath(lockDirectory), owner);
    return owner;
  } catch (error) {
    await rm(lockDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function withLock(lockDirectory, fn, { timeoutMs = 5000 } = {}) {
  if (typeof fn !== 'function') {
    throw stateError('lock_invalid', 'withLock requires an async function', { lockDirectory });
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw stateError('lock_invalid', 'timeoutMs must be a non-negative integer', { timeoutMs });
  }

  const deadline = Date.now() + timeoutMs;
  let owner = null;
  await mkdir(path.dirname(lockDirectory), { recursive: true, mode: 0o700 });

  while (!owner) {
    owner = await tryAcquireLock(lockDirectory);
    if (owner) break;

    const observedOwner = await readLockOwner(lockDirectory);
    await recoverDeadLock(lockDirectory, observedOwner);

    if (Date.now() >= deadline) {
      throw stateError('lock_timeout', `Timed out waiting for lock: ${lockDirectory}`, {
        lockDirectory,
        timeoutMs,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(5, deadline - Date.now()))));
  }

  try {
    return await fn();
  } finally {
    const currentOwner = await readLockOwner(lockDirectory);
    if (ownerMatches(owner, currentOwner)) {
      await rm(lockDirectory, { recursive: true, force: true });
    }
  }
}

export function validateId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw stateError('invalid_id', 'Invalid id', { id });
  }
  return id;
}

export function runPath(root, id) {
  return path.join(root, 'runs', validateId(id));
}

export async function loadRun(root, id) {
  return readJson(path.join(runPath(root, id), 'run.json'), { optional: true });
}

export async function saveRun(root, run) {
  if (!isPlainObject(run)) {
    throw stateError('invalid_run', 'Run must be an object', { run });
  }
  validateId(run.id);
  await writeJsonAtomic(path.join(runPath(root, run.id), 'run.json'), run);
  return run;
}

export async function listRuns(root) {
  const directory = path.join(root, 'runs');
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw stateError('state_read_failed', `Failed to list runs: ${directory}`, { root, cause: error.message });
  }

  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
    const run = await loadRun(root, entry.name);
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => a.id.localeCompare(b.id));
}

export async function createRun(root, run) {
  if (!isPlainObject(run)) {
    throw stateError('invalid_run', 'Run must be an object', { run });
  }
  validateId(run.id);

  const directory = runPath(root, run.id);
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  try {
    await mkdir(directory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw stateError('run_exists', `Run already exists: ${run.id}`, { id: run.id });
    }
    throw stateError('state_write_failed', `Failed to create run directory: ${directory}`, {
      id: run.id,
      cause: error.message,
    });
  }

  try {
    await saveRun(root, run);
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return run;
}

export async function appendEvent(root, runId, event) {
  validateId(runId);
  if (!isPlainObject(event)) {
    throw stateError('invalid_event', 'Event must be an object', { runId });
  }

  const directory = runPath(root, runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let normalized;
  try {
    normalized = normalizeRuntimeEvent(event, { runId, eventId: event.eventId || `${runId}:${crypto.randomUUID()}` });
  } catch (error) {
    throw stateError('invalid_event', 'Event does not satisfy the runtime contract.', { runId, cause: error.code || 'invalid_event' });
  }
  const record = { ...normalized, timestamp: new Date().toISOString() };
  await appendFile(path.join(directory, 'events.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}
