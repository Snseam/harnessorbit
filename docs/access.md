# Agent access layer

The access layer lets a remote personal agent (for example Grok Bot or Dot) drive the Codex and Claude CLIs that live on the HarnessOrbit host. The agent never gets a shell: it submits a job, HarnessOrbit dispatches it through the normal `dispatch → collect → verify` pipeline in an isolated Git worktree, and the agent polls for status until something needs a decision.

It ships twenty tools over the Model Context Protocol and the same as CLI subcommands. Jobs: `describe`, `submit`, `status` to start and follow work, `approve`, `answer`, `cancel`, `retry` to act on the attention items `status` reports, `result` to read what the worker produced, and `events` to read the ordered history. Live sessions: `sessions`, `session_status`, `session_send`, `session_read`, `session_unbind` to continue an existing Claude Code or Codex CLI session the operator bound (see [Live sessions](#live-sessions)). Memory: `memory_recall`, `memory_begin`, `memory_checkpoint` (see [Memory](#memory)). Cooperation events: `coop_report`, `coop_inbox`, `coop_ack` (see [Cooperation events](#cooperation-events)).

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

The target checkout and agent come from the binding or job record, never from the request. An `operationId` stays bound to the principal incarnation, target, session bindingId, checkout, agent and authority that first used it; anything else is `operation_conflict`.

**Which Memy grant carries an operation** is fixed at `begin` by `authority`: `agent` (default) is the bound Claude or Codex session's own v1 grant, with Grok or any other principal recorded as an attributed participant; `orchestrator` is Memy's distinct orchestrator grant (`memy handoff … --agent orchestrator`) for checkpoints no session grant carries. The orchestrator carrier is available only when the host operator enabled it (`HARNESSORBIT_MEMORY_ORCHESTRATOR_CARRIER=1` after `memy connection orchestrator enable`); otherwise `begin` answers `unconfigured/orchestrator_carrier_unavailable` and no agent grant is borrowed instead. An orchestrator-carried checkpoint must name `attestationEventId`: a cooperation event the same principal (same incarnation) reported about the same target instance, meaning the same session binding or the same job attempt (intent revision) that the admission froze; an event from an earlier binding or attempt is `attestation_invalid`, and a job that moved to another attempt after `begin` makes the operation itself `operation_conflict`. The document keeps `session.agent` as the real work source (the bound Claude or Codex session) and carries `attested_by: principal:<id>@<incarnation>` and `attestation_ref: harnessorbit:event/<uuid>` inside `session`, as Memy's SessionRef defines them; the carrier appears only as `--agent orchestrator` on the CLI. A caller string is never an attestation source. Memy treats these as claims, not as verified facts, and never cryptographically verifies them. `memory_recall` takes the same `authority`, so a principal holding only the orchestrator grant has an explicit recall route that borrows nothing.

### Checkpoint semantics

- The document is rendered once, written durably to `<state>/access/memory/pending/` before the provider is called, and every retry sends the very same bytes (same `observed_at`). A retry may omit the body; a different body under the same `operationId` is `checkpoint_conflict`.
- Statuses: `saved`, `deduplicated` (the provider confirmed a replay), `pending` (provider offline, timed out or answered pending: the frozen document stays on the host, retry later), `denied` (final for this `operationId`; begin a new one), `unconfigured`, `invalid`. A replay always goes back to the provider; the local receipt never answers for it.
- Evidence you supply is attributed to you (`issuer: principal:<id>`) and never upgraded. `verified` and `integrated` labels are accepted only when HarnessOrbit's own job state agrees; live sessions can only carry `planned` or `reported`. HarnessOrbit adds its own machine evidence for jobs (`harnessorbit:attempt/<id>` with checks and patch sha256, `harnessorbit:integration/<id>`); it records a patch hash, not a commit.
- Provider receipts are validated per command (UUID operation id, UUID project id, write generation, UUID memory ids); a blank or mismatched success envelope is a protocol error, never a save.
- `access memory pending` lists pending operations for the operator.

## Cooperation events

Cooperation events let a bound agent say what happened to a task it owns, and let other registered agents read and acknowledge that durably. They complement polling: a coordinator drains its inbox on its heartbeat (or, where a transport adapter exists, is woken) instead of asking for status. Events are claims by their source; the bus transports them and upgrades nothing.

### Envelope (`harnessorbit.coop.event.v1`)

```json
{
  "schema": "harnessorbit.coop.event.v1",
  "eventId": "<server UUID>", "seq": 12, "createdAt": "…",
  "type": "work.reported",
  "source": { "principalId": "grok", "incarnation": "…", "kind": "grok", "via": "mcp", "binding": null },
  "task": { "ref": "harnessorbit:job/job-…", "kind": "job", "id": "job-…", "intentRevision": 1 },
  "conversationRef": "room-7", "correlationId": "thread-41", "causationId": "<eventId or null>", "hop": 0,
  "payload": { "summary": "…", "changed": ["src/math.mjs"] },
  "evidenceRefs": [{ "label": "reported", "ref": "worker:output", "issuer": "principal:grok" }]
}
```

- `source` is the authenticated principal (id, incarnation, kind) and how it reported; callers cannot set it. `task.ref` must be a job the principal owns or a session bound to it, re-checked against its current scope. `intentRevision` is the job's attempt number.
- Reportable types: `work.reported`, `task.blocked`, `verification.requested`, `question.asked`, `handoff.offered`. `agent.turn_finished` / `session.ready` come only from the observer; `verification.passed`, `verification.failed`, `task.integrated` only from a verifier (`authority_denied` otherwise). Evidence refs from callers may be `planned` or `reported` and are issued as `principal:<id>`.
- `payload` is plain JSON: depth ≤ 3, strings ≤ 2000 characters, ≤ 8 KiB. `causationId` must name a recorded event; chains are bounded to 8 hops.

### Storage, identity and recovery boundary (`harnessorbit.coop.store.v2`)

`<state>/access/coop/` holds three data files and one control record:

- `journal.jsonl`: append-only, one line per event commit holding the envelope, the idempotency record (principal incarnation + key hash + body hash) and the deliveries frozen with each recipient's registration epoch, with a per-line sha256 and `prev`, the sha of the line before it (`genesis:<generation>` for the first line of an empty log).
- `receipts.jsonl`: acks and dispatch attempts, same checksum and chain.
- `recipients.json`: the registrations, with the store `generation` and a `revision` that increases by one per replacement.
- `store.json`: the store's `generation` (one lineage identifier, minted once at init or at migration and never rotated by upgrades, epochs or incarnations) and the committed **boundary**: for each log the committed line count, byte count and last sha; the committed recipients revision and file sha; the retention floor (0, pruning is disabled). Every mutation appends (or replaces) and then rewrites `store.json` atomically; a caller gets a result only after that.

Opening the store runs under the store lock and verifies all three files against the boundary before anything is read or written: a file shorter or different inside the boundary fails closed (`store_rolled_back`, `receipts_rolled_back`, `recipients_rolled_back`; the store stays read-only with inspect/restore guidance, because a shorter prefix could erase an ack or an unknown-send and revive an old endpoint). Rows beyond the boundary are the crash window between an append and its commit: chained, valid rows are adopted into the boundary before the operation continues (a retry then finds the same UUID, an ack repeats, a `sending` attempt is unresolved), a genuinely incomplete final fragment (not parseable as JSON, no newline) is removed, and a complete row with a bad checksum or chain is corruption (`journal_corrupt`, `receipts_corrupt`) with or without its trailing newline, never repaired in place. A recipient replacement first persists `recipients.intent.json` with the pre-image sha and the exact post-image, so a crash in between rolls the frozen operation forward with its epochs unchanged; a crash after the boundary commit but before the intent is removed leaves only that cleanup to do, and nothing else is written. An intent that fits neither state is `recipients_corrupt`. Missing `store.json` on a root that carries data is `store_metadata_missing` (restore it), never an empty store; a root with no data is `store_uninitialized` until the host runs `access coop store init`; a store from before this protocol is `legacy_migration_required`. Remote calls never create, re-create or migrate a store. Sequence numbers come from the journal, never from wall-clock time; a restart replays the same UUIDs, order and payloads.

Fault model: process crash. The atomic writer syncs file and directory on rename; no power-loss guarantee is claimed. A consistent rollback of the whole root that no client can contradict is locally indistinguishable from a legitimate store; a client holding a newer scoped cursor detects it as `cursor_wrong_generation` or `cursor_ahead`.

```sh
node bin/harnessorbit.mjs access coop store init                     # host: persists a one-generation plan, then the empty files, then the boundary; refuses any root that holds data; rerun replays an interrupted plan
node bin/harnessorbit.mjs access coop store migrate --from-v1        # host, writers stopped and kept stopped: bring a pre-protocol store under the boundary
node bin/harnessorbit.mjs access coop store migrate --resume         # replay an interrupted migration's saved plan; the same generation, never a new baseline
node bin/harnessorbit.mjs access coop store inspect                  # read-only status, boundary, migration state, pending recovery
```

Migration verifies read-only, then persists a plan (one generation, the frozen bytes/hashes of the validated prefix of both logs, each log's exact original image, the original recipients content, and the one tail-only repair a log may need), then applies that repair only to a file that is still exactly the original image, replaces `recipients.json` with the same registrations and epochs plus the generation, and completes. No event or receipt line is rewritten; no UUID, body, sequence, delivery epoch or incarnation changes; nothing is acknowledged, regenerated or sent. While a migration is `in_progress` every other call refuses; `--resume` applies only the saved plan and blocks (`migration_blocked`) if a file no longer matches the frozen images. Stopping every old writer (`access serve`, `access coop dispatch`, `access observe`) and keeping old binaries off the root is the operator's precondition: the dispatcher-lock probe is best effort, and new code can reject unsupported versions and detect nonconforming rows (an old-style row without `prev` is corruption), but cannot make an old binary understand the new markers. Protocol guarantees begin at the migration baseline; the completeness of receipt history before it is not proven retroactively. The live pilot root is not migrated by this change.

### Tools

- `coop_report({ idempotencyKey, type, task: { ref }, payload?, evidenceRefs?, conversationRef?, correlationId?, causationId? })`: same key and body → the same event (`reused: true`); same key, different body → `event_conflict`. Permission and scope are read from the store again inside the lock.
- `coop_inbox({ cursor?, cursorV2?, limit? })`: events delivered to the inbox the operator registered for your current incarnation, oldest first. Choose one cursor mode before anything else: `cursor` (legacy numeric sequence, kept for compatibility; applied to the current store generation with `limitations` stated: no lineage check, no consumer-namespace check), `cursorV2` (a scoped token carrying store generation, sequence, consumer id, principal incarnation and registration epoch), or neither (bootstrap from your own start). Both at once is `invalid_cursor`. Every response returns `nextCursor` and `nextCursorV2`, `cursorMode`, `generation`, `committedSeq`, `more`, `withheld`, `retentionFloor`. A token from another lineage is `cursor_wrong_generation`; another consumer, incarnation or epoch is `cursor_namespace_mismatch` (a new identity starts from its own position, never from another's token); a position beyond the committed boundary is `cursor_ahead`; below the floor is `cursor_expired`; a malformed token is `invalid_cursor`. None of these falls back to numeric mode or jumps to the head, and reading never acknowledges. Tokens are positions, not authority. Each event carries `delivery.epoch` and whether that epoch is still your current registration.
- `coop_ack({ eventId, epoch })`: idempotent receipt for an event delivered to you under that epoch. It is not verification, approval or integration. Another consumer's event, an unknown event or another epoch is refused.

### Recipients (operator only)

```sh
node bin/harnessorbit.mjs access recipient register --id codex-inbox --kind inbox --principal codex --types work.reported,task.blocked,agent.turn_finished
node bin/harnessorbit.mjs access recipient register --id grok-hook --kind grok-native-webhook --endpoint https://… --secret-file /path/0600 --types work.reported
node bin/harnessorbit.mjs access recipient register --id codex-desktop --kind codex-app-server --socket /path/control.sock --thread <thread-id>
node bin/harnessorbit.mjs access recipient list | revoke --id ID
node bin/harnessorbit.mjs access coop deliveries
```

A registration fixes kind, destination, allowed sources, task-ref prefixes and types, and gets an epoch. Re-registering an id (after revoking it) yields a new epoch; deliveries frozen under the old epoch are reported `revoked`, never redirected. An inbox is bound to a principal incarnation; a recreated principal id has no inbox until the operator registers one. Non-inbox kinds are recorded as pending deliveries for a dispatcher; dispatch outcomes are `accepted`, `unknown` (the transport may have delivered; reconcile by `eventId` before any repeated side effect), `failed`, `revoked`, `dead`. The webhook and app-server transports themselves are the next milestone; until then those deliveries stay pending.

### Historical import (host only)

```sh
node bin/harnessorbit.mjs access coop import run-events --job ID [--limit 50] [--dry-run]
```

Imports stable-ID lifecycle facts of one job's own run event log (`runs/<runId>/events.jsonl`, lineage `harnessorbit.run-events.v1`) as `history.imported` events. Host CLI only: there is no MCP tool or route, the operator names a job id and never a path, and the importer reads only the job record and that run's file. It never submits, approves, answers, cancels, retries, adopts or integrates anything and never consults the orchestrator.

- **Rows**: `attempt.reserved` and `attempt.state` with a persisted `eventId`, the job's `runId` and `taskId`, an `attemptId` and a `timestamp`. Other well-identified contract rows are skipped (`unsupported_type`) and advanced over. A row that cannot be identified as this run's (unparseable, no `eventId`, another `runId`, another `taskId`, no `attemptId`, over 64 KiB) or a changed body for a known identity (`conflict`) is a gap: progress stops before it and never jumps it; there is no skip, abort or accept-replacement option.
- **Custody**: the job's recorded owner at its current incarnation (originally bound or previously adopted by the operator), re-read before every imported effect together with its current project and agent scope. The event's `source` is that custodian (`via: "import"`), documented as the authorized custodian and not the proven original author; the original `runId`, `taskId`, `attemptId`, `eventId` and `timestamp` are in `legacyRef`, `createdAt` is the import time, `intentRevision` is null.
- **Identity**: key `harnessorbit:run/<runId>/event/<eventId>` in the owner's idempotency namespace; body hash over the entire persisted row, key-sorted (`sourceBodyHash`, so a changed `sequence` or any extra field is a conflict). The displayed payload is a bounded projection that carries the hash and an `extraFields` count but never undisclosed field values. Same key and body → the same UUID (`reused`), nothing re-frozen or re-sent.
- **Protocol** (records in `receipts.jsonl`, kinds `import.prepare` and `import.checkpoint`, under the store chain and boundary): custody is looked up by job id and by run before the current mapping is accepted (`source_remapped`, `source_claimed`); the file is captured from one handle into one byte image, bounded by 8 MiB per batch and a 64 MiB prefix-verification cap (`source_prefix_cap`, `source_too_large`); the verified prefix must match the committed checkpoint (`source_shortened`, `source_replaced`, `source_unstable`); a preparation freezing custody, the prior checkpoint and the exact range and hash is appended before the first imported event; events commit one by one and index themselves; a checkpoint tied to the same plan closes the batch, hashing the captured image, never a re-read. An unresolved preparation is authoritative on the next run: the same bytes resume it (committed rows `reused`), anything else is refused with the plan and events preserved. A first import that consumes nothing still binds the job with an empty range; repeating the same EOF or gap writes nothing.
- **Opt-in**: a wildcard registration (`--types` omitted) never receives `history.imported`; only a registration naming it does. The type cannot be reported by a principal (`authority_denied`) and is refused as a memory attestation.
- **Dry run**: no durable domain-state write (lock bookkeeping under `locks/` is the only filesystem effect); it uses the examined records plus an in-memory overlay, preserves an existing intent, and reports `recovery_pending` or `plan_pending` instead of acting.

### Automatic end-turn signal

`access observe [--once] [--interval-ms 5000]` watches every bound session (never typing, never editing agent hook configuration) and records observer events attributed to the binding's principal with `source.via: "observer"`. Two grades exist, and the type says which:

- `agent.turn_finished`, from the provider's own record. For a Claude Code session whose provider session id is known (recorded at bind from `claude --resume <uuid>` / `--session-id <uuid>`, or stated by the operator with `--provider-session`), the observer tails that session's transcript (`~/.claude/projects/<encoded cwd>/<session>.jsonl`) read-only and emits one event per logical model turn whose `stop_reason` is `end_turn`, keyed by the provider message id (several content rows share one id; they are one turn). A baseline is taken when observation starts, so history is never replayed; the read cursor stops at the last complete line, so a partial tail is read later; a line larger than the 8 MiB read window is skipped as a whole and counted (`oversizedSkipped`) so later turns still arrive; the file's device and inode are tracked, so a replaced file of any size is a recorded reset of the source generation (read from its start, but rows timestamped before the observation baseline are never emitted) and a shrunken file is a reset that emits nothing. Only identities and timestamps leave the file, never message bodies. `tool_use` stops are not turn boundaries even when the screen looks ready. At emission the binding's principal must still hold the sessions permission and the bound checkout and agent must still be within its current project and agent scope. Observation state written by the first pilot is migrated in place: its pending screen transition stays pending as `session.ready`, an event it already committed is found by its old identity and reused unchanged, and nothing from it is ever relabelled as native evidence.
- `session.ready`, from the screen (working → ready). This is the fallback where no native source exists and is labelled a screen observation: the screen often shows "ready" between tool calls while the provider's turn is still running, so it is never presented as a turn boundary.

- `agent.turn_finished` for **Codex CLI** (observed on 0.163.0): at bind, the live process chain under the pane is inspected read-only for the one rollout JSONL it holds open together with the matching `thread-writer-locks/<uuid>.lock`; the rollout's first row must be `session_meta` whose `payload.id`/`session_id` equal that uuid and whose `payload.cwd` is the bound checkout. Only then does the binding carry a Codex `providerSession` (`source: open_files`; `--provider-session UUID` must match the discovered uuid and never stands in for the file). No latest-file guess, no scan of other sessions, no default-daemon resume, no remote-supplied path; when discovery fails the binding records a `nativeDiagnostic` (`no_open_rollout`, `ambiguous_rollouts`, `writer_lock_mismatch`, `header_session_mismatch`, `header_cwd_mismatch`, `lsof_unavailable`, …) and the screen fallback applies. The observer then emits one event per top-level `event_msg` row whose `payload.type` is `task_complete` with a non-empty `turn_id`, keyed by provider, binding, session and native turn id, as `payload.observation: native_task_complete` with `providerTurnId` (Claude's `providerMessageId` contract is unchanged; a Codex `msg_*` response id is never presented as a turn id). `task_started`, `turn_context`, assistant `response_item` text, `item_completed`, token counts and the screen never finish a turn; `event_msg` rows of any unsampled type (failure, cancellation) are counted as unverified and never become success. Baseline, partial tail, oversized line and shrink rules are the same as for Claude; a replaced or truncated rollout is re-validated by its header and, if it names another session or checkout, the observer reports `source_identity_mismatch`, reads nothing and waits for a rebind. Only identities and timings leave the file: `last_agent_message`, instructions and account fields are never copied.

Both are only observations: neither is task completion nor verification. Pending emissions are persisted before the store is called, so a crash between event and state save, a transient store failure or a repeated poll cannot emit the same identity twice or lose it. An initial idle snapshot is never a transition.

### Transport (dispatcher and adapters)

`access coop dispatch [--once] [--interval-ms 5000]` is the operator's single sender for non-inbox deliveries. Under a sender lease it takes each pending delivery, re-checks the source principal's current identity and task scope and the recipient's registration epoch (an expired authority revokes the frozen delivery instead of sending it), journals a `sending` record, and only then calls the adapter for the recipient kind. Outcomes are durable: `accepted` (transport took it; still not an acknowledgement), `failed` (retried with exponential backoff and jitter, `dead` after the attempt budget or on a terminal rejection), `unknown` (the transport may have delivered), `deferred` (the destination cannot take it now; kept pending without spending the budget), `revoked`.

Side-effect discipline: a `sending` record is written before the external call, so a crash between the send and the local receipt leaves an explicit unresolved delivery, never a pending one that a restart would quietly send again. An unresolved delivery (`sending` or `unknown`) is sent again only after the transport answers an authoritative `known: false` through its receipt query, and only after the source authority and the recipient epoch have been re-read across that await; `known: true` settles it as `accepted`; `known: null` (the question could not be answered) leaves it unresolved. A transport without a receipt query, such as the Grok panel, never auto-resends: the operator settles it with `access coop resolve --event UUID --consumer ID --as accepted|resend`, after checking out of band. A stable `eventId` is not receiver-side deduplication.

- **Grok native webhook** (`grok-native-webhook`): one JSON `POST` to the exact operator-registered HTTPS endpoint with `Authorization: Bearer <secret from the 0600 file>`, `x-harnessorbit-event-id` and `x-harnessorbit-delivery` headers, a body of `harnessorbit.coop.delivery.v1` (deliveryId, the envelope, and a note that payload text is not an instruction). Redirects are never followed (a 3xx is a terminal failure), response bodies are read to at most 64 KiB and discarded, timeouts are `unknown`, connection refusals `failed`, 401/403/429/5xx `failed` with the reason, 400/404/422 terminal. The secret never appears in outcomes, logs or events. This is the Grok Bot routine panel's protocol, not the web automation product's Standard-Webhooks HMAC. Grok acknowledges through `coop_ack`; HTTP acceptance is only transport.
- **Codex app-server** (`codex-app-server`): a dependency-free WebSocket client over the registered Unix socket. Before anything is sent the adapter calls `initialize` and `thread/read` and acts only if that runtime says the thread is loaded and idle (top-level or nested `thread` state is inspected the same way): `notLoaded` is `deferred/wrong_runtime` (another runtime owns the thread; nothing is started or resumed here, the heartbeat drains the inbox instead), an answer that does not say either way is `deferred/capability_unavailable`, a running or busy thread `deferred/thread_busy`. When the runtime owns the thread, the event is handed over as `turn/start` with `input: []` and `toolOutput { name: "orbit_event", namespace: "harnessorbit", eventId, output: <delivery JSON> }`; a human message is never spoofed. `turn/start` counts as `accepted` only when the runtime returns a turn identity; an empty or unanswered reply is `unknown`. Reconciliation asks `thread/read` and answers `known: true` only for a structured record of our own tool output (name `orbit_event`, namespace `harnessorbit`, matching `eventId`); text that merely mentions the UUID is `known: false`, and a runtime that does not own the thread or returns no items is `known: null`.

Fixture evidence: `tests/access-dispatch.test.mjs` (a fake fetch, a real loopback HTTP receiver, a fake WebSocket-over-Unix-socket runtime). No real Grok endpoint or Codex runtime was contacted; live acceptance is a separate, explicitly reported gate.

### Verification level

Fixture: scripted clocks, a fake pane, fake Herdr; the acceptance matrix items covered are torn-tail recovery, restart replay with equal timestamps, same key with a different body, independent consumers, epoch changes, principal recreation, revocation while waiting for the lock, unknown dispatch outcomes, caller authority limits, observer dedup across transient failure and crash, and (`tests/access-store.test.mjs`) store identity and uninitialised/metadata-missing refusal, in-place upgrade of a pre-protocol fixture with resume at each phase and drift blocking, crash windows after event/ack/attempt appends and around a recipient replacement, rollback or loss of each file inside the boundary, chain discipline beyond it, and both cursor modes. Not covered: a real Grok webhook, a real Codex runtime, a model-driven session.

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
