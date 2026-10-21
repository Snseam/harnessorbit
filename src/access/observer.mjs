import crypto from 'node:crypto';
import path from 'node:path';
import { invariant } from '../errors.mjs';
import { readJson, writeJsonAtomic } from '../state.mjs';
import { classifyScreen } from './sessions.mjs';

// Bounded observer for bound live sessions. It watches each binding's screen state and, when a
// session it saw working becomes ready again, records one agent.turn_finished event through the
// cooperation store. The transition identity is derived from stable facts persisted before the
// emission (binding id and the moment the session was last seen working), so a crash between
// the event and the state save, a transient store failure, or a repeated poll cannot emit the same
// transition twice or lose it: a pending transition is retried until the store confirms it. An
// initial idle snapshot is never a transition. The observer never types into a session and never
// edits any agent's hook configuration; it only reads the screen.

export class SessionObserver {
  constructor({ root, sessions, coop, intervalMs = 5000, log = () => {} } = {}) {
    invariant(typeof root === 'string' && root.length > 0, 'invalid_state_root', 'Observer root is required.');
    invariant(sessions && coop, 'invalid_observer', 'Observer requires the session and coop services.');
    invariant(Number.isInteger(intervalMs) && intervalMs >= 1000 && intervalMs <= 300000, 'invalid_observer', 'intervalMs must be 1000 to 300000.');
    this.root = path.resolve(root); this.sessions = sessions; this.coop = coop; this.intervalMs = intervalMs; this.log = log;
    this.directory = path.join(this.root, 'access', 'coop', 'observations');
    this.stopped = false;
  }

  _file(sessionId) { return path.join(this.directory, `${sessionId}.json`); }

  static transitionId(bindingId, busyAt) { return crypto.createHash('sha256').update(`${bindingId}:${busyAt}`).digest('hex').slice(0, 32); }

  // Emits (or re-emits) the persisted pending transition. The store deduplicates by transition
  // identity, so a retry after a crash answers reused instead of creating a second event.
  async _emit(record, observation) {
    const pending = observation.pendingTransition;
    try {
      const result = await this.coop.observe({ sessionId: record.id, bindingId: record.bindingId, transitionId: pending.transitionId, observedAt: pending.readyAt, fromState: 'busy', toState: 'idle' });
      observation.lastEmittedTransitionId = pending.transitionId;
      observation.pendingTransition = null;
      observation.emitFailures = 0;
      return { eventId: result.event.eventId, reused: result.reused, transitionId: pending.transitionId };
    } catch (error) {
      observation.emitFailures = (observation.emitFailures || 0) + 1;
      if (['session_not_found', 'permission_denied', 'invalid_event', 'legacy_migration_required'].includes(error.code)) {
        // Not transient: the binding or its principal changed. Drop the pending transition; the
        // reason is reported, not retried forever.
        observation.pendingTransition = null;
        return { error: error.code, dropped: true, transitionId: pending.transitionId };
      }
      return { error: error.code || 'observe_failed', retry: true, transitionId: pending.transitionId };
    }
  }

  // One pass over every binding. Returns what happened so a CLI one-shot can print it.
  async tick() {
    const results = [];
    for (const record of await this.sessions.sessions.list()) {
      if (typeof record.bindingId !== 'string') { results.push({ sessionId: record.id, skipped: 'legacy_binding' }); continue; }
      const previous = await readJson(this._file(record.id), { optional: true });
      const observation = previous && previous.bindingId === record.bindingId ? previous : { bindingId: record.bindingId, lastState: null, lastBusyAt: null, pendingTransition: null, lastEmittedTransitionId: null, observations: 0, emitFailures: 0 };
      let state;
      try { await this.sessions._identity(record); state = classifyScreen(record.agent.kind, await this.sessions.tmux.captureScreen(record.paneId)).state; }
      catch (error) { results.push({ sessionId: record.id, skipped: error.code || 'identity_failed' }); continue; }
      const at = new Date().toISOString();
      if (state === 'busy' && observation.lastState !== 'busy') observation.lastBusyAt = at; // the moment this working stretch began
      if (state === 'idle' && observation.lastState === 'busy' && observation.lastBusyAt && !observation.pendingTransition) {
        const transitionId = SessionObserver.transitionId(record.bindingId, observation.lastBusyAt);
        if (transitionId !== observation.lastEmittedTransitionId) observation.pendingTransition = { transitionId, busyAt: observation.lastBusyAt, readyAt: at };
      }
      observation.lastState = state; observation.observedAt = at; observation.observations += 1;
      // Persist the pending transition before emitting: a crash after the event but before this
      // save would otherwise re-derive nothing or something new; now it re-derives the same id.
      await writeJsonAtomic(this._file(record.id), observation);
      let emitted = null;
      if (observation.pendingTransition) {
        emitted = await this._emit(record, observation);
        await writeJsonAtomic(this._file(record.id), observation);
      }
      results.push({ sessionId: record.id, state, emitted });
      if (emitted) this.log({ sessionId: record.id, emitted });
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
