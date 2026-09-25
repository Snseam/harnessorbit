import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunApi } from '../src/run-api.mjs';
import * as state from '../src/state.mjs';

test('RunApi reads authoritative run.json and bounded events without exposing raw files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-run-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await state.createRun(root, { schemaVersion: 1, id: 'run1', project: '/tmp/project', tasks: {
    task1: { currentAttempt: 'a1', attempts: [{ id: 'a1', status: 'accepted' }] },
  } });
  await state.appendEvent(root, 'run1', { type: 'attempt.state', runId: 'run1', taskId: 'task1', attemptId: 'a1', from: 'running', to: 'accepted' });
  const api = new RunApi({ root });
  const status = await api.status('run1');
  assert.equal(status.authoritativeState, 'run.json');
  assert.equal(status.counts.accepted, 1);
  const events = await api.events('run1');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'attempt.state');
});

test('RunApi projects event fields and rejects malformed rows', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-run-api-events-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await state.createRun(root, { schemaVersion: 1, id: 'run1', project: '/tmp/project', tasks: {} });
  await state.appendEvent(root, 'run1', {
    type: 'worker.input', taskId: 'task1', attemptId: 'a1', inputKind: 'text',
    prompt: 'do not expose this', token: 'do not expose this',
  });
  const api = new RunApi({ root });
  const [event] = await api.events('run1');
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.runId, 'run1');
  assert.equal(event.inputKind, 'text');
  assert.equal(event.prompt, undefined);
  assert.equal(event.token, undefined);
  const persisted = await fs.readFile(path.join(root, 'runs', 'run1', 'events.jsonl'), 'utf8');
  assert.equal(persisted.includes('do not expose this'), false);

  await fs.appendFile(path.join(root, 'runs', 'run1', 'events.jsonl'), '{malformed\n');
  await assert.rejects(api.events('run1'), error => error.code === 'run_events_malformed' && error.details.line === 2);
});
