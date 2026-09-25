import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../src/orchestrator.mjs';
import { ProjectLedger } from '../src/project-ledger.mjs';
import * as state from '../src/state.mjs';

test('ledger hook failure preserves authoritative run state and persists a bounded reason', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-ledger-hook-state-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'cao-ledger-hook-project-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  await state.createRun(root, { schemaVersion: 1, id: 'run1', project, tasks: {} });
  const ledger = new ProjectLedger({ root, project });
  const full = await ledger.load();
  full.entries = Array.from({ length: 256 }, (_, index) => ({
    id: `entry-${index}`,
    type: 'entry.observed',
    status: 'observed',
    summary: null,
    digest: null,
    metadata: null,
    references: [],
    createdAt: new Date(0).toISOString(),
  }));
  await fs.mkdir(path.dirname(ledger.file), { recursive: true });
  await fs.writeFile(ledger.file, `${JSON.stringify(full)}\n`, { mode: 0o600 });

  const orchestrator = new Orchestrator({ stateRoot: root });
  const run = await state.loadRun(root, 'run1');
  await orchestrator._recordLedgerEvidence(run, { type: 'verification', status: 'passed', runId: 'run1' });

  const persisted = await state.loadRun(root, 'run1');
  assert.equal(persisted.ledgerEvidenceIncomplete, true);
  assert.equal(persisted.ledgerEvidenceIncompleteReason, 'ledger_full');
  assert.deepEqual(persisted.tasks, {});
});
