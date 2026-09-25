// Opt-in smoke: runs two real Claude Code sessions against a local mock Anthropic API.
// It uses only owned fixtures/state, confirms native trust prompts for that fixture,
// retains evidence under work/, and never changes global provider configuration.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Orchestrator } from '../src/orchestrator.mjs';
import { ProfileStore } from '../src/profiles.mjs';
import { prepareExecution } from '../src/execution-config.mjs';
import { Herdr } from '../src/runtime/herdr.mjs';
import { fixture, promptData, task } from '../tests/helpers.mjs';
import { createClaudeSmokeIsolation } from './helpers/claude-smoke-isolation.mjs';
import { classifyClaudeBlockedOutput } from '../src/blocked-output.mjs';

const PROFILE_IDS = ['alpha', 'beta'];
const CLAUDE_ARGS = [
  '--tools', 'Read,Write,Edit,Bash',
  '--allowedTools', 'Read,Write,Edit,Bash',
  '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}',
];

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function snapshotGlobalProviderConfigs() {
  const names = ['.claude/settings.json', '.codex/config.toml'];
  return Promise.all(names.map(async (name) => ({
    name,
    hash: await fs.readFile(path.join(process.env.HOME, name)).then(sha256).catch(() => null),
  })));
}

function textFromMessageContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function sendAnthropicMessage(res, model, content, stop = 'end_turn', stream = true) {
  const id = `msg_cao_${Date.now()}`;
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 50, output_tokens: 20 },
    }));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', {
    message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 0 } },
  });
  content.forEach((block, index) => {
    event('content_block_start', {
      index,
      content_block: block.type === 'text'
        ? { type: 'text', text: '' }
        : { type: 'tool_use', id: block.id, name: block.name, input: {} },
    });
    event('content_block_delta', {
      index,
      delta: block.type === 'text'
        ? { type: 'text_delta', text: block.text }
        : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
    });
    event('content_block_stop', { index });
  });
  event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  event('message_stop', {});
  res.end();
}

function toolSteps(dispatch) {
  return [
    ['Read', { file_path: path.join(path.dirname(dispatch.resultFile), 'prompt.txt') }],
    ['Read', { file_path: path.join(dispatch.cwd, 'src/math.mjs') }],
    ['Write', { file_path: path.join(dispatch.cwd, 'src/math.mjs'), content: 'export const add = (a, b) => a + b;\n' }],
    ['Bash', { command: `node --test '${dispatch.cwd}/tests/math.test.mjs'`, description: 'Run fixture arithmetic regression tests', timeout: 10000 }],
    ['Write', {
      file_path: dispatch.resultFile,
      content: JSON.stringify({
        taskId: dispatch.taskId,
        attemptId: dispatch.attemptId,
        nonce: dispatch.nonce,
        status: 'submitted',
        summary: 'Corrected fixture addition',
        changedFiles: ['src/math.mjs'],
        checks: [],
        children: [],
        unresolved: [],
      }, null, 2),
    }],
  ];
}

function createMockAnthropicServer({ evidence, received }) {
  return http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;

    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    if (req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"input_tokens":50}');
      return;
    }

    const routingMessage = (body.messages || [])
      .map(message => textFromMessageContent(message.content))
      .find(text => text.includes('Routing metadata:'));
    const dispatch = routingMessage ? promptData(routingMessage) : null;
    received.push({
      model: body.model,
      route: req.url,
      taskId: dispatch?.taskId || null,
      tools: (body.tools || []).map(tool => tool.name),
      authMatches: req.headers['x-api-key'] === `mock-${body.model}` || req.headers.authorization === `Bearer mock-${body.model}`,
    });
    await fs.writeFile(path.join(evidence, 'requests.json'), JSON.stringify(received, null, 2));

    if (!dispatch) {
      sendAnthropicMessage(res, body.model, [{ type: 'text', text: 'Ready' }], 'end_turn', body.stream);
      return;
    }

    const completed = new Set((body.messages || []).flatMap(message => (
      Array.isArray(message.content)
        ? message.content.filter(block => block.type === 'tool_result').map(block => block.tool_use_id)
        : []
    )));
    const steps = toolSteps(dispatch);
    const next = steps.findIndex((_, index) => !completed.has(`toolu_cao_${index}`));
    if (next >= 0) {
      const [name, input] = steps[next];
      sendAnthropicMessage(res, body.model, [{ type: 'tool_use', id: `toolu_cao_${next}`, name, input }], 'tool_use', body.stream);
    } else {
      sendAnthropicMessage(res, body.model, [{ type: 'text', text: `CAO_RESULT ${dispatch.attemptId}` }], 'end_turn', body.stream);
    }
  });
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(resolve));
}

async function findSessionFiles(root, sessionId, matches = []) {
  if (!sessionId) return matches;
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return matches;
    throw error;
  }
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await findSessionFiles(file, sessionId, matches);
    } else if (entry.isFile() && entry.name === `${sessionId}.jsonl`) matches.push(file);
  }
  return matches;
}

async function registerProfiles(store, endpoint) {
  for (const id of PROFILE_IDS) {
    const ref = await store.putSecret(id, `mock-${id}`);
    await store.put({
      id,
      agent: 'claude',
      model: id,
      protocol: 'anthropic',
      endpoint,
      credential: { type: 'stored', ref },
      account: { id, maxParallel: 1 },
    });
  }
}

function smokeTasks() {
  return PROFILE_IDS.map(id => task({
    id: `fix-${id}`,
    agent: 'auto',
    execution: { profile: id },
    agentArgs: CLAUDE_ARGS,
  }));
}

async function dispatchTasks(service, runId, inputs) {
  const launched = await Promise.all(inputs.map(input => service.dispatch(runId, input)));
  for (const item of launched) {
    console.log(JSON.stringify({ phase: 'dispatched', task: item.task.id, status: item.attempt.status, error: item.attempt.lastError?.code }));
    assert.notEqual(item.attempt.status, 'failed');
  }
  return launched;
}

async function nudgeIfTrustPrompt(service, runId, taskId, terminalText) {
  if (!classifyClaudeBlockedOutput(terminalText)) return;
  if (terminalText.includes('Welcome to Claude Code') && terminalText.includes('Security notes:') && terminalText.includes('Press Enter to continue')) {
    await service.input(runId, taskId, { keys: ['enter'] });
  }
  if (terminalText.includes('Yes, I trust this folder')) await service.input(runId, taskId, { keys: ['down', 'enter'] });
  if (terminalText.includes('Yes, I accept')) await service.input(runId, taskId, { keys: ['down', 'enter'] });
}

async function waitForSubmissions({ service, herdr, run, inputs, evidence }) {
  for (let count = 0; count < 60; count++) {
    let finished = true;
    for (const input of inputs) {
      const current = await service.inspect(run.id, input.id);
      if (['submitted', 'accepted'].includes(current.attempt.status)) continue;

      finished = false;
      const text = await herdr.readAgent(run.herdrSession, current.attempt.workerName, 40).catch(() => '');
      await fs.writeFile(path.join(evidence, `${input.id}-terminal.txt`), text);
      await nudgeIfTrustPrompt(service, run.id, input.id, text);
      if (!current.attempt.submissionStartedAt) await service.resume(run.id, input.id).catch(() => {});
      await service.collect(run.id, input.id).catch(() => {});
    }
    if (finished) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function verifyTasks(service, runId, inputs) {
  const verified = [];
  for (const input of inputs) {
    const result = await service.verify(runId, input.id);
    verified.push({
      taskId: input.id,
      status: result.attempt.status,
      profileId: result.attempt.execution.profileId,
      runtimeReleased: Boolean(result.attempt.runtimeReleasedAt),
    });
    assert.equal(result.attempt.status, 'accepted');
  }
  return verified;
}

async function cleanupOwnedRun(service, run, inputs) {
  if (!run?.id) return;
  for (const input of inputs) {
    await service.cancel(run.id, input.id).catch(() => {});
  }
  await service.cleanup(run.id).catch(error => {
    console.log(JSON.stringify({ cleanupError: error.code || error.name }));
  });
}

async function main() {
  const fixtureState = await fixture();
  const evidence = path.resolve(`work/profile-smoke-${Date.now()}`);
  await fs.mkdir(evidence, { recursive: true });
  const isolation = await createClaudeSmokeIsolation({ root: path.join(evidence, 'private-claude-runtime') });

  const before = await snapshotGlobalProviderConfigs();
  const received = [];
  const upstream = createMockAnthropicServer({ evidence, received });

  const store = new ProfileStore({ root: fixtureState.stateRoot });
  const herdr = new Herdr({ environment: isolation.environment, evidenceSource: 'mock' });
  const materialize = (input) => prepareExecution({ ...input, environment: isolation.environment });
  const service = new Orchestrator({ stateRoot: fixtureState.stateRoot, profiles: store, herdr, materialize });
  const inputs = smokeTasks();
  let run;

  try {
    await listen(upstream);
    run = await service.init({ project: fixtureState.project, maxParallel: 2 });
    await fs.writeFile(path.join(evidence, 'probe.json'), JSON.stringify({
      fixture: fixtureState.base,
      fixtureRetained: true,
      stateRoot: fixtureState.stateRoot,
      runId: run.id,
      session: run.herdrSession,
      evidence,
      claudeConfigDir: isolation.claudeConfigDir,
    }, null, 2));
    console.log(JSON.stringify({ phase: 'starting', evidence, runId: run.id, session: run.herdrSession }));

    await registerProfiles(store, `http://127.0.0.1:${upstream.address().port}`);
    await dispatchTasks(service, run.id, inputs);
    await waitForSubmissions({ service, herdr, run, inputs, evidence });
    const verified = await verifyTasks(service, run.id, inputs);

    assert.deepEqual(await snapshotGlobalProviderConfigs(), before);
    for (const id of PROFILE_IDS) {
      assert.ok(received.some(record => record.model === id && record.taskId === `fix-${id}` && record.authMatches));
    }
    assert.ok(received.every(record => record.authMatches));
    const sessionIsolation = [];
    const userConfigDirs = [...new Set([path.join(process.env.HOME, '.claude'), process.env.CLAUDE_CONFIG_DIR].filter(Boolean).map(p => path.resolve(p)))];
    for (const item of verified) {
      const inspected = await service.inspect(run.id, item.taskId);
      const nativeSessionId = inspected.attempt.nativeSession.id;
      const projectRoot = path.join(isolation.claudeConfigDir, 'projects');
      const privateMatches = await findSessionFiles(projectRoot, nativeSessionId);
      assert.ok(privateMatches.length > 0, `${item.taskId} should record native session ${nativeSessionId} under private Claude config`);
      const models = new Set();
      for (const file of privateMatches) {
        for (const line of (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean)) {
          const record = JSON.parse(line);
          if (record.message?.model) models.add(record.message.model);
        }
      }
      assert.ok(models.has(item.profileId), `${item.taskId} must persist its mock model in the private session`);
      for (const directory of userConfigDirs) {
        const userMatches = await findSessionFiles(path.join(directory, 'projects'), nativeSessionId);
        assert.equal(userMatches.length, 0, `${item.taskId} native session ${nativeSessionId} must not appear in user Claude projects`);
      }
      sessionIsolation.push({ taskId: item.taskId, nativeSessionId, models: [...models], privateSessionFiles: privateMatches.length, userSessionFiles: 0 });
    }

    const result = { passed: true, verified, requests: received.length, globalProviderConfigsUnchanged: true, sessionIsolation, claudeConfigDir: isolation.claudeConfigDir, evidence };
    await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    await cleanupOwnedRun(service, run, inputs);
    await closeServer(upstream);
  }
}

await main();
