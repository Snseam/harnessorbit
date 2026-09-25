# 执行配置、Profile 与路由

> English: [../execution-profiles.md](../execution-profiles.md)

Execution profile 让 HarnessOrbit 在不改写全局 provider 配置的前提下，为任务选择具体的原生 agent、模型和上游端点。一个 profile 描述一个 agent、协议、endpoint、模型、凭证引用、来源信息和容量提示。任务启动时，HarnessOrbit 创建本地 relay gateway，写入该 attempt 私有的运行配置，通过 Herdr 启动原生 CLI，并在 worker 停止后清理 HarnessOrbit 拥有的临时文件。

旧任务仍可使用。如果任务没有 `execution` selector，且没有 default profile，HarnessOrbit 会按原始流程用任务中的 `agent` 继承原生配置启动。如果设置了 default profile，HarnessOrbit 会把它用于旧任务，但要求它与任务 agent 兼容。只有带显式 `execution` selector 或存在 default profile 时，才应使用 `agent: "auto"`。

## 环境要求

Profiled execution 使用 HarnessOrbit 的基础要求，并需要你想驱动的原生 CLI：

- Node.js 22.13 或更新版本。
- `PATH` 中可调用 Herdr。
- 至少一个已配置好的原生 agent CLI：Claude Code、Codex CLI、Pi 或 OpenCode。
- 对同一组 profile、reservation、gateway 和 run 使用同一个 state directory。

HarnessOrbit 不安装原生 CLI 或 provider。它只生成本地配置，使原生 CLI 连接 HarnessOrbit 的 relay gateway。

## Profile 结构

profile 以 JSON 保存。`profile put` 会添加 HarnessOrbit 控制的 revision 和时间戳；`profile export` 会移除这些元数据，使导出文件可再次导入。

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

关键字段：

| 字段 | 含义 |
| --- | --- |
| `agent` | 启动的原生 CLI：`claude`、`codex`、`pi` 或 `opencode`。 |
| `protocol` | relay 协议：`anthropic`、`openai-responses` 或 `openai-chat`。必须与所选 agent 兼容。 |
| `endpoint` | 上游 base URL。必须是 `http` 或 `https`，且不能包含 userinfo、query 或 fragment。`credential.type: "none"` 只允许 loopback endpoint。 |
| `credential` | secret 引用，不是 secret 值。类型包括 `env`、`stored`、`cc-switch` 和 `none`。Anthropic 上游中，`authScheme: "bearer"` 使用 `Authorization: Bearer`；省略或 `api-key` 使用 `x-api-key`。 |
| `source` | profile 来源。`native` 表示手写；`cc-switch` 记录来源目录、provider id、app、route 和用于漂移检查的 fingerprint。 |
| `capabilities` | 人工标签，供 `requireCapabilities` 使用；HarnessOrbit 不从 provider 自动推断。 |
| `quality`、`speed`、`costPerMillion` | 人工路由评分。`quality`/`speed` 值越高越优先；`cost` 要求已知非负值，越低越优先。 |
| `quota` | 人工或观测到的提示，带有效期。除非你从平台余额同步，否则它不是平台原生余额。过期数据会显示为 stale，不会单独阻塞。 |
| `account.maxParallel` | 对共享 `account.id` 的 profile，或未设置 account 时同 endpoint host 的 HarnessOrbit attempt 进行并发预约限制。它不限制原生 child agent 或单个 attempt 内的 API 请求数。 |
| `modelMap` | Gateway 请求模型重写。请求 body 中的 model 若命中 map，转发为对应上游模型；否则使用 `profile.model`。 |
| `fallbacks` | 最多 8 个 profile id，作为同一 gateway 的后备上游。fallback 必须协议一致且通过路由资格检查。 |

每次读取 profile 记录时，HarnessOrbit 都会校验存储 schema、revision、规范化内容和 secret-like 字段。未知 secret 字段、无效 revision、非规范 JSON、不安全 env 名、symlink secret 文件和不能放进 header 的 secret 值都会被拒绝。

## 管理 Profile

需要非默认 profile store 时，所有命令都可加 `--state-dir PATH`。

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

`profile put --default` 会写入 profile 并设为默认。`profile export --file` 使用独占创建，不覆盖已有文件。

## Secret

不要把 secret 值写进 profile JSON 或命令参数。通过 stdin 保存本地 secret：

```bash
printf '%s\n' "$ANTHROPIC_API_KEY" | node bin/harnessorbit.mjs secret set --id anthropic-main --stdin
node bin/harnessorbit.mjs secret remove --id anthropic-main
```

命令会去掉一个最终换行，将值保存到 HarnessOrbit state directory 中的私有文件，并返回类似 `stored:anthropic-main` 的引用。secret 为空、包含控制字符或超过 64 KiB 时会被拒绝。也可以使用环境变量引用：

```json
{ "type": "env", "name": "ANTHROPIC_API_KEY" }
```

环境变量名必须是合法的 shell 风格变量名。CC Switch 导入使用 `credential.type: "cc-switch"` 和私有数据库字段引用；profile 不包含 key 值。

## 发现和导入 CC Switch Profile

HarnessOrbit 可以只读读取 CC Switch 数据库：

```bash
node bin/harnessorbit.mjs source discover
node bin/harnessorbit.mjs source discover --directory ~/.cc-switch
```

第一版支持真实 CC Switch 3.20.x 结构，要求 `PRAGMA user_version = 18`，以只读方式读取 `providers` 和 `proxy_config`。

本版本支持导入：

- `settings_config.env` 中包含 `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY` 的 Claude direct API 记录。
- 包含 `baseUrl`、受支持 `api`、`models` 目录及字面 `apiKey` 的 Pi provider。可用 `--model` 选定模型，上下文和输出限制写入 `modelMetadata`。
- 存在时读取 `ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL`、`DEFAULT_SONNET_MODEL` 以及 Anthropic 默认模型字段。
- 仅在显式传入 `--allow-shared` 时复用当前 active Claude proxy。

本版本不支持：

- 将 OAuth-only CC Switch 记录作为 direct profile 导入。
- 将 Codex、OpenCode 或其他未支持的 CC Switch client 记录作为 direct profile 导入；Pi 的命令型/插值型 key 也不支持直接导入。
- 自动切换 CC Switch 或写入 CC Switch 数据库。

导入示例：

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

`ANTHROPIC_AUTH_TOKEN` 导入为 `authScheme: "bearer"`；`ANTHROPIC_API_KEY` 导入为 `authScheme: "api-key"`。`profile refresh --id ID` 会重新导入已有 CC Switch profile 并检查来源 fingerprint。fingerprint 不包含 secret 值；公开配置变化会被识别，单独轮换 secret 不改变 fingerprint。

## 在任务中选择 Profile

任务可以指定固定 profile：

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

也可以让 HarnessOrbit 从候选 profile 中选择：

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

selector 字段：

| 字段 | 含义 |
| --- | --- |
| `profile` | 固定 profile id。不能和 `policy` 或 `profiles` 同时使用。 |
| `policy` | 自动策略：`available`、`quality`、`speed` 或 `cost`。默认 `available`。 |
| `profiles` | 自动路由的候选 profile id。 |
| `requireCapabilities` | 必须具备的人工 capability 标签。 |
| `allowShared` | 使用 active CC Switch proxy 等共享来源时必须显式设置。 |

如果 `agent` 是具体值，路由只接受相同 agent 的 profile。如果 `agent` 是 `auto`，HarnessOrbit 可从所有兼容候选中选择。default profile 会应用到旧式任务，但旧任务仍有具体 agent，因此 default 必须匹配该 agent，除非任务使用 `agent: "auto"`。

派发前可以查看路由决策：

```bash
node bin/harnessorbit.mjs route explain --file work/task.json
node bin/harnessorbit.mjs route reservations
```

路由结果包含候选、分数、原因、选中的 profile id 和当前 HarnessOrbit attempt reservation。`quota_exhausted`、`credential_unavailable`、`agent_mismatch`、`protocol_incompatible`、`shared_source_requires_allowShared` 等原因只描述路由资格。

## Gateway 生命周期

profiled task 会自动启动本地 HarnessOrbit gateway。也可以手动管理：

```bash
node bin/harnessorbit.mjs gateway start --profile claude-main --id manual-claude
node bin/harnessorbit.mjs gateway status --id manual-claude
node bin/harnessorbit.mjs gateway list
node bin/harnessorbit.mjs gateway stop --id manual-claude
```

gateway 是同协议 relay，支持 Anthropic Messages、OpenAI Responses 和 OpenAI Chat Completions 路径。它按 `modelMap` 或 `profile.model` 重写请求模型，并转发到同协议 profile。它不做 OAuth，不做 Anthropic/OpenAI 协议互转，也不隐藏协议不兼容。若要使用外部 gateway，请在 profile 中配置兼容的 endpoint 与 protocol；HarnessOrbit 仍把它当作上游 relay target。

fallback 采用保守策略。HarnessOrbit 可在明确未发出请求的网络错误，或上游返回 429/5xx 时尝试另一个 profile。如果请求字节可能已经到达上游，随后连接断开，HarnessOrbit 会把结果视为不确定，而不是假定可安全切换到另一个 provider 重试。

Gateway start 会拒绝 disabled profile、新鲜的 exhausted quota、不兼容 fallback 协议、远程 `credential.type: "none"`、未授权的 shared source 和缺失 required capability。`gateway stop` 会拒绝停止仍被活动 attempt 引用的 gateway。

## 原生运行配置

HarnessOrbit 为每个 attempt 写入私有文件，并传递原生 CLI 参数，使 agent 指向本地 gateway：

| Agent | 配置方式 |
| --- | --- |
| Claude Code | 写入 `claude-settings.json`，设置 Anthropic env key，传入 `--settings`、`--model` 和 `--session-id`。 |
| Codex CLI | 使用 command-backed auth 读取 gateway token，并用 `-c` 覆盖 `model`、`model_provider` 和 `model_providers.<name>`。该路径面向 Codex CLI 0.154 风格的 command auth，不修改全局配置。 |
| Pi | 写入 provider extension，使用 `--extension`、`--provider`、`--model` 和 `--session-id` 启动。 |
| OpenCode | 设置 `OPENCODE_CONFIG_CONTENT` inline provider config，并传入 `--model`。 |

profiled task 会拒绝与 profile 管理范围冲突的原生命令参数，包括模型、provider、session、config 和 worktree 设置。部分安全的 Codex reasoning/verbosity `-c` override 仍允许使用。

## 清理与边界

Profiled execution 避免修改全局配置，但它不是沙箱。原生 CLI 仍可在你的本地权限下使用它原本可用的工具和子代理。

worker 停止后，HarnessOrbit 清理未改变的私有执行文件。若文件被修改、替换或 owner 标记变化，HarnessOrbit 会保留并记录清理证据。Gateway 日志和 attempt 证据保留在 state directory。

路由和容量限制是 HarnessOrbit attempt 级控制。`account.maxParallel` 限制同 bucket 中同时活动的 HarnessOrbit attempt 数量，不限制原生 child agent、provider 侧并发、HTTP 连接数或单个 attempt 内的 API 请求。

## 当前验证证据

Profiled execution 已用 Herdr 0.9+、两个 Claude session 和本地模拟 Anthropic API 做过冒烟检查。隔离后的复测使用两个不同模型和 key 的 profile，覆盖 Read/Write/Bash/工具结果提交，两个任务独立 accepted，14 个 mock 请求匹配，全局 provider 文件未变化，并完成 runtime 释放。两份原生会话及模型记录均只出现在私有测试配置目录，用户 Claude projects 目录没有对应会话。它验证的是该场景下的本地编排、配置与会话隔离，不是真实模型质量或 provider 计费测试。

Codex CLI 0.154.0 和 Pi 0.85.1 的原生 CLI profile 请求也分别通过了本地模拟 Responses / Chat Completions API 检查，验证了模型与网关认证。测试使用隔离的原生目录，并非完整 Herdr 任务生命周期验证；OpenCode 本机未安装，尚未实测。

可通过 `npm run smoke:profiles` 复现两个真实 Claude 会话的测试。它需要 Herdr 和 Claude Code，会创建自己的 Git 夹具，初始化独立的首次启动界面状态，避免欢迎页吞掉第一条任务提示词；随后确认该夹具的目录信任提示，并连接本地模拟 API。`alpha` / `beta` 是用来区分路由的假模型名，不是真实提供商模型。

每次 mock 测试都会在 `work/profile-smoke-*/private-claude-runtime/claude` 创建全新的私有 [`CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/env-vars)，不复制你的 Claude 凭证、设置或插件。HarnessOrbit 同时把该目录传给 Herdr daemon 和 worker 启动环境，并验证原生会话记录出现在私有目录、没有进入正常的 Claude projects 目录。测试证据和模拟用量保留在私有目录，避免进入模型选择器及 Token 工具默认扫描的会话历史。模型请求不需要付费上游 API；这不是网络沙箱。

正常 HarnessOrbit 任务继续使用你的原生用户目录、技能与扩展，只有 mock 测试使用独立配置。旧版 smoke 可能已把 `alpha` / `beta` 会话写入正常 Claude projects 目录；应先备份，仅移出确认属于 mock 的会话，再刷新本地用量缓存。不要把假模型改名成真实模型，也不要删除无关对话。

当前网关请求体上限为 16 MiB，上游 socket 无数据活动超时为 120 秒。手动启动的独立网关不预留 HarnessOrbit attempt 名额。网关 id 是不可重用的证据标识，停止后需要使用新 id。运行中的尝试保持原快照；`profile refresh` 为后续尝试更新连接字段，并保留 HarnessOrbit 手写路由策略。
