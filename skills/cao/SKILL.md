---
name: cao
description: Enable HarnessOrbit as the default development workflow for this conversation when the user invokes HarnessOrbit, /HarnessOrbit, or $cao, asks to activate HarnessOrbit, or continues work in a conversation that already enabled it. Coordinate external coding agents through Herdr and independently verify their results.
---

# HarnessOrbit

Treat activation as the user's continuing preference for **this conversation**. Keep Codex responsible for requirements, task boundaries, acceptance, and integration; use HarnessOrbit to delegate development work to the user's configured coding agents. Ordinary questions and planning requests do not start workers.

## Locate the installation and conversation

Resolve this skill's directory from the loaded `SKILL.md`. Run `node "<skill-directory>/scripts/cao.mjs" --paths` to locate the HarnessOrbit checkout and guides. That wrapper works from any project directory and resolves installed symlinks. Use the wrapper for subsequent HarnessOrbit commands; keep the working directory at the user's target project.

Use `CODEX_THREAD_ID`, then `CODEX_SESSION_ID`, as the conversation identity when available. Pass `--thread ID` explicitly if the runtime provides the current conversation ID another way. If no native ID is available, generate one UUID for this conversation and retain it in handoff notes for subsequent commands. Never use a project path, another conversation's ID, or a fresh UUID on every turn as the identity.

Use one HarnessOrbit state directory outside the target project. Honor a state directory already associated with this conversation; otherwise use the CLI default. Pass `--state-dir PATH` consistently when using a custom location.

## Activate, inspect, or turn off

- For a bare HarnessOrbit invocation, `/HarnessOrbit`, `$cao`, or an explicit request to enable the workflow, run `mode enable`. Preserve existing project, agent/profile, concurrency, and retry preferences unless the user changes them. An initial activation defaults to two external sessions and three attempts per task.
- For a status request, run `mode status`; do not turn the mode on just to inspect it.
- For `HarnessOrbit off` or a request to stop using this default, run `mode disable` for this conversation. Start no new HarnessOrbit work. Inspect any already-owned run and handle it according to the user's request, retaining changes and evidence; changing a preference does not cancel workers.
- A request to work directly for one task is a one-task override. Keep the saved default for later requests.

After enabling, check CLI `--help`, `doctor`, the target project when known, and `profile list`. Prefer the user's selected agent/profile; otherwise use a compatible configured default or their configured Claude Code. Do not change model providers, credentials, or global agent settings to activate a preference. If a dependency or authentication is missing, state the actual blocker. Distinguish “preference enabled” from “runtime ready”.

If the user supplied no development task, report the mode, resolved project/CLI/state paths, selected agent or profile, and any blocker, then wait. Do not dispatch a demonstration task, create a Git commit, or install extra dependencies simply to prove activation.

## Continue the conversation

On subsequent development requests, read `mode status` with the same conversation identity and state directory before choosing the execution path. Respect the user's latest settings and one-task overrides. If HarnessOrbit is enabled, read [the coordination workflow](references/workflow.md) and carry the requested implementation through independent verification and project integration. If HarnessOrbit cannot execute a requested task, explain the specific obstacle instead of silently falling back to direct implementation.

When the user requests shadow routing, enable `--strategy shadow` with their chosen `--preference`. This records advisory choices while preserving the existing execution selection. A shadow recommendation has `applied: false`; it does not authorize changing the executor. For an explicitly requested current-Codex task, use the host path in the coordination guide to register work and run independent checks without starting an external session. Existing conversations remain `delegated` unless changed.

When explicitly asked for active adaptive routing, enable `--strategy adaptive`. Dispatch then chooses and binds an eligible resource using the declared constraints and existing evidence. The default calibration policy is `off`. Enable `--calibration-policy on-demand` only when the user explicitly wants bounded development-time readiness probes; once enabled for the conversation, normal adaptive dispatch may probe without asking again. `mode enable` stores the preference and must not call a model. Unfinished or unknown native children block acceptance; retries keep that bound configuration. Read the adaptive section of the coordination guide; enabling adaptive routing or on-demand calibration never authorizes installations, native settings rewrites, or OAuth credential copying.

Before an interruption or compaction, retain these details in conversation handoff notes: HarnessOrbit mode, conversation ID, CLI wrapper path, state directory, target project, agent/profile and limits, and any active run/task IDs. On recovery, inspect the saved mode and existing run before dispatching work. The state file supports recovery; it is not a scheduler or a mechanism that changes Codex's global settings.

Installation makes this skill discoverable in other conversations. Each conversation activates its own preference. Merely mentioning HarnessOrbit in unrelated discussion, loading a disabled mode for inspection, or installing the skill does not authorize enabling other conversations.

In the desktop app, select **HarnessOrbit** from the `/HarnessOrbit` suggestions and send the inserted skill mention. In Codex CLI use `$cao` or `/skills`. If a client rejects an unselected bare `/HarnessOrbit`, explain the supported invocation for that client instead of claiming the shortcut worked. The shortcut inserts skill instructions; continuing mode is this conversation's preference, not an App-wide setting.
