import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyClaudeBlockedOutput, blockedWaitLastError, shouldClearBlockedWait } from '../src/blocked-output.mjs';

test('classifyClaudeBlockedOutput matches smoke permission prompts only', () => {
  assert.equal(classifyClaudeBlockedOutput('Yes, I trust this folder'), 'permission_required');
  assert.equal(classifyClaudeBlockedOutput('Yes, I accept'), 'permission_required');
  assert.equal(
    classifyClaudeBlockedOutput('Welcome to Claude Code\nSecurity notes:\nPress Enter to continue'),
    'permission_required',
  );
  assert.equal(classifyClaudeBlockedOutput('waiting_permission to use Bash'), 'permission_required');
  assert.equal(classifyClaudeBlockedOutput('Tool permission required'), 'permission_required');
  assert.equal(classifyClaudeBlockedOutput('PermissionRequest dialog'), 'permission_required');
  assert.equal(classifyClaudeBlockedOutput('Selected model is at capacity'), null);
  assert.equal(classifyClaudeBlockedOutput(''), null);
  assert.equal(classifyClaudeBlockedOutput(null), null);
});

test('blockedWaitLastError never embeds terminal text', () => {
  const permission = blockedWaitLastError('Yes, I trust this folder SECRET');
  assert.equal(permission.code, 'permission_required');
  assert.equal(permission.message.includes('SECRET'), false);
  const generic = blockedWaitLastError('obscure pane SECRET');
  assert.equal(generic.code, 'worker_blocked');
  assert.equal(generic.message.includes('SECRET'), false);
});

test('shouldClearBlockedWait unsticks after Herdr leaves blocked', () => {
  const attempt = {
    status: 'needs_input',
    lastObservedState: 'blocked',
    lastError: { code: 'permission_required' },
  };
  assert.equal(shouldClearBlockedWait(attempt, { agent_status: 'working', interactive_ready: true }), true);
  assert.equal(shouldClearBlockedWait(attempt, { agent_status: 'blocked', interactive_ready: true }), false);
  assert.equal(shouldClearBlockedWait({
    status: 'needs_input',
    lastObservedState: 'idle',
    lastError: { code: 'missing_result' },
  }, { agent_status: 'idle', interactive_ready: true }), false);
});
