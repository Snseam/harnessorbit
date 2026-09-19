# 前台监督与性能记录

> English: [../supervision.md](../supervision.md)

CAO 可以对已有任务自动推进收集和独立验收，减少正常阶段逐条等待模型决定下一条命令的开销。原有任务身份、Git 范围、验收与整合 hold 继续生效。

## 使用已有 run

```bash
# 可选的只读启动预检：检查 Git 快照与所需执行文件。
node bin/cao.mjs preflight --run demo --file task.json

# 协调已有任务一次，不创建或重新执行实现任务。
node bin/cao.mjs step --run demo

# 在等待预算内轮询并推进正常阶段。
node bin/cao.mjs supervise --run demo --wait-ms 30000

# 显式允许整合已验收 worktree 补丁，以及每个 attempt 一次报告补交。
node bin/cao.mjs supervise --run demo --integrate --repair-reports

# 只读查询已经落盘的性能记录。
node bin/cao.mjs performance report --run demo
```

使用自定义状态目录时，传入与原 run 相同的 `--state-dir`。预检不登录、不刷新凭据、不调用模型；找到执行文件不代表账号实际可用。dispatch 也会在启动 worker 前预检；不支持的 Git 快照和缺失的运行文件会提前失败并保留诊断。

`supervise` 是前台控制器，轮询预算最多 45 秒。已开始的验收/整合检查受各自 timeout 和可选任务 deadline 限制，因此单次调用可能超过轮询预算。两次调用之间没有后台 watchdog。返回 `timeout` 且任务仍在运行时可以继续调用；返回 `attention` 时先查看原因。每个 run 的控制器锁阻止两个监督器同时操作。看板保持只读，打开网页不会让监督持续运行。

不传 `--integrate` 时，已通过验收的 worktree 补丁留待查看。checkout 任务已经在项目原位修改，不会重复应用补丁。任务检查完成不等于完整产品验收，因此性能报告保留 `projectAcceptance: "unknown"`。

## 自动行为与边界

- 从同一已识别 worker 收集结果，不重发实现任务。
- 对已提交快照独立执行任务 checks。
- 仅在传入 `--integrate` 时，按原有规则应用并重验 worktree 补丁。
- 仅在传入 `--repair-reports` 时，为缺失或格式错误的报告请求一次补交；先保存发送意图，确认丢失时不会重复发送。
- 监督器运行时检查过期任务并请求取消受管工作；身份校验和保留编辑的恢复 hold 不会被跳过。

权限、认证、陈旧 nonce、越界修改、未完成/未知子任务、检查失败和不明确的控制器状态都会需要处理。监督器不会批准权限、重试实现、切换提供商、新建任务、清除 hold、提交或推送。缺少可信进展会要求诊断，不会仅因终端安静就判断进程已停止。

Herdr `blocked` 等待会把 `lastError` 记为 `permission_required` 或 `worker_blocked`。先 `inspect --output`，只对已检查的对话框发 `cao input`，再 `resume`。pane 离开 `blocked` 后，collect 会恢复 `running`。监督 attention 使用该错误码；旧的 `:failed` attention key 不迁移。提供商满载记在 `providerObservation`，不替换 `lastError`；monitor waiting 不是 CAO retry。`inspect.retryAdvice` 说明 worktree 越界要换新任务，还是 checkout 可以 retry。

## 可选任务截止时间

任务 JSON 可添加 UTC 绝对时间 `deadlineAt`，例如 `"2030-01-02T03:04:05.000Z"`，请换成实际截止时间。重试沿用同一 deadline，不重新计算预算；省略则保持旧行为。

启动控制器、独立检查和监督器运行时执行该约束。控制器未运行时，worker 可能继续超过截止时间，下一次监督会先协调并取消过期工作。无法观测的原生后代不具有硬实时终止保证。

过期不会丢弃编辑或释放身份不明确的 writer。显式 `recover` 可以在过期后对保留的 checkout/整合状态做有超时的检查，不重启 worker，也不重放补丁。继续新的实现工作需要合适的新任务截止时间。

## 原子提交报告

新 attempt 目录包含 `submission.json`、`task.json` 与 `prompt.txt`。worker 可将原有结果 JSON 通过 stdin 传给：

```bash
node /absolute/path/to/cao/bin/cao.mjs result submit --attempt-dir /absolute/attempt --stdin
```

也可使用 `--file /path/to/report.json`。helper 校验身份、结构与大小后原子写入 `result.json`，拒绝符号链接结果文件。返回的 `accepted: false` 表示它只收到了报告；仍需按权威 run 记录收集并独立验收。旧 worker 直接写结果文件的方式继续兼容。

## 性能报告口径

新 attempt 记录准备、启动、执行、收集、验收、整合的观察区间；阻塞时间单列，不冒充模型推理耗时。观察时间刷新不会自动刷新进展时间。旧任务缺失的阶段历史明确标未知。

报告保留所有 attempts，包括失败、超时、取消和未验收。`totalElapsedMs` 是已观察 attempt 区间之和，不是项目墙钟耗时或加速倍数；`runWallMs` 另列。候选通过率不代表产品完成率。Token 仍由 `usage` 查询，并保留各自归属限制。

已提交的 `run.json` 是权威记录。`events.jsonl` 中新增的 `performance.observed` 带 schema、稳定 event id、序号和可用的控制器 epoch；附加日志失败时标 coverage 不完整，旧事件仍兼容。性能报告不输出完整 prompt、provider 配置、nonce 或终端正文。

前台监督可配合[资源发现与隔离校准](resources.md)、[shadow 调度](shadow-routing.md)、[当前 Codex host 工作流](host-work.md)和显式启用的[自适应派发](adaptive-dispatch.md)使用。Pi RPC 和默认工作流更新仍是后续工作；协议测试不作为真实提速证据。
