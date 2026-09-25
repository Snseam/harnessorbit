# Local Agent Monitor

> 中文: [zh-CN/monitor.md](zh-CN/monitor.md)

Agent Monitor is a local, read-only status page for HarnessOrbit tasks and related native Codex/Claude children. It is meant for checking parallel work: which HarnessOrbit attempts are running, waiting, accepted, or held for rework; which Codex subagent threads are related to a coordinator; and which Claude subagents were observed through HarnessOrbit-managed hooks or local metadata.

It is not a control plane. The page does not execute commands, send input, cancel tasks, stop agents, read terminal output, show prompts, show tool inputs, show tool output, or show model replies. Stopping the monitor stops only the monitor web server. Failed-attempt reason codes may appear as bounded `performance.lastErrorCode`; `herdr-server.log` remains Herdr stdio. Waiting labels may include `Provider saturated · not a HarnessOrbit retry`; that is not a retry instruction.

## Quick start

From a project checkout:

```bash
node /path/to/harnessorbit/bin/harnessorbit.mjs monitor start --open
```

If you are already using HarnessOrbit from this repository, the shorter form is:

```bash
node bin/harnessorbit.mjs monitor start --open
```

You can also ask Codex:

```text
打开当前项目Agent看板
```

A useful English equivalent is:

```text
Open the Agent Monitor for the current project.
```

To ask for the conversation-focused view with token columns, use:

```text
打开当前项目Agent看板，切到当前对话并显示每个Agent Token
```

The CLI defaults to the current directory's Git root. It shows HarnessOrbit runs for that project and associated Codex/Claude children that can be linked through the current HarnessOrbit state directory and coordinator metadata.

## CLI commands

```bash
node bin/harnessorbit.mjs monitor start [--project PATH | --run ID | --all] [--open] [--id NAME] [--port 0]
node bin/harnessorbit.mjs monitor status [--id NAME]
node bin/harnessorbit.mjs monitor stop [--id NAME]
node bin/harnessorbit.mjs monitor snapshot [--project PATH | --run ID | --all]
```

Extra source options:

```bash
node bin/harnessorbit.mjs monitor snapshot \
  --coordinator CODEX_THREAD_ID \
  --codex-home ~/.codex \
  --claude-home ~/.claude
```

Scope options:

| Option               | Meaning                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| omitted              | Use the current working directory's Git root as `--project`.                                                                                                                                                                                                                                                            |
| `--project PATH`     | Show one project. The path is resolved to its real path.                                                                                                                                                                                                                                                                |
| `--run ID`           | Show one HarnessOrbit run and its linked native children. The run must exist in the same state directory.                                                                                                                                                                                                                        |
| `--all`              | Explicitly show all readable HarnessOrbit runs and native metadata in scope. It is mutually exclusive with `--project` and `--run`.                                                                                                                                                                                              |
| `--coordinator ID`   | Explicitly associate a known Codex coordinator and its native descendant tree, including cross-directory work. Use only a thread that belongs to this project. Without `--run`, environment thread IDs are also discovered, but clearly foreign project children are excluded unless a HarnessOrbit run records the association. |
| `--codex-home PATH`  | Codex configuration/data root to inspect. Defaults to `CODEX_HOME` or `~/.codex`.                                                                                                                                                                                                                                       |
| `--claude-home PATH` | Claude configuration/data root to inspect. Defaults to `CLAUDE_CONFIG_DIR` or `~/.claude`.                                                                                                                                                                                                                              |
| `--id NAME`          | Monitor server name. Defaults to `default`; use another id for another scope.                                                                                                                                                                                                                                           |
| `--port N`           | Local port. `0` asks the OS for a free port.                                                                                                                                                                                                                                                                            |

Use the same `--state-dir` for monitor commands and HarnessOrbit runs you want to observe. A run created in one state directory is invisible to a monitor started with another state directory.

## Project and Conversation views

The UI starts in the Project view. Project view shows the current project scope selected by the CLI and keeps the existing project/run/task grouping. Conversation view focuses on one Codex conversation and its agent graph. You can switch between the views in the page; there is no separate CLI view flag.

Conversation view can show the Codex conversation associated with this monitor or another conversation that is already inside the collected scope. `currentConversationId` is the coordinator id associated when the monitor was started, from `--coordinator` or the captured environment. It does not follow the currently focused Codex App window, and it is not a global cross-conversation setting.

The conversation graph uses explicit relationships. Codex subagents, HarnessOrbit external agents, and Claude children can attach to the selected root conversation when metadata records identify that relationship. Unknown ownership is shown as Unlinked. The monitor does not guess parentage merely because two records share a project path.

Titles and names come from explicit native metadata when available. HarnessOrbit does not use prompt text, preview text, tool content, or model replies as a fallback title.

## Security model

The monitor server binds to `127.0.0.1` and rejects unexpected Host, Origin, query-token, and write requests. `monitor start` returns a URL with the UI token in the fragment, for example:

```text
http://127.0.0.1:49152/#token=...
```

The fragment is not sent in HTTP requests. The browser UI stores it in `sessionStorage` and sends it as an Authorization header for `/api/snapshot`. Internal health and stop endpoints use a separate owner token stored in the HarnessOrbit state directory.

The page is read-only. `monitor stop` calls the monitor's owner stop endpoint; it does not stop Herdr, Codex, Claude, HarnessOrbit tasks, subagents, terminals, or provider requests.

## What data crosses the browser boundary

The browser receives a sanitized metadata-only snapshot with bounded fields:

- ids and parent ids
- agent kind and source
- project/run/task/attempt ids
- model name when available
- native session id when available
- actual title/name metadata when available
- status, status label, delivery state, timestamps, confidence, stale flag, source health
- token metadata under `nodes.tokens` / `tokenUsage` when native records provide it

HarnessOrbit does not send prompts, tool inputs, tool outputs, terminal text, model replies, arbitrary error stacks, or raw native records to the page. Native CLIs may still write their own normal trust/history/session files. Monitor privacy means HarnessOrbit avoids exposing that content through its monitor API; it does not disable native CLI history features.

Profiled execution and monitor hooks do not rewrite global provider files. HarnessOrbit may create private per-attempt settings or hook files under the HarnessOrbit state directory.

## Per-agent token metadata

Monitor snapshots may include per-node token metadata as `nodes.tokens` plus normalized `tokenUsage` fields. The UI treats missing values as `—`. A record can be complete or partial; partial records and scanned-window records are displayed as incomplete observations, not as authoritative totals.

`tokenUsage` can include:

- `total`
- counters such as input, output, cache read, cache write, and reasoning
- `scope`: `session`, `turn`, or `observed`
- `source`
- `complete`

HarnessOrbit prefers native session totals when the native source exposes them. Claude usage is deduplicated by `message.id`; a parent conversation's own log is not automatically added to child rows. Cache and reasoning counters can already be included in input/output totals depending on the native source, so HarnessOrbit does not add those buckets again to compute a larger synthetic total.

These numbers are local usage metadata. They are not subscription balance, provider billing, or the independent cost of a HarnessOrbit task. They can also differ from provider invoices because native CLIs may aggregate, omit, or revise usage records differently.

## Interpreting status

HarnessOrbit delivery and native runtime state are different signals.

| Signal                                    | Meaning                                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `accepted` / `integrated` delivery        | HarnessOrbit independent verification accepted the attempt, or integration completed.                          |
| native `finished`, `completed`, or `idle` | The native runtime or subagent appears to have ended a turn or gone idle. This is not HarnessOrbit acceptance. |
| `submitted` delivery                      | HarnessOrbit collected a result JSON and the attempt is waiting for verification.                              |
| `rework` delivery                         | HarnessOrbit verification rejected the candidate and the task is waiting for retry/rework.                     |
| `running`                                 | HarnessOrbit or native metadata indicates active work.                                                         |
| `waiting`                                 | The agent likely needs input or a rework/retry action.                                                |
| `unknown`                                 | HarnessOrbit cannot safely determine the live status.                                                          |
| `stale`                                   | The observation is old or came from a fallback source rather than a live source.                      |

Each node includes a source and confidence. `live` means HarnessOrbit could observe the current runtime or hook stream. `observed` means local metadata or HarnessOrbit records indicate a state, but it may not be live. `unknown` means the source could not prove the current state. A stale flag can appear with any source when the data is no longer fresh.

Source health is separate from node status. A snapshot may show HarnessOrbit connected while Codex is partial or Claude unavailable. The page should be read as an evidence view, not as a complete scheduler truth.

## HarnessOrbit task source

HarnessOrbit records provide run, task, attempt, delivery, project, and verification/integration status. For active HarnessOrbit attempts, the collector also queries Herdr and checks the recorded pane, terminal, process group, shell pid, worker kind, and worker status when available. If identity no longer matches, the monitor marks the attempt unknown instead of adopting a different terminal.

## Claude source

For new HarnessOrbit-managed Claude attempts, HarnessOrbit tries to add private Claude Code hooks to observe parent and subagent lifecycle events. The hook integration follows Claude Code's hook mechanism: <https://code.claude.com/docs/en/hooks>.

Behavior:

- HarnessOrbit writes monitor hook events under the HarnessOrbit state directory.
- Hook records are sanitized. They keep metadata such as event type, agent role, subagent id/type, status, native session id, and timestamps; they do not keep prompt text or tool input/output.
- Legacy `--settings` is merged when there is a single readable settings source.
- `--bare`, unmergeable multiple settings, `disableAllHooks`, unsafe private paths, or settings read failures degrade gracefully. The attempt still launches, but Claude hook telemetry may be disabled or partial.
- HarnessOrbit evidence has shown one Claude Explore subagent moving `SubagentStart → running → SubagentStop → completed`; the HarnessOrbit task then passed independent verification and integration. Deleting generated settings removed future hook collection while previously recorded events remained as evidence.

Existing or unmanaged Claude sessions may be shown from local metadata fallback when available. Those rows are low-confidence metadata: they can help identify activity, but they may be stale and are not a complete live subagent tree.

## Codex source

HarnessOrbit prefers the Codex app-server proxy metadata path when available. The app-server interface is documented by OpenAI here: <https://learn.chatgpt.com/docs/app-server>. HarnessOrbit requests metadata and opts out of streaming message/output deltas.

When the local app-server proxy is unavailable, current local behavior falls back to read-only SQLite metadata from the Codex home, including `state_5.sqlite` and `thread_history_1.sqlite` when present. This fallback can show coordinator/subagent relationships and observed turn states, but it is not guaranteed to be fully real-time or complete across all Codex versions and hosts.

Use `--coordinator` when you need to link an older or cross-directory Codex root thread that is not available through `CODEX_THREAD_ID` or `CODEX_SESSION_ID` in the current shell.

## Source coverage and limits

HarnessOrbit attempt details include the host/external executor, adaptive resource and selection reasons, observed phase durations, blocked time, and native-child completion evidence when available. The activity row stays compact; open its details for this evidence. Unknown legacy fields remain missing rather than becoming zero. Re-sanitizing collector snapshots at the HTTP boundary preserves these public counters without forwarding private child records.

Phase time includes orchestration and waiting; it is not model thinking time. `reported` child completion is weaker evidence than `verified` hook lifecycle events. A selected adaptive route means a resource was bound to an attempt, not that its candidate or project passed acceptance.

The monitor intentionally scopes itself to the current project by default. Use `--all` only when you explicitly want broader local metadata. Large source sets are bounded; snapshots are capped and may be marked `truncated`.

Known limits:

- `maxChildren` remains a result-reporting contract, not a hard native child cap.
- Native CLIs and providers can perform work that is not visible to HarnessOrbit.
- Native idle or finished state does not prove task correctness.
- Codex SQLite fallback is observed local metadata, not a live subscription.
- Claude unmanaged fallback is metadata-only and low confidence.
- Token metadata may be missing, partial, or limited to a scanned window; it is not a balance, bill, or exact per-task cost.
- Conversation view links only explicit relationships and leaves unknown ownership Unlinked.
- The UI does not replace `collect`, `verify`, `integrate`, `recover`, or native terminal inspection.
