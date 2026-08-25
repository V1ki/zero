# 片段级上下文压缩

## 当前数据流与风险

- `Session.processMessage()` 会从已持久化的 session 消息构造 `conversationHistory`，随后由 `Agent.run()` 准备这段历史并发送给模型提供方。
- `AgentLoop` 会把当前活跃 turn 保留在内存中，并在下一次模型调用前追加新的 `tool_use` / `tool_result` 消息。
- `Agent.processToolResults()` 已经会把特别大的工具输出转成 artifact；旧版 `prepareConversationHistory()` 还会原地修改历史 `tool_result` block。这样能减少 replay 体积，但有丢失 session DB 中原始证据的风险。
- Provider adapter 要求 `tool_use` / `tool_result` 必须合法配对。任何压缩方案都必须保留合法配对，或者把两侧一起移出并替换成文本摘要。
- `task_closure=block` 不是任务完成信号。最新/当前 turn 仍保持高保真；没有配对结果的 `tool_use` turn 会被明确排除在 episode 压缩之外。

## 数据结构

`ToolEvidence`

- 所在层：消息元数据、trace 请求记录、artifact 路径、UI 工具详情。
- 字段：`kind`、`sessionId`、`toolUseId`、`toolName`、`path`、`chars`、`bytes`、`sha256`，以及可选的 `summary`、`strategy`、`writeStatus`。
- 用途：指向精确的原始工具输入/输出，避免永远把完整 IO 内联 replay。

`TimelineCompactionBlock`

- 所在层：持久化 session 投影、API 响应、prompt replay、trace 生命周期、UI timeline。
- 字段：`id`、`status`、`strategy`、`strategyVersion`、`boundaryReason`、`summary`、`workingStateSummary`、`coveredMessageIds`、`coveredRange`、`coveredMessageCount`、`toolUseIds`、`evidence`、`createdAt`、`updatedAt`、`generation`、嵌套 `episodes`、可选语义 `topics`、可选解析器 `validation`、可选压缩 `model`，以及 supersede 关联。
- 用途：让压缩成为 timeline 上的一等对象，而不是隐藏在 prompt-time 的缓存里。规范 session 消息保持不变；block 只覆盖一段 message id，并在 prompt/UI 视图中投影覆盖这些消息。
- 生命周期：首次压缩某个 covered range 时发出 `created`；后续 turn 投影同一段 range 时为 `reused`；旧的 active block 被 recompact block 替代时为 `superseded`。新消息会老化成新的不可变 block，而不是原地扩展已有 block。

`TimelineCompactionTopic`

- 所在层：`TimelineCompactionBlock` 内部的嵌套语义结构，由 UI 渲染，并被 prompt replay 消费。
- 字段：`id`、`title`、`status`、`summary`、`sourceMessageRefs`、`sourceMessageIds`、`toolRefs`、`toolUseIds`，以及可选的事实、决策、当前状态、开放问题、下一步、证据和 `needsRawReview`。
- 用途：让压缩模型按问题/组件状态组织工作，而不是按原始 turn 顺序机械分组。当后续 turn 又回到早前话题时，一个 topic 可以引用 covered window 内非连续的 message refs。

`EpisodeCompaction`

- 所在层：`TimelineCompactionBlock` 内部的嵌套摘要，由 `ToolEvidence` artifact 文件支撑。
- 字段：`boundaryStrategy`、`boundaryReason`、`goal`、`scope`、`toolUseIds`、`confirmedFacts`、`inferredFacts`、`blockers`、`needsRawReview`、`evidence`、`messageIds`、`summary`。
- 用途：把旧的工具密集配对 turn 替换成语义片段，说明工具为什么被调用、实际检查或修改了什么、学到了什么、哪些内容是已确认/推断/阻塞，以及原始证据在哪里。
- 边界说明：v1 使用确定性的连续旧 turn 分组。schema 会显式记录该策略，这样未来的语义分类器可以只替换边界选择层，同时保留相同的证据指针。

`WorkingStateCompaction`

- 所在层：timeline compaction block 中的 `workingStateSummary`。
- 字段：`currentGoal`、`scope`、`confirmedFacts`、`nextAction`、`blockers`、`doNot`、`evidencePointers`、`sourceEpisodeIds`。
- 用途：在旧 episode 被压缩后，保留一个小而明确的当前任务控制面。

## 模型链路与 Prompt 契约

- `task_closure_model` 仍只负责任务闭合判断。上下文压缩有自己的可选配置 key：`context_compaction_model`。
- 压缩模型预期使用速度快、大上下文的模型，例如官方 DeepSeek v4 flash。
- 配置示例：

```yaml
context_compaction_model: deepseek/deepseek-v4-flash
```

- prompt 版本是 `context_compaction_zh_xml_n10_n08_n02_n09_v1`。它使用中文、只接受 XML 输出，并组合了已验证的方向：严格自检、组件/topic 边界优先、父子状态结构，以及面向未来上下文的可用性。
- 模型会收到稳定的 message refs（`E1`、`E2` 等）和 tool refs（`K1`、`K2` 等）。tool refs 包含工具名、tool use id、配对 message refs、结果状态、evidence 路径、hash 和有界预览。
- 小型工具结果会直接进入 `covered_messages`，供压缩模型分析。较大的 tool_result 会以截断原文（head/tail 保留，受 `compactionPromptToolResultMaxChars` 限制）加 evidence 指针进入 `covered_messages`，不再有独立的 digest 前置摘要调用。每个压缩 segment 只产生一次有界（`compactionModelTimeoutMs` 超时、4096 maxTokens）的压缩模型请求。
- Evidence 文件仍是审计/来源层。当 session 消息只携带 artifact 引用、原文被截断仍需回看，或主 compaction topic/episode 标记 `needs_raw_review` 时，可以用 evidence 文件恢复原始工具输出。
- 解析器校验会拒绝缺失 topics、非法 `K` 引用、`tool_refs` 中出现 `E` 引用、工具覆盖缺失，以及 message refs 缺失的输出。非法输出不会被接受为 prompt block。

## 压缩边界

- 活跃/最新 turn：保留完整工具历史；超大输出会用 artifact 引用加 `ToolEvidence` 表示。
- 较旧的配对工具 turn：在 prompt replay 中压缩为 episode summary。原始工具输入和输出写入 `.artifacts/<sessionId>/tool-evidence/`。
- 单 turn 尾部不会仅因为超过普通压缩字符水位就被压缩。它会等待另一个稳定 turn，除非超过 urgent 字符水位；这能避免每个老化 turn 都产生一个新 block。
- 中等大小的活跃 turn 工具输出如果超过单工具 prompt budget，但仍低于 64KB artifact 阈值，会在下一次模型请求中保留完整内容，并先写入原始 `ToolEvidence`，这样后续 replay 压缩可以引用原始 IO，而不是引用被截断的载体。
- 稳定的旧工具密集 turn 的原始 IO 会在主 compaction prompt 内截断（单 tool_result 上限 `compactionPromptToolResultMaxChars`，整段 transcript 上限 `compactionPromptTranscriptMaxChars`），完整原文始终可通过 evidence 文件回看。
- Handle 保留：tool_result 降级为 summary（截断到 `summaryMaxChars`）或 status（`✓ success` / `✗ failed`）时，会从原文提取有界的 exact handle（URL、路径、带扩展名文件名、命令 flag），以 `retained_handles:` 行附在降级内容后，受 `handleRetentionMaxHandles` / `handleRetentionMaxChars` 约束。这保证重度降级后，后续 turn 仍能引用之前产出的 artifact 路径。
- Timeline block 内嵌确定性 handle trail：block summary 在语义摘要之外附加一条 `retained_handles:` 行，由被覆盖的原始消息（tool_use 输入、tool_result、文本）按"最新优先"提取，受 `blockHandleRetentionMaxHandles` / `blockHandleRetentionMaxChars` 约束。该 trail 不依赖压缩模型质量，模型摘要遗漏 artifact 路径时仍可恢复引用。
- 主压缩请求受 `compactionModelTimeoutMs` 超时保护；超时、调用失败或输出校验不通过时，都会回落到确定性 fallback block（保留 evidence 指针），压缩链路不会因为模型失败而中断 turn。
- 未完成 turn：如果某个 `tool_use` 没有配对的 `tool_result`，它所在的 turn 不会被压缩。
- 阻塞 turn：以 `task_closure=block` 结束的 assistant 消息会携带 compact 元数据和分类原因，因此旧 replay 可以把该 episode 标记为 blocked，而不是压平成已完成工作。
- Provider 合法性：被压缩的旧 turn 会同时从 replay 中移除 `tool_use` 和 `tool_result`；保留的 turn 仍保持合法配对。
- 保守事实：`confirmed` 只表示工具 IO 已被捕获，或存在明确 blocker。assistant 文本和 success-result 的解释会保持在 `inferred` 中，除非有独立证据验证。
- Prompt 重放使用与 UI 相同的 block 投影：active block 插入在第一个 covered message id 的位置，所有 covered canonical messages 被跳过，未覆盖的近期消息保持高保真。
- 如果复用已有 block 后，投影历史仍然 block 过多或体积过大，agent 可以从原始 raw messages 和 tool evidence 构造新 generation block，并把旧 block 标记为 `superseded`。这避免了摘要的摘要继续被压缩。

## 可观测性

- `tool_result` block 可以携带 `evidence`。
- 请求 trace 中的 `toolCalls` / `toolResults` 会保留 evidence 指针。
- timeline compaction 发生时，Agent 会发出一个名为 `timeline_compaction_block` 的 `context_compaction` trace span，并写入 `context_compaction.block` run.log 事件。payload 包含 lifecycle、block id、generation、covered range、压缩前后 message 数、prompt chars/tokens、被压缩/保留的 message ids、episode 数、边界策略、跳过的未完成工具 id、聚合 evidence 统计、topic 数、validation 状态/错误、model/provider、prompt version、attempt count 和 supersede 关联。
- 模型调用会记录 `context_compaction.model_request`，以及 `context_compaction.model_response` 或 `context_compaction.model_invalid`。请求失败（含超时）会记录 `context_compaction.model_failed`。日志包含 prompt version、phase、model/provider、response size、validation details、可用时的 usage/cost，以及过滤后的 request/response payload。
- 活跃 turn 的工具输入/输出 evidence 写入仍会记录 `tool_evidence.persisted`。复用 compaction evidence 时，会把聚合信息写入 block trace event，而不是在每次 prompt replay 时为每个 evidence 指针重复发出 `tool_evidence.persisted`。
- Session detail 工具详情（Trajectory 视图）会在可用时渲染 evidence path、chars 和 sha256 前缀。
- Session detail Trajectory 视图会在 turn 之间渲染 COMPACTED 区块，状态与耗时来自 `context_compaction` trace span，compaction summary 在区块详情面板中查看。covered canonical messages 不再默认隐藏，仍按原始消息流完整显示在 ledger 中。

## 已知风险与扩展方向

- 物理 block 边界目前仍从稳定的旧 prompt window 开始；语义 topics 由模型生成，并且可以在 covered window 内合并非连续 refs。未来可以改进 selector，优化哪些 raw messages 进入 recompact window，同时不改变 evidence 或 topic schema。
- 没有 `ToolEvidence` 的既有 session，在其旧工具 turn 首次被压缩成 block 时会生成 evidence 文件。后续复用同一个 block 不会重复写这些 evidence 日志。
- Raw artifacts 可能包含敏感本地数据。`.artifacts/` 只属于运行时数据，并且已被 gitignore；不要把 evidence 文件移动到 tracked source 路径中。
