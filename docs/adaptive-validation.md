# Adaptive dispatch: live validation

> 中文: [zh-CN/adaptive-validation.md](zh-CN/adaptive-validation.md)

On 2026-09-17, controlled macOS tests exercised adaptive dispatch through Herdr 0.9.0 with Claude Code 2.1.274 and Pi 0.85.1. These are integration checks, not a performance comparison against direct Codex.

| Configuration | Observed result |
| --- | --- |
| Pi, configured Kimi `k3` API provider | Read assignment, edit fixture, run tools, submit report, independently verify, integrate and clean up |
| Claude Code, configured `fable` alias through the existing proxy; isolated canary reported `grok-4.6` | Same complete workflow, with hook-backed completion evidence |
| Claude Code, one native Explore child | Real matching `SubagentStart` and `SubagentStop`, completed child id in the report, independent verification and integration |

Each successful scenario used a disposable committed Git fixture and a separate worktree. The target stayed unchanged until integration. Workers closed, runtime reservations released and owned Herdr servers stopped. Source Claude settings and Pi settings/models/auth file hashes matched before and after. Config and history directories were isolated; only the explicitly selected API authentication was reused, with no OAuth export. Pi user extensions and project customization discovery were disabled for this bounded check. This is not validation of every user's daily customized harness or a different provider.

The tests exposed and led to fixes for two real environment failures:

- A login shell inside Herdr replaced PATH, so the agent selected by preflight was not the one actually launched. Pi ran under Node 18 and Claude resolved to an older binary. Every owned pane now prepends the discovered executable directory before launch, including discoveries made through PATH.
- Reopening a state directory through macOS `/var` rather than `/private/var` made telemetry ownership checks fail. Existing state roots are now canonicalized before loading a run.

Independent review also reproduced a capacity leak when a Claude pane started but no assignment was sent. Cancellation now releases capacity once that worker is confirmed closed; it does not relax the gate for an assignment already sent or unknown children from submitted work. Offline regressions cover these cases. Failed setup attempts were retained as failures and their owned runtime was cleaned up, not counted as successful trials.

The browser check used actual successful run metadata, in English and Chinese, at desktop and narrow-screen sizes. It covered selected resources, phase timing, reported versus verified child evidence, known child counts and missing usage. HTTP re-sanitization now preserves child counts and timing coverage. No terminal or reasoning content is added to the dashboard.

## Remaining evidence and rollout

A follow-up on 2026-09-18 verified two additional isolated Pi/Kimi workflows: a cold adaptive dispatch performed one budgeted quick probe before delivering the task, and a normally delegated native task published `verified-task` readiness after independent acceptance. A subsequent read-only adaptive selection accepted that delivery evidence without a probe. The first Pi startup wrote changelog metadata to its isolated settings; that fingerprint change correctly prevented attributing its task to the earlier configuration. Reuse was validated with stable settings. OAuth evidence reuse is covered by offline credential-shape tests, not a live OAuth subscription test. All owned sessions and isolated credential copies were cleaned up; native user configurations and normal history were unchanged.

Adaptive remains opt-in. The live checks above do not establish cross-agent quality rankings, latency savings, full cancellation/fault coverage for every provider, Pi native subagent support, or project-wide completion-rate improvements. Pi child completion still uses the labelled report contract. Larger real tasks, controlled repair/cancellation scenarios and matched existing-repository/greenfield trials remain release work.

Use the [paired evaluator](benchmark-evaluation.md) to account for predeclared trials, including failures and missing results. It is an offline statistics tool, not an agent runner or evidence authenticator. Do not import these three smoke successes as the planned multi-task pilot or enable adaptive by default from them.

Rollback for new work is `node bin/harnessorbit.mjs mode enable --strategy delegated --calibration-policy off` in the relevant conversation. Running attempts keep their original route binding; changing the strategy does not stop or replace them. Continue their normal verification or explicit cancellation/cleanup.
