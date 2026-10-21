import { spawn } from 'node:child_process';
import { OrchestratorError } from './errors.mjs';

function validateArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new OrchestratorError('invalid_command', 'argv must be a nonempty string array');
  }
  for (const part of argv) {
    if (typeof part !== 'string' || part.length === 0) {
      throw new OrchestratorError('invalid_command', 'argv must contain only nonempty strings', { argv });
    }
  }
}

function appendBounded(state, chunk, maxBytes) {
  if (state.truncated) return;
  const nextSize = state.size + chunk.length;
  if (nextSize <= maxBytes) {
    state.chunks.push(chunk);
    state.size = nextSize;
    return;
  }
  const remaining = Math.max(0, maxBytes - state.size);
  if (remaining > 0) state.chunks.push(chunk.subarray(0, remaining));
  state.size = maxBytes;
  state.truncated = true;
}

function bufferText(state) {
  return Buffer.concat(state.chunks, state.size).toString('utf8');
}

function commandEnv(env) {
  const next = { ...(env ?? process.env) };
  delete next.NODE_TEST_CONTEXT;
  return next;
}

export async function runCommand(argv, { cwd, env, timeoutMs = 30000, maxBytes = 1048576, signal, onStdout, input } = {}) {
  validateArgv(argv);
  if (input !== undefined && typeof input !== 'string' && !Buffer.isBuffer(input)) throw new OrchestratorError('invalid_input', 'input must be a string or Buffer.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new OrchestratorError('invalid_timeout', 'timeoutMs must be a non-negative integer', { timeoutMs });
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new OrchestratorError('invalid_max_bytes', 'maxBytes must be a non-negative integer', { maxBytes });
  }
  if (signal !== undefined && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean')) {
    throw new OrchestratorError('invalid_signal', 'signal must be an AbortSignal-compatible object');
  }
  if (signal?.aborted) {
    throw new OrchestratorError('command_cancelled', 'command was cancelled before spawn', {
      argv,
      cwd,
    });
  }
  if (onStdout !== undefined && typeof onStdout !== 'function') throw new OrchestratorError('invalid_observer', 'onStdout must be a function.');

  const stdout = { chunks: [], size: 0, truncated: false };
  const stderr = { chunks: [], size: 0, truncated: false };
  let child;

  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: commandEnv(env),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
  } catch (cause) {
    throw new OrchestratorError('command_spawn_failed', `failed to spawn ${argv[0]}: ${cause.message}`, {
      argv,
      cause: cause.message,
    });
  }
  if (input !== undefined) {
    child.stdin.on('error', () => { /* the child may exit before reading; the exit code tells the story */ });
    child.stdin.end(input);
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let termination;
    let spawnError;
    let observerFailed = false;
    let killTimer;
    let killEscalated = false;
    let pendingTerminationClose = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };

    const killOwnedProcess = (signal = 'SIGTERM') => {
      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // Process may already be gone.
      }
    };

    const finishTerminationAfterEscalation = () => {
      if (!pendingTerminationClose) return;
      const { result, closeSignal } = pendingTerminationClose;
      pendingTerminationClose = null;
      if (termination === 'timeout') {
        finish(reject, new OrchestratorError('command_timeout', `command timed out after ${timeoutMs}ms`, {
          argv,
          cwd,
          timeoutMs,
          signal: closeSignal,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
        }));
        return;
      }
      if (termination === 'cancelled') {
        finish(reject, new OrchestratorError(observerFailed ? 'command_observer_failed' : 'command_cancelled', observerFailed ? 'Command output observer failed.' : 'command was cancelled', {
          argv,
          cwd,
          signal: closeSignal,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
        }));
      }
    };

    const terminate = (reason) => {
      if (termination) return;
      termination = reason;
      killOwnedProcess();
      killTimer = setTimeout(() => {
        killEscalated = true;
        if (!settled) killOwnedProcess('SIGKILL');
        finishTerminationAfterEscalation();
      }, 1000);
    };

    const onAbort = () => terminate('cancelled');

    const timer = timeoutMs === 0 ? null : setTimeout(() => {
      terminate('timeout');
    }, timeoutMs);
    if (timer) timer.unref();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.stdout.on('data', (chunk) => {
      appendBounded(stdout, chunk, maxBytes);
      if (onStdout && !observerFailed && !termination) {
        try { onStdout(chunk); }
        catch { observerFailed = true; terminate('cancelled'); }
      }
    });
    child.stderr.on('data', (chunk) => appendBounded(stderr, chunk, maxBytes));
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code, signal) => {
      const result = {
        code: code ?? (signal ? 128 : 1),
        stdout: bufferText(stdout),
        stderr: bufferText(stderr),
        truncated: stdout.truncated || stderr.truncated,
      };
      if (termination === 'timeout' || termination === 'cancelled') {
        pendingTerminationClose = { result, closeSignal: signal };
        if (killEscalated) finishTerminationAfterEscalation();
        return;
      }
      if (spawnError) {
        finish(reject, new OrchestratorError('command_spawn_failed', `failed to spawn ${argv[0]}: ${spawnError.message}`, {
          argv,
          cwd,
          cause: spawnError.message,
        }));
        return;
      }
      finish(resolve, result);
    });
  });
}
