# Opt-in adaptive dispatch

> 中文: [zh-CN/adaptive-dispatch.md](zh-CN/adaptive-dispatch.md)

Adaptive dispatch binds an eligible resource to an actual task attempt. It is opt-in; existing delegated and shadow conversations retain their behavior.

```bash
node bin/harnessorbit.mjs dispatch --adaptive --run RUN_ID --file task.json
node bin/harnessorbit.mjs dispatch --adaptive --run RUN_ID --file task.json --executor external --resources RESOURCE_ID
node bin/harnessorbit.mjs dispatch --adaptive --run RUN_ID --file task.json --calibration-policy on-demand --probe-budget-ms 30000
# Or explicitly enable it for the current conversation:
node bin/harnessorbit.mjs mode enable --strategy adaptive --preference balanced
node bin/harnessorbit.mjs mode enable --strategy adaptive --calibration-policy on-demand --probe-budget-ms 30000
```

By default, dispatch does not run model probes. Use `resources list` and explicit `calibrate` first when you want known readiness before a task. If the user explicitly enables `--calibration-policy on-demand`, HarnessOrbit may run bounded quick probes during a real adaptive dispatch when no eligible host or external executor is selected and missing or stale call verification is the blocker. `mode enable` only stores the preference; it does not call a model. On-demand probing never installs agents, rewrites native settings, or copies OAuth-only credentials into the isolated probe. Missing/expired evidence can still prevent an external selection, especially when the first real subscription/OAuth task has not succeeded yet. Omit task `agent` or use `auto` for free selection; a concrete agent, fixed profile, profile pool, resource allowlist or explicit executor constrains the choice. Explicit worktree isolation prevents current-host execution. Without an explicit isolation, a host choice uses checkout while an external choice keeps the default worktree.

The preparation budget defaults to 30 seconds and cannot exceed 60 seconds. It covers preparation/preflight and at most two sequential quick probes, stops as soon as a resource becomes eligible, and is shortened by the task deadline. Process cleanup can take additional time; the budget does not cover the subsequent coding task. A ready host is never held up to benchmark other agents. Use `--executor external` when the task specifically needs external execution. Unsupported authentication, capabilities, exhausted quota, and caller restrictions are not bypassed. A disabled conversation's saved probe policy is not inherited by a one-off `--adaptive` dispatch unless explicitly requested again.

Saved preparation preferences use mode schema 3; older mode records remain off by default. To switch an on-demand conversation back to delegated execution, pass `mode enable --strategy delegated --calibration-policy off`. See [resource evidence](resources.md) for the verified-task path and its attribution limits.

If host is selected, dispatch returns a registered host task; the current conversation must implement, `host report`, and independently `host verify` it. Dispatch never makes the current App execute edits by itself. External selections launch through Herdr and keep the usual collect/verify/integrate workflow.

Every adaptive attempt records the original request digest, selected resource fingerprint and decision. Repeating the same request returns its existing attempt. A changed request under the same task id is rejected. Configuration drift before launch fails explicitly. Retries retain the same effective task/resource binding; they do not silently switch providers. Managed profile fallback chains are disabled for this pinned attempt, so an unselected fallback cannot run. Use a new scoped task after diagnosing a needed route change.

Native selections use `execution: {"native": true}` and explicit model/provider arguments, so the global HarnessOrbit default profile cannot replace them. This does not rewrite native settings. Native resource metadata is observed configuration, not a complete freeze of project plugins or opaque proxy internals. Known capacity groups are reserved; unknown account relationships remain conservative. Native children are not a hard provider request limit.

Preferences currently use conservative rules. Matching same-run history requires the exact resource fingerprint and task kind, at least three terminal samples, and retains failures in the denominator. Both fastest and quality-first prefer higher observed completion fractions. Quality-first then prefers more integrated outcomes before elapsed time; fastest then prefers lower elapsed time. Subscription-first does not reorder from this history. These small samples and isolated calibration do not establish universal performance or statistical quality guarantees. No automatic install occurs.

## Native child evidence

Set `maxChildren` and `nativeInstructions` only for an installation whose native tools support the requested work. HarnessOrbit does not force creation of subagents. Claude private hook records now participate in acceptance: an observed unfinished or omitted child blocks collection/verification, and parent Stop does not substitute for SubagentStop. Missing or damaged telemetry remains unknown for adaptive Claude tasks that permit children. Other harnesses retain explicitly labelled report-contract evidence.

If child completion cannot be established, HarnessOrbit retains capacity and reports the blocker. It does not kill unowned descendants or fabricate a completed status. Existing legacy tasks retain their report-contract fallback when telemetry is unavailable; observed unfinished children still block them.

Monitor snapshots expose bounded route and child-evidence metadata. Full project acceptance remains separate from candidate acceptance. This implementation is an opt-in dispatch mechanism; a full real multi-agent throughput experiment and the S6 default rollout are still pending.
