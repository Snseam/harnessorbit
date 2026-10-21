# Agent access layer

The access layer lets a remote personal agent (for example Grok Bot or Dot) drive the Codex and Claude CLIs that live on the HarnessOrbit host. The agent never gets a shell: it submits a job, HarnessOrbit dispatches it through the normal `dispatch → collect → verify` pipeline in an isolated Git worktree, and the agent polls for status until something needs a decision.

It ships sixteen tools over the Model Context Protocol and the same as CLI subcommands. Jobs: `describe`, `submit`, `status` to start and follow work, `approve`, `answer`, `cancel`, `retry` to act on the attention items `status` reports, `result` to read what the worker produced, and `events` to read the ordered history. Live sessions: `sessions`, `session_status`, `session_send`, `session_read`, `session_unbind` to continue an existing Claude Code or Codex CLI session the operator bound (see [Live sessions](#live-sessions)). Memory: `memory_recall` and `memory_checkpoint` (see [Memory](#memory)). A doorbell from host to agent comes later; until then `events` is how an agent catches up.

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

Input `{ jobId, text }` or `{ jobId, keys: ["Enter"] }`, exactly one of the two. Delivers a reply to a worker whose attempt is `needs_input` (attention kind `input`): text is sent as a prompt, keys as terminal key names (letters, digits, `+`, `-`, `_`, up to eight). The call then observes the worker once and returns; the job reads `running` until the worker finishes and `status` collects the new result. A worker that blocked during startup (for example Codex waiting on a trust or sandbox prompt, `lastError.code: agent_not_ready`) never received its task prompt, so after the reply the service resumes the launch and sends the prompt instead of collecting. `answer_not_allowed` when the worker is not waiting; `scope_violation` when the worker already wrote outside `allowedPaths`, which only `cancel` and a wider job can fix.

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

## Live sessions

A live session is an existing Claude Code or Codex CLI process in a tmux pane on the host. A principal can continue it, reusing all of its context, through five tools: `sessions`, `session_status`, `session_send`, `session_read`, `session_unbind`. This is a different capability from jobs: the session edits its own checkout directly, nothing it does runs through verification, and HarnessOrbit never treats what the agent prints as proof that work is done.

### Authorization

- The principal needs the `sessions` permission (`access principal update --id ID --allow-sessions`). `submit` does not imply it.
- The host operator binds one pane to one principal: `access session bind --principal ID --pane %N [--id NAME] [--allow-keys] [--label TEXT]`. Binding records the pane, its pane process, the agent process (pid, start time, executable), and the checkout the agent runs in, which must lie within the principal's `projects`; the agent kind must be in its `agents`. `access session discover` lists panes and which hold an agent. One pane holds at most one binding.
- Every call re-reads the principal from the store: permission bit, current `projects`, current `agents`, and the principal's identity (see [Identity and migration](#identity-and-migration)). A binding that fell out of scope is listed by id only and refuses every other call until the scope is restored.
- `allowKeys` is off by default. Without it a principal can only send text; approval prompts are answered by the operator.

### Identity checks

Before anything is read from or typed into a pane, the bound identity is re-verified: the pane exists with the same pane process, the bound agent process is alive with the same start time and executable, it still runs under that pane, it is the foreground process of its terminal (not suspended, not backgrounded), and its working directory is still the bound checkout. If the working directory cannot be read the call fails closed (`session_unverified`). Codes: `session_gone`, `session_replaced`, `session_exited`, `session_suspended`, `session_background`, `session_moved`.

### State

The bottom of the screen is classified as `idle` (an empty input box; only the exact placeholder each TUI shows counts as empty), `draft` (the box holds unsent text typed by someone else), `busy` (a spinner row such as `✽ Working… (esc to interrupt)`), `waiting_input` (a permission or trust dialog), or `unknown`. `unknown` and `draft` are never treated as idle. `idle` means the prompt accepts input; `completion.executionFinished` is always `unknown` and `verified` always `false`, because the screen cannot show whether the task is done.

### Tools

- `session_send({ sessionId, idempotencyKey, text | keys })`: types a message and submits it. Accepted only when the session is `idle` (`session_busy`, `session_waiting_input`, `session_draft`, `session_state_unknown` otherwise). `keys` such as `["Enter"]` are accepted only while a prompt is waiting and only if the binding allows keys; nothing is ever pressed automatically. The same `idempotencyKey` returns the earlier message; the same key with a different body is `idempotency_conflict`. Delivery is confirmed by one more transcript echo than before or a busy marker; otherwise the outcome is `uncertain` and the caller must read, never resend. Message bodies are not stored, only hashes and lengths. A binding remembers up to 5000 messages; beyond that the operator re-binds.
- `session_read({ sessionId, cursor?, maxLines? })`: returns the scrollback plus the transcript part of the screen since the cursor (oldest first, at most 400 lines and 64 KiB per call), the current bottom rows, the state, and `completion`. Rows the TUI rewrites in place (spinners, dialogs, the empty input box) are excluded so the cursor survives redraws. `reset: true` means the anchor scrolled away and the tail was returned.
- `sessions`, `session_status`, `session_unbind`: list, re-verify and classify, release your binding. The session keeps running on the host.

All mutations of one pane (bind, send, operator unbind) serialize on a per-pane lock, and permission, scope and the binding itself are re-read inside the lock, so a revoked permission or an unbind that raced in takes effect before anything is typed. A send never writes into a binding other than the one it loaded.

### Operator commands

```sh
node bin/harnessorbit.mjs access session discover
node bin/harnessorbit.mjs access session bind --principal grok --pane %3 --id claude-main
node bin/harnessorbit.mjs access session unbind --session claude-main --operator
```

## Memory

Memory lets an agent recall what is known about a session or job before continuing it, and save a distilled handoff checkpoint afterwards. HarnessOrbit owns identity, permissions, busy/idle, idempotent sending and verification state; the memory provider stores goals, decisions, constraints, open questions and sourced handoff notes. Recalled memory is untrusted evidence: it grants no permission, is not a lock or a command, and is never injected into a session by HarnessOrbit. The caller decides what to forward.

### Provider

The production provider is Memy's own `memy handoff` CLI (contract `memy.handoff.v1`, AgentMemory issue 1429, PR 1430). HarnessOrbit spawns it with the bound checkout as working directory; Memy resolves checkout → connection → Project OAuth grant itself. HarnessOrbit passes no token, project id, tenant or namespace, and never maps a path to a namespace. Enable it with `HARNESSORBIT_MEMORY_PROVIDER=memy-handoff-cli` (and `HARNESSORBIT_MEMY_BIN` if `memy` is not on PATH). Without it the provider is `none` and every memory call answers `unconfigured` with the reason. Only `claude` and `codex` sessions are integrated agents on the Memy side; others answer `unconfigured/agent_unsupported`.

### Flow

1. `memory_recall({ sessionId | jobId, question, topK ≤ 10, exclude? })`: bounded items with `observedAt` and whitelisted provenance; statuses `ok`, `degraded`, `unconfigured`, `denied`, `timeout`, `invalid`, `error`.
2. `memory_begin({ sessionId | jobId, operationId })`: admission before you gather handoff content. Idempotent per `operationId`; the provider re-checks that the original admission is still current.
3. `memory_checkpoint({ sessionId | jobId, operationId, summary, goals, decisions, constraints, openQuestions, participants, evidence })`: saves the `memy.handoff.checkpoint.v1` document under the same `operationId`. Without a prior `begin`: `not_begun`.

The target checkout and agent come from the binding or job record, never from the request. An `operationId` stays bound to the principal incarnation, target, session bindingId, checkout and agent that first used it; anything else is `operation_conflict`.

### Checkpoint semantics

- The document is rendered once, written durably to `<state>/access/memory/pending/` before the provider is called, and every retry sends the very same bytes (same `observed_at`). A retry may omit the body; a different body under the same `operationId` is `checkpoint_conflict`.
- Statuses: `saved`, `deduplicated` (the provider confirmed a replay), `pending` (provider offline, timed out or answered pending: the frozen document stays on the host, retry later), `denied` (final for this `operationId`; begin a new one), `unconfigured`, `invalid`. A replay always goes back to the provider; the local receipt never answers for it.
- Evidence you supply is attributed to you (`issuer: principal:<id>`) and never upgraded. `verified` and `integrated` labels are accepted only when HarnessOrbit's own job state agrees; live sessions can only carry `planned` or `reported`. HarnessOrbit adds its own machine evidence for jobs (`harnessorbit:attempt/<id>` with checks and patch sha256, `harnessorbit:integration/<id>`); it records a patch hash, not a commit.
- Provider receipts are validated per command (UUID operation id, UUID project id, write generation, UUID memory ids); a blank or mismatched success envelope is a protocol error, never a save.
- `access memory pending` lists pending operations for the operator.

## Identity and migration

Every principal carries an `incarnation`, set when it is created. Jobs, session bindings and memory operations record the incarnation that created them, and every call compares the authenticated request's incarnation with the store's current record. Removing a principal id and creating it again produces a new incarnation that cannot see or continue the old one's jobs, bindings or operations, and a request authenticated before the recreation is refused.

Principals and jobs recorded before this existed (access layer 0.3.0 on a host) answer `legacy_migration_required` until the operator migrates them explicitly:

```sh
node bin/harnessorbit.mjs access principal migrate --id grok      # once: persists a derived incarnation
node bin/harnessorbit.mjs access principal adopt-jobs --id grok   # assigns that principal's pre-identity jobs to it
```

Both steps are reviewable and idempotent; nothing is adopted automatically. Session bindings without identity fields answer `session_rebind_required` and are re-bound by the operator.

## Verification levels

- **Fixture**: `tests/access.test.mjs`, `tests/access-memory.test.mjs` and `tests/access-sessions.test.mjs` run against a fake Herdr, a scripted memory provider, a fake `memy handoff` CLI that speaks `memy.handoff.v1`, and fake Claude/Codex agents in a private tmux server (`-L cao-test-…`, never the operator's). They are regression evidence for the contracts above.
- **Real tmux**: the fake agents run in real tmux panes, so pane identity, foreground-process checks, bracketed paste and capture work for real.
- **Not covered here**: a real Claude Code or Codex session driven by a model, a real Memy server or connected checkout (this host has no Memy credential), and Grok Bot end to end. Those need live acceptance on a prepared host and are reported as such, not inferred from fixtures.

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

## Example: Grok continuing a bound session with memory

```text
1. sessions                          → one binding "claude-main", identity ok, state idle
2. memory_recall  { sessionId: "claude-main", question: "open decisions on the access layer?" , topK: 5 }
   → status ok, 3 items with observedAt and provenance; review them, forward only what matters
3. session_send   { sessionId: "claude-main", idempotencyKey: "room-7/msg-41", text: "<message>" }
   → outcome sent; state busy
4. session_read   { sessionId: "claude-main", cursor: <from previous read> } … repeat while state is busy
   → lines; completion.promptReady true when idle again (not proof the task is finished)
5. memory_begin   { sessionId: "claude-main", operationId: "room-7/msg-41/handoff" }
6. memory_checkpoint { sessionId, operationId, summary, decisions, openQuestions, evidence: [{ label: "reported", ref: "session:claude-main" }] }
   → saved | pending (retry same operationId) | denied (new operation)
```

## Not in this phase

- Durable cooperation events (report / inbox / ack), recipient registration and transport adapters for Grok and Codex: see [the roadmap](access-roadmap.md). `events` with `since` remains the pull-side history of jobs.
- A headless runtime for hosts without Herdr.
- OAuth. Fixed bearer headers are what Grok's custom connectors support today; OAuth is added only if a target platform requires it.
