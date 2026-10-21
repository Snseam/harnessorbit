# Agent access layer: state and roadmap

Handoff notes for the three-party work on the access layer (HarnessOrbit code: Claude in this repository; architecture and independent acceptance: Codex; Memy side: AgentMemory issue 1429 / PR 1430). Kept in the repository so a coordinator picking up on a heartbeat has the current picture without a chat transcript.

## Stage 1 (this branch): live sessions and memory

Delivered on `feature/access-layer`, documented in [access.md](access.md):

- Jobs: `describe`, `submit`, `status`, `approve`, `answer`, `cancel`, `retry`, `events`, `result`.
- Live sessions: `sessions`, `session_status`, `session_send`, `session_read`, `session_unbind`; operator `access session discover|bind|unbind`.
- Memory: `memory_recall`, `memory_begin`, `memory_checkpoint`; provider interface with `NullMemoryProvider` and `MemyHandoffCliProvider` (contract `memy.handoff.v1`).
- Identity: principal `incarnation`; jobs, bindings and memory operations bound to it; `access principal migrate` and `adopt-jobs` for records that predate it.

Boundaries that stay true in later stages:

- Idle only means the prompt accepts input. Completion is an explicit report, verification is a separate verifier's evidence, integration is yet another step. The screen, an HTTP 2xx, model prose and memory contents certify none of them.
- Memory is evidence, never authority, lock or queue. Saving may fail independently of the work; a failed save stays pending on the host with frozen bytes.
- Every call decides on the store's current principal record (permission, projects, agents, incarnation), never on the token snapshot; checks are repeated after lock waits.
- Secrets never enter logs, audit lines, events, or git.

Verification level of stage 1: fixture and real-tmux tests (see "Verification levels" in access.md). Not live-validated: a model-driven Claude/Codex session, a real Memy connection, Grok end to end.

## Stage 2: durable cooperation events and wakeup

Coordinator contract: `events-phase2-contract.md` in the collaboration workspace (outside this repository).

Milestone A (this branch, after the stage-1 commit): the durable store (`src/access/coop.mjs`), `coop_report` / `coop_inbox` / `coop_ack` over MCP and CLI, operator recipient registration for `inbox`, `grok-native-webhook` and `codex-app-server` kinds (destinations fixed by the operator, epoch per registration, pending-delivery listing and durable attempt outcomes), and the session observer (`src/access/observer.mjs`) that records `agent.turn_finished` on an observed working → ready transition with a persisted transition identity. Fixture evidence: `tests/access-coop.test.mjs`, including the coordinator's two crash classes (torn journal tail before append; observer transient failure and crash between event and state save).

Milestone B (this branch): `src/access/dispatch.mjs` with the single-sender dispatcher, the Grok native-webhook adapter and the Codex app-server adapter (WebSocket over Unix socket, ownership check first), plus the memory authority selection (`agent` default, `orchestrator` carrier behind an explicit host flag with event-based attestation) from `three-party-memory-integration.md`. Fixture evidence: `tests/access-dispatch.test.mjs`, `tests/access-memory.test.mjs`. Still not live-validated. Original plan for the milestone: transport adapters and a dispatcher for pending non-inbox deliveries. Grok: exact operator-registered HTTPS endpoint with `Authorization: Bearer` from a 0600 secret file, no redirects, bounded response, HTTP acceptance recorded as `accepted` but never as an ack. Codex: the owning app-server runtime over WebSocket-on-Unix-socket with `turn/start` carrying `toolOutput { name: "orbit_event", namespace: "harnessorbit" }`; the default managed daemon's `notLoaded` desktop thread answers `wrong_runtime` and the delivery stays pending for heartbeat draining; never `turn/start` or resume on that daemon. Both adapters are tested against fake receivers first and reported as fixtures until a real probe is observed.

Summary of the contract, so this document stays self-contained:

- **Envelope**: schema version, server-generated UUID `eventId`, monotonic sequence, `createdAt`, type, authenticated source identity (principal incarnation / participant binding), `taskId`, task `intentRevision`, `conversationRef`, `correlationId`, `causationId`, bounded typed payload, `evidenceRefs`. No caller-controlled source or verification authority.
- **report(idempotencyKey, target, type, payload)**: one commit boundary for envelope + idempotency record + recipient deliveries (or a write-ahead protocol with a tested crash point). Same key and body → same UUID; changed body → conflict.
- **inbox(consumer, cursor, limit)**: authorized immutable envelopes; reading never acks; per-consumer progress by sequence, never a shared cursor.
- **ack(consumer, eventId, epoch)**: durable, idempotent receipt; neither verification nor integration; rejects another consumer, event or epoch.
- **Recipient registration**: host-only, exact kind, endpoint or runtime, thread, allowed sources and task scopes, secret reference. Remote callers cannot choose URLs, sockets or threads.
- **Delivery**: freeze event and recipient epoch before first send; recheck auth, scope and epoch before dispatch and after waits; bounded retries with backoff and jitter, leases, durable `nextAttemptAt`, terminal/revoked/dead-letter states, replay with the original UUID, retention floor, explicit gaps. Unknown transport outcome is its own state; reconcile before any repeated side effect. At-least-once transport with durable dedup; no claim of exactly-once execution.
- **Codex adapter**: the verified protocol is WebSocket over a Unix socket to the app-server. The default managed daemon reports the desktop thread as `notLoaded` while a separate stdio child owns it; that destination must answer `wrong_runtime` / `capability_unavailable` and keep the event for heartbeat draining. Never resume or `turn/start` the desktop thread on the default daemon. Where a registered runtime really owns the target: `turn/start` with `input: []` and `toolOutput: { name: "orbit_event", namespace: "harnessorbit", output: <envelope JSON> }`; never spoof a human message. The current ten-minute heartbeat is a supported fallback, not instant wakeup.
- **Grok adapter**: the native Grok Bot routine panel uses `Authorization: Bearer` against an HTTPS endpoint registered by the operator; it is not the Standard-Webhooks HMAC protocol of the web automation product. Distinct transport kinds, no redirects, bounded responses, no secret in logs. HTTP accepted is not an ack; Grok reads and acks through the tool contract. Until a real webhook, the same UUID in conversation, and a tool ack are observed, only fixture and transport acceptance are reported.
- **Acceptance matrix**: crash before and after the report commit; same key with a different body; independent consumers; replay preserves UUID and payload; clock rollback and equal timestamps; crash after remote accept before local receipt; duplicate and out-of-order acks; revoke or narrow scope while a sender waits; delete and recreate a principal or consumer; destination epoch changes; busy, draft, unknown session and wrong Codex runtime stay pending without duplicated input or turns.

## Operating rules during the work

- The access service already running on this host (port 7777, access layer 0.3.0) is not restarted, and its old jobs are not integrated or migrated, until the operator decides.
- No PR is merged or deployed from here; the coordinator opens and merges with the project's GitHub identity.
- Fixtures are reported as fixtures. Live acceptance is a separate, explicitly reported step.
