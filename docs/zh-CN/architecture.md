# 架构与模块

> English: [../architecture.md](../architecture.md)

CAO 是一个显式驱动的 CLI 控制器。它不是后台编排 daemon，不接管 provider 配置，不自动安装插件，也不自动 commit/push。执行类命令读取状态、执行一个阶段、写回证据并退出；只读查询检查状态、本地用量记录或 monitor metadata。Agent Monitor 可以观察部分本地 CAO/Codex/Claude metadata，但观察能力取决于数据源，它不是原生 child agent 控制平面。

## 运行边界

可选的前台监督器会为已有任务调用同一组执行阶段，持有 run 专属控制器锁，并在需要处理阻塞或轮询预算结束时返回；不会安装后台 daemon。状态提交后的性能事件与 attempt 计时只是观测，`run.json` 继续作为权威状态。详见[监督与性能记录](supervision.md)。

```text
用户/Codex App
  -> node bin/cao.mjs <command>
      -> skill install/status/uninstall -> 用户技能链接
      -> mode enable/status/disable -> 对话偏好记录
      -> Orchestrator
          -> State store
          -> Git/worktree/patch
          -> Herdr runtime
              -> claude | pi | opencode | codex
          -> verification commands
          -> optional local Agent Monitor
              -> CAO state + Codex app-server/SQLite + Claude hook/local metadata
```

CAO 只管理自己创建的 run、attempt、Herdr session、workspace/pane 和证据文件。agent 自身的模型、账号、provider、权限、原生子代理能力和本地配置由对应工具负责。

## 入口层：`bin/cao.mjs`

CLI 负责参数解析、读取任务文件、创建 `Orchestrator` 和输出 JSON。run 阶段命令包括：`init`、`validate`、`dispatch`、`status`、`inspect`、`collect`、`verify`、`retry`、`resume`、`input`、`integrate`、`recover`、`cancel`、`cleanup`、`doctor`、`usage`。Profiled execution 还增加 `source discover`、`profile ...`、`secret ...`、`route ...` 和 `gateway ...` 命令。本地监控增加 `monitor start`、`monitor status`、`monitor stop` 和 `monitor snapshot`。

重要语义：

- `dispatch` 只提交一次。
- `collect` 等待和对账，不重新提交。
- `verify` 验证已收集候选，不向 agent 继续发任务。
- `integrate` 应用已验收 patch 并在目标项目复验。
- `recover` 只复验已保留在 checkout 中的恢复场景：incomplete integration 不再次 apply patch；stopped checkout 任务按当前 checkout 重新验收。
- `monitor start --project <path> --open` 启动 localhost 只读看板。省略 `--project` 时，CLI 使用当前工作目录的 Git root。`--run` 限定到一个 CAO run；`--all` 必须显式指定，并且与 `--project`、`--run` 互斥。
- `monitor status`、`monitor stop` 和 `monitor snapshot` 用于查看或停止 monitor server。停止 monitor 不会停止 agent。`--id` 选择命名 monitor，`--port` 指定或自动分配 localhost 端口。

## Codex 技能与对话模式

`skills/cao` 是可安装的技能入口，显示名为 `CAO`。`src/skills.mjs` 将它链接到用户技能目录，保护已有同名内容；更新跟随仓库。包装脚本解析实际来源位置后调用 CLI，并保持目标项目的工作目录。安装和启用某个对话是两个独立操作。

`src/conversation-mode.mjs` 在 CAO 状态根的 `conversations/<thread-id>/mode.json` 保存经过校验的偏好，身份来自显式 thread ID 或调用方 Codex 环境。更新使用文件锁和原子写入；同项目的两个对话也有各自记录。技能读取记录，将 Agent/profile 和数量限制带入 CAO 工作流。该记录不会改变独立 CLI 命令默认值、拦截模型决策或调度任务；停用偏好也不会取消 worker。详见 [CAO 技能指南](codex-skill.md)。

## 执行 Profile 层：`src/profiles.mjs`、`src/routing.mjs`、`src/gateway/*`、`src/execution-config.mjs`

Profile 是可选 execution selector，存储在 CAO state root 下。它描述原生 agent、协议、endpoint、模型、凭证引用、来源、人工 capability、人工质量/速度/成本提示、quota 提示、fallback id 和 CAO attempt 容量 bucket。`get` 和 `list` 返回前会验证磁盘 profile JSON，包括 schema version、revision hash、规范化 public 字段和 secret-like 字段拒绝。Secret 值单独保存，或来自环境变量/CC Switch 引用，并在放入 HTTP header 前校验。

路由支持固定 profile，也支持候选列表加 `available`、`quality`、`speed` 或 `cost` 策略。具体任务 agent 会按 agent 兼容性过滤 profile。`agent: auto` 允许所选 profile 决定原生 agent。default profile 对省略 `execution` 的旧任务等同于 execution selector；也可以满足 `agent: auto` 的旧任务。

Reservation 是 CAO attempt 级限制。设置了 `account.id` 的 profile 使用 `account:<id>` bucket；否则按 endpoint host 预约。`account.maxParallel` 限制该 bucket 中活动 CAO attempt 数量，不限制原生 child、provider 侧 API 并发或单个 worker 内的 HTTP 请求。

Gateway 是同协议本地 relay，支持 Anthropic、OpenAI Responses 或 OpenAI Chat profile。它按 `modelMap` 或 `profile.model` 重写请求模型，注入解析后的 secret，过滤受保护 header，并可使用同协议 fallback。它不做 OAuth 或协议转换。Fallback 采用保守策略：CAO 可在明确未发出请求的网络错误或上游 429/5xx 时重试；如果连接断开前字节可能已经到达上游，则视为不确定，不假定可安全重试。

`prepareExecution` 写入每个 attempt 私有的原生配置，不修改全局 provider 文件。Claude Code 使用生成的 settings 文件和 session id；Codex CLI 使用 command-backed auth 和 `-c` provider override；Pi 使用 provider extension；OpenCode 通过 `OPENCODE_CONFIG_CONTENT` 使用 inline config。与 profile 管理范围冲突的原生命令参数会在启动前被拒绝。

CC Switch source adapter 只读。支持 schema version 18 中 `settings_config.env` 的 Claude direct API 记录、显式 `allowShared` 复用 active Claude proxy，以及包含字面 key 和明确模型目录的 Pi API-provider 记录。OAuth-only 和其他未支持的 client 记录会显示为 unsupported 或 gateway-required。原生/NVM 发现和隔离探针边界见[资源发现与校准](resources.md)。

## Orchestrator：`src/orchestrator.mjs`

Orchestrator 是状态机和流程协调层。

- `init`：确认项目 Git root、记录 `baseCommit`、项目快照、初始 dirty 状态和 CAO 专用 Herdr session。
- `dispatch`：校验任务、检查依赖和容量、解析 execution selector 或 default profile、预约 profile 容量、在 profiled 模式启动 gateway、准备隔离目录、启动 Herdr server/workspace/agent、发送 prompt。
- `collect`：观察 Herdr agent 状态，读取 result JSON，校验 attempt nonce、child 报告、允许路径和候选快照。
- `verify`：关闭 worker pane，运行 checks，保存 `check-*.json` 与 `verification.json`，worktree 任务通过后生成 `candidate.patch`。
- `retry`：在 `rework`、`failed`、`interrupted`、`cancelled` 后创建下一 attempt，复用之前的候选 cwd/worktree，并把报告、验收结果和反馈带入新 prompt。
- `integrate`：对 accepted worktree attempt 应用 patch 到目标项目，并重新运行 checks；失败或取消会形成跨 run hold，直到 recover 通过。
- `recover`：对 integration hold 复验当前 checkout，不再次 apply patch；对已停止的 failed/rework/interrupted/cancelled checkout 任务，按当前 checkout 重新进入 verify。
- `cancel`/`cleanup`：关闭 worker 或停止 CAO session；证据与工作树保留。checkout cancel 无改动时释放 checkout hold；cleanup 关闭 run 的新 dispatch，但不清除 hold。

## Agent Monitor：`src/monitor/*`

Agent Monitor 是一个本地只读状态界面，用于查看 CAO 项目和相关原生 agent metadata。默认 scope 是当前 CAO 项目：`monitor start --open` 会把当前工作目录解析为 Git root，并展示匹配的 CAO run，以及可关联的 Codex/Claude children。`monitor start --run <runId>` 缩小到单个 run；`monitor start --all` 是显式的整机视图。三种 scope 互斥。`--codex-home` 和 `--claude-home` 指向对应工具的配置根，不是项目目录。旧版或跨目录 Codex coordinator thread 需要关联时，可以显式传 `--coordinator`。Monitor 使用与 run 命令相同的 CAO state directory。

Monitor server 绑定 `127.0.0.1`，并返回类似 `http://127.0.0.1:<port>/#token=...` 的 token URL。浏览器把 fragment token 放入 `sessionStorage`；API 请求用 bearer token，因此 token 不写入 CAO state。Host/origin 检查会拒绝非本地访问。UI 只显示 metadata，没有执行、prompt、input、cancel 或 stop-agent 控件。`monitor stop` 只停止本地 monitor server。

Monitor 状态与 CAO 交付状态不是同一件事。CAO `accepted` 表示 CAO 已独立验收候选；原生 Codex/Claude 的 `finished`、`idle` 或 `completed` 只表示原生 agent 当前没有活动工作，不表示 CAO 已接受 patch。Snapshot 会带 source freshness，例如 live、observed、unknown 或 stale，方便区分已连接数据、本地历史和 fallback metadata。

CAO 管理的 Claude attempt 可以注入私有 hook settings，用于报告经过清洗的生命周期 metadata。旧版单个 `--settings` 启动可以合并；`disableAllHooks`、`--bare`、多个 settings 文件或不安全 settings 路径会降级为较低置信度 metadata，而不是强行启用 telemetry。已有或非 CAO 管理的 Claude session 仍可通过本地 metadata fallback 观察，但置信度较低。Hook 路径记录 `SubagentStart -> running -> SubagentStop -> completed` 这类生命周期字段；不保存 prompt、tool input、tool output、回复或任意 hook payload。删除生成的 settings 会阻止之后的 hook 事件，已有 CAO event 证据仍保留。

Codex 观察优先使用本地 app-server proxy。当前本机 app-server 行为下 proxy 路径不可用，因此 CAO 会退回只读 SQLite 观察，读取 `thread_history_1` 和 `state_5`。这个 fallback 对 coordinator/thread metadata 有用，但不能承诺完整或完全实时覆盖。原生 CLI 的 trust 文件、history 文件和 provider 行为仍是工具自身的正常行为；CAO 为 monitor 不修改全局 provider 文件。操作命令和数据源限制见 [Agent Monitor](monitor.md)。

## 状态层：`src/state.mjs`

默认状态根是 `~/.local/state/codex-agent-orchestrator`，也可以用 `--state-dir` 指定。状态根必须在目标项目外部。

目录形态：

```text
<stateRoot>/
  runs/<runId>/
    run.json
    events.jsonl
    herdr-server.log
    attempts/<attemptId>/
      task.json
      prompt.txt
      result.json
      terminal.txt
      check-*.json
      verification.json
      candidate.patch
      integration-<随机>.json
```

`herdr-server.log` 是 Herdr daemon 的 stdio。preparing→failed 的原因在 `attempt.state.errorCode` 和 `inspect` 的 `lastError` 上，不在这份日志里。

写 JSON 使用临时文件 + rename；锁使用目录锁，带 pid/hostname/nonce owner。只恢复同主机且进程确定死亡的锁。checkout 单写锁和项目集成锁位于 `<stateRoot>/locks/`，因此只在相同 stateRoot 下互相可见。

## 任务与 prompt：`src/task.mjs`、`src/adapters.mjs`

`validateTask` 严格拒绝未知字段和不安全路径。`compilePrompt` 把任务目标、允许路径、检查命令、原生说明、child 报告契约和 result JSON skeleton 写入 prompt。

完整 assignment 写入 attempt 的 `prompt.txt`；`dispatch` 注入 worker 的是短入口 prompt，只要求 agent 读取 `prompt.txt` 并执行其中的 result contract。

继承模式下 adapter 保留 provider 设置：

- `claude`：Herdr kind 为 `claude`，启动参数会先加 `--add-dir <attemptDirectory>`，再追加 `agentArgs`。
- `pi`、`opencode`、`codex`：按 `agentArgs` 原样传给 Herdr `agent start`。

`maxChildren` 是报告契约。CAO 只验证 result JSON 中 `children.length <= maxChildren` 和 child 状态字段，不硬性限制原生 child、provider 侧 API 并发或单个原生 agent 内的后台工作。Agent Monitor 可以展示部分 CAO 管理或本地观察到的 Codex/Claude child metadata，但这不是 enforcement，也不是完整性保证。Profiled 模式通过 `src/execution-config.mjs` 增加临时原生配置；详见[执行配置](execution-profiles.md)。

## Herdr runtime：`src/runtime/herdr.mjs`

runtime 只操作显式 session，并拒绝 default session。调用 Herdr 前会清理继承的 `HERDR_SOCKET_PATH`、`HERDR_SESSION`、`HERDR_PANE_ID` 等环境变量，避免误连当前 pane。

主要操作：

- `ensureServer`：启动 `herdr --session <session> server`，轮询 `api snapshot` 至多 10 秒。
- `createWorkspace`：在 attempt cwd 创建 workspace，不抢焦点。
- `startAgent`：在 root pane 启动指定 kind 的 agent。
- `prompt`、`keys`、`readAgent`：提交 prompt、发送人工输入、读取可见输出。
- `closePane`、`stopServer`：关闭 worker pane 或停止 CAO session。

CAO 依赖 Herdr 的 pane/terminal/process identity。attempt 会记录 `paneId`、`terminalId`、foreground process group、shell pid 和 agent kind；collect/input/cancel 会复核这些值。若 terminal、pane、process group、shell pid 或 kind 改变，CAO 会拒绝收集、输入或关闭，避免误接管替换后的 pane。

## Git 层：`src/git.mjs`

Git 层负责项目快照、worktree、patch 和集成前冲突检查。

- 快照包含所有 tracked 文件，以及未被 Git 忽略的 untracked 文件；tracked 文件即使匹配 ignore 规则也会进入快照。记录 hash、mode、type。
- 快照把 gitlink 记为不透明指针（`type: gitlink`），不会把 submodule 内容检出到候选 worktree。仍不读取 `.git`，也拒绝经过 symlink ancestor 的路径。
- worktree 任务使用 `git worktree add --detach`；源项目 dirty 时，会先把当前 tracked/untracked 状态写入 tree，再把候选 worktree reset 到该 tree，保留用户未提交基线。
- `makePatch` 用临时 `GIT_INDEX_FILE` 生成 binary patch，不修改用户真实 index。
- `applyPatch` 先 `git apply --check`，再 `git apply`；不 stage、不 commit。

未追踪且被 Git 忽略的文件不会进入快照、candidate patch 或集成覆盖范围；tracked 文件仍按 Git 内容进入快照。

## 验证层：`src/process.mjs`

checks 使用 argv 数组直接 spawn，不走 shell。每个 check 在候选 cwd 或目标项目 cwd 运行，遵守 `timeoutMs`。超时或取消会终止 CAO 启动的进程组；stdout/stderr 有大小上限并写入证据 JSON。

验证命令不应修改源码。`verify` 和 `integrate` 都会检查验证前后快照是否稳定；如果验证修改了源码，attempt 会进入失败/返工状态。

## 当前验证证据

基础流程有本地测试和 Claude Code 真实场景覆盖。Profiled execution 已用 Herdr 0.9+、两个 Claude session 和本地模拟 Anthropic API 做过冒烟检查：两个 profile 使用不同模型和 key，完成 Read/Write/Bash/工具结果提交，两个候选独立 accepted，16 个 gateway 请求符合预期，全局 provider 文件未变化，并完成 runtime 释放。Monitor 证据包括一个 CAO 管理的 Claude Explore child 上报 `SubagentStart -> running -> SubagentStop -> completed`；独立验收和 integration 通过，删除生成 settings 后不再产生后续 hook 事件，已有 CAO event 证据保留。这是本地编排与 metadata 捕获的集成证据，不是真实模型质量、计费或完整 UI 覆盖证据。

## Token 查询：`src/usage.mjs`、`src/runtime/tokscale.mjs`

`UsageService` 调用可选的外部 Tokscale CLI，不修改 CAO 账本。适配器先校验版本、分组、数字字段和聚合总数，再返回 token 各分项。本机查询按 client/provider/model 分组；run/task 查询逐个 client 获取 workspace 报告，与已记录的 worker 目录匹配，明确输出归属精度与覆盖率。共享 checkout 和歧义记录不计入 task 总数。安装方式、计数语义及协调器/session 限制见 [Token 用量报告](usage.md)。
