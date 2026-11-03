import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { StorageService } from './storage.mjs';
import { MonitorCollector } from './collector.mjs';
import { writeJsonAtomic } from '../state.mjs';
import { publicSnapshot } from './model.mjs';

const assetDirectory = fileURLToPath(new URL('../../web/monitor/', import.meta.url));
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']], ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/conversations.mjs', ['conversations.mjs', 'text/javascript; charset=utf-8']], ['/conversations.css', ['conversations.css', 'text/css; charset=utf-8']]]);
for (const [file, mime] of [['storage.html', 'text/html'], ['storage.mjs', 'text/javascript'], ['storage.css', 'text/css']]) {
  assets.set('/' + file, [file, mime + '; charset=utf-8']);
}
const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const bearer = req => typeof req.headers.authorization === 'string' ? /^Bearer (.+)$/.exec(req.headers.authorization)?.[1] : null;
const proof = secret => createHash('sha256').update(secret).digest('hex');

const storageErrors = new Map([['storage_ineligible', 409], ['storage_changed', 409], ['storage_plan_expired', 410]]);
const MAX_STORAGE_BODY = 1024;
async function readStorageId(req, field) {
  const idPattern = field === 'id' ? /^[0-9a-f]{32}$/ : /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) return { status: 415, error: 'json_required' };
  const oversized = { status: 413, error: 'body_too_large' };
  if (Number(req.headers['content-length']) > MAX_STORAGE_BODY) return oversized;
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_STORAGE_BODY) return oversized;
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && Object.keys(body).length === 1 && Object.hasOwn(body, field) &&
        typeof body[field] === 'string' && idPattern.test(body[field])) return { id: body[field] };
  } catch { /* Invalid input receives the same public error. */ }
  return { status: 400, error: 'invalid_storage_request' };
}

export async function startMonitorServer({ token, ownerToken, all = false, storageToken, storageService, port = 0, collector, refreshMs = 2000, assetsRoot = assetDirectory } = {}) {
  if (!token || !ownerToken) throw new Error('Monitor authentication is required.');
  let snapshot = null, collection = null, closed = false;
  let collectedAt = 0;
  const getSnapshot = async () => {
    if (snapshot && Date.now() - collectedAt < refreshMs) return snapshot;
    if (!collection) collection = Promise.resolve().then(() => collector.snapshot()).then(value => {
      snapshot = publicSnapshot({ nodes: value.nodes || [], projects: value.projects || [], sources: value.sources || [], scope: { ...value.scope, all: value.scope?.mode === 'all' }, truncated: value.truncated, currentConversationId: value.currentConversationId });
      collectedAt = Date.now(); return snapshot;
    }).finally(() => { collection = null; });
    return collection;
  };
  const securityHeaders = {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
    'cross-origin-resource-policy': 'same-origin',
  };
  const json = (res, status, body) => {
    const bytes = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length });
    res.end(bytes);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const expected = `127.0.0.1:${server.address().port}`;
      if (![expected, `localhost:${server.address().port}`].includes(req.headers.host)) return json(res, 403, { error: 'host_rejected' });
      const origin = req.headers.origin;
      if (origin && ![`http://${expected}`, `http://localhost:${server.address().port}`].includes(origin)) return json(res, 403, { error: 'origin_rejected' });
      const url = new URL(req.url, `http://${expected}`);
      if (url.search) return json(res, 400, { error: 'query_not_supported' });
      if (url.pathname === '/_cao/health') {
        if (!sameSecret(bearer(req), ownerToken)) return json(res, 401, { error: 'unauthorized' });
        return json(res, 200, { running: !closed, ownerProof: proof(ownerToken) });
      }
      if (url.pathname === '/_cao/stop') {
        if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
        if (!sameSecret(bearer(req), ownerToken)) return json(res, 401, { error: 'unauthorized' });
        json(res, 200, { stopping: true });
        setImmediate(() => close()); return;
      }
      if (['/api/storage', '/api/storage/plan', '/api/storage/execute'].includes(url.pathname)) {
        if (all !== true || !storageService) return json(res, 403, { error: 'storage_requires_all' });
        if (url.pathname === '/api/storage') {
          if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
          if (!sameSecret(bearer(req), token)) return json(res, 401, { error: 'unauthorized' });
          try { return json(res, 200, await storageService.audit()); }
          catch { return json(res, 503, { error: 'storage_unavailable' }); }
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
        if (!storageToken) return json(res, 403, { error: 'storage_read_only' });
        if (!sameSecret(bearer(req), storageToken)) return json(res, 401, { error: 'unauthorized' });
        if ((origin && origin !== 'http://' + req.headers.host) ||
            (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
          return json(res, 403, { error: 'origin_rejected' });
        }
        const planning = url.pathname === '/api/storage/plan';
        const input = await readStorageId(req, planning ? 'id' : 'planId');
        if (input.error) return json(res, input.status, { error: input.error });
        try {
          const result = planning ? await storageService.plan(input.id) : await storageService.execute(input.id);
          return json(res, 200, result);
        } catch (error) {
          const status = storageErrors.get(error?.code);
          return json(res, status || 503, { error: status ? error.code : 'storage_unavailable' });
        }
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'read_only' });
      if (url.pathname === '/api/snapshot') {
        if (!sameSecret(bearer(req), token)) return json(res, 401, { error: 'unauthorized' });
        try { return json(res, 200, await getSnapshot()); }
        catch { return json(res, 503, { error: 'snapshot_unavailable' }); }
      }
      const asset = assets.get(url.pathname);
      if (!asset) return json(res, 404, { error: 'not_found' });
      let bytes;
      try { bytes = await fs.readFile(path.join(assetsRoot, asset[0])); }
      catch { return json(res, 503, { error: 'assets_unavailable' }); }
      res.writeHead(200, { ...securityHeaders, 'content-type': asset[1], 'content-length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { if (!res.headersSent) json(res, 500, { error: 'monitor_error' }); else res.end(); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 32;
  const close = () => {
    if (closed) return;
    closed = true; server.close(); server.closeIdleConnections();
    const timer = setTimeout(() => server.closeAllConnections(), 500); timer.unref();
  };
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return { server, endpoint: `http://127.0.0.1:${server.address().port}`, close };
}

async function main() {
  const position = process.argv.indexOf('--config');
  if (position < 0 || !process.argv[position + 1]) throw new Error('Monitor config is required.');
  const config = JSON.parse(await fs.readFile(process.argv[position + 1], 'utf8'));
  const collector = new MonitorCollector(config);
  const all = config.all === true && !config.project && !config.runId;
  const storageService = all ? new StorageService(config.root) : null;
  const service = await startMonitorServer({ token: config.token, ownerToken: config.ownerToken, port: config.port,
    all, storageService, storageToken: all && config.manageStorage === true ? config.storageToken : null, collector });

  await writeJsonAtomic(config.readyFile, { pid: process.pid, endpoint: service.endpoint, ownerProof: proof(config.ownerToken) });
  process.once('SIGTERM', service.close);
  process.once('SIGINT', service.close);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { process.stderr.write('Monitor could not start.\n'); process.exitCode = 1; });
