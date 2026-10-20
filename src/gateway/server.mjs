import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { writeJsonAtomic, readJson } from '../state.mjs';
import { discoverCCSwitch } from '../config-sources/cc-switch.mjs';

const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'authorization',
  'x-api-key',
  'cookie',
]);
const PROTECTED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
]);
const ALLOWED_PATHS = {
  anthropic: new Set(['/v1/messages', '/v1/messages/count_tokens', '/v1/models']),
  'openai-responses': new Set(['/v1/responses', '/v1/models']),
  'openai-chat': new Set(['/v1/chat/completions', '/v1/models']),
};
const FALLBACK_STATUSES = new Set([429, 500, 502, 503, 504]);

let activeRequests = 0;
let stopping = false;

function parseArgs(argv) {
  const index = argv.indexOf('--config');
  if (index === -1 || !argv[index + 1]) throw new Error('missing --config');
  return { configFile: argv[index + 1] };
}

async function logEvent(config, event) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), gatewayId: config.id, ...event })}\n`;
  await appendFile(config.logFile, line, { mode: 0o600 }).catch(() => {});
}

function sendJson(res, status, value, extraHeaders = {}) {
  if (res.headersSent) return;
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    ...extraHeaders,
  });
  res.end(body);
}

function protocolErrorBody(protocol, code, status, tried) {
  const message = 'Upstream request failed.';
  if (protocol === 'anthropic') {
    return { type: 'error', error: { type: code, message }, status, tried };
  }
  return { error: { message, type: 'upstream_error', code }, status, tried };
}

function bearer(req) {
  const value = req.headers.authorization;
  if (typeof value !== 'string') return null;
  const match = value.match(/^Bearer (.+)$/i);
  return match?.[1] ?? null;
}

function internalAuthorized(req, config) {
  return req.headers['x-cao-owner-nonce'] === config.ownerNonce;
}

function apiKey(req) {
  const value = req.headers['x-api-key'];
  return typeof value === 'string' ? value : null;
}

function callerAuthorized(req, token, config) {
  if (bearer(req) === token) return true;
  return config.protocol === 'anthropic' && apiKey(req) === token;
}

function healthAuthorized(req, token, config) {
  return callerAuthorized(req, token, config) || internalAuthorized(req, config);
}

function ownerProof(config) {
  return createHash('sha256').update(config.ownerNonce).digest('hex');
}

function requestPath(req) {
  const url = new URL(req.url, 'http://127.0.0.1');
  return url.pathname;
}

function protocolPathAllowed(protocol, pathname) {
  return ALLOWED_PATHS[protocol]?.has(pathname) === true;
}

function appendBasePath(endpoint, pathname) {
  const url = new URL(endpoint);
  const base = url.pathname.replace(/\/+$/, '');
  const suffix = pathname.startsWith('/v1/') && base.endsWith('/v1')
    ? pathname.slice('/v1'.length)
    : pathname;
  url.pathname = `${base}${suffix}`.replace(/\/{2,}/g, '/');
  url.search = '';
  url.hash = '';
  return url;
}

function responseHeaders(upstreamHeaders) {
  const headers = {};
  for (const [key, value] of Object.entries(upstreamHeaders)) {
    const lower = key.toLowerCase();
    if (PROTECTED_RESPONSE_HEADERS.has(lower) || value === undefined) continue;
    headers[lower] = value;
  }
  return headers;
}

function outgoingHeaders(req, profile, secret, bodyLength) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (HOP_HEADERS.has(lower) || lower.startsWith('x-cao-')) continue;
    headers[lower] = value;
  }
  headers.host = new URL(profile.endpoint).host;
  if (bodyLength !== null) headers['content-length'] = String(bodyLength);
  if (profile.credential?.type !== 'none') {
    if (profile.protocol === 'anthropic' && profile.credential?.authScheme !== 'bearer') {
      headers['x-api-key'] = secret;
      delete headers.authorization;
    } else {
      headers.authorization = `Bearer ${secret}`;
    }
  }
  return headers;
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('body too large');
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function rewriteBody(buffer, profile, pathname) {
  const passthrough = { body: buffer, requestedModel: null, resolvedModel: null, hasState: false };
  if (buffer.length === 0 || reqMaySkipRewrite(pathname)) return passthrough;
  let value;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    return passthrough;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return passthrough;
  }
  const requestedModel = typeof value.model === 'string' ? value.model : null;
  const mapped = requestedModel && profile.modelMap?.[requestedModel] ? profile.modelMap[requestedModel] : profile.model;
  if (typeof mapped === 'string' && mapped.length > 0) value.model = mapped;
  return {
    body: Buffer.from(JSON.stringify(value)),
    requestedModel,
    resolvedModel: typeof value.model === 'string' ? value.model : null,
    hasState: typeof value.previous_response_id === 'string' && value.previous_response_id.length > 0,
  };
}

function reqMaySkipRewrite(pathname) {
  return pathname === '/v1/models';
}

function secretForProfile(config, profile) {
  if (profile.credential?.type === 'none') return null;
  const name = config.secretEnv?.[profile.id];
  const value = name ? process.env[name] : null;
  if (!value || /[\x00-\x1f\x7f]/.test(value)) {
    const error = new Error('missing secret');
    error.code = 'missing_secret';
    throw error;
  }
  return value;
}

async function assertProfileSourceCurrent(profile) {
  if (profile.source?.type !== 'cc-switch') return true;
  const inventory = await discoverCCSwitch({ directory: profile.source.directory });
  const current = inventory.providers.find(
    (provider) => provider.providerId === profile.source.providerId && provider.app === profile.source.app,
  );
  if (!current) {
    const error = new Error('source profile missing');
    error.code = 'profile_source_missing';
    throw error;
  }
  if (current.fingerprint !== profile.source.fingerprint) {
    const error = new Error('source profile drift');
    error.code = 'profile_source_drift';
    throw error;
  }
  return true;
}

function upstreamRequest(req, profile, config, pathname, body, { signal }) {
  const url = appendBasePath(profile.endpoint, pathname);
  const client = url.protocol === 'https:' ? https : http;
  const secret = secretForProfile(config, profile);
  const headers = outgoingHeaders(req, profile, secret, body.length);
  return new Promise((resolve, reject) => {
    let upstreamConnected = false;
    const request = client.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: req.method,
      headers,
      timeout: config.upstreamTimeoutMs,
    }, (response) => resolve({ response, url }));
    request.on('socket', (socket) => {
      // A reused keep-alive socket is already open and never emits connect again;
      // bytes may reach upstream immediately, so treat it as connected.
      if (socket.readyState === 'open') upstreamConnected = true;
      socket.once('connect', () => {
        upstreamConnected = true;
      });
      socket.once('secureConnect', () => {
        upstreamConnected = true;
      });
    });
    const rejectWithContext = (error) => {
      if (upstreamConnected && error?.code !== 'client_cancelled') {
        error.code = 'upstream_result_uncertain';
      }
      reject(error);
    };
    request.on('timeout', () => {
      request.destroy(Object.assign(new Error('upstream timeout'), { code: 'upstream_timeout' }));
    });
    request.on('error', rejectWithContext);
    signal?.addEventListener?.('abort', () => {
      request.destroy(Object.assign(new Error('client cancelled'), { code: 'client_cancelled' }));
    }, { once: true });
    if (body.length > 0) request.write(body);
    request.end();
  });
}

async function discardResponse(response) {
  for await (const _chunk of response) {
    // Intentionally discard upstream error bodies to keep payloads and secrets out of logs.
  }
}

function retryAfterHeader(response) {
  const value = response.headers['retry-after'];
  if (typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value)) return { 'retry-after': value };
  return {};
}

async function pipeResponse(upstream, res, abortController) {
  res.writeHead(upstream.statusCode ?? 502, responseHeaders(upstream.headers));
  return await new Promise((resolve, reject) => {
    upstream.on('data', (chunk) => {
      if (!res.write(chunk)) upstream.pause();
    });
    res.on('drain', () => upstream.resume());
    upstream.on('end', () => {
      res.end();
      resolve();
    });
    upstream.on('error', (error) => {
      // Headers are already sent; close the client response instead of leaving it hanging.
      res.destroy(error);
      reject(error);
    });
    res.on('close', () => {
      abortController.abort();
      resolve();
    });
  });
}

function fallbackCandidates(config) {
  return config.profiles;
}

function canFallback({ delivered, statusCode, error }) {
  if (delivered) return false;
  if (error) {
    return ![
      'missing_secret',
      'client_cancelled',
      'profile_source_missing',
      'profile_source_drift',
      'cc_switch_unsupported_schema',
      'upstream_result_uncertain',
    ].includes(error.code);
  }
  return FALLBACK_STATUSES.has(statusCode);
}

async function handleProxy(req, res, config) {
  const pathname = requestPath(req);
  if (!protocolPathAllowed(config.protocol, pathname) || !['GET', 'POST'].includes(req.method)) {
    sendJson(res, 404, { error: { code: 'gateway_path_not_allowed' } });
    return;
  }

  let originalBody = Buffer.alloc(0);
  try {
    if (req.method !== 'GET') originalBody = await readBody(req, config.bodyLimitBytes);
  } catch (error) {
    sendJson(res, error.code === 'body_too_large' ? 413 : 400, { error: { code: error.code ?? 'invalid_body' } });
    return;
  }

  const primaryRewrite = rewriteBody(originalBody, config.profiles[0], pathname);
  let delivered = false;
  let lastStatus = null;
  let lastError = null;
  let lastRetryAfter = {};
  const tried = [];

  for (const [index, profile] of fallbackCandidates(config).entries()) {
    if (index > 0 && primaryRewrite.hasState && profile.endpoint !== config.profiles[0].endpoint) {
      lastError = Object.assign(new Error('stateful fallback blocked'), { code: 'stateful_fallback_blocked' });
      await logEvent(config, {
        event: 'fallback_blocked',
        reason: 'previous_response_id_endpoint_switch',
        fromProfileId: config.profiles[0].id,
        toProfileId: profile.id,
      });
      break;
    }

    const rewrite = rewriteBody(originalBody, profile, pathname);
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    tried.push(profile.id);
    await logEvent(config, {
      event: index === 0 ? 'route_attempt' : 'fallback_attempt',
      profileId: profile.id,
      protocol: profile.protocol,
      endpointHost: new URL(profile.endpoint).host,
      path: pathname,
      requestedModel: rewrite.requestedModel,
      resolvedModel: rewrite.resolvedModel,
    }).catch(() => {});

    try {
      await assertProfileSourceCurrent(profile);
      const { response, url } = await upstreamRequest(req, profile, config, pathname, rewrite.body, { signal: controller.signal });
      lastStatus = response.statusCode ?? 502;
      if (lastStatus >= 300 && lastStatus < 400) {
        await discardResponse(response);
        lastError = Object.assign(new Error('upstream redirect rejected'), { code: 'upstream_redirect_rejected' });
        break;
      }
      if (lastStatus >= 400) {
        lastRetryAfter = retryAfterHeader(response);
        await discardResponse(response);
        if (FALLBACK_STATUSES.has(lastStatus) && index < config.profiles.length - 1) {
          await logEvent(config, {
            event: 'fallback_selected',
            fromProfileId: profile.id,
            status: lastStatus,
            nextProfileId: config.profiles[index + 1]?.id,
            endpointHost: url.host,
          });
          continue;
        }
        lastError = Object.assign(new Error('upstream status failed'), { code: 'upstream_failed' });
        break;
      }
      delivered = true;
      await pipeResponse(response, res, controller);
      await logEvent(config, {
        event: 'route_complete',
        profileId: profile.id,
        status: lastStatus,
        delivered: true,
        tried,
      });
      return;
    } catch (error) {
      lastError = error;
      if (canFallback({ delivered, error }) && index < config.profiles.length - 1) {
        await logEvent(config, {
          event: 'fallback_selected',
          fromProfileId: profile.id,
          errorCode: error.code ?? 'network_error',
          nextProfileId: config.profiles[index + 1]?.id,
        });
        continue;
      }
      if (error.code === 'upstream_result_uncertain' && index < config.profiles.length - 1) {
        await logEvent(config, {
          event: 'fallback_blocked_after_upstream_write',
          fromProfileId: profile.id,
          errorCode: error.code,
          nextProfileId: config.profiles[index + 1]?.id,
        });
      }
      break;
    }
  }

  const code = lastError?.code ?? (lastStatus ? 'upstream_failed' : 'gateway_failed');
  const status = ['stateful_fallback_blocked', 'profile_source_missing', 'profile_source_drift'].includes(code) ? 409 : 502;
  await logEvent(config, { event: 'route_failed', status: lastStatus, errorCode: code, tried });
  if (code === 'upstream_failed' && lastStatus >= 400) {
    sendJson(res, lastStatus, protocolErrorBody(config.protocol, code, lastStatus, tried), lastRetryAfter);
  } else {
    sendJson(res, status, { error: { code, status: lastStatus, tried } });
  }
}

async function start(configFile) {
  const config = await readJson(configFile);
  const token = await readFile(config.tokenFile, 'utf8').then((text) => text.trim());
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = requestPath(req);
      if (pathname === '/__cao/health') {
        if (!healthAuthorized(req, token, config)) {
          sendJson(res, 401, { error: { code: 'unauthorized' } });
          return;
        }
        sendJson(res, 200, {
          id: config.id,
          pid: process.pid,
          ownerProof: ownerProof(config),
          activeRequests,
          stopping,
        });
        return;
      }
      if (pathname === '/__cao/stop') {
        if (!internalAuthorized(req, config)) {
          sendJson(res, 401, { error: { code: 'unauthorized' } });
          return;
        }
        if (activeRequests > 0) {
          sendJson(res, 409, { error: { code: 'gateway_busy' }, activeRequests });
          return;
        }
        stopping = true;
        sendJson(res, 200, { ok: true });
        server.close(() => process.exit(0));
        return;
      }
      if (!callerAuthorized(req, token, config)) {
        sendJson(res, 401, { error: { code: 'unauthorized' } });
        return;
      }
      activeRequests += 1;
      try {
        await handleProxy(req, res, config);
      } finally {
        activeRequests -= 1;
      }
    } catch (error) {
      await logEvent(config, { event: 'gateway_exception', errorCode: error.code ?? 'exception' });
      sendJson(res, 500, { error: { code: 'gateway_exception' } });
    }
  });
  server.listen(0, '127.0.0.1', async () => {
    const address = server.address();
    const endpoint = `http://127.0.0.1:${address.port}`;
    await writeJsonAtomic(config.readyFile, {
      id: config.id,
      pid: process.pid,
      port: address.port,
      endpoint,
      ownerNonce: config.ownerNonce,
      readyAt: new Date().toISOString(),
    });
    await logEvent(config, { event: 'gateway_ready', endpoint });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start(parseArgs(process.argv).configFile).catch((error) => {
    // Startup errors go to stderr only; they should not include request payloads or secrets.
    console.error(error?.code ?? 'gateway_start_error');
    process.exit(1);
  });
}
