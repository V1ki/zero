# Session Event Log（session.jsonl）

每个会话一个 append-only 事件文件，作为会话 canonical 状态的权威记录：

```text
.zero/logs/sessions/<dateDir>/<sessionId>/session.jsonl
```

子代理有自己的事件文件：父会话目录下 `sub-<agentId>.jsonl`，header 带
`origin:"subagent"` 与 `parentSessionId` 血缘。`spawn_agent` 工具在派生时调用
`SessionEventStore.registerSubagent` 建立这份文件，并在父会话事件流里记一条 `subagent/spawn`
（带子文件的相对路径）。子代理的 `system/prompt`、`tools/set` 和 step、tool 等过程事件写进子文件，
不混入父会话。子代理仍在进程内运行，trace 和 usage 账本继续沿用父会话的 sessionId。

子文件也带子代理自己的 `user/message` / `assistant/message`：消息由 loop 经 `obs.sessionEvents`
在产生时写入，spawn_agent 把这个句柄重定向到子文件，下标从 0 开始。子文件没有 `turn/*`，子代理不经过 `Session`。
子代理消息里的图片写进父会话目录的 `images/`，与子文件放在一起。
子代理的结束状态不另落事件：结果由父会话后续 `wait_agent` 的 `tool/result` 承载。

记忆检索的 side loop 也用同样的子文件：每次检索 loop 一份 `sub-memory_<uuid>.jsonl`（header 的 `name` 为
`memory_retrieval`），父会话在 `memory/retrieval/start` 与 `end` 之间记一条 `subagent/spawn` 指向它。子文件里有
`system/prompt`、`tools/set`、`loop/start` 和 loop 的全部过程与消息事件，请求能按「请求重建」还原。

## Router 的事件文件

Router 的每次模型调用（`runTriggerModel`）写一份子文件，按天放在同一个目录：

```text
.zero/logs/sessions/router-<本地日期>/sub-<业务会话编号>.<uuidv7>.jsonl
```

- header 与子代理相同（`origin:"subagent"`、`source:"spawn"`），`parentSessionId` 是当天的目录名 `router-<日期>`（没有对应的
  `session.jsonl`），`name` 是调用的中文标签，`role` 是 usage 用途（如 `router_triage`）。文件由 `subagent-index.json` 索引。
- 内容由基座 `runAgentLoop` 写：`system/prompt`、`tools/set`，Router 对话传入的历史逐条写成 `user/message` /
  `assistant/message`，然后是 `loop/start` 和 loop 的全部事件。每个 `step/start` 都能按「请求重建」还原。
- 业务表里的会话编号是文件名去掉 `.<uuidv7>` 的前缀，同一个编号可能对应多份文件（重试、同一任务的多次分诊与调查、同一对话的多轮）：

  | 调用 | 业务会话编号 | 存在哪里 |
  | --- | --- | --- |
  | 分诊（个人线） | `trigger-<uuid>` | `trigger_routes.session_id` |
  | 分诊与 GitHub 调查（委托线） | 任务第一次分析时的 `mandate-<uuid>` | `mandate_tasks.session_id` |
  | ZeRo 派工执行、派工汇报 | `router-job-<派工编号>`、`router-job-<派工编号>-report` | 由派工编号推出 |
  | Router 对话 | `router-general`、`router-task-<任务编号>`、`router-event-<事件编号>`、IM 为 `router-im-…` | 由对话范围推出 |
  | 渠道任务追问 | `router-im-<受众摘要>` | 由受众推出 |
  | 写入确认、委托草案 | `router-write-check`、`commission-<uuid>` | 不存 |

- Codex 派工的每次执行也是这里的一份文件（`sub-router-job-<派工编号>.<uuidv7>.jsonl`，`role` 为 `codex_worker`），
  里面只有一对 `tool/call`、`tool/result`（`name: worker`），没有 `step/*` 和消息；Codex 的中间过程不落盘。
- 保留期：设置了 Router 正文保留期时，`ListenerRuntime` 每次清理业务表后调用 `SessionEventStore.deleteFilesBefore`，删除
  `router-*` 目录里最后写入早于截止时间的文件（含当天的 `run.log`）和对应的索引条目。没有设置保留期时一直保留。

## 设计原则

- **model-visible ⟺ logged**：凡是模型看到过的输入，都能从事件流重建；
  不进 canonical 的请求内容以 request-scoped 事件补记：注入（dynamicContext、图片委托、排队拼接）是
  `injection/context`，记忆提醒阶段的消息是 `request/message`。
- **事件分三类**：surface（投影源：`user/message`、`assistant/message`、
  `messages/truncate`、`compaction/checkpoint`，以及只读的旧数据 `compaction/block`）；
  request-scoped（重建某次请求输入）；diagnostics（纯排障，可裁剪）。
- **只有改变持久状态或不可重算的操作才落事件**：检查点在产生的那一刻落
  `compaction/checkpoint`；由 canonical 和检查点算出的请求投影（摘要替换前缀、
  裁剪水位前的超大 tool_result 只留头尾）不落，重放时按同一投影函数重算。
- **消息正文只存一份**：canonical 消息事件带全量 Message；过程事件
  （tool/call、tool/result）只带 hash/预览/evidence 指针；超大工具 IO 由
  evidence 文件承载。

## 文件不变式

1. 第 0 条事件必为 `type:"session"`（header，seq=0），其后 seq 严格递增。
2. seq 由 `SessionEventStore` 在写入时分配；turn mutex 保证单写者。
3. 读取器校验不变式，失败视为损坏文件：写入拒绝、投影返回 null，
   恢复路径回退 sessions.db 快照。

## 信封与事件目录

```jsonc
{"seq":0,"ts":"...","type":"session","data":{"v":1,"sessionId":"...","schemaVersion":1,"source":"feishu","channelId":"oc_..."}}
{"type":"turn/start","data":{"turnIndex":12,"trigger":"channel|control|queued_drain","model":"...","agentName":"..."}}
{"type":"turn/end","data":{"turnIndex":12,"status":"completed|failed|aborted","durationMs":83400}}  // 恢复时补写的封口另带 "reason":"process_restart"
{"type":"loop/start","data":{"requireThinkingForToolUse":false}}  // 每次 Agent.run 开始,早于 turn 开始的压缩
{"type":"step/start","data":{"stepIndex":3,"requestSpanId":"span_...","model":"...","messageCount":21,"requestHash":"sha256:..."}}
{"type":"step/end","data":{"stepIndex":3,"stopReason":"end_turn|tool_use|error|aborted","requestId":"resp_...","usage":{},"durationMs":12400}}
{"type":"tool/call","data":{"toolUseId":"toolu_...","name":"bash","inputHash":"sha256:...","inputPreview":"...","spanId":"span_..."}}
{"type":"tool/result","data":{"toolUseId":"toolu_...","name":"bash","status":"success","durationMs":9800,"chars":45210,"summary":"..."}}
{"type":"user/message","data":{"messageIndex":86,"message":{...canonical Message...},"hash":"sha256:..."}}
{"type":"assistant/message","data":{"messageIndex":87,"message":{...含 text/thinking/tool_use blocks...},"hash":"sha256:..."}}
{"type":"messages/truncate","data":{"toMessageIndex":86,"reason":"turn_failed|admin|recall|restore_repair|interrupt|unexpected"}}
{"type":"compaction/start","data":{"compactionId":"...","trigger":"turn_start|in_turn","tokens":151000,"thresholdTokens":134400}}
{"type":"compaction/checkpoint","data":{"checkpoint":{...ContextCheckpoint 全量,回滚到没有检查点时为 null...}}}
{"type":"compaction/end","data":{"compactionId":"...","status":"pruned|summarized|failed","tokensBefore":151000,"tokensAfter":41000,"durationMs":18000,"usage":{},"error":"..."}}
{"type":"compaction/block","data":{"blocks":[...TimelineCompactionBlock 全量...],"changed":{"blockId":"...","lifecycle":"created|reused|superseded"}}}  // 旧会话的只读数据,不再写入
{"type":"injection/context","data":{"kind":"dynamic|memory|memory_hint|queued_merge|image_delegation","content":"...原文...","messageId":"...被改写的请求消息","blocks":[...仅 queued_merge:拼接的 blocks...]}}
{"type":"request/message","data":{"message":{...只在请求里的 Message...},"reason":"memory_nudge"}}
{"type":"model/selection","data":{"from":"...","to":{"label":"...","provider":"...","modelId":"..."},"trigger":"init|user_command|fallback|reload|route"}}
{"type":"closure/start","data":{"turnIndex":12,"requestId":"resp_...","model":"..."}}
{"type":"closure/end","data":{"turnIndex":12,"action":"finish|continue|block|discarded","reason":"...","model":"...","requestId":"resp_...","assistantMessageId":"...","durationMs":4200}}
{"type":"memory/retrieval/start","data":{"layer":"layer1|layer2","turnIndex":12}}
{"type":"memory/retrieval/end","data":{"layer":"layer1","status":"injected|skipped|failed","queries":["..."],"searchCount":3,"selected":[{"id":"mem_...","title":"...","score":0.8}],"durationMs":1500,"usage":{"input":0,"output":0}}}
{"type":"memory/recorded","data":{"action":"create|update","memoryId":"mem_...","memoryType":"fact","title":"...","toolUseId":"toolu_..."}}
{"type":"system/prompt","data":{"hash":"sha256:...","chars":10303,"content":"...静态系统提示词...","identity":"...identityMemory..."}}  // hash/chars 描述实际发出的 system
{"type":"tools/set","data":{"hash":"sha256:...","toolNames":["read","bash","..."],"count":79}}
{"type":"params/reasoning","data":{"from":"medium","to":"high"}}
{"type":"agent/inbox/enqueued","data":{"messageIndex":91,"reason":"turn_in_progress","interrupt":true}}
{"type":"agent/inbox/drained","data":{"count":2}}
{"type":"agent/inbox/spliced","data":{"strategy":"inject_into_last_user","count":2}}
{"type":"compaction/prune","data":{"toolUseId":"toolu_...","from":{"chars":91000,"hash":"sha256:..."},"to":{"chars":120,"mode":"artifact_ref"},"evidence":{"path":"...","sha256":"..."}}}
{"type":"job/registered","data":{"jobId":"...","toolUseId":"toolu_...","toolName":"bash"}}
{"type":"job/settled","data":{"jobId":"...","status":"success|error","durationMs":41200,"backgrounded":true,"evidence":{"path":"...","sha256":"..."}}}
{"type":"subagent/spawn","data":{"childSessionId":"agent_...","name":"Worker","role":"researcher","spawnedByRequestId":"resp_...","logFile":"sessions/<dateDir>/<sessionId>/sub-agent_....jsonl"}}
{"type":"checkpoint","data":{"atSeq":94,"messageCount":148,"projectionHash":"sha256:..."}}
```

全部 36 种事件的发射点、触发条件与消费方式见 [session-events-reference.md](./session-events-reference.md);
类型定义在 `packages/shared/src/types/session-events.ts`。

系统提示词与工具集都是 model-visible 请求输入:`system/prompt`（请求的 system =
`content` + `\n\n` + `identity`（有 identityMemory 时）;这段文本的 hash 变化时发射，turn 开始时与
persistSessionState 都做比对）与 `tools/set`（turn 开始时比对名字列表 hash，空工具集也记）
都写在 turn 的第一个 step/start 之前;DB 的 sessions.system_prompt 列只存最新一份静态提示词，迁移时已播种为首个
事件（657 个有值会话）。`params/reasoning` 记录 /think 等入口的 effort 变更。

排队消息链路:入队时先写 `agent/inbox/enqueued`（带 canonical 下标），canonical 追加 'queued' 消息的同一刻
写它的 `user/message`;被 loop 消费拼进首条 user 消息时发
`agent/inbox/drained`+`agent/inbox/spliced`，拼接原文以 `injection/context`
（kind=queued_merge）落盘。canonical 中 messageType='queued' 的消息即排队原文。

工具输出降级:超大 tool_result 在进入 canonical 前被替换为 artifact 引用
（evidence 文件 + sha256），`compaction/prune` 记录替换前后体积与 evidence 指针。
只写了 evidence、原文仍留在 canonical 的中等输出不发 `compaction/prune`。

上下文压缩（[context-compaction.md](./context-compaction.md)）：agent 在压缩发生的那一刻经
`obs.sessionEvents` 写 `compaction/start` → `compaction/checkpoint` → `compaction/end`，都在随后的
`step/start` 之前；子代理写进自己的文件。投影的 `checkpoint` 取最后一份仍然有效的检查点。
检查点也镜像到 sessions.db 的 `session_context_checkpoints`（file-only 模式不写），无事件文件时从那里恢复。

memory 相关覆盖说明：检索决策是成对事件 `memory/retrieval/start|end`（end 带
queries、搜索数、选中记忆与是否注入，失败也落 end），检索 loop 本身的请求与工具调用在 `subagent/spawn` 指向的子文件里；注入原文落在
`injection/context`（kind=memory/memory_hint）；写入落在 `memory/recorded`；
memory 工具的完整调用过程仍由 `tool/call`+`tool/result` 承载。任务结束判断是
成对事件 `closure/start|end`：本 turn 未评估时不产生任何 closure 事件；
`discarded` 表示决策因排队消息被丢弃（原始决策在 detail.originalAction）。

### 请求重建（step/start 的 seq = S）

运行时与重放共用 `assembleRequest`（`packages/core/src/agent/request-assembly.ts`）；它的输入由
`buildRequestAssemblyInput(events, S)`（`@zero-os/observe`，只需要事件，`SessionEventStore.getRequestAssemblyInput`
是它的包装）从日志取得：

1. **所属 loop**：S 之前最近的 `loop/start`（seq = L）。`Agent.run` 每次开始时写一条，早于 turn 开始的压缩。
2. **history 与 checkpoint**：`projectUpTo(L)` 的消息与检查点，即 loop 开始时的 canonical 投影。
3. **system 与工具名**：S 之前最后一条 `system/prompt`（system = `content`，有 `identity` 时接上 `\n\n` + identity）
   与最后一条 `tools/set`。
4. **entries**：L 与 S 之间、按日志顺序的
   - `user/message` / `assistant/message`：loop 追加进请求的 canonical 消息。排队消息除外——紧跟在
     `agent/inbox/enqueued` 之后、下标等于其 `messageIndex` 的那条：它进 canonical，但原文是经 `queued_merge` 拼进请求的；
   - `request/message`：记忆提醒阶段只在请求里的消息；
   - 带 `messageId` 的 `injection/context`（dynamic、image_delegation、queued_merge；迁移播种的旧事件没有 `messageId`，不参与）；
   - `compaction/checkpoint`。
   loop 内出现 `messages/truncate`（turn 进行中的撤回原地改写了请求里的消息）时还原不出，返回 null。
5. **组装**：第一条消息之前，请求历史 = `prepareRequestMessages(history, 当时的检查点)`；message 追加到末尾；
   dynamic / image_delegation 按顺序作为前缀改写 `messageId` 那条消息（有图片委托时去掉它的图片）；queued_merge 把
   `blocks` 接到 `messageId` 那条消息末尾；已有消息之后的 checkpoint（turn 内压缩）从 history + 已追加的消息重新投影，
   并补回注入与排队拼接（同一条消息拼接多次时只补回最后一次，与运行时一致）。
6. **核对**：`hashRequest(assembleRequest(input)) == step/start.requestHash`。`requestHash` 覆盖 system、工具名和传给
   adapter 的消息（键排序 JSON 的 sha256）；图片换成 `{type, mediaType, sha256}`，sha256 是解码后字节的 hash
   （运行时取 `data`，日志与恢复后的消息取 `imageRef.sha256`，同一个 `decodeImageData`）。

turn 内压缩后运行时也经 `assembleRequest` 重建请求消息（它记下同样的 entries）；其余步骤 loop 逐条追加，
一致性由 `requestHash` 核对（`request-replay.test.ts` 对每个 step/start 做三方比对）。

仍还原不出的情形见 [session-log-replay.md](session-log-replay.md)。

### 上下文锚点（baseSeq）

`turn/start` 与 `closure/start` 都带 `baseSeq`（发射时刻事件流的最后一条 seq）：

- `turn/start.baseSeq`：本 turn 的消息事件全部落在 `seq > baseSeq`；区间终点是本 turn 的 `turn/end`。
- `closure/start.baseSeq` + `messageCount`：分类器评估时本 turn 已产生的消息都已写入，其输入 =
  `projectUpTo(baseSeq)` → 经 compaction 投影（确定性重放）+ 本 turn 的 injection 事件；
  `messageCount` 可做快速对账。

## 写入与读取

- 消息写入：**在产生的那一刻写**，入口只有 `SessionEventStore.appendMessage`（外置图片、按投影长度分配
  下标）。loop 产生的消息由 `AgentLoop` 在转给调用方之前写（记忆提醒阶段的消息不转给调用方，
  不进 canonical，写成 `request/message`）；turn 进行中排队的消息由 `queueMessage` 在追加进 canonical 时写。已写入的消息不再原地修改
  （任务结束判定只记在 `closure/end`，不再写回 assistant 消息的 `taskClosure`）。
- 改动已有消息的一方当场调用 `syncMessages(sessionId, messages, reason)`：前缀缩短时写
  `messages/truncate`，再追加之后的消息。原因：turn 失败回滚 `turn_failed`、尾部回滚命令 `admin`、
  外部消息撤回（原地改写一条旧消息）`recall`、恢复时封口没封口的 turn `restore_repair`。
- turn 结束（`persistSessionState`）：**事件流先写，DB 后写**。`syncCanonical` 只做对账，正常找不到消息差异；
  消息或压缩块自上一条 `checkpoint` 后有变化时补一条 `checkpoint`。对账发现差异说明有改动没经过 store：
  截断记 `unexpected`，与补写的消息一起经 `onError` 上报。历史事件永不改写。
- DB 的 `session_messages` 仍在 turn 结束时整体写入（file-only 模式不写），turn 内事件流领先于 DB，
  恢复优先读事件流。
- 读取：恢复（`SessionManagerStore.restoreSessionById`）读 `SessionEventStore.projectForRestore()`：投影加上最后一份
  系统提示词、最大的 turn 编号、已注入记忆表，会话元数据之外的状态都由重放得到，不读 trace 的请求记录、不读 DB 大字段
  （见 [session-log-replay.md](session-log-replay.md)「恢复读什么」）；`getMessagesFromDB` 等只读 `project()`。
  无事件文件（迁移前的旧会话）时回退 sessions.db 快照行。
- 双写等价性：store 在采样的 sync 上从磁盘重放并比对投影，不一致记
  `session_event_store_error`（events.jsonl）。

### 恢复时的修复

恢复不改写 canonical：面向 provider 的清理（排队消息并进 tool_result、DeepSeek 风格 adapter 的签名 thinking）
只在请求组装时做。恢复写事件只有下面两种情形。

- **没封口的 turn。** 进程在 turn 中途退出，日志里最后一个 `turn/start` 之后没有 `turn/end`。恢复
  （`SessionManagerStore.restoreSession` → `sealInterruptedTurn`）按 turn 失败的规则（`applyFailedTurnRollback`）
  处理 `turn/start` 之后写入的消息：没有已完成的 assistant 消息就回滚到 turn 开始时的消息数，排队消息保留；
  否则保留。回滚记 `messages/truncate`（`restore_repair`），本 turn 写过检查点时补写 turn 开始时的检查点，
  最后补 `turn/end`（`status: failed`，`reason: process_restart`）。封口过的 turn 不再处理。
- **没有事件文件的旧会话。** 从 DB 快照恢复时先写 header 并把快照消息写进事件流，之后的消息才能按下标即时追加。

### file-only 模式（终态）

环境变量 `ZERO_SESSION_STORE=file-only` 启用后：

- `session_messages` / `session_compaction_blocks` / `session_context_checkpoints` 不再写入；
  事件文件是唯一消息存储。
- sessions 元数据、channel_models、channel_session_bindings 等小行仍写 DB
  （可变、需索引的检索型数据）。
- DB 大字段降级为**可随时重建的派生索引**（dsh 模式）：需要时运行迁移脚本
  `rebuild` 模式从事件文件重建；损坏或丢失不影响正确性。

默认值 `dual`（双写观察期）。切换顺序：双写验证 → convert → 切 file-only →
purge。注意 purge 前必须已切 file-only，否则下次 persist 会把 DB 行写回。

## run.log 止血（本次同步变更）

- `llm_request.raw_request/raw_response`、`tool_call.raw_input/raw_result`
  四个全量事件已从 agent hook 删除；请求投影继续走 trace.jsonl 的
  llm_request span（systemHash/toolDefinitionsHash/messageCount 等）。
- 工具 span 载荷瘦身为有界预览（≤2048 字符）+ chars + outputSummary；
  完整工具 IO 由 `.artifacts/` evidence 文件承载。

## 旧数据迁移（一次性）

停服后使用 `scripts-diag/convert-session-logs.ts`：

```bash
bun scripts-diag/convert-session-logs.ts --dry-run   # 只读报告
bun scripts-diag/convert-session-logs.ts convert     # DB 快照+run.log 注入 → 事件文件,逐会话等价性校验
bun scripts-diag/convert-session-logs.ts purge       # 校验通过后:删 run.log、清 DB 大字段行、VACUUM
bun scripts-diag/convert-session-logs.ts rebuild     # 事件文件 → DB 大字段行(派生索引,可随时重跑)
```

可选 `--zero <dir>` 指定数据目录。convert 从 run.log 的 raw_request 中抽取
API-only 注入（`<system-reminder>`/`<memory_inject>`）转为 injection 事件；
请求正文不迁移（canonical 事件已覆盖模型可见消息）。purge 对没有有效事件
文件的会话跳过 DB 清理，不会丢数据。

## 后续（未实施）

- 事件文件轮转或 zstd 压缩、保留策略。
- `llm/retry`（适配器层）事件的发射点。
- 恢复会话时处理丢失的 job：有 `job/registered` 没有 `job/settled` 的 bash 执行在进程重启后不会再有完成事件。
- bash 以外的工具转后台时不落 job 事件，输出超过 8000 字符的部分也没有 evidence。
- web 日志查看器改为基于事件流的请求详情重建。
- DB 派生索引的检索增强（如 FTS，对齐 dsh 的 session-query-sqlite 角色）。
