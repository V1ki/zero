# 从日志还原会话上下文

这份文档定义 `session.jsonl` 怎样成为会话上下文的唯一来源：恢复会话、以及还原任意一次模型请求，都只靠重放日志。
事件格式见 [session-event-log.md](session-event-log.md)，压缩见 [context-compaction.md](context-compaction.md)，
整体方向见 [agent-loop-session-log-design.md](agent-loop-session-log-design.md)。

## 目标

对任意一条 `step/start` 事件，下面的等式成立：

```text
assembleRequest(projectUpTo(step/start 的 seq)) == 那次请求实际发给模型的 system、工具集和消息
```

恢复会话是同一件事的特例：`project()` 得到的状态就是会话重启后继续工作所需的全部状态。

## 现状的缺口

1. **本 turn 的消息到 turn 结束才写日志。** 消息事件由 `syncCanonical` 在 turn 结束时做前缀 diff 补写，所以
   `step/start` 的 seq 早于它发出的消息；turn 中途崩溃，本 turn 的消息全部丢失。
2. **记忆提醒阶段的消息不进 canonical，也不落任何事件。** 它们发给了模型，这几次请求还原不出来。
3. **系统提示词只记了一部分。** 请求里的 system 是「系统提示词 + identityMemory」，`system/prompt` 只记了前者。
4. **恢复时会改写 canonical。** 恢复把重排后的工具结果、以及（当前模型是 DeepSeek 时）删掉无签名 thinking 的工具调用
   之后的消息写回日志。后者取决于恢复那一刻的模型，而请求组装时本来就做同样的清理。
5. **恢复依赖日志以外的东西。** 系统提示词取自 DB 行，下一个 turn 的编号取自 trace 的请求记录。
6. **部分会话状态恢复后是空的。** 已注入的记忆编号表不恢复，重启后同一条记忆可能再注入一次。

另外没有任何东西在核对「重放出来的请求」和「实际发出的请求」是否一致。

## 约定

- **消息在产生的那一刻写入。** 写入口只有一个：`SessionEventStore.appendMessage`，下标由 store 按当前投影长度分配。
  主会话和子代理的 loop 都经 `obs.sessionEvents` 调它，所以子代理的事件文件自动带上消息。
- **`syncCanonical` 只做对账。** 正常运行时它找不到差异。出现前缀缩短（回滚、撤回、恢复修复）时写
  `messages/truncate`，原因由调用方声明：`turn_failed`、`admin`、`recall`、`restore_repair`、`interrupt`。
  没有声明原因却出现差异，说明有代码在别处改了 canonical：按 `unexpected` 记录并经 `onError` 上报。
- **模型看到的都落日志。** 不进 canonical 的请求内容一律是 `injection/context` 事件，写在它所属的 `step/start` 之前。
- **组装只有一份实现。** 运行时和重放调同一个 `assembleRequest`；`step/start` 记下实际请求的 hash，重放可以核对。
- **恢复不改写 canonical。** 面向 provider 的清理只发生在请求组装里。
- **恢复只读日志。** 会话元数据之外的状态都由事件重放得到。

## 没封口的 turn

消息即时写入之后，崩溃会在日志里留下一个只有 `turn/start`、没有 `turn/end` 的 turn。恢复时按 turn 失败的现有规则处理
（`applyFailedTurnRollback`）：这个 turn 里没有已完成的 assistant 消息就回滚到 turn 开始时的消息数，排队消息保留；
否则保留已完成的部分。然后补写 `turn/end`（`status: 'failed'`，`reason: 'process_restart'`）把它封口。
回滚产生的 `messages/truncate` 原因是 `restore_repair`。

## 步骤

| 步骤 | 内容 | 关闭的缺口 |
| --- | --- | --- |
| 1 | 消息即时写入；`syncCanonical` 只做对账并写对截断原因；恢复时处理没封口的 turn | 1 |
| 2 | 记忆提醒消息和 identityMemory 落事件 | 2、3 |
| 3 | `assembleRequest` 供运行时和重放共用；`step/start` 记请求 hash；重放核对的测试 | 核对空白 |
| 4 | 恢复不再改写 canonical | 4 |
| 5 | 恢复只读日志：系统提示词、turn 编号、已注入记忆表 | 5、6 |

记忆提醒阶段的消息只落注入事件，不进 canonical：模型以后看不到它们，行为与现在一致，只是多一份可还原的记录。

## 怎么判断有没有变好

- 任意 `step/start`：重放组装出的请求 hash 等于事件里记下的 hash。
- turn 中途杀掉进程再恢复：已产生的消息还在，没封口的 turn 被封口，下一次请求能正常发出。
- 正常运行的会话里没有 `messages/truncate`；出现时原因与实际操作一致，`unexpected` 为 0。
- 切到 `file-only` 后，恢复会话不读 `session_messages`、不读 trace。
