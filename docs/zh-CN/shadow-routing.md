# 任务交接与 shadow 调度

> English: [../shadow-routing.md](../shadow-routing.md)

Shadow 根据任务说明和现有资源证据解释“建议交给谁”，不会派发任务、运行校准、占用容量或更改 provider。每份决策都标记 `mode: "shadow"`、`applied: false`。

```bash
node bin/harnessorbit.mjs mode enable --strategy shadow --preference balanced
node bin/harnessorbit.mjs route shadow --file task.json
node bin/harnessorbit.mjs route shadow --file task.json --thread THREAD_ID --record
```

`--record` 保存当前对话下的脱敏、版本化决策，省略时只预览。旧会话继续 delegated；启用 shadow 后，skill 记录建议，但保留原有执行选择。可选 balanced、fastest、subscription-first、quality-first。目前缺少可比较的生产任务延迟证据，因此使用保守规则，不是已经训练好的调度器或提速保证。

可在普通任务文件中增加 brief：

```json
{
  "brief": {
    "version": 1,
    "taskKind": "bugfix",
    "risk": "low",
    "contextDependency": "high",
    "independent": false,
    "contextRefs": ["src/parser.mjs"],
    "knownFindings": ["已复现失败用例。"],
    "nonGoals": ["不修改公开 API。"],
    "acceptance": ["原有回归检查通过。"],
    "requiredCapabilities": []
  }
}
```

以上是附加片段，仍需正常任务字段和可执行 checks。列表和总大小有上限，不会静默截断；引用必须是仓库相对文件路径。brief 是交接上下文，不是工具授权或验收证明。省略 brief 时保持旧任务的归一化和摘要行为。

选择器遵守固定 agent/profile 与可选 `--resources ID,ID`、`--no-host`，检查调用证据是否过期、额度是否明确耗尽、必要能力是否有证据。简单 canary 不证明复杂代码能力。风险高或依赖当前上下文的任务在允许时倾向当前 host；独立任务可建议可用的外部资源。固定候选不可用时返回无选择，不擅自换人。

明确选择当前 Codex 时使用 `--executor host`；只考虑外部执行器时使用 `--executor external`。仅有 Codex＋checkout 的任务格式不能表达是哪条路径。固定 host 不可用时不会退回外部执行；它只在本次预览覆盖已保存的对话偏好，仍不能与任务中显式指定的外部 profile 冲突。

显式策略使用 mode schema version 2，让旧客户端明确拒绝，而不是悄悄忽略设置；旧版记录继续可读且保持 delegated。Shadow 建议始终不启动任务；显式选择[自适应派发](adaptive-dispatch.md)才能将候选绑定到实际尝试。用户明确选择在当前对话执行时，使用 [host 工作流](host-work.md)。
