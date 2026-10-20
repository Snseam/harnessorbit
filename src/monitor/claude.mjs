import { constants as fsConstants } from 'node:fs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { claudeProjectSlug, readClaudeUsage, usageForClaudeSession } from './claude-usage.mjs';

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'PermissionRequest',
  'Notification',
  'SessionEnd',
];
const TERMINAL_PARENT_STATUSES = new Set(['completed', 'failed', 'cancelled', 'idle']);
const CLOSED_CHILD_STATUSES = new Set(['running', 'waiting']);
const STALE_MS = 180_000;
const MAX_EVENT_BYTES = 8192;
const MAX_EVENTS_FILE_BYTES = 1024 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_FILES = 200;
const MAX_FALLBACK_DIRS = 1000;
const MAX_FALLBACK_DEPTH = 4;
const tailCache = new Map();
const hookScript = fileURLToPath(new URL('./claude-hook.mjs', import.meta.url));

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function safeText(value, fallback = null, max = 160) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
  return cleaned || fallback;
}

function safeIdPart(value, fallback = 'unknown') {
  return safeText(value, fallback, 128)?.replace(/[^a-zA-Z0-9_.:-]/g, '_') || fallback;
}

function isPathInside(parent, child) {
  if (!parent || !child) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function sha256File(file) {
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    return crypto.createHash('sha256').update(await handle.readFile()).digest('hex');
  } finally {
    await handle.close();
  }
}

async function mkdirPrivate(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('private directory is not safe');
  await fs.chmod(directory, 0o700).catch(() => {});
}

async function writeFilePrivate(file, bytes, { exclusive = false } = {}) {
  await mkdirPrivate(path.dirname(file));
  const flags = fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW || 0) | (exclusive ? fsConstants.O_EXCL : 0);
  const handle = await fs.open(file, flags, 0o600);
  try {
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(file, 0o600).catch(() => {});
}

async function writeJsonPrivate(file, value) {
  await writeFilePrivate(file, `${JSON.stringify(value, null, 2)}\n`, { exclusive: true });
}

async function readRegularFileBounded(file, maxBytes) {
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('file is not a bounded regular file');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function readSettingsValue(value, baseDirectory = process.cwd()) {
  if (!value) return { ok: true, settings: {}, source: 'none' };
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) {
    if (Buffer.byteLength(trimmed) > MAX_SETTINGS_BYTES) throw new Error('settings JSON too large');
    const parsed = JSON.parse(trimmed);
    if (!isObject(parsed)) throw new Error('settings JSON must be an object');
    return { ok: true, settings: parsed, source: 'inline' };
  }
  const file = path.resolve(baseDirectory, value);
  const parsed = JSON.parse(await readRegularFileBounded(file, MAX_SETTINGS_BYTES));
  if (!isObject(parsed)) throw new Error('settings file must contain an object');
  return { ok: true, settings: parsed, source: 'file', path: file };
}

function findArgs(args, name, alias) {
  const names = [name, alias].filter(Boolean);
  const found = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    for (const key of names) {
      const eq = `${key}=`;
      if (arg === key) found.push({ index: i, valueIndex: i + 1, value: args[i + 1], form: 'split', name: key });
      else if (arg.startsWith(eq)) found.push({ index: i, valueIndex: i, value: arg.slice(eq.length), form: 'equals', name: key });
    }
  }
  return found;
}

function findArg(args, name, alias) {
  return findArgs(args, name, alias)[0] || null;
}

function hasFlag(args, name, alias) {
  return findArgs(args, name, alias).length > 0;
}

function replaceOrAppendSettings(args, settingsFile) {
  const next = [...args];
  const found = findArgs(next, '--settings');
  if (found.length === 0) return [...next, '--settings', settingsFile];
  if (found.length > 1) return null;
  const item = found[0];
  if (item.form === 'split') next[item.valueIndex] = settingsFile;
  else next[item.index] = `--settings=${settingsFile}`;
  return next;
}

function hasDisableAllHooks(settings) {
  return settings?.disableAllHooks === true;
}

function appendMonitorHooks(settings, context) {
  const hooks = isObject(settings.hooks) ? structuredClone(settings.hooks) : {};
  for (const event of HOOK_EVENTS) {
    const list = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    const hook = {
      type: 'command',
      command: process.execPath,
      args: [
        hookScript,
        '--out', context.eventsFile,
        '--run-id', context.runId,
        '--task-id', context.taskId,
        '--attempt-id', context.attemptId,
        '--worker-name', context.workerName,
      ],
      timeout: event === 'SessionEnd' ? 1.5 : 3,
    };
    if (context.nativeSessionId) hook.args.push('--native-session-id', context.nativeSessionId);
    const entry = ['SubagentStart', 'SubagentStop', 'PermissionRequest', 'Notification', 'SessionEnd'].includes(event)
      ? { matcher: '*', hooks: [hook] }
      : { hooks: [hook] };
    list.push(entry);
    hooks[event] = list;
  }
  return { ...settings, hooks };
}

function sessionArgValue(item) {
  if (!item || typeof item.value !== 'string' || item.value.length === 0 || item.value.startsWith('--')) return null;
  return item.value;
}

function nativeSessionFromArgs(args) {
  const session = sessionArgValue(findArg(args, '--session-id'));
  if (session) return { value: session, source: 'session-id', shouldAppend: false };
  const resumeArg = findArg(args, '--resume', '-r');
  if (resumeArg) return { value: sessionArgValue(resumeArg), source: 'resume', shouldAppend: false };
  if (hasFlag(args, '--continue', '-c')) return { value: null, source: 'continue', shouldAppend: false };
  return { value: crypto.randomUUID(), source: 'new', shouldAppend: true };
}

function taskId(task) {
  return task?.id || task?.definition?.id || 'unknown-task';
}

function attemptId(attempt) {
  return attempt?.id || 'unknown-attempt';
}

function attemptWorker(attempt) {
  return attempt?.workerName || null;
}

export async function prepareClaudeTelemetry({ root, runId, task, attempt, launch }) {
  const inputLaunch = { kind: launch?.kind || 'claude', args: Array.isArray(launch?.args) ? [...launch.args] : [] };
  const monitorDirectory = path.join(path.resolve(root), 'monitor', 'claude', safeIdPart(runId), safeIdPart(taskId(task)), safeIdPart(attemptId(attempt)));
  const eventsFile = path.join(monitorDirectory, 'events.ndjson');
  const settingsFile = path.join(monitorDirectory, 'settings.json');
  const session = nativeSessionFromArgs(inputLaunch.args);
  const manifestBase = {
    directory: monitorDirectory,
    eventsFile,
    settingsFile,
    files: [],
    enabled: false,
    reason: null,
    nativeSessionId: session.value || null,
  };

  if (hasFlag(inputLaunch.args, '--bare')) {
    return { launch: inputLaunch, manifest: { ...manifestBase, reason: 'claude_bare_disables_hooks' } };
  }
  const settingsArgs = findArgs(inputLaunch.args, '--settings');
  if (settingsArgs.length > 1) {
    return { launch: inputLaunch, manifest: { ...manifestBase, reason: 'settings_unmergeable' } };
  }

  const foundSettings = settingsArgs[0] || null;
  let settings;
  try {
    if (foundSettings && (typeof foundSettings.value !== 'string' || foundSettings.value.length === 0 || foundSettings.value.startsWith('--'))) throw new Error('settings value missing');
    const read = await readSettingsValue(foundSettings?.value || null, attempt?.cwd || process.cwd());
    settings = read.settings;
  } catch {
    return { launch: inputLaunch, manifest: { ...manifestBase, reason: 'settings_unmergeable' } };
  }

  if (hasDisableAllHooks(settings)) {
    return { launch: inputLaunch, manifest: { ...manifestBase, reason: 'settings_disable_all_hooks' } };
  }

  try {
    await mkdirPrivate(monitorDirectory);
    await writeFilePrivate(eventsFile, '', { exclusive: true });
    const merged = appendMonitorHooks(settings, {
      eventsFile,
      runId,
      taskId: taskId(task),
      attemptId: attemptId(attempt),
      workerName: attemptWorker(attempt),
      nativeSessionId: session.value,
    });
    await writeJsonPrivate(settingsFile, merged);
  } catch {
    return { launch: inputLaunch, manifest: { ...manifestBase, reason: 'monitor_private_path_unsafe' } };
  }

  let args = replaceOrAppendSettings(inputLaunch.args, settingsFile);
  if (!args) return { launch: inputLaunch, manifest: { ...manifestBase, reason: 'settings_unmergeable' } };
  if (session.shouldAppend) args = [...args, '--session-id', session.value];

  const files = [settingsFile, eventsFile].map(file => ({ path: file, sha256: null }));
  for (const entry of files) entry.sha256 = await sha256File(entry.path);
  return {
    launch: { ...inputLaunch, args },
    manifest: { ...manifestBase, files, enabled: true, reason: 'enabled', nativeSessionId: session.value || null },
  };
}

async function readFileTail(file, maxBytes) {
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return '';
    const key = path.resolve(file);
    const cached = tailCache.get(key);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.maxBytes === maxBytes) return cached.text;
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    const text = buffer.toString('utf8');
    tailCache.set(key, { size: stat.size, mtimeMs: stat.mtimeMs, maxBytes, text });
    if (tailCache.size > 512) tailCache.delete(tailCache.keys().next().value);
    return text;
  } finally {
    await handle.close();
  }
}

async function readNdjson(file, limit) {
  try {
    const text = await readFileTail(file, MAX_EVENTS_FILE_BYTES);
    return text.split('\n').filter(Boolean).slice(-limit).flatMap(line => {
      if (Buffer.byteLength(line) > MAX_EVENT_BYTES) return [];
      try { const value = JSON.parse(line); return isObject(value) ? [value] : []; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function uiStatus(status) {
  if (status === 'waiting_permission' || status === 'waiting') return 'waiting';
  if (['running', 'idle', 'completed', 'failed', 'cancelled', 'unknown'].includes(status)) return status;
  return 'unknown';
}

function baseNode({ id, parentId, kind, label, role, projectId, runId, taskId, attemptId, nativeSessionId, status, statusLabel, startedAt, updatedAt, finishedAt, observedAt, stale, source, confidence, relation, tokenUsage = null }) {
  return {
    id,
    parentId,
    agent: 'claude',
    kind,
    label,
    role,
    model: null,
    projectId,
    runId,
    taskId,
    attemptId,
    nativeSessionId,
    status: uiStatus(status),
    statusLabel,
    delivery: null,
    startedAt,
    updatedAt,
    finishedAt,
    observedAt,
    stale,
    source,
    confidence,
    relation,
    tokens: tokenUsage?.total ?? null,
    tokenUsage,
  };
}

function eventTime(event, now) {
  const parsed = Date.parse(event?.observedAt || event?.timestamp || '');
  return Number.isFinite(parsed) ? parsed : now;
}

function eventNativeSession(event) {
  return safeText(event?.claude?.sessionId || event?.claude?.nativeSessionId || event?.session_id || event?.sessionId, null, 256);
}

function applyManagedEvent(parent, children, event, now) {
  const time = eventTime(event, now);
  const at = iso(time);
  const actualSession = eventNativeSession(event);
  if (actualSession && parent.nativeSessionId !== actualSession) {
    parent.nativeSessionId = actualSession;
    parent.actualNativeSessionObserved = true;
  }
  parent.updatedAt = at;
  parent.observedAt = at;
  parent.eventCount += 1;
  const eventName = event?.hookEventName;
  const isChild = event?.agent?.role === 'subagent' || eventName === 'SubagentStart' || eventName === 'SubagentStop';
  if (!parent.startedAt) parent.startedAt = at;
  if (!isChild) {
    if (eventName === 'UserPromptSubmit' || eventName === 'SessionStart') { parent.status = 'running'; parent.finishedAt = null; }
    if (eventName === 'PermissionRequest') parent.status = 'waiting';
    if (eventName === 'Stop') parent.status = 'idle';
    if (eventName === 'StopFailure') parent.status = 'failed';
    if (eventName === 'SessionEnd') parent.status = 'completed';
    if (TERMINAL_PARENT_STATUSES.has(parent.status)) parent.finishedAt ||= at;
  }

  if (!isChild) return;
  const agentId = safeText(event?.agent?.agentId, event?.agent?.agentType || `unknown-${children.size + 1}`, 128);
  const id = `claude:${safeIdPart(parent.nativeSessionId)}:${safeIdPart(agentId)}`;
  const existing = children.get(id) || baseNode({
    id,
    parentId: parent.id,
    kind: 'subagent',
    label: safeText(event?.agent?.agentType, 'Claude subagent', 80),
    role: safeText(event?.agent?.agentType, null, 80),
    projectId: parent.projectId,
    runId: parent.runId,
    taskId: parent.taskId,
    attemptId: parent.attemptId,
    nativeSessionId: parent.nativeSessionId,
    status: 'unknown',
    statusLabel: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    observedAt: at,
    stale: false,
    source: 'claude-hooks',
    confidence: 'live',
    relation: 'native',
  });
  existing.updatedAt = at;
  existing.observedAt = at;
  existing.startedAt ||= at;
  existing.nativeSessionId = parent.nativeSessionId;
  existing.statusLabel = safeText(event?.agent?.statusReason, null, 80);
  if (eventName === 'SubagentStart') { existing.status = 'running'; existing.startedAt = at; existing.finishedAt = null; existing.stale = false; existing.confidence = 'live'; }
  else if (eventName === 'SubagentStop') { existing.status = 'completed'; existing.finishedAt = at; }
  else if (eventName === 'PermissionRequest') existing.status = 'waiting';
  else if (eventName === 'Notification' && event?.agent?.notificationType === 'agent_needs_input') existing.status = 'waiting';
  else if (eventName === 'StopFailure') { existing.status = 'failed'; existing.finishedAt = at; }
  children.set(id, existing);
}

function finalizeManaged(parent, children, now) {
  const parentUpdated = Date.parse(parent.updatedAt || parent.observedAt || '') || now;
  if (parent.eventCount === 0) {
    parent.confidence = 'unknown';
    parent.status = 'unknown';
    parent.stale = true;
  } else if (parent.status === 'running' && now - parentUpdated > STALE_MS) {
    parent.status = 'unknown';
    parent.stale = true;
    parent.confidence = 'unknown';
  }
  const parentClosed = parent.workerClosed === true || TERMINAL_PARENT_STATUSES.has(parent.status);
  for (const child of children.values()) {
    const updated = Date.parse(child.updatedAt || child.observedAt || '') || now;
    if ((CLOSED_CHILD_STATUSES.has(child.status) && parentClosed) || (child.status === 'running' && now - updated > STALE_MS)) {
      child.status = 'unknown';
      child.stale = true;
      child.confidence = parentClosed ? 'observed' : 'unknown';
      child.statusLabel ||= parentClosed ? 'parent ended before subagent stop' : 'stale running hook state';
    }
  }
}

function attemptTelemetry(run, taskRecord, attempt) {
  const telemetry = attempt?.telemetry || attempt?.claudeTelemetry || attempt?.launchManifest?.telemetry || null;
  if (!telemetry?.eventsFile) return null;
  return {
    runId: run.id,
    projectId: run.project || null,
    taskId: taskRecord?.definition?.id || attempt?.taskId || taskRecord?.id || 'unknown-task',
    attemptId: attempt?.id || 'unknown-attempt',
    attempt,
    telemetry,
  };
}

function collectAttempts(run, all) {
  const out = [];
  for (const taskRecord of Object.values(run?.tasks || {})) {
    const attempts = all ? taskRecord.attempts || [] : (taskRecord.currentAttempt ? (taskRecord.attempts || []).filter(a => a.id === taskRecord.currentAttempt) : []);
    for (const attempt of attempts) {
      const value = attemptTelemetry(run, taskRecord, attempt);
      if (value) out.push(value);
    }
  }
  return out;
}

function knownAttemptCwds(runs) {
  const values = new Set();
  for (const run of runs || []) {
    if (run?.project) values.add(path.resolve(run.project));
    for (const taskRecord of Object.values(run?.tasks || {})) {
      for (const attempt of taskRecord.attempts || []) if (attempt?.cwd) values.add(path.resolve(attempt.cwd));
    }
  }
  return values;
}

async function collectManaged(runs, now, limit, home) {
  const parents = [];
  const nodes = [];
  const managedSessions = new Set();
  for (const run of runs || []) {
    for (const item of collectAttempts(run, run.__collectAllAttempts === true)) {
      if (!item.telemetry.enabled) continue;
      const declaredSessionId = item.telemetry.nativeSessionId || item.attempt.nativeSessionId || item.attempt.nativeSession || null;
      if (declaredSessionId) managedSessions.add(declaredSessionId);
      const parentId = `cao:${safeIdPart(item.runId)}:${safeIdPart(item.taskId)}:${safeIdPart(item.attemptId)}`;
      const created = Date.parse(item.attempt.createdAt || '') || now;
      const parent = {
        id: parentId,
        nativeSessionId: declaredSessionId,
        status: 'unknown',
        updatedAt: iso(created),
        observedAt: iso(created),
        source: 'claude-hooks',
        confidence: 'unknown',
        projectId: item.projectId,
        runId: item.runId,
        taskId: item.taskId,
        attemptId: item.attemptId,
        startedAt: item.attempt.createdAt || null,
        finishedAt: null,
        stale: false,
        workerClosed: item.attempt.workerClosed === true,
        eventCount: 0,
        actualNativeSessionObserved: false,
      };
      const children = new Map();
      const events = await readNdjson(item.telemetry.eventsFile, limit);
      for (const event of events) applyManagedEvent(parent, children, event, now);
      if (parent.nativeSessionId) managedSessions.add(parent.nativeSessionId);
      if (parent.eventCount > 0) parent.confidence = 'live';
      finalizeManaged(parent, children, now);
      const parentUsage = await usageForClaudeSession({ home, cwd: item.attempt.cwd, sessionId: parent.nativeSessionId });
      parent.tokens = parentUsage?.total ?? null;
      parent.tokenUsage = parentUsage;
      for (const child of children.values()) {
        const agentId = child.id.split(':').at(-1);
        const childUsage = await usageForClaudeSession({ home, cwd: item.attempt.cwd, sessionId: child.nativeSessionId, agentId });
        child.tokenUsage = childUsage;
        child.tokens = childUsage?.total ?? null;
      }
      parents.push(parent);
      nodes.push(...children.values());
    }
  }
  return { parents, nodes, managedSessions };
}

async function listJsonlFiles(directory, out = [], budget = { files: MAX_TRANSCRIPT_FILES, dirs: MAX_FALLBACK_DIRS }, depth = 0) {
  if (out.length >= budget.files || budget.dirs <= 0 || depth > MAX_FALLBACK_DEPTH) return out;
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return out; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= budget.files || budget.dirs <= 0) break;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      budget.dirs -= 1;
      await listJsonlFiles(file, out, budget, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(file);
  }
  return out;
}

async function pathVariants(value) {
  if (!value) return [];
  const resolved = path.resolve(value);
  const variants = new Set([resolved]);
  try { variants.add(await fs.realpath(resolved)); } catch {}
  return [...variants];
}

async function fallbackSearchDirectories(base, { all, project, knownCwds }) {
  if (all) return [base];
  const directories = [];
  const seen = new Set();
  for (const candidate of [project, ...(knownCwds || [])]) {
    for (const variant of await pathVariants(candidate)) {
      const directory = path.join(base, claudeProjectSlug(variant));
      if (seen.has(directory)) continue;
      seen.add(directory);
      directories.push(directory);
    }
  }
  return directories;
}

async function fallbackFiles(base, options, limit) {
  const directories = await fallbackSearchDirectories(base, options);
  const files = [];
  const budget = { files: Math.min(MAX_TRANSCRIPT_FILES, limit), dirs: MAX_FALLBACK_DIRS };
  for (const directory of directories) {
    if (files.length >= budget.files) break;
    await listJsonlFiles(directory, files, budget);
  }
  return files;
}

function cwdInScope(cwd, project, knownCwds) {
  if (!cwd) return false;
  if (project && isPathInside(project, cwd)) return true;
  for (const known of knownCwds || []) if (isPathInside(known, cwd) || isPathInside(cwd, known)) return true;
  return false;
}

async function collectFallback({ home, project, knownCwds, managedSessions, now, limit, all = false }) {
  const base = path.join(home || path.join(os.homedir(), '.claude'), 'projects');
  const files = await fallbackFiles(base, { all, project, knownCwds }, limit);
  const nodes = [];
  for (const file of files) {
    const events = await readNdjson(file, 50);
    let latest = null;
    let sessionId = null;
    let isSidechain = false;
    let parentUuid = null;
    let agentType = null;
    let cwd = null;
    for (const event of events) {
      const t = eventTime(event, now);
      if (!latest || t > latest) latest = t;
      sessionId ||= safeText(event.sessionId || event.session_id, null, 256);
      cwd ||= safeText(event.cwd, null, 1024);
      if (event.isSidechain === true) isSidechain = true;
      parentUuid ||= safeText(event.parentUuid || event.sourceToolAssistantUUID, null, 256);
      // `type` on a transcript line is user/assistant/summary, not an agent role.
      agentType ||= safeText(event.agent_type || event.agentType, null, 80);
    }
    if (!sessionId || managedSessions.has(sessionId)) continue;
    if ((project || knownCwds?.size) && !cwdInScope(cwd, project, knownCwds)) continue;
    const id = `claude:${safeIdPart(sessionId)}:${safeIdPart(parentUuid || 'local')}`;
    // Read usage from this transcript itself so a subagent row never inherits its parent's log.
    const localUsage = await readClaudeUsage(file);
    nodes.push(baseNode({
      id,
      parentId: null,
      kind: isSidechain ? 'subagent' : 'agent',
      label: isSidechain ? 'Claude local subagent' : 'Claude local session',
      role: agentType,
      projectId: cwd ? path.resolve(cwd) : null,
      runId: null,
      taskId: null,
      attemptId: null,
      nativeSessionId: sessionId,
      status: 'unknown',
      statusLabel: 'metadata-only local transcript fallback',
      startedAt: null,
      updatedAt: latest ? iso(latest) : null,
      finishedAt: null,
      observedAt: iso(now),
      stale: true,
      source: 'claude-local',
      confidence: 'observed',
      relation: 'unlinked',
      tokenUsage: localUsage,
    }));
    if (nodes.length >= limit) break;
  }
  return nodes;
}

export async function collectClaude({ root, runs, home, project, all = false, now = Date.now(), limit = 500 } = {}) {
  const selectedRuns = Array.isArray(runs) ? runs : [];
  const collectAllRuns = selectedRuns.map(run => ({ ...run, __collectAllAttempts: all }));
  const managed = await collectManaged(collectAllRuns, now, Math.max(1, Math.min(limit, 500)), home);
  const knownCwds = knownAttemptCwds(selectedRuns);
  let nodes = [...managed.nodes];
  const shouldFallback = all || Boolean(project) || knownCwds.size > 0;
  if (shouldFallback && nodes.length < limit) {
    const fallback = await collectFallback({ home, project, knownCwds, managedSessions: managed.managedSessions, now, limit: Math.max(1, limit - nodes.length), all });
    nodes = nodes.concat(fallback);
  }
  if (nodes.length > limit) nodes = nodes.slice(0, limit);
  const hasConfigured = selectedRuns.some(run => collectAttempts(run, true).length > 0);
  const liveParents = managed.parents.filter(parent => parent.eventCount > 0).length;
  const status = liveParents > 0 || nodes.length > 0 ? 'connected' : (hasConfigured || managed.parents.length > 0 ? 'partial' : 'unavailable');
  const detail = status === 'connected'
    ? `Claude telemetry returned ${managed.parents.length} managed parent(s), ${liveParents} with hook events, and ${nodes.length} node(s).`
    : status === 'partial'
      ? 'Claude telemetry is configured, but no hook events were available yet.'
      : 'No Claude telemetry manifests or local fallback metadata were available.';
  return {
    nodes,
    parents: managed.parents.map(({ eventCount, actualNativeSessionObserved, workerClosed, ...parent }) => parent),
    health: { status, detail },
  };
}
