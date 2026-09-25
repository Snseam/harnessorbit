# Discover agents and calibrate local configurations

> 中文: [zh-CN/resources.md](zh-CN/resources.md)

Resource discovery identifies native Claude Code, Codex, Pi and OpenCode installations plus existing HarnessOrbit profiles. It reads selected public configuration fields and reports authentication evidence separately from successful model calls. It does not install tools, change native defaults, import profiles automatically or refresh OAuth tokens.

```bash
node bin/harnessorbit.mjs resources list
node bin/harnessorbit.mjs resources check --agent claude,pi
```

`list` reads configuration and reuses compatible version observations. `check` additionally runs bounded native version/login-status commands and saves sanitized inventory in the HarnessOrbit state directory. Each command has a two-second timeout within a five-second process-probe budget. Unknown or unsupported metadata stays unknown.

Discovery checks PATH first, then known installation locations and a bounded list of NVM Node versions. It returns the executable path and discovery source. Herdr's owned pane restores the discovered executable directory before launch, including PATH discoveries, so a login shell cannot silently select an older installation; shell startup files are not rewritten.

## What a resource means

- `installed`: an executable was found. This does not mean authentication works.
- `configured`: selected configuration or credential evidence exists. It is not a successful request.
- `authentication`: evidence from a recognized native status or credential shape; no raw credentials or email are included.
- `callVerification`: fresh calibration or independently verified task-delivery evidence for the exact resource/configuration fingerprint, or `unknown`/`stale`/`unavailable`. Inspect `source` to distinguish them.
- `requestedModel` versus `observedModel`: an alias or proxy mapping is not assumed to be the actual served model.
- `quota`: declared profile quota hints with freshness. Native package balances that cannot be queried remain unknown.
- `quotaGroup`: known account identity or a conservative grouping. Matching endpoints alone do not prove two configurations use the same account.

Pi's selected built-in provider and providers synced into `models.json` are separate candidates. Two providers with the same model name can use different credentials and endpoints. Discovery preserves that distinction. JSON reads are bounded; unsupported Codex TOML structures, custom commands and extension capabilities are not guessed.

## Read existing CC Switch Pi configurations

```bash
node bin/harnessorbit.mjs source discover
node bin/harnessorbit.mjs profile import-cc-switch --provider PROVIDER_ID --app pi --id my-pi --model MODEL_ID
```

Use identifiers returned by discovery. Schema-18 Pi provider records with a known API protocol, explicit model catalog and literal API key can be imported by reference. Keys remain in CC Switch; source drift is checked at execution. Shell-backed/interpolated keys and OAuth records are not converted into direct credentials.

Pi model limits are imported when present. A managed profile can explicitly declare `modelMetadata: {"contextWindow": 1000000, "maxOutputTokens": 128000}`. Otherwise the existing compatibility values remain labelled as such in the execution manifest. Pi's required numeric price placeholders never establish a free model or actual billing price.

## Explicit isolated calibration

An external native task can establish readiness without an isolated model probe. HarnessOrbit records the configuration fingerprint before launch and only publishes `source: verified-task` after an acknowledged assignment, confirmed worker/child completion, and independent checks against the collected snapshot. The current configuration must still match. This demonstrates functional delivery through that configuration, not a separately observed provider request or served-model identity.

Task evidence expires 15 minutes after verification; rereading it does not refresh its age. A newer negative calibration supersedes older successful delivery evidence. Host work, mock runtimes, unverified reports, failed checks, and unknown child completion do not establish readiness. Legacy native tasks with custom CLI arguments or known project configuration/context markers, and legacy managed profiles with possible gateway fallbacks, are conservatively excluded because their actual configuration is not pinned. Project marker checks only inspect known paths in the project and attempt checkout; they do not scan homes or read credentials. Adaptive attempts already carry a pinned selection.

This gives native OAuth sessions a path into subsequent adaptive choices without copying credentials: first complete a normally delegated, independently checked native task using the configured default and no CLI overrides. HarnessOrbit observes its result; it does not export or convert the login. A cold OAuth resource without this evidence still cannot be actively probed by the API-only isolated adapter.

Choose the exact resource id from `resources list`:

```bash
node bin/harnessorbit.mjs calibrate --resource RESOURCE_ID --quick
node bin/harnessorbit.mjs calibrate --resource RESOURCE_ID --suite code --timeout-ms 60000 --budget-ms 90000
node bin/harnessorbit.mjs calibration list --resource RESOURCE_ID
```

Calibration makes real provider calls on cache misses. There is no automatic test on mode activation. Select at most two resources per invocation. Quick probes cap each resource at 30 seconds and the total budget at 60 seconds; code probes have separately bounded, configurable limits. Runs are serialized locally and known profile capacity is shared with normal HarnessOrbit attempts.

Current probe adapters support Claude and Pi with explicit API authentication or supported HarnessOrbit profiles. They do not copy OAuth credentials. An unsupported isolated authentication path is `unavailable`; it does not mean the normal native session cannot run.

Probes use fresh temporary configuration/session roots and disable session persistence, user extensions, skills and project context discovery. The quick suite checks an unpredictable exact response with tools disabled. The code suite fixes a small file and runs an independent checker with no provider credentials in its environment. Temporary configurations, transcripts and fixture files are removed after the owned process stops. Native file tools and checks remain executable code on the local machine; this is configuration/workspace isolation, not a general OS sandbox.

These are **isolated print-mode probes**, not benchmarks of the user's full interactive Herdr workflow. Disabling customizations changes the harness. No overall coding-quality or speedup claim follows from one probe.

## Metrics, cache and failures

Records contain sanitized metadata, checks, status and nullable metrics; prompts, answers and keys are not persisted. `observedAt`/`expiresAt` in calibration records are Unix milliseconds.

- `firstEventMs` measures the first observed text delta since probe start, including setup latency. It is not pure model thinking time.
- `outputTokens` is native-reported output usage, which can include reasoning according to the provider. Missing usage is null.
- `tokensPerSecond` for quick probes is reported output tokens divided by total probe wall time. It is an end-to-end throughput measure, not text decoding speed. The code suite leaves this rate null.
- A completed response with a wrong answer fails its checker. Authentication, quota/rate-limit and transport failures are unavailable evidence, not a model-quality score.

Cache identity includes resource/configuration fingerprint, suite version, platform/runtime and isolated probe configuration. Quick results last up to 15 minutes; code results up to seven days; unavailable/timeout evidence has a short cooldown. `--refresh` explicitly repeats calls. Mock evidence is never accepted as fresh real evidence. Version/configuration changes invalidate matching results.

If a calibration controller is killed before cleanup, its capacity claim is retained rather than assuming its child stopped. Inspect `route reservations`, confirm the relevant process has stopped, then release only that calibration claim:

```bash
node bin/harnessorbit.mjs calibration release --reservation RESERVATION_ID --confirm-stopped
```

This command cannot release a regular task reservation. Normal interruption/timeout waits for child termination and releases capacity automatically.

Resource/calibration commands are usable now. [Task briefs and shadow routing](shadow-routing.md) consume this evidence for advisory choices; [host work](host-work.md) supports an explicitly selected current-Codex path. [Adaptive dispatch](adaptive-dispatch.md) can bind a choice to an attempt when explicitly enabled. Default-workflow rollout still requires real paired evaluation; existing conversations remain delegated unless explicitly changed.
