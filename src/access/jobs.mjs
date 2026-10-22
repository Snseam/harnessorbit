import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { invariant } from '../errors.mjs';
import { readJson, writeJsonAtomic, validateId, withLock } from '../state.mjs';

export const JOB_SCHEMA_VERSION = 1;
export const JOB_TASK_ID = 'main';
const keyDigest = key => crypto.createHash('sha256').update(key).digest('hex');

// Jobs are the principal-facing handle for one HarnessOrbit run with one task.
// The run remains authoritative for execution state; the job only records the
// mapping, the request as accepted, and the idempotency key that created it.
export class JobStore {
  constructor({ root } = {}) {
    invariant(typeof root === 'string' && root.length > 0, 'invalid_state_root', 'Job store root is required.');
    this.root = path.resolve(root);
    this.directory = path.join(this.root, 'access', 'jobs');
  }

  file(id) { return path.join(this.directory, `${validateId(id)}.json`); }
  indexFile(principalId, key) { return path.join(this.root, 'access', 'idempotency', validateId(principalId), `${keyDigest(key)}.json`); }
  locked(principalId, fn) { return withLock(path.join(this.root, 'locks', `access-jobs-${validateId(principalId)}`), fn); }

  async get(id) { return readJson(this.file(id), { optional: true }); }

  async findByKey(principalId, key) {
    const index = await readJson(this.indexFile(principalId, key), { optional: true });
    return index?.jobId ? this.get(index.jobId) : null;
  }

  // Caller must hold `locked(principalId)` so the index and the job are created together.
  async create(job) {
    validateId(job.id); validateId(job.principalId);
    invariant(typeof job.idempotencyKey === 'string' && job.idempotencyKey.length > 0, 'invalid_job', 'idempotencyKey is required.');
    const record = { schemaVersion: JOB_SCHEMA_VERSION, ...job, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await writeJsonAtomic(this.file(job.id), record);
    await writeJsonAtomic(this.indexFile(job.principalId, job.idempotencyKey), { jobId: job.id, createdAt: record.createdAt });
    return record;
  }

  async update(id, change) {
    const job = await this.get(id);
    invariant(job, 'job_not_found', `Job ${id} does not exist.`);
    change(job);
    job.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.file(id), job);
    return job;
  }

  async list({ principalId = null } = {}) {
    let entries;
    try { entries = await fs.readdir(this.directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const jobs = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const job = await readJson(path.join(this.directory, entry), { optional: true });
      if (job && (!principalId || job.principalId === principalId)) jobs.push(job);
    }
    return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
