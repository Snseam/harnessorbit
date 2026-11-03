import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const maxJsonBytes = 64 * 1024 * 1024;
const sampleDays = 30;
const privateName = '.storage-monitor';
const reasons = { runs: 'run-records', work: 'work-products', archives: 'archives', monitor: 'monitor-data', monitors: 'monitor-data', [privateName]: 'monitor-data' };
const runName = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const exportName = /^(?:\d{12}|\d{8}T\d{6})-(status|inspect)(?:-[a-f0-9]{6})?\.json$/;
const idFor = label => createHash('sha256').update(label).digest('hex').slice(0, 32);
const bytesOf = stat => Number(stat.blocks) * 512;
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join('/');
const fileStat = file => lstat(file, { bigint: true });
const fail = (code, message) => Object.assign(new Error(message), { code });
const changed = () => fail('storage_changed', 'The export or its owning run changed. Refresh the audit.');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function readBounded(file, limit, expected) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.size > limit || (expected && identity(stat) !== expected)) return null;
    const buffer = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) return null;
      offset += bytesRead;
    }
    if (identity(await handle.stat({ bigint: true })) !== identity(stat)) return null;
    return { value: JSON.parse(buffer.toString('utf8')), fingerprint: identity(stat), digest: expected ? createHash('sha256').update(buffer).digest('hex') : null };
  } finally {
    await handle.close();
  }
}

// Keep only the identity fields. Status snapshots and authoritative baselines can be tens of MiB.
async function owner(root, run) {
  const dir = path.join(root, 'runs', run);
  const file = path.join(dir, 'run.json');
  try {
    if (await realpath(dir) !== dir) return null;
    const parsed = await readBounded(file, maxJsonBytes);
    const data = parsed?.value;
    if (!data || data.id !== run || typeof data.closedAt !== 'string' || !Number.isFinite(Date.parse(data.closedAt)) || !object(data.tasks)) return null;
    const attempts = new Map(Object.entries(data.tasks).map(([key, task]) => [
      key, new Set(task?.definition?.id === key && Array.isArray(task.attempts) ? task.attempts.map(a => a.id) : []),
    ]));
    return { dir, id: run, baseline: data.baseline?.hash, attempts, fingerprint: parsed.fingerprint };
  } catch { return null; }
}

async function recognized(file, kind, run, fingerprint) {
  if (!run || await realpath(path.dirname(file)) !== path.dirname(file)) return false;
  try {
    const parsed = await readBounded(file, maxJsonBytes, fingerprint);
    const envelope = parsed?.value;
    const data = envelope?.data;
    if (envelope?.ok !== true || data?.stateDirectory !== run.dir) return false;
    if (kind === 'status') {
      return data.id === run.id && typeof run.baseline === 'string' && data.baseline?.hash === run.baseline && Array.isArray(data.tasks) && parsed.digest;
    }
    return data.runId === run.id && typeof data.attempt?.id === 'string' && run.attempts.get(data.task?.id)?.has(data.attempt.id) && parsed.digest;
  } catch { return false; }
}

async function privateDirectory(root) {
  const dir = path.join(root, privateName);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || await realpath(dir) !== dir || (stat.mode & 0o077) || stat.uid !== process.getuid()) {
    throw fail('storage_unavailable', 'Storage monitor directory is not private.');
  }
  return dir;
}

async function sample(dir, bytes) {
  const file = path.join(dir, 'history.json');
  let previous = [];
  try {
    previous = (await readBounded(file, 16 * 1024))?.value;
    if (!Array.isArray(previous) || !previous.every(p => /^\d{4}-\d{2}-\d{2}$/.test(p?.day) && Number.isSafeInteger(p.bytes) && p.bytes >= 0)) {
      throw fail('storage_unavailable', 'Invalid storage sample history.');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const today = new Date().toISOString().slice(0, 10);
  const history = [...previous.filter(p => p.day < today).slice(-(sampleDays - 1)), { day: today, bytes }];
  const temp = path.join(dir, randomUUID());
  await writeFile(temp, JSON.stringify(history), { mode: 0o600, flag: 'wx' });
  await rename(temp, file);
  return history;
}

export class StorageService {
  constructor(root) {
    this.root = path.resolve(root);
    this.candidates = new Map();
    this.plans = new Map();
  }

  async audit() {
    this.pending ||= this.scan().finally(() => { this.pending = null; });
    return this.pending;
  }

  async scan() {
    const root = this.root;
    // Allow a yet-unused state root. Normalize OS aliases (e.g. /var on macOS) once.
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await lstat(root)).isDirectory()) throw fail('storage_unavailable', 'Invalid state directory.');
    const base = await realpath(root);
    const privateDir = await privateDirectory(base);
    const candidates = new Map();
    const seen = new Set();
    const groups = new Map();
    const items = [];
    let totalBytes = 0;
    let reclaimableBytes = 0;
    const context = new Map();

    async function walk(file, parts) {
      let stat;
      try { stat = await fileStat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (stat.nlink > 1n && !stat.isDirectory()) {
        const key = stat.dev + '/' + stat.ino;
        if (seen.has(key)) return;
        seen.add(key);
      }
      const bytes = bytesOf(stat);
      totalBytes += bytes;
      const [group, run, name] = parts;
      const match = parts.length === 3 && group === 'work' && runName.test(run) && name.match(exportName);
      if (match && stat.isFile() && stat.nlink === 1n && stat.size <= maxJsonBytes) {
        if (!context.has(run)) context.set(run, await owner(base, run));
        const info = context.get(run);
        const fingerprint = identity(stat);
        const digest = await recognized(file, match[1], info, fingerprint);
        if (digest) {
          const label = parts.join('/');
          const item = { id: idFor(label), label, kind: 'command-export', bytes, reclaimable: true, reason: 'closed-run-export' };
          candidates.set(item.id, { item, base, file, run, kind: match[1], fingerprint, digest, owner: info.fingerprint });
          items.push(item);
          reclaimableBytes += bytes;
          return;
        }
      }
      groups.set(group ?? '.', (groups.get(group ?? '.') || 0) + bytes);
      if (stat.isDirectory()) {
        let children;
        try { children = await readdir(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        for (const name of children) {
          try { await walk(path.join(file, name), [...parts, name]); }
          catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
        }
      }
    }
    await walk(base, []);
    for (const [label, bytes] of groups) {
      items.push({ id: idFor(label), label, kind: 'protected-group', bytes, reclaimable: false, reason: label === '.' ? 'state-root' : (Object.hasOwn(reasons, label) ? reasons[label] : 'unrecognized') });
    }
    const history = await sample(privateDir, totalBytes);
    this.candidates = candidates;
    return { totalBytes, reclaimableBytes, protectedBytes: totalBytes - reclaimableBytes, items: items.sort((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label)), history };
  }

  async validate(entry) {
    const current = await owner(entry.base, entry.run);
    if (!current || current.fingerprint !== entry.owner || await realpath(this.root) !== entry.base) throw changed();
    const stat = await fileStat(entry.file);
    if (stat.nlink !== 1n || identity(stat) !== entry.fingerprint || await recognized(entry.file, entry.kind, current, entry.fingerprint) !== entry.digest) throw changed();
    return stat;
  }

  async plan(id) {
    const entry = this.candidates.get(id);
    if (!entry) throw fail('storage_ineligible', 'This item is protected or unknown.');
    try { await this.validate(entry); } catch { throw changed(); }
    const now = Date.now();
    for (const [key, plan] of this.plans) if (plan.until <= now) this.plans.delete(key);
    if (this.plans.size >= 128) this.plans.delete(this.plans.keys().next().value);
    const planId = randomUUID();
    this.plans.set(planId, { entry, until: now + 60_000 });
    return { id: planId, label: entry.item.label, bytes: entry.item.bytes };
  }

  async execute(planId) {
    const plan = this.plans.get(planId);
    this.plans.delete(planId);
    if (!plan || Date.now() >= plan.until) throw fail('storage_plan_expired', 'Cleanup plan expired. Request a new plan.');
    const entry = plan.entry;
    let stat;
    try { stat = await this.validate(entry); } catch { throw changed(); }
    const hold = await mkdtemp(path.join(await privateDirectory(entry.base), 'hold-'));
    const moved = path.join(hold, 'export');
    const manifest = path.join(hold, 'recovery.json');
    let pinned;
    let inQuarantine = false;
    try {
      await writeFile(manifest, JSON.stringify({
        original: entry.item.label, fingerprint: entry.fingerprint, sha256: entry.digest, bytes: entry.item.bytes,
      }), { mode: 0o600, flag: 'wx', flush: true });
      // Pin the audited inode so a replacement cannot reuse its number during the move.
      pinned = await open(entry.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (identity(await pinned.stat({ bigint: true })) !== entry.fingerprint) throw changed();
      await rename(entry.file, moved);
      inQuarantine = true;
      const after = await fileStat(moved);
      // rename changes ctime. Compare all remaining identity fields and recheck the closed run.
      const run = await owner(entry.base, entry.run);
      if (!after.isFile() || after.nlink !== 1n || after.dev !== stat.dev || after.ino !== stat.ino ||
          after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || run?.fingerprint !== entry.owner ||
          await realpath(path.dirname(entry.file)) !== path.dirname(entry.file) ||
          await recognized(moved, entry.kind, run, identity(after)) !== entry.digest) {
        throw changed();
      }
      await unlink(moved);
      inQuarantine = false;
      this.candidates.delete(entry.item.id);
      return { releasedBytes: bytesOf(after) };
    } catch (error) {
      // Restore without overwriting a new occupant. Keep unexpected objects in private quarantine if restoration fails.
      try {
        if (inQuarantine && await realpath(path.dirname(entry.file)) === path.dirname(entry.file)) {
          await link(moved, entry.file);
          await unlink(moved);
          inQuarantine = false;
        }
      } catch { /* retained for recovery */ }
      throw error;
    } finally {
      await pinned?.close();
      if (!inQuarantine) await unlink(manifest).catch(() => {});
      await rmdir(hold).catch(() => {});
    }
  }
}
