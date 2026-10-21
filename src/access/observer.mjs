import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invariant } from '../errors.mjs';
import { readJson, writeJsonAtomic } from '../state.mjs';
import { classifyScreen } from './sessions.mjs';

// Automatic end-of-turn signal for bound live sessions, in two grades:
//
//  - agent.turn_finished from the provider's own record. For a Claude Code session whose provider
//    session id is known (recorded at bind from `claude --resume <uuid>` or given by the operator),
//    the observer tails that session's transcript file read-only and emits one event per logical
//    model turn that ended with stop_reason end_turn, keyed by the provider message id (several
//    content rows share one message id; they are one turn). A baseline is taken when observation
//    starts, so history is never replayed; the read cursor stops at the last complete line, so a
//    partial tail is simply read later; a shrunken file is recorded as a reset and emits nothing.
//    Only identity and timing leave the file: never message bodies.
//
//  - session.ready from the screen (working → ready), the fallback where no native source exists.
//    It is labelled as a screen observation; the screen often shows "ready" between tool calls while
//    the provider's turn is still running, so it is never presented as a turn boundary.
//
// In both grades the pending emission is persisted before the store is called, so a transient store
// failure retries the same identity and a crash between event and state save re-derives it and is
// deduplicated. Nothing here types into a session or edits any agent's hook configuration.

const END_TURN = 'end_turn';
const MAX_TAIL_BYTES = 8 * 1048576;

export function claudeTranscriptPath(home, cwd, sessionId) {
  const encoded = path.resolve(cwd).replace(/[\\/]/g, '-');
  return path.join(home, 'projects', encoded, `${sessionId}.jsonl`);
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

  // Emits (or re-emits) one persisted pending signal. The store deduplicates by identity.
  async _emit(record, observation, pending) {
    try {
      const result = await this.coop.observe({ sessionId: record.id, bindingId: record.bindingId, transitionId: pending.transitionId, observedAt: pending.observedAt, type: pending.type, fromState: 'busy', toState: 'idle', signal: pending.signal || null });
      observation.emitFailures = 0;
      return { eventId: result.event.eventId, reused: result.reused, transitionId: pending.transitionId, type: pending.type, done: true };
    } catch (error) {
      observation.emitFailures = (observation.emitFailures || 0) + 1;
      if (['session_not_found', 'permission_denied', 'invalid_event', 'legacy_migration_required'].includes(error.code)) return { error: error.code, dropped: true, transitionId: pending.transitionId, type: pending.type, done: true };
      return { error: error.code || 'observe_failed', retry: true, transitionId: pending.transitionId, type: pending.type, done: false };
    }
  }

  // Reads new complete lines of the Claude transcript since the cursor. Returns end_turn message
  // identities (deduplicated), the new cursor, and whether the file shrank or disappeared.
  async _nativeTurns(record, observation) {
    const provider = record.providerSession;
    const file = provider.transcriptPath || claudeTranscriptPath(this.claudeHome, record.project, provider.sessionId);
    let stat;
    try { stat = await fs.stat(file); } catch { return { status: 'missing', turns: [], cursor: observation.nativeCursor ?? null }; }
    if (observation.nativeCursor === null || observation.nativeCursor === undefined) return { status: 'baseline', turns: [], cursor: stat.size }; // no history replay
    if (stat.size < observation.nativeCursor) return { status: 'reset', turns: [], cursor: stat.size };
    if (stat.size === observation.nativeCursor) return { status: 'unchanged', turns: [], cursor: stat.size };
    const length = Math.min(stat.size - observation.nativeCursor, MAX_TAIL_BYTES);
    const handle = await fs.open(file, 'r');
    let buffer;
    try { buffer = Buffer.alloc(length); await handle.read(buffer, 0, length, observation.nativeCursor); } finally { await handle.close(); }
    const text = buffer.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline < 0) return { status: 'partial', turns: [], cursor: observation.nativeCursor }; // a torn line is read next time
    const complete = text.slice(0, lastNewline + 1);
    const consumed = Buffer.byteLength(complete);
    const turns = new Map();
    for (const line of complete.split('\n')) {
      if (!line) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row?.type !== 'assistant' || row.isSidechain || row?.message?.stop_reason !== END_TURN) continue;
      if (typeof row.sessionId === 'string' && row.sessionId !== provider.sessionId) continue;
      const messageId = row.message?.id;
      if (typeof messageId !== 'string' || !messageId) continue;
      if (!turns.has(messageId)) turns.set(messageId, { providerMessageId: messageId, providerTimestamp: typeof row.timestamp === 'string' ? row.timestamp : null });
    }
    return { status: 'read', turns: [...turns.values()], cursor: observation.nativeCursor + consumed };
  }

  // One pass over every binding. Returns what happened so a CLI one-shot can print it.
  async tick() {
    const results = [];
    for (const record of await this.sessions.sessions.list()) {
      if (typeof record.bindingId !== 'string') { results.push({ sessionId: record.id, skipped: 'legacy_binding' }); continue; }
      const previous = await readJson(this._file(record.id), { optional: true });
      const observation = previous && previous.bindingId === record.bindingId ? previous : { bindingId: record.bindingId, lastState: null, lastBusyAt: null, pending: [], lastEmitted: {}, nativeCursor: null, nativeResets: 0, observations: 0, emitFailures: 0 };
      let state;
      try { await this.sessions._identity(record); state = classifyScreen(record.agent.kind, await this.sessions.tmux.captureScreen(record.paneId)).state; }
      catch (error) { results.push({ sessionId: record.id, skipped: error.code || 'identity_failed' }); continue; }
      const at = new Date().toISOString();
      const native = record.providerSession?.kind === 'claude' && typeof record.providerSession.sessionId === 'string';
      let nativeStatus = null;
      if (native) {
        const read = await this._nativeTurns(record, observation);
        nativeStatus = read.status;
        if (read.status === 'reset') observation.nativeResets += 1;
        observation.nativeCursor = read.cursor;
        for (const turn of read.turns) {
          const transitionId = SessionObserver.turnId(record.bindingId, turn.providerMessageId);
          if (observation.lastEmitted[transitionId] || observation.pending.some(p => p.transitionId === transitionId)) continue;
          observation.pending.push({ type: 'agent.turn_finished', transitionId, observedAt: at, signal: { source: 'native_end_turn', provider: 'claude', providerSessionId: record.providerSession.sessionId, providerMessageId: turn.providerMessageId, providerTimestamp: turn.providerTimestamp } });
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
      results.push({ sessionId: record.id, state, native: native ? nativeStatus : 'unavailable', emitted: emitted.length ? emitted : null });
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
