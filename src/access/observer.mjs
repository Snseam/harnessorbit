import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invariant } from '../errors.mjs';
import { readJson, writeJsonAtomic } from '../state.mjs';
import { classifyScreen, readCodexRolloutHeader, parseCodexRolloutHeader, claudeTranscriptPath } from './sessions.mjs';

// Automatic end-of-turn signal for bound live sessions, in two grades:
//
//  - agent.turn_finished from the provider's own record. For a Claude Code session whose provider
//    session id is known (recorded at bind from `claude --resume <uuid>` or given by the operator),
//    the observer tails that session's transcript file read-only and emits one event per logical
//    model turn that ended with stop_reason end_turn, keyed by the provider message id (several
//    content rows share one message id; they are one turn). A baseline is taken when observation
//    starts, so history is never replayed; the read cursor stops at the last complete line, so a
//    partial tail is simply read later; a line larger than the read window is skipped as a whole
//    with a recorded count so later turns still arrive; a shrunken file or a replaced file (new
//    inode) is a recorded reset of the source generation, and rows older than the observation
//    baseline are never emitted after it. Only identity and timing leave the file: never bodies.
//
//  - session.ready from the screen (working → ready), the fallback where no native source exists.
//    It is labelled as a screen observation; the screen often shows "ready" between tool calls while
//    the provider's turn is still running, so it is never presented as a turn boundary.
//
// Observation state written by the first pilot (pendingTransition / lastEmittedTransitionId) is
// migrated in place: its pending screen transition stays pending as screen-grade readiness, its
// already committed event is found by the old identity and reused, and nothing from it ever
// becomes native evidence. Pending emissions are persisted before the store is called, so a
// transient failure retries the same identity and a crash between event and state save re-derives
// it. Nothing here types into a session or edits any agent's hook configuration.

const END_TURN = 'end_turn';
// Codex event_msg payload types seen as ordinary progress rows in the sampled rollout (not terminals).
const CODEX_NON_TERMINAL = new Set(['task_started', 'task_complete', 'agent_message', 'agent_message_delta', 'agent_reasoning', 'agent_reasoning_delta', 'agent_reasoning_section_break', 'token_count', 'item_started', 'item_updated', 'item_completed', 'exec_command_begin', 'exec_command_output_delta', 'exec_command_end', 'mcp_tool_call_begin', 'mcp_tool_call_end', 'patch_apply_begin', 'patch_apply_end', 'plan_update', 'web_search_begin', 'web_search_end']);
const MAX_TAIL_BYTES = 8 * 1048576;
const SCAN_CHUNK = 1048576;
const OBSERVATION_VERSION = 2;

export { claudeTranscriptPath };

// Brings a stored observation to the current shape without losing pending work.
export function migrateObservation(previous, at) {
  if (!previous) return null;
  if (previous.version === OBSERVATION_VERSION && Array.isArray(previous.pending)) return previous;
  const pending = [];
  if (previous.pendingTransition?.transitionId) pending.push({ type: 'session.ready', transitionId: previous.pendingTransition.transitionId, observedAt: previous.pendingTransition.readyAt || at, legacy: true });
  const lastEmitted = { ...(previous.lastEmitted || {}) };
  if (previous.lastEmittedTransitionId) lastEmitted[previous.lastEmittedTransitionId] = previous.observedAt || at;
  return {
    version: OBSERVATION_VERSION, bindingId: previous.bindingId, lastState: previous.lastState ?? null, lastBusyAt: previous.lastBusyAt ?? null,
    pending: Array.isArray(previous.pending) ? [...previous.pending, ...pending] : pending, lastEmitted,
    nativeCursor: previous.nativeCursor ?? null, nativeIdentity: previous.nativeIdentity ?? null, nativeBaselineAt: previous.nativeBaselineAt ?? null, nativeResets: previous.nativeResets ?? 0, oversizedSkipped: previous.oversizedSkipped ?? 0,
    observations: previous.observations ?? 0, emitFailures: previous.emitFailures ?? 0, migratedFrom: previous.version ?? 1,
  };
}

export class SessionObserver {
  constructor({ root, sessions, coop, intervalMs = 5000, claudeHome = path.join(os.homedir(), '.claude'), log = () => {} } = {}) {
    invariant(typeof root === 'string' && root.length > 0, 'invalid_state_root', 'Observer root is required.');
    invariant(sessions && coop, 'invalid_observer', 'Observer requires the session and coop services.');
    invariant(Number.isInteger(intervalMs) && intervalMs >= 1000 && intervalMs <= 300000, 'invalid_observer', 'intervalMs must be 1000 to 300000.');
    this.root = path.resolve(root); this.sessions = sessions; this.coop = coop; this.intervalMs = intervalMs; this.claudeHome = claudeHome; this.log = log;
    this.directory = path.join(this.root, 'access', 'coop', 'observations');
    this.stopped = false;
  }

  _file(sessionId) { return path.join(this.directory, `${sessionId}.json`); }

  static transitionId(bindingId, busyAt) { return crypto.createHash('sha256').update(`${bindingId}:${busyAt}`).digest('hex').slice(0, 32); }
  static turnId(bindingId, providerMessageId) { return crypto.createHash('sha256').update(`${bindingId}:native:${providerMessageId}`).digest('hex').slice(0, 32); }

  _fresh(record) {
    return { version: OBSERVATION_VERSION, bindingId: record.bindingId, lastState: null, lastBusyAt: null, pending: [], lastEmitted: {}, nativeCursor: null, nativeIdentity: null, nativeBaselineAt: null, nativeResets: 0, oversizedSkipped: 0, observations: 0, emitFailures: 0 };
  }

  // Emits (or re-emits) one persisted pending signal. The store deduplicates by identity.
  async _emit(record, observation, pending) {
    try {
      const result = await this.coop.observe({ sessionId: record.id, bindingId: record.bindingId, transitionId: pending.transitionId, observedAt: pending.observedAt, type: pending.type, fromState: 'busy', toState: 'idle', signal: pending.signal || null, legacy: pending.legacy === true });
      observation.emitFailures = 0;
      return { eventId: result.event.eventId, reused: result.reused, transitionId: pending.transitionId, type: pending.type, done: true };
    } catch (error) {
      observation.emitFailures = (observation.emitFailures || 0) + 1;
      if (['session_not_found', 'permission_denied', 'invalid_event', 'legacy_migration_required'].includes(error.code)) return { error: error.code, dropped: true, transitionId: pending.transitionId, type: pending.type, done: true };
      return { error: error.code || 'observe_failed', retry: true, transitionId: pending.transitionId, type: pending.type, done: false };
    }
  }

  // Finds the first newline at or after `from`, scanning in bounded chunks. Returns its absolute
  // offset or -1 when the file ends first.
  async _nextNewline(handle, from, size) {
    let position = from;
    const chunk = Buffer.alloc(SCAN_CHUNK);
    while (position < size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(SCAN_CHUNK, size - position), position);
      if (!bytesRead) return -1;
      const index = chunk.subarray(0, bytesRead).indexOf(0x0a);
      if (index >= 0) return position + index;
      position += bytesRead;
    }
    return -1;
  }

  // Where a provider's native record lives. Claude: the transcript under the Claude home for this
  // checkout and session. Codex: only the rollout the live process chain was seen holding open at
  // bind; there is no derived path and never a guess.
  _nativeFile(record) {
    const provider = record.providerSession;
    if (provider.kind === 'claude') return provider.transcriptPath || claudeTranscriptPath(this.claudeHome, record.project, provider.sessionId);
    return typeof provider.transcriptPath === 'string' ? provider.transcriptPath : null;
  }

  // Reads new complete lines of the provider's native record since the cursor. Returns finished-turn
  // identities (deduplicated), the new cursor, and what happened to the source.
  async _nativeTurns(record, observation, at) {
    const provider = record.providerSession;
    const file = this._nativeFile(record);
    if (!file) return { status: 'source_unavailable', turns: [], cursor: observation.nativeCursor ?? null, identity: observation.nativeIdentity ?? null, baselineAt: observation.nativeBaselineAt ?? null };
    let stat;
    try { stat = await fs.stat(file); } catch { return { status: 'missing', turns: [], cursor: observation.nativeCursor ?? null, identity: observation.nativeIdentity ?? null, baselineAt: observation.nativeBaselineAt ?? null }; }
    const identity = { dev: stat.dev, ino: stat.ino };
    const sameIdentity = !observation.nativeIdentity || (observation.nativeIdentity.dev === identity.dev && observation.nativeIdentity.ino === identity.ino);
    if (observation.nativeCursor === null || observation.nativeCursor === undefined) {
      // No history replay. A Codex rollout is also re-validated by its header before the baseline is taken.
      if (provider.kind === 'codex') { const header = await readCodexRolloutHeader(file, { sessionId: provider.sessionId, project: record.project }); if (!header.ok) return { status: 'source_identity_mismatch', reason: header.reason, turns: [], cursor: null, identity: null, baselineAt: null }; }
      return { status: 'baseline', turns: [], cursor: stat.size, identity, baselineAt: at };
    }
    const baselineAt = observation.nativeBaselineAt ?? at;
    if (!sameIdentity) {
      // A replaced file is a new source generation: read it from its start, but only rows written
      // after observation began are candidates; older rows are history and are never emitted. For
      // Codex, _readRows verifies the header of the very handle it reads from; a mismatch keeps the
      // old cursor and identity and reads nothing (the operator rebinds).
      const read = await this._readRows(file, 0, stat.size, record, baselineAt, observation);
      if (read.status === 'source_identity_mismatch') return { ...read, cursor: observation.nativeCursor, identity: observation.nativeIdentity, baselineAt, reset: 'identity_changed' };
      return { ...read, status: 'reset', identity, baselineAt, reset: 'identity_changed' };
    }
    if (stat.size < observation.nativeCursor) {
      if (provider.kind === 'codex') { const header = await readCodexRolloutHeader(file, { sessionId: provider.sessionId, project: record.project }); if (!header.ok) return { status: 'source_identity_mismatch', reason: header.reason, turns: [], cursor: observation.nativeCursor, identity, baselineAt, reset: 'shrunk' }; }
      return { status: 'reset', turns: [], cursor: stat.size, identity, baselineAt, reset: 'shrunk' };
    }
    if (stat.size === observation.nativeCursor) {
      // Nothing new to consume, but a same-inode rewrite to exactly the old size would otherwise go
      // unnoticed until the next append; for Codex the header is verified even here.
      if (provider.kind === 'codex') {
        const handle = await fs.open(file, 'r');
        let header; try { header = await this._codexHeaderFromHandle(handle, stat.size, record); } finally { await handle.close(); }
        if (!header.ok) return { status: 'source_identity_mismatch', reason: header.reason, turns: [], cursor: observation.nativeCursor, identity, baselineAt };
      }
      return { status: 'unchanged', turns: [], cursor: stat.size, identity, baselineAt };
    }
    // Every incremental read re-verifies the source header from the same handle: a same-inode
    // truncate-and-rewrite to an equal or larger size shows neither a new inode nor a shrink.
    return { ...(await this._readRows(file, observation.nativeCursor, stat.size, record, baselineAt, observation)), identity, baselineAt };
  }

  // Header check for a Codex rollout from an already opened handle: the first line must be this
  // session's session_meta for this checkout. Bounded to the first 64 KiB.
  async _codexHeaderFromHandle(handle, size, record) {
    const buffer = Buffer.alloc(Math.min(size, 65536));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const nl = text.indexOf('\n');
    if (nl < 0) return { ok: false, reason: bytesRead >= 65536 ? 'header_oversized' : 'header_incomplete' };
    const parsed = parseCodexRolloutHeader(text.slice(0, nl), { sessionId: record.providerSession.sessionId, project: record.project });
    if (!parsed.ok) return parsed;
    let real = parsed.cwd; try { real = await fs.realpath(parsed.cwd); } catch { /* compare raw */ }
    if (real !== record.project) return { ok: false, reason: 'header_cwd_mismatch' };
    return { ok: true };
  }

  // One provider's finished-turn rule over one parsed row. Returns null for every row that is not
  // the provider's own terminal success marker: assistant text, tool rows, item completions, token
  // counts, turn starts and any unsampled terminal variant never finish a turn here.
  static finishedTurn(provider, row) {
    if (!row || typeof row !== 'object') return null;
    if (provider.kind === 'claude') {
      if (row.type !== 'assistant' || row.isSidechain || row.message?.stop_reason !== END_TURN) return null;
      if (typeof row.sessionId === 'string' && row.sessionId !== provider.sessionId) return null;
      const messageId = row.message?.id;
      if (typeof messageId !== 'string' || !messageId) return null;
      return { key: messageId, signal: { source: 'native_end_turn', provider: 'claude', providerSessionId: provider.sessionId, providerMessageId: messageId }, timestamp: typeof row.timestamp === 'string' ? row.timestamp : null };
    }
    if (provider.kind === 'codex') {
      // Observed Codex CLI 0.163.0 normal completion: top-level event_msg whose payload.type is
      // task_complete with a non-empty turn_id. msg_* response ids are not turn ids and are not used.
      if (row.type !== 'event_msg' || row.payload?.type !== 'task_complete') return null;
      const turnId = row.payload.turn_id;
      if (typeof turnId !== 'string' || !turnId.trim()) return null;
      return { key: `codex:${provider.sessionId}:${turnId}`, signal: { source: 'native_task_complete', provider: 'codex', providerSessionId: provider.sessionId, providerTurnId: turnId, nativeTerminal: 'event_msg:task_complete', outcome: 'completed' }, timestamp: typeof row.timestamp === 'string' ? row.timestamp : null };
    }
    return null;
  }

  async _readRows(file, cursor, size, record, baselineAt, observation) {
    const provider = record.providerSession;
    const length = Math.min(size - cursor, MAX_TAIL_BYTES);
    const handle = await fs.open(file, 'r');
    try {
      if (provider.kind === 'codex') {
        // Same handle, same bytes: the header is checked before any new byte of this read is consumed.
        const header = await this._codexHeaderFromHandle(handle, size, record);
        if (!header.ok) return { status: 'source_identity_mismatch', reason: header.reason, turns: [], cursor };
      }
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, cursor);
      const text = buffer.toString('utf8');
      let lastNewline = text.lastIndexOf('\n');
      let skipped = 0;
      if (lastNewline < 0) {
        if (length < MAX_TAIL_BYTES) return { status: 'partial', turns: [], cursor }; // an ordinary torn line; read it next time
        // One line is larger than the whole read window. Skip it as a unit, keeping the bound, and
        // record that a line was skipped so the gap is explicit.
        const newline = await this._nextNewline(handle, cursor + length, size);
        if (newline < 0) return { status: 'partial', turns: [], cursor, oversized: true }; // still being written
        observation.oversizedSkipped = (observation.oversizedSkipped || 0) + 1;
        return { status: 'skipped_oversized', turns: [], cursor: newline + 1, skipped: 1 };
      }
      const complete = text.slice(0, lastNewline + 1);
      const consumed = Buffer.byteLength(complete);
      const turns = new Map();
      let otherTerminals = 0;
      for (const line of complete.split('\n')) {
        if (!line) continue;
        if (line.length > MAX_TAIL_BYTES) { skipped += 1; continue; }
        let row; try { row = JSON.parse(line); } catch { continue; }
        const finished = SessionObserver.finishedTurn(provider, row);
        if (!finished) {
          // Codex event_msg rows that are neither a start nor the sampled completion are counted as
          // unverified outcomes (failure/cancel formats were not sampled); they never become success.
          if (provider.kind === 'codex' && row?.type === 'event_msg' && typeof row.payload?.type === 'string' && !CODEX_NON_TERMINAL.has(row.payload.type)) otherTerminals += 1;
          continue;
        }
        if (baselineAt && finished.timestamp && finished.timestamp < baselineAt) continue; // history relative to observation start
        if (!turns.has(finished.key)) turns.set(finished.key, { key: finished.key, signal: { ...finished.signal, providerTimestamp: finished.timestamp } });
      }
      if (skipped) observation.oversizedSkipped = (observation.oversizedSkipped || 0) + skipped;
      if (otherTerminals) observation.unverifiedTerminals = (observation.unverifiedTerminals || 0) + otherTerminals;
      return { status: 'read', turns: [...turns.values()], cursor: cursor + consumed, skipped };
    } finally { await handle.close(); }
  }

  // One pass over every binding. Returns what happened so a CLI one-shot can print it.
  async tick() {
    const results = [];
    for (const record of await this.sessions.sessions.list()) {
      if (typeof record.bindingId !== 'string') { results.push({ sessionId: record.id, skipped: 'legacy_binding' }); continue; }
      const at = new Date().toISOString();
      const previous = await readJson(this._file(record.id), { optional: true });
      const observation = previous && previous.bindingId === record.bindingId ? migrateObservation(previous, at) : this._fresh(record);
      let state;
      try { await this.sessions._identity(record); state = classifyScreen(record.agent.kind, await this.sessions.tmux.captureScreen(record.paneId)).state; }
      catch (error) { results.push({ sessionId: record.id, skipped: error.code || 'identity_failed' }); continue; }
      const native = ['claude', 'codex'].includes(record.providerSession?.kind) && typeof record.providerSession.sessionId === 'string';
      let nativeStatus = native ? null : (record.nativeDiagnostic ? `unavailable:${record.nativeDiagnostic.reason || record.nativeDiagnostic.status}` : 'unavailable');
      if (native) {
        const read = await this._nativeTurns(record, observation, at);
        nativeStatus = read.status === 'source_identity_mismatch' ? `source_identity_mismatch:${read.reason}` : read.status;
        if (read.status === 'reset' || read.status === 'source_identity_mismatch') observation.nativeResets += 1;
        if (read.status === 'baseline') observation.nativeBaselineAt = read.baselineAt;
        if (read.status !== 'source_identity_mismatch') { observation.nativeCursor = read.cursor; observation.nativeIdentity = read.identity ?? observation.nativeIdentity; }
        else observation.nativeMismatch = { at, reason: read.reason };
        for (const turn of read.turns) {
          // Claude keeps its identity (binding + provider message id); Codex is keyed by provider, session and native turn id.
          const transitionId = SessionObserver.turnId(record.bindingId, turn.key);
          if (observation.lastEmitted[transitionId] || observation.pending.some(p => p.transitionId === transitionId)) continue;
          observation.pending.push({ type: 'agent.turn_finished', transitionId, observedAt: at, signal: turn.signal });
        }
      }
      // Screen fallback: a working → ready transition is a session.ready observation only.
      if (state === 'busy' && observation.lastState !== 'busy') observation.lastBusyAt = at;
      if (state === 'idle' && observation.lastState === 'busy' && observation.lastBusyAt) {
        const transitionId = SessionObserver.transitionId(record.bindingId, observation.lastBusyAt);
        if (!observation.lastEmitted[transitionId] && !observation.pending.some(p => p.transitionId === transitionId)) observation.pending.push({ type: 'session.ready', transitionId, observedAt: at });
      }
      observation.lastState = state; observation.observedAt = at; observation.observations += 1;
      // Persist pending identities before emitting: a crash after the event but before this save
      // re-derives the same identities and the store answers reused.
      await writeJsonAtomic(this._file(record.id), observation);
      const emitted = [];
      for (const pending of [...observation.pending]) {
        const outcome = await this._emit(record, observation, pending);
        emitted.push(outcome);
        if (outcome.done) { observation.pending = observation.pending.filter(p => p.transitionId !== pending.transitionId); if (!outcome.error) observation.lastEmitted[pending.transitionId] = at; }
        await writeJsonAtomic(this._file(record.id), observation);
      }
      results.push({ sessionId: record.id, state, native: nativeStatus, emitted: emitted.length ? emitted : null });
      if (emitted.length) this.log({ sessionId: record.id, emitted });
    }
    return results;
  }

  async run({ ticks = Infinity } = {}) {
    let count = 0;
    while (!this.stopped && count < ticks) {
      try { await this.tick(); } catch (error) { this.log({ error: error.code || 'tick_failed' }); }
      count += 1;
      if (this.stopped || count >= ticks) break;
      // The interval timer keeps the observer process alive between ticks (never unref'd); stop()
      // cancels it so a signal ends the loop at once instead of after the interval.
      await new Promise(resolve => { this.waiting = { timer: setTimeout(() => { this.waiting = null; resolve(); }, this.intervalMs), resolve }; });
    }
  }

  stop() {
    this.stopped = true;
    if (this.waiting) { clearTimeout(this.waiting.timer); const { resolve } = this.waiting; this.waiting = null; resolve(); }
  }
}
