# 会话日志与 Agent Loop 基座：设计说明

这份文档说明会话日志（`session.jsonl`）和 agent loop 接下来往哪里收敛、按什么顺序做。改动
`packages/core/src/agent/`、`packages/core/src/session/` 的日志与上下文组装路径之前先读它。
事件格式见 [session-event-log.md](session-event-log.md)，上下文压缩见
[context-compaction.md](context-compaction.md)。

## 目的

对齐 DeepSeek Harness（下称 dsh）的三条约定，ZeRo 现在各做到一半：

1. **日志是唯一事实来源，发给模型的消息是日志的投影。** 消息历史不单独存一份，重放就是重新推导。
2. **模型看到的都落了日志（model-visible ⟺ logged）**，对每一个 loop 都成立，不只是主会话。
3. **loop 只有一份。** 主会话、子代理、记忆检索、Router 都是同一个基座的不同组装：写日志在基座里，
   其余功能作为模块传入。

参考实现：dsh 的 `docs/architecture.md`（Turn flow、Session log 两节）和
`docs/subsystems/session.md`（`SurfaceOp`、`deriveMessages()`）。只借约定，不搬它的 Cordis 插件框架：
dsh 把功能拆成插件，ZeRo 用调用处传入的模块，见「目标形态」。

## 现状与差距

| 约定 | dsh 的做法 | ZeRo 现状 | 差距 |
| --- | --- | --- | --- |
| 日志是事实来源 | loop 每产生一条消息就 `session.append()`；`deriveMessages()` 返回冻结的投影 | loop 每产生一条消息就 `appendMessage`（步骤 3）；内存里的 `Message[]` 仍由 `Session` 持有，turn 结束时 `syncCanonical` 只对账 | 恢复从 `projectForRestore` 重建内存状态，不改写 canonical（[session-log-replay.md](session-log-replay.md) 步骤 4、5）；改动已有消息要当场声明原因 |
| 投影不可变 | 冻结对象，改写历史在类型上不可表达；压缩用 `surfaceOp: replace` 落事件 | 请求消息由 `prepareRequestMessages(canonical, 检查点)` 投影得到，不修改 canonical（步骤 1、5） | 已对齐；修复前的问题见下方「已复现的问题」 |
| 两条写路径 | 只有 `append` | 过程事件和消息事件都由 loop 在发生时写入（步骤 3、4a） | 已对齐 |
| 每个 loop 都落日志 | 子代理有自己的 Session | `spawn_agent` 的子代理、记忆检索（步骤 4b）和 Router 的 8 个调用点（步骤 4c）有自己的事件文件（过程事件和消息）；压缩模型、任务闭合不写事件流 | 压缩模型和任务闭合只能从 usage 账本看到花费，看不到输入输出 |
| loop 只有一份 | `agent`（接口）与 `agent-loop`（驱动）分离，扩展点是事件 | `AgentLoop` 本身是通用的，但「能用的 agent」那一层写了三遍 | 见下方「loop 重复在哪里」 |
| 旁路日志 | 无；查询走派生索引 | `run.log`、`trace.jsonl`、`events.jsonl`、`sessions.db` 大字段与事件流并存；Web 还没读事件流 | 双写观察期未结束 |

### 已复现的问题

步骤 1 之前，用 8～10 个 turn 的模拟会话复现（每个 turn 一次 2000 字符的工具输出）。两个问题都已由步骤 1 修复，
相关代码随步骤 5 删除：

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

步骤 2 之后，上表除最后一行外已由基座承担。剩下的重复都出在最后一行。

### 日志写在哪一层

| 层 | 代码 | 谁在用 | 写事件流 |
| --- | --- | --- | --- |
| loop | `AgentLoop`（`agent-loop.ts`） | 所有调用方 | 步骤 4a 起：给了事件句柄就写 step、tool、消息事件 |
| 基座 | `runAgentLoop`（`agent-run.ts`） | 记忆检索、Router | 步骤 4a 起：给了事件句柄就写 `system/prompt`、`tools/set`、`loop/start`；4c 起在 `loop/start` 之前写传入的历史 |
| 会话 Agent | `Agent` + `agent-hooks.ts` | 主会话、`spawn_agent` 子代理 | 注入、压缩、闭合、记忆等会话特有的事件 |

步骤 4a 之前，`step/start`、`requestHash`、`tool/call`、消息事件的写入都在第三层，和排队、任务闭合、记忆提醒、压缩
写在同一批 hooks 里。「日志可重放」因此只对用 `Agent` 的调用成立，接在基座上的调用方什么都没继承到。记忆检索（步骤 4b）
和 Router（步骤 4c）现在都传事件句柄。

`AgentLoopHooks` 的每个扩展点只能放一个函数。主会话的几项功能要共用同一批扩展点，只能在 `createAgentLoopHooks`
里手工拼在一起，功能之间还直接引用对方（排队会打断记忆提醒，工具 hook 要通知记忆「写入成功」）。缺的不是扩展点，
是「多个功能怎么合到一个扩展点」的规则。

Router 和 Codex Worker 因为接不上第三层，各自又做了一份：

- **工具。** Router 的工具是手写的定义加执行表（`router-loop-tools.ts`，调查和派工执行器里各有一份内联的），
  没有工具调用的过程事件。
- **历史。** Router 对话有自己的 turn 存储（`trigger-conversation-store.ts`）。发给模型的历史每轮从业务表现拼，
  只取最近 8 轮的文字；业务表的正文还会被保留期清掉。
- **Worker。** 派工队列经 `runRouterJob`（`packages/core/src/tool/worker.ts`）直接进 `runCodexWorker`：自造
  `ToolContext`、固定的 `toolUseId`、`warn` 和 `error` 置空的 logger，绕过 `BaseTool.run` 和 Agent 的工具 hooks，
  也不接 `onPublicEvent`，Codex 的中间过程不留记录。

## 目标形态

```text
              ┌────────────── SessionJournal（唯一写入口） ──────────────┐
              │ append(事实) ──► session.jsonl ──► project() ──► 只读 canonical │
              └───────────────────────────────────────────────────────────┘
                     ▲ 写                                   │ 读
                     │                                      ▼
   runAgentLoop（基座）──────────────────────── assemble（纯函数投影）
     step/tool/message 事件、usage、                 检查点投影（摘要 + 裁剪）→ 请求消息
     超时取消、预算、最终文本                         不改输入，输出可重算
        ▲            ▲              ▲
   主会话 Agent   记忆检索/压缩/闭合   Router 各调用点
   （基座 + 会话模块）（基座，无工具或只读工具）（基座 + 自己的错误措辞与校验）
```

三个部件各自的约定：

- **组装是纯函数。** 输入 canonical 消息和检查点，输出本次请求的消息。不修改输入；同样的输入得到同样的输出。
  不可重算的状态变化（检查点、artifact 替换）才落事件：`compaction/checkpoint`、`compaction/prune`。
- **loop 写事实。** 消息、step、tool 事件在产生的那一刻由基座写入，顺序就是发生顺序。`syncCanonical`
  退回到只处理非 loop 的修改（回滚、撤回、恢复时封口没封口的 turn），并写对原因。
- **基座只有一份。** 调用方提供模型、工具和模块；基座负责其余。主会话特有的东西（排队消息、任务闭合、
  记忆提醒、压缩）作为模块传入，不再堆在一个文件里。

### 基座与模块

基座固定做四件事，调用方关不掉：跑 loop、写事件流、累计 usage、管超时取消和预算。

其余功能是模块。模块是普通的值，由调用方在调用处按数组传入：系统提示词、记忆、压缩、排队、任务闭合，
以及 Router 自己的校验和错误措辞。没有注册表、服务发现和生命周期，一次组装在一处就能读完。ZeRo 的组装只有下面
几种，都是静态的，用不上 dsh 插件框架提供的动态装卸。

| 组装 | 模块 |
| --- | --- |
| 主会话 | 系统提示词、记忆、压缩、排队、任务闭合、trace |
| `spawn_agent` 子代理 | 系统提示词、压缩、trace |
| 记忆检索 | 无，只有工具 |
| Router 各调用点 | Router 的校验与错误措辞，按需加 Router 工具 |

三条约束，先于任何模块接口：

- **写日志在基座里，不是模块。** 做成可选模块，没装的调用方就没有日志，回到现在的局面。
- **模块不直接改请求。** 只在请求里出现的内容（记忆注入、动态上下文、图片委托、排队拼接）经基座提供的入口加入，
  由基座落 `injection/context` 或 `request/message`。系统提示词同理：模块交片段，基座拼接并记 `system/prompt`。
  「模型看到的都落了日志」由结构保证，不靠每个模块自觉。
- **同一扩展点的合并规则固定。** 只观察的，全部调用；改写内容的，按数组顺序串联；做决定的（一轮结束后是否继续、
  空响应怎么办），按数组顺序取第一个非默认答案。闭合、记忆提醒、排队在 `onEndTurn` 里的先后现在隐含在代码里，
  之后就是数组顺序。

模块之间不互相持有。一个模块需要知道别的模块做了什么时，观察基座发出的事实（某个工具调用结束了、有消息排队了），
不引用对方。做不到这一条，拆出来的只是几个互相 import 的小文件。

模块接口不预先设计：从 `agent-hooks.ts` 一次搬出一项功能，接口长成这些功能实际需要的样子（步骤 6）。

### Router 与 Codex Worker 的边界

- **业务表留着。** 路由记录、投递、派工步骤、Router 对话承担认领、去重、授权和保留期，不并进事件流。业务表存结论和
  一个指向事件文件的会话编号，过程在事件流里。
- **请求输入要落全。** Router 的历史不是日志的投影，是每轮从业务表拼出来的。基座在 loop 开始时把传入的历史写进
  事件流，否则业务表的正文到期清除后请求还原不出。
- **工具不必改写。** 工具调用的过程事件由基座写，Router 手写的工具作为模块提供的工具传入即可。
- **Codex Worker 不是 loop，不做成模块。** 派工队列直接调用它。它在这项派工的事件文件里记成一次工具调用，
  用的是基座写 `tool/call`、`tool/result` 的同一段代码。

## 分步计划

每一步做完系统都能用，可以单独合并、单独回退。

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 组装改为纯函数投影：准备 prompt 不再修改 canonical 消息；evidence 和压缩模型读原文 | 已完成 |
| 2 | loop 基座 `runAgentLoop`；记忆检索和 Router 改为基座的配置 | 已完成 |
| 3 | 主会话的 loop 直接写消息事件，取代 turn 结束时的 diff；`syncCanonical` 只留给非 loop 修改 | 已完成：即 [session-log-replay.md](session-log-replay.md) 的步骤 1，子代理一并写消息；非 loop 修改经 `syncMessages` 声明原因，`syncCanonical` 只对账 |
| 4 | 基座写事件流；记忆检索、Router、Codex Worker 依次接入 | 已完成，见下 |
| 5 | 删除旧式 `compressConversation` 和切换模型时对 canonical 的覆盖；预算改为按压缩后的投影判断 | 已完成：[检查点压缩](context-compaction.md)是唯一的压缩机制，旧代码已删除 |
| 6 | 主会话 `Agent` 改为「基座 + 模块」，从 `agent-hooks.ts` 一次搬出一项功能 | 6.1～6.4 已完成；6.5 见下 |
| 7 | Web 读事件流；切 `file-only`；`run.log` 与 trace 里与事件流重复的部分退役 | 后续 |

### 步骤 1：组装改为纯函数投影

下面是步骤 1 当时的做法。按年龄的降级和 prompt 压力降级已在步骤 5 随旧方案删除，现行规则见
[context-compaction.md](context-compaction.md)。

- `reduceHistoricalToolOutput`、`reduceToolOutputsUnderPromptPressure` 改为返回新对象，不给输入的 block 赋值。
  降级结果只进入发给模型的消息。
- 降级规则不变（0–3 turn 完整、4–8 摘要、9+ 状态；prompt 压力下按最近若干条保留），所以发给模型的内容
  与现在一致。差别只在两处：状态级的 `retained_handles` 改从原文提取（现在是从已截断的摘要里提取）；
  prompt 压力解除后，受影响的工具输出会回到按年龄计算的等级。后者只发生在压缩块新建或回滚之后，
  那时 prompt 前缀本来就变了，不额外损失缓存命中。
- 已经被旧版本改写过的历史消息（内容已截断）原文无法恢复，按截断后的内容继续使用。
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
旁路 loop 落事件流又涉及当时的待定事项（现见「已定事项」）。基座先把接口留好，步骤 3、4 接上。

### 步骤 4：基座写事件流

分四步，每一步单独合并。4a、4b 不依赖「已定事项」里的三项。

- **4a 基座接事件流（已完成）。** 写事件落在两层，入口是同一个 `AgentLoopJournal`：
  - `AgentLoop` 写 `step/start`（含 `requestHash`）、`step/end`、`tool/call`、`tool/result` 和消息事件。主会话和
    `runAgentLoop` 都经过它，所以这几类事件只有一份实现，`agent-hooks.ts` 里的对应代码已删除。
  - `runAgentLoop` 在 loop 之前写 `system/prompt`、`tools/set`、`loop/start`。主会话的系统提示词和工具集仍由 `Session` 在变化时写；`loop/start` 在 6.3 起也由基座写（`historyLogged`）。
  - 主会话特有的三样东西经 `AgentLoopJournal` 的回调交给 loop：请求和工具的 span 编号（trace 一侧提供，没有 tracer
    的调用方不带）、「此刻的消息只进请求」（记忆提醒阶段，写成 `request/message`）。
  - `step/end` 写在 `onCompletionEnd` hook 之前：调用方的策略拒绝这次响应（Router 的输出上限、无效工具调用）时，
    这次请求仍有记录。
  - 事件句柄指向的文件，canonical 消息必须正好等于传入的 `history`；没有历史的一次运行用新文件。4c 改为由基座写历史，见下。
  - 验收：主会话在同一脚本下改动前后的事件流逐条相同（类型、顺序、载荷，除随机编号和时间）；`request-replay.test.ts`
    的三方比对不变；`agent-run.test.ts` 对 `runAgentLoop` 做同样的三方比对。句柄目前可缺省，全部调用方接入后改为必填。
- **4b 记忆检索接入（已完成）。** 它属于父会话的某个 turn，写父会话目录下的 `sub-<id>.jsonl`，与 `spawn_agent` 的子代理
  相同。它现在写进父会话的 `memory/retrieval/start|end` 保留。
  - `createLoopRunner` 每次调用（即每次 `runAgentLoop`）经 `SessionEventStore.openRun` 新建一份 `sub-memory_<uuid>.jsonl`（header 的
    `name` 为 `memory_retrieval`，`role` 为 layer），并在父会话的 `memory/retrieval/start` 与 `end` 之间记一条
    `subagent/spawn`（同样的 `name`、`role` 与 `logFile`），父会话由它找到子文件。
  - 消息里的 `sessionId`、usage 账本和 trace 仍用父会话编号，只有事件写进子文件，与 `spawn_agent` 的子代理一致。
    `spawn_agent` 子代理里的 layer2 检索，子文件同样放在主会话目录，`subagent/spawn` 写在子代理自己的文件里。
  - `openRun` 返回一个写入句柄，文件的状态只在句柄里：不进 `subagent-index.json`，store 也不按编号缓存它。这类文件每个 turn、
    每次 Router 调用都会新建一份，进索引会让索引一直变大（索引每次注册整体重写）。读它按 `subagent/spawn.logFile` 的路径读。
    运行超时或取消后才到的响应和工具结果仍经句柄写入。
  - 验收：主会话在同一脚本下改动前后的事件流逐条相同；`memory-retrieval.test.ts` 对子文件的每个 `step/start` 做三方比对。
- **4c Router 接入（已完成）。** 8 个调用点传入事件句柄，`logger: console` 换成与主会话相同的 logger。传入的历史在 loop
  开始时写成消息事件。每类调用带自己的 usage 用途（`USAGE_PURPOSES` 增项），不再都记成 `agent_loop`。业务表里的会话编号
  指向事件文件。实际落点：
  - 8 个调用点都经 `runTriggerModel`，它是唯一传事件句柄的地方：每次调用经 `openRun` 新建
    `sessions/router-<本地日期>/sub-<业务会话编号>.<uuidv7>.jsonl`，同样不进索引，按文件名找。目录与编号的对应见
    [session-event-log.md](session-event-log.md)「Router 的事件文件」。`AgentDependencies` 增加 `sessionEvents`（必填）
    和 `tracer`。
  - 基座的约束改为：事件句柄指向一份还没有消息的新文件，`runAgentLoop` 在 `tools/set` 之后、`loop/start` 之前把 `history`
    逐条写成消息事件。重放对这段历史调用 `prepareRequestMessages`，所以历史里不能有 notification 消息、也不能有夹在工具调用与
    结果之间的消息；Router 对话拼出的历史只有纯文本的 user / assistant 消息，`prepareRequestMessages` 对它是恒等的，
    `router-model-log.test.ts` 用真实的 `createRouterAgent` 和带历史的对话做三方比对。
  - logger 是 `createSessionLogger`（主会话用的同一个，现从 `@zero-os/core` 导出），会话编号取当天目录名，所以 `run.log`
    落在 `sessions/router-<日期>/`；每行数据带 `callId`（文件的子编号）。
  - usage 用途：`router_triage`、`router_chat`、`router_commission`、`router_investigation`、`router_job`、
    `router_job_report`、`router_write_check`、`router_task_followup`。Web 的「Cost by Purpose」与会话详情的分项直接显示
    `purpose` 字符串，不需要改；旧数据里 Router 的花费仍记在 `agent_loop`。
  - 保留期：`TriggerRetentionStore.sweep` 返回这次使用的截止时间，`ListenerRuntime` 随后调用
    `SessionEventStore.deleteFilesBefore('router-', 截止时间)`，删除 Router 目录里最后写入早于截止时间的文件（含 `run.log`）。
    按文件的最后写入时间判断，不看业务记录：仍在保留的任务、对话，其较早调用的文件也会删掉，
    文件不会比它记录的那次调用活得更久。
  - 不写 `step/start.model`：Router 的 `AgentDependencies.modelRouter` 只给 adapter，模型名在 usage 账本里。
- **4d Codex Worker 接入（已完成）。** 计划：`runRouterJob` 不再自造 `ToolContext`，在派工的事件文件里记一次工具调用；
  logger 不再丢弃 `warn` 和 `error`。实际落点（`ToolContext` 一条与计划不同，见最后一项）：
  - loop 写 `tool/call`、`tool/result` 的代码从 `executeAgentLoopToolCalls` 提成 `journalToolCall`、`journalToolResult`
    （`agent-loop.ts`），loop 和 `runRouterJob` 都调它们，主会话的事件不变。
  - Codex 派工每次执行（每个 attempt）经 `openRouterCall`（与 `runTriggerModel` 同一个函数）新建
    `sessions/router-<日期>/sub-router-job-<派工编号>.<uuidv7>.jsonl`，header 的 `name` 为 `Codex 工程任务`，`role` 为
    `codex_worker`。文件里只有 `tool/call`（`name: worker`，输入为 `type`、`instruction`、`workingDirectory`，续做时带
    `resumeThreadId`）和 `tool/result`（成功或失败、耗时、结果字数与摘要）；抛错时同样写 `tool/result`（`status: error`）。
    Codex 的中间过程不写（见「已定事项」）。完整结果仍在 `router_job_steps.result`。
  - `runRouterJob` 新增必填的 `journal` 和 `logger`，由调用方（`router-job-executors.ts`）给出：logger 是 Router 当天的
    会话 logger，`warn`、`error` 照常写进 `run.log`。`toolUseId` 每次新生成（`router_job_<uuid>`），不再固定为 `router-job`。
  - `ToolContext` 仍在 `runRouterJob` 里组装，因为 `runCodexWorker` 需要它；其中的 logger、会话编号来自调用方，
    运行登记表仍是这次执行独有的一份。没有改成经 `BaseTool.run`：那条路径要求会话的工具 hooks，而派工不在会话里。

### 步骤 6：主会话改为「基座 + 模块」

一次搬一项，每一项单独合并，搬完后 `createAgentLoopHooks` 里不再有它。顺序：

1. **动态上下文与图片委托的注入。** 最简单，用来把「注入经基座入口」的那条约束落成代码。
2. **排队。** 记忆提醒和任务闭合都要看它（排队会打断记忆提醒、丢弃闭合决定）。「有消息排队了」先成为基座发出的
   事实，后面的模块才能不引用它。
3. **压缩。**
4. **任务闭合。**
5. **记忆。** 牵扯最多（检索注入、提醒阶段、写入确认），放最后。

模块的形状（`AgentLoopModule`，`agent-loop.ts`）随搬出的功能增长，没有预先设计的项。模块放在 `packages/core/src/agent/modules/`，
每个文件导出一个返回模块的函数，文件之间不互相 import；`Agent` 在构造 loop 的地方按数组传入。基座记下的
「请求改动」（`LoopIterationContext.requestEntries`：追加的消息、只在请求里的注入、检查点，顺序与日志一致）是模块和剩下的
hooks 读取请求历史的唯一来源。

- **6.1 动态上下文与图片委托（已完成）。** 扩展点 `requestInjections(message)`：模块交出放在 loop 首条 user 消息前面的文本，
  基座按数组顺序拼接，一次写成 `injection/context`（带 `messageId`），记进 `requestEntries`，再用 `applyUserInjections`
  改写请求里的那条消息。原来的 `AgentLoopHooks.buildRequestUserContent` 删除。模块是 `modules/request-context.ts` 的
  `requestContextModule(context)`。消息条目改由 loop 在写消息事件的同一处记进 `requestEntries`，`agent-hooks.ts` 不再自己维护这份列表。
- **6.2 排队（已完成）。** 模块是 `modules/queue.ts` 的 `queueModule(...)`，「有消息排队了」成为基座发出的事实。落点：
  - 扩展点：`takeQueued(point)`（决定：第一个取走的模块给出续写消息）、`mergeQueued(last)`（决定：工具结果之后取走排队消息，
    交出要接在请求末条 user 消息后的 blocks）、`onQueueTaken(taken)`（观察：全部调用）、`shouldInterrupt`（任一模块为真即为真）、
    `onCompletionEnd`（观察，排队用它在请求返回后通知 `onApplied`）。
  - 基座在固定位置检查排队（`QueuePoint`）：一轮结束时（`end_turn`）、全部模块评估之后（`after_evaluation`）、某个模块的
    继续决定生效之前（`before_decision`，给出决定的模块自己会取排队消息时不查），以及只进请求的阶段遇到空响应时
    （`request_only_empty`）；工具结果之后调用 `mergeQueued`。取走时，基座在返回续写消息、改写请求之前同步发出
    `onQueueTaken`（带取走的消息、`QueuedInjectionTrace`、是否续写消息、当时是否处于只进请求的阶段），再由基座写
    `injection/context`（`queued_merge`）并记进 `requestEntries`。`agent/inbox/drained|spliced` 仍由排队模块自己写。
  - 一轮结束拆成三个扩展点：`evaluateEndTurn`（观察，按数组顺序逐个 await；闭合在这里跑分类器、记 `closure/start`）、
    `settleEndTurn(queueTaken)`（观察；闭合在这里记 `closure/end`，评估之后取走了排队消息时记 `discarded`）、`decideEndTurn`
    （决定：按数组顺序取第一个继续的模块；返回的 `commit` 只在这个继续真的生效时调用，所以排队检查让位时闭合的重试次数、
    记忆提醒的开始都不发生）。调用方的 `onEndTurn` hook 最后才问。顺序与原来一致：排队续写提示 → 闭合重试 → 记忆提醒。
  - 「是否处于只进请求的阶段」从 `AgentLoopJournal.requestOnly` 挪成模块扩展点 `requestOnly()`（决定：第一个给出原因的模块），
    基座据此写 `request/message`，并记在 `onQueueTaken` 的 `wasRequestOnly` 里；排队的 trace（`queue_gate_drain` 的
    `wasDuringNudge`）读它，不再读记忆的状态。
  - 模块带可选的 `name`，用于 trace：`before_decision` 处取走排队消息时 span 的 `phase` 是 `pre_<name>`，所以闭合、记忆两处仍是
    `pre_task_closure_retry`、`pre_memory_nudge`；其余位置沿用 `pre_closure`、`post_classifier`、`memory_nudge_empty`。
  - 闭合、记忆、trace 还在 `agent-hooks.ts`：`createAgentLoopHooks` 现在返回 `modules`（闭合与排队 trace 一个、记忆提醒的决定一个），
    由 `Agent` 按 `[requestContextModule, queueModule, ...会话模块]` 传入。闭合分类器读的「已拼进来的排队原文」由会话模块观察
    `onQueueTaken` 自己拼。
  - 验收：扩充后的 `dump-events.ts`（7 个场景：原场景、工具执行中排队拼进工具结果、分类器运行时排队使闭合记成 `discarded`、
    排队打断记忆提醒、闭合要求继续与记忆写入、turn 内压缩、turn 开始压缩）在改动前后输出逐行相同，包括事件、trace 的 span
    调用（名称、父子、顺序、kind、data 与 metadata 的键和 metadata 的值）和 bus 事件。
- **6.3 压缩（已完成）。** 模块是 `modules/compaction.ts` 的 `compactionModule(...)`，主会话 `Agent` 从这一步起经基座
  `runAgentLoop` 运行，`loop/start` 由基座写。落点：
  - 扩展点 `compact(canonical, trigger, checkpoint)`（改写，按数组顺序串联）：模块在压力达到阈值时压缩 canonical 消息，返回新检查点。
    基座在写完 `loop/start` 之后调用一次（`turn_start`），用返回的检查点投影请求历史（`prepareRequestMessages`）；工具结果之后、
    排队拼接之前再调用一次（`in_turn`，canonical = 本次运行的历史 + 新消息），有新检查点时把它记进 `requestEntries`，用
    `assembleRequest` 重建请求消息。`compaction/start|checkpoint|end` 仍由模块在压缩发生的那一刻写。
  - `runAgentLoop` 新增 `history` 的检查点 `checkpoint`、`requireThinkingForToolUse`（写进 `loop/start`）、`modules`、`getMeta`、
    `userImages`、`userMessageEntry`、`transientRetryDelayMs`，以及 `historyLogged`：会话自己的事件文件已经在变化时写了系统提示词、
    工具集，在消息产生时写了历史，基座只写 `loop/start`。没有它时（记忆检索、Router）基座照旧写系统提示词、工具集和历史。
    基座现在对所有调用方都用 `prepareRequestMessages` 投影传入的历史：Router 的历史与记忆检索（无历史）不受影响，见 4c。
  - 压缩模型的请求输入不另落事件：它是一次 `adapter.complete()`，输入由上一份检查点的摘要、新进入摘要范围的 canonical 消息
    （两份检查点水位之间，均已作为消息事件落盘）和代码里的提示词决定，可以从日志推出，但没有 hash 核对。
  - `Agent.compactContextForRequest` 和 `createAgentLoopHooks` 的 `compaction`、`requestBase` 选项、`afterToolResults` hook 删除。
  - 验收：`dump-events.ts` 的 7 个场景（含 turn 开始压缩与 turn 内压缩）改动前后的事件、trace、bus 逐行相同。
- **6.4 任务闭合（已完成）。** 模块是 `modules/closure.ts` 的 `closureModule(...)`（分类器请求、trace 与 `closure/*` 事件的代码一并搬过去）。
  - 用 `evaluateEndTurn`（跑分类器，记 `closure/start`）、`settleEndTurn`（记 `closure/end`，评估之后取走了排队消息时记 `discarded`；
    沿用原来的行为：即使本轮没有评估也记这条 `discarded`）、`decideEndTurn`（要求继续时给出重试提示，`commit` 时计数），`name` 为
    `task_closure_retry`。
  - 不再读记忆和排队的状态：「提醒进行中不评估」改读基座的事实 `LoopIterationContext.requestOnly()`（新增，由 `requestOnly`
    扩展点算出）；分类器输入里的已拼进来的排队原文由模块自己观察 `onQueueTaken` 拼出。trace 里 `queue_gate_drain` 的
    `appliedQueuedIntentLength` 由 trace 一侧另拼一份，两边用同一个 `formatAppliedQueuedIntent`。
  - 任务闭合分类器的请求输入不另落事件：`closure/start` 已带 `baseSeq` 与 `messageCount`，分类器看到的消息都在 `baseSeq` 之前
    （见 session-event-log.md「上下文锚点」），提示词由代码给出；排队原文来自同一段日志里的排队事件。能推出，但没有 hash 核对。
  - `Agent` 的模块数组：`[requestContextModule, compactionModule, queueModule, closureModule, ...记忆与 trace]`；决定的顺序因此是
    排队续写提示 → 闭合重试 → 记忆提醒，与原来相同。
  - 验收：`dump-events.ts` 7 个场景改动前后的事件、trace、bus 逐行相同。

## 已定事项

原来的三个待定事项在 4c、4d 之前按下面的方案定下：

- **Router 的事件放在哪里：按天归并。** 每天一个 Router 目录（`sessions/router-<本地日期>/`，形状同父会话目录），每次模型调用
  一个 `sub-<业务会话编号>.<uuidv7>.jsonl`，即 `registerSubagent` 的形状。理由：Router 的调用没有父会话，按任务或按派工归并
  需要先有统一的「事项」（[router-design.md](router-design.md)「已知的不足」第 1 条）；一次调用一个文件又正好满足基座
  「一次运行一份新文件」的约束。按天的目录让保留期清理可以只看目录，不必逐个解析业务编号。
- **Router 事件流里放什么：存模型实际看到的全文。** Router 发给模型的内容在进入提示词之前已经过 `secretFilter`，落盘的就是
  过滤后的文本；只存 hash 与预览时请求只能核对、不能还原，这次要的是还原。代价是保留期：事件文件遵守 Router 业务表的
  正文保留期（7/30/90/365 天，默认一直保留），到期一并删除，不让日志成为绕过保留期的副本。
- **Codex 的中间过程不落盘。** 只记一次工具调用的开始、结束和最终结果（步骤 4d）。Codex 自己有线程记录；把中间步骤写进
  派工文件会让日志大小取决于 Codex 的输出量，排障时需要的是派工收到了什么、交回了什么。

压缩模型和任务闭合分类是单步的 `adapter.complete()` 调用，不经过 loop。它们的请求输入怎么落，随步骤 6 搬对应模块时定。

## 怎么判断有没有变好

- 事件流里 `messages/truncate` 只在真实回滚、撤回、恢复时封口没封口的 turn 时出现；每条 canonical 消息只对应一条消息事件。
- evidence 文件的字符数与工具原始输出一致。
- 新增一个需要多步工具调用的模型调用点时，不需要再写工具适配、超时、预算和取文本的代码。
- 记忆检索和 Router 的每次请求都有 `step/start`，`requestHash` 能从事件流重算核对（步骤 4 之后）。
- Router 的花费能按用途分项，业务表里的会话编号能打开对应的事件文件（步骤 4c 之后）。
- `agent-hooks.ts` 不再同时出现排队、闭合、记忆、压缩、trace 五类逻辑（步骤 6 之后）。
- 模块文件之间没有互相 import；新增一种组装只是换一个模块数组（步骤 6 之后）。
