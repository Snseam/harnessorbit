import crypto from 'node:crypto';
import path from 'node:path';
import { OrchestratorError } from './errors.mjs';
import { validateId } from './state.mjs';
import { validateExecution } from './routing.mjs';
import { validateBrief } from './task-brief.mjs';

const KNOWN_KEYS = new Set([
  'id',
  'objective',
  'agent',
  'role',
  'allowedPaths',
  'checks',
  'isolation',
  'agentArgs',
  'nativeInstructions',
  'maxChildren',
  'maxAttempts',
  'dependsOn',
  'execution',
  'deadlineAt',
  'brief',
]);

const AGENTS = new Set(['claude', 'pi', 'opencode', 'codex', 'auto']);
const ISOLATIONS = new Set(['worktree', 'checkout']);
const GLOB_CHARS = /[*?[\]{}]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const WINDOWS_ABSOLUTE = /^(?:[a-zA-Z]:[/\\]|[/\\]{2})/;

function taskError(code, message, details = {}) {
  return new OrchestratorError(code, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, field, { nonempty = false } = {}) {
  if (typeof value !== 'string') {
    throw taskError('invalid_task', `${field} must be a string`, { field });
  }
  const normalized = nonempty ? value.trim() : value;
  if (nonempty && normalized.length === 0) {
    throw taskError('invalid_task', `${field} must be nonempty`, { field });
  }
  return normalized;
}

function requireArgvString(value, field) {
  if (typeof value !== 'string') {
    throw taskError('invalid_task', `${field} must be a string`, { field });
  }
  if (value.length === 0 || value.includes('\u0000')) {
    throw taskError('invalid_task', `${field} must be nonempty and must not contain NUL`, { field });
  }
  return value;
}

function normalizeUniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function validatePathScope(scope) {
  if (typeof scope !== 'string' || scope.length === 0) {
    throw taskError('invalid_path', 'Path scope must be a nonempty string', { scope });
  }
  if (scope === '.') return scope;
  if (CONTROL_CHARS.test(scope)) {
    throw taskError('invalid_path', 'Path scope must not contain control characters', { scope });
  }
  if (scope.includes('\\') || path.isAbsolute(scope) || WINDOWS_ABSOLUTE.test(scope)) {
    throw taskError('invalid_path', 'Path scope must be relative and use forward slashes', { scope });
  }
  if (GLOB_CHARS.test(scope)) {
    throw taskError('invalid_path', 'Path scope must not contain glob characters', { scope });
  }
  if (scope.startsWith('/') || scope.startsWith('./') || scope.includes('//')) {
    throw taskError('invalid_path', 'Path scope must be a normalized relative path', { scope });
  }

  const directoryScope = scope.endsWith('/');
  const body = directoryScope ? scope.slice(0, -1) : scope;
  if (body.length === 0) {
    throw taskError('invalid_path', 'Path scope must not be the filesystem root', { scope });
  }

  const segments = body.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment === '.git')) {
    throw taskError('invalid_path', 'Path scope must not traverse or include .git', { scope });
  }

  return directoryScope ? `${segments.join('/')}/` : segments.join('/');
}

function validateRelativePath(relativePath) {
  const normalized = validatePathScope(relativePath);
  if (normalized.endsWith('/')) {
    throw taskError('invalid_path', 'Relative path must name a file path, not a directory scope', { relativePath });
  }
  return normalized;
}

function normalizeAllowedPaths(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw taskError('invalid_task', 'allowedPaths must be a nonempty array', { field: 'allowedPaths' });
  }
  return normalizeUniqueSorted(value.map(validatePathScope));
}

function normalizeCheck(check, index) {
  if (!isPlainObject(check)) {
    throw taskError('invalid_task', 'check must be an object', { index });
  }

  const unknown = Object.keys(check).filter((key) => !['name', 'argv', 'timeoutMs'].includes(key));
  if (unknown.length > 0) {
    throw taskError('invalid_task', 'check contains unknown keys', { index, unknown });
  }

  const name = requireString(check.name, `checks[${index}].name`, { nonempty: true });
  if (!Array.isArray(check.argv) || check.argv.length === 0) {
    throw taskError('invalid_task', 'check argv must be a nonempty string array', { index });
  }
  const argv = check.argv.map((part, argvIndex) =>
    requireArgvString(part, `checks[${index}].argv[${argvIndex}]`),
  );

  const timeoutMs = check.timeoutMs ?? 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) {
    throw taskError('invalid_task', 'check timeoutMs must be an integer from 1 to 300000', { index, timeoutMs });
  }

  return { name, argv, timeoutMs };
}

function normalizeChecks(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw taskError('invalid_task', 'checks must be a nonempty array', { field: 'checks' });
  }
  return value.map(normalizeCheck);
}

function normalizeStringArray(value, field, { safeIds = false } = {}) {
  if (!Array.isArray(value)) {
    throw taskError('invalid_task', `${field} must be an array`, { field });
  }
  return value.map((item, index) => {
    if (safeIds) return validateId(item);
    return requireString(item, `${field}[${index}]`);
  });
}

function normalizeNonnegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw taskError('invalid_task', `${field} must be a non-negative integer`, { field, value });
  }
  return value;
}

function normalizePositiveInteger(value, field, max) {
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw taskError('invalid_task', `${field} must be a positive integer no greater than ${max}`, { field, value });
  }
  return value;
}

export function validateTask(object) {
  if (!isPlainObject(object)) {
    throw taskError('invalid_task', 'task must be an object');
  }

  const unknown = Object.keys(object).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    throw taskError('invalid_task', 'task contains unknown keys', { unknown });
  }

  const id = validateId(object.id);
  const objective = requireString(object.objective, 'objective', { nonempty: true });
  const execution = object.execution === undefined ? null : validateExecution(object.execution);
  const agent = object.agent ?? (execution ? 'auto' : 'claude');
  if (!AGENTS.has(agent)) {
    throw taskError('invalid_task', 'agent must be claude, pi, opencode, codex, or auto', { agent });
  }
  if (execution?.native && agent === 'auto') throw taskError('invalid_task', 'Native execution requires a concrete agent.');

  const role = object.role === undefined ? 'implementer' : requireString(object.role, 'role', { nonempty: true });
  const allowedPaths = normalizeAllowedPaths(object.allowedPaths);
  const checks = normalizeChecks(object.checks);

  const isolation = object.isolation ?? 'worktree';
  if (!ISOLATIONS.has(isolation)) {
    throw taskError('invalid_task', 'isolation must be worktree or checkout', { isolation });
  }

  const agentArgs = normalizeStringArray(object.agentArgs ?? [], 'agentArgs');
  const nativeInstructions = requireString(object.nativeInstructions ?? '', 'nativeInstructions');
  const maxChildren = normalizeNonnegativeInteger(object.maxChildren ?? 0, 'maxChildren');
  const maxAttempts = normalizePositiveInteger(object.maxAttempts ?? 3, 'maxAttempts', 20);
  let deadlineAt;
  if (object.deadlineAt !== undefined) {
    if (typeof object.deadlineAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(object.deadlineAt) || !Number.isFinite(Date.parse(object.deadlineAt))) {
      throw taskError('invalid_task', 'deadlineAt must be an ISO UTC timestamp', { field: 'deadlineAt' });
    }
    deadlineAt = new Date(object.deadlineAt).toISOString();
    const canonicalInput = object.deadlineAt.length === 20 ? object.deadlineAt.replace('Z', '.000Z') : object.deadlineAt;
    if (deadlineAt !== canonicalInput) {
      throw taskError('invalid_task', 'deadlineAt must be a real calendar timestamp', { field: 'deadlineAt' });
    }
  }
  const dependsOn = normalizeUniqueSorted(normalizeStringArray(object.dependsOn ?? [], 'dependsOn', { safeIds: true }));
  if (dependsOn.includes(id)) {
    throw taskError('invalid_task', 'dependsOn must not include the task id', { id });
  }

  return {
    id,
    objective,
    agent,
    role,
    allowedPaths,
    checks,
    isolation,
    agentArgs,
    nativeInstructions,
    maxChildren,
    maxAttempts,
    dependsOn,
    ...(execution ? { execution } : {}),
    ...(deadlineAt ? { deadlineAt } : {}),
    ...(object.brief === undefined ? {} : { brief: validateBrief(object.brief) }),
  };
}

function asScopes(value) {
  return Array.isArray(value) ? value.map(validatePathScope) : [validatePathScope(value)];
}

function scopeContains(scope, relativePath) {
  if (scope === '.') return true;
  if (scope.endsWith('/')) return relativePath === scope.slice(0, -1) || relativePath.startsWith(scope);
  return relativePath === scope;
}

function singleScopesOverlap(left, right) {
  if (left === '.' || right === '.') return true;
  if (!left.endsWith('/') && !right.endsWith('/')) return left === right;
  if (left.endsWith('/') && right.endsWith('/')) return left.startsWith(right) || right.startsWith(left);
  const directory = left.endsWith('/') ? left : right;
  const file = left.endsWith('/') ? right : left;
  return file.startsWith(directory);
}

export function pathAllowed(relativePath, allowedPaths) {
  let normalizedPath;
  let scopes;
  try {
    normalizedPath = validateRelativePath(relativePath);
    scopes = asScopes(allowedPaths);
  } catch {
    return false;
  }
  return scopes.some((scope) => scopeContains(scope, normalizedPath));
}

export function scopesOverlap(a, b) {
  const left = asScopes(a);
  const right = asScopes(b);
  return left.some((leftScope) => right.some((rightScope) => singleScopesOverlap(leftScope, rightScope)));
}

export function outsideScope(paths, allowedPaths) {
  if (!Array.isArray(paths)) {
    throw taskError('invalid_path', 'paths must be an array', { paths });
  }
  return normalizeUniqueSorted(paths.filter((relativePath) => !pathAllowed(relativePath, allowedPaths)));
}

export function assessScope(allowedPaths, snapshotFiles) {
  const scopes = asScopes(allowedPaths);
  const keys = Object.keys(snapshotFiles || {});
  const root = scopes.includes('.');
  const ambiguousDirectories = normalizeUniqueSorted(
    scopes.filter((scope) => scope !== '.' && !scope.endsWith('/') && keys.some((key) => key.startsWith(`${scope}/`))),
  );
  const matched = keys.filter((key) => pathAllowed(key, scopes)).sort((a, b) => a.localeCompare(b));
  return {
    root,
    ambiguousDirectories,
    matchedFiles: matched.length,
    sample: matched.slice(0, 10),
  };
}

export function retryAdvice(task, attempt) {
  if (!attempt) return null;
  const isolation = task?.isolation ?? task?.definition?.isolation;
  const scopeViolation = attempt.lastError?.code === 'scope_violation' || Boolean(attempt.outsideScope?.length);
  if (scopeViolation) {
    return isolation === 'worktree' && attempt.executorKind !== 'host'
      ? { action: 'dispatch_new_task', reason: 'scope_violation' }
      : { action: 'retry_with_feedback', reason: 'scope_violation' };
  }
  if (attempt.status === 'rework') {
    return (attempt.number || 1) >= 2
      ? { action: 'revise_or_split', reason: 'rework' }
      : { action: 'retry_with_feedback', reason: 'rework' };
  }
  return null;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function taskDigest(task) {
  const normalized = validateTask(task);
  return crypto.createHash('sha256').update(stableStringify(normalized)).digest('hex');
}
