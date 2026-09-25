# 本机资源发现与隔离校准

> English: [../resources.md](../resources.md)

资源发现识别本机 Claude Code、Codex、Pi、OpenCode 及已有 HarnessOrbit profiles，读取经过筛选的配置字段，并区分认证线索与真实调用成功。它不安装工具、不更换原生默认配置、不自动导入 profile，也不刷新 OAuth token。

```bash
node bin/harnessorbit.mjs resources list
node bin/harnessorbit.mjs resources check --agent claude,pi
```

`list` 读取配置并复用匹配的版本观测；`check` 额外执行有限时的原生版本/登录状态命令，将脱敏清单保存到 HarnessOrbit 状态目录。每个命令最多两秒，进程探测总预算五秒。无法确认的信息保持未知。

先检查 PATH，再检查常见安装目录与有数量限制的 NVM Node 版本目录。结果包含执行文件及发现来源。Herdr 自己的 pane 在启动前恢复已发现可执行文件的目录，包括从 PATH 发现的安装，防止登录 shell 意外选中旧版本；不修改 shell 启动文件。

## 清单字段

- `installed`：找到可执行文件，不代表登录可用。
- `configured`：发现模型配置或凭据线索，不代表成功调用。
- `authentication`：原生状态或可识别凭据形状的证据，不包含密钥和邮箱。
- `callVerification`：同一配置指纹的校准或独立验收后的任务交付证据，或 unknown/stale/unavailable；通过 `source` 区分来源。
- `requestedModel` 与 `observedModel`：声明模型和实际观测模型分开，不能假定代理或别名的真实后端。
- `quota`：profile 声明的额度线索及新鲜度；无法读取的原生套餐余额保持未知。
- `quotaGroup`：已知账号或保守的分组；相同 endpoint 不能证明是同一个账号。

Pi 当前选中的内置 provider 与同步到 `models.json` 的 provider 是不同候选。即使模型都叫 `k3`，凭据和 endpoint 也可能不同，清单不会将它们合并。JSON 读取有大小限制；复杂 Codex TOML、自定义命令和扩展能力不作推测。

## 读取 CC Switch 的 Pi 配置

```bash
node bin/harnessorbit.mjs source discover
node bin/harnessorbit.mjs profile import-cc-switch --provider PROVIDER_ID --app pi --id my-pi --model MODEL_ID
```

请使用发现结果里的实际 ID。支持 schema-18 下 API 协议已知、模型目录明确、使用字面 API key 的 Pi provider，导入后只保存引用，密钥留在 CC Switch，执行前检查来源变化。命令型/插值型 key 与 OAuth 记录不会被转换成直接凭据。

目录中有上下文和输出限制时一并导入。受管 profile 也可显式填写 `modelMetadata: {"contextWindow": 1000000, "maxOutputTokens": 128000}`；缺失时沿用原有兼容值，并在执行 manifest 标明来源。Pi 协议要求的数值价格占位不代表免费或真实账单。

## 显式校准

外部原生任务可以在不运行隔离探针的情况下建立就绪证据。HarnessOrbit 在启动前保存配置指纹，只有任务已确认发送、worker 和子代理已结束、收集快照通过独立检查、当前配置仍匹配时，才写入 `source: verified-task`。这说明该配置完成过功能交付，不代表另外观察到 provider 请求或实际服务模型身份。

任务证据在验收后 15 分钟过期，重复读取不会刷新时效；较新的失败校准会覆盖更早的成功交付证据。当前 Codex host、mock 运行、仅报告未验收、检查失败或子代理状态未知都不能建立就绪证据。带自定义 CLI 参数或已知项目配置/上下文标记的传统原生任务，以及可能使用网关 fallback 的传统 managed profile，暂不回流，避免把未固定的实际配置归属给默认配置。项目检查只判断项目及尝试工作目录内有限的已知路径是否存在，不扫描 HOME 或读取凭据。自适应尝试已有固定候选绑定。

这为原生 OAuth 登录会话提供了后续进入自适应选择的路径：先按正常 delegated 流程，使用已配置默认值、无 CLI 覆盖参数完成一个真实任务并独立验收。HarnessOrbit 只观察结果，不导出或转换登录凭据。没有此类证据的冷启动 OAuth 候选，仍不能通过仅支持 API 认证的隔离校准器主动探测。

从 `resources list` 选择具体资源 ID：

```bash
node bin/harnessorbit.mjs calibrate --resource RESOURCE_ID --quick
node bin/harnessorbit.mjs calibrate --resource RESOURCE_ID --suite code --timeout-ms 60000 --budget-ms 90000
node bin/harnessorbit.mjs calibration list --resource RESOURCE_ID
```

缓存未命中时会产生真实提供商调用；启用 HarnessOrbit mode 不会自动测速。一次最多两个候选。quick 每个候选最多 30 秒、总预算最多 60 秒；code 有单独的可配置上限。校准在本机串行执行，已知 profile 容量与正常 HarnessOrbit attempts 共用。

当前校准适配器支持有明确 API 认证的 Claude、Pi 原生配置或受支持的 HarnessOrbit profile，不复制 OAuth 凭据。无法隔离认证的候选显示 unavailable，不等于它的正常原生会话不能使用。

每次使用全新临时配置与会话目录，关闭会话持久化、用户扩展、技能和项目上下文发现。quick 在关闭工具后检查随机生成的精确回应；code 修复一个小文件，并在不含提供商凭据的进程中运行独立检查器。受管进程停止后删除临时配置、会话和夹具。原生文件工具及检查仍在本机执行；这属于配置/工作区隔离，不是通用 OS 沙箱。

这是隔离 print 模式的探针，不是用户完整 Herdr 交互工作流的性能评测。关闭自定义能力改变了执行环境，一次结果不能推广成整体代码能力或提速承诺。

## 指标、缓存与失败

持久记录只含脱敏元数据、检查结果、状态和可为空的指标，不保存 prompt、回答和密钥。校准记录的 `observedAt`/`expiresAt` 是 Unix 毫秒。

- `firstEventMs`：从探针开始到首个文本增量，包含初始化，不是纯思考时间。
- `outputTokens`：原生报告的输出用量，按提供商定义可能包含推理；无法获取时为 null。
- quick 的 `tokensPerSecond`：报告的输出 token 除以探针总墙钟秒数，是端到端吞吐，不是纯文本生成速度；code 不计算此速率。
- 回应完整但答案错误才判检查失败。认证、额度/限流、传输失败属于不可用证据，不是模型质量分数。

缓存绑定资源配置指纹、测试版本、平台/运行时和隔离配置。quick 最多 15 分钟，code 最多七天；不可用和超时结果仅短暂冷却。`--refresh` 显式重复调用。mock 记录不会作为真实有效缓存；版本或配置改变后相关证据失效。

控制器被强制杀死且未清理时，会保留校准容量声明，不能假定 child 已停止。查看 `route reservations`，确认相关进程已停止后，只释放对应校准声明：

```bash
node bin/harnessorbit.mjs calibration release --reservation RESERVATION_ID --confirm-stopped
```

它不能释放普通任务的 reservation。正常中断和超时会等待 child 终止后自动释放。

资源和校准命令已可独立使用；[任务交接与 shadow 调度](shadow-routing.md) 可根据证据给出建议，[host 工作流](host-work.md) 支持用户明确选择当前 Codex 执行。[自适应派发](adaptive-dispatch.md) 已支持显式启用后将候选绑定到实际尝试。更新默认工作流仍需真实配对评估；已有对话未显式修改时继续使用 delegated。
