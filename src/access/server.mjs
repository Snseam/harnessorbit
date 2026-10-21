import http from 'node:http';
import { OrchestratorError } from '../errors.mjs';
import { ACCESS_VERSION, TOOL_TIMEOUT_MS, AccessAudit } from './service.mjs';

// Minimal Model Context Protocol server over Streamable HTTP (JSON responses only, no SSE).
// Grok Bot and other remote principals call it through a user-controlled tunnel or tailnet.
export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
const MAX_BODY_BYTES = 262144;
const WRITE_TOOLS = new Set(['submit', 'approve', 'answer', 'cancel']);
const jobIdSchema = { type: 'string', minLength: 1, maxLength: 64, description: 'Job id returned by submit.' };

export const TOOLS = Object.freeze([
  {
    name: 'describe', title: 'Describe HarnessOrbit access',
    description: 'Return what this principal may do: allowed projects, agents, permissions, limits, the job lifecycle, and the attention kinds that status can report.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'submit', title: 'Submit a coding job',
    description: 'Dispatch one task to a local coding agent (Codex or Claude CLI) on the host. The agent works in an isolated Git worktree; HarnessOrbit verifies the candidate with the supplied checks. Returns a job with its state. Reuse the same idempotencyKey when retrying a timed-out call.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: ['idempotencyKey', 'project', 'objective', 'context', 'checks'],
      properties: {
        idempotencyKey: { type: 'string', minLength: 1, maxLength: 128, description: 'Caller-chosen unique key for this request. Identical keys return the original job.' },
        project: { type: 'string', description: 'Absolute path of an allowed project on the host (see describe).' },
        objective: { type: 'string', minLength: 1, maxLength: 4000, description: 'What the agent must accomplish.' },
        context: { type: 'string', minLength: 1, maxLength: 8000, description: 'Why this work is needed and what the caller already knows. Required.' },
        agent: { type: 'string', enum: ['claude', 'pi', 'opencode', 'codex'], description: 'Which local CLI runs the task. Defaults to the principal’s first allowed agent.' },
        allowedPaths: { type: 'array', items: { type: 'string' }, description: 'Relative files or directories (directories end with /) the agent may change. Defaults to the whole project.' },
        checks: { type: 'array', minItems: 1, items: { type: 'object', required: ['name', 'argv'], additionalProperties: false, properties: { name: { type: 'string' }, argv: { type: 'array', minItems: 1, items: { type: 'string' } }, timeoutMs: { type: 'integer', minimum: 1, maximum: 300000 } } }, description: 'Verification commands HarnessOrbit runs independently against the candidate.' },
        maxAttempts: { type: 'integer', minimum: 1, maximum: 20 },
        brief: { type: 'object', description: 'Optional task brief: taskKind, risk (low|medium|high), acceptance, nonGoals, knownFindings, contextRefs.' },
        conversationKey: { type: 'string', maxLength: 128, description: 'Opaque caller conversation id (for example a room id) stored for correlation only.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'status', title: 'Job status',
    description: 'Return the current state of a job: attempt status, verification results, attention items that need a decision, attention_pending, and next_action. Also moves collection and verification forward on the host.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['jobId'], properties: { jobId: jobIdSchema } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'approve', title: 'Approve integration',
    description: 'Integrate an accepted candidate into the project checkout: the verified patch is applied and the checks rerun there. Requires the integrate permission (see describe). Call result first to review the patch.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['jobId'], properties: { jobId: jobIdSchema, kind: { type: 'string', enum: ['integrate'], default: 'integrate' } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'answer', title: 'Answer a waiting worker',
    description: 'Reply to a worker that stopped and needs input (attention kind input). Send text for a question, or keys such as ["Enter"] or ["y"] for a terminal prompt. Exactly one of text or keys.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['jobId'], properties: { jobId: jobIdSchema, text: { type: 'string', minLength: 1, maxLength: 8000 }, keys: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', pattern: '^[A-Za-z0-9+_-]{1,32}$' } } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'cancel', title: 'Cancel a job',
    description: 'Stop the worker and withdraw the job. Nothing in the project checkout changes. An accepted candidate is withdrawn without integration.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['jobId'], properties: { jobId: jobIdSchema, reason: { type: 'string', maxLength: 512 } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'result', title: 'Job result',
    description: 'Return the worker report, verification evidence (per check: status, exit code, stdout and stderr tails), changed paths, and with includePatch the verified unified diff (up to 256 KiB). Available once the attempt was collected.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['jobId'], properties: { jobId: jobIdSchema, includePatch: { type: 'boolean', default: false } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
]);

const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const bearer = req => typeof req.headers.authorization === 'string' ? /^Bearer (.+)$/.exec(req.headers.authorization)?.[1] : null;
const loopbackOrigin = origin => { try { const u = new URL(origin); return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname); } catch { return false; } };

class RateLimiter {
  constructor() { this.buckets = new Map(); }
  allow(principal, now = Date.now()) {
    const limit = principal.rateLimitPerMinute || 60;
    const bucket = this.buckets.get(principal.id) || { tokens: limit, updatedAt: now };
    bucket.tokens = Math.min(limit, bucket.tokens + ((now - bucket.updatedAt) / 60000) * limit);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) { this.buckets.set(principal.id, bucket); return false; }
    bucket.tokens -= 1; this.buckets.set(principal.id, bucket); return true;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new OrchestratorError('payload_too_large', 'Request body exceeds 256 KiB.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new OrchestratorError('tool_timeout', `Tool did not finish within ${ms} ms; call status again.`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function startAccessServer({ service, principals = service?.principals, port = 0, host = '127.0.0.1', toolTimeoutMs = TOOL_TIMEOUT_MS, audit = new AccessAudit({ root: service?.root }), instructions = null } = {}) {
  if (!service || !principals) throw new OrchestratorError('invalid_arguments', 'Access server requires a service and principal store.');
  const limiter = new RateLimiter();
  let closed = false;
  const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin' };
  const send = (res, status, body) => {
    if (body === undefined) { res.writeHead(status, { ...headers, 'content-length': 0 }); return res.end(); }
    const bytes = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length });
    res.end(bytes);
  };

  async function callTool(principal, name, args) {
    switch (name) {
      case 'describe': return service.describe(principal);
      case 'submit': return service.submit(principal, args);
      case 'status': return service.status(principal, { jobId: args?.jobId });
      case 'approve': return service.approve(principal, { jobId: args?.jobId, ...(args?.kind === undefined ? {} : { kind: args.kind }) });
      case 'answer': return service.answer(principal, { jobId: args?.jobId, text: args?.text, keys: args?.keys });
      case 'cancel': return service.cancel(principal, { jobId: args?.jobId, reason: args?.reason });
      case 'result': return service.result(principal, { jobId: args?.jobId, includePatch: args?.includePatch ?? false });
      default: throw new OrchestratorError('unknown_tool', `Unknown tool: ${name}`);
    }
  }

  async function handle(principal, message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(message?.id, -32600, 'Invalid request.');
    const { id, method, params } = message;
    const isNotification = id === undefined;
    if (method.startsWith('notifications/')) return null;
    if (isNotification) return null;
    if (method === 'initialize') {
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : null;
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'harnessorbit-access', version: ACCESS_VERSION },
        instructions: instructions || 'HarnessOrbit runs coding agents on its host. Call describe first, then submit with a unique idempotencyKey, then poll status while next_action is status. When next_action is answer, call answer; when it is approve, call result to review the patch and then approve (if your principal may integrate); when it is result, call result. cancel withdraws a job. Every call returns within 20 seconds; nothing here waits for an agent to finish.',
      });
    }
    if (method === 'ping') return rpcResult(id, {});
    if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (!TOOLS.some(tool => tool.name === name)) return rpcError(id, -32602, `Unknown tool: ${String(name).slice(0, 80)}`);
      if (WRITE_TOOLS.has(name) && !limiter.allow(principal)) return rpcResult(id, { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'rate_limited', message: 'Too many write calls for this principal; wait a minute.' }) }] });
      const startedAt = Date.now();
      try {
        const result = await withTimeout(callTool(principal, name, args), toolTimeoutMs);
        await audit.record({ principalId: principal.id, transport: 'mcp', tool: name, jobId: result?.job?.id || args?.jobId || null, ok: true, durationMs: Date.now() - startedAt });
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
      } catch (error) {
        const failure = error instanceof OrchestratorError ? { code: error.code, message: error.message, details: error.details || {} } : { code: 'internal_error', message: 'Tool failed.' };
        await audit.record({ principalId: principal.id, transport: 'mcp', tool: name, jobId: args?.jobId || null, ok: false, code: failure.code, durationMs: Date.now() - startedAt });
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure, isError: true });
      }
    }
    return rpcError(id, -32601, `Method not found: ${method.slice(0, 80)}`);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${host}`);
      if (!['/mcp', '/'].includes(url.pathname)) return send(res, 404, { error: 'not_found' });
      if (req.headers.origin && !loopbackOrigin(req.headers.origin)) return send(res, 403, { error: 'origin_rejected' });
      if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return send(res, 405, { error: 'method_not_allowed' }); }
      const principal = await principals.authenticate(bearer(req));
      if (!principal) { res.setHeader('www-authenticate', 'Bearer realm="harnessorbit-access"'); return send(res, 401, { error: 'unauthorized' }); }
      let message;
      try { message = JSON.parse(await readBody(req)); }
      catch (error) {
        if (error?.code === 'payload_too_large') return send(res, 413, rpcError(null, -32600, error.message));
        return send(res, 400, rpcError(null, -32700, 'Parse error.'));
      }
      if (Array.isArray(message)) return send(res, 400, rpcError(null, -32600, 'Batch requests are not supported.'));
      const response = await handle(principal, message);
      if (response === null) return send(res, 202);
      return send(res, 200, response);
    } catch {
      if (!res.headersSent) send(res, 500, rpcError(null, -32603, 'Internal error.'));
      else res.end();
    }
  });
  server.requestTimeout = toolTimeoutMs + 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 64;
  const close = () => {
    if (closed) return;
    closed = true; server.close(); server.closeIdleConnections();
    const timer = setTimeout(() => server.closeAllConnections(), 500); timer.unref();
  };
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  const shownHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return { server, endpoint: `http://${shownHost}:${address.port}/mcp`, port: address.port, close, closed: () => closed };
}
