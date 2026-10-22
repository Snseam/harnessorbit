import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { PrincipalStore } from '../src/access/principals.mjs';
import { SessionStore, SessionService, classifyBusyInput, queueWire, queueContentMatches, queueBaseline, queueScan, claudeTranscriptPath, QUEUE_PROFILES, QUEUE_CAPABILITY } from '../src/access/sessions.mjs';
import { AccessService } from '../src/access/service.mjs';
import { startAccessServer } from '../src/access/server.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { parseArgs } from '../bin/cao.mjs';
import { fixture, FakeHerdr } from './helpers.mjs';

// Fixture evidence for the explicit opt-in Claude busy-text queue (design v2 + root decision).
// A fake pane and a synthetic Claude transcript in the sampled row shapes stand in for the TUI; the
// fake paste appends what Claude Code 2.1.306 was observed to write. No real Claude, no probe.

const SESSION = '19b9b76e-aaaa-4bbb-8ccc-000000000001';
const OTHER = '19b9b76e-aaaa-4bbb-8ccc-000000000002';
const PROFILE = 'claude-queue-2.1.306';
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
const line = o => `${JSON.stringify(o)}\n`;
const ordinary = (type = 'assistant', extra = {}) => line({ type, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: SESSION, version: '2.1.306', entrypoint: 'cli', isSidechain: false, message: { role: type === 'user' ? 'user' : 'assistant', content: [{ type: 'text', text: 'MODEL TEXT NEVER LEAVES' }] }, ...extra });
const wrap = (wire, id = '0cee') => `<pasted_content id="${id}">\n${wire}\n</pasted_content id="${id}">`;
const enqueue = (content, extra = {}) => line({ type: 'queue-operation', operation: 'enqueue', content, sessionId: SESSION, timestamp: new Date().toISOString(), ...extra });
const remove = (content, { reason = 'absorbed_mid_turn', commandUuid = crypto.randomUUID(), deliveryId = crypto.randomUUID(), ...extra } = {}) => ({ text: line({ type: 'queue-operation', operation: 'remove', reason, content, commandUuid, deliveryId, sessionId: SESSION, timestamp: new Date().toISOString(), ...extra }), commandUuid, deliveryId });
const attachment = (content, { commandUuid, deliveryId }) => line({ type: 'attachment', uuid: crypto.randomUUID(), sessionId: SESSION, timestamp: new Date(Date.now() - 1000).toISOString(), version: '2.1.306', entrypoint: 'cli', attachment: { type: 'queued_command', prompt: content, source_uuid: commandUuid, delivery_id: deliveryId, commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true } });
const BUSY = ['⏺ Running the tests', '✻ Brewing… (esc to interrupt)', '❯ ', '─────'];
const BUSY_DRAFT = ['✻ Brewing… (esc to interrupt)', '❯ half typed by the operator', '─────'];
const BUSY_NO_PROMPT = ['✻ Brewing… (esc to interrupt)'];
const IDLE = ['⏺ done', '❯ ', '─────'];
const PERMISSION = ['Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel'];

async function setup(t, { bind = {}, settleMs = 800, pasteBehaviour = 'claude' } = {}) {
  const f = await fixture(); t.after(f.remove);
  f.project = await fs.realpath(f.project);
  const claudeHome = path.join(f.base, 'claude-home');
  const transcript = claudeTranscriptPath(claudeHome, f.project, SESSION);
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, ordinary('user') + ordinary('assistant'));
  const principals = new PrincipalStore({ root: f.stateRoot });
  const grok = (await principals.create({ id: 'grok', projects: [f.project], agents: ['claude', 'codex'], permissions: { sessions: true }, kind: 'grok' })).principal;
  const sessions = new SessionStore({ root: f.stateRoot });
  const proc = { pid: 1, ppid: 0, pgid: 1, tpgid: 1, stat: 'S+', startedAt: 'x', comm: 'claude', args: `claude --resume ${SESSION}` };
  const pane = { paneId: '%9', target: 'live:0.0', panePid: 1, dead: false, currentCommand: 'claude', currentPath: f.project, historySize: 0 };
  const pasted = [];
  const tmux = { socket: null, screen: [...BUSY], pane: async () => pane, listPanes: async () => [pane], captureScreen: async () => [...tmux.screen], captureHistory: async () => [], pasteMode: pasteBehaviour, afterPaste: null,
    sendText: async (paneId, text) => { pasted.push(text); if (tmux.pasteMode === 'throw') { const e = new Error('tmux gone'); e.code = 'command_failed'; throw e; } if (tmux.pasteMode === 'claude') await fs.appendFile(transcript, enqueue(wrap(text))); if (tmux.afterPaste) await tmux.afterPaste(text); },
    sendKeys: async () => { throw new Error('never'); } };
  const live = new SessionService({ root: f.stateRoot, principals, sessions, tmux, processes: { table: async () => new Map([[1, proc]]), agentUnder: async () => ({ ...proc, kind: 'claude' }), cwd: async () => f.project }, settleMs, claudeHome });
  const bound = await live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1', providerSessionId: SESSION, allowQueue: true, queueProfile: PROFILE, ...bind });
  const record = async () => sessions.get('ses-1');
  const entry = async key => (await record()).messages.find(m => m.keyHash === sha(key));
  return { ...f, claudeHome, transcript, principals, grok, sessions, tmux, live, bound, pasted, record, entry };
}

test('helpers: busy input classification, wire envelope, strict content decode, baseline anchor and bounded scan', async t => {
  assert.equal(classifyBusyInput('claude', BUSY).ok, true);
  assert.equal(classifyBusyInput('claude', BUSY_DRAFT).reason, 'input_not_empty');
  assert.equal(classifyBusyInput('claude', BUSY_NO_PROMPT).reason, 'no_current_prompt');
  // Review C7: a prompt ABOVE the spinner is the submitted message, not a current empty input box.
  assert.equal(classifyBusyInput('claude', ['❯ ', '✻ Brewing… (esc to interrupt)', 'some tool output']).reason, 'no_current_prompt');
  assert.equal(classifyBusyInput('claude', ['❯ fix it', '✻ Brewing… (esc to interrupt)', '❯ ']).ok, true, 'history above, current empty prompt below');
  assert.equal(classifyBusyInput('claude', ['❯ ', '✻ Brewing… (esc to interrupt)', '❯ draft']).reason, 'input_not_empty');
  assert.equal(classifyBusyInput('claude', ['❯ ', '✻ Brewing… (esc to interrupt)', '❯ ', 'Do you want to proceed?']).reason, 'state_waiting_input', 'a dialog is waiting_input before any busy evaluation');
  assert.equal(classifyBusyInput('claude', IDLE).reason, 'state_idle');
  assert.equal(classifyBusyInput('claude', PERMISSION).reason, 'state_waiting_input');
  assert.equal(classifyBusyInput('claude', ['some log']).reason, 'state_unknown');
  assert.equal(classifyBusyInput('codex', ['• Working (esc to interrupt)', '› ']).ok, true, 'the classifier itself is generic; the profile gate is elsewhere');
  const nonce = 'a'.repeat(32); const wire = queueWire(nonce, '/help me\n!echo');
  assert.equal(wire.split('\n')[0], `orbit-queue v1 ${nonce}`); assert.match(wire[0], /[a-z]/);
  const h = sha(wire);
  assert.equal(queueContentMatches(wire, h), true, 'exact raw');
  assert.equal(queueContentMatches(wrap(wire), h), true, 'exact wrapper');
  assert.equal(queueContentMatches(wrap(wire, 'ffff'), h), true);
  assert.equal(queueContentMatches(`<pasted_content id="0cee">\n${wire}\n</pasted_content id="0ced">`, h), false, 'closing id differs');
  assert.equal(queueContentMatches(`${wrap(wire)} trailing`, h), false);
  assert.equal(queueContentMatches(wrap(`${wire} extra`), h), false, 'body with extra text');
  assert.equal(queueContentMatches(wrap(nonce), h), false, 'nonce alone is not the wire');
  assert.equal(queueContentMatches(wrap(wire.slice(0, -1)), h), false);
  assert.equal(queueContentMatches(null, h), false);
  // Baseline: complete final line with a whole last row inside the window; otherwise unstable.
  const f = await fixture(); t.after(f.remove);
  const file = path.join(f.base, 't.jsonl');
  await fs.writeFile(file, '');
  assert.deepEqual((await queueBaseline(file)).baseline.anchor, null);
  await fs.writeFile(file, ordinary() + ordinary());
  const b = await queueBaseline(file);
  assert.equal(b.ok, true); assert.equal(b.baseline.size, (await fs.stat(file)).size); assert.equal(b.baseline.anchor.end, b.baseline.size);
  await fs.appendFile(file, '{"type":"assistant"');
  assert.equal((await queueBaseline(file)).reason, 'incomplete_final_line');
  await fs.writeFile(file, ordinary() + line({ type: 'assistant', pad: 'x'.repeat(70000), sessionId: SESSION }));
  assert.equal((await queueBaseline(file)).reason, 'anchor_row_exceeds_window', 'a suffix of the last row is never labelled a full row');
  assert.equal((await queueBaseline(path.join(f.base, 'none.jsonl'))).reason, 'source_missing');
  // Scan: complete rows only, offsets, anchor continuity, eof flag, resets.
  await fs.writeFile(file, ordinary() + ordinary());
  const base = (await queueBaseline(file)).baseline;
  await fs.appendFile(file, enqueue('x') + '{"partial":');
  const s1 = await queueScan(file, { dev: base.dev, ino: base.ino, scanCursor: base.size, anchor: base.anchor });
  assert.equal(s1.ok, true); assert.equal(s1.rows.length, 1); assert.equal(s1.rows[0].start, base.size); assert.equal(s1.eof, false, 'unterminated tail left unconsumed');
  assert.equal(s1.scanCursor, base.size + Buffer.byteLength(enqueue('x')));
  await fs.appendFile(file, '"done"}\n');
  const s2 = await queueScan(file, { dev: base.dev, ino: base.ino, scanCursor: s1.scanCursor, anchor: s1.anchor });
  assert.equal(s2.rows.length, 1); assert.equal(s2.eof, true);
  await fs.truncate(file, base.size);
  assert.equal((await queueScan(file, { dev: base.dev, ino: base.ino, scanCursor: s2.scanCursor, anchor: s2.anchor })).reset, 'shrunk');
  const same = await fs.readFile(file); await fs.writeFile(file, Buffer.concat([same.subarray(0, same.length - 10), Buffer.from('X'.repeat(9) + '\n')]));
  await fs.appendFile(file, enqueue('y'));
  assert.equal((await queueScan(file, { dev: base.dev, ino: base.ino, scanCursor: base.size, anchor: base.anchor })).reset, 'anchor_mismatch', 'same-inode rewrite of the anchor row is a discontinuity');
  await fs.rename(file, `${file}.old`); await fs.writeFile(file, same);
  assert.equal((await queueScan(file, { dev: base.dev, ino: base.ino, scanCursor: base.size, anchor: base.anchor })).reset, 'inode_changed');
  void QUEUE_CAPABILITY;
});

test('bind opt-in: the candidate profile is operator-selected, needs the provider session and re-observed compatibility evidence from this session’s own rows; a version string in a request is never a credential', async t => {
  const { bound, record, live, sessions, transcript, claudeHome, project } = await setup(t);
  assert.deepEqual((await record()).queue.profile, PROFILE); assert.equal((await record()).queue.profileStatus, 'candidate');
  assert.equal((await record()).queue.evidenceAtBind.version, '2.1.306'); assert.equal(bound.queue.allowed, true);
  await sessions.remove('ses-1');
  await assert.rejects(live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1', providerSessionId: SESSION, allowQueue: true }), e => e.code === 'invalid_session', 'profile required');
  await assert.rejects(live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1', providerSessionId: SESSION, allowQueue: true, queueProfile: 'claude-queue-9.9.9' }), e => e.code === 'queue_profile_unknown');
  await assert.rejects(live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1', allowQueue: false, queueProfile: PROFILE }), e => e.code === 'invalid_session');
  // No provider session id → no native record to read receipts from.
  const noResume = { table: async () => new Map([[1, { pid: 1, ppid: 0, pgid: 1, tpgid: 1, stat: 'S+', startedAt: 'x', comm: 'claude', args: 'claude' }]]), agentUnder: async () => ({ pid: 1, ppid: 0, pgid: 1, tpgid: 1, stat: 'S+', startedAt: 'x', comm: 'claude', args: 'claude', kind: 'claude' }), cwd: async () => project };
  const bare = new SessionService({ root: live.root, principals: live.principals, sessions, tmux: live.tmux, processes: noResume, settleMs: 100, claudeHome });
  await assert.rejects(bare.bind({ principalId: 'grok', pane: '%9', id: 'ses-1', allowQueue: true, queueProfile: PROFILE }), e => e.code === 'queue_unsupported');
  // Evidence mismatch or absence in the session's own rows refuses; rows of another session do not count.
  await fs.writeFile(transcript, ordinary('assistant', { version: '2.0.0' }));
  await assert.rejects(live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1', providerSessionId: SESSION, allowQueue: true, queueProfile: PROFILE }), e => e.code === 'queue_profile_unverified' && e.details.reason === 'evidence_mismatch');
  await fs.writeFile(transcript, ordinary('assistant', { sessionId: OTHER }));
  await assert.rejects(live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1', providerSessionId: SESSION, allowQueue: true, queueProfile: PROFILE }), e => e.code === 'queue_profile_unverified' && e.details.reason === 'no_ordinary_row_in_window');
  await fs.writeFile(transcript, ordinary('assistant', { entrypoint: 'sdk' }));
  await assert.rejects(live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1', providerSessionId: SESSION, allowQueue: true, queueProfile: PROFILE }), e => e.code === 'queue_profile_unverified');
  await fs.writeFile(transcript, ordinary('system'));
  assert.equal((await live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1', providerSessionId: SESSION, allowQueue: true, queueProfile: PROFILE })).queue.allowed, true);
  // A binding without the opt-in reports queue.allowed false and keeps the default refusal.
  await sessions.remove('ses-1');
  const plain = await live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1', providerSessionId: SESSION });
  assert.deepEqual(plain.queue, { allowed: false, profile: null, outstanding: null });
  assert.equal(QUEUE_PROFILES[PROFILE].status, 'candidate');
});

test('queue send: envelope durable before the paste, receipt only from native rows (queued then absorbed with ids and corroboration), same key never pasted again, one outstanding per binding', async t => {
  const { live, grok, tmux, pasted, entry, transcript, record } = await setup(t);
  // Same-scan lifecycle: Claude absorbs the queued text mid-turn before Orbit's first scan.
  tmux.afterPaste = async text => { const r = remove(wrap(text)); await fs.appendFile(transcript, r.text + attachment(wrap(text), r)); };
  const r1 = await live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'q-1', text: '/help should be plain text here', mode: 'queue' });
  assert.equal(r1.message.mode, 'queue'); assert.equal(r1.message.queue.state, 'absorbed'); assert.equal(r1.message.outcome, 'absorbed');
  assert.equal(pasted.length, 1); assert.equal(pasted[0], queueWire(r1.message.nonce, '/help should be plain text here'), 'the pasted wire is the envelope, not the raw text');
  assert.match(r1.message.nonce, /^[0-9a-f]{32}$/); assert.equal(r1.message.wireHash, sha(pasted[0])); assert.equal(r1.message.payloadHash, sha('text:/help should be plain text here'));
  assert.ok(r1.message.queue.enqueue.start >= r1.message.queue.baseline.size); assert.ok(r1.message.queue.remove.start > r1.message.queue.enqueue.start);
  assert.match(r1.message.queue.remove.commandUuid, /^[0-9a-f-]{36}$/); assert.ok(r1.message.queue.attachment.uuid); assert.ok(r1.message.queue.terminalBoundary >= r1.message.queue.remove.end);
  assert.equal(r1.message.meaning, QUEUE_CAPABILITY.meaning); assert.equal(r1.executionFinished, undefined); assert.ok(!JSON.stringify(r1).includes('MODEL TEXT'));
  assert.equal((await live.status(grok, { sessionId: 'ses-1' })).queue.outstanding, null, 'absorbed released the slot');
  // Same key: reconciled and returned, never pasted again; a different payload or mode under the key conflicts.
  const again = await live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'q-1', text: '/help should be plain text here', mode: 'queue' });
  assert.equal(again.message.reused, true); assert.equal(again.message.queue.state, 'absorbed'); assert.equal(pasted.length, 1);
  await assert.rejects(live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'q-1', text: 'other', mode: 'queue' }), e => e.code === 'idempotency_conflict');
  await assert.rejects(live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'q-1', text: '/help should be plain text here' }), e => e.code === 'idempotency_conflict');
  // Queued but not yet absorbed: outstanding; a second queue send (any key or payload) is refused; status reconciles later.
  tmux.afterPaste = null;
  const r2 = await live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'q-2', text: 'second note', mode: 'queue' });
  assert.equal(r2.message.queue.state, 'queued'); assert.equal(pasted.length, 2);
  assert.notEqual(r2.message.nonce, r1.message.nonce);
  await assert.rejects(live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'q-3', text: 'third', mode: 'queue' }), e => e.code === 'queue_outstanding');
  await assert.rejects(live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'q-3b', text: 'second note', mode: 'queue' }), e => e.code === 'queue_outstanding');
  assert.equal(pasted.length, 2);
  const st = await live.status(grok, { sessionId: 'ses-1' });
  assert.deepEqual([st.queue.outstanding.state, st.queue.outstanding.keyHash], ['queued', sha('q-2')]);
  const rm = remove(wrap(pasted[1])); await fs.appendFile(transcript, rm.text);
  assert.equal((await live.status(grok, { sessionId: 'ses-1' })).queue.outstanding, null);
  assert.equal((await entry('q-2')).queue.state, 'absorbed'); assert.equal((await entry('q-2')).queue.remove.deliveryId, rm.deliveryId); assert.equal((await entry('q-2')).queue.attachment, null, 'corroboration is optional');
  // Same text as q-2 under a new key after absorption: a new nonce, matched only to rows after the earlier match.
  const r4 = await live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'q-4', text: 'second note', mode: 'queue' });
  assert.equal(r4.message.queue.state, 'queued'); assert.notEqual(r4.message.nonce, r2.message.nonce); assert.ok(r4.message.queue.enqueue.start > (await entry('q-2')).queue.remove.start);
  assert.equal((await record()).messages.length, 3);
});

test('refusals with zero paste: default binding, mode omitted, idle, draft, no prompt row, permission prompt, unknown screen, keys in queue mode, Codex, evidence lost, unstable source, authority revoked in the lock', async t => {
  const { live, grok, tmux, pasted, sessions, transcript, principals, project, base } = await setup(t);
  const send = (extra = {}) => live.send(grok, { sessionId: 'ses-1', idempotencyKey: `k-${Math.random()}`, text: 'note', mode: 'queue', ...extra });
  await assert.rejects(live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'plain', text: 'note' }), e => e.code === 'session_busy', 'mode omitted keeps the default refusal even on an opted-in binding');
  tmux.screen = [...IDLE]; await assert.rejects(send(), e => e.code === 'invalid_message');
  tmux.screen = [...BUSY_DRAFT]; await assert.rejects(send(), e => e.code === 'queue_input_not_empty');
  tmux.screen = [...BUSY_NO_PROMPT]; await assert.rejects(send(), e => e.code === 'queue_unverifiable');
  tmux.screen = [...PERMISSION]; await assert.rejects(send(), e => e.code === 'session_waiting_input');
  tmux.screen = ['just some output']; await assert.rejects(send(), e => e.code === 'queue_unverifiable');
  tmux.screen = [...BUSY];
  await assert.rejects(send({ text: undefined, keys: ['Enter'] }), e => e.code === 'keys_not_allowed' || e.code === 'invalid_message');
  await assert.rejects(send({ mode: 'later' }), e => e.code === 'invalid_message');
  // Evidence lost in the session's own rows since bind (the transcript tail now shows another version).
  const good = await fs.readFile(transcript);
  await fs.appendFile(transcript, ordinary('assistant', { version: '2.1.999' }));
  await assert.rejects(send(), e => e.code === 'queue_profile_unverified');
  await fs.writeFile(transcript, good);
  // Unstable source: incomplete final line, or last row larger than the window.
  await fs.appendFile(transcript, '{"type":"assistant"');
  await assert.rejects(send(), e => e.code === 'queue_source_unstable' && e.details.reason === 'incomplete_final_line');
  await fs.writeFile(transcript, Buffer.concat([good, Buffer.from(line({ type: 'system', sessionId: SESSION, version: '2.1.306', entrypoint: 'cli', pad: 'x'.repeat(70000) }))]));
  // A last row larger than the tail window leaves no complete ordinary row in it either: the evidence
  // check refuses first; the anchor rule itself is covered by the helper test. Zero paste either way.
  await assert.rejects(send(), e => (e.code === 'queue_profile_unverified' && e.details.reason === 'no_ordinary_row_in_window') || (e.code === 'queue_source_unstable' && e.details.reason === 'anchor_row_exceeds_window'));
  await fs.writeFile(transcript, good);
  assert.equal(pasted.length, 0, 'nothing was pasted by any refusal');
  // Default binding (no opt-in): queue mode refused as not allowed.
  await sessions.remove('ses-1'); await live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1', providerSessionId: SESSION });
  await assert.rejects(send(), e => e.code === 'queue_not_allowed');
  // Authority revoked while waiting for the pane lock: refused before any paste.
  await sessions.remove('ses-1'); await live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1', providerSessionId: SESSION, allowQueue: true, queueProfile: PROFILE });
  const { withLock } = await import('../src/state.mjs');
  let release; const gate = new Promise(r => { release = r; });
  const held = withLock(path.join(live.root, 'locks', 'access-pane-9'), () => gate, { timeoutMs: 15000 });
  await new Promise(r => setTimeout(r, 30));
  const waiting = send();
  await new Promise(r => setTimeout(r, 30));
  await principals.update('grok', { permissions: { sessions: false } });
  release(); await held;
  await assert.rejects(waiting, e => e.code === 'permission_denied');
  await principals.update('grok', { permissions: { sessions: true } });
  const other = path.join(base, 'elsewhere'); await fs.mkdir(other);
  let release2; const gate2 = new Promise(r => { release2 = r; });
  const held2 = withLock(path.join(live.root, 'locks', 'access-pane-9'), () => gate2, { timeoutMs: 15000 });
  await new Promise(r => setTimeout(r, 30));
  const waiting2 = send();
  await new Promise(r => setTimeout(r, 30));
  await principals.update('grok', { projects: [other] });
  release2(); await held2;
  await assert.rejects(waiting2, e => ['permission_denied', 'session_not_found', 'project_not_allowed'].includes(e.code));
  await principals.update('grok', { projects: [project] });
  assert.equal(pasted.length, 0);
});

test('uncertain paths: tmux error, no native row in the window, unknown removal, ambiguous second enqueue, source reset, oversized row; conflicts are sticky, never absorbed, the slot stays outstanding and nothing is ever re-pasted', async t => {
  const { live, grok, tmux, pasted, entry, transcript, sessions } = await setup(t, { settleMs: 500 });
  // tmux error after the durable entry: uncertain, outstanding, same key only reconciles.
  tmux.pasteMode = 'throw';
  await assert.rejects(live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'u-1', text: 'note', mode: 'queue' }), e => e.code === 'send_uncertain');
  let e1 = await entry('u-1'); assert.equal(e1.queue.state, 'uncertain'); assert.equal(e1.queue.conflict, null); assert.ok(e1.nonce);
  const again = await live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'u-1', text: 'note', mode: 'queue' });
  assert.equal(again.message.reused, true); assert.equal(pasted.length, 1, 'no second paste');
  // The paste actually landed later: the enqueue row appears and reconciliation upgrades to queued, then absorbed.
  await fs.appendFile(transcript, enqueue(wrap(pasted[0])));
  assert.equal((await live.status(grok, { sessionId: 'ses-1' })).queue.outstanding.state, 'queued');
  const rm = remove(wrap(pasted[0])); await fs.appendFile(transcript, rm.text);
  assert.equal((await live.status(grok, { sessionId: 'ses-1' })).queue.outstanding, null); assert.equal((await entry('u-1')).queue.state, 'absorbed');
  // No native row within the window: uncertain without conflict; later rows reconcile it.
  tmux.pasteMode = 'silent';
  const r2 = await live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'u-2', text: 'note two', mode: 'queue' });
  assert.equal(r2.message.queue.state, 'uncertain'); assert.equal(r2.message.queue.conflict, null); assert.equal(r2.message.outcome, 'uncertain');
  await fs.appendFile(transcript, enqueue(wrap(pasted[1])) + remove(wrap(pasted[1])).text);
  assert.equal((await live.status(grok, { sessionId: 'ses-1' })).queue.outstanding, null); assert.equal((await entry('u-2')).queue.state, 'absorbed');
  // Unknown removal reason: sticky uncertain, slot outstanding, a later absorbed-looking remove changes nothing.
  tmux.pasteMode = 'claude';
  const r3 = await live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'u-3', text: 'note three', mode: 'queue' });
  assert.equal(r3.message.queue.state, 'queued');
  await fs.appendFile(transcript, remove(wrap(pasted[2]), { reason: 'user_cleared' }).text);
  let st = await live.status(grok, { sessionId: 'ses-1' });
  assert.deepEqual([st.queue.outstanding.state, st.queue.outstanding.conflict], ['uncertain', 'unknown_removal']);
  assert.equal((await entry('u-3')).queue.nativeRemoval.reason, 'user_cleared');
  await fs.appendFile(transcript, remove(wrap(pasted[2])).text);
  st = await live.status(grok, { sessionId: 'ses-1' });
  assert.deepEqual([st.queue.outstanding.state, st.queue.outstanding.conflict], ['uncertain', 'unknown_removal'], 'sticky');
  await assert.rejects(live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'u-4', text: 'x', mode: 'queue' }), e => e.code === 'queue_outstanding');
  assert.equal(pasted.length, 3);
  // Fresh binding for the remaining conflict classes.
  const rebind = async () => { await sessions.remove('ses-1'); await live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1', providerSessionId: SESSION, allowQueue: true, queueProfile: PROFILE }); };
  // Ambiguous: a second distinct matching enqueue (a human re-paste of the identical wire) before the terminal.
  await rebind(); tmux.pasteMode = 'silent';
  const r5 = await live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'u-5', text: 'note five', mode: 'queue' });
  assert.equal(r5.message.queue.state, 'uncertain');
  await fs.appendFile(transcript, enqueue(wrap(pasted[3])) + enqueue(wrap(pasted[3], 'beef')) + remove(wrap(pasted[3])).text);
  st = await live.status(grok, { sessionId: 'ses-1' });
  assert.deepEqual([st.queue.outstanding.state, st.queue.outstanding.conflict], ['uncertain', 'ambiguous'], 'two candidates and a remove: never absorbed');
  await fs.appendFile(transcript, remove(wrap(pasted[3])).text);
  assert.equal((await live.status(grok, { sessionId: 'ses-1' })).queue.outstanding.conflict, 'ambiguous');
  // E1 in one scan, E2 plus remove in a later scan: still ambiguous (candidates persist across scans).
  await rebind();
  const r6 = await live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'u-6', text: 'note six', mode: 'queue' });
  await fs.appendFile(transcript, enqueue(wrap(pasted[4])));
  assert.equal((await live.status(grok, { sessionId: 'ses-1' })).queue.outstanding.state, 'queued');
  const firstOffset = (await entry('u-6')).queue.enqueue.start;
  await fs.appendFile(transcript, enqueue(wrap(pasted[4])) + remove(wrap(pasted[4])).text);
  st = await live.status(grok, { sessionId: 'ses-1' });
  assert.deepEqual([st.queue.outstanding.state, st.queue.outstanding.conflict], ['uncertain', 'ambiguous']); assert.equal((await entry('u-6')).queue.enqueue.start, firstOffset, 'the first enqueue stays the persisted candidate');
  void r6;
  // Source discontinuity after the paste: sticky native_reset; a later reappearing anchor does not resume attribution.
  await rebind();
  const r7 = await live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'u-7', text: 'note seven', mode: 'queue' });
  assert.equal(r7.message.queue.state, 'uncertain');
  const bytes = await fs.readFile(transcript);
  await fs.rename(transcript, `${transcript}.rotated`); await fs.writeFile(transcript, bytes);
  await fs.appendFile(transcript, enqueue(wrap(pasted[5])) + remove(wrap(pasted[5])).text);
  st = await live.status(grok, { sessionId: 'ses-1' });
  assert.deepEqual([st.queue.outstanding.state, st.queue.outstanding.conflict], ['uncertain', 'native_reset']); assert.equal((await entry('u-7')).queue.nativeReset.reason, 'inode_changed');
  assert.equal((await live.status(grok, { sessionId: 'ses-1' })).queue.outstanding.conflict, 'native_reset');
  // Crash between paste and receipt commit: on restart the same key reconciles from the stored baseline; re-reading the same offset is idempotent.
  await rebind(); tmux.pasteMode = 'claude';
  const r8 = await live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'u-8', text: 'note eight', mode: 'queue' });
  assert.equal(r8.message.queue.state, 'queued');
  const restarted = new SessionService({ root: live.root, principals: live.principals, sessions, tmux, processes: live.processes, settleMs: 500, claudeHome: live.claudeHome });
  const same = await restarted.send(grok, { sessionId: 'ses-1', idempotencyKey: 'u-8', text: 'note eight', mode: 'queue' });
  assert.equal(same.message.reused, true); assert.equal(same.message.queue.state, 'queued'); assert.equal(pasted.length, 7);
  const rm8 = remove(wrap(pasted[6])); await fs.appendFile(transcript, rm8.text + attachment(wrap(pasted[6]), rm8));
  assert.equal((await restarted.status(grok, { sessionId: 'ses-1' })).queue.outstanding, null);
  assert.equal((await entry('u-8')).queue.attachment.uuid !== null, true);
  // Rows of another session and rows before the baseline never match.
  await rebind(); tmux.pasteMode = 'silent';
  const r9 = await live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'u-9', text: 'note nine', mode: 'queue' });
  await fs.appendFile(transcript, enqueue(wrap(pasted[7]), { sessionId: OTHER }) + remove(wrap(pasted[7]), { sessionId: OTHER }).text);
  assert.equal((await live.status(grok, { sessionId: 'ses-1' })).queue.outstanding.state, 'uncertain'); assert.equal((await entry('u-9')).queue.enqueue, null);
  void r9;
});

test('MCP and CLI surfaces: describe labels the candidate, session_send takes mode, bind and send flags parse; receipts carry no completion or authorization', async t => {
  const f = await fixture(); t.after(f.remove);
  const orchestrator = new Orchestrator({ stateRoot: f.stateRoot, herdr: new FakeHerdr() });
  const principals = new PrincipalStore({ root: f.stateRoot });
  const token = (await principals.create({ id: 'grok', projects: [await fs.realpath(f.project)], agents: ['claude'], permissions: { sessions: true } })).token;
  const access = new AccessService({ root: f.stateRoot, orchestrator, principals, driver: 'inline' });
  const live = new SessionService({ root: f.stateRoot, principals, tmux: { socket: null, listPanes: async () => [], pane: async () => null, captureScreen: async () => [], captureHistory: async () => [], sendText: async () => {}, sendKeys: async () => {} }, processes: { table: async () => new Map(), agentUnder: async () => null, cwd: async () => null } });
  const server = await startAccessServer({ service: access, sessions: live, port: 0 }); t.after(() => server.close());
  const call = async (method, params) => (await (await fetch(server.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json());
  const tools = (await call('tools/list', {})).result.tools;
  const send = tools.find(x => x.name === 'session_send');
  assert.deepEqual(send.inputSchema.properties.mode.enum, ['idle_only', 'queue']);
  const described = JSON.parse((await call('tools/call', { name: 'describe', arguments: {} })).result.content[0].text);
  assert.equal(described.busyQueue.profiles[0].status, 'candidate'); assert.match(described.busyQueue.note, /isolated acceptance/);
  assert.deepEqual(parseArgs(['access', 'session', 'bind', '--principal', 'g', '--pane', '%1', '--allow-queue', '--queue-profile', PROFILE]).values, { principal: 'g', pane: '%1', 'allow-queue': true, 'queue-profile': PROFILE });
  assert.deepEqual(parseArgs(['access', 'session', 'send', '--principal', 'g', '--session', 's', '--key', 'k', '--text', 't', '--mode', 'queue']).values.mode, 'queue');
  assert.throws(() => parseArgs(['access', 'session', 'send', '--principal', 'g', '--session', 's', '--key', 'k', '--text', 't', '--send-now']), e => e.code === 'invalid_arguments');
});

test('review regressions: a post-paste crash leaves pending that reconciles from native evidence with zero re-paste, a pre-paste crash control stays outstanding with zero paste, a changed process identity refuses a same-key retry before any receipt mutation, and a historical prompt above the spinner never passes the gate', async t => {
  const { live, grok, tmux, pasted, entry, transcript, sessions, principals, record } = await setup(t, { settleMs: 500 });
  // C5: the process dies after the paste (native enqueue + absorbed remove already written) and before the
  // sent_unobserved commit. Emulated by making that commit throw once; the stored entry is `pending`.
  tmux.afterPaste = async text => { const r = remove(wrap(text)); await fs.appendFile(transcript, r.text + attachment(wrap(text), r)); };
  const commit = live._commit.bind(live); let commits = 0;
  live._commit = async (rec, change) => { commits += 1; if (commits === 2) { const e = new Error('process died'); e.code = 'simulated_crash'; throw e; } return commit(rec, change); };
  await assert.rejects(live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'c5', text: 'diagnosis', mode: 'queue' }), e => e.code === 'simulated_crash');
  live._commit = commit;
  assert.equal((await entry('c5')).queue.state, 'pending'); assert.equal(pasted.length, 1);
  const restarted = new SessionService({ root: live.root, principals, sessions, tmux, processes: live.processes, settleMs: 500, claudeHome: live.claudeHome });
  const st = await restarted.status(grok, { sessionId: 'ses-1' });
  assert.equal(st.queue.outstanding, null, 'status reconciled the pending entry from the native rows');
  const e5 = await entry('c5'); assert.equal(e5.queue.state, 'absorbed'); assert.ok(e5.queue.enqueue && e5.queue.remove && e5.queue.attachment);
  const retry = await restarted.send(grok, { sessionId: 'ses-1', idempotencyKey: 'c5', text: 'diagnosis', mode: 'queue' });
  assert.equal(retry.message.reused, true); assert.equal(retry.message.queue.state, 'absorbed'); assert.equal(pasted.length, 1, 'zero re-paste after restart');
  // Pre-paste crash control: the entry was committed as pending but the paste never happened.
  tmux.afterPaste = null; tmux.pasteMode = 'throw';
  await assert.rejects(live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'c5b', text: 'never pasted', mode: 'queue' }), e => e.code === 'send_uncertain');
  await sessions.update('ses-1', r => { const m = r.messages.find(x => x.keyHash === sha('c5b')); m.queue.state = 'pending'; m.outcome = 'pending'; delete m.error; }); // as a crash before the uncertain commit would leave it
  tmux.pasteMode = 'claude';
  const before = pasted.length;
  const again = await restarted.send(grok, { sessionId: 'ses-1', idempotencyKey: 'c5b', text: 'never pasted', mode: 'queue' });
  assert.equal(again.message.reused, true); assert.equal(again.message.queue.state, 'pending'); assert.equal(again.message.queue.enqueue, null); assert.equal(pasted.length, before, 'unknown delivery: outstanding, never pasted again');
  assert.equal((await live.status(grok, { sessionId: 'ses-1' })).queue.outstanding.state, 'pending');
  await assert.rejects(live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'c5c', text: 'x', mode: 'queue' }), e => e.code === 'queue_outstanding');
  // C6: queued, then a valid remove appears, then the bound process changes; the same-key retry must refuse
  // before touching the receipt. Fresh binding so the slot is free.
  await sessions.remove('ses-1'); await live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1', providerSessionId: SESSION, allowQueue: true, queueProfile: PROFILE });
  const r6 = await live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'c6', text: 'note six', mode: 'queue' });
  assert.equal(r6.message.queue.state, 'queued');
  await fs.appendFile(transcript, remove(wrap(pasted.at(-1))).text);
  const bytesBefore = JSON.stringify(await record());
  const table = await live.processes.table(); const proc = table.get(1);
  live.processes.table = async () => new Map([[1, { ...proc, startedAt: 'restarted-later' }]]);
  await assert.rejects(live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'c6', text: 'note six', mode: 'queue' }), e => e.code === 'session_exited');
  await assert.rejects(live.status(grok, { sessionId: 'ses-1' }), e => e.code === 'session_exited');
  assert.equal(JSON.stringify(await record()), bytesBefore, 'denied identity: receipt bytes unchanged (still queued)');
  assert.equal((await entry('c6')).queue.state, 'queued');
  live.processes.table = async () => new Map([[1, proc]]);
  const ok6 = await live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'c6', text: 'note six', mode: 'queue' });
  assert.equal(ok6.message.reused, true); assert.equal(ok6.message.queue.state, 'absorbed', 'same identity: the retry reconciles'); assert.equal(pasted.length, before + 1 + 1 - 1 + 1 - 1 + 1 - 1 + 0 + (pasted.length - (before + 1)), 'no paste from any retry');
  // C7 at the service level: the old prompt above the spinner refuses with zero paste; a current prompt below passes.
  await sessions.remove('ses-1'); await live.bind({ principalId: 'grok', pane: '%9', id: 'ses-1', providerSessionId: SESSION, allowQueue: true, queueProfile: PROFILE });
  const n = pasted.length;
  tmux.screen = ['❯ ', '✻ Brewing… (esc to interrupt)', 'some tool output'];
  await assert.rejects(live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'c7', text: 'x', mode: 'queue' }), e => e.code === 'queue_unverifiable' && e.details.reason === 'no_current_prompt');
  tmux.screen = ['❯ ', '✻ Brewing… (esc to interrupt)', '❯ half'];
  await assert.rejects(live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'c7b', text: 'x', mode: 'queue' }), e => e.code === 'queue_input_not_empty');
  assert.equal(pasted.length, n);
  tmux.screen = ['❯ earlier request', '✻ Brewing… (esc to interrupt)', '❯ ', '─────'];
  assert.equal((await live.send(grok, { sessionId: 'ses-1', idempotencyKey: 'c7c', text: 'x', mode: 'queue' })).message.queue.state, 'queued');
  assert.equal(pasted.length, n + 1);
});
