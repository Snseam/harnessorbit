# Token usage reports

> 中文: [zh-CN/usage.md](zh-CN/usage.md)

HarnessOrbit can query local token records through the optional external [Tokscale](https://github.com/junhoyeo/tokscale) CLI. This is not a HarnessOrbit runtime dependency and does not install or configure any agent. Install Tokscale separately when you want usage reports:

```bash
npm install -g @tokscale/cli@4.16.0
node bin/harnessorbit.mjs usage --today
```

HarnessOrbit has been written against Tokscale 4.16.0 and accepts Tokscale `>=4.16.0 <5`. If the binary is not named `tokscale` or is not on `PATH`, pass it explicitly or set an environment variable:

```bash
node bin/harnessorbit.mjs usage --tokscale-bin /opt/tools/tokscale --today
CAO_TOKSCALE_BIN=/opt/tools/tokscale node bin/harnessorbit.mjs usage --today
```

Tokscale documents `models --json`, `--client`, date filters, and `--group-by` in its README, including `client,session,model` and `workspace,model` groupings. HarnessOrbit calls only Tokscale `models --json --no-spinner --home ...`; it does not call `submit`, `autosubmit`, `usage`, or any model. Tokscale may still refresh public pricing caches used for local cost calculation, but HarnessOrbit omits monetary amounts from its output.

## Command

```text
node bin/harnessorbit.mjs usage \
  [--agent claude,codex,pi,opencode] \
  [--model MODEL] \
  [--today | --since YYYY-MM-DD --until YYYY-MM-DD] \
  [--run RUN_ID [--task TASK_ID]] \
  [--home HOME] \
  [--tokscale-bin PATH] \
  [--table]
```

JSON is the default output. The CLI wraps the report as `{ "ok": true, "data": <report> }`; the report example below shows the `data` object. Use `--table` for a compact terminal view. `--table` and `--json` are mutually exclusive.

Supported agents are only the four HarnessOrbit adapters: `claude`, `codex`, `pi`, and `opencode`. Without `--agent`, HarnessOrbit queries all four. `--agent` accepts a comma-separated list.

Dates use inclusive local calendar days. `--today` selects the caller's current local day and cannot be combined with `--since` or `--until`. `--since` and `--until` accept `YYYY-MM-DD`; either side may be omitted.

`--model` is an exact filter on Tokscale's normalized returned model name. It is not a provider-side model selector, and it cannot recover the original model/provider decision from wrappers such as ccSwitch.

`--home` tells Tokscale where to read local agent records. HarnessOrbit always passes an explicit home directory to Tokscale, which keeps the query on the local report path and avoids Tokscale's no-home Cursor auto-sync path. The default is the current user's home directory; examples in this document use synthetic paths.

## Machine report

Without `--run`, HarnessOrbit reports local records for the selected agents across the selected date range:

```bash
node bin/harnessorbit.mjs usage --agent claude,codex --since 2026-01-01 --until 2026-01-31
```

The source grouping is Tokscale `client,provider,model`. Rows are machine-local usage records, not HarnessOrbit-only usage and not a provider invoice. A missing row never proves that actual usage was zero.

## Run and task reports

With `--run`, HarnessOrbit attempts to match Tokscale workspace records to HarnessOrbit task working directories:

```bash
node bin/harnessorbit.mjs usage --run demo --today
node bin/harnessorbit.mjs usage --run demo --task fix-add --table
```

Run/task reports cover dispatched worker workspaces, not exact task accounting. The coordinating Codex App conversation is not separately joined; its tokens can appear in machine reports but are not explicitly attributed to a HarnessOrbit run. The formal JSON field is always:

```json
{
  "attribution": {
    "level": "workspace",
    "exactTaskAttribution": false
  }
}
```

HarnessOrbit currently does not join native agent session ids. It matches recorded HarnessOrbit attempt `cwd` values to Tokscale `workspaceKey` values where that is safe. Retry attempts that reuse the same cwd/worktree are counted once per agent/workspace/model row rather than once per attempt.

Scoped rows set `provider` to `null` because workspace grouping does not preserve the provider dimension. All figures follow the local logs: a provider can omit usage, and zero-valued records are not proof of zero actual consumption.

Coverage rules are conservative:

- `worktree` tasks can be matched by workspace when the agent reports the same workspace key.
- `checkout` tasks share the project checkout. HarnessOrbit puts those observations in `sharedWorkspaces` and excludes them from attributed totals.
- Ambiguous workspace ownership is excluded.
- If a selected task has incomplete coverage, `totals` is `null`; `matchedTotals` is the partial local observed subtotal.
- Child agents or native subagents that write records under another worktree or workspace can be missing from the parent task's scoped report.

Claude attribution has an extra caveat: Claude Code stores records under an encoded project directory key. HarnessOrbit can match deterministic Claude project slugs for recorded cwd and realpath variants, but that is still workspace evidence, not session proof. A basename, display label, or local date window is never used as fuzzy attribution.

## JSON shape

A successful machine report has this shape:

```json
{
  "schemaVersion": 1,
  "source": {
    "name": "tokscale",
    "version": "4.16.0",
    "testedVersion": "4.16.0",
    "supportedRange": ">=4.16.0 <5",
    "dataHome": "/synthetic/home",
    "counterBasis": "local-client-records",
    "costIncluded": false
  },
  "filters": {
    "agents": ["claude", "codex", "pi", "opencode"],
    "model": null,
    "since": "2026-01-01",
    "until": "2026-01-31",
    "timezone": "UTC",
    "datePrecision": "local-calendar-day"
  },
  "scope": { "type": "machine", "runId": null, "taskId": null },
  "attribution": { "level": "machine", "exactTaskAttribution": false },
  "rows": [
    {
      "agent": "codex",
      "model": "gpt-example",
      "provider": "openai",
      "input": 100,
      "output": 20,
      "cacheRead": 50,
      "cacheWrite": 0,
      "reasoning": 5,
      "totalTokens": 175,
      "messages": 1
    }
  ],
  "totals": {
    "input": 100,
    "output": 20,
    "cacheRead": 50,
    "cacheWrite": 0,
    "reasoning": 5,
    "totalTokens": 175,
    "messages": 1
  },
  "sourceWarningCount": 0
}
```

A scoped run/task report may add `coverage`, `matchedTotals`, `sharedWorkspaces`, and `ambiguousWorkspaces`. When coverage is incomplete, `totals` is `null` and callers should treat `matchedTotals` as an observed subtotal only.

## Token buckets

HarnessOrbit exposes five Tokscale-normalized buckets:

- `input`
- `output`
- `cacheRead`
- `cacheWrite`
- `reasoning`

`totalTokens` is the sum of all five buckets. Tokscale 4.16.0's `TokenBreakdown::total()` uses that same five-bucket additive basis. Tokscale also contains parser-specific corrections before HarnessOrbit sees the rows: Codex subtracts `reasoning_output_tokens` from raw `output_tokens` before filling the separate `reasoning` bucket; Pi reads a reasoning field but leaves it inside output and reports `reasoning: 0` to avoid double counting. For Pi, `reasoning: 0` does not prove that the model did no reasoning.

`model` and `provider` are log labels parsed from local records. They are useful for grouping, but they are not authoritative billing proof and cannot reliably identify a hidden upstream provider selected by another wrapper.

## Source warnings and diagnostics

HarnessOrbit records a single `sourceWarningCount` from Tokscale `warnings` plus structured diagnostics with `warning` or `error` severity. Tokscale diagnostics are advisory source messages, such as Claude Desktop data being present but not scanned. They are not a parser drop count and they do not prove usage was missed. HarnessOrbit does not expose monetary cost fields.

## References

- Tokscale 4.16 README: `models --json`, date filters, `--client`, and group-by strategies: <https://github.com/junhoyeo/tokscale/blob/v4.16.0/README.md#group-by-strategies>
- Tokscale 4.16 source: additive `TokenBreakdown` bucket semantics and parser normalization live under `crates/tokscale-core/src`: <https://github.com/junhoyeo/tokscale/tree/v4.16.0/crates/tokscale-core/src>

## Integration test

`npm test` uses synthetic reports and needs no Tokscale installation. With the optional CLI installed, run `npm run test:tokscale` to parse synthetic Claude and Codex log files through the real executable, verify token normalization, and check run/task scoping without reading your real agent logs. `CAO_TOKSCALE_BIN` can select the executable.
