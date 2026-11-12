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

子文件目前不含 `user/message` / `assistant/message`，也没有 `turn/*`：消息事件现在由
`Session` 在 turn 结束时写入，子代理不经过 `Session`。等 loop 直接写消息事件
（[设计说明](agent-loop-session-log-design.md) 的步骤 3）之后，子文件会自动带上消息。
子代理的结束状态不另落事件：结果由父会话后续 `wait_agent` 的 `tool/result` 承载。

## 设计原则

- **model-visible ⟺ logged**：凡是模型看到过的输入，都能从事件流投影重建；
  API-only 注入（dynamicContext、memory 注入）以 `injection/context` 事件补记。
- **事件分三类**：surface（投影源：`user/message`、`assistant/message`、
  `messages/truncate`、`compaction/block`）；request-scoped（重建某次请求输入）；
  diagnostics（纯排障，可裁剪）。
- **只有改变持久状态或不可重算的操作才落事件**：确定性投影变换（如按 turn
  年龄的工具输出截断）不落，重放时按规则重算。
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
{"type":"turn/end","data":{"turnIndex":12,"status":"completed|failed|aborted","durationMs":83400}}
{"type":"step/start","data":{"stepIndex":3,"requestSpanId":"span_...","model":"...","messageCount":21}}
{"type":"step/end","data":{"stepIndex":3,"stopReason":"end_turn|tool_use|error|aborted","requestId":"resp_...","usage":{},"durationMs":12400}}
{"type":"tool/call","data":{"toolUseId":"toolu_...","name":"bash","inputHash":"sha256:...","inputPreview":"...","spanId":"span_..."}}
{"type":"tool/result","data":{"toolUseId":"toolu_...","name":"bash","status":"success","durationMs":9800,"chars":45210,"summary":"..."}}
{"type":"user/message","data":{"messageIndex":86,"message":{...canonical Message...},"hash":"sha256:..."}}
{"type":"assistant/message","data":{"messageIndex":87,"message":{...含 text/thinking/tool_use blocks...},"hash":"sha256:..."}}
{"type":"messages/truncate","data":{"toMessageIndex":86,"reason":"turn_failed"}}
{"type":"compaction/block","data":{"blocks":[...TimelineCompactionBlock 全量...],"changed":{"blockId":"...","lifecycle":"created|reused|superseded"}}}
{"type":"injection/context","data":{"kind":"dynamic|memory|memory_hint|queued_merge|image_delegation","content":"...原文..."}}
{"type":"model/selection","data":{"from":"...","to":{"label":"...","provider":"...","modelId":"..."},"trigger":"init|user_command|fallback|reload|route"}}
{"type":"closure/start","data":{"turnIndex":12,"requestId":"resp_...","model":"..."}}
{"type":"closure/end","data":{"turnIndex":12,"action":"finish|continue|block|discarded","reason":"...","model":"...","requestId":"resp_...","assistantMessageId":"...","durationMs":4200}}
{"type":"memory/retrieval/start","data":{"layer":"layer1|layer2","turnIndex":12}}
{"type":"memory/retrieval/end","data":{"layer":"layer1","status":"injected|skipped|failed","queries":["..."],"searchCount":3,"selected":[{"id":"mem_...","title":"...","score":0.8}],"durationMs":1500,"usage":{"input":0,"output":0}}}
{"type":"memory/recorded","data":{"action":"create|update","memoryId":"mem_...","memoryType":"fact","title":"...","toolUseId":"toolu_..."}}
{"type":"system/prompt","data":{"hash":"sha256:...","chars":10303,"content":"...完整系统提示词..."}}
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

全部 32 种事件的发射点、触发条件与消费方式见 [session-events-reference.md](./session-events-reference.md);
类型定义在 `packages/shared/src/types/session-events.ts`。

系统提示词与工具集都是 model-visible 请求输入:`system/prompt`（内容变化时发射，
persistSessionState 做 hash 比对）与 `tools/set`（turn 开始时比对名字列表 hash）
由此进入事件流;DB 的 sessions.system_prompt 列只存最新一份，迁移时已播种为首个
事件（657 个有值会话）。`params/reasoning` 记录 /think 等入口的 effort 变更。

排队消息链路:入队时 canonical 即追加 'queued' 消息（surface 事件）+
`agent/inbox/enqueued`（带 canonical 下标）;被 loop 消费拼进首条 user 消息时发
`agent/inbox/drained`+`agent/inbox/spliced`，拼接原文以 `injection/context`
（kind=queued_merge）落盘。canonical 中 messageType='queued' 的消息即排队原文。

工具输出降级:超大 tool_result 在进入 canonical 前被替换为 artifact 引用
（evidence 文件 + sha256），`compaction/prune` 记录替换前后体积与 evidence 指针。

memory 相关覆盖说明：检索决策是成对事件 `memory/retrieval/start|end`（end 带
queries、搜索数、选中记忆与是否注入，失败也落 end）；注入原文落在
`injection/context`（kind=memory/memory_hint）；写入落在 `memory/recorded`；
memory 工具的完整调用过程仍由 `tool/call`+`tool/result` 承载。任务结束判断是
成对事件 `closure/start|end`：本 turn 未评估时不产生任何 closure 事件；
`discarded` 表示决策因排队消息被丢弃（原始决策在 detail.originalAction）。

`step/start` 自身的 seq 是请求重建锚点：
`projectUpTo(seq) + 该请求的 injection 事件` 即该次模型调用的精确输入。

### 上下文锚点（baseSeq）

`turn/start` 与 `closure/start` 都带 `baseSeq`（发射时刻事件流的最后一条 seq）：

- `turn/start.baseSeq`：本 turn 消息事件尚未写入，全部落在 `seq > baseSeq`；
  区间终点 = 下一个 `turn/start.baseSeq` 或其后 checkpoint 的 `atSeq`。
- `closure/start.baseSeq` + `messageCount`：分类器评估时，本 turn 消息仍未持久化
  （persistState 在 turn 结束才执行），其输入 = `project(到本 turn 区间终点)` →
  经 compaction 投影（确定性重放）+ 本 turn 的 injection 事件；
  `messageCount` 可做快速对账。

## 写入与读取

- 写入（`persistSessionState`）：**事件流先写，DB 后写**。崩溃窗口内事件流最多
  比 DB 新，读端优先事件流不会读到旧数据。消息按前缀 diff 追加，回滚产生
  truncate 事件，历史事件永不改写。
- 读取（`SessionManagerStore.restoreSessionById` / `getMessagesFromDB`）：
  优先 `SessionEventStore.project()`，无事件文件（迁移前的旧会话）时回退
  sessions.db 快照行。
- 双写等价性：store 在采样的 sync 上从磁盘重放并比对投影，不一致记
  `session_event_store_error`（events.jsonl）。

### file-only 模式（终态）

环境变量 `ZERO_SESSION_STORE=file-only` 启用后：

- `session_messages` / `session_compaction_blocks` 不再写入；事件文件是唯一
  消息存储。
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
- 子代理事件文件里的消息事件（见上文，随 loop 直接写消息事件一起落地）。
- web 日志查看器改为基于事件流的请求详情重建。
- DB 派生索引的检索增强（如 FTS，对齐 dsh 的 session-query-sqlite 角色）。
