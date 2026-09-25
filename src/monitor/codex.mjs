import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { attachUsage, usageFromHistoryRows, usageFromProxyThread, usageFromStateThread } from './codex-usage.mjs';

const FAILURE_CACHE_MS = 30_000;
const PROXY_TIMEOUT_MS = 2_000;
const STALE_MS = 5 * 60_000;
const SAFE_LABEL = /[\p{L}\p{N}_.:/ -]/gu;
const MAX_PROXY_LINE_BYTES = 512 * 1024;
const MAX_PROXY_STDERR_BYTES = 16 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;

const proxyFailureUntilByHome = new Map();

const iso = value => Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
const secondsIso = value => Number.isFinite(value) && value > 0 ? iso(value * 1000) : null;
const parsedMs = value => {
  if (typeof value !== 'string' || value.length === 0) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
};
const shortId = id => String(id || '').slice(0, 8) || 'unknown';

function sanitizeText(value, fallback = null, max = 80) {
  if (typeof value !== 'string') return fallback;
  const normalized = [...value.normalize('NFKC').matchAll(SAFE_LABEL)].map(match => match[0]).join('').replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  return normalized.slice(0, max);
}

function conversationTitle(value) {
  return sanitizeText(value, null, 160);
}

function labelFrom({ threadId, kind, agentNickname, agentRole, agentPath }) {
  const nickname = sanitizeText(agentNickname);
  if (nickname) return nickname;
  const role = sanitizeText(agentRole);
  const leaf = sanitizeText(typeof agentPath === 'string' ? agentPath.split('/').filter(Boolean).at(-1) : null);
  if (leaf) return leaf;
  if (role) return role;
  return `${kind === 'subagent' ? 'Codex subagent' : 'Codex session'} ${shortId(threadId)}`;
}

function parseSource(value) {
  if (!value) return {};
  if (typeof value === 'object') return parseSessionSource(value);
  if (typeof value !== 'string' || value.length > MAX_JSON_BYTES) return {};
  try { return parseSessionSource(JSON.parse(value)); } catch { return {}; }
}

function parseSessionSource(value) {
  const spawnInfo = value?.subagent?.thread_spawn ?? value?.subAgent?.thread_spawn ?? value?.thread_spawn;
  if (!spawnInfo || typeof spawnInfo !== 'object') return {};
  return {
    parentThreadId: typeof spawnInfo.parent_thread_id === 'string' ? spawnInfo.parent_thread_id : null,
    agentPath: typeof spawnInfo.agent_path === 'string' ? spawnInfo.agent_path : null,
    agentNickname: typeof spawnInfo.agent_nickname === 'string' ? spawnInfo.agent_nickname : null,
    agentRole: typeof spawnInfo.agent_role === 'string' ? spawnInfo.agent_role : null,
  };
}

function emptyNode(threadId, now, overrides = {}) {
  const kind = overrides.parentThreadId ? 'subagent' : 'coordinator';
  const cwd = typeof overrides.cwd === 'string' ? overrides.cwd : null;
  return {
    id: `codex:${threadId}`,
    parentId: overrides.parentThreadId ? `codex:${overrides.parentThreadId}` : null,
    agent: 'codex',
    kind,
    label: labelFrom({ threadId, kind, ...overrides }),
    role: sanitizeText(overrides.agentRole),
    model: typeof overrides.model === 'string' && overrides.model.length <= 120 ? overrides.model : null,
    projectId: overrides.projectId ?? cwd,
    runId: null,
    taskId: null,
    attemptId: null,
    nativeSessionId: threadId,
    status: 'unknown',
    statusLabel: null,
    delivery: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    observedAt: iso(now),
    stale: false,
    source: 'codex',
    confidence: 'unknown',
    relation: 'native',
    tokens: null,
    tokenUsage: null,
    conversationTitle: kind === 'coordinator' ? conversationTitle(overrides.conversationTitle) : null,
    _threadId: threadId,
    _parentThreadId: overrides.parentThreadId ?? null,
    _activityCompleted: false,
    _latestOrdinal: null,
    _latestActivityMs: null,
    _cwd: cwd,
  };
}

function publicNode(node) {
  const { _threadId, _parentThreadId, _activityCompleted, _latestOrdinal, _latestActivityMs, _agentNickname, _agentRole, _agentPath, _cwd, ...publicFields } = node;
  return publicFields;
}

function ensureNode(map, threadId, now, overrides = {}) {
  if (!threadId || typeof threadId !== 'string') return null;
  let node = map.get(threadId);
  if (!node) {
    node = emptyNode(threadId, now, overrides);
    map.set(threadId, node);
  }
  if (overrides.parentThreadId && !node.parentId) {
    node.parentId = `codex:${overrides.parentThreadId}`;
    node.kind = 'subagent';
    node.conversationTitle = null;
    node._parentThreadId = overrides.parentThreadId;
  }
  if (!node._parentThreadId && overrides.conversationTitle && !node.conversationTitle) node.conversationTitle = conversationTitle(overrides.conversationTitle);
  for (const key of ['agentNickname', 'agentRole', 'agentPath']) {
    if (overrides[key] && !node[`_${key}`]) node[`_${key}`] = overrides[key];
  }
  if (overrides.agentRole && !node.role) node.role = sanitizeText(overrides.agentRole);
  if (overrides.model && !node.model) node.model = sanitizeText(overrides.model, null, 120);
  if (overrides.cwd && !node._cwd) node._cwd = overrides.cwd;
  if ((overrides.projectId || overrides.cwd) && !node.projectId) node.projectId = overrides.projectId ?? overrides.cwd;
  node.label = labelFrom({ threadId, kind: node.kind, agentNickname: node._agentNickname, agentRole: node.role || node._agentRole, agentPath: node._agentPath });
  return node;
}

function setStatus(node, { status, label = null, confidence = 'observed', stale = false, updatedAt = null, finishedAt = undefined }) {
  node.status = status;
  node.statusLabel = label;
  node.confidence = confidence;
  node.stale = stale;
  if (updatedAt) node.updatedAt = updatedAt;
  if (finishedAt !== undefined) node.finishedAt = finishedAt;
}

function mapProxyStatus(status) {
  if (!status || typeof status !== 'object') return { status: 'unknown', label: 'status unavailable' };
  if (status.type === 'active') {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    if (flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')) return { status: 'waiting', label: flags.join(', ') || 'waiting' };
    return { status: 'running', label: 'active' };
  }
  if (status.type === 'idle') return { status: 'idle', label: 'idle' };
  if (status.type === 'systemError') return { status: 'failed', label: 'system error' };
  return { status: 'unknown', label: status.type || null };
}

function nodeFromProxyThread(thread, now) {
  const sourceInfo = parseSource(thread.source);
  const parentThreadId = thread.parentThreadId ?? sourceInfo.parentThreadId ?? null;
  const node = emptyNode(thread.id, now, {
    parentThreadId,
    agentNickname: thread.agentNickname ?? sourceInfo.agentNickname,
    agentRole: thread.agentRole ?? sourceInfo.agentRole,
    agentPath: sourceInfo.agentPath,
    model: thread.model,
    projectId: thread.projectId ?? thread.cwd ?? null,
    cwd: thread.cwd,
    conversationTitle: thread.name,
  });
  node.startedAt = secondsIso(thread.createdAt);
  node.updatedAt = secondsIso(thread.updatedAt ?? thread.recencyAt ?? thread.createdAt);
  const mapped = mapProxyStatus(thread.status);
  setStatus(node, { ...mapped, confidence: 'live', stale: false, updatedAt: node.updatedAt });
  attachUsage(node, usageFromProxyThread(thread));
  return node;
}

function runProxyRequests({ home, requests, timeoutMs = PROXY_TIMEOUT_MS, runner, environment = process.env } = {}) {
  if (runner) return runner(requests);
  return new Promise((resolve, reject) => {
    const initRequest = requests.find(request => request?.method === 'initialize' && request.id !== undefined);
    if (!initRequest) {
      reject(new Error('app-server initialize request missing'));
      return;
    }
    const initialized = requests.find(request => request?.method === 'initialized' && request.id === undefined);
    const readonlyRequests = requests.filter(request => request !== initRequest && request !== initialized);
    const expectedIds = new Set([initRequest, ...readonlyRequests].filter(request => request.id !== undefined).map(request => request.id));
    const responses = new Map();
    const child = spawn('codex', ['app-server', 'proxy'], {
      env: { ...environment, CODEX_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let initializedSent = false;
    let stdoutBuffer = '';
    let stderr = '';

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.removeAllListeners('error');
      child.removeAllListeners('close');
      if (!child.killed) child.kill('SIGTERM');
      if (error) reject(error);
      else resolve([...responses.values()]);
    };

    const timer = setTimeout(() => {
      finish(new Error('app-server proxy timeout'));
    }, timeoutMs);
    timer.unref();

    const writeJson = message => {
      if (settled || !child.stdin.writable) return;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const handleMessage = message => {
      if (!message || !Object.hasOwn(message, 'id')) return;
      if (!expectedIds.has(message.id)) return;
      responses.set(message.id, message);
      if (message.id === initRequest.id && !initializedSent) {
        initializedSent = true;
        if (initialized) writeJson(initialized);
        for (const request of readonlyRequests) writeJson(request);
      }
      if ([...expectedIds].every(id => responses.has(id))) finish();
    };

    const handleLine = line => {
      if (!line.trim()) return;
      if (Buffer.byteLength(line, 'utf8') > MAX_PROXY_LINE_BYTES) {
        finish(new Error('app-server proxy response line too large'));
        return;
      }
      try { handleMessage(JSON.parse(line)); } catch { /* ignore non-JSON proxy noise */ }
    };

    child.stdout.on('data', chunk => {
      if (settled) return;
      stdoutBuffer += chunk.toString('utf8');
      if (Buffer.byteLength(stdoutBuffer, 'utf8') > MAX_PROXY_LINE_BYTES) {
        finish(new Error('app-server proxy response buffer too large'));
        return;
      }
      let newline;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(line);
        if (settled) return;
      }
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_PROXY_STDERR_BYTES);
    });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (settled) return;
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
      if (settled) return;
      finish(new Error(stderr.trim() || `app-server proxy exited before responses (${code})`));
    });

    writeJson(initRequest);
  });
}

async function collectProxy({ home, rootIds, project, all, limit, now, proxyRunner, environment }) {
  const cacheKey = path.resolve(home);
  if ((proxyFailureUntilByHome.get(cacheKey) ?? 0) > Date.now()) throw new Error('app-server proxy failure cache active');
  const requests = [
    { id: 1, method: 'initialize', params: { clientInfo: { name: 'harnessorbit-monitor', title: 'HarnessOrbit Monitor', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: ['item/agentMessage/delta', 'command/exec/outputDelta', 'process/outputDelta'] } } },
    { method: 'initialized' },
    { id: 2, method: 'thread/loaded/list', params: { limit } },
  ];
  let id = 10;
  for (const rootId of rootIds) {
    requests.push({ id: id++, method: 'thread/read', params: { threadId: rootId, includeTurns: false } });
    requests.push({ id: id++, method: 'thread/list', params: { ancestorThreadId: rootId, sourceKinds: ['subAgentThreadSpawn'], useStateDbOnly: true, limit } });
  }
  if (rootIds.length === 0) {
    requests.push({ id: id++, method: 'thread/list', params: { limit, sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true, sourceKinds: all ? ['cli', 'vscode', 'exec', 'appServer', 'subAgentThreadSpawn', 'unknown'] : ['cli', 'vscode', 'appServer'], cwd: all ? null : (project ?? null) } });
  }
  let messages;
  try {
    messages = await runProxyRequests({ home, requests, runner: proxyRunner, environment });
  } catch (error) {
    proxyFailureUntilByHome.set(cacheKey, Date.now() + FAILURE_CACHE_MS);
    throw error;
  }
  const byId = new Map(messages.filter(message => message && Object.hasOwn(message, 'id')).map(message => [message.id, message]));
  const init = byId.get(1);
  if (!init?.result) throw new Error(init?.error?.message || 'app-server initialize failed');
  const nodes = new Map();
  const addThread = thread => {
    if (!thread?.id) return;
    if (!all && rootIds.length === 0 && project && thread.cwd && path.resolve(thread.cwd) !== path.resolve(project)) return;
    nodes.set(thread.id, nodeFromProxyThread(thread, now));
  };
  for (const message of byId.values()) {
    const result = message.result;
    if (result?.thread) addThread(result.thread);
    for (const thread of result?.data || []) addThread(thread);
  }
  return { nodes: [...nodes.values()].slice(0, limit).map(publicNode), detail: `app-server proxy connected; ${nodes.size} Codex sessions observed` };
}

function openDb(file) {
  try { return new DatabaseSync(file, { readOnly: true }); } catch { return null; }
}

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function tableColumns(db, table) {
  try { return new Set(db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map(row => row.name)); } catch { return new Set(); }
}

function hasColumns(db, table, cols) {
  const present = tableColumns(db, table);
  return cols.every(col => present.has(col));
}

function selectColumns(db, table, candidates) {
  const present = tableColumns(db, table);
  return candidates.filter(column => present.has(column));
}

function safeJson(text) {
  if (typeof text !== 'string' || text.length > MAX_JSON_BYTES) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function classifyError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/timeout/i.test(message)) return 'timeout';
  if (/failure cache/i.test(message)) return 'cached_unavailable';
  if (/initialize/i.test(message)) return 'initialize_failed';
  if (/socket|connect|ENOENT|ECONNREFUSED|No such file/i.test(message)) return 'connection_failed';
  if (/schema/i.test(message)) return 'schema_unavailable';
  return 'unavailable';
}

function detailWithProxyCode(detail, error) {
  return `${detail}; proxy unavailable (${classifyError(error)})`;
}

function getField(row, field) {
  return Object.hasOwn(row, field) ? row[field] : null;
}

const THREAD_COLUMNS = ['id', 'created_at', 'updated_at', 'source', 'cwd', 'agent_nickname', 'agent_role', 'model', 'agent_path', 'created_at_ms', 'updated_at_ms', 'project_id', 'tokens_used', 'title', 'name', 'thread_name'];

function mergeThreadRow(nodes, row, now) {
  if (!row?.id) return null;
  const sourceInfo = parseSource(getField(row, 'source'));
  const parentThreadId = sourceInfo.parentThreadId ?? null;
  const cwd = getField(row, 'cwd');
  const node = ensureNode(nodes, row.id, now, {
    parentThreadId,
    agentNickname: getField(row, 'agent_nickname') ?? sourceInfo.agentNickname,
    agentRole: getField(row, 'agent_role') ?? sourceInfo.agentRole,
    agentPath: getField(row, 'agent_path') ?? sourceInfo.agentPath,
    model: getField(row, 'model'),
    projectId: getField(row, 'project_id') ?? cwd,
    cwd,
    conversationTitle: getField(row, 'name') ?? getField(row, 'title') ?? getField(row, 'thread_name'),
  });
  node.startedAt = node.startedAt ?? secondsIso(getField(row, 'created_at')) ?? iso(getField(row, 'created_at_ms'));
  const updated = secondsIso(getField(row, 'updated_at')) ?? iso(getField(row, 'updated_at_ms'));
  if (updated) node.updatedAt = iso(Math.max(parsedMs(node.updatedAt), parsedMs(updated)));
  attachUsage(node, usageFromStateThread(row));
  return node;
}

function stateDbPaths(home) {
  return [path.join(home, 'sqlite', 'state_5.sqlite'), path.join(home, 'state_5.sqlite')];
}

function readState({ home, rootSet, project, all, limit, now }) {
  const nodes = new Map();
  const edges = [];
  const wanted = new Set(rootSet);
  const descendFrom = new Set(rootSet);
  const dbPaths = [...new Set(stateDbPaths(home))];
  let opened = 0;
  let usable = 0;
  let lastReason = 'state_5.sqlite unavailable';

  for (const file of dbPaths) {
    const db = openDb(file);
    if (!db) continue;
    opened += 1;
    try {
      const threadColumns = selectColumns(db, 'threads', THREAD_COLUMNS);
      if (threadColumns.includes('id')) {
        usable += 1;
        const cols = threadColumns.map(quoteIdent).join(', ');
        const threadById = id => db.prepare(`SELECT ${cols} FROM threads WHERE id = ? LIMIT 1`).get(id);
        let rows = [];
        if (wanted.size > 0) {
          for (const id of [...wanted]) {
            const row = threadById(id);
            if (row) rows.push(row);
          }
        } else if (project && threadColumns.includes('cwd')) {
          rows = db.prepare(`SELECT ${cols} FROM threads WHERE cwd = ? ORDER BY ${threadColumns.includes('updated_at') ? 'updated_at' : 'id'} DESC LIMIT ?`).all(project, limit);
        } else if (all) {
          rows = db.prepare(`SELECT ${cols} FROM threads ORDER BY ${threadColumns.includes('updated_at') ? 'updated_at' : 'id'} DESC LIMIT ?`).all(limit);
        }
        for (const row of rows) {
          const node = mergeThreadRow(nodes, row, now);
          if (row.id) {
            wanted.add(row.id);
            if (rootSet.size === 0) descendFrom.add(row.id);
          }
        }

        const ancestryQueue = [...wanted];
        const seenAncestry = new Set();
        let parentByChild = null;
        if (hasColumns(db, 'thread_spawn_edges', ['parent_thread_id', 'child_thread_id'])) {
          parentByChild = db.prepare('SELECT parent_thread_id FROM thread_spawn_edges WHERE child_thread_id = ? LIMIT 1');
        }
        while (ancestryQueue.length > 0 && wanted.size < limit) {
          const childId = ancestryQueue.shift();
          if (!childId || seenAncestry.has(`${file}:${childId}`)) continue;
          seenAncestry.add(`${file}:${childId}`);
          const child = nodes.get(childId);
          const parentId = child?._parentThreadId ?? parentByChild?.get(childId)?.parent_thread_id ?? null;
          if (!parentId || wanted.has(parentId)) continue;
          wanted.add(parentId);
          const parentRow = threadById(parentId);
          if (parentRow) mergeThreadRow(nodes, parentRow, now);
          ensureNode(nodes, childId, now, { parentThreadId: parentId });
          ensureNode(nodes, parentId, now);
          ancestryQueue.push(parentId);
        }
      } else {
        lastReason = 'threads schema missing';
      }

      if (hasColumns(db, 'thread_spawn_edges', ['parent_thread_id', 'child_thread_id'])) {
        const edgeColumns = selectColumns(db, 'thread_spawn_edges', ['parent_thread_id', 'child_thread_id', 'status']);
        const edgeCols = edgeColumns.map(quoteIdent).join(', ');
        const queue = [...descendFrom];
        const seenParents = new Set();
        while (queue.length > 0 && wanted.size < limit) {
          const parent = queue.shift();
          if (!parent || seenParents.has(`${file}:${parent}`)) continue;
          seenParents.add(`${file}:${parent}`);
          for (const row of db.prepare(`SELECT ${edgeCols} FROM thread_spawn_edges WHERE parent_thread_id = ? LIMIT ?`).all(parent, limit)) {
            if (!row.child_thread_id) continue;
            edges.push(row);
            wanted.add(row.child_thread_id);
            descendFrom.add(row.child_thread_id);
            queue.push(row.child_thread_id);
            let childInfo = {};
            if (threadColumns.includes('id')) {
              const cols = threadColumns.map(quoteIdent).join(', ');
              const childRow = db.prepare(`SELECT ${cols} FROM threads WHERE id = ? LIMIT 1`).get(row.child_thread_id);
              if (childRow) {
                mergeThreadRow(nodes, childRow, now);
                const sourceInfo = parseSource(getField(childRow, 'source'));
                childInfo = {
                  agentNickname: getField(childRow, 'agent_nickname') ?? sourceInfo.agentNickname,
                  agentRole: getField(childRow, 'agent_role') ?? sourceInfo.agentRole,
                  agentPath: getField(childRow, 'agent_path') ?? sourceInfo.agentPath,
                  model: getField(childRow, 'model'),
                  cwd: getField(childRow, 'cwd'),
                  projectId: getField(childRow, 'project_id') ?? getField(childRow, 'cwd'),
                };
              }
            }
            const child = ensureNode(nodes, row.child_thread_id, now, { parentThreadId: row.parent_thread_id, ...childInfo });
            child.statusLabel = row.status ? `spawn edge ${sanitizeText(row.status, 'recorded')}` : child.statusLabel;
          }
        }
      }
    } finally {
      db.close();
    }
  }

  if (opened === 0) return { nodes, edges, wanted, ok: false, reason: lastReason };
  if (usable === 0) return { nodes, edges, wanted, ok: false, reason: lastReason };
  return { nodes, edges, wanted, descendFrom, ok: true, reason: null };
}

function applyTurnStatus(node, turns, now) {
  if (!node || turns.length === 0) return;
  const first = turns[0];
  const latest = turns.at(-1);
  node.startedAt = node.startedAt ?? secondsIso(first.started_at);
  const latestMs = (latest.completed_at ?? latest.started_at ?? 0) * 1000;
  const activityMs = Math.max(node._latestActivityMs ?? 0, latestMs);
  if ((node._latestActivityMs ?? 0) > latestMs && node.status !== 'unknown') {
    node.updatedAt = iso(Math.max(parsedMs(node.updatedAt), node._latestActivityMs));
    return;
  }
  node.updatedAt = iso(Math.max(parsedMs(node.updatedAt), activityMs));
  node._latestActivityMs = activityMs;
  node._latestOrdinal = latest.rollout_ordinal ?? node._latestOrdinal;
  if (latest.status === 'inProgress') {
    const freshMs = Math.max((latest.started_at ?? 0) * 1000, node._latestActivityMs ?? 0);
    const stale = now - freshMs > STALE_MS;
    setStatus(node, { status: stale ? 'unknown' : 'running', label: stale ? 'last recorded turn still in progress; live state unavailable' : 'turn in progress', confidence: 'observed', stale, updatedAt: node.updatedAt });
    return;
  }
  if (latest.status === 'failed') {
    if (node.kind === 'coordinator') {
      setStatus(node, { status: 'unknown', label: 'last recorded turn failed; live status unavailable', confidence: 'observed', stale: true, updatedAt: node.updatedAt, finishedAt: secondsIso(latest.completed_at) });
    } else {
      setStatus(node, { status: 'failed', label: 'last recorded turn failed; live state unavailable', confidence: 'observed', stale: false, updatedAt: node.updatedAt, finishedAt: secondsIso(latest.completed_at) });
    }
    return;
  }
  if (latest.status === 'interrupted') {
    if (node.kind === 'coordinator') {
      setStatus(node, { status: 'unknown', label: 'last recorded turn interrupted; live status unavailable', confidence: 'observed', stale: true, updatedAt: node.updatedAt, finishedAt: secondsIso(latest.completed_at) });
    } else {
      setStatus(node, { status: 'cancelled', label: 'last recorded turn interrupted; live state unavailable', confidence: 'observed', stale: false, updatedAt: node.updatedAt, finishedAt: secondsIso(latest.completed_at) });
    }
    return;
  }
  if (latest.status === 'completed') {
    if (node.kind === 'coordinator') {
      setStatus(node, { status: 'unknown', label: 'last recorded turn finished; live status unavailable', confidence: 'observed', stale: true, updatedAt: node.updatedAt, finishedAt: null });
      return;
    }
    const status = node._activityCompleted ? 'completed' : 'idle';
    setStatus(node, { status, label: status === 'completed' ? 'subagent completion observed' : 'last recorded turn finished', confidence: 'observed', stale: false, updatedAt: node.updatedAt, finishedAt: node._activityCompleted ? secondsIso(latest.completed_at) : null });
  }
}


function applyLatestItemActivity(db, nodes, wanted, now) {
  if (!hasColumns(db, 'thread_items', ['thread_id', 'created_at_ms'])) return;
  const stmt = db.prepare('SELECT MAX(created_at_ms) latest_item_ms FROM thread_items WHERE thread_id = ?');
  for (const id of [...wanted]) {
    const latest = stmt.get(id)?.latest_item_ms;
    if (!Number.isFinite(latest) || latest <= 0) continue;
    const node = ensureNode(nodes, id, now);
    node._latestActivityMs = Math.max(node._latestActivityMs ?? 0, latest);
    node.updatedAt = iso(Math.max(parsedMs(node.updatedAt), latest));
  }
}


function applyHistoryTokenUsage(db, nodes, wanted, limit, now) {
  if (!hasColumns(db, 'thread_items', ['thread_id', 'turn_id', 'item_id', 'item_json', 'item_type', 'created_at_ms'])) return;
  const usageLimit = Math.max(1, Math.min(limit, 1000));
  let stmt;
  try {
    stmt = db.prepare(`
      SELECT turn_id, item_id, created_at_ms, item_type,
        json_extract(item_json, '$.tokenUsage.total') AS total,
        json_extract(item_json, '$.tokenUsage.totalTokens') AS totalTokens,
        json_extract(item_json, '$.usage.total_tokens') AS total_tokens,
        json_extract(item_json, '$.info.total_token_usage.total_tokens') AS info_total_tokens,
        json_extract(item_json, '$.info.total_token_usage.totalTokens') AS info_totalTokens,
        json_extract(item_json, '$.tokenUsage.input') AS input,
        json_extract(item_json, '$.tokenUsage.inputTokens') AS inputTokens,
        json_extract(item_json, '$.usage.input_tokens') AS input_tokens,
        json_extract(item_json, '$.info.total_token_usage.input_tokens') AS info_input_tokens,
        json_extract(item_json, '$.info.total_token_usage.inputTokens') AS info_inputTokens,
        json_extract(item_json, '$.tokenUsage.output') AS output,
        json_extract(item_json, '$.tokenUsage.outputTokens') AS outputTokens,
        json_extract(item_json, '$.usage.output_tokens') AS output_tokens,
        json_extract(item_json, '$.info.total_token_usage.output_tokens') AS info_output_tokens,
        json_extract(item_json, '$.info.total_token_usage.outputTokens') AS info_outputTokens,
        json_extract(item_json, '$.tokenUsage.cacheRead') AS cacheRead,
        json_extract(item_json, '$.usage.cache_read_tokens') AS cache_read_tokens,
        json_extract(item_json, '$.usage.cache_read_input_tokens') AS cache_read_input_tokens,
        json_extract(item_json, '$.info.total_token_usage.cached_input_tokens') AS info_cached_input_tokens,
        json_extract(item_json, '$.info.total_token_usage.cachedInputTokens') AS info_cachedInputTokens,
        json_extract(item_json, '$.tokenUsage.cacheWrite') AS cacheWrite,
        json_extract(item_json, '$.usage.cache_write_tokens') AS cache_write_tokens,
        json_extract(item_json, '$.usage.cache_creation_input_tokens') AS cache_creation_input_tokens,
        json_extract(item_json, '$.tokenUsage.reasoning') AS reasoning,
        json_extract(item_json, '$.usage.reasoning_tokens') AS reasoning_tokens,
        json_extract(item_json, '$.info.total_token_usage.reasoning_output_tokens') AS info_reasoning_output_tokens,
        json_extract(item_json, '$.info.total_token_usage.reasoningOutputTokens') AS info_reasoningOutputTokens,
        json_extract(item_json, '$.tokenUsage.scope') AS usage_scope
      FROM thread_items
      WHERE thread_id = ? AND json_valid(item_json)
        AND (json_type(item_json, '$.tokenUsage') IS NOT NULL OR json_type(item_json, '$.usage') IS NOT NULL OR json_type(item_json, '$.info.total_token_usage') IS NOT NULL OR item_type IN ('token_usage_record', 'tokenUsage', 'tokenUsageRecord', 'token_count'))
      ORDER BY created_at_ms DESC
      LIMIT ?`);
  } catch {
    return;
  }
  for (const id of [...wanted]) {
    let rows;
    try { rows = stmt.all(id, usageLimit); } catch { continue; }
    const usage = usageFromHistoryRows(rows);
    if (usage) attachUsage(ensureNode(nodes, id, now), usage);
  }
}

function readHistory({ home, seedNodes, wanted, rootSet, activityRoots, all, limit, now }) {
  const db = openDb(path.join(home, 'thread_history_1.sqlite'));
  if (!db) return { ok: false, reason: 'thread_history_1.sqlite unavailable' };
  const nodes = seedNodes;
  try {
    if (!hasColumns(db, 'thread_turns', ['thread_id', 'turn_id', 'status', 'started_at', 'completed_at', 'duration_ms'])) return { ok: false, reason: 'thread_turns schema missing' };
    if (rootSet.size === 0 && wanted.size === 0) {
      if (!all) return { ok: true, reason: null };
      for (const row of db.prepare('SELECT thread_id, max(started_at) latest FROM thread_turns GROUP BY thread_id ORDER BY latest DESC LIMIT ?').all(limit)) {
        wanted.add(row.thread_id);
        activityRoots.add(row.thread_id);
      }
    }
    for (const id of [...wanted]) ensureNode(nodes, id, now, { parentThreadId: rootSet.has(id) ? null : undefined });

    if (hasColumns(db, 'thread_items', ['thread_id', 'item_type', 'item_json', 'created_at_ms'])) {
      const queue = [...activityRoots];
      const scanned = new Set();
      const activityLimit = Math.max(1, Math.min(limit, 500));
      while (queue.length > 0) {
        const parent = queue.shift();
        if (!parent || scanned.has(parent)) continue;
        scanned.add(parent);
        const parentNode = ensureNode(nodes, parent, now);
        const stmt = db.prepare("SELECT created_at_ms, item_json FROM thread_items WHERE thread_id = ? AND item_type = 'subAgentActivity' ORDER BY created_at_ms DESC LIMIT ?");
        const rows = stmt.all(parent, activityLimit).reverse();
        for (const row of rows) {
          const item = safeJson(row.item_json);
          if (item?.type !== 'subAgentActivity' || typeof item.agentThreadId !== 'string') continue;
          const alreadyWanted = wanted.has(item.agentThreadId);
          if (!alreadyWanted && wanted.size >= limit) continue;
          wanted.add(item.agentThreadId);
          if (!alreadyWanted) queue.push(item.agentThreadId);
          activityRoots.add(item.agentThreadId);
          parentNode._latestActivityMs = Math.max(parentNode._latestActivityMs ?? 0, row.created_at_ms ?? 0);
          const child = ensureNode(nodes, item.agentThreadId, now, { parentThreadId: parent, agentPath: item.agentPath });
          child._latestActivityMs = Math.max(child._latestActivityMs ?? 0, row.created_at_ms ?? 0);
          child.updatedAt = iso(Math.max(parsedMs(child.updatedAt), row.created_at_ms ?? 0));
          if (item.kind === 'started') {
            child._activityCompleted = false;
            child.finishedAt = null;
            setStatus(child, { status: 'running', label: 'subagent start observed', confidence: 'observed', stale: now - (row.created_at_ms ?? 0) > STALE_MS, updatedAt: child.updatedAt, finishedAt: null });
          } else if (item.kind === 'completed') {
            child._activityCompleted = true;
            child.finishedAt = child.updatedAt;
            setStatus(child, { status: 'completed', label: 'subagent completion observed', confidence: 'observed', stale: false, updatedAt: child.updatedAt, finishedAt: child.finishedAt });
          }
        }
      }
    }

    applyLatestItemActivity(db, nodes, wanted, now);
    applyHistoryTokenUsage(db, nodes, wanted, limit, now);

    const turnLimit = Math.max(1, Math.min(limit, 500));
    const turnStmt = db.prepare('SELECT thread_id, turn_id, rollout_ordinal, status, started_at, completed_at, duration_ms FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT ?');
    for (const id of [...wanted]) {
      const turns = turnStmt.all(id, turnLimit).reverse();
      applyTurnStatus(nodes.get(id), turns, now);
    }
  } finally {
    db.close();
  }
  return { ok: true, reason: null };
}

function includeParents(nodes, now) {
  for (const node of [...nodes.values()]) {
    if (node._parentThreadId && !nodes.has(node._parentThreadId)) ensureNode(nodes, node._parentThreadId, now);
  }
}

function scopedNodes(nodes, { rootSet, all, limit, now }) {
  includeParents(nodes, now);
  let result = [...nodes.values()];
  if (rootSet.size > 0) {
    const keep = new Set(rootSet);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of result) {
        if (node._parentThreadId && keep.has(node._parentThreadId) && !keep.has(node._threadId)) { keep.add(node._threadId); changed = true; }
      }
    }
    changed = true;
    while (changed) {
      changed = false;
      for (const node of result) {
        if (node._parentThreadId && keep.has(node._threadId) && !keep.has(node._parentThreadId)) { keep.add(node._parentThreadId); changed = true; }
      }
    }
    result = result.filter(node => keep.has(node._threadId));
  } else if (!all) {
    result = result.filter(node => node.kind === 'coordinator');
  }
  return result.slice(0, limit).map(publicNode);
}

async function collectFallback({ home, rootIds, project, all, now, limit }) {
  const rootSet = new Set(rootIds.filter(id => typeof id === 'string' && id.length > 0));
  const state = readState({ home, rootSet, project, all, limit, now });
  const history = readHistory({ home, seedNodes: state.nodes, wanted: state.wanted, rootSet, activityRoots: state.descendFrom ?? new Set(rootSet), all, limit, now });
  const nodes = scopedNodes(state.nodes, { rootSet, all, limit, now });
  if (!state.ok && !history.ok) return { nodes: [], ok: false, detail: `${state.reason}; ${history.reason}` };
  return { nodes, ok: true, detail: `app-server unavailable; using local Codex metadata (${state.ok ? 'state' : 'no state'}, ${history.ok ? 'history' : 'no history'})` };
}

function mergeLocalIntoLive(liveNodes, fallbackNodes, limit) {
  const merged = liveNodes.map(node => ({ ...node }));
  const byId = new Map(merged.map(node => [node.id, node]));
  for (const fallback of fallbackNodes) {
    const live = byId.get(fallback.id);
    if (!live) {
      if (merged.length < limit) {
        merged.push(fallback);
        byId.set(fallback.id, fallback);
      }
      continue;
    }
    if (!live.tokenUsage && fallback.tokenUsage) {
      live.tokenUsage = fallback.tokenUsage;
      live.tokens = fallback.tokens;
    }
    if (!live.conversationTitle && fallback.conversationTitle) live.conversationTitle = fallback.conversationTitle;
    if (!live.parentId && fallback.parentId) {
      live.parentId = fallback.parentId;
      live.kind = 'subagent';
    }
  }
  return merged;
}

export async function collectCodex({ home = path.join(os.homedir(), '.codex'), rootIds = [], project = null, all = false, now = Date.now(), limit = 500, proxy = true, proxyRunner = null, environment = process.env } = {}) {
  const envRoot = !all && rootIds.length === 0 ? (environment.CODEX_THREAD_ID || environment.CODEX_SESSION_ID || null) : null;
  const effectiveRootIds = envRoot ? [envRoot] : rootIds;
  const safeLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 500, 2_000));
  if (proxy) {
    try {
      const live = await collectProxy({ home, rootIds: effectiveRootIds, project, all, limit: safeLimit, now, proxyRunner, environment });
      const fallback = await collectFallback({ home, rootIds: effectiveRootIds, project, all, now, limit: safeLimit });
      const nodes = fallback.ok ? mergeLocalIntoLive(live.nodes, fallback.nodes, safeLimit) : live.nodes;
      return { nodes, health: { status: 'connected', detail: live.detail } };
    } catch (error) {
      const fallback = await collectFallback({ home, rootIds: effectiveRootIds, project, all, now, limit: safeLimit });
      if (fallback.ok) return { nodes: fallback.nodes, health: { status: 'partial', detail: detailWithProxyCode(fallback.detail, error) } };
      return { nodes: [], health: { status: 'unavailable', detail: `proxy unavailable (${classifyError(error)}); local metadata unavailable` } };
    }
  }
  const fallback = await collectFallback({ home, rootIds: effectiveRootIds, project, all, now, limit: safeLimit });
  return { nodes: fallback.nodes, health: { status: fallback.ok ? 'partial' : 'unavailable', detail: fallback.detail } };
}

export function resetCodexCollectorCacheForTests() {
  proxyFailureUntilByHome.clear();
}
