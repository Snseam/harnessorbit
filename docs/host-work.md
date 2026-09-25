# Track work in the current Codex conversation

> 中文: [zh-CN/host-work.md](zh-CN/host-work.md)

Host tasks register work performed by the current Codex conversation. They use the target checkout, retain its baseline, and run the same independent check runner. They do not create an external Codex session, Herdr pane, gateway, or external-session reservation.

Create a task file with the usual `id`, `objective`, `allowedPaths`, and nonempty executable `checks`. Omit `agent`/`isolation` or set `codex`/`checkout`; external `execution` profiles and launch arguments are not accepted.

```bash
node bin/harnessorbit.mjs init --project /path/to/project --id demo
node bin/harnessorbit.mjs host start --run demo --file task.json --thread THREAD_ID
```

After registration, make the scoped change. The response contains the task, attempt id, nonce and baseline. Use those exact ids in a result file:

```json
{
  "taskId": "task-id-from-start",
  "attemptId": "attempt-id-from-start",
  "nonce": "nonce-from-start",
  "status": "submitted",
  "summary": "Describe the candidate change.",
  "changedFiles": ["src/example.mjs"],
  "checks": [],
  "children": [],
  "unresolved": [],
  "hostStopped": true
}
```

Only declare `hostStopped` after editing and owned native children have stopped. `checks` in this report are self-reported evidence, not acceptance.

```bash
node bin/harnessorbit.mjs host report --run demo --task TASK_ID --file report.json --thread THREAD_ID
node bin/harnessorbit.mjs host verify --run demo --task TASK_ID --thread THREAD_ID
```

Collection checks actual changed paths and the current nonce; verification checks that the snapshot stays stable and runs each configured command independently. A false success report cannot bypass failing tests. Accepted host work has `deliveryMode: "in-place"`; it is not applied again through `integrate`. Full project acceptance is still distinct from candidate checks.

The current thread id is used automatically when the host provides it. An explicit id must agree with the current conversation and the recorded owner. It correlates locally owned work and is not an OS security or authentication mechanism.

## Repair and cancellation

- `host start --retry` with the same definition creates a new attempt/nonce after stopped `rework` or cancellation, preserving partial changes and enforcing `maxAttempts`.
- `cancel` only requests the current Codex to stop. It cannot terminate an App turn or unobserved native children.
- After confirming all writers stopped, `host release --ack-stopped` acknowledges the stop. Optional `--children-file` takes an array of complete child statuses and cannot omit previously reported children.
- If edits remain, the checkout hold remains. `host recover --thread THREAD_ID` independently rechecks retained edits and never restarts a worker or reapplies a patch.
- A supervisor can verify a stopped host report when invoked with the owning conversation identity. Running/unconfirmed host work produces attention; the supervisor does not try to read or control a fictitious terminal.

Other HarnessOrbit writers sharing the state directory respect the checkout hold. Manual tools and other state directories remain outside that coordination boundary. Unknown/running reported children prevent submission or release.
