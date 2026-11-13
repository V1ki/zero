# 从日志还原会话上下文

这份文档定义 `session.jsonl` 怎样成为会话上下文的唯一来源：恢复会话、以及还原任意一次模型请求，都只靠重放日志。
事件格式见 [session-event-log.md](session-event-log.md)，压缩见 [context-compaction.md](context-compaction.md)，
整体方向见 [agent-loop-session-log-design.md](agent-loop-session-log-design.md)。

## 目标

对任意一条 `step/start` 事件，下面的等式成立：

```text
hashRequest(assembleRequest(buildRequestAssemblyInput(日志, step/start 的 seq))) == step/start.requestHash
                                                                         == 那次请求实际发给 adapter 的 system、工具名和消息的 hash
```

恢复会话是同一件事的特例：`project()` 得到的状态就是会话重启后继续工作所需的全部状态。

## 现状的缺口

1. **本 turn 的消息到 turn 结束才写日志。** 消息事件由 `syncCanonical` 在 turn 结束时做前缀 diff 补写，所以
   `step/start` 的 seq 早于它发出的消息；turn 中途崩溃，本 turn 的消息全部丢失。（步骤 1 已关闭）
2. **记忆提醒阶段的消息不进 canonical，也不落任何事件。** 它们发给了模型，这几次请求还原不出来。（步骤 2 已关闭）
3. **系统提示词只记了一部分。** 请求里的 system 是「系统提示词 + identityMemory」，`system/prompt` 只记了前者。（步骤 2 已关闭）
4. **恢复时会改写 canonical。** 恢复把重排后的工具结果、以及（当前模型是 DeepSeek 时）删掉无签名 thinking 的工具调用
   之后的消息写回日志。后者取决于恢复那一刻的模型，而请求组装时本来就做同样的清理。（步骤 4 已关闭）
5. **恢复依赖日志以外的东西。** 系统提示词取自 DB 行，下一个 turn 的编号取自 trace 的请求记录。（步骤 5 已关闭）
6. **部分会话状态恢复后是空的。** 已注入的记忆编号表不恢复，重启后同一条记忆可能再注入一次。（步骤 5 已关闭）

另外没有任何东西在核对「重放出来的请求」和「实际发出的请求」是否一致。（步骤 3 已关闭）

## 约定

- **消息在产生的那一刻写入。** 写入口只有一个：`SessionEventStore.appendMessage`，下标由 store 按当前投影长度分配。
  主会话和子代理的 loop 都经 `obs.sessionEvents` 调它，所以子代理的事件文件自动带上消息。loop 之外进 canonical 的
  只有 turn 进行中排队的消息，`queueMessage` 在追加的同一刻调它。已写入的消息不再原地修改：任务结束判定只记在
  `closure/end`，不再写回 assistant 消息的 `taskClosure`。
- **改动已有消息的一方声明原因。** 回滚、撤回、恢复时封口没封口的 turn 当场调 `syncMessages(sessionId, messages, reason)`；
  `syncCanonical` 不带原因，它发现的差异一律算没有声明。
- **`syncCanonical` 只做对账。** 正常运行时它找不到差异。出现前缀缩短（回滚、撤回、恢复修复）时写
  `messages/truncate`，原因由调用方声明：`turn_failed`、`admin`、`recall`、`restore_repair`、`interrupt`。
  没有声明原因却出现差异，说明有代码在别处改了 canonical：按 `unexpected` 记录并经 `onError` 上报。
- **模型看到的都落日志。** 不进 canonical 的请求内容是 request-scoped 事件（改写请求消息的 `injection/context`、
  只在请求里的 `request/message`），写在它所属的 `step/start` 之前；loop 的起点是 `loop/start`。
- **组装只有一份实现。** 运行时和重放调同一个 `assembleRequest`；`step/start` 记下实际请求的 hash，重放可以核对。
- **恢复不改写 canonical。** 面向 provider 的清理只发生在请求组装里。
- **恢复只读日志。** 会话元数据之外的状态都由事件重放得到。

## 没封口的 turn

消息即时写入之后，崩溃会在日志里留下一个只有 `turn/start`、没有 `turn/end` 的 turn。恢复时按 turn 失败的现有规则处理
（`applyFailedTurnRollback`）：这个 turn 里没有已完成的 assistant 消息就回滚到 turn 开始时的消息数，排队消息保留；
否则保留已完成的部分。然后补写 `turn/end`（`status: 'failed'`，`reason: 'process_restart'`）把它封口。
回滚产生的 `messages/truncate` 原因是 `restore_repair`。

## 步骤

| 步骤 | 内容 | 关闭的缺口 | 状态 |
| --- | --- | --- | --- |
| 1 | 消息即时写入；`syncCanonical` 只做对账并写对截断原因；恢复时处理没封口的 turn | 1 | 已完成 |
| 2 | 记忆提醒消息和 identityMemory 落事件 | 2、3 | 已完成 |
| 3 | `assembleRequest` 供运行时和重放共用；`step/start` 记请求 hash；重放核对的测试 | 核对空白 | 已完成 |
| 4 | 恢复不再改写 canonical | 4 | 已完成 |
| 5 | 恢复只读日志：系统提示词、turn 编号、已注入记忆表 | 5、6 | 已完成 |

步骤 2、3 之后，重建规则见 [session-event-log.md](session-event-log.md)「请求重建」：
- 记忆提醒阶段 loop 追加进请求的消息写成 `request/message`，不进 canonical：模型以后看不到它们，行为不变。
- `system/prompt` 增加 `identity`，hash 覆盖实际发出的 system；每个 turn 开始时比对，变了就写。
- 首条 user 消息的注入与排队拼接带上 `messageId`（排队拼接另带拼接的 blocks，含排队图片）；每次 `Agent.run`
  开头写 `loop/start`（带 provider 清理选项 `requireThinkingForToolUse`），标出请求历史取自哪里。
- `step/start.requestHash` 是实际请求的指纹；`request-replay.test.ts` 用真实 Session / Agent / SessionEventStore 和
  脚本化的 fake adapter 对每个 step/start 核对三方 hash。turn 内压缩后的运行时重建也走 `assembleRequest`。

做这件事时发现的、此前同样没进日志的模型可见输入：loop 的请求历史是 turn 开始时的快照（不是 step 时的 canonical 投影：
turn 中途排队的消息进 canonical 却只以拼接原文进请求，记忆提示等 notification 在本 turn 发出、以后被投影过滤），所以需要
`loop/start` 锚点；provider 清理（DeepSeek 无签名 thinking）取决于当时的 adapter，记在 `loop/start`；排队拼接里的图片原来
只在请求里；`tools/set` 原来不记空工具集；`system/prompt` 原来 trim 后才记。

仍然还原不出的：
- **turn 进行中的撤回。** 撤回原地改写会话里的消息对象，turn 内后续请求看到改写后的内容；日志按截断 + 重新追加记录，
  重放取不到这一刻的改写，`buildRequestAssemblyInput` 遇到 loop 内的 `messages/truncate` 返回 null。
- **检查点指向只在请求里的消息。** turn 内压缩的输入包含记忆提醒阶段的消息，理论上水位可以落在它们上：运行时把这份检查点
  当无效，恢复投影则回退到更早的有效检查点，两边不一致。保留尾部至少占窗口的 20%，提醒阶段的消息很短，实际不会发生。
- **步骤 1 之前的旧日志**没有 `loop/start`，`buildRequestAssemblyInput` 返回 null。

没有事件文件的旧会话恢复时，DB 快照先写进事件流。

## 恢复不改写 canonical（步骤 4）

恢复不写消息事件，也不写 `messages/truncate`，唯一的例外是封口没封口的 turn（`sealInterruptedTurn`）。
原来恢复时做、现在去掉的两件事：

- **重排夹在中间的消息。** turn 进行中排队的消息和 `background_tool_completed` 控制消息会落在 tool_use 与
  tool_result 之间，恢复时把 tool_result 挪到 tool_use 后面再写回日志和 DB。请求组装里的 `prepareRequestMessages`
  先去掉 notification，再由 `mergeInterleavedQueuedMessages` 把这些消息并进 tool_result 消息，原来重排的形状
  （一条或多条、排队与控制混在一起、中间夹着撤回后变成 notification 的消息、并行工具调用）都已覆盖，
  `context.test.ts` 逐一核对请求合法。所以组装没有新增处理，重排函数和它的测试已删除。
  恢复后同一段历史发出的请求也因此与运行时一致：原来重排过的会话，排队消息在请求里是 tool_result 之后的独立消息。
- **按恢复时的模型删工具调用。** 当前模型用 DeepSeek 风格的 adapter 时，恢复会删掉没有签名 thinking 的
  工具调用并写回，换模型之后也找不回来。请求组装按 `loop/start.requireThinkingForToolUse` 做同样的清理，
  canonical 保留原样。

旧版本已经改写过的日志不用处理。

没改的已知风险（与恢复无关，运行中的会话一直有）：压缩划保留尾部时只保证尾部不以 tool_result 开头。
如果切点恰好落在夹在 tool_use 与 tool_result 之间的排队消息上（tool_use 那条 assistant 消息正好是第一条放不进
保留预算的消息），请求里会出现找不到 tool_use 的 tool_result。原来恢复时的重排让重启过的会话避开了这种情形。
要同时满足「工具执行中有人发消息」和「预算边界正好落在一条通常很短的 tool_use 消息上」，概率很低，没有为它改压缩。

## 恢复读什么（步骤 5）

`SessionManagerStore.restoreSession` 先封口没封口的 turn，再调 `SessionEventStore.projectForRestore`。
这是把事件折叠成可恢复状态的唯一地方，折叠规则与 `project()` 共用同一份增量投影。

| 状态 | 有事件文件 | 没有事件文件 |
| --- | --- | --- |
| canonical 消息、检查点、旧压缩块 | 投影 | DB 快照行（随后写进新建的事件文件） |
| 系统提示词（`Session.getSystemPrompt`） | 最后一条 `system/prompt` 的 `content`；没有这条事件时为空 | DB 行的 `system_prompt` |
| 下一个 turn 编号 | `turn/start` 里最大的 `turnIndex` + 1；没有 turn 事件（DB 快照导入的旧会话）时同右 | trace 的请求记录，没有时按消息里的 user turn 数 |
| 已注入记忆表（id → title） | `status: injected` 的 `memory/retrieval/end` 的 `selected`，layer1、layer2 都算 | 空 |
| 会话元数据：id、来源、channel、当前模型、模型历史、reasoning effort、tags、agent 配置 | sessions.db | sessions.db |

`memory/retrieval/end` 原来就够用：`status: injected` 时 `selected` 与检索返回、运行时记进已注入表的记忆是同一份
（layer2 的提示最多带 3 条，与选中上限相同），`title` 一直都写，现在在类型上标为必填。运行时在选中的那一刻记表，
不等请求真的发出；重放按同样的时刻记，所以 turn 失败回滚后已注入表照样保留，与运行中的会话一致。
identityMemory 不从日志恢复：它取自当前的身份记忆，每个 turn 开始时与最后一条 `system/prompt` 比对，变了就写新的。

检查过、恢复后从空开始的会话状态：

- **本来就是瞬时的。** turn 锁、打断与中止标记、进度时间；运行时刷新的待办标记；正在运行的工具表；
  channel 能力（channel 层使用会话时设置）；静态上下文缓存（第一次请求时按当时的模型、工具与技能目录重建，
  重启期间新增的技能因此进系统提示词，而不是作为「新技能」出现在首条 user 消息里）。
  turn 进行中的排队消息队列也是瞬时的：排队消息进队列的同一刻已写进 canonical，崩溃后封口保留它们，下一次请求按普通历史发出。
- **需要新事件才能恢复，暂不做。** 活文档表（type + tags → memoryId，memory 工具据此把同主题写入并进已有文档）：
  `memory/recorded` 没有 tags，算不出折叠键。
- **不属于会话上下文。** 当前快照 id 仍取自 trace 的 snapshots（只用来串起 trace 自己的快照谱系），
  这是恢复唯一还读 trace 的地方。
- **已知缺口，本步骤不做。** 运行中的后台 job：有 `job/registered` 没有 `job/settled` 的 job 重启后不会再有完成事件；
  子代理：只有正常停机时的 drain 快照（`restoreSubAgentSnapshot`），崩溃后的子代理不恢复。

## 怎么判断有没有变好

- 任意 `step/start`：重放组装出的请求 hash 等于事件里记下的 hash。
- turn 中途杀掉进程再恢复：已产生的消息还在，没封口的 turn 被封口，下一次请求能正常发出。
- 正常运行的会话里没有 `messages/truncate`；出现时原因与实际操作一致，`unexpected` 为 0。
- 切到 `file-only` 后，恢复会话不读 `session_messages`、不读 trace。
