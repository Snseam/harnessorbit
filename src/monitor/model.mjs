import path from 'node:path';
import { deriveConversations } from './conversations.mjs';

const states = new Set(['running', 'waiting', 'idle', 'completed', 'failed', 'cancelled', 'unknown']);
const agents = new Set(['codex', 'claude', 'pi', 'opencode', 'unknown']);
const sources = new Set(['cao', 'codex', 'claude-hooks', 'claude-local']);
export const caoNodeId = (run, task, attempt) => `cao:${run}:${task}:${attempt}`;
export const within = (parent, child) => typeof parent === 'string' && typeof child === 'string' && (path.resolve(parent) === path.resolve(child) || path.resolve(child).startsWith(path.resolve(parent) + path.sep));
export const cleanText = (value, max = 160) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ').slice(0, max) : null;
const date = value => { const parsed = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null; return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null; };
const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function publicTokenUsage(value) {
  if (!value || typeof value !== 'object' || counter(value.total) === null) return null;
  return {
    total: value.total,
    input: counter(value.input), output: counter(value.output),
    cacheRead: counter(value.cacheRead), cacheWrite: counter(value.cacheWrite), reasoning: counter(value.reasoning),
    scope: ['session', 'turn', 'observed'].includes(value.scope) ? value.scope : 'observed',
    source: cleanText(value.source, 80) || 'unknown', complete: value.complete === true,
  };
}

function publicTiming(value) {
  if (!value || typeof value !== 'object') return null;
  const phases = ['prepare', 'launch', 'execute', 'collect', 'verify', 'integrate'];
  const lastErrorCode = cleanText(value.evidence?.lastErrorCode ?? value.lastErrorCode, 80);
  return {
    phase: [...phases, 'blocked', 'finished', 'unknown'].includes(value.phase) ? value.phase : 'unknown',
    durationsMs: Object.fromEntries(phases.map(phase => [phase, counter(value.durationsMs?.[phase])])),
    blockedMs: counter(value.blockedMs),
    lastProgressAt: date(value.lastProgressAt),
    lastObservedAt: date(value.lastObservedAt),
    blockerCategory: cleanText(value.blocker?.category ?? value.blockerCategory, 40),
    legacyPrehistory: value.coverage?.hasLegacyPrehistory === true || value.legacyPrehistory === true,
    ...(lastErrorCode ? { lastErrorCode } : {}),
  };
}

// This is the only shape allowed to cross the browser boundary. Do not spread source records.
export function publicNode(node, observedAt) {
  node = node && typeof node === 'object' ? node : {};
  const tokenUsage = publicTokenUsage(node.tokenUsage);
  return {
    id: cleanText(node.id, 256), parentId: cleanText(node.parentId, 256),
    agent: agents.has(node.agent) ? node.agent : 'unknown',
    executorKind: ['host', 'external'].includes(node.executorKind) ? node.executorKind : null,
    route: node.route?.mode === 'adaptive' ? { mode: 'adaptive', resourceId: cleanText(node.route.resourceId, 160), preference: cleanText(node.route.preference, 40), reasons: (Array.isArray(node.route.reasons) ? node.route.reasons : []).slice(0, 12).map(reason => cleanText(reason, 160)) } : null,
    nativeChildren: node.nativeChildren ? { state: ['verified', 'reported', 'unknown', 'blocked'].includes(node.nativeChildren.state) ? node.nativeChildren.state : 'unknown', complete: node.nativeChildren.complete === true, source: cleanText(node.nativeChildren.source, 80), count: Array.isArray(node.nativeChildren.children) ? node.nativeChildren.children.length : counter(node.nativeChildren.count) } : null,
    kind: ['coordinator', 'agent', 'subagent'].includes(node.kind) ? node.kind : 'agent',
    label: cleanText(node.label) || 'Agent', role: cleanText(node.role, 80), model: cleanText(node.model, 120),
    conversationTitle: cleanText(node.conversationTitle, 120),
    projectId: cleanText(node.projectId, 1024), runId: cleanText(node.runId, 64), taskId: cleanText(node.taskId, 64),
    attemptId: cleanText(node.attemptId, 128), nativeSessionId: cleanText(node.nativeSessionId, 128),
    status: states.has(node.status) ? node.status : 'unknown', statusLabel: cleanText(node.statusLabel, 100),
    delivery: ['submitted', 'accepted', 'integrated', 'rework'].includes(node.delivery) ? node.delivery : null,
    startedAt: date(node.startedAt), updatedAt: date(node.updatedAt), finishedAt: date(node.finishedAt),
    observedAt: date(node.observedAt) || observedAt, stale: node.stale === true,
    source: sources.has(node.source) ? node.source : 'cao',
    confidence: ['live', 'observed', 'reported', 'unknown'].includes(node.confidence) ? node.confidence : 'unknown',
    relation: ['native', 'cao', 'workspace', 'unlinked'].includes(node.relation) ? node.relation : 'unlinked',
    tokens: tokenUsage?.total ?? counter(node.tokens), tokenUsage,
    performance: publicTiming(node.performance),
  };
}

export function publicSnapshot({ nodes, projects, sources: sourceStates, scope, truncated = false, currentConversationId = null }, now = Date.now()) {
  const observedAt = new Date(now).toISOString();
  const normalized = nodes.map(node => publicNode(node, observedAt)).filter(node => node.id);
  const graph = deriveConversations(normalized, { currentConversationId });
  const unique = new Map();
  for (const node of graph.nodes) {
    if (unique.has(node.id)) {
      const previous = unique.get(node.id);
      const latest = (Date.parse(previous.updatedAt) || 0) > (Date.parse(node.updatedAt) || 0) ? previous : node;
      unique.set(node.id, { ...latest, parentId: null, conversationId: null, relation: 'unlinked' });
    } else unique.set(node.id, node);
  }
  // Malformed or cyclic ancestry must never lock up the browser's tree renderer.
  for (const node of unique.values()) {
    let cursor = node.parentId;
    const seen = new Set([node.id]);
    while (cursor && unique.has(cursor)) {
      if (seen.has(cursor)) { node.parentId = null; node.relation = 'unlinked'; break; }
      seen.add(cursor); cursor = unique.get(cursor).parentId;
    }
  }
  const visibleNodes = [...unique.values()].slice(0, 1000);
  const counts = new Map();
  for (const node of visibleNodes) if (node.conversationId) counts.set(node.conversationId, (counts.get(node.conversationId) || 0) + 1);
  return {
    schemaVersion: 1, observedAt,
    scope: { mode: scope.all ? 'all' : 'project', project: scope.project || null, runId: scope.runId || null },
    projects: projects.map(p => ({ id: cleanText(p.id, 1024), label: cleanText(p.label), path: cleanText(p.path, 1024) })),
    nodes: visibleNodes,
    currentConversationId: counts.has(graph.currentConversationId) ? graph.currentConversationId : null,
    conversations: graph.conversations.filter(c => counts.has(c.id)).map(c => ({ ...c, agentCount: counts.get(c.id) })),
    sources: sourceStates.map(s => ({ id: cleanText(s.id, 40), status: ['connected', 'partial', 'unavailable'].includes(s.status) ? s.status : 'unavailable', label: cleanText(s.label, 80), detail: cleanText(s.detail, 240) || '' })),
    truncated: truncated || unique.size > 1000 || normalized.length > graph.nodes.length,
  };
}
