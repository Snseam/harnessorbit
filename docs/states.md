# State, isolation, and integration semantics

> 中文: [zh-CN/states.md](zh-CN/states.md)

This document describes CAO runs, attempts, isolation modes, holds, and recovery behavior. The authoritative state is `run.json` under the configured state root.

An optional foreground `supervise` command advances these same states. Task `deadlineAt`, one-shot report repair, atomic submission, and phase timing are described in [supervision and performance](supervision.md). They do not turn native idle state into acceptance or clear checkout/integration holds.

## Run

`init` creates a run with the target project root, base commit, baseline snapshot, initial dirty flag, max parallelism, and a CAO-owned Herdr session.

`cleanup` stops the run's Herdr session, writes `closedAt` / `serverStoppedAt`, and prevents new dispatch in that run. It does not remove worktrees, attempt directories, evidence, target project files, checkout holds, or integration holds.

## Attempt lifecycle

Typical successful worktree path:

```text
preparing -> launching -> ready -> sending -> running
  -> submitted -> verifying -> accepted -> integrating -> integrated
```

Repair and manual paths:

```text
running -> needs_input
submitted -> verifying -> rework
preparing/running/verifying -> cancelling -> cancelled
running/uncertain -> interrupted
accepted -> integrating -> integration_failed
integration_failed/integration_cancelled -> recover -> integrating -> integrated|integration_failed
```

| Status               | Meaning                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `preparing`          | Attempt is reserved; CAO is preparing its directory and isolation.                                                                                                             |
| `launching`          | Herdr workspace/pane exists; CAO is starting the agent.                                                                                                                        |
| `ready`              | Agent is ready; assignment has not yet been sent.                                                                                                                              |
| `sending`            | CAO has claimed the right to send. If sending fails, the attempt becomes `uncertain`; do not blindly resend.                                                                   |
| `running`            | Assignment was acknowledged and the worker is expected to write `result.json`.                                                                                                 |
| `uncertain`          | Delivery or observation failed; use `resume` / `collect` to reconcile.                                                                                                         |
| `needs_input`        | Worker is blocked, result requested input, native children are unresolved, `unresolved` is nonempty, paths are out of scope, or the result is invalid.                         |
| `submitted`          | CAO collected a valid candidate and it can be verified.                                                                                                                        |
| `verifying`          | Worker is closed and checks are running.                                                                                                                                       |
| `accepted`           | Checks passed; a worktree task has a verified patch.                                                                                                                           |
| `rework`             | Verification failed; `retry` can continue in the same candidate cwd.                                                                                                           |
| `integrating`        | CAO is applying or rechecking retained checkout state in the target project.                                                                                                   |
| `integrated`         | Target checkout contains the change and target checks passed.                                                                                                                  |
| `integration_failed` | Patch apply failed, or target recheck failed after apply/recover. Applied changes are retained for inspection or repair, and the project is held.                              |
| `cancelled`          | Attempt was cancelled.                                                                                                                                                         |
| `interrupted`        | Worker or controller disappeared and CAO cannot safely continue automatically.                                                                                                 |
| `failed`             | Startup or flow failed without a usable worker. The reason code is on `inspect` `lastError` and `attempt.state.errorCode`; `herdr-server.log` is Herdr stdio, not that reason. |

## Isolation modes

### `worktree`

This is the default. The first attempt creates a detached Git worktree under the attempt directory. `retry` reuses the previous candidate cwd instead of creating a fresh worktree for every attempt, so partial work and failed evidence remain available to the next worker.

When verification passes, CAO creates `candidate.patch`. `integrate` later applies that patch to the target checkout and reruns checks there.

A worktree task that depends on another task requires that dependency to be `integrated`; otherwise the new worktree cannot see the dependency result.

### `checkout`

A checkout task writes directly in the target checkout. CAO uses a project-level checkout hold across runs sharing the same `stateRoot`.

A checkout hold applies to unaccepted checkout work. If a checkout task fails, is interrupted, or is cancelled after making changes, it continues to hold the project and blocks new tasks and integrations. Continue with `retry` on the original task, or stop the worker and use `recover` to verify the current checkout. If cancellation sees no changes relative to the task baseline, CAO marks `checkoutReleased` and releases the hold.

This coordination only applies to callers using the same state root. A different state root, manual shell, or external tool is outside CAO's lock.

## Scope is not a sandbox

`allowedPaths` is a verification scope, not a filesystem sandbox. The worker process still runs with the local user's permissions.

CAO enforces scope after collection:

- Task paths must be relative paths or directory prefixes; globs, absolute paths, backslashes, traversal, and `.git` are rejected.
- Directory prefixes must end with `/`. A path without a trailing slash is an exact file. Preflight, dispatch, and host start fail with `directory_scope_missing_slash` when snapshot files exist under a missing-slash directory. `src/` and `.` remain legal; there is no file-count cap.
- `collect` compares the candidate snapshot with the attempt baseline and puts out-of-scope tracked or untracked/non-ignored changes into `needs_input`.
- `verify` refuses candidates with scope violations.
- Untracked ignored files are not in snapshots, `changedPaths`, or patches, so `integrate` will not overwrite them. Tracked files are still tracked by Git and remain part of snapshots even if they match ignore patterns.
- `inspect.retryAdvice` is a sibling of `attempt`, not stored on it. Worktree `scope_violation` is `dispatch_new_task`; checkout/host `scope_violation` is `retry_with_feedback`; `rework` is `retry_with_feedback`; later rework (`number >= 2`) is `revise_or_split`.
- Worktree retry after `outsideScope` throws `scope_retry_forbidden`. Checkout and host retry after cancel remain legal so a checkout hold can be cleared. `recover` stays fail-closed for leftover edits.
- Provider saturation is `attempt.providerObservation.code`, not `lastError`. It does not authorize `retry`. `retry` remains legal only on `rework`, `failed`, `interrupted`, or `cancelled`.

## Result contract

The worker must write the attempt's `result.json` last. It must match the task id, attempt id, and nonce from `prompt.txt`.

```json
{
  "taskId": "fix-math",
  "attemptId": "fix-math-a1-1234abcd",
  "nonce": "uuid-from-prompt",
  "status": "submitted",
  "summary": "Fixed add implementation.",
  "changedFiles": ["src/math.mjs"],
  "checks": [
    {
      "name": "node tests",
      "status": "passed",
      "command": "node --test tests/math.test.mjs"
    }
  ],
  "children": [],
  "unresolved": []
}
```

`status` must be `submitted` or `needs_input`. Child statuses must be `completed`, `cancelled`, `running`, or `unknown`. If any child is `running` / `unknown`, or if `unresolved` is nonempty, CAO keeps the attempt in `needs_input`.

CAO does not observe native children. Child reporting is a worker contract, not telemetry.

## Prompt dispatch

The full assignment is written to `prompt.txt` in the attempt directory. The prompt actually sent into Herdr is a short entry prompt that tells the worker to read `prompt.txt` and execute the task and result contract. This avoids relying on long interactive paste for the full task body.

## Verification

`verify` accepts only `submitted` or already `accepted` attempts. It:

1. Confirms no scope violation.
2. Confirms the candidate has not changed since collection.
3. Closes the worker pane after identity checks.
4. Runs task checks in the candidate cwd.
5. Confirms checks did not mutate source state.
6. For passing worktree tasks, writes `candidate.patch` and `verification.json`.

If verification fails, the attempt becomes `rework`. `retry` creates a new attempt with a new nonce and reuses the same candidate cwd.

If the controller crashes during `verifying`, this MVP fails closed. `resume` does not rerun checks or mark the candidate accepted. Inspect retained processes, evidence, and checkout state before deciding whether to retry or handle recovery manually.

## Integration and recovery

`integrate` only handles accepted, stopped `worktree` attempts. It:

1. Confirms the candidate worktree still matches the verified snapshot.
2. Confirms the patch hash still matches verification.
3. Confirms every changed target file still matches the candidate baseline.
4. Confirms no checkout or integration hold blocks the project.
5. Runs `git apply --check`, then `git apply`.
6. Runs task checks in the target project.
7. Confirms target project state stayed stable during checks.

Integration evidence is written to `integration-<random>.json` in the attempt directory.

If `git apply --check` or `git apply` fails, the project normally remains unchanged but the attempt enters `integration_failed`. If apply succeeds and the target checks fail or mutate source, the applied changes are retained in the checkout and the project enters an integration hold. That hold blocks new dispatches and other integrations for the same project across runs sharing the same state root.

After repairing the retained checkout, run `recover`. Recovery for incomplete integrations rechecks the current checkout and does not apply `candidate.patch` again. Recovery for stopped checkout tasks snapshots the current checkout, checks scope, and routes back through verification.

CAO never resets, commits, or pushes automatically.

## Current verification boundary

Unit tests cover fake Herdr, task validation, state transitions, Git patching, integration/recovery semantics, and CLI argument handling.

A real Claude/Herdr control path has completed once through repair, verification, integration, and cleanup. A newer short-prompt happy smoke has also completed through `integrated` + `cleanup` after one inspected trust prompt for the test directory and no post-dispatch input. This is evidence that the path can work; it is not evidence of multi-agent throughput, native-child performance, or speedup.

Pi, OpenCode, and Codex currently have startup adapters and the same prompt/report contract, but no end-to-end validation claim.
