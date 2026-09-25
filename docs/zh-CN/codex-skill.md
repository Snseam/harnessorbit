# Codex 的 HarnessOrbit 技能

> English: [../codex-skill.md](../codex-skill.md)

把 [README 的安装指令](../../README.zh-CN.md#在-codex-对话中直接开始)复制给 Codex，即可安装。随后在需要的任意新的或已有的本地对话中启用 **HarnessOrbit**。

安装粘贴按顺序 stat 四条精确路径（handoff wrapper、已设置时的 `$CODEX_HOME/skills/cao`、`~/.codex/skills/cao`、`~/.agents/skills/cao`），不列出父目录，也不遍历 `~/.codex/sessions`。启用后从已加载的技能目录加 `--paths` 定位 HarnessOrbit；不要把这些安装路径当作 SKILL 的 locate 目标。

## 安装一次

```bash
node /path/to/harnessorbit/bin/harnessorbit.mjs skill install
node /path/to/harnessorbit/bin/harnessorbit.mjs skill status
```

默认安装到 `$CODEX_HOME/skills/cao`；未设置 `CODEX_HOME` 时是 `~/.codex/skills/cao`。当前 Codex runtime 可以发现这个用户目录。使用新版共享技能目录的客户端也可显式指定：

```bash
node /path/to/harnessorbit/bin/harnessorbit.mjs skill install --skills-dir ~/.agents/skills
```

选择一个位置即可，避免重复安装同名技能。Codex 支持链接形式的技能目录；安装器链接到仓库的 `skills/cao`，因此要保留该仓库。对同一来源重复安装不会重复创建。已有真实文件/目录或指向其他来源的链接会被保留并报告冲突；来源缺失或技能包不完整会报错。

技能中的 CLI 包装脚本会解析仓库的实际位置，支持空格和中文路径，并保留目标项目的工作目录。登记技能不需要全局 `cao` 命令，也不需要修改提供商、`AGENTS.md` 或安装额外包依赖。

## 在新旧对话中调用

- **Codex App：**输入 `/HarnessOrbit`，选择 **HarnessOrbit** 候选，再发送插入的技能引用。当前桌面端对显示名的匹配不区分大小写。
- **Codex CLI：**发送 `$cao`，或通过 `/skills` 选择 HarnessOrbit。
- **其它客户端：**使用客户端自己的技能选择器；未经选择的裸 `/HarnessOrbit` 不是所有 Codex 界面通用的命令。

技能内部名称为 `cao`，显示名为 `HarnessOrbit`。旧对话若缓存了技能目录，可以刷新技能列表（当前桌面端提供 **Force reload skills**）、重新打开对话，必要时重启客户端；并非必须新建对话。官方[技能文档](https://learn.chatgpt.com/docs/build-skills)说明了发现、链接目录、`$` 调用和刷新行为；[CLI 命令文档](https://learn.chatgpt.com/docs/developer-commands?surface=cli)说明了 `/skills`。

只调用技能、不提供开发任务时，会保存偏好并检查就绪情况，不启动 worker 或创建初始 Git 提交。安装只是让技能可用，不会自动启用任何对话。

## “默认使用”如何生效

技能要求 Codex 在当前对话后续的开发任务中继续使用 HarnessOrbit，直到你关闭或提出单次例外。Codex 在交接摘要中保留模式、CLI/状态/项目路径和活动 run/task ID，继续工作时读取保存的模式。普通问答和方案讨论仍直接回答。

偏好保存在 HarnessOrbit 状态目录的 `conversations/<thread-id>/mode.json`。身份优先取显式 `--thread`，其次是 `CODEX_THREAD_ID`、`CODEX_SESSION_ID`。如果客户端没有提供原生身份，技能可以为这个对话生成一个 UUID，保存在交接摘要中并在后续命令显式传入；不能拿项目路径当作对话身份。

同一项目里的两个对话可以各有偏好。再次启用时保留已保存的设置，只有明确指定的选项才更新。初始默认最多 2 个外部会话，每项任务最多尝试 3 次；Agent/profile/项目可以暂时未指定，待实际任务明确后选择。

这是由技能指令驱动、带持久偏好记录的工作方式，不是修改 Codex 全局默认值、强制每次模型决策的 hook，也不是后台调度器。上下文若完全丢失，应重新调用 HarnessOrbit；续接已有任务时提供原状态目录和 run ID。

## 手动查看或修改

```bash
node bin/harnessorbit.mjs mode enable --thread THREAD_ID --project /path/to/project
node bin/harnessorbit.mjs mode enable --thread THREAD_ID --agent claude --max-parallel 4 --max-attempts 3
node bin/harnessorbit.mjs mode status --thread THREAD_ID
node bin/harnessorbit.mjs mode disable --thread THREAD_ID
```

`--profile ID` 设置执行配置偏好，`--profile ""` 清除它。用 `--state-dir PATH` 指定已有的、位于目标项目之外的共享 HarnessOrbit 状态目录。模式命令只修改偏好，不分发任务、不取消 worker、不更改 profile 或提供商；关闭默认方式时，应根据你的请求处理已经运行的任务。

## 更新或卸载

按正常 Git 流程更新干净的 HarnessOrbit 仓库，链接技能随来源更新。技能元数据改变后可刷新客户端目录。仓库搬家后，`skill status` 会报告安装断链或不可用；先处理旧链接，再安装新仓库。安装器不会覆盖其它来源的链接或你的技能定制。

```bash
node /path/to/harnessorbit/bin/harnessorbit.mjs skill uninstall
```

如果安装时指定了 `--skills-dir`，卸载时也指定相同目录。只移除指向当前仓库的安装链接，保留来源、模式记录、run 和其它技能；不会自动关闭已载入某个对话的工作偏好。请在该对话要求停用，或对其身份执行 `mode disable`。
