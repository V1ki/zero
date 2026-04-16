# Cross-Provider / API Format Switching Checklist

本清单基于 `packages/model/src/adapters/*.ts`、`packages/model/src/router.ts`、`packages/model/src/stream.ts`、`packages/model/src/__tests__/*.ts`，以及必要的 `packages/core/src/session/session.ts`、`packages/core/src/agent/context.ts`、`packages/core/src/agent/compress.ts` 的真实实现整理。

目标是回答两个问题：

1. 在 ZeRo 的统一 `Message + ContentBlock` 抽象下，跨 provider / API 格式切换时真正会出什么问题。
2. 当前仓库已经覆盖了什么，哪些只覆盖了一半，哪些仍未覆盖或尚无实现。

## 1. Message / History 结构一致性

- 风险点
  - 同一段历史在 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 三种格式中的拆分粒度不同。
  - assistant 的 `tool_use` / user 的 `tool_result` 在 OpenAI 家族里会被拆成单独的 `tool` / `function_call_output` 项；Anthropic 则保留在 message content 中。
  - 非文本 block 如果在某一侧被丢弃，会导致 provider 切换后上下文含义变化。
- 当前代码现状
  - `AnthropicAdapter.convertMessages()` 会保留 user text/image/tool_result，与 assistant text/tool_use。
  - `OpenAIChatAdapter.convertMessages()` 会把 system 变成顶层 `system` message，把 user multimodal 变成 `content: parts`，把 tool_result 变成 `role: 'tool'`。
  - `OpenAIResponsesAdapter.buildInput()` 会把 system 变成 `role: 'system'` input item，把 tool_result 变成 `function_call_output`，把 image 变成 `input_image`。
  - 三个 adapter 都基于统一 `Message` 工作，基础结构转换是存在的。
- 需要的测试类型
  - `unit`
  - `integration`
- 建议测试场景
  - 文本 + tool_use + tool_result 完整回合在三种 API 间互转。
  - 文本 + image 的 user message 在三种 API 间都能保留。
  - assistant 文本 + tool_use 混合消息在 provider 切换后仍保持语义顺序。

## 2. System Prompt / Instructions 注入差异

- 风险点
  - Anthropic OAuth 模式会自动注入 Claude Code 身份提示；OpenAI Chat 用 `system` message；ChatGPT Responses 用顶层 `instructions`。
  - 如果同一个 system prompt 被重复注入，模型行为会偏移。
  - 如果 provider 默认 prompt 被覆盖或丢失，跨 provider 切换后行为会不连续。
- 当前代码现状
  - `AnthropicAdapter.buildSystem()` 在 OAuth 模式下会先注入 `"You are Claude Code, Anthropic's official CLI for Claude."`，再拼接请求级 `system`。
  - `OpenAIChatAdapter.convertMessages()` 会把 `req.system` 作为第一条 `system` message。
  - `OpenAIResponsesAdapter.buildInput()` 会把 `req.system` 变成 `role: 'system'` input。
  - `OpenAIResponsesAdapter.buildChatGptBody()` 现在使用 `instructions`，并在本次修复后调用 `buildInput({ ...req, system: undefined })`，避免 ChatGPT provider 上重复注入 system。
- 需要的测试类型
  - `unit`
  - `integration`
- 建议测试场景
  - Anthropic OAuth 下 provider 默认指令 + 用户 system 同时存在。
  - OpenAI Chat 切换后 system 仍在首条消息。
  - ChatGPT Responses 只走 `instructions`，不再重复出现在 `input`。

## 3. Tool Call / Tool Result 配对与 Dangling State

- 风险点
  - 半完成 turn 中常见 “assistant 发了 tool_use，但 tool_result 还没回来” 的 dangling 状态。
  - 跨 provider 直接重放 dangling tool call，容易让 OpenAI / Responses 重播无效函数调用，或者让 Anthropic 历史结构不合法。
  - orphan tool_result 也会污染后续上下文。
- 当前代码现状
  - `OpenAIChatAdapter.collectPairedToolCallIds()` 和 `OpenAIResponsesAdapter.collectPairedToolCallIds()` 都只序列化成对的 tool_use/tool_result。
  - 这会在 provider 切换时主动丢弃 dangling tool state，但保留同消息中的 assistant 文本。
  - `AnthropicAdapter.convertMessages()` 不做配对过滤，只按 unified history 原样转换。
  - `packages/core/src/agent/context.ts` 的 `mergeInterleavedQueuedMessages()` 会把夹在 tool_use 和 tool_result 之间的 queued user message 合并回 tool_result message，以满足 Anthropic 的结构要求。
- 需要的测试类型
  - `unit`
  - `integration`
- 建议测试场景
  - assistant 文本 + dangling tool_use 切换到 OpenAI Chat / Responses 时仅保留文本。
  - orphan tool_result 被忽略，不生成 tool/function_call_output。
  - queued message 插入 tool_use 与 tool_result 之间后，切换 provider 仍不破坏配对。

## 4. Reasoning / Thinking 内容继承

- 风险点
  - Anthropic 的 `thinking` 与 OpenAI Responses 的 `reasoning summary` 都不是统一 `Message.content` 的一部分。
  - 当前 unified history 没有 reasoning block 类型，跨 provider 切换时无法把上一 provider 的 reasoning 内容继续传给下一 provider。
  - 这意味着 reasoning 只能做观测与日志，不能作为可迁移上下文的一部分。
- 当前代码现状
  - `AnthropicAdapter.extractReasoningContent()` 从 `thinking` blocks 提取 reasoning 文本。
  - `OpenAIResponsesAdapter.parseResponse()` / `parseChatGptCompletion()` 会提取 reasoning summary 为 `reasoningContent`。
  - `collectStream()` 只聚合 text/tool_use/usage，不返回 reasoningContent。
  - `Message` 类型只有 `text | tool_use | tool_result | image`，没有 reasoning block，因此 reasoning 不会进入会话历史。
- 需要的测试类型
  - `unit`
  - `integration`
- 建议测试场景
  - Anthropic completion 能提取 `thinking`。
  - OpenAI Responses / ChatGPT SSE 能提取 reasoning summary。
  - 明确验证 “provider 切换后历史中不携带 reasoning block” 的当前行为，而不是假设可继承。

## 5. Stop Reason / Turn Completion 语义

- 风险点
  - 各 provider 的终止语义命名不同，如 `stop`、`tool_calls`、`end_turn`、`max_tokens`。
  - 某些 OpenAI 兼容接口会在出现 tool_calls 时仍返回 `finish_reason: 'stop'`。
  - 如果统一 stop reason 映射错误，agent 的 tool loop、空回复重试、turn closure 都可能出错。
- 当前代码现状
  - `AnthropicAdapter.mapStopReason()` 已映射 `end_turn` / `tool_use` / `max_tokens`。
  - `OpenAIChatAdapter.complete()` 如果响应中有 tool_calls，会覆盖 `finish_reason: 'stop'`，强制统一成 `tool_use`。
  - `OpenAIResponsesAdapter.parseResponse()` 只要 output 中存在 `function_call` 就返回 `tool_use`，否则 `end_turn`。
  - 本次修复后，`OpenAIResponsesAdapter.stream()` 也会在流式工具调用出现时把 done 的 `finishReason` 统一成 `tool_calls`。
- 需要的测试类型
  - `unit`
  - `integration`
- 建议测试场景
  - OpenAI Chat 返回 `stop` 但 message 中包含 tool_calls。
  - Anthropic `max_tokens` 统一到 `max_tokens`。
  - Responses completion/status=completed 但 output 中包含 function_call 时仍判定为 tool_use。

## 6. Streaming Event 聚合一致性

- 风险点
  - 统一流消费依赖 `tool_use_start` / `tool_use_delta` / `tool_use_end` 事件语义稳定。
  - 任一 adapter 漏发 start/end，会让 `collectStream()` 只能拿到文本，拿不到 tool_use。
  - reasoning delta、usage、finish reason 的差异如果没统一，会导致流式与非流式结果不一致。
- 当前代码现状
  - `AnthropicAdapter.stream()` 已输出统一的 text/reasoning/tool/use/done 事件。
  - `OpenAIChatAdapter.stream()` 已输出统一的 text/tool/done 事件。
  - `OpenAIResponsesAdapter.stream()` 原来标准 Responses 路径只发 `tool_use_delta`，不能被 `collectStream()` 还原；本次已修复为同时处理 `response.output_item.added`、`response.function_call_arguments.delta`、`response.output_item.done`。
  - `collectStream()` 目前只聚合 text/tool/usage，不返回 reasoningContent，也不暴露 finishReason。
- 需要的测试类型
  - `unit`
  - `integration`
- 建议测试场景
  - Anthropic、OpenAI Chat、OpenAI Responses 三种流都能被 `collectStream()` 还原出相同结构。
  - 标准 Responses 流式 function_call 被正确还原成 unified `tool_use`。
  - reasoning delta 在各 provider 上都能产出统一的 `reasoning_delta` 事件。

## 7. Context Window / Token Accounting / Compression

- 风险点
  - provider 切换后 `maxContext` / `maxOutput` 变化，旧历史可能超预算。
  - 不同 provider 的 token 账本字段不同，cache read/write、reasoning tokens 也不统一。
  - 如果 model 层不声明边界，而 session 层也不压缩，切换后可能直接请求失败。
- 当前代码现状
  - token usage 归一化在 `OpenAIChatAdapter.parseUsage()`、`OpenAIResponsesAdapter.parseUsage()`、`AnthropicAdapter.complete()/stream()` 中已有实现。
  - 真正的上下文预算检查和压缩不在 `packages/model`，而在 `packages/core/src/session/session.ts` 的 `switchModel()` 与 `packages/core/src/agent/agent.ts`。
  - `Session.switchModel()` 在切换到更小上下文窗口模型后，会计算新 budget，必要时调用 `compressConversation()`。
  - `packages/model` 本身没有“拒绝超上下文切换”的逻辑。
- 需要的测试类型
  - `unit`
  - `integration`
- 建议测试场景
  - session 在切到小窗口模型时触发压缩。
  - 跨 provider 切换前后 usage bucket 仍符合统一语义。
  - 明确测试当前行为是“压缩后继续”，而不是“在 model router 层拒绝”。

## 8. Multimodal Block 降级或保留策略

- 风险点
  - image block 在各 API 的表达完全不同。
  - 若某一 provider 不支持当前 block，系统需要明确是保留、降级还是拒绝，而不是悄悄丢失。
  - assistant 侧目前没有 image block，后续若扩展也容易发生不对称。
- 当前代码现状
  - `AnthropicAdapter.convertMessages()` 支持 user image -> Anthropic base64 image source。
  - `OpenAIChatAdapter.convertMessages()` 支持 user image -> `image_url` data URL。
  - `OpenAIResponsesAdapter.buildInput()` 支持 user image -> `input_image`。
  - 当前没有 provider 级 capability gate；如果配置了不支持 vision 的模型，model adapter 侧不会主动拒绝。
- 需要的测试类型
  - `unit`
  - `integration`
- 建议测试场景
  - 同一条 user text+image 在三种 API 间都能保留。
  - vision capability 缺失时记录当前实际行为。
  - 非 text block 与 tool_result 混合时顺序是否保持。

## 9. 中断恢复 / 半完成 Turn 切换

- 风险点
  - 中断经常发生在 tool_use 发出后、tool_result 返回前，或者 queued user message 插入中间。
  - 如果切换模型后直接重放原始历史，可能破坏 Anthropic 要求的相邻关系，也可能让 OpenAI 家族误重放函数调用。
- 当前代码现状
  - Anthropic / OpenAI Chat / Responses 都会只序列化成对的 tool_use/tool_result，避免重放 dangling tool call。
  - `mergeInterleavedQueuedMessages()` 专门处理 queued message 打断 tool_use -> tool_result 的情况。
  - `prepareConversationHistory()` 会进一步对老旧 tool_result 做渐进压缩，但不会生成新的 provider-specific repair。
  - model 层目前没有“半完成 assistant text + reasoning + tool call” 的复原抽象，只能依赖 unified message 的现有字段。
- 需要的测试类型
  - `unit`
  - `integration`
- 建议测试场景
  - 切换 provider 时 history 中存在 dangling tool_use。
  - queued message 夹在 tool_use 与 tool_result 之间后，再切换到 Anthropic。
  - tool_result 已存在时 continuation prompt 不应再次触发同一个工具。

## 10. Provider 默认行为差异与 Fallback 策略

- 风险点
  - ChatGPT provider 是 `openai_responses` 变种，但 auth、body 字段、默认 instructions 与普通 OpenAI Responses 都不同。
  - fallback 若只检查可解析性、不检查健康，会把路由切到不可用 provider。
  - 不同 provider 的默认行为不同，例如 Claude Code 注入、ChatGPT instructions、OpenAI Chat system message。
- 当前代码现状
  - `ModelRouter.fallback()` 会按 `fallbackChain` 顺序调用各 adapter 的 `healthCheck()`。
  - `OpenAIResponsesAdapter.healthCheck()` 对 ChatGPT provider 走 `completeFromChatGpt()`，普通 Responses 先试 responses API，再降级试 chat completions。
  - 本次新增测试已覆盖 “前两个 provider 不健康，fallback 落到第三个健康 provider”。
  - 当前 fallback 不考虑 capability 差异、上下文预算或历史兼容度，只看链路和健康检查。
- 需要的测试类型
  - `unit`
  - `integration`
- 建议测试场景
  - 前序 provider `healthCheck()` 失败时顺延到下一 provider。
  - ChatGPT unavailable 时切到 backup OpenAI provider。
  - fallback 后继续用同一份历史发起下一轮，验证行为稳定。

## 覆盖矩阵

| 维度 | 覆盖结论 | 依据 |
| --- | --- | --- |
| message/history 结构一致性 | 已覆盖 | `cross-provider-switch.test.ts` 已覆盖 text/tool_use/tool_result 基础互转；本次新增 `cross-provider-coverage.test.ts` 覆盖 text+image 保留。 |
| system prompt / instructions 注入差异 | 部分覆盖 | 之前仅单 adapter 零散覆盖；本次补了 Anthropic OAuth、OpenAI Chat system、ChatGPT instructions，但真实 API 切换后的端到端验证仍有限。 |
| tool call / tool result 配对与 dangling state | 已覆盖 | `anthropic`、`openai-chat.test.ts`、`openai-resp.test.ts` 都覆盖 paired filtering；本次补了跨 provider 下“保留文本、丢弃 dangling tool_use”。 |
| reasoning/thinking 内容继承 | 部分覆盖 | 单 adapter 提取 reasoning 已有测试；但 unified history 无 reasoning block，跨 provider 继承本身尚无实现，也无端到端覆盖。 |
| stop reason / turn completion 语义 | 部分覆盖 | Anthropic 映射已有；OpenAI Chat/Responses completion 逻辑有覆盖，但跨 provider / 流式 done 语义覆盖仍不全面。 |
| streaming event 聚合一致性 | 已覆盖 | 原有 Anthropic/OpenAI Chat/ChatGPT SSE 覆盖；本次补了标准 OpenAI Responses 流式 tool call 聚合，并修复实现。 |
| context window / token accounting / compression | 部分覆盖 | token parsing 在 model 包已有测试；真正的跨 provider 压缩发生在 core/session，model 包未覆盖端到端切换压缩。 |
| multimodal block 降级或保留策略 | 部分覆盖 | 本次已补 user image 在三种 API 的保留；但 capability-based 降级/拒绝还没有实现级测试。 |
| 中断恢复 / 半完成 turn 切换 | 部分覆盖 | dangling/orphan 有 adapter 级测试；queued message + provider 切换的端到端场景仍主要依赖 core/agent 测试，model 包不足。 |
| provider 默认行为差异与 fallback 策略 | 部分覆盖 | router fallback 健康检查本次已补；但 capability-aware fallback、context-aware fallback 仍未覆盖。 |

## 本轮识别出的主要缺口

1. ChatGPT Responses 之前会把同一个 `system` 同时放进 `instructions` 和 `input`，存在双重注入风险。本轮已修复。
2. 标准 OpenAI Responses 流式路径之前没有统一发出 `tool_use_start/end`，`collectStream()` 不能还原 tool call。本轮已修复。
3. reasoning/thinking 目前只能通过 `CompletionResponse.reasoningContent` 暴露，无法进入统一会话历史，因此“跨 provider 继承 reasoning”在抽象层面尚未实现。
4. 上下文窗口切换后的压缩逻辑主要在 `core/session`，不是 `packages/model`；如果只看 model 包测试，会误以为没有此能力。
5. multimodal 目前验证了“保留”，但尚未验证 capability 不匹配时应当“降级还是拒绝”。
6. fallback 目前只看 `healthCheck()`，不感知历史复杂度、工具能力、vision 能力或 reasoning 支持差异。

## 本轮新增/强化的测试方向

- system prompt / instructions 在 Anthropic OAuth、OpenAI Chat、ChatGPT Responses 上的注入差异。
- dangling tool turn 在 OpenAI Chat / OpenAI Responses 下的保守序列化行为。
- `tool_result` 为空、仅有 `outputSummary`、以及 `isError` 的跨 provider 处理。
- user image block 在三种 API 格式下的保留行为。
- 标准 OpenAI Responses 流式 tool call 的统一事件聚合。
- router fallback 在多个 provider 不可用时的切换行为。

## 结论

`packages/model` 的统一抽象已经能较稳定地承载 text、tool_use、tool_result、image 的跨 provider 切换；当前最主要的剩余结构性缺口不是“消息转换错了”，而是：

- reasoning 不能作为历史的一部分跨 provider 继承；
- capability-aware / context-aware fallback 还没有进入 router 决策；
- 上下文压缩逻辑更多位于 `core/session`，而不是 model 层本身。
