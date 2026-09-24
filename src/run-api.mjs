import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { OrchestratorError, invariant } from './errors.mjs';
import * as state from './state.mjs';
import { normalizeRuntimeEvent, summarizeRun } from './runtime-contract.mjs';

const MAX_EVENTS = 512;

export class RunApi {
  constructor({ root } = {}) {
    invariant(typeof root === 'string' && root.length > 0, 'run_api_invalid_root', 'Run API state root is required.');
    this.root = path.resolve(root);
  }

  async get(runId) {
    const run = await state.loadRun(this.root, runId);
    if (!run) throw new OrchestratorError('run_not_found', `Run ${runId} does not exist.`);
    return run;
  }

  async status(runId) {
    return summarizeRun(await this.get(runId));
  }

  async events(runId, { limit = MAX_EVENTS } = {}) {
    state.validateId(runId);
    invariant(Number.isInteger(limit) && limit > 0 && limit <= MAX_EVENTS, 'run_api_invalid_limit', 'Event limit is invalid.');
    const file = path.join(state.runPath(this.root, runId), 'events.jsonl');
    let text;
    try { text = await readFile(file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new OrchestratorError('run_events_read_failed', 'Failed to read run events.', { cause: error.code || 'read_failed' });
    }
    const lines = text.split('\n').filter(Boolean);
    const offset = Math.max(0, lines.length - limit);
    return lines.slice(offset).map((line, index) => {
      let event;
      try { event = JSON.parse(line); }
      catch {
        throw new OrchestratorError('run_events_malformed', 'Run event log contains malformed JSON.', { line: offset + index + 1 });
      }
      try {
        return normalizeRuntimeEvent(event, { runId, eventId: `${runId}:${offset + index + 1}` });
      } catch (error) {
        throw new OrchestratorError('run_events_malformed', 'Run event log contains an invalid event.', {
          line: offset + index + 1,
          cause: error.code || 'invalid_event',
        });
      }
    });
  }
}
