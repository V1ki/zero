# ZeRo 系统提示词

## 来源与职责

`packages/core/src/agent/prompt.ts` 构造主 agent 和子 agent 的静态提示词。
仓库根目录的 `AGENTS.md` 是开发约定，不会被 ZeRo 的 bootstrap loader 自动注入。

- `execution_mode`：任务范围、已有授权的延续、阻塞和完成条件。分析请求不自动实施建议；已授权操作不因工具切换或阶段汇报再次确认。
- `safety` / `constraints`：安全边界、密钥保护、代码验证和运维命令约束。授权不允许泄露密钥或绕过安全保障。
- `rules`：错误诊断、语言和运行时提示处理。
- `tool_call_style`：复杂任务开始、重要发现、方向变化和风险操作时说明；常规低风险调用不逐条播报。
- `memory_policy`：集中定义静态提示词中的主动保存规则，保留分类、先搜索再更新及临时信息排除要求，服从用户明确的记忆限制。运行时原有的 memory nudge 提醒机制保持不变。
- `tool_rules`：按可用工具注入实际协议，包括密钥引用、后台工具事件、子 agent ID 和图像能力。
- `output_style` / `runtime`：当前 channel 的交付方式和能力。
- `identity` / `project_context`：身份偏好与工作区资料；历史信息不能替代当前用户要求或真实运行状态。

`full` 模式包含完整主流程规则。`minimal` 模式也包含 execution、safety 和 constraints，保留所需工具协议；子 agent 仅继承委派任务中明确传入的授权。
`none` 模式保持原有兼容行为，仅生成身份行，不提供这些规则。

## SOUL 和工作区覆盖

默认模板位于 `packages/core/src/bootstrap/templates.ts`。`full` 模式从
`.zero/workspace/<agentName>/` 加载 `SOUL.md`、`USER.md`、`TOOLS.md`；文件不存在时使用默认模板。
`minimal` 模式的 loader 只保留 `TOOLS.md`；调用方仍须显式传入 bootstrap 内容。

SOUL 仅定义人格和语气，不授予权限，也不管理记忆或授权 agent 自行修改提示词。
修改 SOUL 需要用户明确要求。修改默认模板不会覆盖磁盘上的自定义文件；已有工作区应单独核对，保留定制内容。

## 任务收尾

`packages/core/src/agent/task-closure.ts` 的判定器按用户要求和剩余必要工作决定：

- `finish`：当前要求已经满足。普通解释、摘要或局部分析，不因单一来源或首次总结而自动继续。
- `continue`：还有完成当前要求所必需、且可以继续取得的证据或执行动作。深入研究和多源核验仅按用户要求的范围检查。
- `block`：下一动作超出授权，或缺少无法自行解决的必要信息、凭据、登录态或决策。

成功工具记录只证明对应操作，不代表其他交付要求也已完成。分析结果和建议不构成实施授权。
通知 agent 继续时，同样遵循已有授权和分析边界。

后台任务保留原有协议：收到 `background_tool.started` 后，若后续依赖结果，结束当前轮等待系统的 `background_tool.completed`，不通过进程或文件轮询，也不把后台 task ID 传给 `wait_agent`。
此时判定器的 `finish` 仅表示合法等待，不代表整个用户任务已完成。无成功证据时，不得宣称后台产物已完成、验证或发布。

## 生效与验证

静态提示词由 session 缓存；修改源码或工作区文件不会立即替换正在使用的缓存。
源码变更需要由加载新代码的 ZeRo 进程执行；新 session 或静态上下文重新构建后才使用新提示词。
不要仅凭文件修改成功就认定已有会话已切换。重启操作按 `docs/zero-cli.md` 执行。

相关验证：

```sh
bun run check
bun test packages/core/src/agent/__tests__/prompt.test.ts packages/core/src/agent/__tests__/task-closure.test.ts packages/core/src/bootstrap/__tests__/loader.test.ts
bun test packages/core/src/agent/__tests__/completion-gate.test.ts packages/core/src/tool/__tests__/spawn-agent.test.ts packages/core/src/session/__tests__/background-tool-tasks.test.ts
```

这些检查验证提示词构造、关键约束和运行流程，不证明真实模型在所有场景下的行为。
模型对照验收应覆盖：已授权配置修改、只分析不修改、普通单来源解释、明确的多源研究、后台等待与恢复，以及缺少真实授权时停止。

可重复的新旧提示词对照已提供 `bun run prompt:bench`，用法、冻结快照和结果判读见 [提示词 benchmark](prompt-benchmark.md)。
