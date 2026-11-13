# 上下文压缩：检查点方案

这份文档定义主会话和子代理的上下文压缩。它取代了 timeline 压缩块方案和旧式的 `compressConversation`，
两者的代码已删除，旧会话里已有的压缩块只读展示。事件流约定见
[session-event-log.md](session-event-log.md)，整体方向见
[agent-loop-session-log-design.md](agent-loop-session-log-design.md)。

## 为什么换

旧方案有三层同时作用在历史上，彼此前提冲突：

- **按 turn 年龄触发。** 超过 3 个 turn 的历史就压缩，与上下文是否紧张无关。上下文还很空也会每隔几个 turn
  调一次压缩模型，每次新建压缩块都从历史靠前的位置打破 prompt 缓存。
- **阈值是固定字符数**，与模型窗口无关。真正按模型预算工作的只有旧式 `compressConversation`，它又是唯一覆盖
  turn 内的机制，所以删不掉。
- **产物臃肿。** 一个压缩块里模型实际看到的摘要约占 5%，其余是重复两份的 evidence 清单和 episode 记录。
  事件流每次变化重写全量数组，80 个 turn 的模拟里 `compaction/block` 占了文件的 97%。

## 方案

状态只有两样：**canonical 消息**（原文，不改）和**至多一个检查点**。

```ts
interface ContextCheckpoint {
  id: string
  sessionId: string
  /** 第一份为 1，每被新检查点取代一次加 1 */
  generation: number
  /** 到这条消息为止（含）的 tool_result 以裁剪形式进入 prompt */
  prunedThroughMessageId?: string
  /** 到这条消息为止（含）的消息由 summary 取代 */
  summarizedThroughMessageId?: string
  /** 与 summarizedThroughMessageId 同时存在 */
  summary?: string
  /** 被 summary 取代的 canonical 消息数 */
  coveredMessageCount: number
  tokensBefore: number
  tokensAfter: number
  model?: { model: string; provider: string; promptVersion: string }
  createdAt: string
}
```

### 投影

发给模型的消息是 `(canonical, 检查点)` 的纯函数，不修改输入，同样的输入得到同样的输出：

1. 有 `summary` 时，被取代的前缀换成一条 user 消息：一段固定前言加 `<context_checkpoint>` 包住的摘要。
2. 余下消息里，位置不晚于 `prunedThroughMessageId` 的 `tool_result`，内容超过上限的保留头尾、中间换成省略标记，
   并附上从原文提取的 `retained_handles`（沿用现有的 handle 提取）。
3. 其余消息原样进入。没有检查点时，历史原样进入。

检查点指向的消息不在 canonical 里时（turn 回滚、崩溃后恢复），这份检查点无效，见「回滚与恢复」。

低于压力阈值的会话不做任何处理：不裁剪、不摘要、不调模型。

### 触发

每次模型请求之前检查一次：turn 开始时，以及 turn 内每轮工具结果之后。切换模型不需要单独处理，下一次请求会按新模型的
窗口检查。

- 可用窗口 `U = maxContext − maxOutput`。
- 压力 = 系统提示词 + 工具定义 + 投影后消息的估算 token。
- 阈值 `U × 0.8`，保留预算 `U × 0.2`。两个比例放在 `CONTEXT_PARAMS` 里。
- 模型没有声明 `maxContext` 或 `maxOutput` 时不压缩（与旧式压缩相同）。

估算沿用 `estimateTokens`（按字符数）。用上一次响应的真实 input token 校准、以及 provider 报上下文溢出后压缩重试，
是后续工作。

### 压缩的两个阶段

压力达到阈值时：

1. **划定保留尾部。** 从最新消息往回累计，直到达到保留预算。分界点不能把 assistant 的 `tool_use` 和它的
   `tool_result` 分开。不论预算，尾部至少包含最后一条消息；它带 `tool_result` 时，连同发出对应 `tool_use` 的
   assistant 消息，模型还没看过的工具结果不会被摘要掉。尾部之外为空时什么都不做。
2. **裁剪（不调模型）。** 把 `prunedThroughMessageId` 推进到尾部之前的最后一条消息。重新估算，低于阈值就到此为止。
3. **摘要（调一次模型）。** 仍高于阈值时，把尾部之前的全部内容压成一份新摘要，输入是「上一份摘要 + 新进入范围的
   原始消息」。新检查点取代旧检查点，始终只有一份摘要加一段原文尾部。

两个水位都只前进不后退。裁剪水位落成状态而不是每次重算，是为了让已裁剪的内容在后续请求里保持不变，不反复打破缓存。

### 摘要请求

- 使用压缩模型（`context_compaction_model`，未配置时沿用现有的回退链）。
- 转写稿：按角色列出消息；`tool_use` 给出工具名和有界的输入；`tool_result` 超过上限时保留头尾；thinking 省略。
- 转写稿超过上限时分段滚动：先压第一段得到摘要，再把这份摘要和下一段一起压，直到全部处理完。
- 输出是固定小节的 Markdown，小节不能省，空的写「（无）」：用户请求与意图、关键概念、文件与代码、错误与修复、
  未完成事项、当前工作、下一步、关键上下文。要求保留确切的路径、命令、错误原文、标识符和数值，如实保留用户的
  纠正和明确指示，不提及压缩本身。输入里带上一份检查点时，合并仍然成立的内容、去掉过时的，不原样照抄。
- 摘要落库前过 `secretFilter`。
- 请求失败、超时或返回空文本时，检查点不变（裁剪水位的推进保留），失败记入事件流和日志，当前请求照常发出。
  不生成替代摘要。

### 事件

压缩相关的事件在发生的那一刻写入，不经过 turn 结束时的 diff：

| type | 类别 | data |
| --- | --- | --- |
| `compaction/start` | diagnostics | compactionId、trigger（`turn_start` / `in_turn`）、tokens、thresholdTokens |
| `compaction/checkpoint` | surface | checkpoint（完整的新检查点；turn 回滚到没有检查点时为 null） |
| `compaction/end` | diagnostics | compactionId、status（`pruned` / `summarized` / `failed`）、tokensBefore、tokensAfter、durationMs、usage、error |

`compaction/checkpoint` 是投影源：重放时取最后一份有效的检查点。`step/start` 之前的检查点已经在日志里，
所以 `projectUpTo(seq)` 加上投影函数（`prepareRequestMessages`）就是那次请求的消息。消息事件在产生时写入
（[session-log-replay.md](session-log-replay.md) 步骤 1），turn 内每次请求带的消息都在它的 `step/start` 之前，
指向本 turn 消息的检查点在重放时同样有效，原先「turn 内的请求要接上本 turn 的消息」的缺口已消失。
仍要另外补上的是只在请求里的内容：本 turn 首条 user 消息的注入（`injection/context`）和拼进去的排队原文；
记忆提醒阶段的请求还原不出，留给 session-log-replay 的步骤 2。

检查点同时镜像到 sessions.db 的 `session_context_checkpoints` 行（file-only 模式不写），没有事件文件的会话从这里恢复。

同时调整：

- `compaction/block`：不再写入。类型和读取保留，只用于展示旧会话里已有的压缩块。
- `compaction/summary`：删除，它对应的旧式压缩一并删除。
- `compaction/prune`：只在 `tool_result` 的内容真的被 artifact 引用替换时发。此前只要写了 evidence 就发，
  中等大小的输出没被替换也会记成 `artifact_ref`。

### 回滚与恢复

- **turn 失败回滚**：turn 内产生的检查点可能指向被回滚掉的消息。会话在回滚时把检查点恢复成 turn 开始时的那份，
  并补写一条 `compaction/checkpoint`（turn 开始时没有检查点则写 null）。
- **崩溃后恢复**：重放事件时，最后一份检查点指向的消息不在投影出的消息里，就回退到更早的、仍然有效的那份；
  都无效则视为没有检查点。
- **旧会话**：已有的 timeline 压缩块不再参与投影，历史按原文进入，压力够了由新方案重新压缩。旧块留在原来的事件和
  DB 行里。

### 展示

- API：`GET /api/sessions/:id` 在 `timelineCompactionBlocks` 之外返回 `contextCheckpoint`（没有时为 null）。活会话取
  `Session.getContextCheckpoint()`，其余取 `SessionManager.getContextCheckpointFromDB()`，与恢复同源：事件流投影优先，
  无事件文件回退 DB 行。
- 会话详情：右侧 Summary 的「Context Checkpoint」卡片和 Timeline 里排在最后一条被摘要消息之后的 `context_checkpoint`
  标记，显示代数、被取代的消息数、两个水位、tokens 前后、模型、创建时间和按 Markdown 渲染的摘要。
- Context Load 的 token 分布按投影计算：被摘要取代的消息不计入，摘要计为 Checkpoint，裁剪区的 `tool_result` 按裁剪后的
  长度计。投影函数经 `@zero-os/core/browser`（只依赖 `@zero-os/shared`）与运行时共用。
- Trajectory：每个 `context_checkpoint` span 是一段 COMPACTED，显示状态、耗时、模型、usage、cost 和新纳入摘要的消息数；
  产生当前检查点的那次附带摘要。旧会话的压缩块和 `timeline_compaction_block` span 照旧只读展示。

## 删除的东西

- timeline 压缩块的生成、重压缩和投影；`EpisodeCompaction`、`WorkingStateCompaction`、topics 及其校验。
- 按 turn 年龄的 `tool_result` 降级和按字符数的 prompt 压力降级。
- `compressConversation`，包括 loop 内和切换模型两处调用。
- 压缩时为每个工具调用补写 evidence 文件。执行时为超大输出写 evidence 的逻辑不变。
- 只服务于旧方案的参数和基准脚本。

## 实施步骤

| 步骤 | 内容 | 状态 |
| --- | --- | --- |
| 1 | 核心模块：检查点类型、投影、压缩两阶段、摘要请求，带单元测试，暂不接线 | 已完成 |
| 2 | 接线与清理：接入 `Agent` 和 loop、会话状态与持久化、事件；删除旧方案；更新文档 | 已完成 |
| 3 | Web 与 API：展示检查点，旧压缩块只读展示 | 已完成 |
| 4 | 基准脚本：删除只评估旧方案的脚本 | 已完成（随步骤 2） |

## 怎么判断有没有变好

- 上下文低于阈值的会话里，压缩模型调用次数为 0，发给模型的历史与 canonical 一致。
- 事件流里压缩相关事件的体积与摘要文本同量级。
- 任意一次请求的消息都能由 `projectUpTo(step/start 的 seq)` 加投影函数重建。
- 长 turn 内的压缩和 turn 之间的压缩走同一条代码路径。
