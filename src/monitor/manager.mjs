import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readJson, writeJsonAtomic, validateId, withLock } from '../state.mjs';
import { invariant } from '../errors.mjs';
import { runCommand } from '../process.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const proof = secret => createHash('sha256').update(secret).digest('hex');
const optionsIdentity = c => JSON.stringify([c.project, c.runId, c.all, c.manageStorage === true, c.coordinatorId, c.coordinatorExplicit === true, c.codexHome, c.claudeHome, c.port]);
function startResult(status, config, reused) {
  const url = config.manageStorage === true
    ? `${status.endpoint}/storage.html#${new URLSearchParams({ token: config.token, storageToken: config.storageToken })}`
    : status.url;
  return { ...status, url, reused };
}

async function request(endpoint, route, token, method = 'GET') {
  const response = await fetch(endpoint + route, { method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
  return { ok: response.ok, data: await response.json() };
}
function localEndpoint(endpoint) {
  try { const u = new URL(endpoint); return u.protocol === 'http:' && u.hostname === '127.0.0.1' && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash; }
  catch { return false; }
}
export async function openMonitor(url) {
  const command = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', url] : ['xdg-open', url];
  try { const result = await runCommand(command, { timeoutMs: 5000 }); return result.code === 0; }
  catch { return false; }
}

export class MonitorManager {
  constructor({ root, spawnProcess = spawn } = {}) { this.root = path.resolve(root); this.spawn = spawnProcess; }
  directory(id) { return path.join(this.root, 'monitors', validateId(id)); }
  async status(id = 'default') {
    const directory = this.directory(id);
    const config = await readJson(path.join(directory, 'config.json'), { optional: true });
    const handle = await readJson(path.join(directory, 'ready.json'), { optional: true });
    if (!config || !handle || !localEndpoint(handle.endpoint)) return null;
    const health = await request(handle.endpoint, '/_cao/health', config.ownerToken).catch(() => null);
    return {
      id, running: health?.ok === true && health.data.ownerProof === proof(config.ownerToken), pid: handle.pid,
      url: `${handle.endpoint}/#token=${encodeURIComponent(config.token)}`, endpoint: handle.endpoint,
      project: config.project, runId: config.runId, all: config.all, stateRoot: this.root,
    };
  }
  async start({ id = 'default', project = null, runId = null, all = false, manageStorage = false, port = 0, coordinatorId = process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || null, coordinatorExplicit = false, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') } = {}) {
    validateId(id); if (runId) validateId(runId); if (coordinatorId) validateId(coordinatorId);
    invariant(Number.isInteger(port) && port >= 0 && port <= 65535, 'invalid_monitor_port', 'Monitor port must be an integer from 0 to 65535.');
    invariant(all || project || runId, 'monitor_scope_required', 'Pass --project PATH, --run ID, or explicitly choose --all.');
    invariant(!all || (!project && !runId), 'invalid_monitor_scope', '--all cannot be combined with --project or --run.');
    invariant(!manageStorage || all === true, 'invalid_monitor_scope', '--manage-storage requires --all.');
    const scope = { project: project ? path.resolve(project) : null, runId, all, manageStorage, coordinatorId, coordinatorExplicit, codexHome: path.resolve(codexHome), claudeHome: path.resolve(claudeHome), port };
    if (project) invariant((await fs.stat(scope.project)).isDirectory(), 'invalid_monitor_project', 'Monitor project must be a directory.');
    if (project) invariant(this.root !== scope.project && !this.root.startsWith(scope.project + path.sep), 'state_inside_project', 'Monitor state must be outside the project working tree.');
    const directory = this.directory(id);
    return withLock(path.join(this.root, 'locks', `monitor-${id}`), async () => {
      const existing = await this.status(id);
      if (existing?.running) {
        const previous = await readJson(path.join(directory, 'config.json'));
        const requested = scope.coordinatorExplicit ? scope : { ...scope, coordinatorId: previous.coordinatorId, coordinatorExplicit: previous.coordinatorExplicit };
        invariant(optionsIdentity(previous) === optionsIdentity(requested), 'monitor_already_running', 'This monitor id is already running with another scope. Use a different --id or stop it first.');
        return startResult(existing, previous, true);
      }
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const configFile = path.join(directory, 'config.json');
      const readyFile = path.join(directory, 'ready.json');
      await fs.rm(readyFile, { force: true });
      const config = { schemaVersion: 1, root: this.root, ...scope, token: randomBytes(32).toString('base64url'), ownerToken: randomBytes(32).toString('base64url'), readyFile };
      if (manageStorage) config.storageToken = randomBytes(32).toString('base64url');
      await writeJsonAtomic(configFile, config);
      const stderr = await fs.open(path.join(directory, 'server.log'), 'a', 0o600);
      let child, failure = null, exited = false;
      try {
        child = this.spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--config', configFile], { detached: true, stdio: ['ignore', 'ignore', stderr.fd], env: { ...process.env, NODE_TEST_CONTEXT: '' } });
        child.once('error', () => { failure = true; });
        child.once('exit', () => { exited = true; });
        child.unref();
      } finally { await stderr.close(); }
      const deadline = Date.now() + 10000;
      try {
        while (Date.now() < deadline) {
          invariant(!failure && !exited, 'monitor_start_failed', 'Monitor process exited before becoming ready.');
          const ready = await this.status(id);
          if (ready?.running) return startResult(ready, config, false);
          await delay(75);
        }
        invariant(false, 'monitor_start_timeout', 'Monitor did not become ready within ten seconds.');
      } catch (error) {
        if (!failure && !exited) {
          child.kill('SIGTERM'); await delay(100);
          if (!exited) child.kill('SIGKILL');
        }
        throw error;
      }
    }, { timeoutMs: 15000 });
  }
  async stop(id = 'default') {
    const status = await this.status(id);
    if (!status?.running) return status;
    const config = await readJson(path.join(this.directory(id), 'config.json'));
    const response = await request(status.endpoint, '/_cao/stop', config.ownerToken, 'POST');
    invariant(response.ok, 'monitor_stop_failed', 'The owned monitor refused to stop.');
    // Stopping the monitor never stops an agent or a Herdr server.
    return { ...status, running: false, stopped: true };
  }
}
