import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { OrchestratorError, invariant } from '../errors.mjs';
import { runCommand } from '../process.mjs';
import { readJson, writeJsonAtomic, validateId, withLock } from '../state.mjs';
import { classifyClaudeBlockedOutput } from '../blocked-output.mjs';

// Live-session bridge: lets a principal continue an existing Claude Code or Codex CLI session
// that the host operator runs in tmux. Unlike jobs, a live session works in its own checkout and
// nothing here is verified by HarnessOrbit, so every call re-checks the bound pane's identity and
// the operator's explicit binding is the only authorization.

export const SESSION_SCHEMA_VERSION = 1;
export const SESSION_AGENTS = Object.freeze(['claude', 'codex']);
export const SESSION_STATES = Object.freeze(['idle', 'draft', 'busy', 'waiting_input', 'unknown']);
export const MAX_READ_LINES = 400;
export const DEFAULT_READ_LINES = 120;
export const MAX_READ_BYTES = 65536;
export const MAX_HISTORY_LINES = 5000;
// Idempotency keys are remembered for the life of a binding, up to this many messages; a
// binding that outgrows it must be re-bound, so an old key can never be replayed silently.
export const MAX_MESSAGES = 5000;
// Only the bottom rows carry state: the input box, a spinner right above it, or a dialog.
const SCREEN_LINES = 12;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'login', '-zsh', '-bash']);
const KEY_RE = /^[A-Za-z0-9+_-]{1,32}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
// Awaited sleeps keep the loop alive on purpose; an unref'd timer here would let the process exit mid-wait.
const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const basename = value => (typeof value === 'string' && value ? path.basename(value.trim()) : '');

// Screen classifiers per agent. Patterns are checked on the bottom rows of the pane, most
// specific first: a permission prompt wins over a spinner, a spinner wins over the idle prompt.
const PROFILES = {
  claude: {
    waiting: [/Do you want to proceed\?/i, /Yes, I trust this folder/, /Yes, I accept/, /Press Enter to continue/i, /Esc to cancel/, /\(y\/n\)/i, /❯ 1\. Yes/],
    // Any "<symbol> Word…" spinner row counts as busy, whatever glyph the animation is on.
    busy: [/esc to interrupt/i, /ctrl\+c to interrupt/i, /^\s*[^\p{L}\p{N}\s>❯›]\s*\p{Lu}\p{L}*(…|\.\.\.)/mu],
    // The input box: a prompt marker alone means empty; text after it is an unsent draft. Only
    // the exact placeholder Claude Code shows counts as empty; any other text fails closed as draft.
    prompt: /^\s*❯(.*)$/,
    placeholder: /^\s*(Try "[^"]*")?\s*$/,
    // The transcript shows a submitted message as "> text"; the input box itself uses ❯.
    echo: text => new RegExp(`^\\s*[>❯]\\s*${escapeRe(firstLine(text)).slice(0, 80)}`, 'gm'),
  },
  codex: {
    waiting: [/Allow command\?/i, /Approve\b.*\?/i, /\(y\/n\)/i, /Yes \(y\)/i, /Press Enter to continue/i, /trust this (directory|folder)/i, /Do you want to proceed\?/i],
    busy: [/esc to interrupt/i, /\bWorking\b/, /\bThinking\b/, /^\s*[^\p{L}\p{N}\s>❯›]\s*\p{Lu}\p{L}*(…|\.\.\.)/mu],
    prompt: /^\s*›(.*)$/,
    placeholder: /^\s*(Ask Codex to do anything)?\s*$/i,
    echo: text => new RegExp(`^\\s*›\\s*${escapeRe(firstLine(text)).slice(0, 80)}`, 'gm'),
  },
};

function escapeRe(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function firstLine(text) { return String(text).split('\n').find(line => line.trim()) || ''; }
function countMatches(text, re) { return (text.match(re) || []).length; }

// Classifies the bottom of a pane. A prompt that still shows a spinner is busy, a dialog is
// waiting_input, an empty input box is idle, a box with unsent text is draft. Anything without a
// recognizable marker is unknown and is never treated as idle.
export function classifyScreen(kind, screen) {
  const profile = PROFILES[kind];
  if (!profile) return { state: 'unknown', reason: 'unsupported_agent' };
  const text = Array.isArray(screen) ? screen.join('\n') : String(screen || '');
  const all = text.split('\n').map(row => row.replace(/\s+$/, ''));
  while (all.length && !all.at(-1)) all.pop(); // a short transcript leaves blank rows at the bottom
  const rows = all.slice(-SCREEN_LINES);
  const tail = rows.join('\n');
  if (kind === 'claude' && classifyClaudeBlockedOutput(tail) === 'permission_required') return { state: 'waiting_input', reason: 'permission_required' };
  if (profile.waiting.some(re => re.test(tail))) return { state: 'waiting_input', reason: 'prompt' };
  if (profile.busy.some(re => re.test(tail))) return { state: 'busy', reason: 'working' };
  const bottom = rows.slice(-12);
  for (let i = bottom.length - 1; i >= 0; i--) {
    const m = profile.prompt.exec(bottom[i]);
    if (!m) continue;
    const rest = m[1].replace(/\s+$/, '');
    if (profile.placeholder.test(rest)) return { state: 'idle', reason: 'prompt_empty' };
    return { state: 'draft', reason: 'prompt_has_text' };
  }
  return { state: 'unknown', reason: 'no_marker' };
}

// The readable stream of a session: scrollback plus the transcript part of the screen, which
// is everything above the input box. Rows the TUI rewrites in place (spinners, dialogs, the
// empty input box) are left out so a cursor anchored on the stream survives redraws.
export function streamRows(kind, history, screen) {
  const profile = PROFILES[kind];
  const rows = (screen || []).map(row => row.replace(/\s+$/, ''));
  while (rows.length && !rows.at(-1)) rows.pop();
  let cut = rows.length;
  if (profile) for (let i = rows.length - 1; i >= 0; i--) if (profile.prompt.test(rows[i])) { cut = i; break; }
  const volatile = row => {
    if (!profile) return false;
    if (profile.busy.some(re => re.test(row)) || profile.waiting.some(re => re.test(row))) return true;
    const m = profile.prompt.exec(row);
    return Boolean(m && profile.placeholder.test(m[1].replace(/\s+$/, '')));
  };
  return [...(history || []).map(row => row.replace(/\s+$/, '')), ...rows.slice(0, cut)].filter(row => !volatile(row));
}

export function agentKindOf({ comm, args }) {
  // ps truncates comm to 16 characters; the executable path in args is complete.
  const argv = typeof args === 'string' ? args.split(/\s+/) : [];
  const name = basename(argv[0] || comm);
  if (SHELLS.has(name)) return 'shell';
  if (name === 'claude') return 'claude';
  if (name === 'codex') return 'codex';
  if (['node', 'bun', 'deno'].includes(name) && argv.length > 1) {
    const script = basename(argv[1]).replace(/\.(m?js|cjs)$/, '');
    if (script === 'claude' || (script === 'cli' && /claude/.test(argv[1]))) return 'claude';
    if (script === 'codex' || /@openai\/codex/.test(argv[1])) return 'codex';
  }
  if (/\/\.local\/share\/claude\//.test(comm || '') || /\/claude\/versions\//.test(comm || '')) return 'claude';
  if (/@openai\/codex/.test(comm || '')) return 'codex';
  return 'other';
}

// Thin tmux wrapper. `socket` selects a tmux server (-L) so tests never touch the operator's.
export class Tmux {
  constructor({ socket = null, binary = 'tmux', command = runCommand } = {}) {
    invariant(socket === null || /^[A-Za-z0-9_.-]{1,64}$/.test(socket), 'invalid_tmux_socket', 'tmux socket name is invalid.');
    this.socket = socket; this.binary = binary; this.command = command;
  }

  argv(...rest) { return [this.binary, ...(this.socket ? ['-L', this.socket] : []), ...rest]; }

  async run(args, { timeoutMs = 5000 } = {}) {
    const result = await this.command(this.argv(...args), { timeoutMs, maxBytes: 4 * 1048576 });
    if (result.code !== 0) throw new OrchestratorError('tmux_failed', `tmux ${args[0]} failed.`, { code: result.code, stderr: String(result.stderr || '').slice(0, 200) });
    return result.stdout;
  }

  async listPanes() {
    const out = await this.run(['list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_command}\t#{pane_current_path}\t#{history_size}']);
    return out.split('\n').filter(Boolean).map(line => {
      const [paneId, session, window, index, pid, dead, command, cwd, history] = line.split('\t');
      return { paneId, target: `${session}:${window}.${index}`, panePid: Number(pid), dead: dead === '1', currentCommand: command, currentPath: cwd, historySize: Number(history) };
    });
  }

  async pane(paneId) {
    const panes = await this.listPanes();
    return panes.find(p => p.paneId === paneId) || null;
  }

  async captureScreen(paneId) { return (await this.run(['capture-pane', '-p', '-J', '-t', paneId])).replace(/\n$/, '').split('\n'); }

  // Scrollback only (rows above the visible screen), oldest first, bounded.
  async captureHistory(paneId, historySize, maxLines = MAX_HISTORY_LINES) {
    const size = Math.min(Number(historySize) || 0, maxLines);
    if (size <= 0) return [];
    const out = await this.run(['capture-pane', '-p', '-J', '-t', paneId, '-S', `-${size}`, '-E', '-1']);
    return out.replace(/\n$/, '').split('\n');
  }

  async sendText(paneId, text) {
    const buffer = `hoa-${crypto.randomBytes(4).toString('hex')}`;
    await this.run(['set-buffer', '-b', buffer, '--', text]);
    await this.run(['paste-buffer', '-d', '-p', '-b', buffer, '-t', paneId]);
    await this.run(['send-keys', '-t', paneId, 'Enter']);
  }

  async sendKeys(paneId, keys) { await this.run(['send-keys', '-t', paneId, ...keys]); }
}

// Process identity via ps/lsof; no /proc on macOS. `lstart` is stable for a process's lifetime,
// so pid + start time + command identifies one process and detects pid reuse.
export class ProcessInspector {
  constructor({ command = runCommand } = {}) { this.command = command; }

  async table() {
    // pgid/tpgid tell whether a process is the foreground job of its terminal; stat 'T' means stopped.
    const result = await this.command(['ps', '-ax', '-o', 'pid=,ppid=,pgid=,tpgid=,stat=,lstart=,comm=,args='], { timeoutMs: 10000, maxBytes: 8 * 1048576 });
    if (result.code !== 0) throw new OrchestratorError('ps_failed', 'ps failed.', { code: result.code });
    const rows = new Map();
    for (const line of result.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(\S+)\s*(.*)$/.exec(line);
      if (!m) continue;
      rows.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), tpgid: Number(m[4]), stat: m[5], startedAt: m[6], comm: m[7], args: m[8] });
    }
    return rows;
  }

  // The agent process is the pane process itself or a descendant within three levels.
  async agentUnder(panePid, table = null) {
    const rows = table || await this.table();
    const queue = [[panePid, 0]];
    while (queue.length) {
      const [pid, depth] = queue.shift();
      const row = rows.get(pid);
      if (!row) continue;
      const kind = agentKindOf(row);
      if (SESSION_AGENTS.includes(kind)) return { ...row, kind, depth };
      if (depth >= 3) continue;
      for (const child of rows.values()) if (child.ppid === pid) queue.push([child.pid, depth + 1]);
    }
    return null;
  }

  async process(pid, table = null) { return (table || await this.table()).get(pid) || null; }

  async cwd(pid) {
    try {
      const result = await this.command(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeoutMs: 5000 });
      const line = result.stdout.split('\n').find(l => l.startsWith('n'));
      return line ? line.slice(1) : null;
    } catch { return null; }
  }
}

export class SessionStore {
  constructor({ root } = {}) {
    invariant(typeof root === 'string' && root.length > 0, 'invalid_state_root', 'Session store root is required.');
    this.root = path.resolve(root);
    this.directory = path.join(this.root, 'access', 'sessions');
  }

  file(id) { return path.join(this.directory, `${validateId(id)}.json`); }
  locked(id, fn) { return withLock(path.join(this.root, 'locks', `access-session-${validateId(id)}`), fn, { timeoutMs: 15000 }); }
  async get(id) { return readJson(this.file(id), { optional: true }); }

  async create(record) {
    validateId(record.id);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    invariant(!(await this.get(record.id)), 'session_exists', `Session ${record.id} is already bound.`);
    const stored = { schemaVersion: SESSION_SCHEMA_VERSION, ...record, messages: [], createdAt: now(), updatedAt: now() };
    await writeJsonAtomic(this.file(record.id), stored);
    return stored;
  }

  async update(id, change) {
    const record = await this.get(id);
    invariant(record, 'session_not_found', `Session ${id} is not bound.`);
    change(record);
    record.updatedAt = now();
    await writeJsonAtomic(this.file(id), record);
    return record;
  }

  async remove(id) {
    try { await fs.unlink(this.file(id)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  async list({ principalId = null } = {}) {
    let entries;
    try { entries = await fs.readdir(this.directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const record = await readJson(path.join(this.directory, entry), { optional: true });
      if (record && (!principalId || record.principalId === principalId)) records.push(record);
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

function encodeCursor(history) {
  if (!history.length) return null;
  const tail = history.slice(-3).map(line => sha(line).slice(0, 16));
  return Buffer.from(JSON.stringify({ v: 1, n: history.length, a: tail })).toString('base64url');
}

function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null) return null;
  invariant(typeof cursor === 'string' && cursor.length <= 200, 'invalid_cursor', 'cursor must be a value returned by a previous read.');
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    invariant(parsed && parsed.v === 1 && Number.isInteger(parsed.n) && Array.isArray(parsed.a) && parsed.a.every(h => /^[0-9a-f]{16}$/.test(h)), 'invalid_cursor', 'cursor is malformed.');
    return parsed;
  } catch (error) {
    if (error instanceof OrchestratorError) throw error;
    invariant(false, 'invalid_cursor', 'cursor is malformed.');
  }
}

// Finds the index just after the anchor (the last lines of the previous read) in the current
// history. Returns -1 when the anchor scrolled away or the screen was rewritten.
function anchorIndex(history, cursor) {
  const hashes = history.map(line => sha(line).slice(0, 16));
  const window = cursor.a.length;
  const matches = i => cursor.a.every((h, k) => hashes[i - window + 1 + k] === h);
  const guess = Math.min(cursor.n - 1, hashes.length - 1);
  if (guess >= window - 1 && matches(guess)) return guess + 1;
  for (let i = hashes.length - 1; i >= window - 1; i--) if (matches(i)) return i + 1;
  return -1;
}

export class SessionService {
  constructor({ root, principals, sessions, tmux, processes, settleMs = 3000, now: clock = Date.now } = {}) {
    invariant(typeof root === 'string' && root.length > 0, 'invalid_state_root', 'Session service root is required.');
    invariant(principals, 'invalid_principals', 'Session service requires a principal store.');
    this.root = path.resolve(root);
    this.principals = principals;
    this.sessions = sessions || new SessionStore({ root: this.root });
    this.tmux = tmux || new Tmux();
    this.processes = processes || new ProcessInspector();
    this.settleMs = settleMs;
    this.clock = clock;
  }

  // Operator view of every pane on the tmux server: which hold an agent, in which checkout,
  // in what state. Only the bottom of each screen is read, for classification; content is not returned.
  async discover() {
    const panes = await this.tmux.listPanes();
    const table = await this.processes.table();
    const bound = await this.sessions.list();
    const result = [];
    for (const pane of panes) {
      const agent = pane.dead ? null : await this.processes.agentUnder(pane.panePid, table);
      const entry = { paneId: pane.paneId, target: pane.target, panePid: pane.panePid, currentCommand: pane.currentCommand, currentPath: pane.currentPath, agent: null, state: null, boundAs: bound.filter(b => b.paneId === pane.paneId).map(b => ({ id: b.id, principalId: b.principalId })) };
      if (agent) {
        const cwd = await this.processes.cwd(agent.pid) || pane.currentPath;
        entry.agent = { kind: agent.kind, pid: agent.pid, startedAt: agent.startedAt, cwd };
        try { entry.state = classifyScreen(agent.kind, await this.tmux.captureScreen(pane.paneId)); } catch { entry.state = { state: 'unknown', reason: 'capture_failed' }; }
      }
      result.push(entry);
    }
    return { panes: result, tmuxSocket: this.tmux.socket };
  }

  // Operator-only. Binding is the authorization: it names the principal, one pane, the agent
  // process in it (pid + start time), and the checkout it works in, which must be in the
  // principal's project scope. Keys are off unless the operator allows them.
  // The provider's own session identity, when it can be known without guessing: Claude Code
  // launched as `claude --resume <uuid>` / `--session-id <uuid>`, or an id the operator states.
  // It enables the native end-turn signal; without it the observer falls back to the screen.
  static providerSessionFor(agent, providerSessionId = null) {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (providerSessionId !== null) {
      invariant(typeof providerSessionId === 'string' && UUID.test(providerSessionId), 'invalid_session', 'providerSessionId must be the provider’s session UUID.');
      return agent.kind === 'claude' ? { kind: 'claude', sessionId: providerSessionId.toLowerCase(), source: 'operator', transcriptPath: null } : null;
    }
    if (agent.kind !== 'claude') return null;
    const argv = typeof agent.args === 'string' ? agent.args.split(/\s+/) : [];
    for (let i = 0; i < argv.length - 1; i++) if (['--resume', '-r', '--session-id'].includes(argv[i]) && UUID.test(argv[i + 1])) return { kind: 'claude', sessionId: argv[i + 1].toLowerCase(), source: 'process_args', transcriptPath: null };
    return null;
  }

  async bind({ principalId, pane, id = null, allowKeys = false, label = null, providerSessionId = null } = {}) {
    const principal = await this.principals.get(principalId);
    invariant(principal, 'principal_not_found', 'Principal does not exist.');
    invariant(typeof principal.incarnation === 'string' && principal.incarnation.length > 0, 'legacy_migration_required', `Principal ${principalId} predates identity tracking. Run "access principal migrate --id ${principalId}" first.`);
    invariant(principal.permissions.sessions === true, 'permission_denied', `Principal ${principalId} has no sessions permission. Grant it first (access principal update --allow-sessions).`);
    invariant(typeof pane === 'string' && /^%\d+$/.test(pane), 'invalid_pane', 'pane must be a tmux pane id such as %3.');
    invariant(typeof allowKeys === 'boolean', 'invalid_session', 'allowKeys must be a boolean.');
    invariant(label === null || (typeof label === 'string' && label.length <= 120), 'invalid_session', 'label must be at most 120 characters.');
    const target = await this.tmux.pane(pane);
    invariant(target && !target.dead, 'pane_not_found', `Pane ${pane} does not exist on this tmux server.`);
    const agent = await this.processes.agentUnder(target.panePid);
    invariant(agent, 'not_an_agent_pane', 'The pane does not run a Claude Code or Codex CLI process.', { currentCommand: target.currentCommand });
    const cwd = await this.processes.cwd(agent.pid) || target.currentPath;
    let project;
    try { project = await fs.realpath(cwd); } catch { invariant(false, 'project_not_allowed', 'The agent working directory is not readable.', { cwd }); }
    invariant(principal.projects.some(p => project === p || project.startsWith(`${p}${path.sep}`)), 'project_not_allowed', 'The agent works outside the principal’s projects.', { project, projects: principal.projects });
    invariant(principal.agents.includes(agent.kind), 'agent_not_allowed', 'The principal may not drive this agent kind.', { agent: agent.kind });
    const sessionId = id || `ses-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    // One pane, one binding: the uniqueness check and the create happen under the bind lock and
    // the pane's own lock, so a send or unbind on that pane cannot interleave with the rebind.
    const record = await withLock(path.join(this.root, 'locks', 'access-sessions-bind'), () => withLock(this._paneLock(pane), async () => {
      for (const existing of await this.sessions.list()) invariant(existing.paneId !== pane, 'pane_already_bound', `Pane ${pane} is already bound as ${existing.id}.`, { sessionId: existing.id, principalId: existing.principalId });
      return this.sessions.create({
        id: sessionId, bindingId: crypto.randomBytes(8).toString('hex'), principalId, principalIncarnation: principal.incarnation ?? null, label, paneId: pane, target: target.target, panePid: target.panePid, tmuxSocket: this.tmux.socket,
        agent: { kind: agent.kind, pid: agent.pid, startedAt: agent.startedAt, comm: agent.comm }, project, allowKeys,
        providerSession: SessionService.providerSessionFor(agent, providerSessionId),
      });
    }, { timeoutMs: 15000 }), { timeoutMs: 15000 });
    return this._public(record, { ok: true });
  }

  _paneLock(paneId) { return path.join(this.root, 'locks', `access-pane-${String(paneId).replace(/[^0-9]/g, '') || 'x'}`); }

  // Serializes every mutation of one pane and re-authorizes inside the lock: the principal's
  // current permission bits and the binding are re-read, so a revoked permission or an unbind
  // that raced in takes effect before anything is typed.
  async _withPane(principal, sessionId, fn) {
    const first = await this._owned(principal, sessionId);
    return withLock(this._paneLock(first.paneId), async () => {
      // Everything is re-read under the lock: permission bits, scope, and the binding itself,
      // which must still be the one seen before waiting (same bindingId, same pane).
      const record = await this._owned(principal, sessionId);
      invariant(record.bindingId === first.bindingId && record.paneId === first.paneId, 'session_replaced', 'The binding changed while waiting for the pane; nothing was sent.', { sessionId });
      return fn(record, await this.principals.get(principal.id));
    }, { timeoutMs: 15000 });
  }

  // Operator unbind serializes on the pane like every other mutation, so an in-flight send either
  // finishes before the binding disappears or fails closed afterwards.
  async unbindAsOperator(id) {
    const record = await this.sessions.get(id).catch(() => null);
    if (!record) return false;
    return withLock(this._paneLock(record.paneId), async () => {
      const fresh = await this.sessions.get(id);
      if (!fresh || fresh.bindingId !== record.bindingId) return false;
      return this.sessions.remove(id);
    }, { timeoutMs: 15000 });
  }

  // Principal tools below. Every one re-reads the binding and re-verifies identity.

  async list(principal) {
    const current = await this._allowed(principal);
    const records = (await this.sessions.list({ principalId: principal.id })).filter(record => (record.principalIncarnation ?? null) === (current.incarnation ?? null));
    const out = [];
    for (const record of records) {
      const scope = this._inScope(current, record);
      // A binding outside the principal's current scope is listed by id only: no checkout, pane or state.
      if (!scope.ok) { out.push({ schemaVersion: SESSION_SCHEMA_VERSION, session: { id: record.id, principalId: record.principalId }, authorized: false, identity: null, state: null, stateReason: null, next_action: 'operator', verification: 'none', reason: scope.code }); continue; }
      out.push({ ...this._public(record, await this._identity(record).catch(error => ({ ok: false, code: error.code, message: error.message }))), authorized: true });
    }
    return { schemaVersion: SESSION_SCHEMA_VERSION, sessions: out, note: 'Live sessions work directly in their checkout; HarnessOrbit does not verify what they change. Sessions are bound by the host operator.' };
  }

  async status(principal, { sessionId } = {}) {
    const record = await this._owned(principal, sessionId);
    const identity = await this._identity(record);
    const screen = await this.tmux.captureScreen(record.paneId);
    const state = classifyScreen(record.agent.kind, screen);
    return this._public(record, identity, state);
  }

  async send(principal, { sessionId, idempotencyKey, text, keys } = {}) {
    const record0 = await this._owned(principal, sessionId);
    invariant(typeof idempotencyKey === 'string' && idempotencyKey.trim().length > 0 && idempotencyKey.length <= 128, 'invalid_message', 'idempotencyKey is required (1 to 128 characters).', { field: 'idempotencyKey' });
    const message = text === undefined ? undefined : this._text(text);
    if (keys !== undefined) {
      invariant(Array.isArray(keys) && keys.length > 0 && keys.length <= 8 && keys.every(k => typeof k === 'string' && KEY_RE.test(k)), 'invalid_message', 'keys must be 1 to 8 key names such as Enter, y, or Escape.', { field: 'keys' });
      invariant(record0.allowKeys, 'keys_not_allowed', 'This binding does not allow key presses. Only text can be sent; the host operator answers prompts.');
    }
    invariant(Boolean(message) !== Boolean(keys), 'invalid_message', 'Supply either text or keys.');
    const payloadHash = sha(message ? `text:${message}` : `keys:${keys.join('\u0000')}`);
    return this._withPane(principal, record0.id, async record => {
      invariant(record.allowKeys || !keys, 'keys_not_allowed', 'This binding does not allow key presses.');
      const keyHash = sha(idempotencyKey);
      const existing = record.messages.find(m => m.keyHash === keyHash);
      if (existing) {
        invariant(existing.payloadHash === payloadHash, 'idempotency_conflict', 'This idempotencyKey was already used with a different message. Choose a new key.', { idempotencyKey });
        return { ...this._public(record, await this._identity(record), null), message: { ...existing, reused: true } };
      }
      invariant(record.messages.length < MAX_MESSAGES, 'session_message_limit', `This binding has recorded ${MAX_MESSAGES} messages; the operator must re-bind it before more can be sent.`);
      const identity = await this._identity(record);
      const before = await this.tmux.captureScreen(record.paneId);
      const state = classifyScreen(record.agent.kind, before);
      if (message) {
        const refusal = { busy: ['session_busy', 'The session is still working; read it and send when it is idle.'], waiting_input: ['session_waiting_input', 'The session is waiting on a prompt. Text is not accepted; the host operator answers it, or send keys if this binding allows them.'], draft: ['session_draft', 'The input box already holds unsent text typed by someone else; the host operator must clear or submit it first.'], unknown: ['session_state_unknown', 'The session state could not be determined; read the screen and let the host operator check.'] };
        invariant(state.state === 'idle', refusal[state.state]?.[0] || 'session_state_unknown', refusal[state.state]?.[1] || 'The session is not idle.', { state });
      } else {
        invariant(state.state === 'waiting_input', 'keys_not_applicable', 'Keys are accepted only while the session shows a prompt waiting for input.', { state });
      }
      const entry = { keyHash, payloadHash, at: now(), kind: message ? 'text' : 'keys', length: message ? message.length : keys.length, stateBefore: state.state, outcome: 'pending' };
      await this._commit(record, r => { r.messages = [...r.messages, entry]; });
      try {
        if (message) await this.tmux.sendText(record.paneId, message); else await this.tmux.sendKeys(record.paneId, keys);
      } catch (error) {
        await this._commit(record, r => { const m = r.messages.find(x => x.keyHash === keyHash); if (m) { m.outcome = 'uncertain'; m.error = error.code || 'send_failed'; } }).catch(() => {});
        throw new OrchestratorError('send_uncertain', 'tmux did not confirm the send. Do not resend; read the session to see whether it arrived.', { cause: error.code || 'send_failed' });
      }
      const outcome = await this._confirm(record, message, keys, before);
      const updated = await this._commit(record, r => { const m = r.messages.find(x => x.keyHash === keyHash); if (m) { m.outcome = outcome.outcome; m.stateAfter = outcome.state; m.confirmedBy = outcome.confirmedBy; } });
      const stored = updated.messages.find(x => x.keyHash === keyHash);
      return { ...this._public(record, identity, { state: outcome.state, reason: outcome.reason }), message: { ...stored, reused: false, note: outcome.outcome === 'sent' ? 'Delivered. Poll read until the session is idle again.' : 'Delivery could not be confirmed within the settle window. Do not resend with a new key; read the session first.' } };
    });
  }

  async read(principal, { sessionId, cursor, maxLines = DEFAULT_READ_LINES } = {}) {
    invariant(Number.isInteger(maxLines) && maxLines >= 1 && maxLines <= MAX_READ_LINES, 'invalid_message', `maxLines must be an integer from 1 to ${MAX_READ_LINES}.`, { field: 'maxLines' });
    const record = await this._owned(principal, sessionId);
    const decoded = decodeCursor(cursor);
    const identity = await this._identity(record);
    const pane = identity.pane;
    const history = await this.tmux.captureHistory(record.paneId, pane.historySize);
    const screen = await this.tmux.captureScreen(record.paneId);
    const state = classifyScreen(record.agent.kind, screen);
    const stream = streamRows(record.agent.kind, history, screen);
    let start = 0; let reset = false;
    if (decoded) {
      const index = anchorIndex(stream, decoded);
      if (index >= 0) start = index; else { reset = true; start = Math.max(0, stream.length - maxLines); }
    } else start = Math.max(0, stream.length - maxLines);
    let bytes = 0; const lines = [];
    for (const line of stream.slice(start)) {
      if (lines.length >= maxLines || bytes + Buffer.byteLength(line) + 1 > MAX_READ_BYTES) break;
      lines.push(line); bytes += Buffer.byteLength(line) + 1;
    }
    const end = start + lines.length;
    const more = end < stream.length;
    const next = encodeCursor(stream.slice(0, end)) || cursor || null;
    const lastMessage = record.messages.at(-1) || null;
    return {
      ...this._public(record, identity, state),
      lines, more, reset, truncated: history.length >= MAX_HISTORY_LINES, cursor: next,
      screen: screen.slice(-12).map(line => line.replace(/\s+$/, '')),
      // idle only means the prompt is ready for input. Whether the task is finished is not
      // observable from the screen; an explicit report from the agent is a later phase.
      completion: { promptReady: state.state === 'idle', executionFinished: 'unknown', verified: false, note: 'idle means the agent shows its prompt and accepts input; it does not mean the task is finished. Nothing here was checked by HarnessOrbit; use a job with checks for independently verified work.' },
      lastMessage: lastMessage ? { at: lastMessage.at, kind: lastMessage.kind, outcome: lastMessage.outcome } : null,
    };
  }

  async unbind(principal, { sessionId } = {}) {
    return this._withPane(principal, sessionId, async record => {
      const removed = await this.sessions.remove(record.id);
      return { schemaVersion: SESSION_SCHEMA_VERSION, session: { id: record.id, paneId: record.paneId, project: record.project }, removed };
    });
  }

  // Authorization is read from the principal store on every call, never from the token's
  // snapshot: the sessions permission, and the binding's checkout and agent must be within the
  // principal's current scope. A binding that fell out of scope is unusable until re-granted.
  async _allowed(principal) {
    const current = await this.principals.get(principal?.id).catch(() => null);
    // The request carries the incarnation its token authenticated as; it must be the incarnation
    // on record now. A principal id removed and recreated while a request was in flight is a
    // different principal, and a request without an incarnation is not accepted at all.
    invariant(!current || typeof current.incarnation === 'string', 'legacy_migration_required', `Principal ${current?.id} predates identity tracking. The host operator runs "access principal migrate --id ${current?.id}" before it can use live sessions.`);
    invariant(typeof principal?.incarnation === 'string' && principal.incarnation.length > 0 && current && current.incarnation === principal.incarnation, 'permission_denied', 'This request’s principal identity is not current; authenticate again.');
    invariant(current.permissions.sessions === true, 'permission_denied', 'This principal may not use live sessions. The host operator grants the sessions permission and binds a pane.');
    return current;
  }

  _inScope(current, record) {
    if (!record.project || !current.projects.some(p => record.project === p || record.project.startsWith(`${p}${path.sep}`))) return { ok: false, code: 'project_not_allowed', message: 'The session’s checkout is outside this principal’s current projects.' };
    if (!current.agents.includes(record.agent.kind)) return { ok: false, code: 'agent_not_allowed', message: `This principal may not drive ${record.agent.kind} sessions any more.` };
    return { ok: true };
  }

  async _owned(principal, sessionId) {
    const current = await this._allowed(principal);
    invariant(typeof sessionId === 'string' && sessionId.length > 0, 'invalid_message', 'sessionId is required.', { field: 'sessionId' });
    const record = await this.sessions.get(sessionId).catch(() => null);
    // A binding belongs to one incarnation of a principal id; a removed-and-recreated id is a
    // stranger. A binding without identity fields (bindingId, principalIncarnation) is refused
    // outright: the operator re-binds it rather than HarnessOrbit guessing who owns it.
    invariant(record && record.principalId === principal.id, 'session_not_found', `Session ${sessionId} is not bound.`);
    invariant(typeof record.bindingId === 'string' && typeof record.principalIncarnation === 'string', 'session_rebind_required', 'This binding predates identity tracking; the host operator must unbind and bind it again.', { sessionId });
    invariant(record.principalIncarnation === current.incarnation, 'session_not_found', `Session ${sessionId} is not bound.`);
    const scope = this._inScope(current, record);
    invariant(scope.ok, scope.code, scope.message, { sessionId });
    return record;
  }

  // Writes to a binding only while it is still the binding that was loaded under the pane lock.
  async _commit(record, change) {
    const fresh = await this.sessions.get(record.id);
    invariant(fresh && fresh.bindingId === record.bindingId, 'session_replaced', 'The binding changed while the operation was in flight; nothing was recorded.', { sessionId: record.id });
    return this.sessions.update(record.id, change);
  }

  _text(value) {
    invariant(typeof value === 'string', 'invalid_message', 'text must be a string.', { field: 'text' });
    const trimmed = value.replace(/\r\n/g, '\n').trim();
    invariant(trimmed.length > 0 && trimmed.length <= 8000, 'invalid_message', 'text must be 1 to 8000 characters.', { field: 'text' });
    invariant(!CONTROL.test(trimmed), 'invalid_message', 'text must not contain control characters.', { field: 'text' });
    return trimmed;
  }

  // The pane must still exist with the same pane process, the bound agent process must still be
  // alive with the same start time and command, under that pane, in the same checkout.
  async _identity(record) {
    const pane = await this.tmux.pane(record.paneId);
    invariant(pane && !pane.dead, 'session_gone', 'The bound pane no longer exists.', { paneId: record.paneId });
    invariant(pane.panePid === record.panePid, 'session_replaced', 'The pane now runs a different process than the one bound.', { paneId: record.paneId });
    const table = await this.processes.table();
    const proc = table.get(record.agent.pid);
    invariant(proc && proc.startedAt === record.agent.startedAt && basename(proc.comm) === basename(record.agent.comm), 'session_exited', 'The bound agent process has exited or was replaced.', { pid: record.agent.pid });
    let pid = proc.pid; let underPane = false;
    for (let hop = 0; hop < 6 && pid; hop++) { if (pid === record.panePid) { underPane = true; break; } pid = table.get(pid)?.ppid; }
    invariant(underPane, 'session_replaced', 'The bound agent process is no longer attached to the pane.', { pid: record.agent.pid });
    const kind = agentKindOf(proc);
    invariant(kind === record.agent.kind, 'session_replaced', 'The pane process is not the bound agent.', { kind });
    const live = await this.processes.agentUnder(record.panePid, table);
    invariant(live && live.pid === record.agent.pid, 'session_replaced', 'Another agent process now owns the pane.', { pid: live?.pid || null });
    // Keystrokes go to the terminal's foreground process group. A suspended (stopped) or
    // backgrounded agent would let typed text fall through to the shell, so refuse both.
    invariant(!/^T/.test(proc.stat || ''), 'session_suspended', 'The bound agent is stopped (suspended); input would not reach it.', { pid: proc.pid, stat: proc.stat });
    invariant(Number.isInteger(proc.tpgid) && proc.tpgid > 0 && proc.tpgid === proc.pgid, 'session_background', 'The bound agent is not the foreground process of its terminal; input would reach something else.', { pid: proc.pid, pgid: proc.pgid, tpgid: proc.tpgid });
    const cwd = await this.processes.cwd(record.agent.pid);
    invariant(cwd, 'session_unverified', 'The agent working directory could not be verified (lsof unavailable); refusing to act on an unverified session.', { pid: proc.pid });
    let real = cwd; try { real = await fs.realpath(cwd); } catch { /* keep raw */ }
    invariant(real === record.project, 'session_moved', 'The agent changed its working directory since binding.', { project: record.project, cwd: real });
    return { ok: true, pane, agent: { kind, pid: proc.pid, startedAt: proc.startedAt } };
  }

  // After sending, watch the screen for the echo of the message or a busy marker.
  async _confirm(record, message, keys, before) {
    const deadline = this.clock() + this.settleMs;
    const echo = message ? PROFILES[record.agent.kind].echo(message) : null;
    // The same text may already appear in the transcript from an earlier turn, so delivery is
    // confirmed by one more echo than before, not by the echo being present at all.
    const echoesBefore = echo ? countMatches(before.join('\n'), echo) : 0;
    let state = { state: 'unknown', reason: 'not_observed' };
    while (true) {
      const screen = await this.tmux.captureScreen(record.paneId);
      state = classifyScreen(record.agent.kind, screen);
      const text = screen.join('\n');
      if (echo && countMatches(text, echo) > echoesBefore) return { outcome: 'sent', state: state.state, reason: state.reason, confirmedBy: 'echo' };
      if (message && state.state === 'busy') return { outcome: 'sent', state: state.state, reason: state.reason, confirmedBy: 'busy' };
      if (keys && state.state !== 'waiting_input') return { outcome: 'sent', state: state.state, reason: state.reason, confirmedBy: 'prompt_cleared' };
      if (this.clock() >= deadline) return { outcome: 'uncertain', state: state.state, reason: state.reason, confirmedBy: null };
      await sleep(150);
    }
  }

  _public(record, identity = null, state = null) {
    return {
      schemaVersion: SESSION_SCHEMA_VERSION,
      session: { id: record.id, principalId: record.principalId, label: record.label, paneId: record.paneId, target: record.target, agent: record.agent.kind, project: record.project, allowKeys: record.allowKeys, createdAt: record.createdAt, messages: record.messages.length },
      identity: identity ? { ok: identity.ok !== false, ...(identity.code ? { code: identity.code, message: identity.message } : {}) } : null,
      state: state ? state.state : null,
      stateReason: state ? state.reason : null,
      next_action: !identity ? null : identity.ok === false ? 'operator' : !state ? 'status' : state.state === 'idle' ? 'send' : state.state === 'busy' ? 'read' : state.state === 'waiting_input' ? (record.allowKeys ? 'answer' : 'operator') : 'operator',
      verification: 'none',
    };
  }
}
