# Changelog

Notable changes to HarnessOrbit are recorded here. Pre-1.0 interfaces may change between releases.

## Unreleased

### Added

- Opt-in, budgeted on-demand quick calibration for adaptive task dispatch, with saved conversation preferences, selector-aware candidate filtering, cache reuse and no probes during activation or when an eligible executor is already available.
- Configuration-bound readiness from independently verified external task deliveries, allowing a normally delegated native login session to establish evidence for later adaptive selection without exporting OAuth credentials. Host work, mock runtime evidence and ambiguous legacy overrides are excluded.

- Offline paired benchmark evaluation with predeclared experiment identities, separate existing-repository/greenfield cohorts, failure and missing-result denominators, cancellation sensitivity, and all-trial time-to-acceptance percentiles. Example data is synthetic; default adaptive rollout remains disabled.
- Monitor details for executor, adaptive resource/reasons, phase and blocked durations, and native-child evidence, with compact activity rows and preserved unknown values.
- Live isolated adaptive validation for Pi/Kimi and Claude/Grok, including an actual Claude Explore child, independent verification, integration and owned-runtime cleanup. This proves those tested paths, not a speedup over direct Codex.

- Opt-in adaptive dispatch (`dispatch --adaptive` or `mode enable --strategy adaptive`) that binds one eligible resource to an attempt, pins retries to that binding, and treats unfinished or unknown native children as blockers. Preference ranking uses completion rate before elapsed time; it is not a live-agent speed or quality guarantee.
- Optional bounded task briefs and unapplied `route shadow` recommendations with versioned per-conversation preferences. Existing dispatch defaults remain delegated.
- Current-Codex `host start/report/verify/release/recover` workflow with checkout ownership, explicit stopped reports, bounded retries and independent in-place verification; cancellation does not pretend to stop the App turn.
- English/Chinese host and shadow-routing guides, updated HarnessOrbit skill guidance, and host/external executor metadata in monitor snapshots.

- Native/managed `resources list/check`, including NVM installations, distinct Pi provider/model candidates, configuration fingerprints, quota freshness and cached call-verification evidence.
- Explicit isolated Claude/Pi `calibrate` quick/code suites, bounded model calls, private temporary configuration, independent code checks and real/mock-aware evidence caching. These probes are not production harness or overall quality benchmarks.
- CC Switch schema-18 Pi API-provider discovery and reference import, explicit Pi model metadata, and labelled unknown price/compatibility metadata.

- Foreground `step` / `supervise` commands to reconcile existing tasks and advance independent verification, with explicit integration and one-shot report-repair options, per-run controller ownership, deadline checks, and attention on unresolved work.
- Read-only task `preflight`, optional absolute `deadlineAt`, and atomic `result submit` with identity/size checks. Expired retained edits can still be explicitly rechecked through recovery without restarting implementation.
- `performance report` with observed phase/blocked durations, outcome and legacy-data coverage, sequenced post-commit observation events, and sanitized timing metadata in monitor snapshots. These are execution observations, not model inference benchmarks or speedup claims.
- English and Chinese supervision guides and regression coverage for acknowledgement loss, controller concurrency, deadline/recovery behavior, and end-to-end CLI verification/integration.

- Installable **HarnessOrbit** Codex skill, a copyable README installation request, and `skill install/status/uninstall` commands with linked-checkout updates and conflict protection.
- Per-conversation `mode enable/status/disable` preferences for continuing HarnessOrbit development across turns, with independent project/agent/profile/limit settings and recovery notes. Desktop activation uses the `/HarnessOrbit` skill suggestion; CLI supports `$cao` and `/skills`.
- `usage` queries local Claude Code, Codex CLI, Pi, and OpenCode token records through optional Tokscale tooling (`>=4.16.0 <5`).
- Agent/model/date filters, JSON or terminal-table output, and HarnessOrbit run/task workspace attribution with explicit precision and coverage metadata.
- Separate input, output, cache read/write, and reasoning counters; incomplete or shared checkout usage is not presented as an exact task total.
- An opt-in synthetic Tokscale integration test and bilingual token-usage documentation.
- Execution profiles for selecting native Claude, Codex, Pi, and OpenCode runtime settings per task without rewriting global provider files.
- Profile CRUD/default/export, stored and environment secret references, CC Switch source discovery/import, route explanation, gateway lifecycle commands, and HarnessOrbit-attempt reservation tracking.
- Profiled local gateway relay with same-protocol fallbacks, model rewriting, source drift checks, and private per-attempt native configuration for Claude Code, Codex CLI, Pi, and OpenCode.
- Bilingual execution-profile documentation and architecture notes covering routing, CC Switch schema-18 limits, secrets, gateway behavior, and current validation evidence.
- Profiled execution smoke evidence covers Herdr 0.9+ with two Claude sessions against a local simulated Anthropic API: separate models/keys, Read/Write/Bash/tool-result submission, two independently accepted tasks, 16 matched gateway requests, unchanged global provider files, and runtime release. This is not a real model-quality or provider-billing measurement.
- Local Agent Monitor commands (`monitor start/status/stop/snapshot`) for read-only localhost metadata dashboards over HarnessOrbit projects, individual runs, or explicit machine-wide scope.
- Monitor source adapters for HarnessOrbit state, Codex app-server/SQLite metadata, and Claude hook/local metadata, with source freshness labels and no storage of prompts, tool inputs, tool outputs, or replies.
- HarnessOrbit-managed Claude hook telemetry for sanitized child lifecycle metadata, with graceful degradation for disabled hooks, bare launches, unsafe settings, or unmanaged sessions.
- Monitor validation evidence covers a HarnessOrbit-managed Claude Explore child reporting `SubagentStart -> running -> SubagentStop -> completed`; independent acceptance and integration passed, and generated settings were removed after worker shutdown while existing event evidence remained. Browser checks cover desktop/mobile layouts, conversation isolation and retained selection, unlinked-only snapshots, token details, known zero, missing usage, and partial records.
- Agent Monitor Project and Conversation views, including explicit conversation-root graph relationships for Codex subagents, HarnessOrbit external agents, and Claude children without project-path parent guessing.
- Per-agent token metadata in monitor snapshots (`nodes.tokens` / `tokenUsage`) with session/turn/observed scope, source, completeness, and partial/scanned-window handling. These observations are not provider billing, subscription balance, or exact HarnessOrbit task cost.

### Fixed

- Treat leftover Git gitlinks as opaque snapshot pointers so nested worktree leftovers no longer fail `preparing`.
- Surface a bounded `errorCode` on `attempt.state` events, monitor timings, and supervisor HOLD attention; `herdr-server.log` remains Herdr stdio.
- Record `permission_required` or `worker_blocked` when Herdr is blocked, and restore `running` after that wait ends without auto-approving prompts.
- Annotate provider saturation on collect without replacing `lastError`; monitor waiting copy is not a HarnessOrbit retry.
- Reject directory scopes missing a trailing slash before reserving an attempt; worktree scope violations cannot retry leftover files.
- Close the Codex install-paste locate paths to exact `stat`s so installation does not walk session history.

- Restore the preflight-discovered agent directory inside every owned Herdr pane, including PATH discoveries, so login-shell PATH changes do not silently start older agents or Node runtimes.
- Resolve state-root aliases before resuming attempts, preventing macOS `/var` aliases from breaking telemetry identity checks and cleanup.
- Release adaptive Claude capacity when startup is cancelled after the worker closes but before an assignment is sent; submitted or still-unknown child work continues to hold capacity.
- Preserve child counts and timing evidence when the monitor sanitizes a snapshot twice, and distinguish bound adaptive attempts from unapplied shadow advice in recorded route reasons.

- Isolate mock Claude profile smoke runs from user configuration and session history, preventing synthetic `alpha` / `beta` models from appearing in normal model pickers and token reports. Explicit Claude config directories now reach the actual worker bootstrap as well as recorded log roots.
- Preserve command cancellation escalation after a leader exits, so TERM-resistant descendants are killed before cancellation settles.

## [0.1.0] - 2026-09-15

Initial public preview.

### Added

- A zero-dependency Node.js CLI for Herdr-managed coding-agent workflows.
- Durable run/task/attempt records, explicit task dependencies, capacity checks, and duplicate-dispatch protection.
- Isolated Git worktrees, dirty-baseline preservation, scope checks, patch verification, and project integration checks.
- Independent command verification, failure feedback, retry, cancellation, and guarded recovery.
- Launch adapters for Claude Code, Pi, OpenCode, and Codex CLI; a repository-local Codex skill draft.
- English and Simplified Chinese documentation, Apache-2.0 licensing, contribution guidance, and security reporting policy.
- Offline CI for Node.js 22 on macOS and Linux, with separately invoked Herdr and live-agent tests.

### Validation and limitations

- The original 67 local tests passed; the suite now separates 66 offline tests from one read-only Herdr integration test.
- Two local Claude Code scenarios passed: controlled failure/repair and normal task-file dispatch, including project integration checks.
- Pi, OpenCode, and Codex CLI live workflows remain unverified. Native subagent monitoring, a background scheduler, and large-scale performance evaluation are not included.

[0.1.0]: https://github.com/Snseam/harnessorbit/releases/tag/v0.1.0
