export function classifyClaudeBlockedOutput(text) {
  if (typeof text !== 'string' || !text) return null;
  if (text.includes('Welcome to Claude Code') && text.includes('Security notes:') && text.includes('Press Enter to continue')) {
    return 'permission_required';
  }
  if (text.includes('Yes, I trust this folder') || text.includes('Yes, I accept')) {
    return 'permission_required';
  }
  if (/waiting[_ -]?permission|tool[-_ ]?permission|permission[_ -]?request/i.test(text)) {
    return 'permission_required';
  }
  return null;
}

export function blockedWaitLastError(text) {
  if (classifyClaudeBlockedOutput(text) === 'permission_required') {
    return {
      code: 'permission_required',
      message: 'Worker is waiting for an inspected permission or trust prompt. Use inspect --output, then cao input, then resume.',
    };
  }
  return {
    code: 'worker_blocked',
    message: 'Worker is blocked; inspect the pane and supply input if authorized.',
  };
}

export function shouldClearBlockedWait(attempt, live) {
  if (attempt?.status !== 'needs_input' || live?.agent_status === 'blocked') return false;
  if (!live.interactive_ready) return true;
  return attempt.lastObservedState === 'blocked'
    && ['permission_required', 'worker_blocked'].includes(attempt.lastError?.code)
    && ['working', 'idle', 'done'].includes(live.agent_status);
}
