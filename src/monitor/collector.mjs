import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Herdr } from '../runtime/herdr.mjs';
import { caoNodeId, publicSnapshot } from './model.mjs';
import { runCommand } from '../process.mjs';
import { collectCodex } from './codex.mjs';
import { collectClaude } from './claude.mjs';
import { publicPerformance } from '../performance/index.mjs';

const activeStates = new Set(['preparing', 'launching', 'ready', 'sending', 'running', 'needs_input', 'uncertain', 'cancelling']);
const terminalStates = new Set(['accepted', 'integrated', 'failed', 'cancelled', 'rework', 'interrupted']);
const taskStatus = status => {
  if (['accepted', 'integrated'].includes(status)) return 'completed';
  if (['needs_input', 'rework'].includes(status)) return 'waiting';
  if (status === 'submitted') return 'idle';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed' || status === 'integration_failed') return 'failed';
  if (['interrupted', 'uncertain', 'integration_cancelled'].includes(status)) return 'unknown';
  return 'running';
};

function waitingLabel(attempt) {
  const base = attempt.status === 'rework'
    ? 'rework'
    : attempt.status === 'needs_input' && attempt.lastObservedState === 'blocked'
      ? 'needs_input · blocked'
      : attempt.status;
  if (attempt.providerObservation?.code) return `Provider saturated · not a CAO retry · ${base}`;
  return base;
}

async function readRuns(root, { project, runId, limit = 200 }) {
  let entries;
  try { entries = await fs.readdir(path.join(root, 'runs'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { runs: [], damaged: 0, truncated: false }; throw error; }
  const candidates = entries.filter(e => e.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(e.name) && (!runId || e.name === runId));
  const runs = []; let damaged = 0;
  for (const entry of candidates.slice(-limit)) {
    try {
      const file = path.join(root, 'runs', entry.name, 'run.json');
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) { damaged++; continue; }
      const r = JSON.parse(await fs.readFile(file, 'utf8'));
      if (r.schemaVersion !== 1 || !r.tasks || Array.isArray(r.tasks) || typeof r.project !== 'string') { damaged++; continue; }
      if (!project || path.resolve(r.project) === path.resolve(project)) runs.push(r);
    } catch { damaged++; }
  }
  return { runs, damaged, truncated: candidates.length > limit };
}

function taskNode(run, task, attempt, now) {
  const coordinator = attempt.coordinatorThreadId || run.coordinatorThreadId;
  return {
    id: caoNodeId(run.id, task.definition.id, attempt.id), parentId: coordinator ? `codex:${coordinator}` : null,
    agent: attempt.execution?.agent || task.definition.agent, kind: 'agent',
    executorKind: attempt.executorKind || 'external',
    route: attempt.routeDecision ? { mode: attempt.routeDecision.mode, resourceId: attempt.routeDecision.resource?.id || null, preference: attempt.routeDecision.preference, reasons: attempt.routeDecision.reasons } : null,
    nativeChildren: attempt.nativeChildren || null,
    label: `${task.definition.id} · ${attempt.number || 1}`, role: task.definition.role || 'implementer',
    model: attempt.execution?.model || null, projectId: run.project, runId: run.id, taskId: task.definition.id,
    attemptId: attempt.id, nativeSessionId: attempt.nativeSession?.id || attempt.telemetry?.nativeSessionId || null,
    status: taskStatus(attempt.status),
    statusLabel: ['needs_input', 'rework'].includes(attempt.status) ? waitingLabel(attempt) : attempt.status,
    performance: attempt.performance ? publicPerformance(attempt, { now: new Date(now).toISOString(), taskId: task.definition.id }) : null,
    delivery: ['submitted', 'accepted', 'integrated', 'rework'].includes(attempt.status) ? attempt.status : null,
    startedAt: attempt.createdAt, updatedAt: run.updatedAt,
    finishedAt: terminalStates.has(attempt.status) ? attempt.integration?.finishedAt || attempt.verification?.finishedAt || run.updatedAt : null,
    observedAt: new Date(now).toISOString(), stale: false, source: 'cao', confidence: attempt.executorKind === 'host' ? 'reported' : 'observed', relation: 'cao', tokens: null,
  };
}

function pathMatchesAny(candidate, roots) {
  if (!candidate || typeof candidate !== 'string') return false;
  let resolved;
  try { resolved = path.resolve(candidate); } catch { return false; }
  for (const root of roots) {
    if (!root) continue;
    const base = path.resolve(root);
    const relative = path.relative(base, resolved);
    if (relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))) return true;
  }
  return false;
}

function pruneProjectScope(nodes, { project, entries, trustedCoordinatorIds, currentCoordinatorId }) {
  if (!project) return nodes;
  const byId = new Map(nodes.filter(node => node?.id).map(node => [node.id, node]));
  const children = new Map();
  for (const node of byId.values()) {
    if (!node.parentId) continue;
    const list = children.get(node.parentId) || [];
    list.push(node);
    children.set(node.parentId, list);
  }
  const knownCwds = new Set([project]);
  for (const entry of entries) {
    if (entry.run?.project) knownCwds.add(entry.run.project);
    if (entry.attempt?.cwd) knownCwds.add(entry.attempt.cwd);
  }
  const trustedRoots = new Set([...trustedCoordinatorIds].map(id => `codex:${id}`));
  const currentRoot = currentCoordinatorId ? `codex:${currentCoordinatorId}` : null;
  const keep = new Set();
  const traversedTrusted = new Set();

  const explicitForeign = node => Boolean(node?.projectId) && !pathMatchesAny(node.projectId, knownCwds);
  const addTrustedTree = id => {
    if (!id || traversedTrusted.has(id)) return;
    traversedTrusted.add(id);
    keep.add(id);
    for (const child of children.get(id) || []) addTrustedTree(child.id);
  };
  const addCurrentTree = id => {
    const node = byId.get(id);
    if (!node || keep.has(id)) return;
    if (id !== currentRoot && explicitForeign(node)) return;
    keep.add(id);
    for (const child of children.get(id) || []) addCurrentTree(child.id);
  };
  const addWithAllowedAncestors = id => {
    let cursor = id;
    const seen = new Set();
    while (cursor && byId.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      const node = byId.get(cursor);
      if (explicitForeign(node) && !trustedRoots.has(cursor)) break;
      keep.add(cursor);
      cursor = node.parentId;
    }
  };

  for (const node of byId.values()) {
    if (node.source === 'cao' || node.id.startsWith('cao:')) addTrustedTree(node.id);
  }
  for (const root of trustedRoots) addTrustedTree(root);
  if (currentRoot) addCurrentTree(currentRoot);
  for (const node of byId.values()) {
    if (node.projectId && pathMatchesAny(node.projectId, knownCwds)) addWithAllowedAncestors(node.id);
  }
  // Keep only the ancestor path of a matching node, never unrelated siblings.
  for (const id of [...keep]) {
    let parent = byId.get(id)?.parentId;
    const seen = new Set([id]);
    while (parent && byId.has(parent) && !seen.has(parent)) {
      seen.add(parent); keep.add(parent); parent = byId.get(parent).parentId;
    }
  }
  return nodes.filter(node => keep.has(node.id));
}

export class MonitorCollector {
  constructor({ root, project = null, runId = null, all = false, coordinatorId = null, coordinatorExplicit = false, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), herdr, codex = collectCodex, claude = collectClaude, now = Date.now } = {}) {
    this.root = path.resolve(root);
    this.scope = { project: project ? path.resolve(project) : null, runId, all, coordinatorId, coordinatorExplicit };
    this.codexHome = codexHome; this.claudeHome = claudeHome;
    this.herdr = herdr || new Herdr({ runner: (argv, options) => runCommand(argv, { ...options, timeoutMs: 2000 }) });
    this.codex = codex; this.claude = claude; this.now = now;
  }

  async snapshot() {
    const now = this.now();
    const result = await readRuns(this.root, { project: this.scope.all ? null : this.scope.project, runId: this.scope.runId });
    const { runs } = result;
    const entries = [];
    for (const run of runs) for (const task of Object.values(run.tasks)) {
      if (!task?.definition?.id || !Array.isArray(task.attempts)) continue;
      for (const attempt of task.attempts) if (attempt?.id) entries.push({ run, task, attempt, node: taskNode(run, task, attempt, now) });
    }
    const trustedCoordinatorIds = new Set([...runs.map(r => r.coordinatorThreadId), ...entries.map(e => e.attempt.coordinatorThreadId)].filter(Boolean));
    if (this.scope.coordinatorExplicit && this.scope.coordinatorId) trustedCoordinatorIds.add(this.scope.coordinatorId);
    const rootIds = [...new Set([this.scope.coordinatorId, ...trustedCoordinatorIds].filter(Boolean))];
    const unavailable = label => ({ nodes: [], parents: [], health: { status: 'unavailable', detail: `${label} status is unavailable; other sources are still shown.` } });
    const [codex, claude] = await Promise.all([
      this.codex({ home: this.codexHome, rootIds: this.scope.all ? [] : rootIds, project: this.scope.all ? null : this.scope.project, all: this.scope.all, now, limit: 500 }).catch(() => unavailable('Codex')),
      this.claude({ root: this.root, runs, home: this.claudeHome, project: this.scope.project, all: this.scope.all, now, limit: 500 }).catch(() => unavailable('Claude')),
    ]);
    const parentSignals = new Map((claude.parents || []).map(n => [n.id, n]));
    let liveCount = 0, runtimeUnavailable = 0;
    const liveRuns = runs.filter(r => entries.some(e => e.run.id === r.id && e.attempt.paneId && !e.attempt.workerClosed && activeStates.has(e.attempt.status)));
    for (let offset = 0; offset < liveRuns.length; offset += 4) {
      await Promise.all(liveRuns.slice(offset, offset + 4).map(async run => {
        let agents;
        try {
          const response = await this.herdr.snapshot(run.herdrSession);
          agents = response.result?.snapshot?.agents;
          if (!Array.isArray(agents)) throw new Error('Unsupported snapshot');
          liveCount++;
        } catch { runtimeUnavailable++; }
        for (const entry of entries.filter(e => e.run.id === run.id && e.attempt.paneId && !e.attempt.workerClosed && activeStates.has(e.attempt.status))) {
          const agent = agents?.find(a => a.name === entry.attempt.workerName);
          let same = agent && agent.pane_id === entry.attempt.paneId && agent.terminal_id === entry.attempt.terminalId && agent.agent === entry.node.agent;
          if (same && entry.attempt.processIdentity) {
            try {
              const info = (await this.herdr.getProcessInfo(run.herdrSession, entry.attempt.paneId)).result?.process_info;
              same = info?.foreground_process_group_id === entry.attempt.processIdentity.group && info?.shell_pid === entry.attempt.processIdentity.shell;
            } catch { same = false; }
          }
          if (!same) { entry.node.status = 'unknown'; entry.node.statusLabel = 'Runtime unavailable'; entry.node.stale = true; continue; }
          entry.node.confidence = 'live';
          if (entry.attempt.status === 'uncertain') { entry.node.status = 'unknown'; entry.node.statusLabel = 'Task delivery uncertain'; continue; }
          if (agent.agent_status === 'blocked') { entry.node.status = 'waiting'; entry.node.statusLabel = waitingLabel(entry.attempt); }
          else if (['idle', 'done'].includes(agent.agent_status)) { entry.node.status = 'idle'; entry.node.statusLabel = 'Idle · not yet accepted'; }
          else { entry.node.status = 'running'; entry.node.statusLabel = 'Running'; }
        }
      }));
    }
    for (const entry of entries) {
      const signal = parentSignals.get(entry.node.id);
      if (signal?.nativeSessionId) entry.node.nativeSessionId = signal.nativeSessionId;
      if (signal?.tokenUsage) { entry.node.tokenUsage = signal.tokenUsage; entry.node.tokens = signal.tokens; }
      if (!entry.attempt.workerClosed && signal?.status === 'waiting' && entry.node.confidence !== 'live') entry.node.status = 'waiting';
    }
    const nodes = [...entries.map(e => e.node), ...(codex.nodes || []), ...(claude.nodes || [])];
    const ids = new Set(nodes.map(n => n.id));
    for (const id of rootIds) if (!ids.has(`codex:${id}`)) nodes.push({ id: `codex:${id}`, agent: 'codex', kind: 'coordinator', label: 'Codex coordinator', nativeSessionId: id, status: 'unknown', statusLabel: 'Live status unavailable', source: 'codex', confidence: 'unknown', relation: 'cao', projectId: this.scope.project });
    // An explicit run filter also limits native child trees to the selected CAO/caller roots.
    let selectedNodes = nodes;
    if (this.scope.runId) {
      const keep = new Set([...entries.map(e => e.node.id), ...rootIds.map(id => `codex:${id}`)]);
      let changed = true;
      while (changed) { changed = false; for (const node of nodes) if (node.parentId && keep.has(node.parentId) && !keep.has(node.id)) { keep.add(node.id); changed = true; } }
      const byId = new Map(nodes.map(node => [node.id, node]));
      for (const id of [...keep]) {
        let parent = byId.get(id)?.parentId;
        const seen = new Set([id]);
        while (parent && byId.has(parent) && !seen.has(parent)) { seen.add(parent); keep.add(parent); parent = byId.get(parent).parentId; }
      }
      selectedNodes = nodes.filter(n => keep.has(n.id));
    } else if (this.scope.project && !this.scope.all) {
      selectedNodes = pruneProjectScope(nodes, {
        project: this.scope.project,
        entries,
        trustedCoordinatorIds,
        currentCoordinatorId: this.scope.coordinatorId,
      });
    }
    // Native descendants may run in another cwd/worktree. In a project-scoped
    // collection their project membership comes from the explicitly selected tree.
    if (this.scope.project && !this.scope.all) selectedNodes = selectedNodes.map(node => ({ ...node, projectId: this.scope.project }));
    const projects = new Map();
    for (const p of [this.scope.project, ...runs.map(r => r.project), ...selectedNodes.map(n => n.projectId)]) if (p) projects.set(p, { id: p, label: path.basename(p), path: p });
    return publicSnapshot({
      nodes: selectedNodes, projects: [...projects.values()], scope: this.scope, currentConversationId: this.scope.coordinatorId, truncated: result.truncated || codex.truncated || claude.truncated,
      sources: [
        { id: 'cao', label: 'CAO tasks', status: result.damaged ? 'partial' : 'connected', detail: result.damaged ? `${result.damaged} records could not be read.` : `${runs.length} runs; acceptance comes from CAO verification.` },
        { id: 'codex', label: 'Codex agents', ...codex.health },
        { id: 'claude', label: 'Claude agents', ...claude.health },
        { id: 'herdr', label: 'Herdr runtime', status: runtimeUnavailable ? liveCount ? 'partial' : 'unavailable' : 'connected', detail: liveRuns.length ? `${liveCount} active runtimes observed; idle is not acceptance.` : 'No active CAO runtime requires observation.' },
      ],
    }, now);
  }
}
