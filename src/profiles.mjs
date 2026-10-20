import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { OrchestratorError, invariant } from './errors.mjs';
import { readJson as readStateJson, validateId, withLock, writeJsonAtomic } from './state.mjs';
import { discoverCCSwitch, resolveCCSwitchSecret } from './config-sources/cc-switch.mjs';

const agents = new Set(['claude', 'codex', 'pi', 'opencode']);
const protocols = new Set(['anthropic', 'openai-responses', 'openai-chat']);
const credentialTypes = new Set(['none', 'env', 'stored', 'cc-switch']);
const authSchemes = new Set(['bearer', 'api-key']);
const sourceTypes = new Set(['native', 'cc-switch', 'external-gateway']);
const quotaStates = new Set(['unknown', 'available', 'exhausted', 'unavailable']);
const publicKeys = new Set([
  'id', 'name', 'agent', 'model', 'protocol', 'endpoint', 'credential', 'source', 'enabled',
  'capabilities', 'priority', 'account', 'quota', 'quality', 'speed', 'costPerMillion',
  'modelMap', 'fallbacks',
  'modelMetadata',
]);
const secretFieldPattern = /^(?:value|secret|token|apiKey|api_key|password|accessToken|refreshToken|clientSecret|privateKey)$/i;
const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const storedProfileKeys = new Set([...publicKeys, 'schemaVersion', 'revision', 'createdAt', 'updatedAt']);
const secretValueMaxBytes = 64 * 1024;

function fail(code, message, details = {}) {
  throw new OrchestratorError(code, message, details);
}

async function readJson(file, options) {
  try { return await readStateJson(file, options); }
  catch (error) {
    // JSON parser diagnostics can quote content from a malformed private file.
    if (error.code === 'state_invalid_json') fail('invalid_profile_store', 'Stored profile JSON is invalid.');
    throw error;
  }
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknown(object, allowed, context) {
  for (const key of Object.keys(object || {})) {
    if (secretFieldPattern.test(key)) fail('profile_secret_literal', `Secret literal field is not allowed in ${context}.`, { field: key });
    if (!allowed.has(key)) fail('profile_unknown_field', `Unknown field in ${context}: ${key}`, { field: key });
  }
}

function nonempty(value, field, max = 512) {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value), 'invalid_profile', `${field} must be a nonempty safe string.`);
  return value;
}

function opaqueIdentifier(value, field, max = 256) {
  invariant(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value), 'invalid_profile', `${field} must be a nonempty safe string.`);
  return value;
}

function normalizeEnvName(value, field = 'env secret ref') {
  const name = nonempty(value, field, 256);
  invariant(envNamePattern.test(name), 'invalid_secret_ref', `${field} must be a valid environment variable name.`);
  return name;
}

function normalizeSecretValue(value) {
  invariant(typeof value === 'string', 'invalid_secret', 'Secret value must be a string.');
  const normalized = value.endsWith('\n') ? value.slice(0, -1) : value;
  invariant(normalized.length > 0, 'invalid_secret', 'Secret value must be a nonempty string.');
  invariant(Buffer.byteLength(normalized, 'utf8') <= secretValueMaxBytes, 'invalid_secret', 'Secret value is too large.');
  invariant(!/[\x00-\x1f\x7f]/.test(normalized), 'invalid_secret', 'Secret value must not contain control characters.');
  return normalized;
}

function nullableIso(value, field) {
  if (value === null || value === undefined) return null;
  invariant(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'invalid_profile', `${field} must be an ISO timestamp or null.`);
  return value;
}

function numberOrNull(value, field, { min = -Infinity, max = Infinity } = {}) {
  if (value === null || value === undefined) return null;
  invariant(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, 'invalid_profile', `${field} is out of range.`);
  return value;
}

function bool(value, fallback) {
  if (value === undefined) return fallback;
  invariant(typeof value === 'boolean', 'invalid_profile', 'Boolean fields must be true or false.');
  return value;
}

function normalizeEndpoint(value, credential) {
  const endpoint = nonempty(value, 'endpoint', 2048);
  let url;
  try { url = new URL(endpoint); }
  catch { fail('invalid_profile', 'endpoint must be an http(s) URL.'); }
  invariant(['http:', 'https:'].includes(url.protocol), 'invalid_profile', 'endpoint must use http or https.');
  invariant(!url.username && !url.password && !url.search && !url.hash, 'invalid_profile', 'endpoint must not include userinfo, query or hash.');
  if (credential?.type === 'none') {
    invariant(['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname), 'invalid_profile', 'credential.type none is only valid for loopback endpoints.');
  }
  return url.toString().replace(/\/$/, '');
}

function normalizeAuthScheme(value) {
  if (value === undefined) return {};
  invariant(authSchemes.has(value), 'invalid_profile', 'credential.authScheme must be bearer or api-key.');
  return { authScheme: value };
}

function normalizeCredential(input = {}) {
  invariant(plain(input), 'invalid_profile', 'credential must be an object.');
  rejectUnknown(input, new Set(['type', 'name', 'ref', 'providerId', 'app', 'field', 'secretRef', 'authScheme']), 'credential');
  const type = input.type || 'none';
  invariant(credentialTypes.has(type), 'invalid_profile', 'Unsupported credential type.');
  const authScheme = normalizeAuthScheme(input.authScheme);
  if (type === 'none') return { type: 'none' };
  if (type === 'env') return { type, name: normalizeEnvName(input.name, 'credential.name'), ...authScheme };
  if (type === 'stored') return { type, ref: normalizeSecretRef(input.ref, 'stored'), ...authScheme };
  return {
    type,
    providerId: opaqueIdentifier(input.providerId, 'credential.providerId'),
    app: nonempty(input.app, 'credential.app', 64),
    ...(input.field ? { field: nonempty(input.field, 'credential.field', 128) } : {}),
    ...(input.secretRef ? { secretRef: normalizeSecretRef(input.secretRef, 'cc-switch') } : {}),
    ...authScheme,
  };
}

function normalizeSecretRef(ref, requiredType = null) {
  const value = nonempty(ref, 'secret ref', requiredType === 'cc-switch' ? 4096 : 256);
  const [type, id, extra] = value.split(':');
  if (type === 'cc-switch') {
    invariant(!requiredType || requiredType === 'cc-switch', 'invalid_secret_ref', 'Secret ref must use cc-switch: prefix.');
    invariant(value.length <= 4096, 'invalid_secret_ref', 'CC Switch secret ref is too long.');
    return value;
  }
  invariant(!extra && ['stored', 'env'].includes(type), 'invalid_secret_ref', 'Secret ref must be stored:<id>, env:<name> or cc-switch:<ref>.');
  if (requiredType) invariant(type === requiredType, 'invalid_secret_ref', `Secret ref must use ${requiredType}: prefix.`);
  if (type === 'stored') validateId(id);
  else normalizeEnvName(id);
  return value;
}

function normalizeSource(input = {}) {
  invariant(plain(input), 'invalid_profile', 'source must be an object.');
  rejectUnknown(input, new Set(['type', 'directory', 'providerId', 'app', 'fingerprint', 'externalId', 'allowShared', 'route']), 'source');
  const type = input.type || 'native';
  invariant(sourceTypes.has(type), 'invalid_profile', 'Unsupported source type.');
  if (type === 'native') return { type: 'native' };
  if (type === 'cc-switch') {
    return {
      type,
      directory: path.resolve(nonempty(input.directory, 'source.directory', 2048)),
      providerId: opaqueIdentifier(input.providerId, 'source.providerId'),
      app: nonempty(input.app, 'source.app', 64),
      fingerprint: nonempty(input.fingerprint, 'source.fingerprint', 128),
      ...(input.route ? { route: nonempty(input.route, 'source.route', 64) } : {}),
      allowShared: bool(input.allowShared, false),
    };
  }
  return {
    type,
    externalId: input.externalId ? nonempty(input.externalId, 'source.externalId', 256) : null,
    allowShared: bool(input.allowShared, false),
  };
}

function normalizeAccount(input = {}) {
  invariant(plain(input), 'invalid_profile', 'account must be an object.');
  rejectUnknown(input, new Set(['id', 'maxParallel']), 'account');
  const maxParallel = input.maxParallel === undefined ? 1 : input.maxParallel;
  invariant(Number.isInteger(maxParallel) && maxParallel >= 1 && maxParallel <= 1024, 'invalid_profile', 'account.maxParallel must be a positive integer.');
  return { id: input.id === undefined ? null : input.id === null ? null : nonempty(input.id, 'account.id', 256), maxParallel };
}

function normalizeQuota(input = {}) {
  invariant(plain(input), 'invalid_profile', 'quota must be an object.');
  rejectUnknown(input, new Set(['state', 'observedAt', 'expiresAt', 'remainingTokens']), 'quota');
  const state = input.state || 'unknown';
  invariant(quotaStates.has(state), 'invalid_profile', 'Invalid quota state.');
  return {
    state,
    observedAt: nullableIso(input.observedAt, 'quota.observedAt'),
    expiresAt: nullableIso(input.expiresAt, 'quota.expiresAt'),
    remainingTokens: numberOrNull(input.remainingTokens, 'quota.remainingTokens', { min: 0 }),
  };
}

function normalizeStringArray(input, field) {
  const values = input === undefined ? [] : input;
  invariant(Array.isArray(values) && values.every(value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)), 'invalid_profile', `${field} must be a safe string array.`);
  return [...new Set(values)].sort();
}

function normalizeFallbacks(input, id) {
  const values = input === undefined ? [] : input;
  invariant(Array.isArray(values), 'invalid_profile', 'fallbacks must be a safe string array.');
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const fallback = validateId(nonempty(value, 'fallback profile id', 64));
    invariant(fallback !== id, 'invalid_profile', 'fallbacks must not include the profile itself.');
    if (!seen.has(fallback)) {
      seen.add(fallback);
      result.push(fallback);
    }
  }
  invariant(result.length <= 8, 'invalid_profile', 'fallbacks must contain at most 8 profiles.');
  return result.sort();
}

function normalizeModelMap(input = {}) {
  invariant(plain(input), 'invalid_profile', 'modelMap must be an object.');
  const result = Object.create(null);
  for (const [key, value] of Object.entries(input)) {
    invariant(!['__proto__', 'constructor', 'prototype'].includes(key), 'invalid_profile', 'modelMap key is not allowed.');
    result[nonempty(key, 'modelMap key', 256)] = nonempty(value, 'modelMap value', 256);
  }
  return Object.assign({}, result);
}

function profileHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function publicForRevision(profile) {
  const { schemaVersion, revision, createdAt, updatedAt, ...rest } = profile;
  return rest;
}

function attachMetadata(profile, { previous = null, now = new Date().toISOString() } = {}) {
  const base = {
    schemaVersion: 1,
    ...profile,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
  return { ...base, revision: profileHash(publicForRevision(base)) };
}

function validateStoredProfile(record) {
  invariant(plain(record), 'invalid_profile_record', 'Stored profile must be an object.');
  rejectUnknown(record, storedProfileKeys, 'stored profile');
  invariant(record.schemaVersion === 1, 'invalid_profile_record', 'Stored profile schema version is unsupported.');
  invariant(typeof record.revision === 'string' && /^[a-f0-9]{64}$/.test(record.revision), 'invalid_profile_record', 'Stored profile revision is invalid.');
  nullableIso(record.createdAt, 'createdAt');
  nullableIso(record.updatedAt, 'updatedAt');
  const publicRecord = publicForRevision(record);
  invariant(record.revision === profileHash(publicRecord), 'profile_revision_invalid', 'Stored profile revision does not match its contents.');
  const normalized = validateProfile(publicRecord);
  invariant(JSON.stringify(normalized) === JSON.stringify(publicRecord), 'invalid_profile_record', 'Stored profile is not normalized.');
  return { ...record, ...normalized };
}

export function validateProfile(input) {
  invariant(plain(input), 'invalid_profile', 'Profile must be an object.');
  rejectUnknown(input, publicKeys, 'profile');
  const id = validateId(nonempty(input.id, 'id', 64));
  const credential = normalizeCredential(input.credential || { type: 'none' });
  const normalized = {
    id,
    name: input.name === undefined ? id : nonempty(input.name, 'name', 256),
    agent: nonempty(input.agent, 'agent', 64),
    model: nonempty(input.model, 'model', 256),
    protocol: nonempty(input.protocol, 'protocol', 64),
    endpoint: null,
    credential,
    source: normalizeSource(input.source || { type: 'native' }),
    enabled: bool(input.enabled, true),
    capabilities: normalizeStringArray(input.capabilities, 'capabilities'),
    priority: input.priority === undefined ? 0 : input.priority,
    account: normalizeAccount(input.account || {}),
    quota: normalizeQuota(input.quota || {}),
    quality: numberOrNull(input.quality, 'quality', { min: 0, max: 100 }),
    speed: numberOrNull(input.speed, 'speed', { min: 0, max: 100 }),
    costPerMillion: numberOrNull(input.costPerMillion, 'costPerMillion', { min: 0 }),
    modelMap: normalizeModelMap(input.modelMap || {}),
    fallbacks: normalizeFallbacks(input.fallbacks, id),
  };
  invariant(agents.has(normalized.agent), 'invalid_profile', 'Unsupported agent.');
  invariant(protocols.has(normalized.protocol), 'invalid_profile', 'Unsupported protocol.');
  if (input.modelMetadata !== undefined) {
    invariant(plain(input.modelMetadata), 'invalid_profile', 'modelMetadata must be an object.');
    rejectUnknown(input.modelMetadata, new Set(['contextWindow', 'maxOutputTokens']), 'modelMetadata');
    const { contextWindow, maxOutputTokens } = input.modelMetadata;
    invariant(Number.isSafeInteger(contextWindow) && contextWindow > 0 && contextWindow <= 4000000, 'invalid_profile', 'modelMetadata.contextWindow must be a positive integer no greater than 4000000.');
    invariant(Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0 && maxOutputTokens <= contextWindow, 'invalid_profile', 'modelMetadata.maxOutputTokens must fit the context window.');
    normalized.modelMetadata = { contextWindow, maxOutputTokens };
  }
  invariant(Number.isInteger(normalized.priority), 'invalid_profile', 'priority must be an integer.');
  normalized.endpoint = normalizeEndpoint(input.endpoint, credential);
  return normalized;
}

export class ProfileStore {
  constructor({ root }) {
    invariant(typeof root === 'string' && root.length > 0, 'invalid_profile_store', 'ProfileStore requires root.');
    this.root = path.resolve(root);
    this.profilesDirectory = path.join(this.root, 'profiles');
    this.secretsDirectory = path.join(this.root, 'profile-secrets');
    this.settingsFile = path.join(this.root, 'profile-settings.json');
    this.lockDirectory = path.join(this.root, '.profiles.lock');
  }

  profileFile(id) {
    return path.join(this.profilesDirectory, `${validateId(id)}.json`);
  }

  secretFile(id) {
    return path.join(this.secretsDirectory, `${validateId(id)}.secret`);
  }

  async put(input, { ifRevision, makeDefault = false } = {}) {
    const normalized = validateProfile(input);
    return withLock(this.lockDirectory, async () => {
      const existingRaw = await readJson(this.profileFile(normalized.id), { optional: true });
      const existing = existingRaw ? validateStoredProfile(existingRaw) : null;
      if (ifRevision !== undefined) invariant(existing?.revision === ifRevision, 'profile_revision_conflict', 'Profile revision changed.');
      const record = attachMetadata(normalized, { previous: existing });
      await writeJsonAtomic(this.profileFile(record.id), record);
      if (makeDefault) await this.setDefaultUnlocked(record.id);
      return structuredClone(record);
    });
  }

  async get(id) {
    const profile = await readJson(this.profileFile(id), { optional: true });
    return profile ? structuredClone(validateStoredProfile(profile)) : null;
  }

  async list() {
    let entries;
    try { entries = await readdir(this.profilesDirectory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const profiles = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const profile = await readJson(path.join(this.profilesDirectory, entry.name));
      profiles.push(validateStoredProfile(profile));
    }
    return profiles.sort((a, b) => a.id.localeCompare(b.id));
  }

  async remove(id) {
    validateId(id);
    return withLock(this.lockDirectory, async () => {
      const existing = await this.get(id);
      if (!existing) return false;
      const wasDefault = (await this.getDefault())?.id === id;
      if (wasDefault) await this.setDefaultUnlocked(null);
      await rm(this.profileFile(id), { force: true });
      return true;
    });
  }

  async getDefault() {
    const settings = await readJson(this.settingsFile, { optional: true });
    if (!settings?.defaultProfileId) return null;
    return this.get(settings.defaultProfileId);
  }

  async setDefaultUnlocked(id) {
    if (id !== null) {
      validateId(id);
      invariant(await this.get(id), 'profile_not_found', 'Default profile does not exist.');
    }
    await writeJsonAtomic(this.settingsFile, { schemaVersion: 1, defaultProfileId: id, updatedAt: new Date().toISOString() });
    return id;
  }

  async setDefault(id) {
    return withLock(this.lockDirectory, () => this.setDefaultUnlocked(id));
  }

  async clone(id, newId) {
    const existing = await this.get(id);
    invariant(existing, 'profile_not_found', 'Profile does not exist.');
    const { schemaVersion, revision, createdAt, updatedAt, ...input } = existing;
    return this.put({ ...input, id: validateId(newId), name: `${existing.name} copy` });
  }

  async export(id) {
    const profile = await this.get(id);
    invariant(profile, 'profile_not_found', 'Profile does not exist.');
    return structuredClone(publicForRevision(profile));
  }

  async putSecret(id, value) {
    validateId(id);
    const secretValue = normalizeSecretValue(value);
    await mkdir(this.secretsDirectory, { recursive: true, mode: 0o700 });
    const file = this.secretFile(id);
    try {
      const info = await lstat(file);
      invariant(!info.isSymbolicLink(), 'invalid_secret', 'Secret file must not be a symlink.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temporary = path.join(this.secretsDirectory, `.${id}.${process.pid}.${Date.now()}.tmp`);
    const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try { await handle.writeFile(secretValue, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
    return `stored:${id}`;
  }

  async removeSecret(id) {
    await unlink(this.secretFile(id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }

  async secretExists(ref) {
    const value = normalizeSecretRef(ref);
    const [type, id] = value.split(':');
    if (type === 'env') return process.env[id] !== undefined;
    if (type === 'cc-switch') {
      try { await resolveCCSwitchSecret(value); return true; }
      catch (error) { if (error.code === 'secret_not_found' || error.code === 'cc_switch_provider_not_found') return false; throw error; }
    }
    try { const info = await lstat(this.secretFile(id)); return info.isFile() && !info.isSymbolicLink(); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  async resolveSecret(ref) {
    const value = normalizeSecretRef(ref);
    const [type, id] = value.split(':');
    if (type === 'env') {
      invariant(process.env[id] !== undefined, 'secret_not_found', 'Secret reference is not available.');
      return normalizeSecretValue(process.env[id]);
    }
    if (type === 'cc-switch') return normalizeSecretValue(await resolveCCSwitchSecret(value));
    try {
      const file = this.secretFile(id);
      const info = await lstat(file);
      invariant(info.isFile() && !info.isSymbolicLink(), 'secret_not_found', 'Secret reference is not available.');
      return normalizeSecretValue(await readFile(file, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') fail('secret_not_found', 'Secret reference is not available.'); throw error; }
  }

  async resolveProfileSecret(profileSnapshot) {
    invariant(plain(profileSnapshot), 'invalid_profile', 'Profile snapshot must be an object.');
    const credential = profileSnapshot.credential || { type: 'none' };
    if (credential.type === 'none') return null;
    if (profileSnapshot.source?.type === 'cc-switch') await this.assertSourceCurrent(profileSnapshot);
    if (credential.type === 'env') return this.resolveSecret(`env:${credential.name}`);
    if (credential.type === 'stored') return this.resolveSecret(credential.ref);
    if (credential.type === 'cc-switch') {
      if (credential.secretRef) return this.resolveSecret(credential.secretRef);
      return resolveCCSwitchSecret({
        directory: profileSnapshot.source?.directory,
        app: credential.app || profileSnapshot.source?.app,
        providerId: credential.providerId || profileSnapshot.source?.providerId,
        field: credential.field,
      });
    }
    fail('invalid_profile', 'Unsupported credential type.');
  }

  async credentialAvailable(profileSnapshot) {
    invariant(plain(profileSnapshot), 'invalid_profile', 'Profile snapshot must be an object.');
    const credential = profileSnapshot.credential || { type: 'none' };
    if (credential.type === 'none') return true;
    try {
      if (credential.type === 'env') return process.env[credential.name] !== undefined;
      if (credential.type === 'stored') return this.secretExists(credential.ref);
      if (credential.type === 'cc-switch') {
        if (profileSnapshot.source?.type === 'cc-switch') await this.assertSourceCurrent(profileSnapshot);
        await this.resolveProfileSecret(profileSnapshot);
        return true;
      }
      return false;
    } catch (error) {
      if (['secret_not_found', 'cc_switch_provider_not_found', 'profile_source_missing', 'profile_source_drift'].includes(error.code)) return false;
      throw error;
    }
  }

  async resolve(id) {
    const profile = await this.get(id);
    invariant(profile, 'profile_not_found', 'Profile does not exist.');
    const snapshot = structuredClone(profile);
    snapshot.resolvedAt = new Date().toISOString();
    if (snapshot.source.type === 'cc-switch') await this.assertSourceCurrent(snapshot);
    return Object.freeze(snapshot);
  }

  async assertSourceCurrent(snapshot) {
    invariant(plain(snapshot), 'invalid_profile', 'Profile snapshot must be an object.');
    if (snapshot.source?.type !== 'cc-switch') return true;
    const inventory = await discoverCCSwitch({ directory: snapshot.source.directory });
    const current = inventory.providers.find(provider => provider.providerId === snapshot.source.providerId && provider.app === snapshot.source.app);
    invariant(current, 'profile_source_missing', 'CC Switch source profile is no longer present.');
    invariant(current.fingerprint === snapshot.source.fingerprint, 'profile_source_drift', 'CC Switch source profile changed.');
    return true;
  }
}
