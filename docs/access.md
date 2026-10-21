# Agent access layer

The access layer lets a remote personal agent (for example Grok Bot or Dot) drive the Codex and Claude CLIs that live on the HarnessOrbit host. The agent never gets a shell: it submits a job, HarnessOrbit dispatches it through the normal `dispatch → collect → verify` pipeline in an isolated Git worktree, and the agent polls for status until something needs a decision.

It ships nine tools over the Model Context Protocol and the same nine as CLI subcommands: `describe`, `submit`, `status` to start and follow work, `approve`, `answer`, `cancel`, `retry` to act on the attention items `status` reports, `result` to read what the worker produced, and `events` to read the ordered history of your jobs. A doorbell from host to agent comes later; until then `events` is how an agent catches up.

## Topology

```text
Grok Bot (cloud)  --MCP over Streamable HTTP-->  tunnel or tailnet  -->  127.0.0.1:<port>/mcp
                                                                         access serve
                                                                           └─ Orchestrator → Herdr → claude | codex
Dot (sandbox)     --shell-->  harnessorbit access submit|status  (same service, no network)
```

- The server binds loopback only. You expose it with your own tunnel (cloudflared, ngrok) or a private network (Tailscale). HarnessOrbit never opens a public port.
- Every call authenticates with a principal token in `Authorization: Bearer`. There is no anonymous access.
- The host keeps authoritative state in `run.json` as always. Jobs only map a principal's request to a run and a task.
- Nothing reaches the project checkout until integration. A principal integrates through `approve` only when it was created with `--allow-integrate`; otherwise the host operator runs `harnessorbit integrate`.

## Principals

A principal is one remote caller with a scope.

```sh
node bin/harnessorbit.mjs access principal create --id grok \
  --project /path/to/repo[,/another/repo] --agents codex,claude --label "Grok Bot"
```

The command prints the token once. HarnessOrbit stores only its SHA-256 in `<state>/access/principals.json`. Fields:

| Field | Meaning |
| --- | --- |
| `projects` | Absolute directories (realpath) the principal may submit work for. Anything else is `project_not_allowed`. |
| `agents` | Which local CLIs it may choose. The first one is the default. |
| `permissions` | `submit` (also gates `answer` and `retry`) and `cancel` default on; `integrate` default off (`--allow-integrate` to enable; it gates `approve`). |
| `rateLimitPerMinute` | Token bucket for write tools (`submit`, `approve`, `answer`, `cancel`, `retry`) on the MCP server. Default 60. |

`access principal list` and `access principal remove --id ID` manage them.

## Serving

```sh
node bin/harnessorbit.mjs access serve --port 7777
```

The command prints `{ endpoint, port, pid }` and stays in the foreground until Ctrl-C. Run it in tmux. Then publish the endpoint:

- **Tailscale**: `tailscale serve --bg 7777` on the host; the remote agent uses the tailnet URL. Preferred, no public exposure.
- **cloudflared**: a named tunnel pointing at `http://127.0.0.1:7777`; the remote agent uses the stable hostname.

Register the URL as a custom MCP connector on the agent's side with a fixed header `Authorization: Bearer <token>`.

### Protocol

- Transport: Streamable HTTP, JSON responses only (no SSE stream, no sessions). `POST /mcp` with one JSON-RPC 2.0 message per request; batches are rejected.
- Methods: `initialize` (protocol versions 2025-06-18, 2025-03-26, 2024-11-05), `ping`, `tools/list`, `tools/call`. Notifications return 202.
- A request with a non-loopback `Origin` header is rejected; browsers are not clients.
- Tool failures come back as `isError: true` with `{ code, message, details }`, never as HTTP errors, so the agent can read them.
- Tools return within 20 seconds (`tool_timeout` otherwise). Long work never blocks a call; `status` polls it.

## Tools

### `describe`

Returns the principal's scope, limits, the submit contract, and the lifecycle (states, attention kinds, next actions). Agents should call it first.

### `submit`

```json
{
  "idempotencyKey": "room-6ac9…-msg-42",
  "project": "/Users/me/repo",
  "objective": "Make add() add its inputs; keep existing tests passing.",
  "context": "User reported add(3,4) returns -1. tests/math.test.mjs already encodes the expected behaviour.",
  "agent": "codex",
  "allowedPaths": ["src/math.mjs"],
  "checks": [{ "name": "tests", "argv": ["node", "--test", "tests/math.test.mjs"], "timeoutMs": 60000 }],
  "brief": { "taskKind": "bugfix", "risk": "low" },
  "conversationKey": "6ac9ebe094c081a28db48ac493ac0dc2"
}
```

- `idempotencyKey` is required. A repeated key returns the original job (`job.reused: true`) instead of dispatching again, so a caller whose request timed out can safely retry.
- `context` is required. It is handed to the worker as native instructions; a bare objective is not accepted.
- `checks` is required and nonempty. HarnessOrbit runs them itself against the candidate; the agent's own claim of success is not trusted.
- `allowedPaths` defaults to the whole project. Directory scopes must end with `/`. Worktree isolation is always used; `checkout` is not offered to principals.
- `conversationKey` is stored for correlation only. It is never used for authentication.
- Each job is its own run (`runId === job.id`, task id `main`), so project-level holds and capacity rules from the orchestrator still apply.

If dispatch fails after the job was recorded (for example Herdr is down), the job is kept with `state: attention`, `attention[0].kind: retry`, and the same idempotency key keeps returning it.

### `status`

Input `{ jobId }`. Besides reading, it moves the job forward: a running worker is collected, a submitted candidate is verified (up to three stages per call). The CLI waits for them. The server waits up to eight seconds for them to settle, then answers with the state it has and lets the stage finish in the background. Output:

```json
{
  "state": "attention",
  "job": { "id": "job-…", "runId": "job-…", "taskId": "main", "agent": "codex", "reused": false },
  "attempt": { "status": "accepted", "number": 1, "changedPaths": ["src/math.mjs"], "verification": { "checks": [{ "name": "tests", "status": "passed" }] }, "lastError": null, "retryAdvice": null },
  "attention": [{ "kind": "integrate", "target": ["src/math.mjs"], "risk": "low", "since": "…", "how": "Call result to review the patch, then approve with kind=integrate." }],
  "attention_pending": 1,
  "next_action": "approve"
}
```

States: `dispatching`, `running`, `attention`, `integrated`, `cancelled`. Attention kinds: `integrate`, `input`, `out_of_scope_write`, `retry`, `integration_recovery`, `operation_failed`. `next_action` is one of `status`, `approve`, `answer`, `retry`, `resubmit`, `cancel`, `result`, `operator`, `none`. A caller polls only while `next_action` is `status`. `retry` means call the `retry` tool on this job; `resubmit` means the job cannot continue (attempt limit reached, or the project moved under an accepted candidate) and a new job with a new `idempotencyKey` is needed; `cancel` means cancel this job and then submit a wider one; `operator` means only the host operator can continue.

### `approve`

Input `{ jobId, kind: "integrate" }`. Applies the verified patch to the project checkout and reruns the checks there, exactly as `harnessorbit integrate` does: the candidate must still match its verification snapshot, and the files it touches must be unchanged in the project since the candidate's baseline. Requires the principal's `integrate` permission (`permission_denied` otherwise) and an `accepted` attempt (`not_accepted`). On success the job is `integrated` and `next_action` is `result`. `job_busy` means a stage started by an earlier `status` call is still running on the server; call `status` again first. The same applies to `answer`.

If integration fails after the call returned (for example `integration_conflict` because the project moved), the next `status` shows an `operation_failed` attention item with that code. For `integration_conflict`, `candidate_changed`, and `patch_changed` the answer is a new job on the current baseline; everything else is for the host operator.

### `answer`

Input `{ jobId, text }` or `{ jobId, keys: ["Enter"] }`, exactly one of the two. Delivers a reply to a worker whose attempt is `needs_input` (attention kind `input`): text is sent as a prompt, keys as terminal key names (letters, digits, `+`, `-`, `_`, up to eight). The call then observes the worker once and returns; the job reads `running` until the worker finishes and `status` collects the new result. `answer_not_allowed` when the worker is not waiting; `scope_violation` when the worker already wrote outside `allowedPaths`, which only `cancel` and a wider job can fix.

### `cancel`

Input `{ jobId, reason? }`. Stops the worker and withdraws the job; nothing in the project checkout changes. A running worker is closed; an `accepted` candidate is withdrawn without integration and stops reporting the `integrate` attention; a job whose dispatch failed is closed. `already_integrated` once the patch is in the checkout, `integration_recovery_required` when integration stopped half-way. Afterwards `state` is `cancelled` and `next_action` is `none`.

### `retry`

Input `{ jobId, feedback? }`. Starts the next attempt of a job whose attempt ended in `rework`, `failed`, `interrupted`, or `cancelled`, through the orchestrator's `retry`: the previous worker is closed, and the feedback, the previous report, the failed check output, and the last error are handed to the new attempt in its prompt file. When the first dispatch never produced a worker (the `retry` attention after a dispatch failure), `retry` dispatches the original task again, with the feedback appended to the worker's native instructions.

`retry_not_allowed` while an attempt is still active or accepted; `attempt_limit` when the job's `maxAttempts` is reached (the `retry` attention item then carries `exhausted: true` and `next_action` is `resubmit`); `scope_retry_forbidden` after an out-of-scope write, because a retry would reuse the worktree's leftover files. A refused retry is not recorded. A retry on a withdrawn job revives it.

### `events`

Input `{ jobId?, since?, limit? }`. Returns `{ events, more, next_since, jobs }`: the ordered history of one job, or of all the principal's jobs (the 50 most recent) when `jobId` is omitted. Two sources are merged:

- the run's own event log (`run.created`, `attempt.reserved`, `attempt.state` with `from`/`to`/`errorCode`, `worker.input`, `task.collected`, `task.verified`, `task.integrated`, `task.attention`, …), reduced to the fields a caller can act on;
- the access layer's own record: `job.submitted`, `job.dispatch_failed`, `job.answered`, `job.approved`, `job.retried`, `job.withdrawn`, `job.operation_failed`.

Events are sorted oldest first by `at` and then by `id`. `next_since` is `<at>/<id>` of the last event returned; passing it back as `since` returns only later events, with no loss and no repeats even when several events share a millisecond. `limit` is 1 to 200 (default 100); `more: true` means another page is waiting. Periodic observations and supervisor bookkeeping are left out.

### `result`

Input `{ jobId, includePatch? }`. Returns the `status` view plus a `result` object: the worker report (`status`, `summary`, `changedFiles`, `unresolved`), the verification (`passed`, per check: `status`, exit `code`, `argv`, `stdout` and `stderr` tails of 4000 characters, `error`), `changedPaths`, `outsideScope`, and `integrated`. With `includePatch: true` it adds the verified unified diff (`patch.text`, up to 256 KiB; `patch_too_large` above that, `patch_unavailable` before verification passed). `result_not_ready` until the attempt has been collected.

## CLI path (same-host agents)

An agent that lives on the same machine as HarnessOrbit, such as Dot inside its own sandbox, needs no network: it runs the subcommands directly, scoped to a principal by id.

```sh
node bin/harnessorbit.mjs access describe --principal dot
node bin/harnessorbit.mjs access submit   --principal dot --file job.json
node bin/harnessorbit.mjs access status   --principal dot --job job-… [--no-advance]
node bin/harnessorbit.mjs access approve  --principal dot --job job-…
node bin/harnessorbit.mjs access answer   --principal dot --job job-… --text "Two inputs only."   # or --text-file FILE, or --keys Enter,y
node bin/harnessorbit.mjs access cancel   --principal dot --job job-… [--reason TEXT]
node bin/harnessorbit.mjs access result   --principal dot --job job-… [--patch]
node bin/harnessorbit.mjs access retry    --principal dot --job job-… [--feedback TEXT | --feedback-file FILE]
node bin/harnessorbit.mjs access events   --principal dot [--job job-…] [--since CURSOR] [--limit 100]
```

Each call returns the same JSON as the MCP tool. `status`, `approve`, `answer`, and `retry` run their host stage inline, so they may take as long as the verification checks and surface a host failure as the command's error; pass `--no-advance` to `status` for a pure read.

## Audit

Every call appends one line to `<state>/access/audit.jsonl`: time, principal, transport (`mcp` or `cli`), tool, job id, outcome, duration. Request bodies and tokens are never written. This file is how the host operator sees what a remote agent asked for.

## Not in this phase

- A doorbell webhook from the host to the agent. `events` with `since` is the pull-side half; the push half needs a target the agent can receive on.
- A headless runtime for hosts without Herdr.
- OAuth. Fixed bearer headers are what Grok's custom connectors support today; OAuth is added only if a target platform requires it.
