import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OrchestratorError, invariant } from '../errors.mjs';
import { runCommand } from '../process.mjs';
import { writeJsonAtomic } from '../state.mjs';
import { ProfileStore } from '../profiles.mjs';
import { CalibrationStore } from '../calibration/store.mjs';
import { PROBE_ENVIRONMENT } from '../calibration/environment.mjs';
import { readTaskEvidenceForResource } from './task-evidence.mjs';

const SCHEMA_VERSION = 1;
const NATIVE_AGENTS = [
  { id: 'native-claude', agent: 'claude', executable: 'claude' },
  { id: 'native-codex', agent: 'codex', executable: 'codex' },
  { id: 'native-pi', agent: 'pi', executable: 'pi' },
  { id: 'native-opencode', agent: 'opencode', executable: 'opencode' },
];
const CHECK_TIMEOUT_MS = 2000;
const CHECK_TOTAL_MS = 5000;
const CHECK_MAX_BYTES = 4096;
const CLAUDE_AUTH_ENV_NAMES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_EXECUTABLE_DIRECTORIES_PER_SOURCE = 20;
const QUOTA_FRESH_TTL_MS = 15 * 60 * 1000;
const VERSION_OBSERVATION_TTL_MS = 24 * 60 * 60 * 1000;
const PI_AUTH_TYPES = new Set(['api_key', 'oauth']);

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function opaquePathHash(file) {
  return sha256({ path: path.resolve(file) });
}

function isoFromNow(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  return new Date(value).toISOString();
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value, max = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
}

function safeIdentifier(value, max = 128) {
  const string = safeString(value, max);
  return string && /^[A-Za-z0-9_.:@/-]+$/.test(string) ? string : null;
}

function sanitizeUrl(input) {
  const value = safeString(input, 2048);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '') || ''}`;
  } catch {
    return null;
  }
}

function endpointHost(endpoint) {
  try { return new URL(endpoint).host.toLowerCase(); }
  catch { return null; }
}

function endpointBucket(endpoint, protocol = 'unknown') {
  try {
    const url = new URL(endpoint);
    return `endpoint:${url.protocol}//${url.host.toLowerCase()}`;
  } catch {
    return endpoint ? `endpoint:${String(endpoint).toLowerCase()}` : `endpoint:${protocol}:unknown`;
  }
}

async function fileMetadata(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile()) return null;
    return { pathHash: opaquePathHash(file), size: info.size, mtimeMs: Math.trunc(info.mtimeMs) };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { pathHash: opaquePathHash(file), unreadable: true };
  }
}

async function readJsonObject(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return null;
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    return plain(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstString(...values) {
  for (const value of values) {
    const string = safeString(value);
    if (string) return string;
  }
  return null;
}

function readNested(object, keys) {
  let current = object;
  for (const key of keys) {
    if (!plain(current)) return undefined;
    current = current[key];
  }
  return current;
}

function parseSimpleCodexToml(text) {
  const result = {};
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    if (section) continue;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z0-9_.:/@+-]+)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (['model', 'effort', 'reasoning_effort', 'model_reasoning_effort'].includes(key)) result[key] = safeString(value, 256);
  }
  return result;
}

async function readCodexConfig(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return {};
    const text = await readFile(file, 'utf8');
    return parseSimpleCodexToml(text);
  } catch {
    return {};
  }
}

async function nativeConfig(agent, home, environment) {
  if (agent === 'claude') {
    const claudeRoot = path.resolve(environment.CLAUDE_CONFIG_DIR || path.join(home, '.claude'));
    const settingsFile = path.join(claudeRoot, 'settings.json');
    const settings = await readJsonObject(settingsFile);
    const settingsEnv = plain(settings?.env) ? settings.env : {};
    const authEnvNames = CLAUDE_AUTH_ENV_NAMES.filter(name => environment[name] !== undefined || settingsEnv[name] !== undefined);
    const model = firstString(environment.ANTHROPIC_MODEL, environment.CLAUDE_MODEL, settings?.model, readNested(settings, ['env', 'ANTHROPIC_MODEL']));
    const endpoint = sanitizeUrl(firstString(environment.ANTHROPIC_BASE_URL, environment.CLAUDE_BASE_URL, readNested(settings, ['env', 'ANTHROPIC_BASE_URL']), settings?.baseUrl, settings?.baseURL));
    return {
      publicFields: { model, endpoint, authEnvNames },
      files: [await fileMetadata(settingsFile)].filter(Boolean),
      requestedModel: model,
      effort: null,
      endpoint,
      authEnvNames,
      partial: !settings,
    };
  }
  if (agent === 'codex') {
    const codexRoot = path.resolve(environment.CODEX_HOME || path.join(home, '.codex'));
    const configFile = path.join(codexRoot, 'config.toml');
    const parsed = await readCodexConfig(configFile);
    const effort = parsed.model_reasoning_effort || parsed.reasoning_effort || parsed.effort || null;
    return {
      publicFields: { model: parsed.model || null, effort },
      files: [await fileMetadata(configFile)].filter(Boolean),
      requestedModel: parsed.model || null,
      effort,
      endpoint: null,
      partial: true,
    };
  }
  if (agent === 'pi') {
    const piRoot = path.resolve(environment.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent'));
    const settingsFile = path.join(piRoot, 'settings.json');
    const legacySettingsFile = path.join(home, '.pi', 'settings.json');
    const modelsFile = path.join(piRoot, 'models.json');
    const authFile = path.join(piRoot, 'auth.json');
    const settings = await readJsonObject(settingsFile) || (!environment.PI_CODING_AGENT_DIR ? await readJsonObject(legacySettingsFile) : null);
    const models = await readJsonObject(modelsFile);
    const auth = await readJsonObject(authFile);
    const provider = safeIdentifier(settings?.defaultProvider) || safeIdentifier(settings?.provider);
    const providersRoot = piProvidersRoot(models);
    const defaultModel = firstString(settings?.defaultModel, settings?.model, provider && readNested(providersRoot, [provider, 'defaultModel']));
    const endpoint = sanitizeUrl(settings?.endpoint || settings?.baseUrl || settings?.baseURL);
    const effort = firstString(settings?.defaultThinkingLevel, settings?.thinkingLevel);
    const modelProviders = sanitizePiProviders(models);
    const authEntries = sanitizePiAuth(auth, models, environment);
    return {
      publicFields: { provider, defaultModel, endpoint, effort, modelProviders, authEntries },
      files: [await fileMetadata(settingsFile), await fileMetadata(legacySettingsFile), await fileMetadata(modelsFile), await fileMetadata(authFile)].filter(Boolean),
      requestedModel: defaultModel,
      effort,
      endpoint,
      providerId: provider,
      modelProviders,
      authEntries,
      partial: !settings,
    };
  }
  const settingsFile = path.join(home, '.config', 'opencode', 'opencode.json');
  const settings = await readJsonObject(settingsFile);
  const model = firstString(settings?.model, settings?.defaultModel);
  const endpoint = sanitizeUrl(settings?.endpoint || settings?.baseUrl || settings?.baseURL);
  return {
    publicFields: { model, endpoint },
    files: [await fileMetadata(settingsFile)].filter(Boolean),
    requestedModel: model,
    effort: null,
    endpoint,
    partial: !settings,
  };
}

function splitPath(pathValue) {
  return String(pathValue || '').split(path.delimiter).filter(Boolean);
}

function executableExtensions(environment) {
  return process.platform === 'win32' ? String(environment.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
}

function candidatePath(directory, name, extension) {
  return path.resolve(directory, `${name}${extension}`);
}

function semverParts(version) {
  const match = String(version || '').match(/^v?(\d+)\.(\d+)\.(\d+)(?:$|[-+])/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareSemverDesc(a, b) {
  const left = semverParts(a);
  const right = semverParts(b);
  if (!left && !right) return String(b).localeCompare(String(a));
  if (!left) return 1;
  if (!right) return -1;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return right[index] - left[index];
  }
  return 0;
}

async function nvmVersionDirectories(home, environment) {
  const nvmRoot = path.resolve(environment.NVM_DIR || path.join(home, '.nvm'));
  const versionsRoot = path.join(nvmRoot, 'versions', 'node');
  let entries;
  try { entries = await readdir(versionsRoot, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter(entry => entry.isDirectory() && semverParts(entry.name))
    .map(entry => entry.name)
    .sort(compareSemverDesc)
    .slice(0, MAX_EXECUTABLE_DIRECTORIES_PER_SOURCE)
    .map(version => path.join(versionsRoot, version, 'bin'));
}

async function executableInfo(file, source) {
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return {
      installed: true,
      executable: file,
      discoverySource: source,
      pathHash: opaquePathHash(file),
      file: { pathHash: opaquePathHash(file), size: info.size, mtimeMs: Math.trunc(info.mtimeMs) },
    };
  } catch {
    return null;
  }
}

async function findExecutable(name, environment) {
  return findExecutableBounded(name, { home: os.homedir(), environment });
}

export async function findExecutableBounded(name, { home = os.homedir(), environment = process.env } = {}) {
  const extensions = executableExtensions(environment);
  const seen = new Set();
  const candidates = [];
  const addCandidate = (directory, source) => {
    if (!safeString(directory, 4096)) return;
    for (const extension of extensions) {
      const file = candidatePath(directory, name, extension);
      if (seen.has(file)) continue;
      seen.add(file);
      candidates.push({ file, source });
    }
  };

  for (const directory of splitPath(environment.PATH).slice(0, MAX_EXECUTABLE_DIRECTORIES_PER_SOURCE)) {
    addCandidate(directory, 'PATH');
  }
  for (const directory of [
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
  ]) {
    addCandidate(directory, 'known-location');
  }
  for (const directory of (await nvmVersionDirectories(home, environment)).slice(0, MAX_EXECUTABLE_DIRECTORIES_PER_SOURCE)) {
    addCandidate(directory, 'nvm');
  }

  for (const candidate of candidates) {
    const found = await executableInfo(candidate.file, candidate.source);
    if (found) return found;
  }
  return { installed: false, executable: null, discoverySource: null, pathHash: null, file: null };
}

function sanitizePiAuth(auth, models, environment) {
  const entries = [];
  const add = (providerId, type, source) => {
    const id = safeIdentifier(providerId);
    const normalizedType = String(type || '').toLowerCase().replace(/-/g, '_');
    const safeType = PI_AUTH_TYPES.has(normalizedType) ? normalizedType : 'unknown';
    if (!id) return;
    entries.push({ providerId: id, type: safeType, present: true, source });
  };
  if (plain(auth)) {
    const authRoot = plain(auth.providers) ? auth.providers : auth;
    for (const [providerId, value] of Object.entries(authRoot).slice(0, 50)) {
      if (plain(value)) add(providerId, value.type || value.authType || value.kind || value.scheme, 'auth.json');
      else if (typeof value === 'string') add(providerId, value, 'auth.json');
    }
  }
  const providersRoot = piProvidersRoot(models);
  if (plain(providersRoot)) {
    for (const [providerId, value] of Object.entries(providersRoot).slice(0, 50)) {
      if (plain(value) && (value.apiKey !== undefined || value.api_key !== undefined)) {
        const key = value.apiKey ?? value.api_key;
        const reference = typeof key === 'string' && (key.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/) || key.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)}$/));
        const usable = reference ? Boolean(safeString(environment[reference[1]], 65536)) : Boolean(safeString(key, 65536) && !key.startsWith('!') && !key.includes('$'));
        add(providerId, usable ? 'api_key' : 'unknown', 'models.json');
      }
    }
  }
  return entries.sort((a, b) => `${a.providerId}:${a.type}:${a.source}`.localeCompare(`${b.providerId}:${b.type}:${b.source}`));
}

function sanitizePiProviders(models) {
  const providersRoot = piProvidersRoot(models);
  if (!plain(providersRoot)) return [];
  const providers = [];
  for (const [providerIdRaw, providerRaw] of Object.entries(providersRoot).slice(0, 50)) {
    const providerId = safeIdentifier(providerIdRaw);
    if (!providerId || !plain(providerRaw)) continue;
    const api = firstString(providerRaw.api, providerRaw.protocol, providerRaw.apiFormat);
    const baseUrl = sanitizeUrl(providerRaw.baseUrl || providerRaw.baseURL || providerRaw.endpoint);
    const modelEntries = [];
    const modelsValue = providerRaw.models;
    if (Array.isArray(modelsValue)) {
      for (const modelRaw of modelsValue.slice(0, 100)) {
        const model = sanitizePiModel(modelRaw);
        if (model) modelEntries.push(model);
      }
    } else if (plain(modelsValue)) {
      for (const [modelId, modelRaw] of Object.entries(modelsValue).slice(0, 100)) {
        const model = sanitizePiModel({ id: modelId, ...(plain(modelRaw) ? modelRaw : {}) });
        if (model) modelEntries.push(model);
      }
    }
    providers.push({
      providerId,
      api,
      baseUrl,
      models: modelEntries.sort((a, b) => a.id.localeCompare(b.id)),
    });
  }
  return providers.sort((a, b) => a.providerId.localeCompare(b.providerId));
}

function piProvidersRoot(models) {
  if (!plain(models)) return null;
  return plain(models.providers) ? models.providers : models;
}

function sanitizePiModel(modelRaw) {
  if (typeof modelRaw === 'string') {
    const id = safeIdentifier(modelRaw, 256);
    return id ? { id, contextWindow: null, maxOutputTokens: null } : null;
  }
  if (!plain(modelRaw)) return null;
  const id = safeIdentifier(modelRaw.id || modelRaw.name || modelRaw.model, 256);
  if (!id) return null;
  return {
    id,
    contextWindow: Number.isSafeInteger(modelRaw.contextWindow) ? modelRaw.contextWindow
      : Number.isSafeInteger(modelRaw.context_window) ? modelRaw.context_window
        : Number.isSafeInteger(modelRaw.inputTokens) ? modelRaw.inputTokens
          : null,
    maxOutputTokens: Number.isSafeInteger(modelRaw.maxOutputTokens) ? modelRaw.maxOutputTokens
      : Number.isSafeInteger(modelRaw.maxTokens) ? modelRaw.maxTokens
      : Number.isSafeInteger(modelRaw.max_output_tokens) ? modelRaw.max_output_tokens
        : Number.isSafeInteger(modelRaw.outputTokens) ? modelRaw.outputTokens
          : null,
  };
}

function nativeAuth(agent, environment, config, checkAuth) {
  if (checkAuth) return checkAuth;
  if (agent === 'claude') {
    if (CLAUDE_AUTH_ENV_NAMES.some(name => environment[name] !== undefined)) return { state: 'observed', source: 'env' };
    if (config.authEnvNames?.length) return { state: 'observed', source: 'settings.env' };
    return { state: 'unknown', source: 'native-config' };
  }
  if (agent === 'codex') return { state: 'unknown', source: 'codex-login' };
  if (agent === 'pi') {
    const source = config.authEntries?.find(entry => entry.providerId === config.providerId && entry.type === 'api_key')?.source;
    if (source) return { state: 'observed', source: `pi.${source}.api_key` };
  }
  return { state: 'unknown', source: 'native-config' };
}

function nativeCapabilities(agent, config) {
  return {
    values: [],
    source: 'unknown',
    unverified: true,
    extensionsFingerprint: sha256({ agent, publicFields: config.publicFields, partial: config.partial }),
  };
}

function profileCapabilities(profile) {
  return {
    values: [...profile.capabilities],
    source: 'profile',
    unverified: true,
  };
}

function quotaFresh(quota, nowMs) {
  if (!quota?.observedAt) return false;
  const observed = Date.parse(quota.observedAt);
  if (!Number.isFinite(observed) || observed > nowMs || nowMs - observed > QUOTA_FRESH_TTL_MS) return false;
  if (!quota.expiresAt) return true;
  const expires = Date.parse(quota.expiresAt);
  return Number.isFinite(expires) && expires > nowMs;
}

function unknownQuota(observedAt = null) {
  return { state: 'unknown', remainingTokens: null, observedAt, expiresAt: null, fresh: false };
}

function normalizeQuota(quota, nowMs) {
  return {
    state: quota?.state || 'unknown',
    remainingTokens: quota?.remainingTokens ?? null,
    observedAt: quota?.observedAt ?? null,
    expiresAt: quota?.expiresAt ?? null,
    fresh: quotaFresh(quota, nowMs),
  };
}

function profileQuotaGroup(profile) {
  if (profile.account?.id) return { id: `account:${profile.account.id}`, source: 'profile.account.id', confidence: 'high' };
  const host = endpointHost(profile.endpoint);
  if (host) return { id: endpointBucket(profile.endpoint, profile.protocol), source: 'profile.endpoint', confidence: 'medium' };
  return { id: `profile:${profile.id}`, source: 'profile.id', confidence: 'low' };
}

function nativeQuotaGroup(agent, endpoint, profiles) {
  const host = endpointHost(endpoint);
  if (host) {
    return { id: endpointBucket(endpoint), source: 'native.endpoint', confidence: 'low' };
  }
  return { id: `native:${agent}:unknown`, source: 'native', confidence: 'low' };
}

function summarizeQuotaGroups(resources) {
  const groups = new Map();
  for (const resource of resources) {
    const existing = groups.get(resource.quotaGroup.id) || {
      id: resource.quotaGroup.id,
      source: resource.quotaGroup.source,
      confidence: resource.quotaGroup.confidence,
      resourceIds: [],
    };
    existing.resourceIds.push(resource.id);
    groups.set(resource.quotaGroup.id, existing);
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function parseVersion(stdout) {
  const firstLine = String(stdout || '').split(/\r?\n/).map(line => line.trim()).find(Boolean);
  if (!firstLine || firstLine.length > 128 || /@|:\/\//.test(firstLine)) return null;
  const version = firstLine.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/);
  return version ? version[0] : null;
}

function parseClaudeAuth(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (!plain(parsed)) return { state: 'unknown', source: 'claude auth status --json' };
    if (parsed.authenticated === true || parsed.status === 'authenticated' || parsed.loggedIn === true) return { state: 'observed', source: 'claude auth status --json' };
    if (parsed.authenticated === false || parsed.status === 'unauthenticated' || parsed.loggedIn === false) return { state: 'missing', source: 'claude auth status --json' };
  } catch {}
  return { state: 'unknown', source: 'claude auth status --json' };
}

function parseCodexAuth(stdout) {
  const text = String(stdout || '').toLowerCase();
  if (/not\s+logged\s+in|not\s+authenticated|logged\s+out|unauthenticated/.test(text)) return { state: 'missing', source: 'codex login status' };
  if (/\blogged\s+in\b|\bauthenticated\b/.test(text) && !/@/.test(text)) return { state: 'observed', source: 'codex login status' };
  return { state: 'unknown', source: 'codex login status' };
}

async function runProbe(runner, argv, environment, startedAt) {
  const remaining = CHECK_TOTAL_MS - (Date.now() - startedAt);
  if (remaining <= 0) {
    throw new OrchestratorError('resource_probe_timeout', 'Resource probes exceeded total timeout.');
  }
  return runner(argv, { env: environment, timeoutMs: Math.min(CHECK_TIMEOUT_MS, remaining), maxBytes: CHECK_MAX_BYTES });
}

async function checkNative(entry, executable, runner, environment, startedAt) {
  const result = { version: null, authentication: null, warnings: [] };
  if (!executable.executable) {
    result.missingExecutable = true;
    return result;
  }
  try {
    const version = await runProbe(runner, [executable.executable, '--version'], environment, startedAt);
    if (version.code === 0) result.version = parseVersion(version.stdout || version.stderr);
  } catch (error) {
    if (error?.code === 'command_spawn_failed') result.missingExecutable = true;
    else result.warnings.push({ code: 'resource_version_probe_failed', resourceId: entry.id, message: `${entry.agent} version probe failed.` });
  }

  if (entry.agent === 'claude') {
    try {
      const auth = await runProbe(runner, [executable.executable, 'auth', 'status', '--json'], environment, startedAt);
      if (auth.code === 0) result.authentication = parseClaudeAuth(auth.stdout);
      else result.authentication = { state: 'unknown', source: 'claude auth status --json' };
    } catch (error) {
      if (error?.code !== 'command_spawn_failed') result.authentication = { state: 'unknown', source: 'claude auth status --json' };
    }
  } else if (entry.agent === 'codex') {
    try {
      const auth = await runProbe(runner, [executable.executable, 'login', 'status'], environment, startedAt);
      if (auth.code === 0) result.authentication = parseCodexAuth(auth.stdout);
      else result.authentication = { state: 'unknown', source: 'codex login status' };
    } catch (error) {
      if (error?.code !== 'command_spawn_failed') result.authentication = { state: 'unknown', source: 'codex login status' };
    }
  }
  return result;
}

function probeSupport(resource, environment) {
  if (resource.kind === 'profile' && resource.agent === 'claude' && resource.protocol === 'anthropic' && resource.authentication.state === 'observed') {
    return { supported: true, reason: 'managed Claude Anthropic profile through gateway' };
  }
  if (resource.kind === 'profile' && resource.agent === 'pi' && resource.authentication.state === 'observed') {
    return { supported: true, reason: 'managed Pi profile has observed auth' };
  }
  if (resource.id === 'native-claude' && resource.authentication.state === 'observed' && ['env', 'settings.env'].includes(resource.authentication.source)) {
    return { supported: true, reason: 'native Claude has explicit Anthropic API environment' };
  }
  if (resource.agent === 'pi' && resource.authentication.state === 'observed' && resource.authentication.source.includes('api_key')) {
    return { supported: true, reason: 'native Pi provider has explicit API key auth' };
  }
  return { supported: false, reason: 'probe support is unverified for this resource' };
}

function publicProfileFingerprint(profile) {
  return sha256({
    id: profile.id,
    agent: profile.agent,
    model: profile.model,
    protocol: profile.protocol,
    endpointHost: endpointHost(profile.endpoint),
    credentialType: profile.credential?.type || 'none',
    source: profile.source?.type || 'native',
    capabilities: profile.capabilities,
    quotaGroup: profileQuotaGroup(profile),
    revision: profile.revision || null,
  });
}

function publicProfileResourceFingerprint(profile, nativeResource) {
  return sha256({
    profile: publicProfileFingerprint(profile),
    native: nativeResource ? {
      fingerprint: nativeResource.fingerprint,
      installed: nativeResource.installed,
      executable: nativeResource.executable,
      discoverySource: nativeResource.discoverySource,
      // Only the observed version participates; the observation timestamp would change the
      // fingerprint on every `resources check` and invalidate unrelated calibration records.
      version: nativeResource.version,
    } : null,
  });
}

function nativeFingerprint(entry, config, executable, version) {
  return sha256({
    id: entry.id,
    agent: entry.agent,
    executableInstalled: executable.installed,
    executablePathHash: executable.pathHash,
    executableFile: executable.file,
    discoverySource: executable.discoverySource,
    version,
    publicConfig: config.publicFields,
    files: config.files,
  });
}

function nativeModelFingerprint(entry, config, executable, version, provider, model) {
  return sha256({
    id: entry.id,
    agent: entry.agent,
    provider,
    model,
    executableInstalled: executable.installed,
    executablePathHash: executable.pathHash,
    executableFile: executable.file,
    discoverySource: executable.discoverySource,
    version,
    files: config.files,
  });
}

function nativeBasisFingerprint(entry, config, executable) {
  return nativeFingerprint(entry, config, executable, null);
}

function piModelResourceId(providerId, modelId) {
  return `native-pi-${sha256({ providerId, modelId }).slice(0, 16)}`;
}

function piProviderAuth(config, providerId) {
  const apiKeyEntry = config.authEntries?.find(entry => entry.providerId === providerId && entry.type === 'api_key');
  if (apiKeyEntry) return { state: 'observed', source: `pi.${apiKeyEntry.source}.api_key` };
  const entry = config.authEntries?.find(item => item.providerId === providerId);
  if (entry) return { state: 'unknown', source: `pi.${entry.source}.${entry.type}` };
  return { state: 'unknown', source: 'pi.auth' };
}

function piProviderCapabilities(provider, model) {
  return {
    values: [],
    source: 'pi.models.json',
    unverified: true,
    provider: {
      providerId: provider.providerId,
      api: provider.api,
      baseUrl: provider.baseUrl,
    },
    model: {
      id: model.id,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
    },
  };
}

function versionObservationFresh(observation, nowMs) {
  if (!observation?.observedAt || !observation?.basisFingerprint) return false;
  const observed = Date.parse(observation.observedAt);
  return Number.isFinite(observed) && observed <= nowMs && nowMs - observed <= VERSION_OBSERVATION_TTL_MS;
}

async function readStoredInventory(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return plain(parsed) && Array.isArray(parsed.resources) ? parsed : null;
  } catch {
    return null;
  }
}

function calibrationCallVerification(record, fresh) {
  return {
    state: fresh ? (record.checks.some(check => check.id === 'completed-response' && check.passed) ? 'verified' : 'unavailable') : 'stale',
    suite: record.suiteId,
    source: 'calibration',
    observedAt: record.observedAt,
    expiresAt: record.expiresAt,
    errorCode: record.errorCode,
    qualityStatus: record.status,
  };
}

function taskEvidenceCallVerification(record, fresh) {
  return {
    state: fresh ? 'verified' : 'stale',
    suite: record.suiteId,
    source: record.source,
    observedAt: record.observedAt,
    expiresAt: record.expiresAt,
    errorCode: null,
    qualityStatus: record.qualityStatus,
  };
}

function unknownCallVerification() {
  return { state: 'unknown', suite: null, source: null, observedAt: null, expiresAt: null, errorCode: null, qualityStatus: null };
}

function selectCallVerification({ calibration, taskEvidence, nowMs }) {
  const nonFutureTaskEvidence = taskEvidence.filter(record => record.observedAt <= nowMs);
  const latestTaskEvidence = nonFutureTaskEvidence.at(-1) || null;
  const calibrationFresh = Boolean(calibration && calibration.observedAt <= nowMs && calibration.expiresAt > nowMs);
  const calibrationView = calibration ? calibrationCallVerification(calibration, calibrationFresh) : null;
  const freshNegativeCalibration = calibrationView?.state === 'unavailable' && calibrationFresh;
  if (freshNegativeCalibration && (!latestTaskEvidence || calibration.observedAt >= latestTaskEvidence.observedAt)) {
    return { callVerification: calibrationView, observedModel: null };
  }
  const taskFresh = Boolean(latestTaskEvidence && latestTaskEvidence.fresh);
  const taskView = latestTaskEvidence ? taskEvidenceCallVerification(latestTaskEvidence, taskFresh) : null;

  if (calibrationView && taskView) {
    const useTask = calibration.observedAt > nowMs || taskView.observedAt > calibrationView.observedAt;
    const selected = useTask ? taskView : calibrationView;
    return {
      callVerification: selected,
      observedModel: selected.source === 'calibration' && selected.state === 'verified' && calibrationFresh ? calibration.servedModel : null,
    };
  }
  if (taskView) return { callVerification: taskView, observedModel: null };
  if (calibrationView) {
    return {
      callVerification: calibrationView,
      observedModel: calibrationView.state === 'verified' && calibrationFresh ? calibration.servedModel : null,
    };
  }
  return { callVerification: unknownCallVerification(), observedModel: null };
}

export class ResourceService {
  constructor({ root, home = os.homedir(), environment = process.env, runner = runCommand, now = Date.now, profiles } = {}) {
    invariant(typeof root === 'string' && root.length > 0, 'invalid_resource_service', 'ResourceService requires root.');
    this.root = path.resolve(root);
    this.home = path.resolve(home);
    this.environment = environment;
    this.runner = runner;
    this.now = now;
    this.profiles = profiles || new ProfileStore({ root: this.root });
  }

  inventoryFile() {
    return path.join(this.root, 'resources', 'inventory.json');
  }

  async discover({ check = false, agents } = {}) {
    const observedAt = isoFromNow(this.now);
    const nowMs = Date.parse(observedAt);
    const warnings = [];
    const agentFilter = agents ? new Set(Array.isArray(agents) ? agents : String(agents).split(',').map(value => value.trim()).filter(Boolean)) : null;
    const profiles = await this.profiles.list();
    const storedInventory = check ? null : await readStoredInventory(this.inventoryFile());
    const startedAt = Date.now();
    const resources = [];

    for (const entry of NATIVE_AGENTS) {
      if (agentFilter && !agentFilter.has(entry.agent)) continue;
      const [config, executable] = await Promise.all([
        nativeConfig(entry.agent, this.home, this.environment),
        findExecutableBounded(entry.executable, { home: this.home, environment: this.environment }),
      ]);
      let version = null;
      let versionObservation = { source: 'not-checked', observedAt: null, fresh: false };
      let installed = executable.installed;
      let checkAuth = null;
      const basisFingerprint = nativeBasisFingerprint(entry, config, executable);
      if (check) {
        const checked = await checkNative(entry, executable, this.runner, this.environment, startedAt);
        version = checked.version;
        versionObservation = { source: 'version-probe', observedAt: version ? observedAt : null, fresh: Boolean(version), basisFingerprint };
        if (checked.missingExecutable) installed = false;
        checkAuth = checked.authentication;
        warnings.push(...checked.warnings);
      } else {
        const stored = storedInventory?.resources?.find(resource => resource.id === entry.id);
        if (stored?.version && stored?.versionObservation?.basisFingerprint === basisFingerprint && versionObservationFresh(stored.versionObservation, nowMs)) {
          version = stored.version;
          versionObservation = { ...stored.versionObservation, fresh: true };
          // Reuse probe-observed authentication for the same configuration so OAuth-only
          // installations stay `configured` in list mode, which adaptive dispatch relies on.
          if (stored.authentication?.state === 'observed' && typeof stored.authentication.source === 'string') {
            checkAuth = { state: 'observed', source: stored.authentication.source };
          }
        }
      }
      const authentication = nativeAuth(entry.agent, this.environment, config, checkAuth);
      const resource = {
        schemaVersion: SCHEMA_VERSION,
        id: entry.id,
        kind: 'native',
        agent: entry.agent,
        profileId: null,
        providerId: config.providerId || null,
        fingerprint: nativeFingerprint(entry, config, executable, version),
        installed,
        executable: executable.executable,
        discoverySource: executable.discoverySource,
        executableDiscoverySource: executable.discoverySource,
        configured: Boolean(config.requestedModel || config.endpoint || authentication.state === 'observed'),
        version,
        versionObservation,
        requestedModel: config.requestedModel,
        endpoint: config.endpoint || null,
        observedModel: null,
        effort: config.effort,
        authentication,
        quotaGroup: nativeQuotaGroup(entry.agent, config.endpoint, profiles),
        quota: unknownQuota(check ? observedAt : null),
        capabilities: nativeCapabilities(entry.agent, config),
        probe: { supported: false, reason: 'computed after resource normalization' },
      };
      resource.probe = probeSupport(resource, this.environment);
      resources.push(resource);

      if (entry.agent === 'pi') {
        for (const provider of config.modelProviders || []) {
          for (const model of provider.models || []) {
            const authentication = piProviderAuth(config, provider.providerId);
            const modelResource = {
              schemaVersion: SCHEMA_VERSION,
              id: piModelResourceId(provider.providerId, model.id),
              kind: 'native',
              agent: 'pi',
              profileId: null,
              providerId: provider.providerId,
              fingerprint: nativeModelFingerprint(entry, config, executable, version, provider, model),
              installed,
              executable: executable.executable,
              discoverySource: executable.discoverySource,
              executableDiscoverySource: executable.discoverySource,
              configured: installed && authentication.state !== 'missing',
              version,
              versionObservation,
              requestedModel: model.id,
              endpoint: provider.baseUrl || null,
              observedModel: null,
              effort: config.effort,
              authentication,
              quotaGroup: { id: `native:pi:${provider.providerId}`, source: 'pi.providerId', confidence: 'medium' },
              quota: unknownQuota(check ? observedAt : null),
              capabilities: piProviderCapabilities(provider, model),
              probe: { supported: false, reason: 'computed after resource normalization' },
            };
            modelResource.probe = probeSupport(modelResource, this.environment);
            resources.push(modelResource);
          }
        }
      }
    }

    for (const profile of profiles) {
      if (agentFilter && !agentFilter.has(profile.agent)) continue;
      const nativeResource = resources.find(resource => resource.id === `native-${profile.agent}`) || null;
      let authState = 'unknown';
      if (profile.credential?.type === 'none') authState = 'observed';
      else if (profile.credential?.type === 'env') authState = this.environment[profile.credential.name] === undefined ? 'missing' : 'observed';
      else {
        try { authState = await this.profiles.credentialAvailable(profile) ? 'observed' : 'missing'; }
        catch { authState = 'unknown'; }
      }
      const resource = {
        schemaVersion: SCHEMA_VERSION,
        id: `profile-${profile.id}`,
        kind: 'profile',
        agent: profile.agent,
        profileId: profile.id,
        providerId: null,
        fingerprint: publicProfileResourceFingerprint(profile, nativeResource),
        installed: nativeResource?.installed ?? false,
        executable: nativeResource?.executable ?? null,
        discoverySource: nativeResource?.discoverySource ?? null,
        executableDiscoverySource: nativeResource?.executableDiscoverySource ?? null,
        configured: profile.enabled && authState !== 'missing',
        version: nativeResource?.version ?? null,
        versionObservation: nativeResource?.versionObservation ?? { source: 'profile', observedAt: null, fresh: false },
        requestedModel: profile.model,
        endpoint: profile.endpoint,
        observedModel: null,
        effort: null,
        authentication: { state: authState, source: `profile.credential.${profile.credential?.type || 'none'}` },
        quotaGroup: profileQuotaGroup(profile),
        quota: normalizeQuota(profile.quota, nowMs),
        capabilities: profileCapabilities(profile),
        probe: { supported: false, reason: 'computed after resource normalization' },
        protocol: profile.protocol,
        sourceType: profile.source?.type || 'native',
      };
      resource.probe = probeSupport(resource, this.environment);
      resources.push(resource);
    }

    resources.sort((a, b) => a.id.localeCompare(b.id));
    const calibrations = await new CalibrationStore({ root: this.root }).list();
    await Promise.all(resources.map(async resource => {
      const record = calibrations.filter(row => row.source === 'real' && row.resourceId === resource.id && row.fingerprint === resource.fingerprint && row.environmentFingerprint === PROBE_ENVIRONMENT && row.suiteVersion === '1').at(-1);
      const evidence = await readTaskEvidenceForResource({ root: this.root, resourceId: resource.id, fingerprint: resource.fingerprint, now: this.now });
      const matchingTaskEvidence = evidence.record ? [{ ...evidence.record, fresh: evidence.fresh, freshnessReason: evidence.reason }] : [];
      const selectedEvidence = selectCallVerification({ calibration: record, taskEvidence: matchingTaskEvidence, nowMs });
      resource.callVerification = selectedEvidence.callVerification;
      if (selectedEvidence.observedModel) resource.observedModel = selectedEvidence.observedModel;
    }));
    const inventory = {
      schemaVersion: SCHEMA_VERSION,
      observedAt,
      resources: resources.map(({ protocol, sourceType, ...resource }) => resource),
      quotaGroups: summarizeQuotaGroups(resources),
      warnings,
    };
    if (check) {
      await mkdir(path.dirname(this.inventoryFile()), { recursive: true, mode: 0o700 });
      await writeJsonAtomic(this.inventoryFile(), inventory);
    }
    return inventory;
  }

  async get(id, { check = false } = {}) {
    const inventory = await this.discover({ check });
    const resource = inventory.resources.find(item => item.id === id);
    if (!resource) throw new OrchestratorError('resource_not_found', 'Resource does not exist.', { id });
    return resource;
  }
}

export default ResourceService;
