# 状态、隔离与集成语义

> English: [../states.md](../states.md)

本文说明 HarnessOrbit 的 run、task、attempt 状态和安全边界。实际状态以 `run.json` 为准。

可选前台 `supervise` 命令推进同一组状态。任务 `deadlineAt`、一次报告补交、原子提交及阶段计时见[监督与性能记录](supervision.md)。它们不会将原生 idle 当作验收通过，也不会清除 checkout/integration hold。

## Run

`init` 创建 run：记录项目 root、base commit、baseline snapshot、是否初始 dirty、最大并发和 HarnessOrbit 专用 Herdr session。`status` 不带 `--run` 时列出所有 run。

`cleanup` 只停止该 run 的 Herdr session，写入 `closedAt`/`serverStoppedAt`，并关闭该 run 后续新 dispatch。它不会删除 worktree、attempt 目录、证据文件或目标项目文件，也不会清除 checkout 或 integration hold。

## Attempt 生命周期

常见主路径：

```text
preparing -> launching -> ready -> sending -> running
  -> submitted -> verifying -> accepted -> integrating -> integrated
```

需要人工或重试的路径：

```text
running -> needs_input
submitted -> verifying -> rework
preparing/running/verifying -> cancelling -> cancelled
running/uncertain -> interrupted
accepted -> integrating -> integration_failed
integration_failed/integration_cancelled -> recover -> integrating -> integrated|integration_failed
```

状态含义：

| 状态                 | 含义                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preparing`          | attempt 已预留，正在准备目录、worktree 或 checkout。                                                                                                                      |
| `launching`          | Herdr workspace/pane 已创建，正在启动 agent。                                                                                                                             |
| `ready`              | agent 已就绪，尚未发送任务。                                                                                                                                              |
| `sending`            | HarnessOrbit 已声明将发送 prompt；失败后进入 `uncertain`，不能盲目重发。                                                                                                           |
| `running`            | prompt 已交给 agent，等待 result JSON。                                                                                                                                   |
| `uncertain`          | 提交或观察失败，可能已经送达；用 `resume`/`collect` 对账。                                                                                                                |
| `needs_input`        | agent 阻塞、result 要求输入、child 未完成、unresolved 非空、越界修改或 result 无效。                                                                                      |
| `submitted`          | 已收集有效候选，可进入 `verify`。                                                                                                                                         |
| `verifying`          | worker 已关闭，正在运行 checks。                                                                                                                                          |
| `accepted`           | checks 通过；worktree 任务已有已验 patch。                                                                                                                                |
| `rework`             | 验证失败，可 `retry`。                                                                                                                                                    |
| `integrating`        | 正在把已验 patch 应用到目标项目并复验。                                                                                                                                   |
| `integrated`         | patch 已应用，目标项目复验通过。                                                                                                                                          |
| `integration_failed` | patch 应用失败或应用后复验失败。若 patch 已经成功 apply，改动会保留在目标项目中，供人工检查/修复；此 hold 会阻止同项目新 dispatch 和其他 integration，直到 recover 成功。 |
| `cancelled`          | 已取消。                                                                                                                                                                  |
| `interrupted`        | worker 缺失、CLI 中断或启动流程无法安全恢复。                                                                                                                             |
| `failed`             | 启动或流程失败且没有可继续的 worker。原因码在 `inspect` 的 `lastError` 和 `attempt.state.errorCode` 上；`herdr-server.log` 是 Herdr stdio，不是该原因。                   |

## 隔离模式

### `worktree`

默认模式。首次 attempt 在状态目录下创建 Git worktree，worker 只在该 worktree 中改动。`retry` 复用之前的候选 cwd/worktree，而不是每次创建新的 worktree。验证通过后生成 `candidate.patch`；`integrate` 再把 patch 应用到目标项目。

优点：适合并行任务；集成前会检查目标项目中候选改过的文件是否仍等于候选基线，避免覆盖别人后来的改动。

注意：worktree 任务依赖另一个 task 时，依赖必须已 `integrated`，否则新 worktree 看不到依赖结果。

### `checkout`

worker 直接写目标项目 checkout。HarnessOrbit 会在相同 stateRoot 下加项目级单写锁：任一 run 中有 active checkout 任务时，其他 checkout 任务不能启动。checkout 任务失败、取消或中断后，如果 checkout 相对该任务 baseline 有改动，会继续 hold，阻止同项目新 task 与 integration；可以对原 task `retry`，或在 worker 停止后用 `recover` 复验当前 checkout。若 cancel 时 checkout 没有改动，HarnessOrbit 会标记 `checkoutReleased` 并释放 hold。

限制：这个锁只覆盖相同 stateRoot。另一个 stateRoot、手工 shell 或外部工具不受 HarnessOrbit 锁约束。

## Scope 不是 sandbox

`allowedPaths` 用于收集后的验收判断，不是进程沙箱。agent 仍以本机用户权限运行。HarnessOrbit 的保护点是：

- 任务路径必须是相对路径或目录前缀，不允许 glob、绝对路径、反斜杠、路径穿越和 `.git`。
- 目录前缀必须以 `/` 结尾；没有尾斜杠的路径是精确文件。当快照里已有该路径下的文件时，preflight、dispatch 和 host start 会以 `directory_scope_missing_slash` 失败。`src/` 和 `.` 仍然合法，没有文件数上限。
- `collect` 比较候选快照，发现 tracked/unignored 文件超出 `allowedPaths` 会进入 `needs_input`。
- `verify` 拒绝带越界修改的候选。
- 未追踪且被 Git 忽略的文件不在快照、changedPaths 或 patch 中，因此不会被 `integrate` 覆盖。
- `inspect.retryAdvice` 是 `attempt` 的兄弟字段，不写入 attempt。worktree 的 `scope_violation` 为 `dispatch_new_task`；checkout/host 为 `retry_with_feedback`；`rework` 为 `retry_with_feedback`；后续 rework（`number >= 2`）为 `revise_or_split`。
- worktree 在 `outsideScope` 之后 `retry` 会抛 `scope_retry_forbidden`。checkout/host 在 cancel 之后仍可 retry，以便清 `checkoutHold`。`recover` 对残留编辑继续 fail-closed。
- 提供商满载记在 `attempt.providerObservation.code`，不是 `lastError`，也不授权 `retry`。`retry` 仍只在 `rework`、`failed`、`interrupted`、`cancelled` 合法。

## Result contract

agent 必须最后写入 attempt 的 `result.json`。字段必须匹配 prompt 中的 skeleton：

```json
{
  "taskId": "fix-math",
  "attemptId": "fix-math-a1-1234abcd",
  "nonce": "uuid-from-prompt",
  "status": "submitted",
  "summary": "完成了 add 实现修复。",
  "changedFiles": ["src/math.mjs"],
  "checks": [
    {
      "name": "node tests",
      "status": "passed",
      "command": "node --test tests/math.test.mjs"
    }
  ],
  "children": [],
  "unresolved": []
}
```

`status` 只能是 `submitted` 或 `needs_input`。`children` 里的状态只能是 `completed`、`cancelled`、`running`、`unknown`。只要存在 `running`/`unknown` child，或 `unresolved` 非空，HarnessOrbit 都会把 attempt 保持在 `needs_input`。

HarnessOrbit 不会真实监测原生 children。child 报告是 agent 与控制器之间的契约，不是 telemetry。

## Prompt dispatch

HarnessOrbit 把完整 assignment、范围、检查命令、child 报告契约和 result JSON skeleton 写入 attempt 目录的 `prompt.txt`。真正发给 agent 的 prompt 是短入口：要求 agent 完整读取 `prompt.txt`，然后执行其中任务。这样减少长 prompt 直接粘贴到交互终端时的控制风险。

## Verification

`verify` 只接受 `submitted` 或已 `accepted` 的 attempt。它会：

1. 确认没有 scope violation。
2. 确认候选自 collect 后未变化。
3. 关闭 worker pane，避免验证期间继续改文件。
4. 在候选 cwd 运行任务声明的 checks。
5. 确认验证没有改动源码。
6. worktree 任务通过后生成 `candidate.patch` 和 `verification.json`。

验证失败时进入 `rework`，可以 `retry`。retry 不丢弃候选 worktree/checkout 中的已有改动，而是在同一 cwd 上创建新的 attempt 和 prompt。若 verifying 期间控制器崩溃或被中断，本 MVP fail-closed：`resume` 不自动重跑 checks，也不自动恢复为 accepted；需要人工检查进程、证据和 checkout 后再决定下一步。

## Integration

`integrate` 只处理 `accepted` 且 worker 已关闭的 `worktree` attempt。集成证据写入 attempt 目录的 `integration-<随机>.json`。它会：

1. 检查候选 worktree 快照仍等于已验快照。
2. 检查 patch hash 未变。
3. 检查目标项目中候选改过的每个文件仍等于候选 baseline。
4. 确认没有 checkout hold 或未处理的 integration hold。
5. `git apply --check` 后 `git apply`。
6. 在目标项目重新运行 checks。
7. 检查复验期间目标项目快照稳定。

如果 apply 失败，状态为 `integration_failed`，目标项目通常未改动。如果 apply 成功但复验失败或不稳定，状态仍为 `integration_failed`，已应用的改动会保留在目标项目中。此 hold 跨 run 生效，阻止同项目新 dispatch 和其他 integration。修复当前 checkout 后运行 `recover`；recover 只重新检查当前 checkout，不会再次 apply patch。HarnessOrbit 不会自动 reset、commit 或 push。

## 当前验证边界

仓库内单元测试覆盖 fake Herdr、状态机、任务校验、Git patch/集成/recovery 语义和 CLI 参数。真实控制链路已完成一次：首个会话按测试要求保留错误实现、独立验收失败，第二个会话修复，随后 `verify` 和 `integrate` 通过。该过程包含一次人工处理新 fixture trust，以及一次长粘贴只落到输入框、由 controller 补 Enter 的干预。新版短 prompt 的正常冒烟也已通过：处理测试目录信任后，派发任务至集成清理没有补输入。尚未测量大规模完成率或加速效果。Pi、OpenCode、Codex 当前只确认有启动适配和 prompt/report 契约，未做真实端到端验证。
