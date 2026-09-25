# Execution profiles and routing

> 中文: [zh-CN/execution-profiles.md](zh-CN/execution-profiles.md)

Execution profiles let HarnessOrbit run a task through a selected native agent and model without rewriting your global provider configuration. A profile describes one agent, protocol, endpoint, model, credential reference, routing metadata, and capacity hints. When a profiled task starts, HarnessOrbit creates a local relay gateway, writes private per-attempt runtime configuration, launches the native CLI through Herdr, and cleans up the HarnessOrbit-owned files after the worker stops.

Legacy tasks still work. If a task has no `execution` selector and no default profile, HarnessOrbit launches the requested `agent` with its inherited native configuration, as in the original workflow. If a default profile exists, HarnessOrbit applies it to legacy tasks only when it is compatible with the task agent. Use `agent: "auto"` only with an explicit `execution` selector or with a default profile.

## Requirements

Profiled execution uses the same base requirements as HarnessOrbit plus the native CLI you want to drive:

- Node.js 22.13 or newer.
- Herdr on `PATH`.
- One configured native agent CLI: Claude Code, Codex CLI, Pi, or OpenCode.
- A state directory shared by commands that should see the same profiles, reservations, gateways, and runs.

HarnessOrbit does not install native CLIs or providers. It starts them with generated local configuration that points at HarnessOrbit's relay gateway.

## Profile schema

A stored profile is JSON. `profile put` adds HarnessOrbit metadata such as revision and timestamps; `profile export` removes those controlled metadata fields so the output can be imported again.

```json
{
  "id": "claude-sonnet-api",
  "name": "Claude Sonnet via API",
  "agent": "claude",
  "model": "claude-sonnet-4-5",
  "protocol": "anthropic",
  "endpoint": "https://api.anthropic.com/v1",
  "credential": { "type": "stored", "ref": "stored:anthropic-main", "authScheme": "api-key" },
  "source": { "type": "native" },
  "enabled": true,
  "capabilities": ["shell"],
  "priority": 0,
  "account": { "id": "anthropic-main", "maxParallel": 1 },
  "quota": { "state": "unknown", "observedAt": null, "expiresAt": null, "remainingTokens": null },
  "quality": 80,
  "speed": 60,
  "costPerMillion": null,
  "modelMap": {},
  "fallbacks": []
}
```

Important fields:

| Field | Meaning |
| --- | --- |
| `agent` | Native CLI to launch: `claude`, `codex`, `pi`, or `opencode`. |
| `protocol` | Relay wire protocol: `anthropic`, `openai-responses`, or `openai-chat`. The profile must be compatible with the selected agent. |
| `endpoint` | Upstream base URL. It must be `http` or `https` and cannot contain userinfo, query, or fragment. `credential.type: "none"` is accepted only for loopback endpoints. |
| `credential` | A reference to a secret, never the secret value. Types are `env`, `stored`, `cc-switch`, and `none`. For Anthropic upstreams, `authScheme: "bearer"` sends `Authorization: Bearer`; omitted or `api-key` sends `x-api-key`. |
| `source` | Where the profile came from. `native` is user-authored. `cc-switch` stores the source directory, provider id, app, route, and fingerprint used for drift checks. |
| `capabilities` | Manual labels used by `requireCapabilities`; HarnessOrbit does not infer these from the provider. |
| `quality`, `speed`, `costPerMillion` | Manual routing scores. `quality` and `speed` rank higher values first. `cost` requires a known nonnegative value and ranks lower cost first. |
| `quota` | A manual or observed hint with expiry. It is not a live platform balance unless you update it from such a source. Stale quota data is reported but does not block by itself. |
| `account.maxParallel` | HarnessOrbit attempt reservation limit for profiles sharing the same `account.id`, or for the same endpoint host when no account id is set. It does not limit native child agents or API requests inside one attempt. |
| `modelMap` | Gateway request model rewrite map. If the request body asks for a key in the map, HarnessOrbit forwards the mapped upstream model; otherwise it forwards `profile.model`. |
| `fallbacks` | Up to eight profile ids used by a gateway after the primary profile. Fallback profiles must use the same protocol and pass eligibility checks. |

Stored profile records are validated on every read. HarnessOrbit rejects unknown secret-like fields, invalid revisions, non-normalized JSON, unsafe env names, symlinked stored secret files, and header-unsafe secret values.

## Managing profiles

All commands accept `--state-dir PATH` when you want a non-default profile store.

```bash
node bin/harnessorbit.mjs profile put --file profile.json --default
node bin/harnessorbit.mjs profile list
node bin/harnessorbit.mjs profile show --id claude-sonnet-api
node bin/harnessorbit.mjs profile default
node bin/harnessorbit.mjs profile default --id claude-sonnet-api
node bin/harnessorbit.mjs profile default --clear
node bin/harnessorbit.mjs profile clone --id claude-sonnet-api --new-id claude-copy
node bin/harnessorbit.mjs profile export --id claude-sonnet-api --file exported-profile.json
node bin/harnessorbit.mjs profile remove --id claude-copy
```

`profile put --default` writes the profile and makes it the default. `profile export --file` uses exclusive create, so it will not overwrite an existing file.

## Secrets

Never put secret values in profile JSON or command arguments. Store a local secret from stdin:

```bash
printf '%s\n' "$ANTHROPIC_API_KEY" | node bin/harnessorbit.mjs secret set --id anthropic-main --stdin
node bin/harnessorbit.mjs secret remove --id anthropic-main
```

The command trims one final newline, stores a private file under the HarnessOrbit state directory, and returns a reference such as `stored:anthropic-main`. Secret values are rejected if they are empty, contain control characters, or exceed 64 KiB. HarnessOrbit also supports environment references:

```json
{ "type": "env", "name": "ANTHROPIC_API_KEY" }
```

Environment names must be valid shell-style variable names. CC Switch imports use `credential.type: "cc-switch"` with a private database field reference; the profile does not contain the key.

## Discovering and importing CC Switch profiles

HarnessOrbit can read a CC Switch database without changing it:

```bash
node bin/harnessorbit.mjs source discover
node bin/harnessorbit.mjs source discover --directory ~/.cc-switch
```

The first implementation supports the real CC Switch 3.20.x schema with `PRAGMA user_version = 18`. It reads `providers` and `proxy_config` in read-only mode.

Supported imports in this version:

- Claude direct API records whose `settings_config.env` contains `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`.
- Pi provider records with `baseUrl`, a supported `api`, a `models` catalog and a literal `apiKey`. Select a model with `--model`; available context/output limits become `modelMetadata`.
- `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `DEFAULT_SONNET_MODEL`, and Anthropic default model fields when present.
- Explicit reuse of the current active Claude proxy only when you pass `--allow-shared`.

Unsupported in this version:

- OAuth-only CC Switch records as direct profiles.
- Codex, OpenCode, or other unsupported CC Switch client records as direct profiles; Pi command/interpolation-backed keys are also unsupported.
- Automatic CC Switch switching or writes to the CC Switch database.

Import examples:

```bash
node bin/harnessorbit.mjs profile import-cc-switch \
  --provider claude-main \
  --app claude \
  --id claude-main

node bin/harnessorbit.mjs profile import-cc-switch \
  --directory ~/.cc-switch \
  --provider claude-current \
  --app claude \
  --id claude-shared-proxy \
  --allow-shared
```

`ANTHROPIC_AUTH_TOKEN` imports as `authScheme: "bearer"`; `ANTHROPIC_API_KEY` imports as `authScheme: "api-key"`. `profile refresh --id ID` re-imports an existing CC Switch profile and checks the source fingerprint. Source fingerprints intentionally exclude secret values; public config drift is detected, but rotating the secret value alone does not change the fingerprint.

## Selecting profiles for tasks

A task may use a fixed profile:

```json
{
  "id": "typed-change",
  "objective": "Update the type definitions and tests.",
  "agent": "auto",
  "execution": { "profile": "codex-fast" },
  "allowedPaths": ["src/types/", "tests/types.test.mjs"],
  "checks": [{ "name": "types", "argv": ["npm", "test", "--", "tests/types.test.mjs"] }]
}
```

A task may also ask HarnessOrbit to choose among candidate profiles:

```json
{
  "id": "docs-pass",
  "objective": "Improve the docs for profile routing.",
  "agent": "auto",
  "execution": {
    "policy": "quality",
    "profiles": ["claude-main", "codex-fast", "opencode-local"],
    "requireCapabilities": ["shell"]
  },
  "allowedPaths": ["README.md", "docs/"],
  "checks": [{ "name": "syntax", "argv": ["npm", "run", "check"] }]
}
```

Selector fields:

| Field | Meaning |
| --- | --- |
| `profile` | Fixed profile id. Cannot be combined with `policy` or `profiles`. |
| `policy` | Automatic policy: `available`, `quality`, `speed`, or `cost`. Defaults to `available`. |
| `profiles` | Candidate profile ids for automatic routing. |
| `requireCapabilities` | Required manual capability labels. |
| `allowShared` | Required for profiles using a shared source such as an active CC Switch proxy. |

If `agent` is a concrete value, routing only accepts profiles with the same agent. If `agent` is `auto`, HarnessOrbit can choose any compatible candidate. A default profile is applied to old-style tasks without changing the task definition; because the old task still has a concrete agent, the default must match that agent unless the task uses `agent: "auto"`.

Use route explain before dispatching:

```bash
node bin/harnessorbit.mjs route explain --file work/task.json
node bin/harnessorbit.mjs route reservations
```

The route decision reports candidates, scores, reasons, and the selected profile id. `route reservations` lists active HarnessOrbit attempt reservations separately; availability may change between explanation and dispatch. Reasons such as `quota_exhausted`, `credential_unavailable`, `agent_mismatch`, `protocol_incompatible`, and `shared_source_requires_allowShared` describe routing eligibility only.

## Gateway lifecycle

A profiled task starts a local HarnessOrbit gateway automatically. You can also manage one manually:

```bash
node bin/harnessorbit.mjs gateway start --profile claude-main --id manual-claude
node bin/harnessorbit.mjs gateway status --id manual-claude
node bin/harnessorbit.mjs gateway list
node bin/harnessorbit.mjs gateway stop --id manual-claude
```

The gateway is a same-protocol relay. It supports Anthropic Messages paths, OpenAI Responses paths, and OpenAI Chat Completions paths. It forwards to profiles that share the same protocol and rewrites the request model according to `modelMap` or `profile.model`. It does not perform OAuth, convert Anthropic to OpenAI or OpenAI to Anthropic, or hide protocol incompatibility. For external gateways, use a compatible endpoint and protocol in the profile; HarnessOrbit still treats it as an upstream relay target.

Fallback is conservative. HarnessOrbit may try another profile after a clear pre-send network failure or an upstream 429/5xx response. If bytes may already have reached an upstream and the connection then breaks, HarnessOrbit treats the result as uncertain rather than assuming it is safe to retry against another provider.

Gateway start refuses disabled profiles, fresh exhausted quotas, incompatible fallback protocols, remote `credential.type: "none"`, shared sources without `allowShared`, and missing required capabilities. `gateway stop` refuses to stop a gateway still referenced by active attempts.

## Native runtime configuration

HarnessOrbit writes per-attempt private files and passes native CLI options that point each agent at the local gateway:

| Agent | Configuration mode |
| --- | --- |
| Claude Code | Writes `claude-settings.json`, sets Anthropic env keys, passes `--settings`, `--model`, and `--session-id`. |
| Codex CLI | Uses command-backed auth for the gateway token and `-c` overrides for `model`, `model_provider`, and `model_providers.<name>`. This is designed for Codex CLI 0.154-style command auth while leaving global config alone. |
| Pi | Writes a provider extension and starts Pi with `--extension`, `--provider`, `--model`, and `--session-id`. |
| OpenCode | Sets `OPENCODE_CONFIG_CONTENT` with inline provider config and passes `--model`. |

Profiled tasks reject native arguments that would conflict with profile-owned model, provider, session, config, or worktree settings. Some safe Codex reasoning and verbosity `-c` overrides are allowed.

## Cleanup and boundaries

Profiled execution avoids global config mutation, but it is still not a sandbox. The native CLI can run whatever tools and subagents it normally can run under your local permissions.

HarnessOrbit cleans up unchanged private execution files after the worker stops. If a file was modified, replaced, or its ownership marker changed, HarnessOrbit retains it and records cleanup evidence. Gateway logs and attempt evidence remain in the state directory.

Routing and capacity limits are HarnessOrbit attempt controls. `account.maxParallel` limits simultaneously active HarnessOrbit attempts in the same bucket. It does not limit native child agents, provider-side concurrency, HTTP connections, or API requests made inside one attempt.

## Current validation evidence

Profiled execution has been smoke-checked with Herdr 0.9+ using two Claude sessions and a local simulated Anthropic API. The isolated rerun used two profiles with different models and keys, exercised Read/Write/Bash/tool-result submission, accepted both tasks independently, matched 14 mock requests, confirmed global provider files were unchanged, and released runtime resources. Both native session/model records were present only under the private test configuration, with no matching sessions in user Claude projects. This verifies local orchestration and configuration/session isolation for that scenario; it is not a real model-quality or provider-billing test.

Codex CLI 0.154.0 and Pi 0.85.1 also passed native CLI profile request checks against local mock Responses and Chat Completions APIs. These used isolated native test directories and verified model selection and gateway authentication, not full Herdr task lifecycles. OpenCode was not installed for live validation.

To reproduce the two-session Claude check:

```bash
npm run smoke:profiles
```

This opt-in script needs Herdr and Claude Code. It creates its own Git fixture, initializes disposable first-run UI state so the welcome screen cannot consume the first task prompt, confirms the fixture's native directory-trust prompt, and runs against a local mock API. The synthetic model names `alpha` and `beta` are routing fixtures, not real provider models.

Each mock run uses a fresh private [`CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/env-vars) under `work/profile-smoke-*/private-claude-runtime/claude`. It does not copy your Claude credentials, settings, or plugins. HarnessOrbit passes this directory to both the Herdr daemon and the worker's launch environment, then verifies that native session records appear there rather than in your normal Claude projects directory. Evidence and synthetic usage remain in the private test directory, outside normal session discovery by model pickers and token-usage tools. This test requires no paid upstream model call; it is not a network sandbox.

Normal HarnessOrbit tasks still use your configured native home, skills, and extensions. Only mock tests use this disposable configuration. Older smoke runs may have written `alpha` / `beta` sessions to your normal Claude projects directory; back up and move only confirmed mock sessions out of that directory, then refresh local usage caches. Do not rename them to real models or delete unrelated conversations.

The relay currently limits request bodies to 16 MiB and upstream socket inactivity to 120 seconds. Standalone gateways do not reserve HarnessOrbit attempt slots. Gateway ids are immutable evidence ids; start a new id after stopping one. Running attempts keep their resolved snapshots. `profile refresh` updates imported connection fields for future attempts while preserving HarnessOrbit routing metadata.
