# 本地 Agent Monitor

> English: [../monitor.md](../monitor.md)

Agent Monitor 是本地只读状态页，用来查看 CAO 任务及其关联的 Codex/Claude 原生 children。它适合检查并行工作：哪些 CAO attempt 正在运行、等待、accepted 或 rework；哪些 Codex subagent thread 与 coordinator 有关联；哪些 Claude subagent 通过 CAO 管理的 hook 或本地 metadata 被观察到。

它不是控制面。页面不执行命令、不发送输入、不取消任务、不停止 agent、不读取终端输出、不显示 prompt、不显示 tool input、不显示 tool output，也不显示模型回复。停止 monitor 只会停止 monitor web server。失败 attempt 的原因码可能以有界的 `performance.lastErrorCode` 出现；`herdr-server.log` 仍是 Herdr stdio。等待文案可能带有 `Provider saturated · not a CAO retry`，这不是 retry 指令。

## 快速开始

在项目 checkout 中运行：

```bash
node /path/to/codex-agent-orchestrator/bin/cao.mjs monitor start --open
```

如果已经在 CAO 仓库中，可以使用短命令：

```bash
node bin/cao.mjs monitor start --open
```

也可以直接告诉 Codex：

```text
打开当前项目Agent看板
```

英文等价说法：

```text
Open the Agent Monitor for the current project.
```

如果要让 Codex 打开对话视图并显示 token 列，可以说：

```text
打开当前项目Agent看板，切到当前对话并显示每个Agent Token
```

CLI 默认使用当前目录的 Git root。它会显示该项目的 CAO runs，以及通过当前 CAO state directory 和 coordinator metadata 可关联到的 Codex/Claude children。

## CLI 命令

```bash
node bin/cao.mjs monitor start [--project PATH | --run ID | --all] [--open] [--id NAME] [--port 0]
node bin/cao.mjs monitor status [--id NAME]
node bin/cao.mjs monitor stop [--id NAME]
node bin/cao.mjs monitor snapshot [--project PATH | --run ID | --all]
```

额外 source 参数：

```bash
node bin/cao.mjs monitor snapshot \
  --coordinator CODEX_THREAD_ID \
  --codex-home ~/.codex \
  --claude-home ~/.claude
```

Scope 参数：

| 参数                 | 含义                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 省略                 | 使用当前工作目录的 Git root 作为 `--project`。                                                                                                  |
| `--project PATH`     | 显示一个项目，路径会解析为 real path。                                                                                                          |
| `--run ID`           | 显示一个 CAO run 及其关联的原生 children。该 run 必须存在于同一个 state directory。                                                             |
| `--all`              | 显式显示所有可读 CAO runs 和范围内原生 metadata。它与 `--project`、`--run` 互斥。                                                               |
| `--coordinator ID`   | 当环境变量无法识别旧的或跨目录 Codex coordinator thread 时，显式关联它。不带 `--run` 时，CAO 也会读取 `CODEX_THREAD_ID` 或 `CODEX_SESSION_ID`。 |
| `--codex-home PATH`  | 要检查的 Codex 配置/数据根。默认 `CODEX_HOME` 或 `~/.codex`。                                                                                   |
| `--claude-home PATH` | 要检查的 Claude 配置/数据根。默认 `CLAUDE_CONFIG_DIR` 或 `~/.claude`。                                                                          |
| `--id NAME`          | Monitor server 名称。默认 `default`；不同 scope 可用不同 id。                                                                                   |
| `--port N`           | 本地端口。`0` 表示让系统分配空闲端口。                                                                                                          |

monitor 命令和要观察的 CAO runs 必须使用同一个 `--state-dir`。在一个 state directory 创建的 run，对另一个 state directory 启动的 monitor 不可见。

## Project view 与 Conversation view

UI 默认进入 Project view。Project view 显示 CLI 选定的当前项目 scope，并保留 project/run/task 分组。Conversation view 聚焦一个 Codex 对话及其 agent graph。两种视图在页面内切换；没有单独的 CLI view 参数。

Conversation view 可以显示当前 monitor 关联的 Codex 对话，也可以选择已在采集范围内的其他对话。`currentConversationId` 是 monitor 启动时关联的 coordinator id，来自 `--coordinator` 或启动环境。它不会自动跟随 Codex App 当前焦点，也不表示全局跨对话配置。

对话图只使用显式关系。Codex subagent、CAO external agent 和 Claude children 只有在 metadata 标识出关系时才会挂到所选 root conversation。归属未知的节点显示为 Unlinked。monitor 不会仅因为两个记录共享 project path 就猜测父子关系。

标题和名称来自明确的原生 metadata。CAO 不会把 prompt text、preview text、tool content 或模型回复当作 fallback title。

## 安全模型

monitor server 只绑定 `127.0.0.1`，并拒绝异常 Host、Origin、query-token 和写请求。`monitor start` 返回的 URL 会把 UI token 放在 fragment 中，例如：

```text
http://127.0.0.1:49152/#token=...
```

fragment 不会随 HTTP 请求发送。浏览器 UI 会把它保存到 `sessionStorage`，并用 Authorization header 请求 `/api/snapshot`。内部 health/stop endpoint 使用另一个 owner token，该 token 保存在 CAO state directory 中。

页面是只读的。`monitor stop` 调用 monitor 的 owner stop endpoint；它不会停止 Herdr、Codex、Claude、CAO task、subagent、terminal 或 provider 请求。

## 浏览器收到哪些数据

浏览器只收到经过清洗、字段有界的 metadata snapshot：

- id 与 parent id
- agent kind 与 source
- project/run/task/attempt id
- 可用时的 model name
- 可用时的 native session id
- 可用时的真实 title/name metadata
- status、status label、delivery state、timestamps、confidence、stale flag、source health
- 原生记录提供时的 `nodes.tokens` / `tokenUsage` token metadata

CAO 不会把 prompt、tool input、tool output、terminal text、模型回复、任意错误 stack 或原始 native record 发送到页面。原生 CLI 仍可能写入自身正常的 trust/history/session 文件。Monitor 的隐私边界是 CAO 不通过 monitor API 暴露这些内容；它不会关闭原生 CLI 自带的 history 功能。

Profiled execution 和 monitor hooks 不改写全局 provider 文件。CAO 可能在 state directory 下创建 attempt 私有 settings 或 hook 文件。

## 每个 Agent 的 token metadata

Monitor snapshot 可能在 `nodes.tokens` 和规范化 `tokenUsage` 字段中包含每个节点的 token metadata。UI 会把缺失值显示为 `—`。记录可能是 complete，也可能是 partial；partial 记录和 scanned-window 记录会显示为不完整观测，不会当作权威总数。

`tokenUsage` 可包含：

- `total`
- input、output、cache read、cache write、reasoning 等 counters
- `scope`：`session`、`turn` 或 `observed`
- `source`
- `complete`

当原生 source 暴露 session 总计时，CAO 优先使用原生 session totals。Claude usage 按 `message.id` 去重；parent 对话自己的日志不会自动加到 child 行。不同原生 source 中 cache 和 reasoning 可能已经包含在 input/output 中，因此 CAO 不会把这些 bucket 再相加生成更大的 synthetic total。

这些数字是本地 usage metadata，不是套餐余额、provider 账单，也不是某个 CAO task 的独立成本。它们也可能不同于 provider 发票，因为原生 CLI 对 usage record 的聚合、缺失或修订方式可能不同。

## 如何理解状态

CAO delivery 和原生 runtime state 是不同信号。

| 信号                                   | 含义                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `accepted` / `integrated` delivery     | CAO 独立验收通过该 attempt，或集成完成。                               |
| 原生 `finished`、`completed` 或 `idle` | 原生 runtime 或 subagent 看起来结束一轮或空闲。这不是 CAO acceptance。 |
| `submitted` delivery                   | CAO 已收集 result JSON，等待 verify。                                  |
| `rework` delivery                      | CAO 验证拒绝候选，任务等待 retry/rework。                              |
| `running`                              | CAO 或原生 metadata 表示正在运行。                                     |
| `waiting`                              | agent 可能需要输入，或任务需要 rework/retry。                          |
| `unknown`                              | CAO 无法安全判断 live 状态。                                           |
| `stale`                                | 观察结果过旧，或来自 fallback 而不是 live source。                     |

每个节点都有 source 和 confidence。`live` 表示 CAO 能观察当前 runtime 或 hook stream；`observed` 表示本地 metadata 或 CAO 记录显示某个状态，但不一定 live；`unknown` 表示 source 无法证明当前状态。stale flag 可与任何 source 同时出现。

Source health 与节点状态分开。一次 snapshot 可能显示 CAO connected，同时 Codex partial 或 Claude unavailable。该页面应被理解为证据视图，而不是完整调度事实。

## CAO task source

CAO 记录提供 run、task、attempt、delivery、project 和 verification/integration 状态。对于 active CAO attempts，collector 还会查询 Herdr，并在可用时复核记录的 pane、terminal、process group、shell pid、worker kind 和 worker status。若 identity 不再匹配，monitor 会把 attempt 标为 unknown，而不是接管另一个 terminal。

## Claude source

对于新的 CAO-managed Claude attempts，CAO 会尝试添加私有 Claude Code hooks 来观察 parent 和 subagent 生命周期事件。hook 集成遵循 Claude Code hooks 机制：<https://code.claude.com/docs/en/hooks>。

行为：

- CAO 将 monitor hook events 写到 CAO state directory 下。
- Hook 记录经过清洗，仅保留 event type、agent role、subagent id/type、status、native session id、timestamp 等 metadata；不保存 prompt text 或 tool input/output。
- legacy `--settings` 在只有一个可读 settings source 时会合并。
- `--bare`、多个无法合并的 settings、`disableAllHooks`、不安全私有路径或 settings 读取失败时会降级。attempt 仍会启动，但 Claude hook telemetry 可能 disabled 或 partial。
- CAO 证据显示一个 Claude Explore subagent 完成了 `SubagentStart → running → SubagentStop → completed`；随后 CAO task 通过独立验收和 integration。删除生成的 settings 会移除后续 hook 采集，但已记录 events 仍作为证据保留。

已有或非 CAO 管理的 Claude sessions 在可用时可能通过本地 metadata fallback 显示。这些行是低置信 metadata：有助于识别活动，但可能 stale，也不是完整 live subagent tree。

## Codex source

CAO 优先使用 Codex app-server proxy metadata。app-server 接口说明见 OpenAI 文档：<https://learn.chatgpt.com/docs/app-server>。CAO 请求 metadata，并 opt out message/output delta 流。

当本地 app-server proxy 不可用时，当前本机行为会回退到 Codex home 下的只读 SQLite metadata，包括存在时的 `state_5.sqlite` 和 `thread_history_1.sqlite`。该 fallback 可以显示 coordinator/subagent 关系和观测到的 turn 状态，但不能保证对所有 Codex 版本和主机完全实时或完整覆盖。

当需要关联旧的或跨目录 Codex root thread，且当前 shell 中没有 `CODEX_THREAD_ID` 或 `CODEX_SESSION_ID` 时，使用 `--coordinator`。

## Source 覆盖和限制

CAO 尝试的详情现在显示 host/外部执行器、自适应候选和选择理由、已观察到的阶段耗时、阻塞时间以及原生子代理完成证据。活动行保持简洁，展开详情即可查看这些证据。旧记录缺失字段仍显示未知，不换算成零。采集结果经过 HTTP 边界再次净化时，会保留这些公开计数，不透传私密子代理记录。

阶段时间包含协调和等待，不等于模型思考时间。子代理 `reported` 完成依赖报告合同，证据强度不同于 `verified` 生命周期事件。自适应选择表示候选已绑定到一次尝试，不表示代码或整个项目已验收通过。

monitor 默认限制在当前项目。只有明确需要更广本机 metadata 时才使用 `--all`。大型 source 集合会受限；snapshot 有上限，可能标记 `truncated`。

已知限制：

- `maxChildren` 仍是 result-reporting contract，不是原生 child 硬上限。
- 原生 CLI 和 provider 可能执行 CAO 不可见的工作。
- 原生 idle 或 finished 不证明任务正确。
- Codex SQLite fallback 是观测到的本地 metadata，不是 live subscription。
- Claude unmanaged fallback 是 metadata-only 且低置信。
- Token metadata 可能缺失、partial，或只覆盖 scanned window；它不是余额、账单或精确任务成本。
- Conversation view 只链接显式关系；未知归属保留为 Unlinked。
- UI 不能替代 `collect`、`verify`、`integrate`、`recover` 或原生 terminal 检查。

显式 `--coordinator ID` 表示你确认这个 Codex 协调器及其原生子代理树属于当前项目，允许关联不同工作目录中的后代。仅环境变量自动发现的协调器不会自动带入明确属于其他项目的子代理；已有 CAO run/attempt 中记录的协调关系也可用于关联。
