import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Orchestrator } from '../src/orchestrator.mjs';
import { PrincipalStore } from '../src/access/principals.mjs';
import { AccessService } from '../src/access/service.mjs';
import { SessionStore } from '../src/access/sessions.mjs';
import { MemoryService, MemyHandoffCliProvider, MAX_ITEM_CHARS, clipScalars, scalarCount, excerptMetadata } from '../src/access/memory.mjs';
import { fixture, FakeHerdr } from './helpers.mjs';

// Fixture evidence for the recall excerpt contract (memy-recall-identity-excerpt-decision.md):
// Memy's additive per-item fields `truncated` and `original_chars` (Unicode scalars after
// redaction, before the 1200 cap) pass through as truncated / originalChars; missing or malformed
// metadata is unknown (null), never a completeness claim; Orbit's own clipping is known truncation;
// the top-level flag is true only for known loss. A fake CLI answers; no real Memy.

const checks = [{ name: 'math', argv: [process.execPath, '--test', 'tests/math.test.mjs'], timeoutMs: 10000 }];
const job = project => ({ idempotencyKey: 'req-1', project, objective: 'Fix add to add its two inputs; preserve the existing tests.', context: 'Tests already encode the expected behaviour.', allowedPaths: ['src/math.mjs'], checks });
const PROJECT = '44444444-4444-4444-8444-444444444444';

function fakeRecall() {
  const state = { items: [], omitted: null, degraded: false };
  const command = async argv => {
    const sub = argv[argv.indexOf('handoff') + 1];
    const out = sub === 'recall' ? { schema: 'memy.handoff.v1', command: 'recall', status: 'ok', project_id: PROJECT, items: state.items, degraded: state.degraded, ...(state.omitted ? { omitted: state.omitted } : {}) } : { schema: 'memy.handoff.v1', command: sub, status: 'ok', project_id: PROJECT, collection: { write_enabled: true, write_generation: 1 } };
    return { code: 0, stdout: `${JSON.stringify(out)}\n`, stderr: '' };
  };
  return { state, command };
}

async function setup(t) {
  const f = await fixture(); t.after(f.remove);
  f.project = await fs.realpath(f.project);
  const orchestrator = new Orchestrator({ stateRoot: f.stateRoot, herdr: new FakeHerdr() });
  const principals = new PrincipalStore({ root: f.stateRoot });
  const { principal } = await principals.create({ id: 'grok', projects: [f.project], agents: ['claude', 'codex'], permissions: { sessions: true }, kind: 'grok' });
  const access = new AccessService({ root: f.stateRoot, orchestrator, principals, driver: 'inline' });
  const sessions = new SessionStore({ root: f.stateRoot });
  const fake = fakeRecall();
  const provider = new MemyHandoffCliProvider({ argv: ['memy'], timeoutMs: 800, command: fake.command });
  const memory = new MemoryService({ root: f.stateRoot, provider, principals, sessions, jobs: access.jobs, orchestrator, timeoutMs: 800 });
  const jobId = (await access.submit(principal, job(f.project))).job.id;
  const recall = (extra = {}) => memory.recall(principal, { jobId, question: 'what was decided about add()?', ...extra });
  return { ...f, memory, principal, jobId, fake, recall, provider };
}

const item = (content, extra = {}) => ({ memory_id: '0b5a4b5a-5c7e-4f1e-9a1a-00000000000a', content, memory_type: 'handoff', provenance: { source: 'test', observed_at: '2026-10-01T00:00:00Z' }, ...extra });
const cjk = n => '記'.repeat(n);
const emoji = n => '😀'.repeat(n);

test('scalar counting and clipping: code points, not UTF-16 units; exactly the cap is untouched; one more is clipped to cap-1 plus an ellipsis', () => {
  assert.equal(scalarCount(emoji(3)), 3); assert.equal(emoji(3).length, 6);
  assert.deepEqual(clipScalars('abc', 1200), { content: 'abc', clipped: false, chars: 3 });
  const exact = emoji(MAX_ITEM_CHARS);
  assert.deepEqual(clipScalars(exact, MAX_ITEM_CHARS), { content: exact, clipped: false, chars: MAX_ITEM_CHARS });
  const over = clipScalars(emoji(MAX_ITEM_CHARS + 1), MAX_ITEM_CHARS);
  assert.equal(over.clipped, true); assert.equal(over.chars, MAX_ITEM_CHARS + 1); assert.equal(scalarCount(over.content), MAX_ITEM_CHARS); assert.ok(over.content.endsWith('…'));
  assert.deepEqual(clipScalars(null, 10), { content: '', clipped: false, chars: 0 });
});

test('excerpt metadata: old providers without fields are unknown; known complete, known truncated and Orbit-clipped items are reported truthfully; contradictory or malformed metadata is unknown, never invented', () => {
  const short = item('hello');
  assert.deepEqual(excerptMetadata(short, clipScalars(short.content, MAX_ITEM_CHARS)), { truncated: null, originalChars: null }, 'absent fields are unknown, not complete');
  assert.deepEqual(excerptMetadata({ ...short, truncated: false, original_chars: 5 }, clipScalars('hello', MAX_ITEM_CHARS)), { truncated: false, originalChars: 5 });
  const capped = item(cjk(MAX_ITEM_CHARS), { truncated: true, original_chars: 2026 });
  assert.deepEqual(excerptMetadata(capped, clipScalars(capped.content, MAX_ITEM_CHARS)), { truncated: true, originalChars: 2026 }, 'provider clipping with its redacted original length');
  const ownClip = item(cjk(1500), { truncated: false, original_chars: 1500 });
  assert.deepEqual(excerptMetadata(ownClip, clipScalars(ownClip.content, MAX_ITEM_CHARS)), { truncated: true, originalChars: 1500 }, 'Orbit clipped it: truncated, original length kept');
  const ownClipUnknown = item(cjk(1500));
  assert.deepEqual(excerptMetadata(ownClipUnknown, clipScalars(ownClipUnknown.content, MAX_ITEM_CHARS)), { truncated: true, originalChars: null }, 'Orbit clipped an item of unknown origin: truncated, length unknown');
  // A malformed truncated flag is unknown; a malformed count is dropped (completeness stated by the
  // provider then yields Orbit's own count of the complete content); a valid, consistent count beside a
  // malformed flag is kept as the provider's statement of length while truncation stays unknown.
  assert.deepEqual(excerptMetadata(item('hello', { truncated: 'yes', original_chars: 5 }), clipScalars('hello', MAX_ITEM_CHARS)), { truncated: null, originalChars: 5 });
  assert.deepEqual(excerptMetadata(item('hello', { truncated: 'yes', original_chars: 'five' }), clipScalars('hello', MAX_ITEM_CHARS)), { truncated: null, originalChars: null });
  for (const bad of [{ truncated: false, original_chars: -1 }, { truncated: false, original_chars: 3.5 }, { truncated: false, original_chars: '5' }]) {
    assert.deepEqual(excerptMetadata(item('hello', bad), clipScalars('hello', MAX_ITEM_CHARS)), { truncated: false, originalChars: 5 }, `malformed count dropped, complete content counted: ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(excerptMetadata(item('hello', { truncated: false, original_chars: 9 }), clipScalars('hello', MAX_ITEM_CHARS)), { truncated: null, originalChars: null }, 'complete but counts differ from what was sent: contradictory, unknown');
  assert.deepEqual(excerptMetadata(item('hello', { truncated: true, original_chars: 2 }), clipScalars('hello', MAX_ITEM_CHARS)), { truncated: null, originalChars: null }, 'truncated but counted fewer than sent: contradictory, unknown');
  assert.deepEqual(excerptMetadata(item('hello', { original_chars: 2 }), clipScalars('hello', MAX_ITEM_CHARS)), { truncated: null, originalChars: null });
  assert.deepEqual(excerptMetadata(item('hello', { original_chars: 40 }), clipScalars('hello', MAX_ITEM_CHARS)), { truncated: null, originalChars: 40 }, 'a count alone, consistent, is kept while truncation stays unknown');
});

test('recall passes the excerpt contract through end to end: old wire, short, exact cap, long, Unicode, Orbit clipping, omitted items; top-level truncated is true only for known loss and false is no completeness promise under unknown metadata', async t => {
  const { recall, fake } = await setup(t);
  // Old provider wire: no fields → unknown, top-level false but metadataUnknown true.
  fake.state.items = [item('Earlier decision: keep add() binary.')];
  let r = await recall();
  assert.equal(r.status, 'ok'); assert.equal(r.items[0].truncated, null); assert.equal(r.items[0].originalChars, null);
  assert.equal(r.truncated, false); assert.equal(r.metadataUnknown, true); assert.equal(r.omittedByOrbit, 0); assert.equal(r.trust, 'untrusted_evidence');
  assert.match(r.note, /excerpt/);
  // Short, exact cap and long with the new fields.
  fake.state.items = [item('short', { truncated: false, original_chars: 5 }), item(cjk(MAX_ITEM_CHARS), { truncated: false, original_chars: MAX_ITEM_CHARS }), item(cjk(MAX_ITEM_CHARS), { truncated: true, original_chars: 2026 })];
  r = await recall({ topK: 3 });
  assert.deepEqual(r.items.map(i => [i.truncated, i.originalChars, scalarCount(i.content)]), [[false, 5, 5], [false, MAX_ITEM_CHARS, MAX_ITEM_CHARS], [true, 2026, MAX_ITEM_CHARS]]);
  assert.equal(r.truncated, true, 'a known provider truncation makes the whole answer known-incomplete'); assert.equal(r.metadataUnknown, false);
  fake.state.items = fake.state.items.slice(0, 2);
  r = await recall({ topK: 3 });
  assert.equal(r.truncated, false); assert.equal(r.metadataUnknown, false, 'all items known complete: false is a real statement');
  // Unicode: 1200 emoji are 2400 UTF-16 units but exactly the cap in scalars; Orbit must not clip them.
  fake.state.items = [item(emoji(MAX_ITEM_CHARS), { truncated: false, original_chars: MAX_ITEM_CHARS })];
  r = await recall();
  assert.equal(r.items[0].content, emoji(MAX_ITEM_CHARS)); assert.equal(r.items[0].truncated, false); assert.equal(r.items[0].originalChars, MAX_ITEM_CHARS);
  // Provider known clipping survives Orbit's larger budget untouched.
  fake.state.items = [item('x'.repeat(100), { truncated: true, original_chars: 5000 })];
  r = await recall();
  assert.equal(r.items[0].truncated, true); assert.equal(r.items[0].originalChars, 5000); assert.equal(r.items[0].content.length, 100); assert.equal(r.truncated, true);
  // Orbit's own clipping of an over-cap item: known truncation, provider's complete count kept; without a count, length unknown.
  fake.state.items = [item(emoji(1500), { truncated: false, original_chars: 1500 }), item('x'.repeat(1300))]; // 4800 + 1200 bytes: both fit the 8 KiB budget
  r = await recall({ topK: 2 });
  assert.equal(scalarCount(r.items[0].content), MAX_ITEM_CHARS); assert.ok(r.items[0].content.endsWith('…')); assert.deepEqual([r.items[0].truncated, r.items[0].originalChars], [true, 1500]);
  assert.deepEqual([r.items[1].truncated, r.items[1].originalChars, scalarCount(r.items[1].content)], [true, null, MAX_ITEM_CHARS]);
  assert.equal(r.truncated, true);
  // Malformed metadata on the wire never invents completeness or lengths.
  fake.state.items = [item('hello', { truncated: 'yes', original_chars: 'five' }), item('hello', { truncated: false, original_chars: 99 })];
  r = await recall({ topK: 2 });
  assert.deepEqual(r.items.map(i => [i.truncated, i.originalChars]), [[null, null], [null, null]]); assert.equal(r.truncated, false); assert.equal(r.metadataUnknown, true);
  // Items omitted by the provider (over_budget) or by Orbit's topK / byte budget make truncated true.
  fake.state.items = [item('a', { truncated: false, original_chars: 1 })]; fake.state.omitted = { over_budget: 2 };
  r = await recall();
  assert.equal(r.truncated, true); assert.deepEqual(r.omitted, { over_budget: 2 }); assert.equal(r.omittedByOrbit, 0);
  fake.state.omitted = null;
  fake.state.items = [item('a', { truncated: false, original_chars: 1 }), item('b', { truncated: false, original_chars: 1 }), item('c', { truncated: false, original_chars: 1 })];
  r = await recall({ topK: 2 });
  assert.equal(r.items.length, 2); assert.equal(r.omittedByOrbit, 1); assert.equal(r.truncated, true);
  fake.state.items = Array.from({ length: 8 }, (_, i) => item(cjk(MAX_ITEM_CHARS), { truncated: false, original_chars: MAX_ITEM_CHARS, memory_id: `0b5a4b5a-5c7e-4f1e-9a1a-00000000000${i}` }));
  r = await recall({ topK: 8 });
  assert.ok(r.items.length < 8, 'the 8 KiB byte budget omits items'); assert.equal(r.omittedByOrbit, 8 - r.items.length); assert.equal(r.truncated, true);
  // Degraded answers keep the same metadata semantics.
  fake.state.items = [item('short', { truncated: false, original_chars: 5 })]; fake.state.degraded = true;
  r = await recall();
  assert.equal(r.status, 'degraded'); assert.equal(r.items[0].truncated, false); assert.equal(r.truncated, false);
});
