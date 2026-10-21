import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { invariant } from '../errors.mjs';
import { readJson, writeJsonAtomic, validateId, withLock } from '../state.mjs';

export const PRINCIPAL_SCHEMA_VERSION = 1;
export const PRINCIPAL_AGENTS = Object.freeze(['claude', 'pi', 'opencode', 'codex']);
const PERMISSIONS = Object.freeze({ submit: true, cancel: true, integrate: false });
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
    return stored;
  }

  _locked(fn) { return withLock(path.join(this.root, 'locks', 'access-principals'), fn); }

  async list() { return Object.values((await this._load()).principals).map(publicPrincipal); }

  async get(id) {
    validateId(id);
    const store = await this._load();
    return Object.hasOwn(store.principals, id) ? publicPrincipal(store.principals[id]) : null;
  }

  async create({ id, projects, agents = ['codex', 'claude'], permissions = {}, rateLimitPerMinute = 60, label = null } = {}) {
    validateId(id);
    invariant(Number.isInteger(rateLimitPerMinute) && rateLimitPerMinute > 0 && rateLimitPerMinute <= 600, 'invalid_principal', 'rateLimitPerMinute must be an integer from 1 to 600.');
    invariant(label === null || (typeof label === 'string' && label.length <= 120), 'invalid_principal', 'label must be at most 120 characters.');
    const record = {
      schemaVersion: PRINCIPAL_SCHEMA_VERSION, id, label,
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
