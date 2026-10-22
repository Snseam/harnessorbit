import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { invariant } from '../errors.mjs';
import { readJson, writeJsonAtomic, validateId, withLock } from '../state.mjs';

export const PRINCIPAL_SCHEMA_VERSION = 1;
export const PRINCIPAL_AGENTS = Object.freeze(['claude', 'pi', 'opencode', 'codex']);
// What the principal is, for handoff records (memy.handoff participants[].kind); not a permission.
export const PRINCIPAL_KINDS = Object.freeze(['grok', 'claude_code', 'codex', 'human', 'orchestrator', 'other']);
// sessions: may continue live Claude/Codex sessions the operator binds to it. Off by default and
// never implied by submit: a live session edits its checkout directly, outside worktree isolation.
const PERMISSIONS = Object.freeze({ submit: true, cancel: true, integrate: false, sessions: false });
const TOKEN_PREFIX = 'hoa_';
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const sameHash = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function publicPrincipal(record) {
  if (!record) return null;
  const { tokenHash, ...rest } = record;
  return structuredClone(rest);
}

function normalizePermissions(value = {}) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'invalid_principal', 'permissions must be an object.');
  const unknown = Object.keys(value).filter(key => !Object.hasOwn(PERMISSIONS, key));
  invariant(!unknown.length, 'invalid_principal', 'permissions contains unknown keys.', { unknown });
  const permissions = { ...PERMISSIONS };
  for (const [key, flag] of Object.entries(value)) {
    invariant(typeof flag === 'boolean', 'invalid_principal', `permissions.${key} must be a boolean.`);
    permissions[key] = flag;
  }
  return permissions;
}

function normalizeAgents(value) {
  invariant(Array.isArray(value) && value.length > 0, 'invalid_principal', 'agents must be a nonempty array.');
  for (const agent of value) invariant(PRINCIPAL_AGENTS.includes(agent), 'invalid_principal', 'agents must name claude, pi, opencode, or codex.', { agent });
  return [...new Set(value)];
}

async function normalizeProjects(value) {
  invariant(Array.isArray(value) && value.length > 0, 'invalid_principal', 'projects must be a nonempty array of directories.');
  const projects = [];
  for (const entry of value) {
    invariant(typeof entry === 'string' && entry.length > 0 && path.isAbsolute(entry), 'invalid_principal', 'Each project must be an absolute directory path.', { project: entry });
    let real;
    try { real = await fs.realpath(entry); }
    catch { invariant(false, 'invalid_principal', 'Project directory does not exist.', { project: entry }); }
    invariant((await fs.stat(real)).isDirectory(), 'invalid_principal', 'Project must be a directory.', { project: entry });
    projects.push(real);
  }
  return [...new Set(projects)].sort((a, b) => a.localeCompare(b));
}

// Principals are the remote callers (personal agents) allowed to drive HarnessOrbit.
// Only the SHA-256 of a token is stored; the token itself is shown once at creation.
export class PrincipalStore {
  constructor({ root } = {}) {
    invariant(typeof root === 'string' && root.length > 0, 'invalid_state_root', 'Principal store root is required.');
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'access', 'principals.json');
  }

  async _load() {
    const stored = await readJson(this.file, { optional: true });
    if (!stored) return { schemaVersion: PRINCIPAL_SCHEMA_VERSION, principals: {} };
    invariant(stored.schemaVersion === PRINCIPAL_SCHEMA_VERSION && stored.principals && typeof stored.principals === 'object', 'invalid_principal_store', 'Unsupported principals file.');
    for (const record of Object.values(stored.principals)) if (typeof record.kind !== 'string') record.kind = 'other';
    return stored;
  }

  // Operator-only, one-time: give a principal recorded before identity tracking its incarnation.
  // Until then every access call for it answers legacy_migration_required. The value is derived
  // from the record's stable identity (id, creation time, token hash) and persisted, so the
  // operator can review exactly which record was promoted; a recreated id never gets the old value.
  async migrate(id) {
    validateId(id);
    return this._locked(async () => {
      const store = await this._load();
      invariant(Object.hasOwn(store.principals, id), 'principal_not_found', `Principal ${id} does not exist.`);
      const record = store.principals[id];
      if (typeof record.incarnation === 'string' && record.incarnation) return { principal: publicPrincipal(record), migrated: false };
      record.incarnation = crypto.createHash('sha256').update(`incarnation:${record.id}:${record.createdAt}:${record.tokenHash}`).digest('hex').slice(0, 16);
      record.migratedAt = new Date().toISOString();
      await writeJsonAtomic(this.file, store);
      return { principal: publicPrincipal(record), migrated: true };
    });
  }

  _locked(fn) { return withLock(path.join(this.root, 'locks', 'access-principals'), fn); }

  async list() { return Object.values((await this._load()).principals).map(publicPrincipal); }

  async get(id) {
    validateId(id);
    const store = await this._load();
    return Object.hasOwn(store.principals, id) ? publicPrincipal(store.principals[id]) : null;
  }

  async create({ id, projects, agents = ['codex', 'claude'], permissions = {}, rateLimitPerMinute = 60, label = null, kind = 'other' } = {}) {
    validateId(id);
    invariant(Number.isInteger(rateLimitPerMinute) && rateLimitPerMinute > 0 && rateLimitPerMinute <= 600, 'invalid_principal', 'rateLimitPerMinute must be an integer from 1 to 600.');
    invariant(label === null || (typeof label === 'string' && label.length <= 120), 'invalid_principal', 'label must be at most 120 characters.');
    invariant(PRINCIPAL_KINDS.includes(kind), 'invalid_principal', 'kind must be grok, claude_code, codex, human, orchestrator, or other.', { kind });
    // incarnation changes whenever a principal id is removed and created again, so records bound
    // to the earlier principal (sessions, jobs, memory operations) can never be taken over by the new one.
    const record = {
      schemaVersion: PRINCIPAL_SCHEMA_VERSION, id, label, kind, incarnation: crypto.randomBytes(8).toString('hex'),
      projects: await normalizeProjects(projects), agents: normalizeAgents(agents),
      permissions: normalizePermissions(permissions), rateLimitPerMinute,
      createdAt: new Date().toISOString(),
    };
    const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
    await this._locked(async () => {
      const store = await this._load();
      invariant(!Object.hasOwn(store.principals, id), 'principal_exists', `Principal ${id} already exists.`);
      store.principals[id] = { ...record, tokenHash: hash(token) };
      await writeJsonAtomic(this.file, store);
    });
    return { principal: publicPrincipal(record), token };
  }

  // Operator-only change of permission bits; the token and scope stay as they are.
  async update(id, { permissions = {}, agents, projects } = {}) {
    validateId(id);
    invariant(permissions && typeof permissions === 'object' && !Array.isArray(permissions), 'invalid_principal', 'permissions must be an object.');
    const nextProjects = projects === undefined ? undefined : await normalizeProjects(projects);
    const nextAgents = agents === undefined ? undefined : normalizeAgents(agents);
    return this._locked(async () => {
      const store = await this._load();
      invariant(Object.hasOwn(store.principals, id), 'principal_not_found', `Principal ${id} does not exist.`);
      const record = store.principals[id];
      record.permissions = normalizePermissions({ ...record.permissions, ...permissions });
      if (nextProjects) record.projects = nextProjects;
      if (nextAgents) record.agents = nextAgents;
      record.updatedAt = new Date().toISOString();
      await writeJsonAtomic(this.file, store);
      return publicPrincipal(record);
    });
  }

  async remove(id) {
    validateId(id);
    return this._locked(async () => {
      const store = await this._load();
      const existed = Object.hasOwn(store.principals, id);
      delete store.principals[id];
      await writeJsonAtomic(this.file, store);
      return existed;
    });
  }

  async authenticate(token) {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX) || token.length < 24 || token.length > 128) return null;
    const presented = hash(token);
    let match = null;
    // Compare against every principal so timing does not reveal which token prefix exists.
    for (const record of Object.values((await this._load()).principals)) if (sameHash(record.tokenHash, presented)) match = record;
    return publicPrincipal(match);
  }
}
