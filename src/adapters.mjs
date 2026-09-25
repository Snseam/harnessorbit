import { fileURLToPath } from 'node:url';
import { renderBrief } from './task-brief.mjs';

export const capabilities = {
  claude: {
    herdrKind: 'claude',
    nativeDelegation: 'available when native tooling is enabled; private hooks can observe lifecycle metadata, while native execution and concurrency remain agent-owned',
    maxChildren: 'reported in prompt contract only',
  },
  pi: {
    herdrKind: 'pi',
    nativeDelegation: 'Pi core has no built-in subagents; extensions/packages/external panes may add them, not observed or enforced by HarnessOrbit',
    maxChildren: 'reported in prompt contract only',
  },
  opencode: {
    herdrKind: 'opencode',
    nativeDelegation: 'OpenCode subagents depend on local config and permissions; not observed or enforced by HarnessOrbit',
    maxChildren: 'reported in prompt contract only',
  },
  codex: {
    herdrKind: 'codex',
    nativeDelegation: 'local Codex lifecycle metadata can be observed where supported; live coverage varies and native delegation is not controlled by HarnessOrbit',
    maxChildren: 'reported in prompt contract only',
  },
};

const HERDR_KINDS = new Set(['claude', 'pi', 'opencode', 'codex']);

export function buildLaunch(task, attemptDirectory) {
  const kind = task.agent || 'claude';
  if (!HERDR_KINDS.has(kind)) {
    throw new Error(`unsupported agent kind for MVP: ${kind}`);
  }
  const args = [...(task.agentArgs || [])];
  if (kind === 'claude') {
    return { kind, args: ['--add-dir', attemptDirectory, ...args] };
  }
  return { kind, args };
}

function lines(values) {
  return values.map((value) => `- ${value}`).join('\n') || '- (none)';
}

function checkLines(checks) {
  return checks.map((check) => {
    const timeout = check.timeoutMs ? ` timeoutMs=${check.timeoutMs}` : '';
    return `- ${check.name}: ${JSON.stringify(check.argv)}${timeout}`;
  }).join('\n');
}

function resultSkeleton(task, attempt) {
  return {
    taskId: task.id,
    attemptId: attempt.id,
    nonce: attempt.nonce,
    status: 'submitted',
    summary: '',
    changedFiles: [],
    checks: [],
    children: [],
    unresolved: [],
  };
}

export function compilePrompt(task, attempt) {
  const nativeInstructions = (task.nativeInstructions || '').trim() || '(none)';
  const feedback = attempt.feedback ? `\n\nPrevious feedback:\n${attempt.feedback}\n` : '';
  const checks = checkLines(task.checks || []);
  const allowedPaths = lines(task.allowedPaths || []);
  const maxChildren = Number.isInteger(task.maxChildren) ? task.maxChildren : 0;
  const skeleton = resultSkeleton(task, attempt);

  return `You are working under HarnessOrbit.

Task:
${task.objective}
${task.brief ? `\n${renderBrief(task.brief)}\n` : ''}

Task metadata:
- taskId: ${task.id}
- attemptId: ${attempt.id}
- attempt number: ${attempt.number}
- nonce: ${attempt.nonce}
- role: ${task.role || 'implementer'}
- working directory: ${attempt.cwd}
- attempt directory: ${attempt.directory}
- result file: ${attempt.resultFile}
- max native children requested/reported: ${maxChildren}

Allowed paths:
${allowedPaths}

You may read the attempt directory and result file path explicitly. You may write the result file at ${attempt.resultFile} even if it is outside allowedPaths; this is the only write exception outside allowedPaths. Existing project permissions still apply. Do not modify other files outside the allowed paths. Preserve other people's edits. Do not commit, push, change providers, install dependencies, or alter global/user configuration.

Verification commands you should run when relevant:
${checks}

Native-agent instructions:
${nativeInstructions}
${feedback}

Child/inner-agent reporting:
- You may use native child/subagent/team mechanisms only if this agent installation actually supports them and the needed tools are enabled.
- If max native children requested/reported is 0, do not start child/subagent/team work; complete the task in this session.
- Do not claim inner delegation occurred unless it actually did.
- For Claude Code, use the native agent id from SubagentStart/SubagentStop evidence in children[].id. A parent stop or idle state does not establish that children stopped; telemetry may block acceptance even if a child is omitted from this report.
- Track every child you start in the final result JSON as {id,status}. Valid child statuses are "completed", "cancelled", "running", and "unknown".
- The orchestrator does not treat your terminal idle state as proof that children completed; report unresolved child work explicitly.

Result contract:
- Write the result file last, after edits and checks.
- Prefer the atomic submission helper with the result JSON on stdin. Its argv is ${JSON.stringify([process.execPath, fileURLToPath(new URL('../bin/harnessorbit.mjs', import.meta.url)), 'result', 'submit', '--attempt-dir', attempt.directory, '--stdin'])}. It validates your report; it does not accept the task or run checks for you. Direct result-file writing remains supported.
- The result file must contain one JSON object with this shape:
${JSON.stringify(skeleton, null, 2)}
- status must be "submitted" when you have delivered work for verification, or "needs_input" when blocked on user/controller input.
- Include only checks that you actually ran. Do not claim tests or commands that were not run.
- changedFiles must list relative paths you changed.
- unresolved must list blockers, skipped checks, or risks.
- After writing the result file, print exactly this final line:
CAO_RESULT ${attempt.id}
`;
}

export function compileDispatchPrompt(task, attempt) {
  return `Read ${JSON.stringify(`${attempt.directory}/prompt.txt`)} completely using your file tools, then execute that task and its result contract. This file is the authoritative assignment for this attempt; reading it is authorized. It contains the scope, verification commands, native-agent instructions, and any previous failure output. Do not ask for the task again. If blocked, report the specific blocker.

Routing metadata:
- taskId: ${task.id}
- attemptId: ${attempt.id}
- nonce: ${attempt.nonce}
- working directory: ${attempt.cwd}
- result file: ${attempt.resultFile}
`;
}
