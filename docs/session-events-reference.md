# Session 事件总账（session.jsonl 全量参考）

每个事件如何产生、何时写入、如何被消费。类别定义：

- **① surface**：canonical 投影的折叠源（恢复路径依赖，重放 = 权威）
- **② request-scoped**：重建某次请求精确输入所需
- **③ diagnostics**：纯排障/时间线，可裁剪不影响正确性
- **结构**：文件结构或可重建标记，非业务事件

写入统一经 `SessionEventStore.append/syncCanonical`，seq 写入时分配（turn mutex 单写者），ts 为 ISO 时间。状态：✅ 发射中 / 🌱 仅迁移播种 / ⏸ 类型就绪未接 / 💤 保留未发射。

## 结构事件

| type | 发射点 | 触发 | data 要点 | 投影行为 |
|---|---|---|---|---|
| `session` ✅ | persistence `ensureSessionEventHeader`（经 persistSessionMetadata/State）;子代理文件由 store `registerSubagent`（spawn-agent 工具调用） | 会话首次持久化，幂等;子代理派生时 | v、sessionId、schemaVersion、source、channelId/Name；子代理才有 origin+血缘 | projection.header；第 0 条不变式锚点 |
| `checkpoint` ✅ | store `syncCanonical`/`syncMessages` 每批变更后 | 消息/块变化落一批后 | atSeq、messageCount、projectionHash | 不折叠;冷启动快进与对账标记，可重算 |

## ① surface（canonical 投影源）

| type | 发射点 | 触发 | data 要点 | 说明 |
|---|---|---|---|---|
| `user/message` ✅ | store `buildMessageSyncInputs`（diff 追加） | canonical 新增 user 消息（turn 输入、tool_result 消息、queued、layer2 提示、background 回注） | messageIndex、message 全量、source、hash | 唯一权威的消息正文;图片为 imageRef 文件引用 |
| `assistant/message` ✅ | 同上 | canonical 新增 assistant 消息（含 text/thinking/tool_use blocks） | 同上 | 模型输出唯一权威全文 |
| `messages/truncate` ✅ | 同上 | canonical 前缀缩短（turn 回滚 `applyFailedTurnRollback`、restore 修复） | toMessageIndex、reason | 折叠指令，历史事件永不删除 |
| `compaction/block` ✅ | store `syncCanonical`（blocks 数组变化时） | timeline 压缩块创建/supersede/recompact | blocks 全量数组 + changed(blockId, lifecycle) | 投影取最新一份;取代 DB `session_compaction_blocks` 大字段 |

## ② request-scoped（重建请求输入）

| type | 发射点 | 触发 | data 要点 | 重建规则 |
|---|---|---|---|---|
| `injection/context` ✅ | ① `buildRequestUserContent`（agent-hooks）每 turn 首条请求前;② afterToolResults 队列拼接后;③ 迁移播种 🌱 | kind=dynamic（system-reminder 含记忆检索）、image_delegation、queued_merge;memory/memory_hint 仅迁移期从 run.log 抽取 | kind、content 原文、refs | 按 turn 区间/请求关联取用;投影 canonical 时忽略 |
| `system/prompt` ✅ | persistence `ensureSessionPromptEvent`（hash 比对） | 初始化、agent 重建、能力变更导致 prompt 重建 | hash、chars、content 全文 | getSystemPrompt;DB 列只存最新一份，事件流保留谱系 |
| `tools/set` ✅ | session-turn `ensureToolsSetEvent`（turn 开始比对名字列表 hash） | 工具集变化 | hash、toolNames、count | getToolSet;完整定义由代码版本推导 |
| `step/start` ✅ | agent-hooks `onCompletionStart` | 每次模型请求开始 | stepIndex、requestSpanId、model、messageCount | **事件自身 seq 即请求重建锚点**：projectUpTo(seq)+该请求注入 |
| `closure/start` ✅ | agent-hooks `onEndTurn` | closure 评估开始 | turnIndex、requestId、model、baseSeq、messageCount | baseSeq+messageCount 对账;未评估不产生任何 closure 事件 |

## ③ diagnostics（时间线/排障）

| type | 发射点 | 触发 | data 要点 |
|---|---|---|---|
| `turn/start` ✅ | session-turn | 每 turn 开始 | turnIndex、trigger、model、agentName、baseSeq（本 turn 消息 seq 均大于它） |
| `turn/end` ✅ | session-turn 成功/异常两条路径 | turn 结束 | turnIndex、status(completed/failed/aborted)、durationMs |
| `step/end` ✅ | agent-hooks `onCompletionEnd` | 每次模型请求返回 | stepIndex、stopReason、requestId、usage、durationMs |
| `tool/call` ✅ | agent-hooks `onToolCallStart` | 工具开始 | toolUseId、name、inputHash、inputPreview、spanId |
| `tool/result` ✅ | agent-hooks `onToolCallEnd` | 工具返回 | toolUseId、name、status、durationMs、chars、summary |
| `compaction/prune` ✅ | agent-hooks `processAgentToolResults`（artifactize） | 超大 tool_result 持久替换为 artifact 引用 | toolUseId、from(chars+hash)、to(artifact_ref)、evidence 指针 |
| `closure/end` ✅ | agent-hooks `onEndTurn` 三条路径 | 决策产出 | action(finish/continue/block/discarded)、reason、model、requestId、assistantMessageId、durationMs;discarded 原决策在 detail |
| `memory/retrieval/start` ✅ | memory-retrieval `retrieveMemoriesWithDecision` | 检索 agent 侧循环开始（layer1 开场/layer2 工具失败后） | layer、turnIndex |
| `memory/retrieval/end` ✅ | 同上（成功/失败两路径） | 检索结束 | layer、status(injected/skipped/failed)、queries、searchCount、selected、durationMs、usage、error |
| `memory/recorded` ✅ | agent-hooks `onToolCallEnd` memory 分支 | memory 工具 create/update 成功 | action、memoryId、memoryType、title、toolUseId |
| `model/selection` ✅（仅 1/4 触发点） | session `switchSessionModel` | /model 命令 | from、to(label/provider/modelId)、trigger=user_command、detail |
| `params/reasoning` ✅ | session-controllers `updateSessionReasoningEffort` | /think 变更 effort | from、to |
| `agent/inbox/enqueued` ✅ | session `handleSessionMessageEntry` 排队分支 | turn 进行中消息入队 | messageIndex（canonical 下标）、reason、interrupt |
| `agent/inbox/drained` ✅ | queueGate `injectQueuedMessagesIntoLastUserMessage` | loop 取走排队消息 | count |
| `agent/inbox/spliced` ✅ | 同上 | 拼进首条 user 消息 | strategy=inject_into_last_user、count |
| `job/registered` ✅ | `BackgroundToolTaskManager.run`（经 agent 的工具执行器） | 每次 bash 执行开始，紧跟该调用的 `tool/call` | jobId、toolUseId、toolName |
| `job/settled` ✅ | 同上;前台结束在 `run`，转后台后结束在 `completeTask` | bash 执行真正结束 | jobId、status(success/error)、durationMs、backgrounded、evidence（转后台且输出超过 8000 字符时，完整输出的落盘指针） |
| `subagent/spawn` ✅ | spawn-agent 工具，`agentControl.spawn` 成功之后 | 派生子代理;写在父会话事件流，位于 spawn_agent 的 `tool/call` 与 `tool/result` 之间 | childSessionId（即 agent_id）、name、role、spawnedByRequestId、logFile（子事件文件相对 logs 根的路径） |

job 只针对 bash。bash 执行超过 5 秒转后台（其他工具仍是 60 秒，且不落 job 事件）：转后台时
`tool/result` 立刻返回 `background_tool.started`，此时 jobId 就是 background task id；真正结束时先落
`job/settled`，再把 `background_tool.completed` 作为 control 消息送回会话。5 秒内结束的 bash 顺序是
`tool/call` → `job/registered` → `job/settled` → `tool/result`。事件流里有 `job/registered` 而没有对应
`job/settled` 的 job，就是仍在运行或因进程重启而丢失的 job。子代理与父会话共用同一个后台任务管理器，
它的 bash job 事件写在父会话文件里，对应的 `tool/call` 在子代理自己的文件里，用 toolUseId 关联。

子代理自己的事件写在 `logFile` 指向的文件里：`session` 头、`system/prompt`、`tools/set`，以及由同一套 agent hooks
发出的 step、tool 等过程事件。目前不含消息事件和 `turn/*`，原因见
[session-event-log.md](./session-event-log.md)。子代理结束不另落事件，结果在父会话后续 `wait_agent` 的 `tool/result` 里。

## ⏸ 类型就绪、发射点未接

| type | 计划发射点 | 未接原因 |
|---|---|---|
| `llm/retry` | model 包 adapter 层（openai-resp transport、model-pool failover） | 需要 model 包回接事件流句柄 |
| `model/selection` 其余触发 | init（会话创建）、fallback（pool failover）、reload（配置热更）、route | 目前只有 user_command |
| `session/archive` | 会话归档/删除 | 待接入 |

## 💤 保留未发射

| type | 说明 |
|---|---|
| `compaction/summary` | 旧式 compressConversation 专用（scope=loop_only，只改 loop 内存不持久）;该路径按早前分析应删，删除时此类型一并移除 |

## 消费方

| 消费 | 路径 |
|---|---|
| 会话恢复（权威） | `SessionManagerStore.restoreSessionById` / `getMessagesFromDB` → `store.project()`;无事件文件回退 DB |
| 请求重建 | `projectUpTo(seq)` + turn 区间内 injection + compaction 确定性重放 |
| 状态查询 | `getSystemPrompt` / `getToolSet` / `getLastSeq` |
| 迁移/校验 | scripts-diag convert（播种 session/system/prompt/user·assistant·truncate/compaction-block/injection）+ rebuild（事件→DB 派生行） |
| Web UI | ⏸ 尚未读取事件流（run.log raw 事件删除后，请求详情重建待接） |
