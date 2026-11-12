# 会话日志与 Agent Loop 基座：设计说明

这份文档说明会话日志（`session.jsonl`）和 agent loop 接下来往哪里收敛、按什么顺序做。改动
`packages/core/src/agent/`、`packages/core/src/session/` 的日志与上下文组装路径之前先读它。
事件格式见 [session-event-log.md](session-event-log.md)，压缩块见
[episode-context-compaction.md](episode-context-compaction.md)。

## 目的

对齐 DeepSeek Harness（下称 dsh）的三条约定，ZeRo 现在各做到一半：

1. **日志是唯一事实来源，发给模型的消息是日志的投影。** 消息历史不单独存一份，重放就是重新推导。
2. **模型看到的都落了日志（model-visible ⟺ logged）**，对每一个 loop 都成立，不只是主会话。
3. **loop 只有一份。** 主会话、子代理、记忆检索、Router 都是同一个 loop 的不同配置。

参考实现：dsh 的 `docs/architecture.md`（Turn flow、Session log 两节）和
`docs/subsystems/session.md`（`SurfaceOp`、`deriveMessages()`）。只借约定，不搬它的 Cordis 插件框架。

## 现状与差距

| 约定 | dsh 的做法 | ZeRo 现状 | 差距 |
| --- | --- | --- | --- |
| 日志是事实来源 | loop 每产生一条消息就 `session.append()`；`deriveMessages()` 返回冻结的投影 | 内存里的 `Message[]` 是事实，turn 结束时 `syncCanonical` 把它和日志做前缀 diff | 日志是镜像。turn 中途崩溃丢本 turn 消息；内存数组一被改写，diff 就产生回滚事件 |
| 投影不可变 | 冻结对象，改写历史在类型上不可表达；压缩用 `surfaceOp: replace` 落事件 | `reduceHistoricalToolOutput` 等在准备 prompt 时原地改 canonical 的 `tool_result` | 见下方「已复现的问题」 |
| 两条写路径 | 只有 `append` | 过程事件（step、tool、closure、injection）由 hooks 直接 `append`，消息事件由 `syncCanonical` 事后补 | `step/start` 的 seq 早于它发出的 `user/message` |
| 每个 loop 都落日志 | 子代理有自己的 Session | `spawn_agent` 的子代理有自己的事件文件（过程事件，暂无消息）；记忆检索、压缩模型、任务闭合、Router 的 8 个调用点都不写事件流；Router 用 `logger: console` | 这些模型调用只能从 usage 账本看到花费，看不到输入输出 |
| loop 只有一份 | `agent`（接口）与 `agent-loop`（驱动）分离，扩展点是事件 | `AgentLoop` 本身是通用的，但「能用的 agent」那一层写了三遍 | 见下方「loop 重复在哪里」 |
| 旁路日志 | 无；查询走派生索引 | `run.log`、`trace.jsonl`、`events.jsonl`、`sessions.db` 大字段与事件流并存；Web 还没读事件流 | 双写观察期未结束 |

### 已复现的问题

用 8～10 个 turn 的模拟会话复现（每个 turn 一次 2000 字符的工具输出）：

- **每个 turn 都在回滚重写。** 准备 prompt 时会给上一 turn 的 `tool_result` 原地打上
  `truncationLevel`，之后按年龄把内容截到约 200 字符。`syncCanonical` 的前缀 diff 因此判定历史变了：
  10 个 turn、40 条消息，日志里写了 122 条消息事件和 9 条 `messages/truncate`，原因全部是 `turn_failed`。
- **evidence 文件存的不是原文。** 年龄降级跑在压缩块之前，等这段历史攒够 3 个 turn 进入压缩块时，
  `evidence.ts` 落盘的已是截断后的 200 字符；压缩模型读到的也是它。3 份 evidence 里 2 份如此。

### loop 重复在哪里

`AgentLoop`（`agent-loop.ts`）只负责请求、流式、工具分发和 hooks。在它之上，下面这些事每个调用方都自己做了一遍：

| 能力 | 主会话 `Agent` + `agent-hooks.ts` | 记忆检索 `createLoopRunner` | Router `runTriggerModel` |
| --- | --- | --- | --- |
| 把工具处理函数适配成 `ToolExecutor` | 有 | 有 | 有 |
| 累计 usage | trace recorder | 手写 | 无 |
| 记录工具调用 | trace + 事件流 | 手写数组 | 回调 |
| 取最终文本 | 调用方各自取 | 手写 | 手写 |
| 超时与取消 | turn runtime | 无 | 手写 `Promise.race` |
| 步数与工具调用预算 | `maxIterations` | `maxIterations` | 手写计数 |
| 事件流与 trace | 有（约 2000 行 hooks） | 仅外层一个 span | 无 |

另外，压缩模型、任务闭合分类、会话评审是直接调 `adapter.complete()` 的单步调用，同样各自处理超时、usage 和日志。

## 目标形态

```text
              ┌────────────── SessionJournal（唯一写入口） ──────────────┐
              │ append(事实) ──► session.jsonl ──► project() ──► 只读 canonical │
              └───────────────────────────────────────────────────────────┘
                     ▲ 写                                   │ 读
                     │                                      ▼
   runAgentLoop（基座）──────────────────────── assemble（纯函数投影）
     step/tool/message 事件、usage、                 压缩块投影 → 工具输出降级 → 请求消息
     超时取消、预算、最终文本                         不改输入，输出可重算
        ▲            ▲              ▲
   主会话 Agent   记忆检索/压缩/闭合   Router 各调用点
   （基座 + 会话插件）（基座，无工具或只读工具）（基座 + 自己的错误措辞与校验）
```

三个部件各自的约定：

- **组装是纯函数。** 输入 canonical 消息和压缩块，输出本次请求的消息。不修改输入；同样的输入得到同样的输出。
  不可重算的状态变化（压缩块、artifact 替换）才落事件，沿用现有的 `compaction/block`、`compaction/prune`。
- **loop 写事实。** 消息、step、tool 事件在产生的那一刻由基座写入，顺序就是发生顺序。`syncCanonical`
  退回到只处理非 loop 的修改（回滚、撤回、恢复期修复），并写对原因。
- **基座只有一份。** 调用方提供模型、提示词、工具和策略；基座负责其余。主会话特有的东西（排队消息、任务闭合、
  记忆提醒、压缩）以 hooks 组合进来，不再堆在一个文件里。

## 分步计划

每一步做完系统都能用，可以单独合并、单独回退。

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 组装改为纯函数投影：准备 prompt 不再修改 canonical 消息；evidence 和压缩模型读原文 | 本 PR |
| 2 | loop 基座 `runAgentLoop`；记忆检索和 Router 改为基座的配置 | 本 PR |
| 3 | 主会话的 loop 直接写消息事件，取代 turn 结束时的 diff；`syncCanonical` 只留给非 loop 修改 | 后续 |
| 4 | 旁路 loop（记忆检索、压缩、闭合、Router）落事件流 | 后续，见待定事项 |
| 5 | 删除旧式 `compressConversation` 和切换模型时对 canonical 的覆盖；预算改为按压缩后的投影判断 | 后续 |
| 6 | 主会话 `Agent` 改为「基座 + 会话插件」，拆分 `agent-hooks.ts` | 后续 |
| 7 | Web 读事件流；切 `file-only`；`run.log` 与 trace 里与事件流重复的部分退役 | 后续 |

### 步骤 1：组装改为纯函数投影

- `reduceHistoricalToolOutput`、`reduceToolOutputsUnderPromptPressure` 改为返回新对象，不给输入的 block 赋值。
  降级结果只进入发给模型的消息。
- 降级规则不变（0–3 turn 完整、4–8 摘要、9+ 状态；prompt 压力下按最近若干条保留），所以发给模型的内容
  与现在一致。差别只在两处：状态级的 `retained_handles` 改从原文提取（现在是从已截断的摘要里提取）；
  prompt 压力解除后，受影响的工具输出会回到按年龄计算的等级。后者只发生在压缩块新建或回滚之后，
  那时 prompt 前缀本来就变了，不额外损失缓存命中。
- 已经被旧版本改写过的历史消息（带 `truncationLevel` 且内容已截断）原文无法恢复，按现有等级继续使用，不再升级回完整。
- 带来的结果：canonical 保留原文；evidence 和压缩模型拿到原文；事件流不再每个 turn 回滚重写。
- 代价：内存和 `sessions.db`（双写期）里的旧工具输出不再随年龄变小。单条上限仍是 64KB（更大的在执行时已转 artifact）。

### 步骤 2：loop 基座

在 `packages/core/src/agent/` 新增 `runAgentLoop`，包在 `AgentLoop` 之上，负责上表里除「事件流与 trace」外的各项：
工具适配、usage 累计、工具调用记录、最终文本、超时与取消、步数与工具调用预算。超时、取消、超预算以带原因的
类型化错误抛出，调用方决定怎么对用户表述。

- 记忆检索的 `createLoopRunner` 保留导出，内部改为调用基座。
- Router 的 `runTriggerModel` 保留签名和全部对外行为（错误措辞、工具调用校验、未知工具的诊断替换、
  「没有工具时拒绝工具请求」），只把通用部分交给基座。`docs/router-design.md` 的取舍原则不受影响：
  授权和能力边界仍在 Router 自己的代码里。
- 主会话 `Agent` 这一步不动，步骤 6 再迁。

事件流与 trace 不在这一步进基座：主会话的事件载荷依赖 tracer 的 span 编号，直接搬动会改变现有事件；
旁路 loop 落事件流又涉及下面的待定事项。基座先把接口留好，步骤 3、4 接上。

## 待定事项

需要先定下来才能做步骤 4：

- **旁路 loop 的事件放在哪里。** 记忆检索、压缩、闭合属于某个会话的某个 turn，适合写进父会话目录下的
  `sub-<id>.jsonl`（`spawn_agent` 的子代理已经这样做）。Router 的调用没有父会话：分诊每个事件一次调用，
  派工、对话各有自己的编号。每次调用一个文件会产生大量小文件，需要决定按什么归并（按任务、按天、按派工）以及保留多久。
- **Router 事件流里放什么。** 事件正文、仓库内容都是外部资料，落盘前要过 `secretFilter`；是否保存全文还是只存
  hash 与预览，取决于排障时到底要看什么。

## 怎么判断有没有变好

- 事件流里 `messages/truncate` 只在真实回滚、撤回、恢复修复时出现；每条 canonical 消息只对应一条消息事件。
- evidence 文件的字符数与工具原始输出一致。
- 新增一个需要多步工具调用的模型调用点时，不需要再写工具适配、超时、预算和取文本的代码。
- `agent-hooks.ts` 不再同时出现排队、闭合、记忆、压缩、trace 五类逻辑（步骤 6 之后）。
