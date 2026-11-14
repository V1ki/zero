# Session 事件总账（session.jsonl 全量参考）

每个事件如何产生、何时写入、如何被消费。类别定义：

- **① surface**：canonical 投影的折叠源（恢复路径依赖，重放 = 权威）
- **② request-scoped**：重建某次请求精确输入所需
- **③ diagnostics**：纯排障/时间线，可裁剪不影响正确性
- **结构**：文件结构或可重建标记，非业务事件

写入统一经 `SessionEventStore`：消息走 `appendMessage`（产生时）与 `syncMessages`（改动已有消息时，声明截断原因），
turn 结束的对账走 `syncCanonical`，其余事件走 `append`。seq 写入时分配（turn mutex 单写者），ts 为 ISO 时间。状态：✅ 发射中 / 🌱 仅迁移播种 / ⏸ 类型就绪未接 / 💤 保留未发射。

## 结构事件

| type | 发射点 | 触发 | data 要点 | 投影行为 |
|---|---|---|---|---|
| `session` ✅ | persistence `ensureSessionEventHeader`（经 persistSessionMetadata/State）;子代理文件由 store `registerSubagent`（spawn-agent 工具调用） | 会话首次持久化，幂等;子代理派生时 | v、sessionId、schemaVersion、source、channelId/Name；子代理才有 origin+血缘 | projection.header；第 0 条不变式锚点 |
| `checkpoint` ✅ | store `syncCanonical`/`syncMessages` | 上一条 checkpoint 之后写过消息、截断或压缩块事件（正常即每个 turn 结束时一条） | atSeq、messageCount、projectionHash | 不折叠;冷启动快进与对账标记，可重算 |

## ① surface（canonical 投影源）

| type | 发射点 | 触发 | data 要点 | 说明 |
|---|---|---|---|---|
| `user/message` ✅ | store `appendMessage`：`AgentLoop`（loop 产生消息的那一刻，早于转给调用方；子代理写进自己的文件）、`runAgentLoop`（调用方传入的历史，在 `loop/start` 之前，现为 Router 对话）、session `queueMessage`（排队消息进 canonical 的那一刻）;`syncMessages` 截断后重新追加 | canonical 新增 user 消息（turn 输入、tool_result 消息、queued、control、layer2 提示、background 回注）;记忆提醒阶段的消息不进 canonical，写成 `request/message` | messageIndex（按投影长度分配）、message 全量、source、hash | 唯一权威的消息正文;图片为 imageRef 文件引用 |
| `assistant/message` ✅ | 同上（`AgentLoop`） | canonical 新增 assistant 消息（含 text/thinking/tool_use blocks） | 同上 | 模型输出唯一权威全文;写入后不再原地修改 |
| `messages/truncate` ✅ | store `syncMessages`（改动方声明原因）;`syncCanonical` 对账发现未声明的差异 | reason：`turn_failed`（turn 失败回滚 `applyFailedTurnRollback`）、`admin`（尾部回滚命令）、`recall`（外部消息撤回，原地改写旧消息后截断到它并重新追加）、`restore_repair`（恢复时封口没封口的 turn;恢复不再重排或清理 canonical）、`unexpected`（对账时发现没经过 store 的改动，同时经 `onError` 上报）;`interrupt` 保留未用 | toMessageIndex、reason | 折叠指令，历史事件永不删除;正常运行的会话里没有 |
| `compaction/checkpoint` ✅ | agent `compactContextForRequest`（压缩产生新检查点的那一刻，经 `obs.sessionEvents`，子代理写进自己的文件）;session-turn 失败回滚时补写 | 裁剪水位推进或新摘要;turn 回滚恢复 turn 开始时的检查点 | checkpoint（完整检查点，回滚到没有检查点时为 null） | 投影取最后一份指向的消息都在投影里的检查点，无效则往前回退，遇到 null 或到头则没有;DB 镜像为 `session_context_checkpoints` 行 |
| `compaction/block` 💤 | 不再写入（旧 store `syncCanonical` 在 blocks 变化时写） | 旧 timeline 压缩块 | blocks 全量数组 + changed(blockId, lifecycle) | 只读的旧数据：投影取最新一份用于展示，不参与请求投影 |

## ② request-scoped（重建请求输入）

| type | 发射点 | 触发 | data 要点 | 重建规则 |
|---|---|---|---|---|
| `loop/start` ✅ | agent `Agent.run` 开头（早于 turn 开始的压缩;子代理写进自己的文件）；`runAgentLoop` 带事件句柄时在 `system/prompt`、`tools/set` 之后写 | 每次 agent loop 开始（会话每 turn 一次;交互式子代理每次输入一次） | requireThinkingForToolUse | 请求历史 = 此处的 canonical 投影与检查点;其后到 step/start 之间的事件是该 loop 的 entries |
| `injection/context` ✅ | ① agent-hooks `buildRequestUserContent` loop 首条 user 消息进请求时;② afterToolResults 队列拼接后;③ 迁移播种 🌱 | kind=dynamic（system-reminder 含记忆检索）、image_delegation、queued_merge;memory/memory_hint 仅迁移期从 run.log 抽取 | kind、content 原文、refs、messageId（被改写的请求消息）、blocks（queued_merge 拼接的 blocks，含排队图片，图片外置为 imageRef） | 带 messageId 的参与请求组装;投影 canonical 时忽略 |
| `request/message` ✅ | `AgentLoop`（调用方声明消息只进请求时，现为记忆提醒进行中;store `append` 把图片外置） | 记忆提醒阶段 loop 追加进请求的消息：提醒 prompt、提醒回复、提醒阶段的工具结果 | message 全量、reason=memory_nudge | 只追加进本 loop 之后的请求,不进 canonical,后续 turn 看不到 |
| `system/prompt` ✅ | persistence `ensureSessionPromptEvent`（hash 比对）：session-turn 每 turn 开始、persistSessionState;子代理由 spawn-agent 写 | 请求的 system 文本变化（prompt 重建、identityMemory 变化） | hash 与 chars（描述发出的 system = content + `\n\n` + identity）、content（静态系统提示词）、identity | getSystemPrompt;DB 列只存最新一份静态提示词，事件流保留谱系 |
| `tools/set` ✅ | session-turn `ensureToolsSetEvent`（turn 开始比对名字列表 hash，空列表也记） | 工具集变化 | hash、toolNames、count | getToolSet;完整定义由代码版本推导 |
| `step/start` ✅ | `AgentLoop`，`onCompletionStart` hook 之后 | 每次模型请求开始 | stepIndex、requestSpanId、model、messageCount、requestHash（`hashRequest`：system、工具名、传给 adapter 的消息，图片按内容 hash 归一） | **事件自身 seq 即请求重建锚点**，规则见 session-event-log.md「请求重建」;`hashRequest(assembleRequest(...))` 应等于 requestHash |
| `closure/start` ✅ | agent-hooks `onEndTurn` | closure 评估开始 | turnIndex、requestId、model、baseSeq、messageCount | 分类器看到的消息都在 baseSeq 之前;messageCount 对账;未评估不产生任何 closure 事件 |

## ③ diagnostics（时间线/排障）

| type | 发射点 | 触发 | data 要点 |
|---|---|---|---|
| `turn/start` ✅ | session-turn | 每 turn 开始 | turnIndex、trigger、model、agentName、baseSeq（本 turn 消息 seq 均大于它）;恢复时下一个 turn 编号 = 最大 turnIndex + 1 |
| `turn/end` ✅ | session-turn 成功/异常两条路径;恢复时 `sealInterruptedTurn` 补写 | turn 结束;进程在 turn 中途退出后恢复（最后一个 `turn/start` 之后没有 `turn/end`） | turnIndex、status(completed/failed/aborted)、durationMs;补写的封口为 status=failed、reason=process_restart |
| `step/end` ✅ | `AgentLoop`，`onCompletionEnd` hook 之前（调用方拒绝这次响应时也已写入） | 每次模型请求返回 | stepIndex、stopReason、requestId、usage、durationMs |
| `tool/call` ✅ | `AgentLoop`，`onToolCallStart` hook 之后;`WorkerTool.runRouterJob`（Router 的 Codex 派工，开始执行前）。两处都经 `journalToolCall` | 工具开始 | toolUseId、name、inputHash、inputPreview、spanId |
| `tool/result` ✅ | `AgentLoop`，`onToolCallEnd` hook 之后;`WorkerTool.runRouterJob`（结束或抛错时）。两处都经 `journalToolResult` | 工具返回 | toolUseId、name、status、durationMs、chars、summary |
| `compaction/prune` ✅ | agent-hooks `processAgentToolResults`（artifactize） | tool_result 内容真的被 artifact 引用替换时（只写了 evidence、原文仍在 canonical 的中等输出不发） | toolUseId、from(chars+hash)、to(artifact_ref)、evidence 指针 |
| `compaction/start` ✅ | agent `compactContextForRequest` | 请求前压力达到阈值且保留尾部之外有内容 | compactionId、trigger(turn_start/in_turn)、tokens、thresholdTokens |
| `compaction/end` ✅ | 同上 | 裁剪或摘要结束（紧跟在 `compaction/checkpoint` 之后） | compactionId、status(pruned/summarized/failed)、tokensBefore、tokensAfter、durationMs、usage、error |
| `closure/end` ✅ | agent-hooks `onEndTurn` 三条路径 | 决策产出 | action(finish/continue/block/discarded)、reason、model、requestId、assistantMessageId、durationMs;discarded 原决策在 detail;判定只记在这里，不写回 assistant 消息 |
| `memory/retrieval/start` ✅ | memory-retrieval `retrieveMemoriesWithDecision` | 检索 agent 侧循环开始（layer1 开场/layer2 工具失败后） | layer、turnIndex |
| `memory/retrieval/end` ✅ | 同上（成功/失败两路径） | 检索结束 | layer、status(injected/skipped/failed)、queries、searchCount、selected（id、title 必填、score）、durationMs、usage、error;status=injected 时 selected 就是记进会话已注入记忆表的记忆，恢复按它重建 |
| `memory/recorded` ✅ | agent-hooks `onToolCallEnd` memory 分支 | memory 工具 create/update 成功 | action、memoryId、memoryType、title、toolUseId |
| `model/selection` ✅（仅 1/4 触发点） | session `switchSessionModel` | /model 命令 | from、to(label/provider/modelId)、trigger=user_command、detail |
| `params/reasoning` ✅ | session-controllers `updateSessionReasoningEffort` | /think 变更 effort | from、to |
| `agent/inbox/enqueued` ✅ | session `handleSessionMessageEntry` 排队分支 | turn 进行中消息入队 | messageIndex（canonical 下标）、reason、interrupt |
| `agent/inbox/drained` ✅ | queueGate `injectQueuedMessagesIntoLastUserMessage` | loop 取走排队消息 | count |
| `agent/inbox/spliced` ✅ | 同上 | 拼进首条 user 消息 | strategy=inject_into_last_user、count |
| `job/registered` ✅ | `BackgroundToolTaskManager.run`（经 agent 的工具执行器） | 每次 bash 执行开始，紧跟该调用的 `tool/call` | jobId、toolUseId、toolName |
| `job/settled` ✅ | 同上;前台结束在 `run`，转后台后结束在 `completeTask` | bash 执行真正结束 | jobId、status(success/error)、durationMs、backgrounded、evidence（转后台且输出超过 8000 字符时，完整输出的落盘指针） |
| `subagent/spawn` ✅ | spawn-agent 工具，`agentControl.spawn` 成功之后;memory-retrieval `createLoopRunner`，检索 loop 开始之前 | 派生子代理，写在父会话事件流，位于 spawn_agent 的 `tool/call` 与 `tool/result` 之间;每次记忆检索 loop，位于 `memory/retrieval/start` 与 `end` 之间（name=`memory_retrieval`，role=layer） | childSessionId（即 agent_id;记忆检索为 `memory_<uuid>`）、name、role、spawnedByRequestId、logFile（子事件文件相对 logs 根的路径） |

job 只针对 bash。bash 执行超过 5 秒转后台（其他工具仍是 60 秒，且不落 job 事件）：转后台时
`tool/result` 立刻返回 `background_tool.started`，此时 jobId 就是 background task id；真正结束时先落
`job/settled`，再把 `background_tool.completed` 作为 control 消息送回会话。5 秒内结束的 bash 顺序是
`tool/call` → `job/registered` → `job/settled` → `tool/result`。事件流里有 `job/registered` 而没有对应
`job/settled` 的 job，就是仍在运行或因进程重启而丢失的 job。子代理与父会话共用同一个后台任务管理器，
它的 bash job 事件写在父会话文件里，对应的 `tool/call` 在子代理自己的文件里，用 toolUseId 关联。

Router 每次模型调用的子文件（`sessions/router-<日期>/`，见 [session-event-log.md](./session-event-log.md)「Router 的事件文件」）
也由 `runAgentLoop` 写，带历史的调用（Router 对话）在 `tools/set` 与 `loop/start` 之间把历史逐条写成消息事件；父目录没有
`session.jsonl`，不写 `subagent/spawn`。

记忆检索的子文件由 `runAgentLoop` 写：`session` 头之后是 `system/prompt`、`tools/set`、`loop/start`，然后是 loop 的
step、tool 与消息事件，每个 `step/start` 都能按「请求重建」还原。

子代理自己的事件写在 `logFile` 指向的文件里：`session` 头、`system/prompt`、`tools/set`，以及由同一套 agent hooks
发出的 `user/message` / `assistant/message` 和 step、tool 等过程事件。没有 `turn/*`，见
[session-event-log.md](./session-event-log.md)。子代理结束不另落事件，结果在父会话后续 `wait_agent` 的 `tool/result` 里。

## ⏸ 类型就绪、发射点未接

| type | 计划发射点 | 未接原因 |
|---|---|---|
| `llm/retry` | model 包 adapter 层（openai-resp transport、model-pool failover） | 需要 model 包回接事件流句柄 |
| `model/selection` 其余触发 | init（会话创建）、fallback（pool failover）、reload（配置热更）、route | 目前只有 user_command |
| `session/archive` | 会话归档/删除 | 待接入 |

## 消费方

| 消费 | 路径 |
|---|---|
| 会话恢复（权威） | `SessionManagerStore.restoreSessionById` → 先封口没封口的 turn，再 `store.projectForRestore()`:canonical 投影、检查点、最后一条 `system/prompt` 的 content、最大的 `turn/start.turnIndex`、`memory/retrieval/end`(injected) 折出的已注入记忆表;恢复不写其他事件;无事件文件回退 DB 并把快照写进事件流;`getMessagesFromDB` 只读投影;规则见 [session-log-replay.md](./session-log-replay.md)「恢复读什么」 |
| 请求重建 | `store.getRequestAssemblyInput(id, step/start 的 seq)`（或对事件数组调 `buildRequestAssemblyInput`）→ `assembleRequest` → `hashRequest` 与 `step/start.requestHash` 核对;规则见 [session-event-log.md](./session-event-log.md)「请求重建」 |
| 状态查询 | `getSystemPrompt` / `getToolSet` / `getLastSeq` |
| 迁移/校验 | scripts-diag convert（播种 session/system/prompt/user·assistant·truncate/compaction-block/injection）+ rebuild（事件→DB 派生行） |
| Web UI | 会话详情 `GET /api/sessions/:id` 的 `contextCheckpoint`：活会话取 `Session.getContextCheckpoint()`，否则 `getContextCheckpointFromDB` → `store.project()`，无事件文件回退 DB;请求详情重建仍待接（run.log raw 事件已删除） |
