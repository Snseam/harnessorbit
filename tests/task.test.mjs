import assert from 'node:assert/strict';
import test from 'node:test';
import { OrchestratorError } from '../src/errors.mjs';
import { outsideScope, pathAllowed, scopesOverlap, taskDigest, validateTask, assessScope, retryAdvice } from '../src/task.mjs';

function validTask(overrides = {}) {
  return {
    id: 'task_1',
    objective: 'Implement the feature',
    allowedPaths: ['src/task.mjs', 'tests/'],
    checks: [{ name: 'unit', argv: ['node', '--test', 'tests/task.test.mjs'] }],
    ...overrides,
  };
}

test('validateTask normalizes defaults and stable collections', () => {
  assert.deepEqual(validateTask(validTask({ allowedPaths: ['tests/', 'src/task.mjs', 'tests/'] })), {
    id: 'task_1',
    objective: 'Implement the feature',
    agent: 'claude',
    role: 'implementer',
    allowedPaths: ['src/task.mjs', 'tests/'],
    checks: [{ name: 'unit', argv: ['node', '--test', 'tests/task.test.mjs'], timeoutMs: 60000 }],
    isolation: 'worktree',
    agentArgs: [],
    nativeInstructions: '',
    maxChildren: 0,
    maxAttempts: 3,
    dependsOn: [],
  });
});

test('validateTask accepts explicit legal options', () => {
  const task = validateTask(
    validTask({
      id: 'Task-2',
      agent: 'opencode',
      role: 'reviewer',
      isolation: 'checkout',
      agentArgs: ['--model', 'local'],
      nativeInstructions: 'Do not commit.',
      maxChildren: 2,
      maxAttempts: 5,
      dependsOn: ['a', 'b_2', 'A-3'],
      checks: [{ name: 'slow', argv: ['npm', 'test'], timeoutMs: 300000 }],
    }),
  );

  assert.equal(task.agent, 'opencode');
  assert.equal(task.isolation, 'checkout');
  assert.equal(task.maxChildren, 2);
  assert.equal(task.maxAttempts, 5);
  assert.deepEqual(task.dependsOn, ['a', 'A-3', 'b_2'].sort((a, b) => a.localeCompare(b)));
});

test('validateTask rejects unknown keys and malformed values with typed errors', () => {
  const cases = [
    validTask({ extra: true }),
    validTask({ id: '../bad' }),
    validTask({ objective: '   ' }),
    validTask({ agent: 'grok' }),
    validTask({ isolation: 'shared' }),
    validTask({ checks: [] }),
    validTask({ checks: [{ name: 'bad', argv: [] }] }),
    validTask({ checks: [{ name: 'bad', argv: ['node', 'bad\u0000arg'] }] }),
    validTask({ checks: [{ name: 'bad', argv: ['node'], timeoutMs: 300001 }] }),
    validTask({ agentArgs: ['ok', 7] }),
    validTask({ maxChildren: -1 }),
    validTask({ maxAttempts: 21 }),
    validTask({ dependsOn: ['../bad'] }),
    validTask({ id: 'self', dependsOn: ['self'] }),
  ];

  for (const item of cases) {
    assert.throws(
      () => validateTask(item),
      (error) => error instanceof OrchestratorError && ['invalid_task', 'invalid_id'].includes(error.code),
    );
  }
});

test('validateTask rejects traversal, absolute, glob, backslash and .git scopes', () => {
  const badPaths = [
    '../secret',
    '/tmp/file',
    'src\\file.js',
    'C:/tmp/file',
    'C:\\tmp\\file',
    '//server/share',
    'src/*.js',
    './src/file.js',
    'src//file.js',
    'src/../file.js',
    '.git/config',
    'src/.git/config',
    'src/\u0001file.js',
  ];

  for (const badPath of badPaths) {
    assert.throws(
      () => validateTask(validTask({ allowedPaths: [badPath] })),
      (error) => error instanceof OrchestratorError && error.code === 'invalid_path',
    );
  }
});

test('checks argv preserves literal string values while rejecting unusable NUL args', () => {
  const task = validateTask(
    validTask({
      checks: [{ name: 'literal', argv: ['node', '  spaced arg  ', '--flag= value '] }],
    }),
  );

  assert.deepEqual(task.checks[0].argv, ['node', '  spaced arg  ', '--flag= value ']);
  assert.throws(
    () => validateTask(validTask({ checks: [{ name: 'bad', argv: ['node', '\u0000'] }] })),
    (error) => error instanceof OrchestratorError && error.code === 'invalid_task',
  );
});

test('pathAllowed honors exact paths, directory prefixes and whole-tree scope', () => {
  assert.equal(pathAllowed('src/task.mjs', ['src/task.mjs']), true);
  assert.equal(pathAllowed('src/task.test.mjs', ['src/task.mjs']), false);
  assert.equal(pathAllowed('tests/task.test.mjs', ['tests/']), true);
  assert.equal(pathAllowed('tests', ['tests/']), true);
  assert.equal(pathAllowed('anywhere/file.txt', ['.']), true);
  assert.equal(pathAllowed('../secret', ['.']), false);
});

test('scopesOverlap detects file and directory scope conflicts', () => {
  assert.equal(scopesOverlap('src/', 'src/task.mjs'), true);
  assert.equal(scopesOverlap('src/task.mjs', 'src/task.mjs'), true);
  assert.equal(scopesOverlap('src/a/', 'src/a/b/file.js'), true);
  assert.equal(scopesOverlap('src/a/', 'src/b/'), false);
  assert.equal(scopesOverlap('.', 'docs/readme.md'), true);
  assert.equal(scopesOverlap(['src/a/', 'docs/readme.md'], ['tests/', 'docs/']), true);
});

test('outsideScope returns sorted paths outside allowed paths', () => {
  assert.deepEqual(
    outsideScope(['src/task.mjs', 'tests/task.test.mjs', 'docs/readme.md'], ['src/task.mjs', 'tests/']),
    ['docs/readme.md'],
  );
});

test('assessScope flags missing directory slashes without a file-count cap', () => {
  const files = {
    'src/task.mjs': { hash: 'a', mode: '100644', type: 'file' },
    'tests/task.test.mjs': { hash: 'b', mode: '100644', type: 'file' },
    '.claude/worktrees/bug-audit': { hash: 'c', mode: '160000', type: 'gitlink' },
  };
  assert.deepEqual(assessScope(['src'], files), {
    root: false,
    ambiguousDirectories: ['src'],
    matchedFiles: 0,
    sample: [],
  });
  const legal = assessScope(['src/', 'tests/'], files);
  assert.equal(legal.root, false);
  assert.deepEqual(legal.ambiguousDirectories, []);
  assert.equal(legal.matchedFiles, 2);
  assert.deepEqual(legal.sample, ['src/task.mjs', 'tests/task.test.mjs']);
  assert.deepEqual(assessScope(['.'], files).root, true);
  assert.deepEqual(assessScope(['.'], files).ambiguousDirectories, []);
  assert.deepEqual(assessScope(['.claude/worktrees/bug-audit'], files).ambiguousDirectories, []);
});

test('retryAdvice stays a sibling of attempt and does not widen worktree leftovers', () => {
  assert.deepEqual(
    retryAdvice({ isolation: 'worktree' }, { status: 'needs_input', lastError: { code: 'scope_violation' }, outsideScope: ['unexpected.txt'] }),
    { action: 'dispatch_new_task', reason: 'scope_violation' },
  );
  assert.deepEqual(
    retryAdvice({ isolation: 'checkout' }, { status: 'needs_input', outsideScope: ['unexpected.txt'], executorKind: 'host' }),
    { action: 'retry_with_feedback', reason: 'scope_violation' },
  );
  assert.deepEqual(retryAdvice({ isolation: 'worktree' }, { status: 'rework', number: 1 }), { action: 'retry_with_feedback', reason: 'rework' });
  assert.deepEqual(retryAdvice({ isolation: 'worktree' }, { status: 'rework', number: 2 }), { action: 'revise_or_split', reason: 'rework' });
  assert.equal(retryAdvice({ isolation: 'worktree' }, { status: 'running' }), null);
});

test('taskDigest is deterministic for normalized task input', () => {
  const left = validTask({
    allowedPaths: ['tests/', 'src/task.mjs'],
    dependsOn: ['b', 'a'],
  });
  const right = {
    checks: [{ argv: ['node', '--test', 'tests/task.test.mjs'], name: 'unit' }],
    objective: 'Implement the feature',
    allowedPaths: ['src/task.mjs', 'tests/'],
    dependsOn: ['a', 'b'],
    id: 'task_1',
  };

  assert.match(taskDigest(left), /^[a-f0-9]{64}$/);
  assert.equal(taskDigest(left), taskDigest(right));
});
