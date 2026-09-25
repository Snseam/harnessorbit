import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { contextDigest, createContextPacket } from '../src/context-packet.mjs';
import { buildWorkflowGraph, createReleaseReadinessPlan, evaluateReleaseReadiness, WorkflowRegistry } from '../src/workflows.mjs';

function run(status = 'integrated') {
  return {
    id: 'run1', project: '/tmp/project', tasks: {
      task1: {
        definition: { id: 'task1' }, currentAttempt: 'a1', attempts: [{
          id: 'a1', status, verification: { passed: true, checks: [{ name: 'unit', status: 'passed' }] },
          integration: status === 'integrated' ? { passed: true } : null,
        }],
      },
    },
  };
}

function contextPacket() {
  const packet = {
    schemaVersion: 1,
    packetId: 'packet-1',
    project: { root: '/tmp/project', head: 'head', dirty: false },
    baseline: { snapshotDigest: 'a'.repeat(64), fileCount: 0 },
    files: {},
    provenance: [],
    packetDigest: null,
  };
  packet.packetDigest = contextDigest(packet);
  return packet;
}

test('release-readiness builds task graph from attempt verification and integration evidence', () => {
  const plan = createReleaseReadinessPlan();
  const context = contextPacket();
  const graph = buildWorkflowGraph({ run: run(), plan, contextPacket: context });
  assert.equal(graph.gates.projectAcceptance, 'accepted');
  assert.equal(graph.gates.readiness, 'ready');
  assert.equal(graph.nodes.find(node => node.kind === 'task').integrated, true);
  const report = evaluateReleaseReadiness({ run: run(), plan, contextPacket: context });
  assert.equal(report.projectAcceptance, 'accepted');
  assert.match(report.reportDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.evidence.references.at(-1).kind, 'outcome');
  assert.ok(report.taskGraph.nodes.find(node => node.kind === 'task').references.some(reference => reference.kind === 'verification'));
});

test('generated ContextPacket is accepted by workflow validation', async t => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-workflow-project-'));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', project]);
  execFileSync('git', ['-C', project, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', project, 'config', 'user.name', 'CAO Test']);
  await fs.writeFile(path.join(project, 'README.md'), '# workflow fixture\n');
  execFileSync('git', ['-C', project, 'add', '.']);
  execFileSync('git', ['-C', project, 'commit', '-qm', 'fixture']);
  const generated = createContextPacket({ project, runId: 'run-generated', now: () => '2026-09-24T00:00:00.000Z' });
  assert.equal(generated.packetDigest, contextDigest(generated));
  const report = evaluateReleaseReadiness({ run: { ...run(), id: 'run-generated', project: await fs.realpath(project) }, contextPacket: generated });
  assert.equal(report.taskGraph.gates.contextObserved, true);
  assert.equal(report.projectAcceptance, 'accepted');
});

test('release-readiness keeps missing or failed evidence unknown/blocked', () => {
  const blocked = evaluateReleaseReadiness({ run: run('rework'), contextPacket: contextPacket() });
  assert.equal(blocked.projectAcceptance, 'unknown');
  assert.equal(blocked.taskGraph.gates.readiness, 'blocked');
  assert.equal(blocked.taskGraph.blockers[0].reason, 'task_rework');
  const noTasks = evaluateReleaseReadiness({ run: { id: 'empty', project: '/tmp', tasks: {} } });
  assert.equal(noTasks.projectAcceptance, 'unknown');
  assert.equal(noTasks.taskGraph.gates.readiness, 'blocked');
});

test('workflow never claims observed context or readiness without a ContextPacket', () => {
  const graph = buildWorkflowGraph({ run: run() });
  assert.equal(graph.nodes[0].status, 'unknown');
  assert.equal(graph.gates.contextObserved, false);
  assert.equal(graph.gates.projectAcceptance, 'unknown');
  assert.equal(graph.gates.readiness, 'blocked');
  assert.equal(graph.blockers[0].reason, 'context_packet_missing');
  const report = evaluateReleaseReadiness({ run: run() });
  assert.equal(report.evidence.contextDigest, null);
});

test('workflow registry exposes only deterministic release-readiness evaluator', () => {
  const registry = new WorkflowRegistry();
  assert.deepEqual(registry.list(), [{ id: 'release-readiness' }]);
  assert.equal(registry.get('missing'), null);
  assert.equal(registry.evaluate('release-readiness', { run: run(), contextPacket: contextPacket() }).projectAcceptance, 'accepted');
});

test('release-readiness does not substitute the last attempt for an invalid current pointer', () => {
  const invalid = run();
  invalid.tasks.task1.currentAttempt = 'missing';
  const report = evaluateReleaseReadiness({ run: invalid, contextPacket: contextPacket() });
  const node = report.taskGraph.nodes.find(item => item.kind === 'task');
  assert.equal(node.status, 'unknown');
  assert.equal(node.blocker, 'invalid_current_attempt');
  assert.equal(report.projectAcceptance, 'unknown');
});
