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
   之后的消息写回日志。后者取决于恢复那一刻的模型，而请求组装时本来就做同样的清理。
5. **恢复依赖日志以外的东西。** 系统提示词取自 DB 行，下一个 turn 的编号取自 trace 的请求记录。
6. **部分会话状态恢复后是空的。** 已注入的记忆编号表不恢复，重启后同一条记忆可能再注入一次。

另外没有任何东西在核对「重放出来的请求」和「实际发出的请求」是否一致。（步骤 3 已关闭）

## 约定

- **消息在产生的那一刻写入。** 写入口只有一个：`SessionEventStore.appendMessage`，下标由 store 按当前投影长度分配。
  主会话和子代理的 loop 都经 `obs.sessionEvents` 调它，所以子代理的事件文件自动带上消息。loop 之外进 canonical 的
  只有 turn 进行中排队的消息，`queueMessage` 在追加的同一刻调它。已写入的消息不再原地修改：任务结束判定只记在
  `closure/end`，不再写回 assistant 消息的 `taskClosure`。
- **改动已有消息的一方声明原因。** 回滚、撤回、恢复修复当场调 `syncMessages(sessionId, messages, reason)`；
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
| 4 | 恢复不再改写 canonical | 4 | 后续 |
| 5 | 恢复只读日志：系统提示词、turn 编号、已注入记忆表 | 5、6 | 后续 |

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

## 怎么判断有没有变好

- 任意 `step/start`：重放组装出的请求 hash 等于事件里记下的 hash。
- turn 中途杀掉进程再恢复：已产生的消息还在，没封口的 turn 被封口，下一次请求能正常发出。
- 正常运行的会话里没有 `messages/truncate`；出现时原因与实际操作一致，`unexpected` 为 0。
- 切到 `file-only` 后，恢复会话不读 `session_messages`、不读 trace。
