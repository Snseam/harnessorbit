# Coordinate development with CAO

Use the CLI path resolved by this skill's `scripts/cao.mjs --paths`. Read the checkout's README and CLI `--help` for the current task schema; use the returned absolute guide paths when routing or monitoring needs more detail. Do not walk `~/.codex/sessions` or open jsonl/sqlite files to find CAO.

## Split useful work

Keep requirements, acceptance conditions, shared interfaces, and cross-task decisions in Codex. Give an external session an independently reviewable task, exact owned paths, and executable checks. Directory prefixes in `allowedPaths` must end with `/`; a path without the slash is an exact file. Worktree tasks may run in parallel; integrate predecessors before dispatching dependent worktrees. Checkout mode permits one writer across runs sharing the same state directory. Keep that directory outside the target Git worktree.

For an existing project, reproduce the issue and establish a baseline before dispatch. For a new application, establish a committed skeleton and one thin end-to-end path before expanding independent features. Creating a commit still requires the user's applicable authorization. A candidate competition uses separate task IDs/worktrees and integrates only the selected candidate.

Inspect available agents and `profile list`. Without an execution selector/default, supported agents inherit their native provider configuration. For profiles, read the resolved profiles guide and run `route explain --file TASK.json` before dispatch. Use `agent: "auto"` when a profile may choose the agent; a concrete agent constrains routing. Preserve the user's native/CC Switch provider and authentication settings. Use stdin and private credential references for secrets, never prompt text or CLI arguments.

Request native collaboration through `nativeInstructions` only when the selected agent actually supports it. Set `maxChildren` to the intended number and avoid duplicating externally owned work inside a worker. Child reports remain part of the delivery contract. CAO attempt limits do not enforce native child or provider request concurrency.

## Drive the CLI to acceptance

If `mode status` reports `strategy: shadow`, call `route shadow --file TASK.json --thread THREAD_ID --record` before ordinary dispatch. Resource discovery here is read-only; calibration is not automatic. Record the recommendation and its evidence gaps, then keep the user's existing agent/profile selection. Do not apply a recommendation solely because it selected a different executor. Use optional task `brief` for acceptance notes, context references, known findings, risk and independence; executable `checks` still decide candidate acceptance.

1. Inspect a recorded active run before creating another. `init --project ABS_PATH --max-parallel N` creates a run and an owned Herdr session. Generate a task file with the conversation's configured agent/profile and `maxAttempts`; `validate --file TASK.json` checks it. `dispatch --run RUN --file TASK.json` reserves and submits once.
2. `collect --run RUN --task TASK --wait-ms 30000` waits for evidence. `inspect --output` reads the worker when needed. Terminal idle, a final chat sentence, and a transport acknowledgement do not prove acceptance.
3. On `needs_input`, run `inspect --output` and read `lastError.code`. For `permission_required` or a live permission/trust dialog, resolve only what existing authorization covers with `input --keys ...` or `input --text-file ...`, then `resume`. Do not auto-approve, skip native permissions, or resume an unsubmitted pane. If a worker is idle without a report, request the current attempt's report instead of replaying the implementation task. Monitor waiting, including `Provider saturated · not a CAO retry`, is not a retry. If the coordinator itself shows "Selected model is at capacity", wait; do not cancel-to-retry. `providerObservation` never replaces `lastError`.
4. On `submitted`, run `verify`. It stops the owned worker, checks the candidate identity and scope, runs checks independently, and creates a patch only on success. A stale nonce, changed snapshot, unexpected path, or unfinished reported child blocks acceptance.
5. `retry` is legal only when `inspect.attempt.status` is `rework`, `failed`, `interrupted`, or `cancelled`. On `rework`, inspect evidence and `retry` with focused feedback. A new attempt preserves partial work and includes failed checks. Stay within the task's configured attempt limit; repeated identical failures call for a revised diagnosis or task boundary. Follow `inspect.retryAdvice`: worktree `scope_violation` is `dispatch_new_task` (cancel, then a new task id — leftover files cannot be retried); checkout/host `scope_violation` is `retry_with_feedback`; later rework (`number >= 2`) is `revise_or_split`.
6. On `accepted`, review the candidate and `integrate` within the user's development authorization. CAO checks the target baseline/patch hash, applies without committing, and reruns checks in the target project. Finish project-level acceptance, not just individual candidate acceptance.
7. After completion or cancellation, `cleanup --run RUN` stops the owned Herdr server and closes the run. Evidence/worktrees remain. It does not commit, push, or delete project files.

## Recovery and observation

- An uncertain transport outcome is not permission to retry blindly. Inspect/resume first; stop the old worker before creating a replacement attempt. Do not force-stop a gateway with active users.
- Failed or cancelled checkout work can leave edits in place. Failed integration can leave an applied patch. CAO holds the affected project; inspect the retained checkout and use the documented `retry`/`recover` path. `recover` rechecks the current checkout and does not replay a patch. `cleanup` does not clear a recovery hold.
- A crashed `verifying` attempt is fail-closed; inspect its process/evidence state. Do not edit the ledger to pretend it passed. Runtime identity mismatches require inspection, not force-closing an arbitrary terminal.
- When the user asks to see activity, use `monitor start --project ABS_PATH --open` with the same state directory. Conversation view shows linked native and external agents. Status may be observed, stale, or unknown; token counts carry their own scope/completeness. A native finished turn is distinct from independently accepted work. Stopping the viewer does not stop agents.
- Worktrees and file scopes coordinate writes; they are not a filesystem sandbox. Choose checks appropriate for the target repository and preserve existing authorization boundaries.

Report delivered behavior, independent verification, actual external sessions/repair attempts, and remaining limitations. Retain run/task IDs and evidence paths for the conversation's next turn.

## Adaptive dispatch

For an enabled adaptive conversation, use normal `dispatch` with the same conversation identity, or `dispatch --adaptive` for one task. Inspect resources and existing evidence first. Preserve explicit user agent/profile/resource choices. Leave task agent unspecified or auto only when the user permits selection. The default calibration policy is off. If the saved mode or one-task command explicitly sets `--calibration-policy on-demand`, dispatch may run bounded quick probes only when missing or stale call verification blocks otherwise useful external candidates; do not run probes without a task, install agents, rewrite native settings, or copy OAuth-only credentials. A first successful real delegated task can provide useful evidence for OAuth/subscription paths, but do not fabricate readiness from configuration alone. When the returned attempt is host-owned, follow the host workflow below; otherwise supervise the external attempt. A route bound to an attempt is not proof of acceptance. Unfinished or unknown native children block collect/verify; retries keep the bound configuration and do not silently take a fallback. Preference ranking uses completion rate before elapsed time and is not a general speed or quality guarantee. Details and limits are in the checkout's `docs/adaptive-dispatch.md`.

## Work in the current Codex conversation

Use this path when the user chooses current-Codex execution for the task. It does not start another Codex CLI and is not an automatic fallback from external failure.

If previewing this explicit choice through shadow routing, pass `route shadow --executor host`; `agent: codex` plus checkout isolation alone also describes a valid external Codex task. An explicit host choice never falls back to an external executor. It overrides the saved per-conversation external preference for that preview only, but cannot contradict an execution profile explicitly supplied in the task.

1. Create or reuse the run, then `host start --run RUN --file TASK.json --thread THREAD_ID`. Omit external execution/profile/agent arguments from the task; the host path uses Codex and checkout isolation. Wait for successful registration before editing; it captures the baseline and holds the project against other CAO writers.
2. Work within the returned scope. When editing and all owned native children have stopped, prepare the normal result JSON with current taskId/attemptId/nonce and `hostStopped: true`. Report all actual children. Submit with `host report --run RUN --task TASK --file REPORT.json --thread THREAD_ID`.
3. Run `host verify` with the same identity. Only independent checks can mark the candidate accepted. It is an in-place delivery: never apply a patch to the same checkout again. Project-level acceptance remains your responsibility.
4. For `rework`, use `host start --retry` with the same task definition to register another bounded attempt before editing; it retains the original baseline and changes the nonce. For cancellation, stop your work and owned children, then `host release --ack-stopped`; use `--children-file` with a complete array when child status needs updating. Changed checkout holds remain until `host recover` rechecks the retained edits.

CAO cannot terminate the current App turn. `cancel` requests a stop; it does not prove the host stopped or release its checkout. Never acknowledge stopped work while a child or verifier can still write. The thread id is a correlation/ownership check within the local workflow, not a separate authentication boundary.
