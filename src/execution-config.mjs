import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { invariant } from './errors.mjs';
import { writeJsonAtomic } from './state.mjs';
import { buildLaunch } from './adapters.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const safeCodexConfig = /^(?:model_reasoning_effort|model_reasoning_summary|model_verbosity)\s*=/;

export function validateProfileAgentArgs(agent, args) {
  const denied = {
    claude: new Set(['--settings', '--setting-sources', '--model', '--session-id', '--resume', '--continue', '-r', '-c', '--bare']),
    codex: new Set(['--model', '-m', '--profile', '-p', '--oss', '--local-provider', '--remote', '--remote-auth-token-env', '--cd', '-C', '--worktree']),
    pi: new Set(['--provider', '--model', '--models', '--api-key', '--session', '--session-id', '--session-dir', '--no-session', '--continue', '--resume', '--fork', '-c', '-r']),
    opencode: new Set(['--model', '-m', '--agent', '--session', '-s', '--continue', '-c', '--fork']),
  };
  for (let i = 0; i < args.length; i++) {
    let name = args[i].split('=')[0];
    if (/^-[^-]/.test(name) && name.length > 2 && denied[agent]?.has(name.slice(0, 2))) name = name.slice(0, 2);
    invariant(!denied[agent]?.has(name), 'execution_argument_conflict', `Execution profile owns ${name}; remove this conflicting agent argument.`);
    if (agent === 'codex' && (['-c', '--config'].includes(name) || /^-c.+/.test(name))) {
      const config = args[i].startsWith('-c') && !args[i].startsWith('--') && args[i].length > 2 ? args[i].slice(2) : args[i].includes('=') ? args[i].slice(args[i].indexOf('=') + 1) : args[++i];
      invariant(typeof config === 'string' && safeCodexConfig.test(config), 'execution_argument_conflict', 'Profiled Codex accepts only reasoning/verbosity -c overrides in agentArgs.');
    }
  }
}

export async function prepareExecution({ task, attempt, profile, gateway, environment = process.env }) {
  invariant(profile.agent && gateway.protocol === profile.protocol, 'execution_protocol_mismatch', 'Gateway protocol must match the selected profile.');
  validateProfileAgentArgs(profile.agent, task.agentArgs);
  const privateDirectory = path.join(attempt.directory, 'execution');
  await fs.mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const tokenInfo = await fs.lstat(gateway.tokenFile);
  invariant(tokenInfo.isFile() && !tokenInfo.isSymbolicLink() && tokenInfo.size <= 4096, 'invalid_gateway_token', 'Gateway token must be a private regular file.');
  const token = (await fs.readFile(gateway.tokenFile, 'utf8')).trim();
  invariant(token.length > 0 && !/[\x00-\x20\x7f]/.test(token), 'invalid_gateway_token', 'Gateway token format is invalid.');
  const ownerNonce = crypto.randomUUID();
  const files = [];
  const save = async (name, content) => {
    const file = path.join(privateDirectory, name);
    await fs.writeFile(file, content, { mode: 0o600, flag: 'wx' });
    files.push({ path: file, sha256: hash(content) });
    return file;
  };
  const saveJson = (name, value) => save(name, JSON.stringify(value, null, 2) + '\n');
  const nativeSessionId = ['claude', 'pi'].includes(profile.agent) ? crypto.randomUUID() : null;
  const launch = buildLaunch({ ...task, agent: profile.agent }, attempt.directory);
  const endpoint = gateway.endpoint.replace(/\/$/, '');
  const providerName = `cao_${ownerNonce.replaceAll('-', '').slice(0, 12)}`;
  const env = {};
  let nativeLogRoots;

  if (profile.agent === 'claude') {
    Object.assign(env, {
      ANTHROPIC_BASE_URL: endpoint,
      ANTHROPIC_AUTH_TOKEN: token,
      // Override an inherited key without triggering Claude's custom-key prompt.
      // The local gateway accepts the session's Authorization bearer token.
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_MODEL: profile.model,
    });
    if (environment.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = path.resolve(environment.CLAUDE_CONFIG_DIR);
    for (const role of ['HAIKU', 'SONNET', 'OPUS', 'FABLE']) {
      const selector = role.toLowerCase();
      env[`ANTHROPIC_DEFAULT_${role}_MODEL`] = Object.hasOwn(profile.modelMap, selector) ? selector : profile.model;
    }
    const settings = await saveJson('claude-settings.json', { env, model: profile.model });
    launch.args.push('--settings', settings, '--model', profile.model, '--session-id', nativeSessionId);
    nativeLogRoots = [path.resolve(environment.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')];
  } else if (profile.agent === 'codex') {
    // Command-backed auth also works when the CLI uses an existing app-server daemon.
    const tokenReader = await save('codex-token.cjs', `const fs = require('node:fs'); process.stdout.write(fs.readFileSync(${JSON.stringify(gateway.tokenFile)}, 'utf8').trim());\n`);
    const tomlString = value => JSON.stringify(value);
    const provider = `{name="HarnessOrbit",base_url=${tomlString(endpoint + '/v1')},wire_api="responses",supports_websockets=false,request_max_retries=0,stream_max_retries=0,auth={command=${tomlString(process.execPath)},args=[${tomlString(tokenReader)}],timeout_ms=5000,refresh_interval_ms=0}}`;
    launch.args.push('-c', `model=${tomlString(profile.model)}`, '-c', `model_provider=${tomlString(providerName)}`, '-c', `model_providers.${providerName}=${provider}`, '--add-dir', attempt.directory);
    nativeLogRoots = [path.resolve(environment.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions')];
  } else if (profile.agent === 'pi') {
    const api = { anthropic: 'anthropic-messages', 'openai-responses': 'openai-responses', 'openai-chat': 'openai-completions' }[profile.protocol];
    const options = await saveJson('pi-provider.json', {
      name: providerName, baseUrl: endpoint + (profile.protocol === 'anthropic' ? '' : '/v1'), api, apiKey: token,
      // Pi requires numeric cost fields; these zeros are transport placeholders,
      // never a measured price. The manifest records the unknown price source.
      models: [{ id: profile.model, name: profile.model, reasoning: profile.capabilities.includes('reasoning'), input: profile.capabilities.includes('vision') ? ['text', 'image'] : ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: profile.modelMetadata?.contextWindow ?? 128000, maxTokens: profile.modelMetadata?.maxOutputTokens ?? 8192 }],
    });
    const extension = await save('pi-provider.mjs', `import fs from 'node:fs';\nexport default function(pi) { const {name, ...config} = JSON.parse(fs.readFileSync(${JSON.stringify(options)}, 'utf8')); pi.registerProvider(name, config); }\n`);
    launch.args.push('--extension', extension, '--provider', providerName, '--model', profile.model, '--session-id', nativeSessionId);
    nativeLogRoots = [path.resolve(environment.PI_CODING_AGENT_SESSION_DIR || path.join(environment.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'sessions'))];
  } else if (profile.agent === 'opencode') {
    // Runtime inline config overrides project config while preserving unrelated settings.
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      model: `${providerName}/${profile.model}`,
      provider: { [providerName]: { npm: '@ai-sdk/openai-compatible', name: 'HarnessOrbit', options: { baseURL: endpoint + '/v1', apiKey: token }, models: { [profile.model]: { name: profile.model } } } },
    });
    launch.args.push('--model', `${providerName}/${profile.model}`);
    nativeLogRoots = [path.join(environment.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode')];
  }

  // Bootstrap contains a file path only; secret values are never sent as terminal text.
  const exports = Object.entries(env).map(([name, value]) => `export ${name}=${shellQuote(value)}`);
  const envFile = await save('environment.sh', ['set +x', 'set +v', ...exports, ''].join('\n'));
  const markerNonce = crypto.randomUUID();
  const manifest = {
    schemaVersion: 1, ownerNonce, agent: profile.agent, profileId: profile.id, profileRevision: profile.revision,
    gatewayId: gateway.id, privateDirectory, envFile, envKeys: Object.keys(env), files,
    kind: launch.kind, args: launch.args, nativeSession: { id: nativeSessionId, evidence: nativeSessionId ? 'requested-via-native-cli' : 'not-yet-observed', logRoots: nativeLogRoots },
    readyMarker: `CAO_ENV_${markerNonce}`,
    bootstrap: `set +x; set +v; . ${shellQuote(envFile)} && printf '\\nCAO_ENV_%s\\n' ${shellQuote(markerNonce)}`,
    globalConfigMutation: false,
    ...(profile.agent === 'pi' ? { modelMetadata: {
      contextWindow: profile.modelMetadata?.contextWindow ?? 128000,
      maxOutputTokens: profile.modelMetadata?.maxOutputTokens ?? 8192,
      source: profile.modelMetadata ? 'profile-declared' : 'compatibility-default', priceSource: 'unknown',
    } } : {}),
  };
  await writeJsonAtomic(path.join(privateDirectory, 'manifest.json'), manifest);
  return manifest;
}

export async function cleanupExecution(manifest) {
  if (!manifest) return { removed: [], retained: [] };
  const directory = await fs.lstat(manifest.privateDirectory);
  invariant(directory.isDirectory() && !directory.isSymbolicLink(), 'execution_owner_changed', 'Execution directory was replaced.');
  const saved = JSON.parse(await fs.readFile(path.join(manifest.privateDirectory, 'manifest.json'), 'utf8'));
  invariant(saved.ownerNonce === manifest.ownerNonce, 'execution_owner_changed', 'Execution manifest owner changed.');
  const removed = [], retained = [];
  for (const file of manifest.files) {
    invariant(path.dirname(file.path) === manifest.privateDirectory, 'execution_path_invalid', 'Execution resource is outside its owned directory.');
    try {
      const info = await fs.lstat(file.path);
      if (!info.isFile() || info.isSymbolicLink() || hash(await fs.readFile(file.path)) !== file.sha256) { retained.push(file.path); continue; }
      await fs.unlink(file.path); removed.push(file.path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { removed, retained };
}
