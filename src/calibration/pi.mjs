import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { invariant } from '../errors.mjs';
import { providerFailure } from './environment.mjs';

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 1024 * 1024;
const PROTOCOL_API = {
  anthropic: 'anthropic-messages',
  'openai-chat': 'openai-completions',
  'openai-responses': 'openai-responses',
};

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value, max = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value) ? value : null;
}

async function readJsonObject(file) {
  try {
    const info = await fs.lstat(file);
    invariant(info.isFile() && !info.isSymbolicLink() && info.size <= MAX_CONFIG_BYTES, 'native_config_unsupported', 'Native Pi config cannot be read safely.');
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return plain(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error.name === 'SyntaxError') invariant(false, 'native_config_invalid', 'Native Pi config is invalid.');
    throw error;
  }
}

function piAgentDir(home, environment) {
  return path.resolve(environment.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent'));
}

function modelsProviders(models) {
  if (plain(models?.providers)) return models.providers;
  return models;
}

function parseProviderModel(resource, settings) {
  let providerId = safeString(resource.providerId, 256) || safeString(settings.defaultProvider, 256) || safeString(settings.provider, 256) || null;
  let model = safeString(resource.requestedModel, 256) || safeString(settings.defaultModel, 256) || safeString(settings.model, 256) || null;
  if (providerId && model?.startsWith(`${providerId}/`)) {
    model = model.slice(providerId.length + 1);
  }
  invariant(providerId, 'native_probe_config_unavailable', 'Native Pi calibration requires a configured provider.');
  invariant(model, 'probe_model_unknown', 'Native Pi calibration requires a configured model.');
  return { providerId, model };
}

function resolveConfigValue(value, environment, label) {
  const raw = safeString(value, 65536);
  if (!raw) return null;
  invariant(!raw.startsWith('!'), 'native_probe_auth_unsupported', `${label} uses a command-backed credential, which calibration will not execute.`);
  const simple = raw.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/) || raw.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)}$/);
  if (simple) {
    const resolved = safeString(environment[simple[1]], 65536);
    invariant(resolved, 'native_probe_auth_unavailable', `${label} environment credential is unavailable.`);
    return resolved;
  }
  invariant(!raw.includes('$'), 'native_probe_auth_unsupported', `${label} uses interpolated credentials, which calibration will not evaluate.`);
  return raw.startsWith('$!') ? raw.slice(1) : raw;
}

function selectedApiKey({ providerId, providerConfig, auth, environment }) {
  const credential = auth[providerId];
  if (plain(credential)) {
    if (credential.type === 'api_key' && safeString(credential.key, 65536)) return credential.key;
    if (credential.type === 'oauth' || credential.access || credential.refresh) {
      invariant(false, 'native_probe_auth_unsupported', 'Native Pi calibration cannot copy OAuth credentials.');
    }
  }
  const configured = resolveConfigValue(providerConfig?.apiKey, environment, `provider ${providerId} apiKey`);
  if (configured) return configured;
  invariant(false, 'native_probe_auth_unavailable', 'Native Pi calibration requires a selected API key credential.');
}

function publicProviderConfig(providerId, providerConfig, model) {
  if (!plain(providerConfig)) return null;
  const output = {};
  for (const key of ['name', 'baseUrl', 'api', 'authHeader', 'compat']) {
    if (providerConfig[key] !== undefined) output[key] = providerConfig[key];
  }
  const models = Array.isArray(providerConfig.models) ? providerConfig.models : [];
  const selectedModels = models.filter(entry => plain(entry) && entry.id === model);
  output.models = selectedModels.length ? selectedModels.map(entry => sanitizeModel(entry, providerConfig.api)) : [compatModel(model, providerConfig.api)];
  return { [providerId]: output };
}

function sanitizeModel(model, inheritedApi) {
  return {
    id: safeString(model.id, 256),
    name: safeString(model.name, 256) || safeString(model.id, 256),
    api: safeString(model.api, 128) || safeString(inheritedApi, 128) || undefined,
    reasoning: model.reasoning === true,
    input: Array.isArray(model.input) ? model.input.filter(value => ['text', 'image'].includes(value)) : ['text'],
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : 128000,
    maxTokens: Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : 8192,
    ...(plain(model.compat) ? { compat: model.compat } : {}),
    ...(plain(model.thinkingLevelMap) ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
  };
}

function compatModel(model, api) {
  return {
    id: model,
    name: model,
    api,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    compat: { source: 'calibration-compatibility-default' },
  };
}

async function writeJsonPrivate(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

async function nativeConfig(resource, { directory, home, environment }) {
  const source = piAgentDir(home, environment);
  let settingsFile = path.join(source, 'settings.json');
  if (!environment.PI_CODING_AGENT_DIR) {
    try { await fs.lstat(settingsFile); }
    catch (error) { if (error.code === 'ENOENT') settingsFile = path.join(home, '.pi', 'settings.json'); else throw error; }
  }
  const [settings, models, auth] = await Promise.all([
    readJsonObject(settingsFile),
    readJsonObject(path.join(source, 'models.json')),
    readJsonObject(path.join(source, 'auth.json')),
  ]);
  const { providerId, model } = parseProviderModel(resource, settings);
  const providers = modelsProviders(models);
  const providerConfig = plain(providers?.[providerId]) ? providers[providerId] : null;
  const key = selectedApiKey({ providerId, providerConfig, auth, environment });
  const modelsConfig = providerConfig ? { providers: publicProviderConfig(providerId, providerConfig, model) } : null;
  return {
    providerId,
    model,
    modelArg: model,
    auth: { [providerId]: { type: 'api_key', key } },
    modelsConfig,
    capacityProfile: nativeCapacityProfile(resource, providerConfig),
  };
}

function nativeCapacityProfile(resource, providerConfig) {
  const endpoint = safeProviderEndpoint(providerConfig?.baseUrl);
  return {
    id: resource.id,
    protocol: 'native-pi',
    ...(endpoint ? { endpoint } : {}),
    account: { maxParallel: 1 },
  };
}

function safeProviderEndpoint(value) {
  const raw = safeString(value, 2048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    const pathname = url.pathname.replace(/\/$/, '') || '';
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return null;
  }
}

async function profileConfig(resource, { profiles, environment }) {
  const profile = resource.profile || await profiles?.get?.(resource.profileId);
  invariant(plain(profile) && profile.agent === 'pi', 'probe_adapter_unavailable', 'Pi calibration requires a Pi execution profile.');
  invariant(Object.hasOwn(PROTOCOL_API, profile.protocol), 'probe_protocol_unavailable', 'Pi profile protocol is not supported for calibration.');
  const endpoint = safeEndpoint(profile.endpoint, profile.protocol);
  const token = await resolveProfileCredential(profile, profiles, environment);
  const providerId = `cao_calibration_${crypto.randomBytes(8).toString('hex')}`;
  const model = safeString(profile.model, 256);
  invariant(model, 'probe_model_unknown', 'Pi calibration requires an explicit profile model.');
  const metadata = plain(profile.modelMetadata) ? profile.modelMetadata : null;
  const providerConfig = {
    name: 'HarnessOrbit Calibration',
    baseUrl: profile.protocol === 'anthropic' || endpoint.endsWith('/v1') ? endpoint : `${endpoint}/v1`,
    api: PROTOCOL_API[profile.protocol],
    apiKey: token || 'cao-loopback-probe',
    models: [compatModel(model, PROTOCOL_API[profile.protocol])],
  };
  providerConfig.models[0].contextWindow = metadata?.contextWindow ?? providerConfig.models[0].contextWindow;
  providerConfig.models[0].maxTokens = metadata?.maxOutputTokens ?? metadata?.maxTokens ?? providerConfig.models[0].maxTokens;
  providerConfig.models[0].compat = { ...(providerConfig.models[0].compat || {}), source: metadata ? 'profile-declared-or-compatibility-default' : 'compatibility-default' };
  return {
    providerId,
    model,
    modelArg: model,
    auth: {},
    modelsConfig: { providers: { [providerId]: providerConfig } },
    capacityProfile: profile,
  };
}

function safeEndpoint(value, protocol) {
  const raw = safeString(value, 2048);
  invariant(raw, 'probe_endpoint_invalid', 'Pi profile endpoint is invalid.');
  let url;
  try { url = new URL(raw); }
  catch { invariant(false, 'probe_endpoint_invalid', 'Pi profile endpoint is invalid.'); }
  invariant(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'probe_endpoint_invalid', 'Pi profile endpoint is invalid.');
  const pathname = url.pathname.replace(/\/$/, '') || '';
  return `${url.protocol}//${url.host}${pathname}`.replace(/\/v1$/, protocol === 'anthropic' ? '/v1' : '');
}

async function resolveProfileCredential(profile, profiles, environment) {
  const credential = profile.credential || { type: 'none' };
  if (credential.type === 'none') return null;
  if (credential.type === 'env') {
    const value = safeString(environment[credential.name], 65536);
    invariant(value, 'native_probe_auth_unavailable', 'Profile credential environment variable is unavailable.');
    return value;
  }
  if (profiles?.resolveProfileSecret) return profiles.resolveProfileSecret(profile);
  invariant(false, 'native_probe_auth_unavailable', 'Profile credential resolver is unavailable.');
}

function minimalEnvironment(base, directory) {
  const env = {};
  for (const key of ['PATH', 'TMPDIR', 'SystemRoot', 'WINDIR', 'COMSPEC']) {
    if (base[key]) env[key] = base[key];
  }
  env.HOME = directory;
  env.USERPROFILE = directory;
  env.TMPDIR ||= directory;
  env.PI_CODING_AGENT_DIR = path.join(directory, 'pi');
  env.PI_CODING_AGENT_SESSION_DIR = path.join(directory, 'sessions');
  env.PI_OFFLINE = '1';
  env.PI_TELEMETRY = '0';
  return env;
}

export async function preparePiProbe(resource, { directory, home, environment = process.env, profiles, suite = 'quick' } = {}) {
  invariant(plain(resource) && resource.agent === 'pi', 'probe_adapter_unavailable', 'Pi calibration requires a Pi resource.');
  invariant(safeString(directory), 'invalid_calibration', 'Pi calibration requires a temporary directory.');
  invariant(safeString(home), 'invalid_calibration', 'Pi calibration requires a home directory.');
  invariant(['quick', 'code'].includes(suite), 'invalid_calibration', 'Unknown Pi calibration suite.');

  const workspace = path.join(directory, 'workspace');
  const piDir = path.join(directory, 'pi');
  const sessionDir = path.join(directory, 'sessions');
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  await fs.mkdir(piDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });

  const config = resource.kind === 'profile'
    ? await profileConfig(resource, { profiles, environment })
    : await nativeConfig(resource, { directory, home, environment });

  await writeJsonPrivate(path.join(piDir, 'settings.json'), {
    defaultProvider: config.providerId,
    defaultModel: config.modelArg,
    defaultProjectTrust: 'never',
    quietStartup: true,
  });
  await writeJsonPrivate(path.join(piDir, 'auth.json'), config.auth);
  if (config.modelsConfig) await writeJsonPrivate(path.join(piDir, 'models.json'), config.modelsConfig);

  const argv = [
    '--print',
    '--mode', 'json',
    '--provider', config.providerId,
    '--model', config.modelArg,
    '--no-session',
    '--session-dir', sessionDir,
    '--offline',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-approve',
  ];
  if (suite === 'quick') argv.push('--no-tools');
  else argv.push('--tools', 'read,edit,write');

  return {
    env: minimalEnvironment(environment, directory),
    argv,
    model: config.model,
    providerId: config.providerId,
    capacityProfile: config.capacityProfile,
  };
}

function usageOutputTokens(usage) {
  for (const key of ['output_tokens', 'outputTokens', 'output', 'completion_tokens', 'completionTokens']) {
    const value = usage?.[key];
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (plain(part)) return typeof part.text === 'string' ? part.text : typeof part.content === 'string' ? part.content : '';
    return '';
  }).join('');
}

export function observePiStream({ now = Date.now, startedAt = now() } = {}) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let bytes = 0;
  let firstEventMs = null;
  let outputTokens = null;
  let servedModel = null;
  let assistantText = '';
  let isError = false;
  let terminal = false;
  let failureCode = null;

  function eventLine(text) {
    if (!text.trim()) return;
    let event;
    try { event = JSON.parse(text); } catch { return; }
    failureCode ||= providerFailure(event.message?.errorMessage || event.error);
    if (['agent_start', 'message_start'].includes(event.type)) terminal = false;
    if (event.type === 'error' || event.isError === true || event.is_error === true) isError = true;
    if (event.model || event.message?.model || event.usage?.model) servedModel = String(event.model || event.message?.model || event.usage?.model).slice(0, 256);
    if (event.usage || event.message?.usage) outputTokens = usageOutputTokens(event.usage || event.message.usage) ?? outputTokens;
    const update = event.assistantMessageEvent;
    if (event.type === 'message_update' && update?.type === 'text_delta') {
      if (firstEventMs === null) firstEventMs = Math.max(0, now() - startedAt);
      assistantText += typeof update.delta === 'string' ? update.delta : '';
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      assistantText = contentText(event.message.content) || assistantText;
      const stopReason = event.message.stopReason || event.message.stop_reason;
      if (['error', 'aborted', 'length'].includes(stopReason)) isError = true;
      if (['stop', 'error', 'aborted', 'length'].includes(stopReason)) terminal = true;
    }
    if (event.type === 'turn_end' && event.message?.role === 'assistant') {
      assistantText = contentText(event.message.content) || assistantText;
      if (event.message.model) servedModel = String(event.message.model).slice(0, 256);
      const stopReason = event.message.stopReason || event.message.stop_reason;
      if (['error', 'aborted', 'length'].includes(stopReason)) isError = true;
      if (['stop', 'error', 'aborted', 'length'].includes(stopReason)) terminal = true;
    }
    if (event.type === 'agent_end' && Array.isArray(event.messages)) {
      terminal = true;
      const lastAssistant = event.messages.findLast?.(message => message.role === 'assistant')
        || [...event.messages].reverse().find(message => message.role === 'assistant');
      if (lastAssistant) assistantText = contentText(lastAssistant.content) || assistantText;
      if (lastAssistant?.model) servedModel = String(lastAssistant.model).slice(0, 256);
      if (['error', 'aborted', 'length', 'toolUse'].includes(lastAssistant?.stopReason)) isError = true;
      const counts = event.messages.filter(message => message.role === 'assistant').map(message => usageOutputTokens(message.usage));
      if (counts.length) outputTokens = counts.every(value => value !== null) ? counts.reduce((sum, value) => sum + value, 0) : null;
    }
  }

  return {
    onStdout(chunk) {
      bytes += chunk.length;
      invariant(bytes <= MAX_STREAM_BYTES, 'calibration_output_limit', 'Probe output exceeded its limit.');
      pending += decoder.write(chunk);
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        eventLine(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
    },
    finish() {
      pending += decoder.end();
      if (pending.trim()) eventLine(pending);
      const result = terminal ? {
        is_error: isError,
        result: assistantText,
        usage: { output_tokens: outputTokens },
      } : null;
      return { result, servedModel, firstEventMs, outputTokens, ...(failureCode ? { failureCode } : {}) };
    },
  };
}
