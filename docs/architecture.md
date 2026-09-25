# Architecture and modules

> 中文: [zh-CN/architecture.md](zh-CN/architecture.md)

HarnessOrbit is an explicit CLI controller. It is not a background orchestration daemon, does not change model/provider settings, does not install plugins, and does not commit or push. Execution commands load state, perform a stage, write evidence, and exit. Read-only queries inspect state, local usage records, or monitor metadata. The Agent Monitor can observe selected local HarnessOrbit/Codex/Claude metadata, but that observation is source-dependent and is not a native control plane for child agents.

## Runtime boundary

```text
User / Codex App
  -> node bin/harnessorbit.mjs <command>
      -> skill install/status/uninstall -> user skill link
      -> mode enable/status/disable -> conversation preference record
      -> Orchestrator
          -> State store
          -> Git / worktree / patch layer
          -> Herdr runtime
              -> claude | pi | opencode | codex
          -> verification commands
          -> optional local Agent Monitor
              -> HarnessOrbit state + Codex app-server/SQLite + Claude hook/local metadata
```

HarnessOrbit owns only the runs, attempts, Herdr session, workspaces/panes, and evidence it creates. Agent accounts, models, provider configuration, native delegation features, and local permissions remain owned by the corresponding tool installation.

The optional foreground supervisor drives those same stages for existing tasks. It holds a run-specific controller lock, returns on attention or its polling budget, and never installs a daemon. Post-commit performance projections and per-attempt timing are observational; `run.json` stays authoritative. See [supervision and performance](supervision.md).

## CLI layer: `bin/harnessorbit.mjs`

The CLI parses arguments, reads task files, creates the `Orchestrator`, and prints JSON. Supported run stages are `init`, `validate`, `dispatch`, `status`, `inspect`, `collect`, `verify`, `retry`, `resume`, `input`, `integrate`, `recover`, `cancel`, `cleanup`, `doctor`, and `usage`. Profiled execution adds `source discover`, `profile ...`, `secret ...`, `route ...`, and `gateway ...` commands. Local monitoring adds `monitor start`, `monitor status`, `monitor stop`, and `monitor snapshot`.

Key semantics:

- `dispatch` submits a task once.
- `collect` reconciles and waits; it does not resubmit the assignment.
- `verify` checks an already collected candidate; it does not continue the worker conversation.
- `integrate` applies a verified worktree patch to the target checkout and reruns checks there.
- `recover` rechecks retained checkout state. It does not rerun a worker and does not apply the same patch again.
- `monitor start --project <path> --open` starts a localhost, read-only dashboard. If `--project` is omitted, the CLI uses the current working directory's Git root. `--run` scopes the view to one HarnessOrbit run. `--all` is explicit and mutually exclusive with `--project` and `--run`.
- `monitor status`, `monitor stop`, and `monitor snapshot` inspect or stop the monitor server. Stopping the monitor does not stop agents. `--id` selects a named monitor, and `--port` selects or auto-allocates the localhost port.

## Codex skill and conversation mode

`skills/cao` is the installable entrypoint, with `HarnessOrbit` as its display name. `src/skills.mjs` links it into the user's skill directory and protects conflicting paths; updates follow the checkout. The wrapper resolves its real source path before invoking the CLI, retaining the target project's working directory. Installation is separate from conversation activation.

`src/conversation-mode.mjs` stores validated preferences under `conversations/<thread-id>/mode.json` in the HarnessOrbit state root. Identity comes from an explicit thread ID or the calling Codex environment. Updates use file locks and atomic writes; two conversations sharing a project still have separate records. The skill reads this record and supplies the selected agent/profile and limits while driving HarnessOrbit. The mode record does not change standalone CLI defaults, intercept model decisions, schedule work, or cancel workers when disabled. See [the HarnessOrbit skill guide](codex-skill.md).

## Execution profile layer: `src/profiles.mjs`, `src/routing.mjs`, `src/gateway/*`, `src/execution-config.mjs`

Profiles are optional execution selectors stored under the HarnessOrbit state root. They describe a native agent, protocol, endpoint, model, credential reference, source, manual capabilities, manual quality/speed/cost hints, quota hints, fallback ids, and HarnessOrbit attempt capacity buckets. `get` and `list` validate stored profile JSON before returning it, including schema version, revision hash, normalized public fields, and secret-like field rejection. Secret values are stored separately or read from environment/CC Switch references and are validated before use in HTTP headers.

Routing accepts either a fixed profile or an automatic candidate list with policy `available`, `quality`, `speed`, or `cost`. A concrete task agent filters profiles by agent compatibility. `agent: auto` allows the selected profile to determine the native agent. A default profile behaves like an execution selector for legacy tasks that omit `execution`; it can also satisfy an `agent: auto` legacy task.

Reservations are HarnessOrbit-attempt limits. A profile with `account.id` reserves an `account:<id>` bucket; otherwise HarnessOrbit reserves by endpoint host. `account.maxParallel` limits active HarnessOrbit attempts in that bucket and does not limit native children, provider-side API concurrency, or HTTP requests made inside one worker.

The gateway is a same-protocol local relay for Anthropic, OpenAI Responses, or OpenAI Chat profiles. It rewrites request model names using `modelMap` or `profile.model`, injects the resolved secret into upstream auth headers, filters protected headers, and can use same-protocol fallbacks. It does not perform OAuth or protocol translation. Fallback is conservative: HarnessOrbit may retry on clear pre-send network failures or upstream 429/5xx responses, but a connection break after bytes may have reached upstream is treated as uncertain rather than safely retryable.

`prepareExecution` writes per-attempt private native configuration and never mutates global provider files. Claude Code receives a generated settings file and session id; Codex CLI receives command-backed auth and `-c` provider overrides; Pi receives a provider extension; OpenCode receives inline config through `OPENCODE_CONFIG_CONTENT`. Profile-owned native arguments are rejected before launch.

The CC Switch source adapter is read-only. It supports schema version 18 direct Claude API records in `settings_config.env`, explicit `allowShared` reuse of the active Claude proxy, and Pi API-provider records with literal keys and explicit model catalogs. OAuth-only and other unsupported client records are surfaced as unsupported or gateway-required. See [resources and calibration](resources.md) for native/NVM discovery and isolated probe boundaries.

## Orchestrator: `src/orchestrator.mjs`

The orchestrator is the state machine and coordination layer.

- `init` resolves the Git root, records the base commit, baseline snapshot, initial dirty state, maximum parallelism, and a HarnessOrbit-owned Herdr session.
- `dispatch` validates a task, checks dependencies and holds, resolves any execution profile selector or default profile, reserves profile capacity, starts a gateway when profiled, prepares worktree or checkout isolation, starts Herdr server/workspace/agent, records identity, writes `prompt.txt`, and sends a short dispatch prompt.
- `collect` observes the Herdr agent, reads the result JSON, validates task/attempt/nonce, validates reported children, checks changed paths against the task scope, and saves terminal output.
- `verify` closes the owned worker, runs task checks independently, writes `check-*.json` and `verification.json`, and for accepted worktree tasks creates `candidate.patch`.
- `retry` creates a new attempt with a new nonce, reuses the previous candidate cwd, and carries failed evidence/feedback into the next `prompt.txt`.
- `integrate` applies an accepted worktree patch to the target checkout, records an integration operation, and reruns checks in the target project. Failure or cancellation creates a cross-run integration hold until recovery succeeds.
- `recover` rechecks current checkout state: incomplete integrations are verified without applying the patch again; stopped checkout tasks are moved back through verification using the current checkout.
- `cancel` closes the owned worker when identity still matches. Checkout cancellation releases the checkout hold only when there are no changes relative to that task baseline.
- `cleanup` stops the run's Herdr server and closes the run for future dispatch. It retains worktrees, evidence, and any checkout/integration holds.

## Agent Monitor: `src/monitor/*`

The Agent Monitor is a local read-only status surface for HarnessOrbit projects and related native agent metadata. The default scope is the current HarnessOrbit project: `monitor start --open` resolves the current working directory to its Git root and shows matching HarnessOrbit runs plus associated Codex/Claude children when they can be linked. `monitor start --run <runId>` narrows the scope to one run, while `monitor start --all` is an explicit machine-wide view. The three scope forms are intentionally exclusive. `--codex-home` and `--claude-home` point at the corresponding configuration roots, not project directories. `--coordinator` can be supplied when an older or cross-directory Codex coordinator thread should be associated with the project. All monitor state uses the same HarnessOrbit state directory as the run commands.

The monitor server binds to `127.0.0.1` and serves a tokenized URL such as `http://127.0.0.1:<port>/#token=...`. The browser stores that fragment token in `sessionStorage`; API calls use it as a bearer token, so the token is not persisted in HarnessOrbit state. Host/origin checks reject non-local access. The UI exposes metadata only and has no execute, prompt, input, cancel, or stop-agent controls. `monitor stop` stops only the local monitor server.

Monitor status is deliberately different from HarnessOrbit delivery state. HarnessOrbit `accepted` means HarnessOrbit independently verified and accepted the candidate. Native Codex/Claude `finished`, `idle`, or `completed` means the native agent reports no active work, not that HarnessOrbit accepted its patch. Snapshot records include source freshness such as live, observed, unknown, or stale so callers can distinguish connected data from local history and fallback metadata.

HarnessOrbit-managed Claude attempts can receive private hook settings that report sanitized lifecycle metadata. Legacy single `--settings` launches may be merged; `disableAllHooks`, `--bare`, multiple settings files, or unsafe settings paths degrade to lower-confidence metadata instead of forcing telemetry. Existing or unmanaged Claude sessions can still be observed through local metadata fallback, but confidence is lower. The hook path records lifecycle fields such as `SubagentStart -> running -> SubagentStop -> completed`; it does not store prompts, tool inputs, tool outputs, replies, or arbitrary hook payloads. Removing generated settings prevents future hook events while existing HarnessOrbit event records remain.

Codex observation prefers the local app-server proxy when available. On the current local app-server behavior, the proxy path is not available, so HarnessOrbit falls back to read-only SQLite observation from `thread_history_1` and `state_5`. That fallback is useful for coordinator/thread metadata, but it should not be documented as complete or fully real-time coverage. Native CLI trust files, history files, and provider behavior remain normal native-tool behavior; HarnessOrbit does not mutate global provider files for monitoring. See [Agent Monitor](monitor.md) for operator commands and source limitations.

## State store: `src/state.mjs`

The default state root is `~/.local/state/harnessorbit`; `--state-dir` can override it. If the new root does not exist but the legacy `~/.local/state/codex-agent-orchestrator` root does, HarnessOrbit uses the legacy root so existing runs and conversation preferences remain available. The state root must be outside the target Git worktree.

```text
<stateRoot>/
  runs/<runId>/
    run.json
    events.jsonl
    herdr-server.log
    attempts/<attemptId>/
      task.json
      prompt.txt
      result.json
      terminal.txt
      check-*.json
      verification.json
      candidate.patch
      integration-<random>.json
```

`herdr-server.log` is Herdr daemon stdio. Preparing-to-failed reasons live on `attempt.state.errorCode` and `inspect` `lastError`, not in that log.

JSON writes use a temporary file and atomic rename. Locks are directory locks with pid/hostname/nonce owners. HarnessOrbit only recovers a stale lock when the owner is on the same host and the process is definitely dead. Checkout and integration project locks live under `<stateRoot>/locks/`, so they coordinate only callers using the same state root.

## Task and prompt layer: `src/task.mjs`, `src/adapters.mjs`

`validateTask` rejects unknown keys and unsafe paths. Paths must be normalized relative paths or trailing-slash directory prefixes; globs, absolute paths, backslashes, traversal, and `.git` are rejected.

The full assignment is written to `prompt.txt`: objective, allowed paths, checks, native instructions, child-reporting contract, and result JSON skeleton. `dispatch` sends a short entry prompt asking the worker to read `prompt.txt` and execute the contract.

In inherited mode, adapters preserve provider settings:

- `claude` starts Herdr kind `claude` and prepends `--add-dir <attemptDirectory>` before task `agentArgs`.
- `pi`, `opencode`, and `codex` pass task `agentArgs` through unchanged to Herdr `agent start`.

`maxChildren` is a reporting contract only. HarnessOrbit validates the number and status values in result JSON; it does not hard-cap native children, provider-side API concurrency, or background work inside a native agent. The Agent Monitor can show selected metadata for some HarnessOrbit-managed or locally observed Codex/Claude children, but this is not enforcement and is not a completeness guarantee. Profiled mode adds temporary native configuration through `src/execution-config.mjs`; see [execution profiles](execution-profiles.md).

## Herdr runtime: `src/runtime/herdr.mjs`

The runtime targets an explicit named session and refuses default-session server operations. It strips inherited `HERDR_SOCKET_PATH`, `HERDR_SESSION`, `HERDR_PANE_ID`, and related Herdr environment variables before invoking Herdr, so commands do not accidentally target the caller's pane.

Main operations:

- `ensureServer`: starts `herdr --session <session> server` and polls `api snapshot` for up to 10 seconds.
- `createWorkspace`: creates a workspace at the attempt cwd without focusing it.
- `startAgent`: starts the selected Herdr agent kind in the root pane.
- `prompt`, `keys`, `readAgent`: submit the short prompt, send inspected human input, or read visible output.
- `getProcessInfo`: captures pane process identity.
- `closePane`, `stopServer`: close the worker pane or stop the HarnessOrbit Herdr session.

HarnessOrbit records and rechecks `paneId`, `terminalId`, foreground process group id, shell pid, and agent kind. If any of these identities change, HarnessOrbit refuses collect/input/cancel instead of adopting or closing an unknown process.

## Git layer: `src/git.mjs`

The Git layer handles snapshots, worktrees, patches, and integration checks.

- Snapshots include tracked files and untracked files that are not ignored by Git. Tracked files are included even if they match ignore patterns.
- Snapshots record hash, mode, and type; symlink targets are hashed without following the link.
- Snapshots treat gitlinks as opaque pointers (`type: gitlink`) and do not check submodule content out into candidates. They still reject paths that pass through symlink ancestors, and never read `.git`.
- Worktree tasks use `git worktree add --detach`. If the source checkout is dirty, HarnessOrbit writes the current tracked plus untracked/non-ignored state into a tree and resets the candidate worktree to that tree, preserving the user's baseline.
- `makePatch` uses a temporary `GIT_INDEX_FILE` to produce a binary patch without touching the user's real index.
- `applyPatch` runs `git apply --check` and then `git apply`; it does not stage, commit, or push.

Untracked ignored files are not part of snapshots, changed paths, candidate patches, or integration overwrites.

## Verification layer: `src/process.mjs`

Checks are spawned from argv arrays, never through a shell. Each check runs in either the candidate cwd or the target project cwd and observes its own `timeoutMs`. Timeout or cancellation kills the process group HarnessOrbit started. Captured output is bounded and written into evidence JSON.

Verification commands are expected not to edit source files. `verify` and `integrate` compare snapshots before and after checks; if checks mutate source state, the attempt fails or remains held for recovery.

## Current validation evidence

The base workflow has local tests and Claude Code live-scenario coverage. Profiled execution has been smoke-checked with Herdr 0.9+ using two Claude sessions against a local simulated Anthropic API: two profiles with separate models and keys completed Read/Write/Bash/tool-result submission, both candidates were independently accepted, 16 gateway requests matched expectations, global provider files stayed unchanged, and runtime resources were released. Monitor evidence includes a HarnessOrbit-managed Claude Explore child reporting `SubagentStart -> running -> SubagentStop -> completed`; independent acceptance and integration passed, and deleting generated settings prevented future hook events while retaining existing HarnessOrbit event evidence. This is integration evidence for local orchestration and metadata capture, not real model-quality, billing, or exhaustive UI coverage evidence.

## Token usage: `src/usage.mjs`, `src/runtime/tokscale.mjs`

`UsageService` queries an optional external Tokscale CLI and leaves the HarnessOrbit ledger unchanged. The adapter validates version, grouping, numeric fields, and aggregate totals before the service returns token buckets. Machine queries group client/provider/model; scoped queries call one workspace report per client, match recorded worker directories, and expose attribution precision and coverage. Checkout and ambiguous observations are separated from task totals. See [usage reports](usage.md) for installation, counter semantics, and coordinator/session limitations.
