---
name: herdr-dev
description: Coordinate authorized development through the local HarnessOrbit CLI and Herdr coding-agent sessions, with isolated worktrees, independent verification, repair attempts and integration. Use when the user chooses this collaboration method for a project.
---

# Herdr development coordination

For the installable **HarnessOrbit** skill and per-conversation activation, use [the HarnessOrbit entrypoint](../cao/SKILL.md) and the repository's `skill install` command. This legacy draft remains available to existing manual-workflow prompts.

Use the installed HarnessOrbit CLI, or this repository's `bin/harnessorbit.mjs`. Resolve its absolute path once; when the skill is read from this repository it is `../../bin/harnessorbit.mjs` relative to this folder. If the skill has been copied elsewhere, locate the existing HarnessOrbit checkout or executable instead of assuming the relative path still works. Read the CLI `--help` and the repository README for the current manifest schema. This is a repository skill draft; it does not install or register itself.

## Plan useful independent work

Keep product decisions, acceptance conditions, shared interfaces and cross-task sequencing in Codex. Give each external session an independently reviewable task, exact owned paths and executable acceptance checks. Worktree tasks may run in parallel; integrate predecessors before dispatching dependent worktrees. Checkout mode permits one writer across runs sharing the same state directory. Use one state directory for a project; put it outside the target Git worktree.

For an existing project, reproduce the issue and establish the baseline before dispatch. For a new application, establish a committed skeleton and one thin end-to-end path, then expand independent features. A candidate competition uses separate task IDs/worktrees and integrates only the selected candidate.

Select the user's configured agent; actual availability must be checked locally. Without an execution selector or HarnessOrbit default profile, `claude`, `pi`, `opencode`, and `codex` inherit their existing provider configuration. For profile selection, read [Execution profiles](../../docs/execution-profiles.md), inspect `profile list` and `source discover`, then run `route explain --file TASK.json` before dispatch. Use `agent: "auto"` when an execution selector or default profile may choose the agent; an explicit agent constrains the route. Preserve external managers' global current provider and authentication state. Import supported CC Switch references or use HarnessOrbit native profiles within the user's requested configuration scope; unsupported source records are not usable merely because discovery finds them.

Route scores and quota records are declared inputs with freshness rules, not measured model superiority or guaranteed subscription balance. Set shared `account.id` values for profiles using the same account; HarnessOrbit reserves attempt capacity, not every native child or API request. Explicit shared-proxy use needs `allowShared`; check source drift rather than silently refreshing a running attempt. Each attempt pins its configuration; changing a profile applies to a new attempt, and retry may select another agent. Send secret values only through stdin/private credential references, never prompt text or CLI arguments.

`nativeInstructions` can request the selected agent's available internal tools; set `maxChildren` to the intended number and avoid duplicating externally owned tasks inside the worker. Child reports remain part of the delivery contract. The monitor can also observe supported native lifecycle metadata, but it does not enforce native concurrency or replace independent acceptance. Do not promise native teams or large-scale concurrency from this MVP alone.

When the user asks to see agent activity, use `monitor start --project ABS_PATH --open` with the same state directory as the project's runs; report its local URL. See [monitoring](../../docs/monitor.md) for scope and source coverage. Keep the default project scope unless the user asks for `--all`. The CLI captures the calling Codex thread ID when available; use `--coordinator ID` only for a known, explicitly associated thread. Treat observed, stale and unknown states as such, especially when Codex live status is unavailable. The page is read-only, and `monitor stop` stops only the viewer process, never workers. Never expose prompts, terminal output or provider credentials to populate the page.

Use the page's Conversation view to focus on the monitor-associated Codex conversation and its linked agents. This association does not follow App window focus. Token cells show native usage when available; inspect their scope and completeness before interpreting them, and never equate session totals with exact task cost.

## Drive the actual CLI loop

1. `init --project ABS_PATH` creates a run and an owned named Herdr session. Save the run ID and use it for every command. `validate --file TASK.json` checks the definition; `dispatch --run RUN --file TASK.json` reserves and sends a task once.
2. `collect --run RUN --task TASK --wait-ms 30000` waits for evidence. `inspect --output` reads the worker. Never infer completion from `idle`, a final chat sentence, or a successful transport acknowledgment.
3. On `needs_input`, inspect the exact terminal output and error. Resolve only what existing authorization covers. Use `input --keys ...` or `input --text-file ...` for a concrete inspected interaction; do not press Enter blindly. `resume` reconciles the same attempt and never resends an acknowledged assignment. If the worker is idle without a result, ask it to write the current attempt's report; do not replay the implementation request.
4. On `submitted`, run `verify`. It stops the owned worker, checks the collected snapshot, runs the manifest's checks independently and creates a patch only on success. A stale nonce, changed snapshot, unexpected path or unfinished reported child blocks acceptance.
5. On `rework`, inspect independent evidence and use `retry` with a focused feedback file when useful. HarnessOrbit creates a new attempt and nonce, preserves partial work, and includes failed check output. Continue authorized repair attempts up to the task's `maxAttempts`; if the same blocker repeats, revise the diagnosis or task boundary instead of replaying the same instructions.
6. On `accepted`, review the candidate and call `integrate` when integration is within the user's requested development scope. It checks the target baseline and patch hash, applies without a commit, and reruns checks in the target project. A task is delivered only when the requested project-level acceptance passes, not merely when individual candidates pass.
7. After completion or cancellation, `cleanup --run RUN` stops the owned Herdr server and closes the run for new dispatches. Evidence and worktrees remain available. It does not delete project files or commit/push.

## Failure and recovery boundaries

- An uncertain transport outcome is not a retry instruction. Inspect or resume first; use a new attempt only after the old worker is stopped.
- Gateway failures after a request was sent can have an uncertain upstream outcome. Do not automatically replay such requests or force-stop an in-use gateway. `verify` and `cancel` release owned gateway/configuration resources after stopping the worker; inspect `runtimeCleanupError` if cleanup was incomplete.
- Integration failure/cancellation can leave an applied patch in the project. HarnessOrbit blocks new dispatches and integrations for that project across runs. Inspect and repair the retained checkout; `recover` rechecks the current checkout and does not apply the patch again. It preserves the hold if checks fail. `cleanup` only stops the Herdr server and closes that run for new dispatches; it does not clear this hold.
- Checkout tasks write the target checkout directly. If a checkout task fails, is interrupted, or is cancelled after making changes, HarnessOrbit holds the project and blocks new tasks/integrations. Continue with `retry` on the original task, or stop the worker and use `recover` to verify the current checkout. A checkout cancellation with no changes can release the hold.
- An interrupted verification is fail-closed in this MVP. `resume` does not replay its commands and `recover` does not automatically recover a crashed `verifying` attempt. Inspect retained process/evidence state before deciding on manual recovery; do not edit the ledger to fake acceptance.
- HarnessOrbit records terminal/process identity and rejects adoption when the pane, terminal, foreground process group, shell pid, or agent kind changes. Treat identity failures as requiring inspection, not force-close.
- Scopes, file locks and worktrees are coordination controls, not a filesystem sandbox. Git-ignored files and external side effects are outside the snapshot. Use checks whose behavior is suitable for the actual target repository.
- Preserve scope and persistent authorization. This skill does not add permission to change providers, install dependencies, publish, send messages or delete work. Do not ask again for ordinary development and verification already authorized by the user.

Report the implemented behavior, independent acceptance results, actual external sessions/repair attempts, unresolved limitations and retained evidence. Separate a controlled fault-injection test from a measurement of real project success rate or speed.
