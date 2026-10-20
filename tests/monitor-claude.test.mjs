import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { prepareClaudeTelemetry, collectClaude } from '../src/monitor/claude.mjs';
import { sanitizeHookInput } from '../src/monitor/claude-hook.mjs';

async function tmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-claude-monitor-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function taskRecord(id = 'task-one') {
  return { id, definition: { id } };
}

function attemptRecord(extra = {}) {
  return { id: 'attempt-one', taskId: 'task-one', workerName: 'worker-one', createdAt: '2026-09-15T00:00:00.000Z', ...extra };
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function appendEvents(file, events) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, events.map(event => JSON.stringify(event)).join('\n') + '\n');
}

function claudeProjectSlug(value) {
  return path.resolve(value).replace(/[^A-Za-z0-9]/g, '-');
}

async function writeClaudeJsonl({ home, cwd, sessionId, agentId = null, records }) {
  const root = path.join(home, 'projects', claudeProjectSlug(cwd));
  const file = agentId
    ? path.join(root, sessionId, 'subagents', `agent-${agentId}.jsonl`)
    : path.join(root, `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  return file;
}

function assistantUsage(id, usage, extra = {}) {
  return {
    type: 'assistant',
    uuid: `${id}-uuid-${Math.random().toString(16).slice(2)}`,
    message: { id, usage, content: [{ type: 'text', text: 'SECRET CONTENT MUST NOT LEAK' }], model: 'synthetic' },
    ...extra,
  };
}

test('prepareClaudeTelemetry privately merges existing settings and preserves original file', async t => {
  const root = await tmp(t);
  const original = path.join(root, 'user-settings.json');
  const before = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo', args: ['ok'] }] }] }, permissions: { allow: ['Bash(ls)'] } };
  await fs.writeFile(original, JSON.stringify(before), { mode: 0o600 });

  const result = await prepareClaudeTelemetry({
    root,
    runId: 'run-one',
    task: taskRecord(),
    attempt: attemptRecord({ cwd: root }),
    launch: { kind: 'claude', args: ['--model', 'sonnet', '--settings', original] },
  });

  assert.equal(result.manifest.enabled, true);
  assert.equal(result.launch.kind, 'claude');
  assert.notEqual(result.launch.args[result.launch.args.indexOf('--settings') + 1], original);
  assert.equal(JSON.stringify(await readJson(original)), JSON.stringify(before));
  assert.ok(result.launch.args.includes('--session-id'));
  assert.ok(result.launch.args.includes(result.manifest.nativeSessionId));
  assert.match(result.manifest.nativeSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(result.manifest.files.length, 2);

  const merged = await readJson(result.manifest.settingsFile);
  assert.deepEqual(merged.permissions, before.permissions);
  assert.equal(merged.hooks.Stop.length, 2);
  assert.ok(merged.hooks.SubagentStart[0].hooks[0].args.includes(result.manifest.eventsFile));
});

test('prepareClaudeTelemetry keeps existing session id and disables when hooks cannot be safely used', async t => {
  const root = await tmp(t);
  const withSession = await prepareClaudeTelemetry({
    root,
    runId: 'run-one',
    task: taskRecord(),
    attempt: attemptRecord(),
    launch: { kind: 'claude', args: ['--session-id', 'native-existing'] },
  });
  assert.equal(withSession.manifest.nativeSessionId, 'native-existing');
  assert.equal(withSession.launch.args.filter(arg => arg === '--session-id').length, 1);

  const bare = await prepareClaudeTelemetry({
    root,
    runId: 'run-one',
    task: taskRecord(),
    attempt: attemptRecord(),
    launch: { kind: 'claude', args: ['--bare'] },
  });
  assert.equal(bare.manifest.enabled, false);
  assert.equal(bare.manifest.reason, 'claude_bare_disables_hooks');
  assert.deepEqual(bare.launch.args, ['--bare']);

  const disabled = await prepareClaudeTelemetry({
    root,
    runId: 'run-one',
    task: taskRecord(),
    attempt: attemptRecord(),
    launch: { kind: 'claude', args: ['--settings', '{"disableAllHooks":true}'] },
  });
  assert.equal(disabled.manifest.enabled, false);
  assert.equal(disabled.manifest.reason, 'settings_disable_all_hooks');
});

test('hook sanitizer and CLI persist metadata only', async t => {
  const root = await tmp(t);
  const eventsFile = path.join(root, 'events.ndjson');
  const raw = {
    hook_event_name: 'PermissionRequest',
    session_id: 'native-one',
    prompt: 'secret prompt',
    message: { content: 'assistant text' },
    tool_name: 'Bash',
    tool_input: { command: 'cat ~/.token' },
    error_details: 'secret error detail',
  };
  const sanitized = sanitizeHookInput(raw, { runId: 'run-one', taskId: 'task-one', attemptId: 'attempt-one', nativeSessionId: 'native-one' }, '2026-09-15T00:00:00.000Z');
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes('secret prompt'), false);
  assert.equal(serialized.includes('cat ~/.token'), false);
  assert.equal(sanitized.agent.toolName, 'Bash');
  assert.equal(sanitized.privacy.toolInputStored, false);

  const cli = spawnSync(process.execPath, [
    'src/monitor/claude-hook.mjs',
    '--out', eventsFile,
    '--run-id', 'run-one',
    '--task-id', 'task-one',
    '--attempt-id', 'attempt-one',
    '--native-session-id', 'native-one',
  ], { input: JSON.stringify(raw), cwd: path.resolve('.'), encoding: 'utf8' });
  assert.equal(cli.status, 0);
  assert.equal(cli.stderr, '');
  const line = await fs.readFile(eventsFile, 'utf8');
  assert.equal(line.includes('secret prompt'), false);
  assert.equal(line.includes('cat ~/.token'), false);
  assert.match(line, /PermissionRequest/);
});

test('hook CLI entrypoint runs from paths with spaces and non-ASCII characters', async t => {
  const root = await tmp(t);
  const spaced = path.join(root, 'hook dir 中文');
  await fs.mkdir(spaced, { recursive: true });
  const script = path.join(spaced, 'claude hook 中文.mjs');
  await fs.copyFile(path.resolve('src/monitor/claude-hook.mjs'), script);
  const eventsFile = path.join(root, 'events.ndjson');

  const cli = spawnSync(process.execPath, [
    script,
    '--out', eventsFile,
    '--run-id', 'run-one',
    '--task-id', 'task-one',
    '--attempt-id', 'attempt-one',
  ], { input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'native spaced' }), encoding: 'utf8' });

  assert.equal(cli.status, 0);
  assert.equal(cli.stderr, '');
  const record = JSON.parse((await fs.readFile(eventsFile, 'utf8')).trim());
  assert.equal(record.hookEventName, 'SessionStart');
  assert.equal(record.claude.sessionId, 'native spaced');
});

test('collectClaude builds managed parent and subagent state without marking parent completion as CAO delivery', async t => {
  const root = await tmp(t);
  const prepared = await prepareClaudeTelemetry({
    root,
    runId: 'run-one',
    task: taskRecord(),
    attempt: attemptRecord(),
    launch: { kind: 'claude', args: ['--session-id', 'native-one'] },
  });
  await appendEvents(prepared.manifest.eventsFile, [
    { schemaVersion: 1, observedAt: '2026-09-15T00:00:00.000Z', hookEventName: 'UserPromptSubmit', claude: { nativeSessionId: 'native-one' }, agent: { role: 'parent', status: 'running' } },
    { schemaVersion: 1, observedAt: '2026-09-15T00:00:01.000Z', hookEventName: 'SubagentStart', claude: { nativeSessionId: 'native-one' }, agent: { role: 'subagent', agentId: 'child-one', agentType: 'Explore', status: 'running' } },
    { schemaVersion: 1, observedAt: '2026-09-15T00:00:02.000Z', hookEventName: 'SubagentStop', claude: { nativeSessionId: 'native-one' }, agent: { role: 'subagent', agentId: 'child-one', agentType: 'Explore', status: 'completed' } },
    { schemaVersion: 1, observedAt: '2026-09-15T00:00:03.000Z', hookEventName: 'Stop', claude: { nativeSessionId: 'native-one' }, agent: { role: 'parent', status: 'idle' } },
  ]);
  const run = { id: 'run-one', tasks: { 'task-one': { definition: { id: 'task-one' }, currentAttempt: 'attempt-one', attempts: [{ ...attemptRecord(), telemetry: prepared.manifest }] } } };

  const result = await collectClaude({ root, runs: [run], now: Date.parse('2026-09-15T00:00:04.000Z') });
  assert.equal(result.health.status, 'connected');
  assert.equal(result.parents.length, 1);
  assert.equal(result.parents[0].status, 'idle');
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].id, 'claude:native-one:child-one');
  assert.equal(result.nodes[0].parentId, 'cao:run-one:task-one:attempt-one');
  assert.equal(result.nodes[0].status, 'completed');
  assert.equal(result.nodes[0].delivery, null);
  assert.equal(result.nodes[0].source, 'claude-hooks');
  assert.equal(result.nodes[0].confidence, 'live');
});

test('collectClaude marks running hook children unknown when stale or parent closed', async t => {
  const root = await tmp(t);
  const prepared = await prepareClaudeTelemetry({
    root,
    runId: 'run-one',
    task: taskRecord(),
    attempt: attemptRecord(),
    launch: { kind: 'claude', args: ['--session-id', 'native-one'] },
  });
  await appendEvents(prepared.manifest.eventsFile, [
    { observedAt: '2026-09-15T00:00:00.000Z', hookEventName: 'UserPromptSubmit', agent: { role: 'parent' } },
    { observedAt: '2026-09-15T00:00:01.000Z', hookEventName: 'SubagentStart', agent: { role: 'subagent', agentId: 'child-one', agentType: 'Plan' } },
    { observedAt: '2026-09-15T00:00:02.000Z', hookEventName: 'SessionEnd', agent: { role: 'parent' } },
  ]);
  const run = { id: 'run-one', tasks: { 'task-one': { definition: { id: 'task-one' }, currentAttempt: 'attempt-one', attempts: [{ ...attemptRecord({ workerClosed: true }), telemetry: prepared.manifest }] } } };
  const result = await collectClaude({ root, runs: [run], now: Date.parse('2026-09-15T00:05:00.000Z') });
  assert.equal(result.nodes[0].status, 'unknown');
  assert.equal(result.nodes[0].stale, true);
  assert.equal(result.nodes[0].statusLabel, 'parent ended before subagent stop');
});


test('collectClaude defaults to current attempt and includes prior attempts only with all=true', async t => {
  const root = await tmp(t);
  const current = await prepareClaudeTelemetry({ root, runId: 'run-one', task: taskRecord(), attempt: attemptRecord({ id: 'attempt-current' }), launch: { kind: 'claude', args: ['--session-id', 'native-current'] } });
  const old = await prepareClaudeTelemetry({ root, runId: 'run-one', task: taskRecord(), attempt: attemptRecord({ id: 'attempt-old' }), launch: { kind: 'claude', args: ['--session-id', 'native-old'] } });
  await appendEvents(current.manifest.eventsFile, [{ observedAt: '2026-09-15T00:00:01.000Z', hookEventName: 'SubagentStart', agent: { role: 'subagent', agentId: 'current-child' } }]);
  await appendEvents(old.manifest.eventsFile, [{ observedAt: '2026-09-15T00:00:01.000Z', hookEventName: 'SubagentStart', agent: { role: 'subagent', agentId: 'old-child' } }]);
  const run = { id: 'run-one', tasks: { 'task-one': { definition: { id: 'task-one' }, currentAttempt: 'attempt-current', attempts: [
    { ...attemptRecord({ id: 'attempt-old' }), telemetry: old.manifest },
    { ...attemptRecord({ id: 'attempt-current' }), telemetry: current.manifest },
  ] } } };

  const scoped = await collectClaude({ root, runs: [run], now: Date.parse('2026-09-15T00:00:02.000Z') });
  assert.deepEqual(scoped.nodes.map(node => node.id), ['claude:native-current:current-child']);
  const isolatedHome = path.join(root, 'isolated-home');
  await fs.mkdir(isolatedHome, { recursive: true });
  const all = await collectClaude({ root, runs: [run], home: isolatedHome, all: true, now: Date.parse('2026-09-15T00:00:02.000Z') });
  assert.deepEqual(new Set(all.nodes.map(node => node.id)), new Set(['claude:native-current:current-child', 'claude:native-old:old-child']));
});


test('prepareClaudeTelemetry degrades without changing args for multiple settings and handles short resume flags', async t => {
  const root = await tmp(t);
  const multi = await prepareClaudeTelemetry({
    root,
    runId: 'run-one',
    task: taskRecord(),
    attempt: attemptRecord(),
    launch: { kind: 'claude', args: ['--settings', '{}', '--settings', '{}'] },
  });
  assert.equal(multi.manifest.enabled, false);
  assert.equal(multi.manifest.reason, 'settings_unmergeable');
  assert.deepEqual(multi.launch.args, ['--settings', '{}', '--settings', '{}']);

  const resume = await prepareClaudeTelemetry({
    root,
    runId: 'run-one',
    task: taskRecord(),
    attempt: attemptRecord({ id: 'attempt-resume' }),
    launch: { kind: 'claude', args: ['-r'] },
  });
  assert.equal(resume.manifest.enabled, true);
  assert.equal(resume.manifest.nativeSessionId, null);
  assert.equal(resume.launch.args.includes('--session-id'), false);

  const continueFlag = await prepareClaudeTelemetry({
    root,
    runId: 'run-one',
    task: taskRecord(),
    attempt: attemptRecord({ id: 'attempt-continue' }),
    launch: { kind: 'claude', args: ['-c'] },
  });
  assert.equal(continueFlag.manifest.enabled, true);
  assert.equal(continueFlag.manifest.nativeSessionId, null);
  assert.equal(continueFlag.launch.args.includes('--session-id'), false);
});

test('hook sanitizer drops unknown events and does not store arbitrary reason or error strings', () => {
  assert.equal(sanitizeHookInput({ hook_event_name: 'MadeUp', reason: 'leak me' }), null);
  const sanitized = sanitizeHookInput({
    hook_event_name: 'StopFailure',
    error: 'SECRET stack and token',
    error_details: 'SECRET details',
  }, {}, '2026-09-15T00:00:00.000Z');
  assert.equal(sanitized.agent.statusReason, 'StopFailure');
  assert.equal(JSON.stringify(sanitized).includes('SECRET'), false);
});


test('main-session agent_type alone is not treated as a subagent', () => {
  const sanitized = sanitizeHookInput({
    hook_event_name: 'Notification',
    session_id: 'native-one',
    agent_type: 'default-main-agent',
    notification_type: 'idle_prompt',
  }, {}, '2026-09-15T00:00:00.000Z');

  assert.equal(sanitized.agent.role, 'parent');
  assert.equal(sanitized.agent.agentType, 'default-main-agent');
});

test('child lifecycle events do not terminate parent and repeated SubagentStart resets episode timestamps', async t => {
  const root = await tmp(t);
  const prepared = await prepareClaudeTelemetry({
    root,
    runId: 'run-one',
    task: taskRecord(),
    attempt: attemptRecord(),
    launch: { kind: 'claude', args: ['--session-id', 'native-one'] },
  });
  await appendEvents(prepared.manifest.eventsFile, [
    { observedAt: '2026-09-15T00:00:00.000Z', hookEventName: 'UserPromptSubmit', agent: { role: 'parent' } },
    { observedAt: '2026-09-15T00:00:01.000Z', hookEventName: 'SubagentStart', agent: { role: 'subagent', agentId: 'child-one', agentType: 'Explore' } },
    { observedAt: '2026-09-15T00:00:02.000Z', hookEventName: 'SubagentStop', agent: { role: 'subagent', agentId: 'child-one', agentType: 'Explore' } },
    { observedAt: '2026-09-15T00:00:03.000Z', hookEventName: 'SubagentStart', agent: { role: 'subagent', agentId: 'child-one', agentType: 'Explore' } },
    { observedAt: '2026-09-15T00:00:04.000Z', hookEventName: 'StopFailure', agent: { role: 'subagent', agentId: 'child-one', agentType: 'Explore' } },
    { observedAt: '2026-09-15T00:00:05.000Z', hookEventName: 'SessionEnd', agent: { role: 'subagent', agentId: 'child-one', agentType: 'Explore' } },
  ]);
  const run = { id: 'run-one', tasks: { 'task-one': { definition: { id: 'task-one' }, currentAttempt: 'attempt-one', attempts: [{ ...attemptRecord(), telemetry: prepared.manifest }] } } };

  const result = await collectClaude({ root, runs: [run], now: Date.parse('2026-09-15T00:00:06.000Z') });
  assert.equal(result.parents[0].status, 'running');
  assert.equal(result.parents[0].finishedAt, null);
  assert.equal(result.nodes[0].status, 'failed');
  assert.equal(result.nodes[0].startedAt, '2026-09-15T00:00:03.000Z');
  assert.equal(result.nodes[0].finishedAt, '2026-09-15T00:00:04.000Z');
});

test('collectClaude updates managed native id from actual hook session and reports empty hooks as partial', async t => {
  const root = await tmp(t);
  const prepared = await prepareClaudeTelemetry({
    root,
    runId: 'run-one',
    task: taskRecord(),
    attempt: attemptRecord(),
    launch: { kind: 'claude', args: ['-r'] },
  });
  const emptyRun = { id: 'run-one', project: root, tasks: { 'task-one': { definition: { id: 'task-one' }, currentAttempt: 'attempt-one', attempts: [{ ...attemptRecord({ cwd: root }), telemetry: prepared.manifest }] } } };
  const empty = await collectClaude({ root, runs: [emptyRun], home: path.join(root, 'home'), now: Date.parse('2026-09-15T00:00:01.000Z') });
  assert.equal(empty.health.status, 'partial');
  assert.equal(empty.parents[0].confidence, 'unknown');

  await appendEvents(prepared.manifest.eventsFile, [
    { observedAt: '2026-09-15T00:00:02.000Z', hookEventName: 'SubagentStart', claude: { sessionId: 'actual-native' }, agent: { role: 'subagent', agentId: 'child-one' } },
  ]);
  const collected = await collectClaude({ root, runs: [emptyRun], home: path.join(root, 'home'), now: Date.parse('2026-09-15T00:00:03.000Z') });
  assert.equal(collected.parents[0].nativeSessionId, 'actual-native');
  assert.equal(collected.nodes[0].id, 'claude:actual-native:child-one');
  assert.equal(collected.nodes[0].projectId, root);
});

test('collectClaude project-scoped fallback requires bounded cwd match and works without all=true', async t => {
  const root = await tmp(t);
  const home = path.join(root, 'claude-home');
  const project = path.join(root, 'project_测试.v1');
  const sibling = path.join(root, 'project_测试.v1-sibling');
  const worktree = path.join(root, 'state_worktree');
  const projectDir = path.join(home, 'projects', claudeProjectSlug(project));
  const worktreeDir = path.join(home, 'projects', claudeProjectSlug(worktree));
  const unrelatedDir = path.join(home, 'projects', 'p');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(worktreeDir, { recursive: true });
  await fs.mkdir(unrelatedDir, { recursive: true });
  await fs.mkdir(path.join(project, 'sub'), { recursive: true });
  await fs.mkdir(sibling, { recursive: true });
  await fs.mkdir(worktree, { recursive: true });
  await fs.writeFile(path.join(projectDir, 'in.jsonl'), JSON.stringify({ timestamp: '2026-09-15T00:00:00.000Z', sessionId: 'inside', cwd: path.join(project, 'sub') }) + '\n');
  await fs.writeFile(path.join(projectDir, 'out.jsonl'), JSON.stringify({ timestamp: '2026-09-15T00:00:00.000Z', sessionId: 'outside', cwd: sibling }) + '\n');
  await fs.writeFile(path.join(worktreeDir, 'worktree.jsonl'), JSON.stringify({ timestamp: '2026-09-15T00:00:00.000Z', sessionId: 'worktree', cwd: worktree }) + '\n');
  await fs.writeFile(path.join(projectDir, 'nocwd.jsonl'), JSON.stringify({ timestamp: '2026-09-15T00:00:00.000Z', sessionId: 'nocwd' }) + '\n');
  await fs.writeFile(path.join(unrelatedDir, 'unscanned.jsonl'), JSON.stringify({ timestamp: '2026-09-15T00:00:00.000Z', sessionId: 'unscanned', cwd: project }) + '\n');

  const scopedRun = { id: 'run-one', project, tasks: { 'task-one': { definition: { id: 'task-one' }, currentAttempt: 'attempt-one', attempts: [{ ...attemptRecord({ cwd: worktree }) }] } } };
  const result = await collectClaude({ root, runs: [scopedRun], home, project, now: Date.parse('2026-09-15T00:00:10.000Z') });
  assert.deepEqual(new Set(result.nodes.map(node => node.nativeSessionId)), new Set(['inside', 'worktree']));
  assert.ok(result.nodes.some(node => node.projectId === path.join(project, 'sub')));
  assert.ok(result.nodes.some(node => node.projectId === worktree));
});


test('collectClaude attaches parent and child token usage from Claude JSONL without double counting or leaking content', async t => {
  const root = await tmp(t);
  const home = path.join(root, 'claude-home');
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd, { recursive: true });
  const prepared = await prepareClaudeTelemetry({
    root,
    runId: 'run-one',
    task: taskRecord(),
    attempt: attemptRecord({ cwd }),
    launch: { kind: 'claude', args: ['--session-id', 'native-one'] },
  });
  await appendEvents(prepared.manifest.eventsFile, [
    { observedAt: '2026-09-15T00:00:00.000Z', hookEventName: 'UserPromptSubmit', claude: { sessionId: 'native-one' }, agent: { role: 'parent' } },
    { observedAt: '2026-09-15T00:00:01.000Z', hookEventName: 'SubagentStart', claude: { sessionId: 'native-one' }, agent: { role: 'subagent', agentId: 'child-one', agentType: 'Explore' } },
    { observedAt: '2026-09-15T00:00:02.000Z', hookEventName: 'SubagentStop', claude: { sessionId: 'native-one' }, agent: { role: 'subagent', agentId: 'child-one', agentType: 'Explore' } },
  ]);
  await writeClaudeJsonl({ home, cwd, sessionId: 'native-one', records: [
    assistantUsage('same-id', { input_tokens: 1, output_tokens: 1 }),
    assistantUsage('same-id', { input_tokens: 10, output_tokens: 2 }),
    assistantUsage('same-id', { input_tokens: 5, output_tokens: 1 }),
    assistantUsage('second-id', { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, output_tokens_details: { thinking_tokens: 7 } }),
  ] });
  await writeClaudeJsonl({ home, cwd, sessionId: 'native-one', agentId: 'child-one', records: [
    assistantUsage('child-id', { input_tokens: 100, output_tokens: 11 }),
  ] });
  const run = { id: 'run-one', project: cwd, tasks: { 'task-one': { definition: { id: 'task-one' }, currentAttempt: 'attempt-one', attempts: [{ ...attemptRecord({ cwd }), telemetry: prepared.manifest }] } } };

  const result = await collectClaude({ root, runs: [run], home, now: Date.parse('2026-09-15T00:00:03.000Z') });
  assert.equal(result.parents[0].tokens, 29);
  assert.deepEqual(result.parents[0].tokenUsage, {
    total: 29, input: 15, output: 7, cacheRead: 3, cacheWrite: 4, reasoning: 7,
    scope: 'session', source: 'claude-jsonl', complete: true,
  });
  assert.equal(result.nodes[0].tokens, 111);
  assert.equal(result.nodes[0].tokenUsage.total, 111);
  assert.equal(JSON.stringify(result).includes('SECRET CONTENT MUST NOT LEAK'), false);
});


test('collectClaude usage treats reasoning as output detail, handles empty/corrupt usage, encoded cwd, and unsafe ids', async t => {
  const root = await tmp(t);
  const home = path.join(root, 'claude-home');
  const cwd = path.join(root, 'project with.dot_中文');
  await fs.mkdir(cwd, { recursive: true });
  const prepared = await prepareClaudeTelemetry({
    root,
    runId: 'run-one',
    task: taskRecord(),
    attempt: attemptRecord({ cwd }),
    launch: { kind: 'claude', args: ['--session-id', 'safe-session_1'] },
  });
  await appendEvents(prepared.manifest.eventsFile, [
    { observedAt: '2026-09-15T00:00:00.000Z', hookEventName: 'UserPromptSubmit', claude: { sessionId: 'safe-session_1' }, agent: { role: 'parent' } },
    { observedAt: '2026-09-15T00:00:01.000Z', hookEventName: 'SubagentStart', claude: { sessionId: 'safe-session_1' }, agent: { role: 'subagent', agentId: 'bad/../child' } },
  ]);
  const parentFile = await writeClaudeJsonl({ home, cwd, sessionId: 'safe-session_1', records: [
    assistantUsage('empty-usage', {}),
    assistantUsage('reasoning-child', { input_tokens: 2, output_tokens: 3, output_tokens_details: { thinking_tokens: 99 } }),
  ] });
  await fs.appendFile(parentFile, '{bad json}\n' + JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 9 } } }) + '\n');
  await writeClaudeJsonl({ home, cwd, sessionId: 'safe-session_1', agentId: 'bad/../child', records: [
    assistantUsage('unsafe-child', { input_tokens: 100, output_tokens: 1 }),
  ] }).catch(() => {});
  const run = { id: 'run-one', project: cwd, tasks: { 'task-one': { definition: { id: 'task-one' }, currentAttempt: 'attempt-one', attempts: [{ ...attemptRecord({ cwd }), telemetry: prepared.manifest }] } } };

  const result = await collectClaude({ root, runs: [run], home, now: Date.parse('2026-09-15T00:00:03.000Z') });
  assert.equal(result.parents[0].tokens, 5);
  assert.equal(result.parents[0].tokenUsage.reasoning, 99);
  assert.equal(result.parents[0].tokenUsage.complete, false);
  assert.equal(result.parents[0].tokenUsage.scope, 'observed');
  assert.equal(result.nodes[0].tokens, null);
  assert.equal(result.nodes[0].tokenUsage, null);
});

test('collectClaude reports null usage for missing transcripts and observed partial usage for capped transcripts', async t => {
  const root = await tmp(t);
  const home = path.join(root, 'claude-home');
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd, { recursive: true });
  const missing = await prepareClaudeTelemetry({
    root,
    runId: 'run-one',
    task: taskRecord(),
    attempt: attemptRecord({ id: 'attempt-missing', cwd }),
    launch: { kind: 'claude', args: ['--session-id', 'missing-session'] },
  });
  await appendEvents(missing.manifest.eventsFile, [
    { observedAt: '2026-09-15T00:00:00.000Z', hookEventName: 'UserPromptSubmit', claude: { sessionId: 'missing-session' }, agent: { role: 'parent' } },
  ]);
  const partial = await prepareClaudeTelemetry({
    root,
    runId: 'run-one',
    task: taskRecord(),
    attempt: attemptRecord({ id: 'attempt-partial', cwd }),
    launch: { kind: 'claude', args: ['--session-id', 'partial-session'] },
  });
  await appendEvents(partial.manifest.eventsFile, [
    { observedAt: '2026-09-15T00:00:00.000Z', hookEventName: 'UserPromptSubmit', claude: { sessionId: 'partial-session' }, agent: { role: 'parent' } },
  ]);
  const partialFile = await writeClaudeJsonl({ home, cwd, sessionId: 'partial-session', records: [assistantUsage('tail-id', { input_tokens: 21, output_tokens: 2 })] });
  await fs.writeFile(partialFile, `${'x'.repeat(2 * 1024 * 1024 + 10)}\n${JSON.stringify(assistantUsage('tail-id', { input_tokens: 21, output_tokens: 2 }))}\n`);
  const run = { id: 'run-one', project: cwd, tasks: { 'task-one': { definition: { id: 'task-one' }, currentAttempt: 'attempt-partial', attempts: [
    { ...attemptRecord({ id: 'attempt-missing', cwd }), telemetry: missing.manifest },
    { ...attemptRecord({ id: 'attempt-partial', cwd }), telemetry: partial.manifest },
  ] } } };

  const currentOnly = await collectClaude({ root, runs: [run], home, now: Date.parse('2026-09-15T00:00:03.000Z') });
  assert.equal(currentOnly.parents[0].tokens, 23);
  assert.equal(currentOnly.parents[0].tokenUsage.scope, 'observed');
  assert.equal(currentOnly.parents[0].tokenUsage.complete, false);

  const all = await collectClaude({ root, runs: [run], home, all: true, now: Date.parse('2026-09-15T00:00:03.000Z') });
  const missingParent = all.parents.find(parent => parent.attemptId === 'attempt-missing');
  assert.equal(missingParent.tokens, null);
  assert.equal(missingParent.tokenUsage, null);
});

test('collectClaude reads bounded local fallback without duplicating managed sessions', async t => {
  const root = await tmp(t);
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  await fs.mkdir(path.join(home, 'projects/p'), { recursive: true });
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(home, 'projects/p/local.jsonl'), JSON.stringify({
    timestamp: '2026-09-15T00:00:00.000Z',
    sessionId: 'local-one',
    cwd: project,
    isSidechain: true,
    type: 'user',
    parentUuid: 'parent-one',
    message: { content: 'must not appear' },
    toolUseResult: { output: 'must not appear' },
  }) + '\n');

  const result = await collectClaude({ root, runs: [], home, project, all: true, now: Date.parse('2026-09-15T00:00:10.000Z') });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].source, 'claude-local');
  assert.equal(result.nodes[0].relation, 'unlinked');
  assert.equal(result.nodes[0].status, 'unknown');
  assert.equal(result.nodes[0].role, null);
  assert.equal(JSON.stringify(result).includes('must not appear'), false);
});
