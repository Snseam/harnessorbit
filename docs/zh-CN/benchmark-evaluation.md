# 成对 Benchmark 评估

HarnessOrbit 的 benchmark 评估器是受控实验的统计框架。它不启动 agent，不把 adaptive dispatch 设为默认，也不会用 smoke test 或 shadow routing 声称 HarnessOrbit 变快。

使用预先声明的实验计划和结果文件运行：

```bash
node benchmarks/evaluate.mjs benchmarks/example-plan.json benchmarks/example-results.json
```

实验计划会先固定 schema version、experiment id、deadline、cohort、task id、实验臂和 repetition。结果文件必须带有相同的 `schemaVersion` 和 `experimentId`。每条结果都必须匹配一个预先声明的 `(cohortId, taskId, armId, repetition)` identity。重复、未知、不安全或过大的 identity 会让评估失败，不会被静默忽略。

评估器把缺失、失败、超时、取消和未判定 trial 都计入分母。只有在固定 deadline 内通过完整项目验收的 trial 才算完成。`p50TimeToAcceptanceMs` 与 `p90TimeToAcceptanceMs` 按全部计划 trial 计算；如果完成比例没有达到 50% 或 90%，对应分位数就是 `null`。这样可以避免只看成功子集而制造“很快”的假象。

报告包含 `overall` 总览和按 cohort 拆开的视图。已有仓库与 greenfield 的对比应优先看 cohort 视图；overall 只是方便汇总，不能掩盖某个 cohort 的退化。

报告还包含两个取消敏感性视图：

- `userCancelsIncluded` 把用户取消计为未完成。
- `userCancelsExcluded` 从该视图的分母和配对比较中排除用户取消。

配对比较按 cohort、task id 和 repetition 匹配。评估器会报告计划配对数、实际观察到的配对数、缺失 pair 成员数和完成配对的耗时差。完成配对耗时差只使用两个实验臂都产生实际完整验收结果的 pair。`benefitClaim` 保持为 `null`：默认启用或宣称收益需要足够的真实、受控、成对数据和单独发布决策。无法配对的数据可以检查，但不能支撑速度或完成率收益结论。

schema 只校验统计口径，不证明结果内容真实。原始 transcript、commit、检查日志和验收产物仍需保留给评审。没有 CI 或单独发布流程确认足够真实 benchmark 证据之前，HarnessOrbit 仍应保持 opt-in。

示例文件刻意很小且不完整。它们只展示统计口径，不代表性能证据。
