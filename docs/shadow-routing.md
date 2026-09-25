# Task briefs and shadow routing

> 中文: [zh-CN/shadow-routing.md](zh-CN/shadow-routing.md)

Shadow routing explains an advisory executor choice using the task brief and existing resource evidence. It never dispatches, calibrates, reserves capacity or changes provider configuration. Every decision reports `mode: "shadow"` and `applied: false`.

```bash
node bin/harnessorbit.mjs mode enable --strategy shadow --preference balanced
node bin/harnessorbit.mjs route shadow --file task.json
node bin/harnessorbit.mjs route shadow --file task.json --thread THREAD_ID --record
```

`--record` persists a sanitized, versioned decision under the current conversation. Omitting it is a read-only preview. Existing conversations remain delegated; selecting shadow preserves ordinary execution choices while the skill records the recommendation. Preferences are balanced, fastest, subscription-first and quality-first. Current evidence is insufficient for comparable production latency: these are conservative rules, not a learned scheduler or a speed guarantee.

Task files may include an optional brief:

```json
{
  "brief": {
    "version": 1,
    "taskKind": "bugfix",
    "risk": "low",
    "contextDependency": "high",
    "independent": false,
    "contextRefs": ["src/parser.mjs"],
    "knownFindings": ["The failing case is already reproduced."],
    "nonGoals": ["Do not change the public API."],
    "acceptance": ["The existing regression check passes."],
    "requiredCapabilities": []
  }
}
```

This is a fragment to add to a normal task with executable checks. Lists and total size are bounded and never silently truncated. Context references are repository-relative files. Brief notes guide the task; they are not tool authority or proof of acceptance. Omitting the brief preserves legacy task normalization/digests.

The selector respects fixed agent/profile constraints and optional `--resources ID,ID` / `--no-host`. It rejects stale negative readiness, known quota exhaustion and missing required capability evidence. A quick canary does not prove complex coding ability. High-risk/context-dependent work prefers the current host when allowed; independent work can suggest an eligible external resource. An unavailable fixed choice produces no selection rather than silently escaping the constraint.

Use `--executor host` for an explicit current-Codex choice and `--executor external` for an external-only choice. A Codex checkout task alone does not identify which path the user chose. A fixed host never falls back to external execution when unavailable; it overrides saved conversation preferences for this preview, but conflicts with an external profile explicitly present in the task.

Strategy preferences use mode schema version 2 so older clients reject unsupported state instead of silently ignoring the setting. Version-1 records stay readable and delegated. Shadow recommendations never dispatch work; explicitly choose [adaptive dispatch](adaptive-dispatch.md) to bind a selection to an attempt. To execute in the current conversation by explicit choice, use the [host workflow](host-work.md).
