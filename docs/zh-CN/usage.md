# Token 用量报告

> English: [../usage.md](../usage.md)

HarnessOrbit 可以通过可选的外部 [Tokscale](https://github.com/junhoyeo/tokscale) CLI 查询本机 token 记录。Tokscale 不是 HarnessOrbit 运行时依赖，HarnessOrbit 不会安装或配置任何 Agent。需要用量报告时，请单独安装：

```bash
npm install -g @tokscale/cli@4.16.0
node bin/harnessorbit.mjs usage --today
```

HarnessOrbit 按 Tokscale 4.16.0 编写，并接受 Tokscale `>=4.16.0 <5`。如果可执行文件不叫 `tokscale` 或不在 `PATH` 中，可以显式指定：

```bash
node bin/harnessorbit.mjs usage --tokscale-bin /opt/tools/tokscale --today
CAO_TOKSCALE_BIN=/opt/tools/tokscale node bin/harnessorbit.mjs usage --today
```

Tokscale README 记录了 `models --json`、`--client`、日期过滤和 `--group-by`，包括 `client,session,model` 与 `workspace,model`。HarnessOrbit 只调用 Tokscale `models --json --no-spinner --home ...`；不会调用 `submit`、`autosubmit`、`usage`，也不会调用模型。Tokscale 可能刷新公开 pricing cache，但 HarnessOrbit 输出不包含金额。

## 命令

```bash
node bin/harnessorbit.mjs usage \
  [--agent claude,codex,pi,opencode] \
  [--model MODEL] \
  [--today | --since YYYY-MM-DD --until YYYY-MM-DD] \
  [--run RUN_ID [--task TASK_ID]] \
  [--home HOME] \
  [--tokscale-bin PATH] \
  [--table]
```

默认输出 JSON。`--table` 输出紧凑终端表格。`--table` 与 `--json` 互斥。

支持的 agent 仅限四个 HarnessOrbit 适配器：`claude`、`codex`、`pi`、`opencode`。不传 `--agent` 时查询四者。`--agent` 可传逗号分隔列表。

日期按本地日历日过滤，边界包含当天。`--today` 选择调用方当前本地日期，不能与 `--since` 或 `--until` 合用。`--since` 与 `--until` 使用 `YYYY-MM-DD`，两端均可省略。

`--model` 是对 Tokscale 返回的 normalized model name 做精确匹配。它不是 provider 侧模型选择器，也不能从 ccSwitch 等包装器反推真实供应商或模型路由。

`--home` 指定 Tokscale 读取本地 Agent 记录的 home。HarnessOrbit 总是向 Tokscale 传显式 home，使查询保持在本地 report 路径，并避开 Tokscale 未传 home 时的 Cursor 自动同步路径；默认是当前用户 home。本文示例均使用合成路径。

## 本机报告

不传 `--run` 时，HarnessOrbit 返回所选 agent 在日期范围内的本机记录：

```bash
node bin/harnessorbit.mjs usage --agent claude,codex --since 2026-01-01 --until 2026-01-31
```

底层 Tokscale 分组是 `client,provider,model`。这些行表示本机记录，不是 HarnessOrbit 专属用量，也不是 provider 账单。没有记录不代表实际用量为零。

## Run 与 task 报告

传 `--run` 后，HarnessOrbit 尝试把 Tokscale workspace 记录匹配到 HarnessOrbit task 的工作目录：

```bash
node bin/harnessorbit.mjs usage --run demo --today
node bin/harnessorbit.mjs usage --run demo --task fix-add --table
```

run/task 报告是 workspace 范围，不是精确 task 计量。正式 JSON 字段始终是：

```json
{
  "attribution": {
    "level": "workspace",
    "exactTaskAttribution": false
  }
}
```

HarnessOrbit 当前不 join 原生 Agent session id。它只在安全时把 HarnessOrbit attempt 记录的 `cwd` 与 Tokscale `workspaceKey` 匹配。retry 复用同一 cwd/worktree 时，同一个 agent/workspace/model 行只计算一次，而不是按 attempt 次数重复计算。

覆盖规则是保守的：

- `worktree` 任务在 agent 报告同一 workspace key 时可以做 workspace 匹配。
- `checkout` 任务共享项目 checkout。HarnessOrbit 把这些观测放入 `sharedWorkspaces`，并从归属 totals 中排除。
- workspace 归属不唯一时会被排除。
- 若选中 task 覆盖不完整，`totals` 为 `null`；`matchedTotals` 只是本地观测到的部分小计。
- 子 Agent 或原生 subagent 如果在另一个 worktree 或 workspace 写入记录，可能不会出现在父任务 scoped 报告中。

Claude 还有额外边界：Claude Code 按编码后的 project 目录 key 存记录。HarnessOrbit 可以为记录过的 cwd 和 realpath 变体匹配确定性的 Claude project slug，但这仍是 workspace 证据，不是 session 证据。HarnessOrbit 不使用 basename、显示 label 或本地日期窗口做模糊归属。

## JSON 形状

成功的本机报告形状如下：

```json
{
  "schemaVersion": 1,
  "source": {
    "name": "tokscale",
    "version": "4.16.0",
    "testedVersion": "4.16.0",
    "supportedRange": ">=4.16.0 <5",
    "dataHome": "/synthetic/home",
    "counterBasis": "local-client-records",
    "costIncluded": false
  },
  "filters": {
    "agents": ["claude", "codex", "pi", "opencode"],
    "model": null,
    "since": "2026-01-01",
    "until": "2026-01-31",
    "timezone": "UTC",
    "datePrecision": "local-calendar-day"
  },
  "scope": { "type": "machine", "runId": null, "taskId": null },
  "attribution": { "level": "machine", "exactTaskAttribution": false },
  "rows": [
    {
      "agent": "codex",
      "model": "gpt-example",
      "provider": "openai",
      "input": 100,
      "output": 20,
      "cacheRead": 50,
      "cacheWrite": 0,
      "reasoning": 5,
      "totalTokens": 175,
      "messages": 1
    }
  ],
  "totals": {
    "input": 100,
    "output": 20,
    "cacheRead": 50,
    "cacheWrite": 0,
    "reasoning": 5,
    "totalTokens": 175,
    "messages": 1
  },
  "sourceWarningCount": 0
}
```

scoped run/task 报告可能增加 `coverage`、`matchedTotals`、`sharedWorkspaces` 和 `ambiguousWorkspaces`。覆盖不完整时，`totals` 为 `null`，调用方只能把 `matchedTotals` 当作已观测小计。

## Token 桶

HarnessOrbit 暴露五个 Tokscale 归一化 token 桶：

- `input`
- `output`
- `cacheRead`
- `cacheWrite`
- `reasoning`

`totalTokens` 是五个桶之和。Tokscale 4.16.0 的 `TokenBreakdown::total()` 使用相同的五桶相加语义。Tokscale 在 HarnessOrbit 读取 rows 之前已经做了 parser 级修正：Codex 会先从原始 `output_tokens` 中扣出 `reasoning_output_tokens`，再填入独立 `reasoning` 桶；Pi 会读取 reasoning 字段，但保留在 output 内并报告 `reasoning: 0`，以避免重复计算。因此 Pi 的 `reasoning: 0` 不代表模型一定没有推理。

`model` 和 `provider` 是从本地日志解析出的标签。它们适合分组，但不是权威账单证据，也不能可靠识别被其他包装器隐藏选择的上游供应商。

## Source warnings 与 diagnostics

HarnessOrbit 将 Tokscale 的 `warnings` 加上结构化 diagnostics 中 severity 为 `warning` 或 `error` 的项，汇总为 `sourceWarningCount`。Tokscale diagnostics 是来源提示，例如检测到 Claude Desktop 数据但未扫描。它不是 parser 丢弃记录计数，也不能证明实际漏用了多少 token。HarnessOrbit 不输出金额字段。

## 参考

- Tokscale 4.16 README：`models --json`、日期过滤、`--client` 与 group-by：<https://github.com/junhoyeo/tokscale/blob/v4.16.0/README.md#group-by-strategies>
- Tokscale 4.16 源码：五桶 TokenBreakdown 与 parser 归一化位于 `crates/tokscale-core/src`：<https://github.com/junhoyeo/tokscale/tree/v4.16.0/crates/tokscale-core/src>

## 协调器用量与集成测试

run/task 查询覆盖已派发 worker 的工作目录，不单独关联 Codex App 主协调会话。主协调器 token 可以出现在本机报告中，但尚不能明确归属到某个 HarnessOrbit run；结果会标记 `coordinatorAttribution: "not_tracked"`。

`npm test` 使用合成报告，不要求安装 Tokscale。安装可选 CLI 后，运行 `npm run test:tokscale`，通过真实 Tokscale 解析合成 Claude/Codex 日志，验证计数规范化及 run/task 匹配，不读取真实 Agent 日志；可用 `CAO_TOKSCALE_BIN` 指定程序路径。

CLI 默认将报告包装为 `{ "ok": true, "data": <报告> }`，文档中的报告示例对应 `data`。workspace 分组不保留 provider 维度，因此 scoped 行的 `provider` 为 `null`。本功能依据本地日志；提供商可能不记录用量，缺记录或零值记录都不能证明实际没有消耗。
