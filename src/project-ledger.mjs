import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, validateId, withLock, writeJsonAtomic } from './state.mjs';
import { invariant } from './errors.mjs';
import { contextDigest, createContextPacket } from './context-packet.mjs';

export const PROJECT_LEDGER_SCHEMA_VERSION = 1;
const MAX_SUMMARY = 512;
const MAX_ENTRIES = 256;
const MAX_METADATA_KEYS = 16;
const SECRET_KEY_RE = /(key|token|secret|password|credential|authorization|prompt|answer|stdout|stderr|source(code)?)/i;

function projectKey(project) {
  return crypto.createHash('sha256').update(project).digest('hex').slice(0, 32);
}

function cleanText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SUMMARY ? value : null;
}

function cleanMetadata(value, depth = 0) {
  if (depth > 4) return '[depth-limit]';
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') return value.slice(0, MAX_SUMMARY);
  if (Array.isArray(value)) return value.slice(0, MAX_METADATA_KEYS).map(item => cleanMetadata(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().slice(0, MAX_METADATA_KEYS)
      .filter(key => !SECRET_KEY_RE.test(key))
      .map(key => [key, cleanMetadata(value[key], depth + 1)]));
  }
  return null;
}

function ledgerPath(root, project) {
  return path.join(root, 'projects', projectKey(project), 'ledger.json');
}

function realpathAllowMissing(value) {
  let current = path.resolve(value);
  const suffix = [];
  while (true) {
    try {
      const resolved = fs.realpathSync.native(current);
      return path.join(resolved, ...suffix.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT' || current === path.dirname(current)) return current;
      suffix.push(path.basename(current));
      current = path.dirname(current);
    }
  }
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertNoSymlinkAncestors(root, target) {
  const relative = path.relative(root, target);
  invariant(isWithin(root, target), 'ledger_path_escape', 'Ledger path escapes the configured state root.');
  let current = root;
  for (const segment of relative.split(path.sep)) {
    if (!segment || segment === '.') continue;
    current = path.join(current, segment);
    try {
      invariant(!fs.lstatSync(current).isSymbolicLink(), 'ledger_path_symlink', 'Ledger path contains a symbolic-link component.');
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
  const resolved = realpathAllowMissing(target);
  invariant(isWithin(root, resolved), 'ledger_path_escape', 'Ledger path resolves outside the configured state root.');
}

export class ProjectLedger {
  constructor({ root, project } = {}) {
    invariant(typeof root === 'string' && root.length > 0, 'ledger_invalid_root', 'Ledger state root is required.');
    invariant(typeof project === 'string' && project.length > 0, 'ledger_invalid_project', 'Ledger project is required.');
    this.root = realpathAllowMissing(root);
    this.project = realpathAllowMissing(project);
    const relative = path.relative(this.project, this.root);
    invariant(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'state_inside_project', 'Ledger state root must be outside the project working tree.');
    this.file = ledgerPath(this.root, this.project);
    this.lock = `${this.file}.lock`;
    assertNoSymlinkAncestors(this.root, this.file);
    assertNoSymlinkAncestors(this.root, this.lock);
  }

  async load() {
    assertNoSymlinkAncestors(this.root, this.file);
    const ledger = await readJson(this.file, { optional: true });
    if (!ledger) return {
      schemaVersion: PROJECT_LEDGER_SCHEMA_VERSION,
      project: this.project,
      projectKey: projectKey(this.project),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entries: [],
    };
    invariant(
      ledger.schemaVersion === PROJECT_LEDGER_SCHEMA_VERSION
        && ledger.project === this.project
        && ledger.projectKey === projectKey(this.project)
        && Array.isArray(ledger.entries),
      'ledger_invalid_file',
      'Project ledger schema or identity is invalid.',
    );
    invariant(ledger.entries.length <= MAX_ENTRIES, 'ledger_invalid_file', 'Project ledger exceeds its append-only entry bound.');
    return ledger;
  }

  async append({ type, summary = null, digest = null, status = 'observed', metadata = null, references = [] } = {}) {
    invariant(typeof type === 'string' && /^[a-z][a-z0-9_.-]{1,95}$/.test(type), 'ledger_invalid_entry', 'Ledger entry type is invalid.');
    validateId(type.replaceAll('.', '_'));
    const entry = {
      id: crypto.randomUUID(),
      type,
      status: cleanText(status) || 'observed',
      summary: cleanText(summary),
      digest: typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest) ? digest : null,
      metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? cleanMetadata(metadata) : null,
      references: Array.isArray(references) ? cleanMetadata(references) : [],
      createdAt: new Date().toISOString(),
    };
    assertNoSymlinkAncestors(this.root, this.file);
    assertNoSymlinkAncestors(this.root, this.lock);
    return await withLock(this.lock, async () => {
      const ledger = await this.load();
      invariant(ledger.entries.length < MAX_ENTRIES, 'ledger_full', 'Project ledger entry bound reached; refusing to truncate append-only history.');
      assertNoSymlinkAncestors(this.root, this.file);
      ledger.entries = [...ledger.entries, entry];
      ledger.updatedAt = entry.createdAt;
      await writeJsonAtomic(this.file, ledger);
      return entry;
    });
  }

  async recordContext(packet, references = []) {
    const packetDigest = contextDigest(packet);
    return this.append({
      type: 'context.packet',
      summary: 'Bounded Git context observed.',
      digest: packetDigest,
      metadata: { packetId: packet.packetId, snapshotDigest: packet.baseline.snapshotDigest },
      references,
    });
  }

  async recordDecision(result, references = []) {
    const digest = crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');
    return this.append({ type: 'decision.receipt', summary: 'Decision receipt recorded.', digest, metadata: { providerId: result?.provider?.id || null, inputDigest: result?.inputDigest || null, fallback: result?.fallback?.used === true }, references });
  }

  async recordEvidence({ type, status = 'observed', digest = null, runId = null, taskId = null, attemptId = null, references = [] } = {}) {
    return this.append({
      type,
      status,
      digest,
      summary: `CAO evidence observed: ${type}.`,
      metadata: { runId, taskId, attemptId },
      references,
    });
  }
}

export async function initProjectLedger({ root, project, includePaths = [], runId = null } = {}) {
  const packet = createContextPacket({ project, includePaths, runId });
  const ledger = new ProjectLedger({ root, project: packet.project.root });
  const existing = await ledger.load();
  if (!existing.entries?.length) await ledger.append({ type: 'project.initialized', summary: 'HarnessOrbit project ledger initialized.', digest: packet.packetDigest, metadata: { head: packet.project.head, dirty: packet.project.dirty } });
  await ledger.recordContext(packet);
  return { packet, ledger: await ledger.load() };
}
