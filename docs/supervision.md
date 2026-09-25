# Foreground supervision and performance evidence

> 中文: [zh-CN/supervision.md](zh-CN/supervision.md)

HarnessOrbit can now advance existing tasks through collection and independent verification without a separate model decision at every normal stage. It preserves the existing task/attempt identity, Git scope, verification, and integration holds.

## Use with an existing run

```bash
# Optional read-only preflight before dispatch: Git snapshot and required executables.
node bin/harnessorbit.mjs preflight --run demo --file task.json

# Reconcile existing tasks once; never creates or retries an implementation task.
node bin/harnessorbit.mjs step --run demo

# Poll and advance normal stages. Stop on a blocker or when the wait budget expires.
node bin/harnessorbit.mjs supervise --run demo --wait-ms 30000

# Explicitly permit integrating accepted worktree patches and one report-only repair.
node bin/harnessorbit.mjs supervise --run demo --integrate --repair-reports

# Query committed performance evidence without starting or observing an agent.
node bin/harnessorbit.mjs performance report --run demo
```

Use the same `--state-dir` as the run when it is not the default. Preflight does not authenticate, refresh credentials, or make a model request; an executable being present does not prove its account is usable. Dispatch also performs preflight before starting a worker. Unsupported Git snapshots and missing runtime executables fail early, retaining diagnostic evidence.

`supervise` runs in the foreground. Its polling budget is at most 45 seconds; already-started verification/integration checks finish under their own check timeout and optional task deadline, so a call can take longer than the polling budget. There is no installed daemon or watchdog between calls. Continue after `timeout` when work remains; inspect `attention` before deciding on recovery. A single per-run controller lock prevents two supervisors from acting at once. The dashboard remains read-only and does not keep supervision alive.

Without `--integrate`, accepted worktree patches stay ready for review. Checkout tasks already modify the project and are never passed through patch integration. Settled task checks are not proof of complete product acceptance: performance reports retain `projectAcceptance: "unknown"`.

## What is automatic

- Collect from the same identified worker without replaying the assignment.
- Verify a submitted snapshot using the task's independently run checks.
- With `--integrate`, apply and recheck an accepted worktree patch through the existing integration rules.
- With `--repair-reports`, request a missing or malformed report once per attempt. The durable intent is written before sending; a lost acknowledgment is reconciled rather than resent.
- While supervision is active, request cancellation of expired owned work. Cancellation identity checks and retained-checkout holds still apply.

Permission prompts, authentication, stale nonces, scope violations, unknown/running children, failed checks, and ambiguous controller state require attention. Supervision does not approve prompts, retry implementation, change providers, create new tasks, clear holds, commit, or push. Lack of confirmed progress triggers attention rather than guessing that a silent process has stopped.

A Herdr `blocked` wait records `lastError` as `permission_required` or `worker_blocked`. Inspect with `inspect --output`, send `cao input` only for that inspected dialog, then `resume`. After the pane leaves `blocked`, collect restores `running`. Supervisor attention uses that error code; leftover `:failed` attention keys are not migrated. Provider saturation is recorded as `providerObservation` and does not replace `lastError`; monitor waiting is not a HarnessOrbit retry. `inspect.retryAdvice` tells whether a scope violation needs a new worktree task or a checkout retry.

## Optional task deadline

Set `deadlineAt` to an absolute UTC timestamp in task JSON, for example `"2030-01-02T03:04:05.000Z"` (replace with your actual deadline). It is preserved across attempts, preventing retries from resetting the task's budget. Omit it to retain legacy behavior.

Launch and independent checks enforce this deadline while their controllers are running. Supervision also checks it before advancing work. If no controller is running, a worker can continue past the deadline; the next supervision call reconciles and cancels expired work. HarnessOrbit cannot promise hard real-time termination of unobserved native descendants.

Expiry does not discard edits or release an uncertain writer. Explicit `recover` can run bounded checks on retained checkout/integration state after expiry, without restarting the worker or replaying a patch. Starting more implementation work needs a task with an appropriate new deadline.

## Atomic worker reports

New attempt directories contain `submission.json` alongside `task.json` and `prompt.txt`. A worker may pipe its existing result JSON into:

```bash
node /absolute/path/to/cao/bin/harnessorbit.mjs result submit --attempt-dir /absolute/attempt --stdin
```

Alternatively use `--file /path/to/report.json`. The helper validates identity, report shape and size, then atomically writes `result.json`; it refuses symlink result files. It returns `accepted: false`: only collection against the authoritative run and independent verification can accept work. Direct result-file writing remains compatible with older workers.

## Reading performance reports

New attempts track preparation, launch, execution, collection, verification and integration intervals. Blocked intervals are separate and are not labelled model inference time. Observation timestamps do not by themselves advance the progress timestamp. Missing legacy history is explicitly unknown.

The report includes all attempts and outcomes, including failed, timed-out, cancelled and unjudged work. `totalElapsedMs` is the **sum of observed attempt durations**, not a project speedup or wall-clock duration; `runWallMs` is separate. Acceptance statistics do not establish product completion. Token accounting remains available through `usage`, with its own attribution limits.

Committed `run.json` remains authoritative. `performance.observed` entries in `events.jsonl` carry a schema version, stable event id, sequence and controller epoch when available. Event append failures mark coverage incomplete; old events without those fields remain readable. Performance output excludes full prompts, provider configuration, nonces and terminal output.

Foreground supervision works with [resource discovery and isolated calibration](resources.md), [advisory routing](shadow-routing.md), [current-Codex host work](host-work.md), and explicitly enabled [adaptive dispatch](adaptive-dispatch.md). Pi RPC and default-workflow rollout remain follow-up work. Protocol tests do not establish a measured speedup.
