import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MonitorCollector } from '../src/monitor/collector.mjs';
import { saveRun } from '../src/state.mjs';

async function root(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-monitor-collector-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function attempt(id, status, extra = {}) {
  return {
    id,
    taskId: extra.taskId || 'task1',
    number: extra.number || 1,
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    workerClosed: !['running', 'ready', 'needs_input', 'submitted', 'uncertain'].includes(status),
    workerName: `worker-${id}`,
    paneId: `pane-${id}`,
    terminalId: `term-${id}`,
    execution: { agent: extra.agent || 'claude', model: extra.model || 'model-x' },
    ...extra,
  };
}

function taskRecord(id, attempts, extra = {}) {
  return {
    definition: {
      id,
      agent: extra.definitionAgent || 'claude',
      role: 'implementer',
      isolation: 'worktree',
      ...extra.definition,
    },
    attempts,
    currentAttempt: attempts.at(-1).id,
  };
}

function runRecord(id, project, tasks, extra = {}) {
  return {
    schemaVersion: 1,
    id,
    project,
    updatedAt: '2026-01-01T00:10:00.000Z',
    herdrSession: `session-${id}`,
    coordinatorThreadId: extra.coordinatorThreadId,
    tasks: Object.fromEntries(tasks.map(task => [task.definition.id, task])),
  };
}

function codexFake(extra = {}) {
  const calls = [];
  const fn = async options => {
    calls.push(options);
    if (extra.throw) throw new Error('CODEX_CANARY_SECRET');
    return {
      nodes: extra.nodes || [],
      parents: extra.parents || [],
      health: extra.health || { status: 'connected', detail: 'codex ok' },
      truncated: extra.truncated || false,
    };
  };
  fn.calls = calls;
  return fn;
}

function claudeFake(extra = {}) {
  const calls = [];
  const fn = async options => {
    calls.push(options);
    if (extra.throw) throw new Error('CLAUDE_CANARY_SECRET');
    return {
      nodes: extra.nodes || [],
      parents: extra.parents || [],
      health: extra.health || { status: 'connected', detail: 'claude ok' },
      truncated: extra.truncated || false,
    };
  };
  fn.calls = calls;
  return fn;
}

function herdrFake(snapshots = {}) {
  return {
    calls: [],
    async snapshot(session) {
      this.calls.push(session);
      const value = snapshots[session];
      if (value instanceof Error) throw value;
      return value || { result: { snapshot: { agents: [] } } };
    },
  };
}

test('collector respects project and run scope and keeps native child relationships', async t => {
  const state = await root(t);
  const projectA = path.join(state, 'project-a');
  const projectB = path.join(state, 'project-b');
  await saveRun(state, runRecord('run-a', projectA, [
    taskRecord('task-a', [attempt('task-a-a1', 'accepted', { taskId: 'task-a', nativeSession: { id: 'native-a' } })]),
  ], { coordinatorThreadId: 'coord-a' }));
  await saveRun(state, runRecord('run-b', projectB, [
    taskRecord('task-b', [attempt('task-b-a1', 'accepted', { taskId: 'task-b' })]),
  ], { coordinatorThreadId: 'coord-b' }));
  const codex = codexFake({ nodes: [{ id: 'codex:child-a', parentId: 'codex:coord-a', agent: 'codex', kind: 'subagent', label: 'child', status: 'running', source: 'codex', relation: 'native' }] });
  const collector = new MonitorCollector({ root: state, project: projectA, codex, claude: claudeFake(), herdr: herdrFake(), now: () => Date.parse('2026-01-01T00:20:00.000Z') });

  const snapshot = await collector.snapshot();
  assert.equal(snapshot.scope.mode, 'project');
  assert.equal(snapshot.scope.project, projectA);
  assert.ok(snapshot.nodes.some(node => node.id === 'cao:run-a:task-a:task-a-a1'));
  assert.ok(!snapshot.nodes.some(node => node.id.includes('run-b')));
  assert.ok(snapshot.nodes.some(node => node.id === 'codex:coord-a'));
  assert.ok(snapshot.nodes.some(node => node.id === 'codex:child-a' && node.parentId === 'codex:coord-a'));
  assert.deepEqual(codex.calls[0].rootIds, ['coord-a']);
});

test('collector separates native idle from CAO delivery acceptance', async t => {
  const state = await root(t);
  const project = path.join(state, 'project');
  await saveRun(state, runRecord('run-delivery', project, [
    taskRecord('submitted-task', [attempt('submitted-a1', 'submitted', { taskId: 'submitted-task', workerClosed: true })]),
    taskRecord('accepted-task', [attempt('accepted-a1', 'accepted', { taskId: 'accepted-task', verification: { finishedAt: '2026-01-01T00:05:00.000Z' } })]),
    taskRecord('rework-task', [attempt('rework-a1', 'rework', { taskId: 'rework-task' })]),
  ]));
  const snapshot = await new MonitorCollector({ root: state, project, codex: codexFake(), claude: claudeFake(), herdr: herdrFake() }).snapshot();

  const submitted = snapshot.nodes.find(node => node.taskId === 'submitted-task');
  assert.equal(submitted.status, 'idle');
  assert.equal(submitted.delivery, 'submitted');
  const accepted = snapshot.nodes.find(node => node.taskId === 'accepted-task');
  assert.equal(accepted.status, 'completed');
  assert.equal(accepted.delivery, 'accepted');
  const rework = snapshot.nodes.find(node => node.taskId === 'rework-task');
  assert.equal(rework.status, 'waiting');
  assert.equal(rework.delivery, 'rework');
});

test('collector labels provider saturation without changing waiting status', async t => {
  const state = await root(t);
  const project = path.join(state, 'project');
  await saveRun(state, runRecord('run-sat', project, [
    taskRecord('blocked-task', [attempt('blocked-a1', 'needs_input', {
      taskId: 'blocked-task',
      lastObservedState: 'blocked',
      workerClosed: false,
      providerObservation: { code: 'provider_saturated' },
    })]),
    taskRecord('rework-task', [attempt('rework-a1', 'rework', {
      taskId: 'rework-task',
      providerObservation: { code: 'provider_rate_limited' },
    })]),
  ]));
  const herdr = herdrFake({
    'session-run-sat': { result: { snapshot: { agents: [{ name: 'worker-blocked-a1', pane_id: 'pane-blocked-a1', terminal_id: 'term-blocked-a1', agent: 'claude', agent_status: 'blocked', interactive_ready: false }] } } },
  });
  const snapshot = await new MonitorCollector({ root: state, project, codex: codexFake(), claude: claudeFake(), herdr }).snapshot();
  const blocked = snapshot.nodes.find(node => node.taskId === 'blocked-task');
  assert.equal(blocked.status, 'waiting');
  assert.equal(blocked.statusLabel, 'Provider saturated · not a CAO retry · needs_input · blocked');
  const rework = snapshot.nodes.find(node => node.taskId === 'rework-task');
  assert.equal(rework.status, 'waiting');
  assert.equal(rework.statusLabel, 'Provider saturated · not a CAO retry · rework');
});

test('collector marks active CAO attempts unknown on terminal identity mismatch and never treats idle as accepted', async t => {
  const state = await root(t);
  const project = path.join(state, 'project');
  await saveRun(state, runRecord('run-live', project, [
    taskRecord('live-task', [attempt('live-a1', 'running', { taskId: 'live-task', agent: 'claude', workerClosed: false })]),
  ]));
  const herdr = herdrFake({
    'session-run-live': { result: { snapshot: { agents: [{ name: 'worker-live-a1', pane_id: 'pane-live-a1', terminal_id: 'different-terminal', agent: 'claude', agent_status: 'idle', interactive_ready: true }] } } },
  });
  const snapshot = await new MonitorCollector({ root: state, project, codex: codexFake(), claude: claudeFake(), herdr }).snapshot();

  const node = snapshot.nodes.find(item => item.taskId === 'live-task');
  assert.equal(node.status, 'unknown');
  assert.equal(node.statusLabel, 'Runtime unavailable');
  assert.equal(node.stale, true);
  assert.equal(node.delivery, null);
});

test('collector handles damaged CAO records and missing native sources without leaking exception text', async t => {
  const state = await root(t);
  await fs.mkdir(path.join(state, 'runs', 'bad-run'), { recursive: true });
  await fs.writeFile(path.join(state, 'runs', 'bad-run', 'run.json'), '{ bad json with CANARY_SECRET');
  const snapshot = await new MonitorCollector({ root: state, all: true, codex: codexFake({ throw: true }), claude: claudeFake({ throw: true }), herdr: herdrFake() }).snapshot();

  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /CANARY_SECRET|CODEX_CANARY_SECRET|CLAUDE_CANARY_SECRET/);
  assert.equal(snapshot.sources.find(source => source.id === 'cao').status, 'partial');
  assert.equal(snapshot.sources.find(source => source.id === 'codex').status, 'unavailable');
  assert.equal(snapshot.sources.find(source => source.id === 'claude').status, 'unavailable');
});

test('collector skips malformed task records gracefully', async t => {
  const state = await root(t);
  const project = path.join(state, 'project');
  await saveRun(state, {
    schemaVersion: 1,
    id: 'run-mixed',
    project,
    updatedAt: '2026-01-01T00:00:00.000Z',
    herdrSession: 'session-run-mixed',
    tasks: {
      bad: { definition: {}, attempts: 'not-array' },
      good: taskRecord('good', [attempt('good-a1', 'accepted', { taskId: 'good' })]),
    },
  });
  const snapshot = await new MonitorCollector({ root: state, project, codex: codexFake(), claude: claudeFake(), herdr: herdrFake() }).snapshot();
  assert.ok(snapshot.nodes.some(node => node.taskId === 'good'));
  assert.ok(!snapshot.nodes.some(node => node.taskId === 'bad'));
});

test('project scope prunes explicit foreign children from the current coordinator before projectId remapping', async t => {
  const state = await root(t);
  const project = path.join(state, 'project-a');
  const foreign = path.join(state, 'project-b');
  await saveRun(state, runRecord('run-a', project, [
    taskRecord('task-a', [attempt('task-a-a1', 'accepted', { taskId: 'task-a' })]),
  ], { coordinatorThreadId: 'trusted-coord' }));
  const codex = codexFake({ nodes: [
    { id: 'codex:current-root', agent: 'codex', kind: 'coordinator', label: 'current', projectId: project, status: 'unknown', source: 'codex', relation: 'native' },
    { id: 'codex:foreign-child', parentId: 'codex:current-root', agent: 'codex', kind: 'subagent', label: 'foreign', projectId: foreign, status: 'running', source: 'codex', relation: 'native' },
    { id: 'codex:unknown-child', parentId: 'codex:current-root', agent: 'codex', kind: 'subagent', label: 'unknown', status: 'running', source: 'codex', relation: 'native' },
  ] });
  const snapshot = await new MonitorCollector({ root: state, project, coordinatorId: 'current-root', codex, claude: claudeFake(), herdr: herdrFake() }).snapshot();

  assert.ok(snapshot.nodes.some(node => node.id === 'codex:current-root'));
  assert.ok(snapshot.nodes.some(node => node.id === 'codex:unknown-child' && node.parentId === 'codex:current-root'));
  assert.ok(!snapshot.nodes.some(node => node.id === 'codex:foreign-child'));
  assert.ok(!snapshot.projects.some(item => item.id === foreign));
  assert.ok(snapshot.nodes.every(node => !node.projectId || node.projectId === project));
});

test('project scope preserves trusted CAO coordinator cross-worktree children and remaps them after pruning', async t => {
  const state = await root(t);
  const project = path.join(state, 'project-a');
  const worktree = path.join(state, 'cao-worktree-outside-project');
  await saveRun(state, runRecord('run-a', project, [
    taskRecord('task-a', [attempt('task-a-a1', 'accepted', { taskId: 'task-a', cwd: worktree })]),
  ], { coordinatorThreadId: 'trusted-coord' }));
  const codex = codexFake({ nodes: [
    { id: 'codex:trusted-child', parentId: 'codex:trusted-coord', agent: 'codex', kind: 'subagent', label: 'trusted child', projectId: worktree, status: 'running', source: 'codex', relation: 'native' },
  ] });
  const snapshot = await new MonitorCollector({ root: state, project, coordinatorId: 'current-root', codex, claude: claudeFake(), herdr: herdrFake() }).snapshot();

  const child = snapshot.nodes.find(node => node.id === 'codex:trusted-child');
  assert.ok(child);
  assert.equal(child.parentId, 'codex:trusted-coord');
  assert.equal(child.projectId, project);
  assert.ok(snapshot.nodes.some(node => node.id === 'codex:trusted-coord'));
  assert.ok(!snapshot.projects.some(item => item.id === worktree));
});

test('project scope keeps necessary unknown ancestor context for matching native descendants', async t => {
  const state = await root(t);
  const project = path.join(state, 'project-a');
  await saveRun(state, runRecord('run-a', project, [
    taskRecord('task-a', [attempt('task-a-a1', 'accepted', { taskId: 'task-a' })]),
  ]));
  const codex = codexFake({ nodes: [
    { id: 'codex:context-parent', parentId: 'codex:current-root', agent: 'codex', kind: 'subagent', label: 'context', status: 'unknown', source: 'codex', relation: 'native' },
    { id: 'codex:matching-grandchild', parentId: 'codex:context-parent', agent: 'codex', kind: 'subagent', label: 'match', projectId: project, status: 'running', source: 'codex', relation: 'native' },
  ] });
  const snapshot = await new MonitorCollector({ root: state, project, coordinatorId: 'current-root', codex, claude: claudeFake(), herdr: herdrFake() }).snapshot();

  assert.ok(snapshot.nodes.some(node => node.id === 'codex:current-root'));
  assert.ok(snapshot.nodes.some(node => node.id === 'codex:context-parent' && node.parentId === 'codex:current-root'));
  assert.ok(snapshot.nodes.some(node => node.id === 'codex:matching-grandchild' && node.parentId === 'codex:context-parent'));
});

test('project scope prunes unlinked Claude fallback outside selected project or attempt cwd', async t => {
  const state = await root(t);
  const project = path.join(state, 'project-a');
  const selectedCwd = path.join(state, 'selected-worktree');
  const foreign = path.join(state, 'project-b');
  await saveRun(state, runRecord('run-a', project, [
    taskRecord('task-a', [attempt('task-a-a1', 'accepted', { taskId: 'task-a', cwd: selectedCwd })]),
  ]));
  const claude = claudeFake({ nodes: [
    { id: 'claude:known-local', agent: 'claude', kind: 'agent', label: 'known', projectId: selectedCwd, status: 'unknown', source: 'claude-local', relation: 'unlinked' },
    { id: 'claude:foreign-local', agent: 'claude', kind: 'agent', label: 'foreign', projectId: foreign, status: 'unknown', source: 'claude-local', relation: 'unlinked' },
  ] });
  const snapshot = await new MonitorCollector({ root: state, project, codex: codexFake(), claude, herdr: herdrFake() }).snapshot();

  const known = snapshot.nodes.find(node => node.id === 'claude:known-local');
  assert.ok(known);
  assert.equal(known.projectId, project);
  assert.ok(!snapshot.nodes.some(node => node.id === 'claude:foreign-local'));
  assert.ok(!snapshot.projects.some(item => item.id === selectedCwd || item.id === foreign));
});

test('only an explicitly linked coordinator includes an older cross-directory native tree', async t => {
  const state = await root(t);
  const project = path.join(state, 'project');
  const otherCwd = path.join(state, 'conversation-directory');
  const native = codexFake({ nodes: [
    { id: 'codex:child', parentId: 'codex:caller', agent: 'codex', kind: 'subagent', projectId: otherCwd, source: 'codex', label: 'child', status: 'running' },
    { id: 'codex:grandchild', parentId: 'codex:child', agent: 'codex', kind: 'subagent', projectId: otherCwd, source: 'codex', label: 'grandchild', status: 'running' },
  ] });
  const options = { root: state, project, coordinatorId: 'caller', codex: native, claude: claudeFake(), herdr: herdrFake() };
  const implicit = await new MonitorCollector(options).snapshot();
  assert.ok(!implicit.nodes.some(n => n.id === 'codex:child'));
  const explicit = await new MonitorCollector({ ...options, coordinatorExplicit: true }).snapshot();
  assert.ok(explicit.nodes.some(n => n.id === 'codex:child'));
  assert.ok(explicit.nodes.some(n => n.id === 'codex:grandchild' && n.parentId === 'codex:child'));
});

test('project scope retains native children bound to a CAO attempt without a cwd', async t => {
  const state = await root(t);
  const project = path.join(state, 'project');
  await saveRun(state, runRecord('run-a', project, [taskRecord('task-a', [attempt('a1', 'accepted', { taskId: 'task-a' })])]));
  const snapshot = await new MonitorCollector({ root: state, project, codex: codexFake(), herdr: herdrFake(), claude: claudeFake({ nodes: [
    { id: 'claude:child', parentId: 'cao:run-a:task-a:a1', agent: 'claude', kind: 'subagent', projectId: null, source: 'claude-hooks', status: 'completed' },
  ] }) }).snapshot();
  assert.ok(snapshot.nodes.some(n => n.id === 'claude:child' && n.parentId === 'cao:run-a:task-a:a1'));
});

test('machine scope does not restrict Codex discovery to the calling coordinator', async t => {
  const state = await root(t);
  const codex = codexFake();
  await new MonitorCollector({ root: state, all: true, coordinatorId: 'caller', codex, claude: claudeFake(), herdr: herdrFake() }).snapshot();
  assert.equal(codex.calls[0].all, true);
  assert.deepEqual(codex.calls[0].rootIds, []);
  assert.equal(codex.calls[0].project, null);
});

test('run view keeps coordinator ancestors for conversation grouping without adding their unrelated siblings', async t => {
  const state = await root(t);
  const project = path.join(state, 'project');
  await saveRun(state, runRecord('run-a', project, [taskRecord('task-a', [attempt('a1', 'accepted')])], {coordinatorThreadId:'child'}));
  const codex = codexFake({nodes:[
    {id:'codex:top',nativeSessionId:'top',parentId:null,agent:'codex',kind:'coordinator',relation:'native',source:'codex',status:'idle',confidence:'observed',conversationTitle:'Conversation',projectId:'/other-cwd'},
    {id:'codex:child',nativeSessionId:'child',parentId:'codex:top',agent:'codex',kind:'subagent',relation:'native',source:'codex',status:'completed',projectId:'/other-cwd'},
    {id:'codex:sibling',nativeSessionId:'sibling',parentId:'codex:top',agent:'codex',kind:'subagent',relation:'native',source:'codex',status:'running',projectId:'/unrelated'},
  ]});
  const snapshot = await new MonitorCollector({root:state,project,runId:'run-a',codex,claude:claudeFake(),herdr:herdrFake()}).snapshot();
  assert.ok(snapshot.nodes.some(n=>n.id==='codex:top'));
  assert.ok(!snapshot.nodes.some(n=>n.id==='codex:sibling'));
  assert.equal(snapshot.nodes.find(n=>n.id==='cao:run-a:task-a:a1').conversationId,'top');
  assert.equal(snapshot.conversations[0].id,'top');
});
