import crypto from 'node:crypto';
import path from 'node:path';
import * as git from './git.mjs';
import { invariant } from './errors.mjs';

export const CONTEXT_PACKET_SCHEMA_VERSION = 1;
const MAX_PATHS = 128;
const MAX_PATH_LENGTH = 240;

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH && !path.isAbsolute(value) && !value.split('/').includes('..') ? value : null;
}

function selectedPaths(snapshot, includePaths) {
  const all = Object.keys(snapshot.files || {}).sort();
  if (!Array.isArray(includePaths) || includePaths.length === 0) return { paths: all.slice(0, MAX_PATHS), omitted: Math.max(0, all.length - MAX_PATHS) };
  const wanted = [...new Set(includePaths.map(safePath).filter(Boolean))];
  const paths = all.filter(file => wanted.some(prefix => file === prefix || file.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))).slice(0, MAX_PATHS);
  return { paths, omitted: Math.max(0, paths.length - MAX_PATHS) + all.filter(file => !paths.includes(file)).length };
}

/** Build a bounded, provenance-bearing project context packet. */
export function createContextPacket({ project, includePaths = [], runId = null, now = () => new Date().toISOString() } = {}) {
  invariant(typeof project === 'string' && project.length > 0, 'context_invalid_project', 'Project path is required.');
  const info = git.getProjectInfo(project);
  const snapshot = git.snapshot(info.root);
  const selection = selectedPaths(snapshot, includePaths);
  const files = Object.fromEntries(selection.paths.map(file => [file, snapshot.files[file]]));
  const packet = {
    schemaVersion: CONTEXT_PACKET_SCHEMA_VERSION,
    packetId: crypto.randomUUID(),
    createdAt: now(),
    runId: typeof runId === 'string' ? runId : null,
    project: { root: info.root, head: info.head, dirty: info.dirty },
    baseline: { snapshotDigest: snapshot.hash, fileCount: Object.keys(snapshot.files || {}).length },
    files,
    bounds: { maxPaths: MAX_PATHS, selectedPaths: selection.paths.length, omittedPaths: selection.omitted },
    provenance: [{ source: 'git.snapshot', digest: snapshot.hash, observedAt: now() }],
    authority: 'advisory-context; run.json and independent checks remain authoritative',
  };
  packet.packetDigest = contextDigest(packet);
  return Object.freeze(packet);
}

function canonicalContextPayload(packet) {
  return {
    schemaVersion: packet.schemaVersion,
    packetId: typeof packet.packetId === 'string' ? packet.packetId : null,
    createdAt: typeof packet.createdAt === 'string' ? packet.createdAt : null,
    runId: typeof packet.runId === 'string' ? packet.runId : null,
    project: packet.project || null,
    baseline: packet.baseline || null,
    files: packet.files || {},
    bounds: packet.bounds || null,
    provenance: packet.provenance || [],
    authority: typeof packet.authority === 'string' ? packet.authority : null,
  };
}

export function contextDigest(packet) {
  invariant(packet && packet.schemaVersion === CONTEXT_PACKET_SCHEMA_VERSION, 'context_invalid_packet', 'Unsupported context packet.');
  // packetDigest is intentionally excluded so a generated packet can be
  // verified against the same canonical payload that created it.
  return digest(canonicalContextPayload(packet));
}
