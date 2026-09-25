import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invariant } from './errors.mjs';
import { loadRun, validateId } from './state.mjs';
import { defaultStateRoot } from './orchestrator.mjs';
import { Tokscale } from './runtime/tokscale.mjs';

export const usageClients = ['claude', 'codex', 'pi', 'opencode'];
const buckets = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];
const emptyTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, messages: 0 });
const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ');

function validDate(value) {
  if (value === undefined) return null;
  invariant(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'invalid_arguments', 'Dates must use YYYY-MM-DD.');
  const date = new Date(`${value}T00:00:00Z`);
  invariant(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value, 'invalid_arguments', `Invalid calendar date: ${value}`);
  return value;
}

export function validateUsageOptions(input = {}, now = new Date()) {
  const clients = input.agent === undefined ? [...usageClients] : [...new Set(String(input.agent).split(',').map(x => x.trim()))];
  invariant(clients.length && clients.every(c => usageClients.includes(c)), 'invalid_arguments', `--agent accepts: ${usageClients.join(', ')}.`);
  invariant(!input.task || input.run, 'invalid_arguments', '--task requires --run.');
  if (input.run !== undefined) validateId(input.run);
  if (input.task !== undefined) validateId(input.task);
  invariant(!(input.today && (input.since !== undefined || input.until !== undefined)), 'invalid_arguments', '--today cannot be combined with --since or --until.');
  let since = validDate(input.since), until = validDate(input.until);
  if (input.today) since = until = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  invariant(!since || !until || since <= until, 'invalid_arguments', '--since must not be later than --until.');
  invariant(input.model === undefined || (typeof input.model === 'string' && input.model.length > 0 && input.model.length <= 512 && !/[\x00-\x1f\x7f]/.test(input.model)), 'invalid_arguments', '--model must be a nonempty model identifier.');
  invariant(input.home === undefined || (typeof input.home === 'string' && input.home.length > 0 && !input.home.includes('\0')), 'invalid_arguments', '--home must be a directory path.');
  return { clients, model: input.model || null, since, until, home: path.resolve(input.home || os.homedir()), runId: input.run || null, taskId: input.task || null };
}

function sum(rows) {
  const result = emptyTokens();
  for (const row of rows) {
    for (const key of [...buckets, 'messages']) {
      invariant(Number.isSafeInteger(row[key]) && row[key] >= 0, 'usage_invalid_counter', 'Usage counters must be nonnegative safe integers.');
      result[key] += row[key];
      invariant(Number.isSafeInteger(result[key]), 'usage_counter_overflow', 'Token totals exceed JavaScript safe-integer precision.');
    }
  }
  result.totalTokens = buckets.reduce((total, key) => total + result[key], 0);
  invariant(Number.isSafeInteger(result.totalTokens), 'usage_counter_overflow', 'Token total exceeds JavaScript safe-integer precision.');
  return result;
}

function rowFrom(entry, { taskIds = [], shared = false, scoped = false } = {}) {
  const values = Object.fromEntries(buckets.map(key => [key, entry[key]]));
  values.messages = entry.messageCount;
  return {
    agent: entry.client, model: entry.model,
    // workspace,model does not preserve the provider grouping dimension.
    provider: scoped ? null : (entry.provider || null),
    ...(scoped ? { workspaceKey: entry.workspaceKey, taskIds, shared } : {}),
    ...sum([values]),
  };
}

function normalizePath(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '') || '/';
  return /^(?:\/|[A-Za-z]:\/)/.test(normalized) ? normalized : null;
}

async function workspaceKeys(client, cwd) {
  let canonical = normalizePath(cwd);
  const values = new Set([canonical]);
  try { canonical = normalizePath(await fs.realpath(cwd)); values.add(canonical); }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  values.delete(null);
  if (client === 'claude') {
    for (const value of [...values]) values.add(value.replace(/[^A-Za-z0-9]/g, '-'));
  }
  return { keys: values, canonical };
}


function attemptAgent(task, attempt) {
  return attempt?.execution?.agent || task.definition.agent;
}

function taskAgents(task) {
  return [...new Set((task.attempts || []).map(attempt => attemptAgent(task, attempt)).filter(agent => usageClients.includes(agent)))];
}

function taskMatchesClients(task, clients) {
  const agents = taskAgents(task);
  if (agents.length) return agents.some(agent => clients.includes(agent));
  return task.definition.agent === 'auto' && clients.length === usageClients.length;
}

function coverageAgent(task, clients) {
  const agents = taskAgents(task).filter(agent => clients.includes(agent));
  if (agents.length === 1) return agents[0];
  if (agents.length > 1) return 'multiple';
  return task.definition.agent;
}

function warningCount(report) {
  return (report.warnings?.length || 0) + (report.diagnostics?.filter(d => ['warning', 'error'].includes(d.severity)).length || 0);
}

const rowKey = row => [row.agent, row.model, row.provider || '', row.workspaceKey || ''].join('\0');
const sortRows = rows => rows.sort((a, b) => rowKey(a).localeCompare(rowKey(b)));

export class UsageService {
  constructor({ stateRoot = defaultStateRoot(), tokscale = new Tokscale(), now = () => new Date() } = {}) {
    this.root = path.resolve(stateRoot);
    this.tokscale = tokscale;
    this.now = now;
  }

  async query(input = {}) {
    const options = validateUsageOptions(input, this.now());
    let tasks = [], allTasks = [];
    if (options.runId) {
      const run = await loadRun(this.root, options.runId);
      invariant(run, 'run_not_found', `Run ${options.runId} does not exist.`);
      invariant(run.schemaVersion === 1 && run.tasks && typeof run.tasks === 'object' && !Array.isArray(run.tasks), 'invalid_run', 'Run record is invalid.');
      if (options.taskId) invariant(Object.hasOwn(run.tasks, options.taskId), 'task_not_found', `Task ${options.taskId} does not exist.`);
      allTasks = Object.values(run.tasks);
      invariant(allTasks.every(t => t?.definition?.id && (usageClients.includes(t.definition.agent) || t.definition.agent === 'auto') && ['worktree', 'checkout'].includes(t.definition.isolation) && Array.isArray(t.attempts) && t.attempts.every(a => a && (a.cwd === null || a.cwd === undefined || typeof a.cwd === 'string') && (a.execution?.agent === undefined || usageClients.includes(a.execution.agent)))), 'invalid_run', 'Task records are invalid.');
      tasks = allTasks.filter(t => (!options.taskId || t.definition.id === options.taskId) && taskMatchesClients(t, options.clients));
    }

    const version = await this.tokscale.version();
    const base = {
      schemaVersion: 1,
      source: { name: 'tokscale', ...version, dataHome: options.home, counterBasis: 'local-client-records', costIncluded: false },
      filters: { agents: options.clients, model: options.model, since: options.since, until: options.until, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, datePrecision: 'local-calendar-day' },
      scope: { type: options.taskId ? 'task' : options.runId ? 'run' : 'machine', runId: options.runId, taskId: options.taskId },
      notes: ['Counters describe locally recorded usage, not a provider invoice. Missing records cannot establish zero actual usage.', 'Tokscale may refresh public pricing caches; HarnessOrbit invokes only local models reports and omits monetary estimates.'],
    };
    const request = { home: options.home, since: options.since || undefined, until: options.until || undefined };
    const matchesModel = entry => !options.model || entry.model === options.model;
    if (!options.runId) {
      const report = await this.tokscale.models({ ...request, clients: options.clients, groupBy: 'client,provider,model' });
      const rows = sortRows(report.entries.filter(matchesModel).map(entry => rowFrom(entry)));
      return {
        ...base, observedAt: this.now().toISOString(), status: rows.length ? 'ok' : 'no_records',
        attribution: { level: 'machine', exactTaskAttribution: false },
        rows, totals: sum(rows), sourceWarningCount: warningCount(report),
      };
    }

    const owners = new Map(), expectedWorkspaces = new Map();
    for (const task of allTasks) {
      expectedWorkspaces.set(task.definition.id, new Set());
      for (const attempt of task.attempts) {
        const client = attemptAgent(task, attempt);
        if (!usageClients.includes(client) || !options.clients.includes(client)) continue;
        const cwd = attempt.cwd;
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) continue;
        const workspace = await workspaceKeys(client, cwd);
        expectedWorkspaces.get(task.definition.id).add(`${client}\0${workspace.canonical}`);
        for (const key of workspace.keys) {
          const ownerKey = `${client}\0${key}`;
          if (!owners.has(ownerKey)) owners.set(ownerKey, new Map());
          const known = owners.get(ownerKey);
          const taskAgentKey = `${task.definition.id}\0${client}`;
          if (!known.has(taskAgentKey)) known.set(taskAgentKey, { taskId: task.definition.id, agent: client, isolation: task.definition.isolation, cwds: new Set() });
          known.get(taskAgentKey).cwds.add(`${client}\0${workspace.canonical}`);
        }
      }
    }
    const selected = new Set(tasks.map(t => t.definition.id));
    const clients = [...new Set(tasks.flatMap(taskAgents).filter(agent => options.clients.includes(agent)))];
    const rows = [], sharedWorkspaces = [], ambiguousWorkspaces = [];
    const matched = new Map(tasks.map(t => [t.definition.id, new Set()]));
    let sourceWarningCount = 0;
    for (const client of clients) {
      // Separate calls preserve agent attribution even when workspace,model merges clients.
      const report = await this.tokscale.models({ ...request, clients: [client], groupBy: 'workspace,model' });
      sourceWarningCount += warningCount(report);
      for (const entry of report.entries.filter(matchesModel)) {
        const known = owners.get(`${client}\0${normalizePath(entry.workspaceKey) || entry.workspaceKey}`);
        if (!known || ![...known.values()].some(owner => selected.has(owner.taskId))) continue;
        const candidates = [...known.values()];
        const taskIds = candidates.map(t => t.taskId).sort();
        if (candidates.some(t => t.isolation === 'checkout')) {
          sharedWorkspaces.push({ ...rowFrom(entry, { taskIds, shared: true, scoped: true }), reason: 'shared_checkout_not_task_usage' });
        } else if (candidates.length !== 1 || candidates[0].cwds.size !== 1) {
          ambiguousWorkspaces.push({ ...rowFrom(entry, { taskIds, scoped: true }), reason: 'multiple_tasks_share_workspace_key' });
        } else {
          rows.push(rowFrom(entry, { taskIds, scoped: true }));
          matched.get(taskIds[0]).add([...candidates[0].cwds][0]);
        }
      }
    }
    const coverage = tasks.map(task => {
      const count = matched.get(task.definition.id).size;
      const expected = expectedWorkspaces.get(task.definition.id).size;
      return {
        taskId: task.definition.id, agent: coverageAgent(task, options.clients),
        status: task.definition.isolation === 'checkout' ? 'shared_checkout' : expected === 0 ? 'workspace_unavailable' : !count ? 'no_matching_records' : count === expected ? 'workspace_matched' : 'partial_workspace_match',
        attempts: task.attempts.length, expectedWorkspaces: expected, matchedWorkspaces: count,
      };
    });
    const complete = coverage.length > 0 && coverage.every(t => t.status === 'workspace_matched') && !ambiguousWorkspaces.length;
    const matchedTotals = sum(rows);
    return {
      ...base, observedAt: this.now().toISOString(),
      status: complete ? 'ok' : rows.length ? 'partial' : tasks.length ? 'unattributable' : 'no_matching_tasks',
      attribution: {
        level: 'workspace', exactTaskAttribution: false,
        basis: 'Recorded HarnessOrbit working directories; Claude uses encoded project keys. No native session identity or within-day boundary is joined.',
        coordinatorAttribution: 'not_tracked',
        completeWorkspaceCoverage: complete,
      },
      rows: sortRows(rows), totals: complete ? matchedTotals : null, matchedTotals,
      coverage, sharedWorkspaces: sortRows(sharedWorkspaces), ambiguousWorkspaces: sortRows(ambiguousWorkspaces), sourceWarningCount,
      notes: [...base.notes, 'Scoped counts include matching workspaces across all attempts; retries reusing a worktree are counted once. They are not exact causal task accounting.', 'Shared checkout observations are shown separately and never included in task/run totals. Subagents using other workspaces may be missing.', 'Coordinator conversation tokens are not separately attributed; run/task views cover matched worker workspaces.'],
    };
  }
}

export function formatUsageTable(report) {
  const lines = [`Token usage — ${report.scope.type} (${report.status})`, `Source: Tokscale ${clean(report.source.version)} | observed ${clean(report.observedAt)}`];
  if (report.filters) lines.push(`Dates: ${report.filters.since || 'beginning'} through ${report.filters.until || 'latest'} (${clean(report.filters.timezone)})`);
  if (report.scope.runId) lines.push(`Run: ${clean(report.scope.runId)}${report.scope.taskId ? ` | Task: ${clean(report.scope.taskId)}` : ''}`);
  lines.push(report.attribution.level === 'machine' ? 'Scope: machine local records; not HarnessOrbit-only.' : 'Attribution: workspace-based, NOT exact task usage.');
  const headers = ['Agent', 'Model', 'Provider', 'Input', 'Output', 'Cache read', 'Cache write', 'Reasoning', 'Total'];
  const number = value => new Intl.NumberFormat('en-US').format(value);
  const cells = report.rows.map(r => [clean(r.agent), clean(r.model), clean(r.provider || (report.attribution.level === 'workspace' ? 'not grouped' : 'unknown')), ...buckets.map(k => number(r[k])), number(r.totalTokens)]);
  const widths = headers.map((h, i) => Math.min(i === 1 ? 40 : 24, cells.reduce((width, row) => Math.max(width, row[i].length), h.length)));
  const render = row => row.map((value, i) => value.slice(0, widths[i]).padEnd(widths[i])).join('  ');
  lines.push('', render(headers), widths.map(w => '-'.repeat(w)).join('  '), ...cells.map(render));
  if (!cells.length) lines.push('(no attributable records)');
  const total = report.totals || report.matchedTotals;
  lines.push('', `${report.totals ? 'Recorded total' : 'Matched subtotal (coverage incomplete)'}: ${number(total.totalTokens)} tokens; ${number(total.messages)} messages.`);
  if (report.sourceWarningCount) lines.push(`Tokscale reported ${report.sourceWarningCount} warning(s)/diagnostic(s); coverage may be incomplete.`);
  if (report.sharedWorkspaces?.length) lines.push(`${report.sharedWorkspaces.length} shared checkout observation(s) excluded. Use JSON to inspect them.`);
  if (report.ambiguousWorkspaces?.length) lines.push(`${report.ambiguousWorkspaces.length} ambiguous workspace observation(s) excluded.`);
  if (report.coverage) for (const item of report.coverage.filter(t => t.status !== 'workspace_matched')) lines.push(`  ${clean(item.taskId)}: ${item.status}`);
  lines.push('Missing records do not mean zero actual usage. No provider charges are calculated.');
  return lines.join('\n') + '\n';
}
