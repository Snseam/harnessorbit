import test from 'node:test';
import assert from 'node:assert/strict';
import { publicSnapshot } from '../src/monitor/model.mjs';

const now = Date.parse('2026-01-01T00:00:00.000Z');

test('publicSnapshot exposes only browser contract fields and strips sensitive text fields', () => {
  const snapshot = publicSnapshot({
    scope: { project: '/project', runId: 'run1' },
    projects: [{ id: '/project', label: 'Project\u0007Name', path: '/project', secret: 'PROJECT_SECRET' }],
    sources: [{ id: 'cao', status: 'connected', label: 'CAO', detail: 'ok', secret: 'SOURCE_SECRET' }],
    nodes: [{
      id: 'node1', parentId: null, agent: 'codex', kind: 'agent', label: 'Worker\u001b[31m', role: 'implementer', model: 'gpt',
      projectId: '/project', runId: 'run1', taskId: 'task1', attemptId: 'attempt1', nativeSessionId: 'session1',
      status: 'running', statusLabel: 'Running', delivery: 'submitted', startedAt: now, updatedAt: now, finishedAt: null,
      observedAt: now, stale: false, source: 'cao', confidence: 'live', relation: 'cao', tokens: 7,
      prompt: 'PROMPT_SECRET', objective: 'OBJECTIVE_SECRET', messages: ['MESSAGE_SECRET'], toolOutput: 'TOOL_SECRET', secret: 'NODE_SECRET',
    }],
  }, now);

  assert.deepEqual(Object.keys(snapshot.nodes[0]).sort(), [
    'agent', 'attemptId', 'confidence', 'conversationId', 'conversationTitle', 'delivery', 'executorKind', 'finishedAt', 'id', 'kind', 'label', 'model', 'nativeSessionId', 'nativeChildren', 'route', 'observedAt',
    'parentId', 'performance', 'projectId', 'relation', 'role', 'runId', 'source', 'stale', 'startedAt', 'status', 'statusLabel', 'taskId', 'tokens', 'tokenUsage', 'updatedAt',
  ].sort());
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /PROMPT_SECRET|OBJECTIVE_SECRET|MESSAGE_SECRET|TOOL_SECRET|NODE_SECRET|PROJECT_SECRET|SOURCE_SECRET/);
  assert.equal(snapshot.nodes[0].label, 'Worker [31m');
  assert.doesNotMatch(snapshot.nodes[0].label, /[\x00-\x1f]/);
});

test('monitor timings expose bounded counters without forwarding task evidence', () => {
  const snapshot = publicSnapshot({ scope: {}, projects: [], sources: [], nodes: [{ id: 'n', performance: {
    phase: 'blocked', durationsMs: { prepare: 12, execute: -1, secret: 'PRIVATE' }, blockedMs: 15,
    blocker: { category: 'permission', message: 'PRIVATE' }, progressState: { nonce: 'PRIVATE' },
    evidence: { checks: ['PRIVATE'] }, coverage: { hasLegacyPrehistory: true },
  } }] }, now);
  const timing = snapshot.nodes[0].performance;
  assert.equal(timing.phase, 'blocked');
  assert.equal(timing.durationsMs.prepare, 12);
  assert.equal(timing.durationsMs.execute, null);
  assert.equal(timing.blockerCategory, 'permission');
  assert.equal(timing.legacyPrehistory, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/);
});

test('monitor timings copy bounded lastErrorCode from evidence and drop private details', () => {
  const snapshot = publicSnapshot({ scope: {}, projects: [], sources: [], nodes: [{ id: 'n', performance: {
    phase: 'finished',
    evidence: { lastErrorCode: 'unsupported_submodule', message: 'PRIVATE', details: { token: 'PRIVATE' } },
    lastError: { code: 'unsupported_submodule', message: 'PRIVATE' },
  } }] }, now);
  assert.equal(snapshot.nodes[0].performance.lastErrorCode, 'unsupported_submodule');
  assert.equal(Object.hasOwn(snapshot.nodes[0].performance, 'evidence'), false);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/);
});

test('publicSnapshot falls back invalid enum and scalar values to safe public values', () => {
  const snapshot = publicSnapshot({
    scope: { all: true, project: null, runId: null }, projects: [], sources: [{ id: 'weird', status: 'bogus', label: null, detail: null }],
    nodes: [{ id: 'n', agent: 'made-up', kind: 'bad-kind', status: 'done-ish', delivery: 'raw-output', source: 'filesystem', confidence: 'certain', relation: 'magic', tokens: -1 }],
  }, now);

  assert.equal(snapshot.scope.mode, 'all');
  assert.equal(snapshot.nodes[0].agent, 'unknown');
  assert.equal(snapshot.nodes[0].kind, 'agent');
  assert.equal(snapshot.nodes[0].status, 'unknown');
  assert.equal(snapshot.nodes[0].delivery, null);
  assert.equal(snapshot.nodes[0].source, 'cao');
  assert.equal(snapshot.nodes[0].confidence, 'unknown');
  assert.equal(snapshot.nodes[0].relation, 'unlinked');
  assert.equal(snapshot.nodes[0].tokens, null);
  assert.equal(snapshot.sources[0].status, 'unavailable');
});

test('publicSnapshot breaks cyclic parents and enforces node limit without hanging', () => {
  const nodes = [
    { id: 'a', parentId: 'b', relation: 'native' },
    { id: 'b', parentId: 'a', relation: 'native' },
  ];
  for (let i = 0; i < 1005; i++) nodes.push({ id: `extra-${i}`, status: 'running' });
  const snapshot = publicSnapshot({ scope: {}, projects: [], sources: [], nodes }, now);

  assert.equal(snapshot.nodes.length, 1000);
  assert.equal(snapshot.truncated, true);
  const a = snapshot.nodes.find(node => node.id === 'a');
  const b = snapshot.nodes.find(node => node.id === 'b');
  assert.ok(!a.parentId || !b.parentId || a.parentId !== 'b' || b.parentId !== 'a');
  assert.ok([a, b].some(node => node.relation === 'unlinked' && node.parentId === null));
});

test('token metadata keeps an authoritative total without summing detail counters or leaking payload fields', () => {
  const snapshot = publicSnapshot({ nodes: [{ id: 'usage', tokens: 999, tokenUsage: { total: 100, input: 80, output: 20, cacheRead: 40, reasoning: 10, scope: 'session', source: 'local', complete: true, prompt: 'TOKEN_PRIVATE_CANARY' } }], projects: [], sources: [], scope: { all: true } });
  assert.equal(snapshot.nodes[0].tokens, 100);
  assert.equal(snapshot.nodes[0].tokenUsage.total, 100);
  assert.equal(snapshot.nodes[0].tokenUsage.cacheRead, 40);
  assert.equal(JSON.stringify(snapshot).includes('TOKEN_PRIVATE_CANARY'), false);
  const empty = publicSnapshot({ nodes: [{ id: 'missing' }, { id: 'zero', tokenUsage: { total: 0, complete: true } }], projects: [], sources: [], scope: {} });
  assert.equal(empty.nodes[0].tokens, null);
  assert.equal(empty.nodes[0].tokenUsage, null);
  assert.equal(empty.nodes[1].tokens, 0);
});

test('publicSnapshot keeps host executorKind and adaptive-only route metadata', () => {
  const snapshot = publicSnapshot({
    nodes: [{
      id: 'host-node', executorKind: 'host',
      route: { mode: 'adaptive', resourceId: 'native-host', preference: 'balanced', reasons: ['preference:balanced'] },
      nativeChildren: { state: 'verified', complete: true, source: 'controller-no-worker-created', children: [] },
    }],
    projects: [], sources: [], scope: {},
  }, now);
  assert.equal(snapshot.nodes[0].executorKind, 'host');
  assert.deepEqual(snapshot.nodes[0].route, {
    mode: 'adaptive', resourceId: 'native-host', preference: 'balanced', reasons: ['preference:balanced'],
  });
  assert.equal(snapshot.nodes[0].nativeChildren.state, 'verified');
  assert.equal(snapshot.nodes[0].nativeChildren.complete, true);
  assert.equal(snapshot.nodes[0].nativeChildren.count, 0);

  const other = publicSnapshot({
    nodes: [{ id: 'ext', executorKind: 'external', route: { mode: 'shadow', resourceId: 'secret' } }],
    projects: [], sources: [], scope: {},
  }, now);
  assert.equal(other.nodes[0].executorKind, 'external');
  assert.equal(other.nodes[0].route, null);
});

test('re-sanitizing snapshots cannot turn ambiguous or cyclic conversation ancestry into a confirmed group', () => {
  const root = { id: 'codex:root', nativeSessionId: 'root', agent: 'codex', kind: 'coordinator', relation: 'native' };
  for (const nodes of [[root, { ...root }], [{ ...root, parentId: 'codex:other' }, { ...root, id: 'codex:other', nativeSessionId: 'other', parentId: 'codex:root' }]]) {
    const first = publicSnapshot({ nodes, projects: [], sources: [], scope: {} });
    const second = publicSnapshot({ ...first, scope: {} });
    assert.deepEqual(first.conversations, []);
    assert.deepEqual(second.conversations, []);
    assert.ok(second.nodes.every(n => n.conversationId === null));
  }
});

test('collector-to-server sanitization preserves child counts and timing evidence without private data', () => {
  const first = publicSnapshot({
    nodes: [{ id: 'attempt',
      nativeChildren: { state: 'blocked', complete: false, source: 'claude-hooks', children: [{ id: 'private-child-id', status: 'running' }] },
      performance: { phase: 'blocked', durationsMs: { execute: 100 }, blockedMs: 20,
        blocker: { category: 'native_children', secret: 'PRIVATE' }, coverage: { hasLegacyPrehistory: true } },
    }], projects: [], sources: [], scope: {},
  }, now);
  const second = publicSnapshot(first, now);
  assert.deepEqual(second.nodes[0].nativeChildren, first.nodes[0].nativeChildren);
  assert.deepEqual(second.nodes[0].performance, first.nodes[0].performance);
  assert.equal(second.nodes[0].nativeChildren.count, 1);
  assert.equal(second.nodes[0].performance.blockerCategory, 'native_children');
  assert.equal(second.nodes[0].performance.legacyPrehistory, true);
  assert.doesNotMatch(JSON.stringify(second), /private-child-id|PRIVATE/);
});
