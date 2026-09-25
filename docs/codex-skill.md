# HarnessOrbit skill for Codex

> 中文: [zh-CN/codex-skill.md](zh-CN/codex-skill.md)

Use the [copyable installation request](../README.md#start-in-codex) to let Codex install HarnessOrbit. Then activate **HarnessOrbit** in each new or existing local conversation where you want this development workflow.

The paste stats four exact paths (handoff wrapper, `$CODEX_HOME/skills/cao` when set, `~/.codex/skills/cao`, `~/.agents/skills/cao`) and does not list parent directories or walk `~/.codex/sessions`. After activation, locate HarnessOrbit from the loaded skill directory plus `--paths`; do not treat those install paths as SKILL locate targets.

## Install once

```bash
node /path/to/harnessorbit/bin/harnessorbit.mjs skill install
node /path/to/harnessorbit/bin/harnessorbit.mjs skill status
```

The default destination is `$CODEX_HOME/skills/cao`, or `~/.codex/skills/cao` when `CODEX_HOME` is unset. The current Codex runtime recognizes this user location. Hosts using the newer shared user location can choose it explicitly:

```bash
node /path/to/harnessorbit/bin/harnessorbit.mjs skill install --skills-dir ~/.agents/skills
```

Use one location, not duplicate installations with the same skill name. Codex supports linked skill folders. The installer creates a link to the checkout's `skills/cao`, so the checkout must remain available. Repeat installation is idempotent for that exact source. A different link or existing real directory/file is preserved and reported as a conflict. Missing or incomplete source bundles are errors.

The wrapper in the skill resolves the physical checkout, including when the install path contains spaces or Unicode. It preserves the target project's working directory. No global `cao` executable, provider edit, `AGENTS.md` edit, or package dependency is needed for skill registration.

## Invoke in a new or existing conversation

- **Codex App:** type `/HarnessOrbit`, choose the **HarnessOrbit** suggestion, then send the inserted skill mention. The current desktop app matches the display name without case sensitivity.
- **Codex CLI:** use `$cao`, or choose HarnessOrbit through `/skills`.
- **Other clients:** use their native skill picker. An unselected bare `/HarnessOrbit` is not a portable command across every Codex surface.

The installed skill is named `cao` and displayed as `HarnessOrbit`. If an already-open conversation has a cached catalog, refresh its skills (the current desktop app provides **Force reload skills**), reopen the conversation, or restart the client if needed. Creating a new conversation is not inherently required. Official [skill guidance](https://learn.chatgpt.com/docs/build-skills) describes discovery, symlink support, `$` invocation, and refresh behavior; [CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli) document `/skills`.

An invocation with no task enables the preference and checks readiness. It does not launch a worker or create an initial Git commit. Installing the skill only makes it available; it does not activate any conversation.

## What “default” means

The skill tells Codex to keep using HarnessOrbit for subsequent development requests in the same conversation, until you turn it off or request a one-task exception. Codex retains the mode, CLI/state/project paths, and active run/task IDs in handoff notes and checks the saved mode when continuing work. Questions and planning remain direct responses.

Preferences are stored under the HarnessOrbit state directory at `conversations/<thread-id>/mode.json`. Native identity is taken from an explicit `--thread`, then `CODEX_THREAD_ID`, then `CODEX_SESSION_ID`. If native identity is unavailable, the skill can retain a generated conversation UUID in its handoff notes and pass it explicitly. A project path is never substituted for a conversation ID.

Two conversations in one project can have different preferences. Re-enabling preserves saved choices unless new options are supplied. The initial limits are two external sessions and three attempts per task. Agent/profile/project can remain unset until the actual task supplies enough context.

This is an instruction-based workflow with a durable preference record, not a modification of Codex's application-wide defaults, a hook that enforces every model decision, or a background scheduler. If context is lost entirely, invoke HarnessOrbit again and supply the original state directory and run ID when resuming active work.

## Inspect and change the preference directly

```bash
node bin/harnessorbit.mjs mode enable --thread THREAD_ID --project /path/to/project
node bin/harnessorbit.mjs mode enable --thread THREAD_ID --agent claude --max-parallel 4 --max-attempts 3
node bin/harnessorbit.mjs mode status --thread THREAD_ID
node bin/harnessorbit.mjs mode disable --thread THREAD_ID
```

`--profile ID` selects a saved execution preference; `--profile ""` clears it. `--state-dir PATH` selects an existing shared HarnessOrbit state directory outside the target project. Mode commands only change preferences: they do not dispatch tasks, cancel workers, or alter a profile/provider. Resolve already-active work according to the user's request when disabling the default.

## Update or uninstall

Update a clean checkout through its normal Git workflow; the linked skill follows the source. Reload the client catalog if metadata changed. If the checkout moved, `skill status` reports the broken/unusable installation; resolve that old link before installing the new checkout. The installer does not overwrite foreign links or local skill customizations.

```bash
node /path/to/harnessorbit/bin/harnessorbit.mjs skill uninstall
```

Pass the same `--skills-dir` used at installation. Uninstall removes only the link to this checkout, leaving the source, mode records, runs, and other skills intact. It does not turn off a preference already loaded in a conversation; ask Codex to stop using HarnessOrbit there, or use `mode disable` for that identity.
