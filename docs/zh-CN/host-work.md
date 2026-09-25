# 将当前 Codex 的工作纳入 HarnessOrbit

> English: [../host-work.md](../host-work.md)

host 任务登记当前 Codex 对话直接完成的工作，使用目标 checkout、保留基线，并复用独立检查器。它不新建外部 Codex 会话、Herdr pane 或 gateway，也不占外部会话名额。

任务文件仍需 `id`、`objective`、`allowedPaths` 和非空的可执行 `checks`。省略 `agent`/`isolation`，或指定 `codex`/`checkout`；不接受外部 execution profile 和启动参数。

```bash
node bin/harnessorbit.mjs init --project /path/to/project --id demo
node bin/harnessorbit.mjs host start --run demo --file task.json --thread THREAD_ID
```

登记成功后再修改代码。返回结果包含 taskId、attemptId、nonce 和基线。结果文件使用这些实际 ID：

```json
{
  "taskId": "task-id-from-start",
  "attemptId": "attempt-id-from-start",
  "nonce": "nonce-from-start",
  "status": "submitted",
  "summary": "说明本次修改。",
  "changedFiles": ["src/example.mjs"],
  "checks": [],
  "children": [],
  "unresolved": [],
  "hostStopped": true
}
```

只有本次编辑和自己启动的原生子代理都已停止，才能声明 `hostStopped`。报告中的 checks 仍是自报证据。

```bash
node bin/harnessorbit.mjs host report --run demo --task TASK_ID --file report.json --thread THREAD_ID
node bin/harnessorbit.mjs host verify --run demo --task TASK_ID --thread THREAD_ID
```

HarnessOrbit 核对实际变更范围、当前 nonce 和快照，并独立运行配置的 checks。自报成功不能绕过失败检查。通过后标记 `deliveryMode: "in-place"`，不会通过 integrate 重复应用修改。候选通过与完整项目验收仍是两个层次。

环境提供当前 thread id 时可省略 `--thread`；显式 ID 必须与当前对话和已登记 owner 一致。它用于本地任务关联，不是 OS 安全或认证机制。

## 修复与取消

- 停止后的 rework/cancelled 可用相同定义执行 `host start --retry`，保留已有修改、生成新 nonce，并受 maxAttempts 限制。
- `cancel` 只请求当前 Codex 停止，不能直接终止 App 回合或无法观测的原生子代理。
- 确认所有 writer 都已停下后，调用 `host release --ack-stopped`。需要更新子任务时可传 `--children-file`，内容为完整状态数组，不得遗漏此前报告的 child。
- checkout 有修改时仍保持 hold；`host recover --thread THREAD_ID` 独立检查保留的代码，不重新启动 worker，也不重放补丁。
- 同一 owner 对话调用的 supervisor 可以验收已经停止并提交的 host 任务；运行中或未确认停止时返回 attention，不尝试操作虚构终端。

写锁只约束共用同一状态目录的 HarnessOrbit 操作，不是文件系统沙箱。已报告的未知/运行中子任务会阻止提交或释放。
