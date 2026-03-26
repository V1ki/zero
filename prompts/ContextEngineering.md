# ZeRo OS 上下文工程

> **文档关系说明**：本文档基于 [Architecture - 记忆模块] 的记忆架构和 [TechStack - Session 生命周期 / Provider Adapter 接口] 的实现框架，定义 System Prompt 的结构、上下文窗口的动态管理策略和记忆检索的调用设计。本文档中的 TypeScript 代码使用 camelCase，持久化层格式使用 snake_case，与 [TechStack - 命名规范] 保持一致。

---

## 核心原则

上下文是 Agent 唯一的"感知窗口"——模型只能看到被塞进上下文的内容。上下文工程的目标是在有限的 Token 预算内，让模型**在每一轮对话中都拥有做出正确决策所需的最小充分信息**。

三条指导原则：

1. **前置重要信息**。LLM 对上下文开头的注意力最强，越往后衰减越明显（Lost in the Middle 效应）。角色定义、关键约束、身份记忆放在前面，对话历史放在后面。
2. **正面指令优于负面禁止**。"先诊断再重试"比"不要盲目重试"更有效——LLM 更擅长遵循"做什么"而非"不做什么"。
3. **标注来源与可信度**。检索到的记忆、工具输出、系统通知都应标注来源，让模型自行判断权重，而不是把所有信息混为一团。

---

## 上下文总览

一次完整的 Agent 调用，上下文的组装结构如下：

```
┌─────────────────────────────────────────────────────────────┐
│                      System Prompt                           │
│                                                              │
│  ┌─ 静态层 ──────────────────────────────────────────────┐  │
│  │  角色定义（Role Block）                                │  │
│  │  行为规则（Behavior Rules）                            │  │
│  │  工具使用规则（Tool Rules）                             │  │
│  │  输出约束（Output Constraints）                         │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ 动态层 ──────────────────────────────────────────────┐  │
│  │  身份记忆 = 全局身份 + Agent 身份（Identity Block）     │  │
│  │  备忘录（Memo Block）                                   │  │
│  │  检索记忆（Retrieved Memory Block）                     │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                      Messages                                │
│                                                              │
│  [压缩摘要（如果触发过压缩）]                                 │
│  [对话历史 msg_1 ... msg_N]                                  │
│  [用户最新消息]                                               │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

System Prompt 通过 API 的 `system` 参数传入（Anthropic Messages API 的 `system` 字段 / OpenAI 的 `role: system` 消息），对话历史和用户消息通过 `messages` 数组传入。两者分开管理，互不侵占预算。

---

## System Prompt 结构

### 分区格式：XML 标签

System Prompt 内部使用 XML 标签分区。选择 XML 而非 Markdown 标题的理由：

1. XML 标签有明确的开闭边界，模型能精确识别每个区块的范围，不会出现 Markdown 标题层级混淆。
2. Anthropic 和 OpenAI 的官方 Prompt 指南均推荐 XML 标签做结构化分区。
3. 标签支持属性（如 `<memory type="runbook" confidence="0.92">`），可以在结构中携带元数据。

```xml
<role>
你是 ZeRo OS 的 Coder Agent，一个在 macOS 上自主执行任务的 AI Agent。
你擅长 TypeScript 全栈开发，使用 Bun 运行时。
</role>

<rules>
...行为规则...
</rules>

<tool_rules>
...工具使用规则...
</tool_rules>

<constraints>
...输出约束...
</constraints>

<identity>
  <global>...全局身份记忆...</global>
  <agent>...当前 Agent 身份记忆...</agent>
</identity>

<system-reminder>
  <new_skills>...新增 Skill 通知...</new_skills>
</system-reminder>
```

### 静态层

静态层在 Agent 生命周期内基本不变（除非用户修改配置或身份记忆自我进化）。

#### Role Block — 角色定义

精简、具体，不超过 200 tokens。开头几百 token 是注意力最集中的区域，每个词都要有信息量。

```xml
<role>
你是 ZeRo OS 的 {agentName}，一个在 macOS 上自主执行任务的 AI Agent。
{agentDescription}
你的工作目录是 .zero/workspace/{agentName}/，最终产出物放到 .zero/workspace/shared/。
</role>
```

`agentDescription` 来自 Agent 身份记忆文件（如 `preferences/agents/coder.md`）的摘要，运行时注入。保持一段话的长度，不展开细节——细节在后面的 Identity Block 中。

#### Behavior Rules — 行为规则

核心行为准则，所有 Agent 共享。规则用**祈使句**写，每条一行，便于模型逐条遵循：

```xml
<rules>
执行操作前先说明意图，让用户知道你打算做什么。
工具调用失败时先读错误信息做诊断，再决定重试或换方案。不盲目重复相同命令。
涉及不可逆操作（删除文件、覆写内容、格式化）时主动向用户确认。
遇到超出能力范围的问题时如实告知，不编造解决方案。
回复使用中文，技术术语可以用英文原文。
每完成一个阶段性目标后，更新备忘录中你自己的分区。
</rules>
```

规则数量控制在 **6-10 条**。过多的规则互相竞争注意力，反而降低遵循率。优先保留"违反后果最严重"的规则。

#### Tool Rules — 工具使用规则

紧跟工具定义注入。不放在 System Prompt 开头——放在模型"决定用哪个工具"的决策点附近，效果更好。

```xml
<tool_rules>
Read：优先使用 Read 查看文件内容，不要用 Bash cat。
Write：只在工作目录（.zero/workspace/{agentName}/）和共享目录（.zero/workspace/shared/）中写入。写入其他路径前必须确认。
Edit：修改文件前先 Read 确认当前内容，避免基于过期认知做编辑。
Bash：命令执行前检查是否命中熔断名单。长时间运行的命令（构建、测试）加 timeout。
Fetch：用 Fetch 读取网页、调用 API、下载内容。返回可读文本。如果页面需要 JavaScript 渲染或交互操作，通过 Bash 调用 agent-browser。
Task：拆分 SubAgent 时明确每个子任务的输入、输出和依赖关系。不要把含糊的大任务直接丢给 SubAgent。
</tool_rules>
```

实现上，Tool Rules 在 `buildSystemPrompt()` 中根据 Agent 当前可用的工具集动态生成——不可用的工具不出现对应规则，减少噪音。

**Skill 上下文注入**：当 Agent 需要使用 Skill（如 Browser Skill）时，对应 Skill 的 `SKILL.md` 内容按需注入到 `<tool_rules>` 或单独的 `<skill>` 标签中，教会 Agent 该 Skill 的工作流和命令模式。Skill 不占用固定预算，仅在被激活时动态注入。例如 Browser Skill 被激活后，Agent 的上下文中会出现 agent-browser 的命令模式（open/snapshot/click/fill/close），引导 Agent 通过 Bash 工具调用 agent-browser CLI。

#### Output Constraints — 输出约束

```xml
<constraints>
所有输出（聊天回复、文件写入、日志）不得包含密钥值。如需引用密钥，使用引用名（如 anthropic_api_key）。
代码修改后必须通过至少一种验证（类型检查、单元测试、手动执行）再报告完成。
单次回复不超过 2000 字，除非用户明确要求详细输出。
</constraints>
```

### 动态层

动态层在每次 Agent 调用时根据当前状态注入。

#### Identity Block — 身份记忆

对应 [Architecture - 身份记忆]。合并全局身份 + 当前 Agent 身份，用嵌套 XML 标签区分来源：

```xml
<identity>
  <global>
  用户偏好：中文沟通，技术讨论保留英文术语
  系统环境：macOS，Bun 运行时，TypeScript 全栈
  代码规范：Biome 格式化，strict TypeScript
  项目仓库：monorepo 结构，8 个 packages + 3 个 apps
  </global>

  <agent name="coder">
  技术栈：Bun + TypeScript，不使用 LangChain / Next.js
  代码风格：函数式优先，小函数，显式类型，避免过度抽象
  测试策略：真实 API 调用 + record-replay，不用 mock
  Git 规范：每次有意义的变更独立 commit，消息用英文祈使句
  </agent>
</identity>
```

身份记忆从 `preferences/global.md` 和 `preferences/agents/{agentName}.md` 读取。这两个文件是 Markdown + Frontmatter 格式（与其他记忆文件一致），但注入 System Prompt 时**只取正文内容**，不带 Frontmatter 元数据——元数据是给检索系统和 UI 用的，模型不需要看到。

#### System Reminder — 运行时提示

`<system-reminder>` 只用于 API 请求内的内部运行时提示，不落盘，不视为用户消息。当前该区块承载新增 Skill 通知和检索到的历史记忆，不包含时间或 memo。

```xml
<system-reminder>
  <new_skills>
    新增了以下 Skill，可通过 Read 工具读取 SKILL.md 获取详细指令：
    <skill name="browser" path="/path/to/SKILL.md">...</skill>
  </new_skills>
  <retrieved_memories>
    ...检索到的历史记忆...
  </retrieved_memories>
</system-reminder>
```

---

## System Prompt 组装

```typescript
// packages/core/src/agent/prompt.ts

interface PromptComponents {
  agentConfig: AgentConfig
  globalIdentity: string       // preferences/global.md 正文
  agentIdentity: string        // preferences/agents/{name}.md 正文
  memo: string                 // memo.md 全文
  retrievedMemories: Memory[]  // 检索结果
  currentTime: string
}

function buildSystemPrompt(components: PromptComponents): string {
  const {
    agentConfig, globalIdentity, agentIdentity,
    memo, retrievedMemories, currentTime,
  } = components

  const sections: string[] = []

  // ── 静态层 ──
  sections.push(buildRoleBlock(agentConfig, currentTime))
  sections.push(buildRulesBlock())
  sections.push(buildToolRulesBlock(agentConfig.tools))
  sections.push(buildConstraintsBlock())

  // ── 动态层 ──
  sections.push(buildIdentityBlock(globalIdentity, agentIdentity, agentConfig.name))
  sections.push(buildMemoBlock(memo))

  if (retrievedMemories.length > 0) {
    sections.push(buildRetrievedMemoryBlock(retrievedMemories))
  }

  return sections.join('\n\n')
}
```

各 `build*Block` 函数负责包裹对应的 XML 标签，返回纯字符串。不使用模板引擎——System Prompt 的结构足够简单，字符串拼接最透明、最易调试。

**热更新**：身份记忆和备忘录可能在 Session 存活期间被修改（用户编辑 memo、Agent 自我更新身份记忆）。每次 Agent 循环开始时重新读取文件并重建 System Prompt。如果内容发生变化，产生新的 Snapshot（[Architecture - 上下文快照]）。

---

## 上下文预算管理

### 预算分配模型

上下文窗口的总容量由当前模型决定（`maxContext`）。系统将其划分为**固定预算**和**弹性预算**两部分：

```
┌─────────────────────────────────────────────────────────────┐
│                    模型上下文窗口 (maxContext)                 │
│                                                              │
│  ┌─ 固定预算 ────────────────────────────────────────────┐  │
│  │  System Prompt（静态层 + 动态层）            ~8k       │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ 弹性预算 ────────────────────────────────────────────┐  │
│  │  对话历史 + 工具输出                         剩余空间   │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ 输出预留 ────────────────────────────────────────────┐  │
│  │  模型响应空间                                maxOutput │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

```typescript
// packages/core/src/agent/budget.ts

interface ContextBudget {
  /** 固定预算：System Prompt 各分区 */
  role: number              // 角色定义 + 行为规则
  toolRules: number         // 工具使用规则
  constraints: number       // 输出约束
  identity: number          // 身份记忆（全局 + Agent）
  memo: number              // 备忘录
  retrievedMemory: number   // 检索记忆

  /** 弹性预算：对话区 */
  conversation: number      // 对话历史 + 工具输出

  /** 预留：模型输出 */
  reserved: number          // = maxOutput
}

function allocateBudget(maxContext: number, maxOutput: number): ContextBudget {
  const reserved = maxOutput

  // 固定预算的上限（非实际占用，是各分区允许的最大 token 数）
  const fixedLimits = {
    role: 500,
    toolRules: 800,           // 6 个工具（Read/Write/Edit/Bash/Fetch/Task），每个约 100 tokens
    constraints: 300,
    identity: 3000,           // 全局 ~1k + Agent ~2k
    memo: 1500,               // 备忘录应保持精简
    retrievedMemory: 2000,    // Top 5 条，每条 ~400 tokens
  }

  const fixedTotal = Object.values(fixedLimits).reduce((a, b) => a + b, 0)
  // fixedTotal ≈ 8,100 tokens

  const conversation = maxContext - reserved - fixedTotal

  return { ...fixedLimits, conversation, reserved }
}
```

### 各模型的预算实际分配

| 模型 | maxContext | maxOutput | 固定预算 | 对话区 | 说明 |
|------|-----------|-----------|---------|--------|------|
| claude-opus | 200,000 | 32,000 | ~8k | ~160k | 对话区极宽裕 |
| claude-sonnet | 200,000 | 8,192 | ~8k | ~184k | 输出预留小，对话区更大 |
| gpt-4o | 128,000 | 16,384 | ~8k | ~104k | 充裕 |
| deepseek-r1 | 65,536 | 8,192 | ~8k | ~49k | 偏紧，需更积极压缩 |

对话区的可用空间在降级到小上下文模型时会显著收窄。模型切换时应检查当前对话历史是否超出新模型的预算，超出则立即触发压缩。

### 固定预算超限处理

正常情况下，各固定分区不会超限——角色定义和规则是手写的，身份记忆文件有容量管理（[Architecture - 容量管理]），备忘录设计上保持精简。但需要防御异常情况：

```typescript
function enforceFixedBudget(
  content: string,
  limit: number,
  label: string
): string {
  const tokens = countTokens(content)
  if (tokens <= limit) return content

  // 超限时截断并标注
  const truncated = truncateToTokens(content, limit - 50) // 留 50 tokens 给截断标记
  return `${truncated}\n\n[${label} 内容过长，已截断。原始长度 ${tokens} tokens，限制 ${limit} tokens。]`
}
```

截断标记让模型知道信息不完整，可以通过 Read 工具去读原始文件获取完整内容。

---

## 对话历史管理

### Messages 数组结构

对话历史通过 API 的 `messages` 数组传入，遵循 user/assistant 交替格式。工具调用嵌入在 assistant 消息中（`tool_use` content block），工具结果作为 user 消息返回（`tool_result` content block）。

一次典型的 Agent 循环在 messages 中的表现：

```
messages: [
  // ── 历史对话 ──
  { role: "user",      content: "帮我重构 provider.ts" },
  { role: "assistant", content: [
    { type: "text", text: "好的，我先看一下当前代码..." },
    { type: "tool_use", id: "tc_001", name: "Read", input: { path: "src/provider.ts" } }
  ]},
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "tc_001", content: "// provider.ts 文件内容..." }
  ]},
  { role: "assistant", content: [
    { type: "text", text: "代码结构清楚了，我来做以下修改..." },
    { type: "tool_use", id: "tc_002", name: "Edit", input: { path: "src/provider.ts", ... } }
  ]},
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "tc_002", content: "编辑成功" }
  ]},
  { role: "assistant", content: "重构完成。主要改动：..." },

  // ── 新消息 ──
  { role: "user", content: "测试一下能不能跑通" },
]
```

### 工具输出截断

工具输出是上下文膨胀的最大来源。一个 `bash ls -laR` 可能返回几万行，一个 `Read` 可能读到一个大文件。必须在 Tool 层就控制输出 token 数。

```typescript
// packages/core/src/tool/base.ts — 在 afterExecute 钩子中

const TOOL_OUTPUT_LIMITS: Record<string, number> = {
  Read: 8000,       // 文件内容，保留更多
  Write: 500,       // 写入结果，极简
  Edit: 1000,       // 编辑结果 + diff 摘要
  Bash: 4000,       // 命令输出
  Fetch: 6000,      // 网页内容（readability 提取后的 markdown）
  Task: 2000,       // SubAgent 结果摘要
}

function truncateToolOutput(
  tool: string,
  output: string,
): string {
  const limit = TOOL_OUTPUT_LIMITS[tool] ?? 4000
  const tokens = countTokens(output)
  if (tokens <= limit) return output

  // 保留头部和尾部，中间用省略标记
  const lines = output.split('\n')
  const headCount = Math.ceil(lines.length * 0.6)
  const tailCount = Math.ceil(lines.length * 0.2)
  const head = lines.slice(0, headCount).join('\n')
  const tail = lines.slice(-tailCount).join('\n')

  return [
    head,
    '',
    `... (输出已截断: 原始 ${tokens} tokens, 保留头尾约 ${limit} tokens)`,
    `... (该内容作为 tool_result 写入会话消息，并会记录到后续请求对应的 llm_request trace span)`,
    '',
    tail,
  ].join('\n')
}
```

截断策略偏向保留头部（60%）——命令输出的开头通常包含最重要的信息（错误消息、表头、状态摘要），尾部包含最终结果。中间的重复性输出（如大量文件列表）可以丢弃。

完整输出不进入全局 `events.jsonl`。`events.jsonl` 只保留便于扫描的事件摘要；需要追查完整执行路径时，模型应优先读取对应 Session 下的 `trace.jsonl`，必要时再回退到 legacy ledgers（`requests.jsonl` / `snapshots.jsonl` / `closure.jsonl`）——这是“上下文中放摘要，详情按需检索”的通用模式。

### 历史消息的工具输出递减

距离当前越远的对话轮次，其工具输出的价值越低。系统对历史消息中的工具输出做渐进式压缩：

```typescript
// packages/core/src/agent/context.ts

interface MessageWithMeta {
  message: Message
  turnIndex: number        // 对话轮次序号，0 = 最新
  toolOutputTokens: number // 该消息中工具输出的 token 数
}

function compressHistoricalToolOutputs(
  messages: MessageWithMeta[],
  currentTurn: number,
): Message[] {
  return messages.map(m => {
    if (m.message.role !== 'user') return m.message

    const age = currentTurn - m.turnIndex
    // 最近 3 轮保留完整工具输出
    if (age <= 3) return m.message
    // 3-8 轮前的工具输出截断为摘要
    if (age <= 8) return replaceToolResultsWithSummaries(m.message)
    // 8 轮以上的工具输出只保留状态（成功/失败）
    return replaceToolResultsWithStatus(m.message)
  })
}
```

```
距离当前的轮次     工具输出保留策略
─────────────────────────────────
 0 - 3 轮         完整保留
 4 - 8 轮         替换为 outputSummary（来自 ToolResult）
 9+ 轮            仅保留 "✓ 成功" / "✗ 失败 + 错误摘要"
```

这样做的效果：最近的操作上下文完整保留（模型需要看到最新的文件内容、命令结果），远期的操作只保留"做了什么、结果如何"的骨架（足够模型理解对话脉络），大幅节省 token。

---

## 对话历史压缩

当对话历史的 token 数接近弹性预算上限时，触发压缩。

### 触发条件

```typescript
function shouldCompress(
  conversationTokens: number,
  budget: number,
): boolean {
  return conversationTokens >= budget * 0.85 // 85% 阈值，留 15% 缓冲
}
```

85% 阈值的考量：留出缓冲应对下一轮工具调用可能产生的大量输出。如果压缩后紧接着一个返回 5000 tokens 的 Bash 命令，15% 缓冲能吸收这个峰值而不触发二次压缩。

### 压缩策略：滑动窗口 + 摘要

```
压缩前：
  [msg_1] [msg_2] ... [msg_30] | [msg_31] ... [msg_42]
  ←───── 历史区（压缩为摘要）──→  ←── 保留区（原文保留）──→

压缩后：
  [summary_msg]  [msg_31] ... [msg_42]
```

```typescript
// packages/core/src/agent/compress.ts

interface CompressionResult {
  summary: string           // 压缩摘要，作为第一条 user 消息注入
  retainedMessages: Message[]
  stats: {
    messagesBefore: number
    messagesAfter: number
    compressedRange?: string
  }
}

async function compressConversation(
  messages: Message[],
  conversationBudget: number,
  compressionModel: string,    // 用便宜模型做压缩
): Promise<CompressionResult> {

  // 1. 从后往前找保留区的起始点
  //    保留区占 70% 预算，留 30% 给摘要和缓冲
  const retainBudget = Math.floor(conversationBudget * 0.70)
  let retainedTokens = 0
  let splitIndex = messages.length

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = countTokens(messages[i])
    if (retainedTokens + msgTokens > retainBudget) break
    retainedTokens += msgTokens
    splitIndex = i
  }

  // 确保至少保留最近 4 轮（8 条消息）
  const minRetain = Math.max(0, messages.length - 8)
  splitIndex = Math.min(splitIndex, minRetain)

  const toSummarize = messages.slice(0, splitIndex)
  const retained = messages.slice(splitIndex)

  // 2. 用便宜模型生成摘要
  const summary = await generateSummary(toSummarize, compressionModel)

  return {
    summary,
    retainedMessages: retained,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: retained.length + 1, // +1 for summary
      compressedRange: `0..${splitIndex - 1}`,
    },
  }
}
```

### 摘要生成的 Prompt

摘要生成用独立的单轮调用，使用便宜模型（如 claude-haiku 或 gpt-4o-mini）：

```xml
<instruction>
将以下对话历史压缩为一段简洁的摘要。
摘要必须保留：
1. 用户的原始目标和意图
2. 已完成的关键操作及其结果
3. 当前的进展状态
4. 未解决的问题或待办事项
5. 重要的文件路径、变量名、错误信息等具体细节

摘要不需要保留：
- 工具调用的具体输入输出（保留结论即可）
- 寒暄和确认性对话
- 已被后续操作覆盖的中间状态

输出格式：纯文本，不超过 800 tokens。
</instruction>

<conversation>
{对话历史}
</conversation>
```

摘要作为一条特殊的 user 消息注入到保留区之前：

```typescript
const summaryMessage: Message = {
  role: 'user',
  content: `[以下是之前对话的摘要]\n\n${summary}\n\n[摘要结束，以下是最近的对话]`,
}
```

### 压缩与 Snapshot 的关系

每次压缩产生一条新的 Snapshot（写入 `trace.jsonl` 的 snapshot span；旧 `snapshots.jsonl` 仅保留兼容 fallback），记录压缩前后的消息数量、压缩范围、摘要内容。Session 层还会把压缩决策的上下文一并写入 `decision_context`，至少包含：

- `current_tokens`：压缩前估算的当前对话 token 数
- `conversation_budget`：本轮会话区预算

这样事后回放 Session 时不仅能看到“压缩发生了”，还能知道“为什么会压缩”。

---

## 排队消息注入

Agent 在 tool use loop 中执行任务时，用户可能发来新消息（查进度、补充约束、要求中断）。这些消息排入队列，在 tool 执行完毕后、下一次 LLM 调用前注入对话历史。整体流程和时机见 [Architecture - 消息排队]，本节定义注入格式和上下文工程策略。

### 注入位置

排队消息注入在 `tool_result` 之后、下一次 LLM 调用之前。在 messages 数组中的位置：

```
messages: [
  ...对话历史...
  { role: "assistant", content: [
    { type: "tool_use", id: "tc_005", name: "Bash", input: { command: "bun test" } }
  ]},
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "tc_005", content: "3 passed, 0 failed" }
  ]},
  ← 排队消息注入点
  { role: "user", content: "<queued_message>...</queued_message>" },
]
```

注入后 messages 中会出现两条连续的 user 消息（tool_result + queued_message）。Anthropic API 要求 user/assistant 严格交替——因此实现时将排队消息**合并到 tool_result 所在的 user 消息中**，作为额外的 text content block：

```typescript
// 实际注入方式：合并到最后一条 user 消息
{
  role: "user",
  content: [
    { type: "tool_result", tool_use_id: "tc_005", content: "3 passed, 0 failed" },
    { type: "text", text: "<queued_message>...</queued_message>" },
  ]
}
```

### 单条排队消息的包装格式

```xml
<queued_message>
以下是你执行任务期间用户发来的消息。请简短回应后继续执行之前的任务，不要中断当前工作流。
---
现在处理得怎么样了
</queued_message>
```

关键设计点：

1. **XML 标签包裹**：让 LLM 明确区分"这是插队消息"和"这是新的用户指令"。不用标签的话，LLM 可能把"现在处理得怎么样了"理解为一个全新的对话主题。
2. **系统指令嵌入**："请简短回应后继续执行之前的任务"——这是防止 LLM 回复后返回 `end_turn` 而不是继续 `tool_use` 的核心手段。"不要中断当前工作流"进一步强化。
3. **分隔线**：`---` 把系统指令和用户原文分开，让 LLM 能区分哪些是框架指令、哪些是用户实际说的话。

### 多条排队消息的合并格式

如果 Agent 执行一个耗时工具期间积累了多条排队消息，合并为一个 `<queued_messages>`（复数）标签：

```xml
<queued_messages count="2">
以下是你执行任务期间用户发来的 2 条消息。请统一简短回应后继续执行之前的任务。
---
[14:32] 现在处理得怎么样了
[14:35] 对了，别改 config.ts 那个文件
</queued_messages>
```

- 每条消息带时间戳前缀，让 LLM 理解消息的时序
- `count` 属性提示消息数量，帮助 LLM 规划回应结构
- 系统指令用"统一简短回应"而非"逐条回应"，避免 LLM 产生冗长的分条回复

### 兜底续接 Prompt

LLM 回应排队消息后可能返回 `end_turn`（认为对话结束了），导致任务静默中断。Agent 层的兜底机制：

```typescript
// packages/core/src/agent/agent.ts — tool use loop 中

if (response.stopReason === 'end_turn' && !this.isTaskComplete()) {
  // 任务未完成，但 LLM 停了——追加续接消息
  this.messages.push({
    role: 'user',
    content: [
      { type: 'text', text: CONTINUATION_PROMPT },
    ],
  })
  // 重新调用 LLM，最多续接 2 次
  continuationCount++
  if (continuationCount <= 2) continue
}
```

续接消息的内容：

```xml
<system_notice>
你刚才回应了用户的插队消息，但之前的任务尚未完成。请继续执行。
当前进度可参考上方的工具调用历史。
</system_notice>
```

用 `<system_notice>` 而非 `<queued_message>` 标签——语义不同，这是系统的提醒而非用户的消息。"当前进度可参考上方的工具调用历史"引导 LLM 回顾上下文而非从头开始。

### 任务完成判定

`isTaskComplete()` 的判断逻辑：

- LLM 最后一条消息**只有 text 内容**（没有 tool_use）且**内容包含明确的完成信号**（如"已完成"、"重构完成"、"任务结束"等）→ 视为完成
- LLM 最后一条消息包含 tool_use → 不可能走到这个分支（stop_reason 会是 `tool_use`）
- 以上都不匹配 → 视为未完成，触发续接

这个判断故意做得宽松（偏向"未完成"），因为误续接的代价很低（LLM 发现任务已经做完了会自然结束），而漏续接的代价很高（任务静默中断，用户不知道）。

### 预算影响

排队消息注入会占用对话区预算。单条排队消息（含 XML 包装和系统指令）约 100-150 tokens，多条合并后约 150-300 tokens。这个开销相对于对话区总预算（通常 50k+）可以忽略。

如果极端情况下用户在长时间执行期间发了大量排队消息（比如 10+ 条），合并后可能占用 500-800 tokens。此时对早期排队消息做截断——保留最新 5 条完整消息，更早的合并为一行摘要"[还有 N 条早期消息已省略]"。

---

## 记忆检索

### 调用时机

用户发消息后、Agent 主循环开始前，执行一次独立的检索调用（[Architecture - 工作记忆]）。

```
用户消息到达
  │
  ▼
┌──────────────────────────────────────────────┐
│  记忆检索（独立单轮调用，便宜模型）             │
│                                               │
│  输入：用户消息 + 身份记忆摘要                  │
│  输出：{ need: boolean, queries?: string[] }   │
│                                               │
│  不占用主 Session 的 messages 上下文            │
└──────────────────────────┬───────────────────┘
                           │
              need = true  │  need = false
              ┌────────────┤────────────┐
              ▼                         ▼
    向量检索 + Tag 过滤          跳过，不注入记忆
              │
              ▼
    Top N 结果注入 System Prompt
    的 <retrieved_memories> 区块
```

### 检索判断 + Query 生成合并

将"要不要检索"和"用什么 query 检索"合并为一次调用。两次调用的成本和延迟都翻倍，而这两个判断在语义上是强耦合的。

```typescript
// packages/memory/src/retrieval.ts

const RETRIEVAL_DECISION_PROMPT = `
<instruction>
分析用户消息，判断是否需要从记忆库中检索历史信息来辅助回答。

需要检索的情况：
- 用户提到"之前"、"上次"、"那个问题"等指代历史事件
- 任务涉及已有的 runbook、incident、decision
- 需要了解项目上下文或技术决策背景
- 用户问题与身份记忆中提到但未展开的内容相关

不需要检索的情况：
- 通用技术问题（"如何写 TypeScript 泛型"）
- 当前身份记忆已包含足够信息
- 简单的操作指令（"帮我创建一个文件"）
- 闲聊或确认性回复

返回 JSON，不要其他内容：
需要检索: {"need": true, "queries": ["检索关键词1", "检索关键词2"]}
不需要:   {"need": false}

queries 是用于语义检索的关键词短语，每个 query 聚焦一个检索意图，最多 3 个。
</instruction>

<identity_summary>
{身份记忆摘要，200 tokens 以内}
</identity_summary>

<user_message>
{用户消息}
</user_message>
`.trim()
```

检索判断使用便宜模型（在 `config.yaml` 中配置 `retrieval_model`，默认降级链中最便宜的模型）。单轮调用，延迟通常 < 500ms。

### 检索执行

当 `need = true` 时，对每个 query 执行向量检索 + Tag 过滤：

```typescript
async function executeRetrieval(
  queries: string[],
  options: RetrievalOptions = {},
): Promise<Memory[]> {
  const { topN = 5, confidenceThreshold = 0.6 } = options

  // 对每个 query 独立检索，合并去重
  const allResults: Memory[] = []
  for (const query of queries) {
    const embedding = await embed(query)
    const results = await vectorIndex.search(embedding, topN * 2)
    allResults.push(...results)
  }

  // 去重（同一 memory 可能被多个 query 命中）
  const unique = deduplicateById(allResults)

  // 过滤：只保留 verified 且 confidence 达标的
  const filtered = unique.filter(m =>
    m.status === 'verified' &&
    m.confidence >= confidenceThreshold
  )

  // 按相关度排序，取 Top N
  filtered.sort((a, b) => b.relevanceScore - a.relevanceScore)
  return filtered.slice(0, topN)
}
```

### 检索结果的格式化

注入 System Prompt 时遵循一个原则：**给模型足够的元数据来判断可信度，但不灌输过多原文**。

```typescript
function formatRetrievedMemories(memories: Memory[]): string {
  if (memories.length === 0) return ''

  const items = memories.map(m => {
    // 内容截断：每条最多 400 tokens
    const content = truncateToTokens(m.content, 400)
    return [
      `<memory type="${m.type}" confidence="${m.confidence}" id="${m.id}" updated="${m.updatedAt}">`,
      `标题：${m.title}`,
      `内容：`,
      content,
      `</memory>`,
    ].join('\n')
  })

  return `<retrieved_memories>\n${items.join('\n\n')}\n</retrieved_memories>`
}
```

---

## 记忆写入的上下文处理

写入管线的架构设计见 [Architecture - 记忆的写入]。本节定义写入流程中涉及的上下文工程：写入意图检测 Prompt、事件分类 Prompt、框架层拦截机制、和写入结果的上下文通知格式。

### 写入意图检测

写入意图的识别分两个层面，对应两种写入触发方式：

1. **框架层自动拦截**：在用户消息到达 Agent 前，检测简单的"记住 X"模式，自动执行写入。
2. **Agent 工具调用**：Agent 通过 MemoryWrite 工具主动写入，用于需要推理的复杂写入场景。

框架层处理轻量级写入（不消耗 Agent 推理轮次），Agent 工具处理重量级写入（需要上下文理解）。与读取端对称——读取端的记忆检索也是框架层做的独立调用，不是 Agent 自己检索。

### 框架层写入拦截

```
用户消息到达
  │
  ├──→ 正则快速匹配（无模型调用，延迟 < 1ms）
  │     匹配模式：/^(记住|记下|别忘了|以后|今后).+/
  │               /^我(喜欢|偏好|习惯).+/
  │               /(帮我|请)(记住|记录|记下).+/
  │
  │     未命中 → 用户消息正常传给 Agent，不拦截
  │     命中 ↓
  │
  ├──→ 便宜模型确认 + 提取（单轮调用，延迟 < 500ms）
  │     确认是写入意图 → 提取核心内容 + type 映射为 path/target
  │     否定（误匹配）→ 用户消息正常传给 Agent
  │
  │     确认 ↓
  │
  ├──→ 执行写入（Path A 或 B，由 Prompt 返回的 type 直接映射）
  │
  ├──→ 生成 system_notice 通知 Agent "已自动记录"
  │
  └──→ 用户消息正常传给 Agent（Agent 仍需回应用户）
```

关键设计点：

1. **两步过滤**：正则先过滤掉 90%+ 的非写入消息，只有命中正则的才调用模型确认。避免每条消息都做模型调用。
2. **拦截不阻断**：拦截后仍然将原始消息传给 Agent。Agent 需要回应用户"好的，已记住"，而 system_notice 告诉 Agent 不需要重复执行写入操作。
3. **不占用主 Session 上下文**：便宜模型确认是独立单轮调用，不进入主 Session 的 messages 数组。

### 写入拦截确认 Prompt

```typescript
// packages/memory/src/write-intent.ts

const WRITE_INTENT_PROMPT = `
<instruction>
分析用户消息，判断是否包含需要记录到记忆库的意图。

是记忆写入意图的情况：
- "记住我喜欢用 Vim"（用户偏好 → preferences）
- "以后部署前先跑测试"（行为规则 → agent identity）
- "别忘了明天有个会议"（待办事项 → memo）
- "记一下，这个 API 的 base_url 改了"（知识条目 → notes）

不是记忆写入意图的情况：
- "帮我记录一下这个函数的文档"（文档写入，不是记忆写入）
- "记得把这个文件保存一下"（文件操作指令）
- "我记得之前有个类似的问题"（回忆/检索意图，不是写入）

返回 JSON，不要其他内容：
是写入: {"write": true, "type": "global_pref|agent_pref|task_note|knowledge", "content": "提取的核心内容"}
不是:   {"write": false}

type 说明：
- global_pref: 用户个人偏好、沟通习惯、通用约束 → 写入 Path A (preferences/global.md)
  例："我喜欢用 Vim"、"中文沟通，技术术语保留英文"
- agent_pref: 针对特定 Agent 的行为规则、技术栈约束 → 写入 Path A (preferences/agents/{name}.md)
  例："以后部署前先跑测试"、"代码注释用英文"
- task_note: 当前任务相关的临时约束 → 写入 Path A (memo)
  例："别忘了明天有个会议"、"先别动 config.ts"
- knowledge: 事实性知识、技术细节 → 写入 Path B (notes)
  例："这个 API 的 base_url 改了"、"DeepSeek 的速率限制是 60 RPM"
</instruction>

<user_message>
{用户消息}
</user_message>
`.trim()
```

此 Prompt 与检索判断的 `RETRIEVAL_DECISION_PROMPT` 风格一致：单轮调用、便宜模型、返回 JSON。

### 事件分类 Prompt

用于 `user_request` 和 `agent_discovery` 等模糊事件的分类（确定性事件不需要模型调用）：

```typescript
// packages/memory/src/classifier.ts

const EVENT_CLASSIFY_PROMPT = `
<instruction>
将以下事件分类到正确的记忆写入路径。

Path A（身份记忆 / 备忘录）适合：
- 用户偏好、行为规则、Agent 工作模式
- 当前目标、任务状态、待办事项
- 需要同 Session 立即可见的约束

Path B（工作记忆库）适合：
- 故障案例、可复用修复步骤、架构决策
- 需要跨 Session 检索的知识
- 事实性信息、技术细节

返回 JSON，不要其他内容：
{"path": "A", "target": "global|agent|memo", "reason": "分类理由"}
或
{"path": "B", "target": "incident|runbook|decision|note", "reason": "分类理由"}
</instruction>

<event>
来源：{event_source}
内容：{event_content}
当前 Agent：{agent_name}
</event>
`.trim()
```

### Session 分析 Prompt

Session 结束时用便宜模型生成分析，驱动后续的跨路径写入流（[Architecture - Session 结束写入流]）：

```typescript
// packages/memory/src/lifecycle.ts

const SESSION_ANALYSIS_PROMPT = `
<instruction>
分析以下 Session 的完整对话历史，生成结构化的 Session 分析。

输出 JSON：
{
  "summary": "Session 总结，800 tokens 以内",
  "outcome": "success | partial | failed",
  "extractable": [
    {"type": "incident|runbook|decision", "title": "标题", "content": "内容", "tags": ["tag1"]}
  ],
  "preferenceUpdates": [
    {"target": "global|agent", "content": "需要更新的偏好内容"}
  ],
  "memoCleanup": ["可以从 memo 中删除的条目描述"]
}

extractable 提取规则：
- 遇到的错误 + 解决方案 → incident
- 可复用的操作步骤 → runbook
- 做出的架构或方案选择 → decision
- 没有值得提取的内容时 extractable 为空数组

preferenceUpdates 提取规则：
- 用户纠正了 Agent 的行为（如 "不要用 npm" → 更新 agent preferences）
- 用户表达了新的偏好（如 "代码注释用英文" → 更新 global preferences）
- 没有行为纠正时 preferenceUpdates 为空数组

memoCleanup 规则：
- 本 Session 完成的任务对应的 memo 条目可以清理
- 未完成的任务不清理
</instruction>

<conversation>
{对话历史}
</conversation>
`.trim()
```

此调用使用便宜模型，不占用主 Session 上下文。Session 结束后执行，不影响 Agent 响应延迟。

### 写入通知的上下文注入

#### system_notice 格式（框架层自动写入后）

框架层自动执行写入后，需要通知 Agent 两件事：(1) 已经自动记录了，(2) 不需要 Agent 重复执行写入。

```xml
<system_notice>
已自动记录到记忆库：
- 写入路径：{path_description}
- 内容摘要：{content_summary}
- 状态：{draft | verified}
你不需要重复记录此内容。请继续回应用户的消息。
</system_notice>
```

注入方式与排队消息注入一致（[排队消息注入]）：合并到当前 user 消息的 text content block 中。使用 `<system_notice>` 标签——与兜底续接 Prompt（本文档"排队消息注入"章节）使用的标签一致，语义为"系统生成的通知，非用户消息"。

#### MemoryWrite 工具结果格式

Agent 通过 MemoryWrite 工具写入时，结果作为 `tool_result` 返回：

```
写入成功。
- 路径：{Path A: preferences/global.md | Path B: incidents/inc_xxx}
- 标题：{memory_title}
- 状态：{status}，置信度：{confidence}
- 去重结果：{与 {existing_id} 合并 | 无重复，新建记录}
```

结果控制在 200 tokens 以内，遵循工具输出的 token 预算限制。

### 写入路由的两条路径

写入端有两种路由机制，各自独立，不要混淆：

1. **框架层拦截**（用户消息触发）：`WRITE_INTENT_PROMPT` 返回 type → `resolvePathAndTarget` 直接映射为 path/target。**不经过 EventClassifier**——框架层处理的是用户显式的"记住 X"请求，type 到 path/target 的映射是确定性的。
2. **程序化事件**（系统内部触发）：由 `EventClassifier.classify()` 路由。处理 `task_status_change`、`error_recurring` 等运行时事件。跨路径事件（`session_end`/`session_interrupt`）不经过分类器，由 `SessionLifecycle` 直接编排。

### 与记忆检索的对比

| 维度 | 记忆检索（读取端） | 记忆写入（写入端） |
|------|-------------------|-------------------|
| 调用时机 | 用户消息到达后、Agent 循环前 | 实时（框架层拦截或 Agent 工具调用） |
| 模型调用 | 便宜模型单轮（检索判断 + query 生成） | 便宜模型单轮（写入意图确认 / 事件分类） |
| 上下文注入 | 结果注入 System Prompt `<retrieved_memories>` | 通知注入 messages `<system_notice>` |
| 占用主 Session | 否（独立调用） | 否（便宜模型独立调用），仅 notice 占用少量 token |
| 无结果时 | 不注入空标签 | 不注入 notice |

---

## SubAgent 上下文

SubAgent 通过 Task 工具启动（[Architecture - 任务编排]），其上下文设计和主 Agent 有本质区别：SubAgent 是**任务导向的一次性执行者**，不需要完整的对话历史和身份记忆。

### 精简上下文结构

```
SubAgent 的 System Prompt:
┌─────────────────────────────────────────────────────────────┐
│  <role>                                                      │
│  你是 ZeRo OS 的 SubAgent，负责执行一项特定任务。             │
│  任务完成后输出结果，不需要与用户交互。                        │
│  </role>                                                     │
│                                                              │
│  <tool_rules>                                                │
│  （仅包含该 SubAgent 可用的工具）                              │
│  </tool_rules>                                               │
│                                                              │
│  <constraints>                                               │
│  （与主 Agent 相同的输出约束）                                 │
│  </constraints>                                              │
│                                                              │
│  <task>                                                      │
│  任务指令：{instruction}                                      │
│  工作目录：{workDir}                                          │
│  输出要求：{expectedOutput}                                   │
│  超时：{timeout}秒                                            │
│  </task>                                                     │
│                                                              │
│  <upstream_results>                                          │
│  （上游 SubAgent 的输出，如有依赖）                            │
│  </upstream_results>                                         │
└─────────────────────────────────────────────────────────────┘

SubAgent 的 Messages:
  （空，从第一轮开始）
```

### 与主 Agent 上下文的区别

| 维度 | 主 Agent | SubAgent |
|------|---------|----------|
| 身份记忆 | 全局 + Agent + 备忘录 | 不加载 |
| 检索记忆 | 每轮按需检索 | 不检索（任务信息由 instruction 提供） |
| 对话历史 | 完整维护 + 压缩 | 无历史，从空开始 |
| 工具集 | 完整 6 个 | 由 TaskNode 配置的子集 |
| 上游依赖 | 无 | 通过 `<upstream_results>` 注入 |
| 压缩 | 支持 | 通常不需要（任务应足够聚焦） |

SubAgent 的上下文精简意味着它能把更多 token 预算用在实际工作上。一个 64k 上下文的模型，主 Agent 可能只有 ~49k 对话区，但 SubAgent 能拿到 ~55k（省去了身份记忆、备忘录、检索记忆的开销）。

### 上游结果的格式化

```typescript
function formatUpstreamResults(
  results: Map<string, TaskResult>,
  dependsOn: string[],
): string {
  if (dependsOn.length === 0) return ''

  const items = dependsOn.map(depId => {
    const result = results.get(depId)
    if (!result) return ''
    // 上游结果截断为 2000 tokens，只传结论
    const output = truncateToTokens(result.output, 2000)
    return [
      `<upstream id="${depId}" status="${result.success ? 'success' : 'failed'}">`,
      output,
      `</upstream>`,
    ].join('\n')
  })

  return `<upstream_results>\n${items.join('\n\n')}\n</upstream_results>`
}
```

---

## 模型切换时的上下文迁移

当 Model Router 触发模型切换（用户手动切换或降级链自动降级）时，上下文需要迁移到新模型。

### 迁移检查清单

```typescript
async function migrateContext(
  session: Session,
  fromModel: ModelConfig,
  toModel: ModelConfig,
): Promise<void> {
  // 1. 检查 System Prompt 格式兼容性
  //    Anthropic 和 OpenAI 的 system 参数格式不同
  const newPrompt = rebuildSystemPrompt(session, toModel)

  // 2. 检查对话历史是否超出新模型的预算
  const newBudget = allocateBudget(toModel.maxContext, toModel.maxOutput)
  const currentTokens = countConversationTokens(session.messages)

  if (currentTokens > newBudget.conversation) {
    // 立即触发压缩，适配新模型的窗口
    await compressConversation(
      session.messages,
      newBudget.conversation,
      getCompressionModel(),
    )
  }

  // 3. 检查 Tool Schema 格式
  //    Anthropic 和 OpenAI 的工具定义格式不同，由 Provider Adapter 处理

  // 4. 产生 Snapshot 记录模型切换
  await createSnapshot({
    trigger: 'model_switch',
    fromModel: fromModel.alias,
    toModel: toModel.alias,
  })
}
```

### 跨协议的消息格式转换

消息在系统内部使用统一格式（[TechStack - Provider Adapter 接口] 中的 `Message` 和 `ContentBlock` 类型），由 Provider Adapter 负责在调用 API 时转换为厂商格式。模型切换时不需要转换历史消息——转换发生在 Adapter 的 `complete()` / `stream()` 调用时。

但有一个特殊情况需要注意：**Anthropic 和 OpenAI 对 tool_use / tool_result 的消息结构不同**。Anthropic 将 tool_use 作为 assistant 消息的 content block，OpenAI 使用独立的 tool_calls 字段。这些差异由 Adapter 在序列化时处理，内部统一格式不受影响。

---

## 调优参数汇总

所有可调参数集中在此，便于实验和迭代。

### System Prompt 预算

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `budget.role` | 500 tokens | 角色定义 + 行为规则 |
| `budget.toolRules` | 800 tokens | 工具使用规则 |
| `budget.constraints` | 300 tokens | 输出约束 |
| `budget.identity` | 3,000 tokens | 身份记忆（全局 + Agent） |
| `budget.memo` | 1,500 tokens | 备忘录 |
| `budget.retrievedMemory` | 2,000 tokens | 检索记忆（Top N） |

### 对话历史管理

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `compression.threshold` | 0.85 | 对话区占用达到预算的 85% 时触发压缩 |
| `compression.retainRatio` | 0.70 | 压缩后保留区占对话预算的 70% |
| `compression.minRetainTurns` | 4 | 压缩后至少保留最近 4 轮对话原文 |
| `compression.summaryMaxTokens` | 800 | 压缩摘要的最大 token 数 |
| `compression.model` | 降级链最便宜模型 | 用于生成压缩摘要的模型 |

### 工具输出

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `toolOutput.Read` | 8,000 tokens | Read 工具输出上限 |
| `toolOutput.Write` | 500 tokens | Write 结果上限 |
| `toolOutput.Edit` | 1,000 tokens | Edit 结果上限 |
| `toolOutput.Bash` | 4,000 tokens | Bash 命令输出上限 |
| `toolOutput.Fetch` | 6,000 tokens | Fetch 网页内容上限 |
| `toolOutput.Task` | 2,000 tokens | SubAgent 结果摘要上限 |
| `toolOutput.headRatio` | 0.6 | 截断时头部保留比例 |
| `toolOutput.tailRatio` | 0.2 | 截断时尾部保留比例 |

### 历史工具输出递减

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `history.fullRetainTurns` | 3 | 最近 N 轮保留完整工具输出 |
| `history.summaryRetainTurns` | 8 | N 轮内的工具输出替换为摘要 |
| `history.beyondSummary` | 仅状态 | 超出范围仅保留 ✓/✗ 状态 |

### 记忆检索

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `retrieval.model` | 降级链最便宜模型 | 检索判断使用的模型 |
| `retrieval.topN` | 5 | 返回的最大记忆条数 |
| `retrieval.confidenceThreshold` | 0.6 | 最低 confidence 门槛 |
| `retrieval.maxQueries` | 3 | 单次检索的最大 query 数 |
| `retrieval.perMemoryMaxTokens` | 400 | 每条检索结果的最大 token 数 |

### 记忆写入

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `write.intentModel` | 降级链最便宜模型 | 写入意图检测使用的模型 |
| `write.dedupHighThreshold` | 0.98 | embedding 相似度高于此值直接判定为重复 |
| `write.dedupLowThreshold` | 0.85 | embedding 相似度低于此值判定为不同 |
| `write.dedupModel` | 降级链最便宜模型 | 灰色区间去重判断使用的模型 |
| `write.inboxDefaultConfidence` | 0.3 | inbox 新条目的默认 confidence |
| `write.autoVerifyConfidence` | 0.7 | 自动升级为 verified 的 confidence 门槛 |
| `write.autoVerifyMinSessions` | 2 | 自动 verify 要求的最少确认 Session 数 |
| `write.sessionSummaryConfidence` | 0.8 | Session 总结的 confidence |
| `write.knowledgeExtractConfidence` | 0.6 | 提炼知识条目的初始 confidence |
| `write.interruptSummaryConfidence` | 0.5 | 中断 Session 部分总结的 confidence |
| `write.pathA.globalCapacity` | 1,000 tokens | preferences/global.md 容量上限 |
| `write.pathA.agentCapacity` | 2,000 tokens | preferences/agents/*.md 容量上限 |
| `write.pathA.memoCapacity` | 1,500 tokens | memo.md 容量上限 |
| `write.pathA.warnThreshold` | 0.90 | 容量警告阈值（超过则发出 system_notice） |

### SubAgent

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `subAgent.upstreamMaxTokens` | 2,000 | 每个上游依赖结果的最大 token 数 |

### 排队消息

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `queue.maxContinuationRetries` | 2 | 兜底续接的最大重试次数 |
| `queue.maxRetainMessages` | 5 | 合并注入时保留完整内容的最大消息条数，超出部分摘要化 |

---

## 设计决策记录

### 为什么用 XML 标签而不是 Markdown 标题

Markdown 标题（`## Role`）在短 System Prompt 中工作良好，但 ZeRo OS 的 System Prompt 包含多个嵌套层级（Identity 下有 global 和 agent、Retrieved Memories 下有多条记忆各带属性）。XML 标签的开闭边界更精确，属性可以携带元数据（confidence、type），嵌套结构不会和 Markdown 的标题层级冲突。实测中 Claude 和 GPT-4o 对 XML 分区的指令遵循率均高于 Markdown 分区。

### 为什么不在 System Prompt 中放对话历史摘要

有些系统把压缩后的摘要放在 System Prompt 中。ZeRo OS 选择放在 Messages 的第一条 user 消息中，原因是：

1. System Prompt 的每个分区都有明确语义（角色、规则、身份、记忆），压缩摘要和这些语义都不匹配。
2. 压缩摘要本质上是对话历史的一部分，放在 messages 中语义更自然。
3. 模型在处理 messages 时有明确的时间线意识（先看到摘要，再看到后续对话），放在 System Prompt 中会模糊这种时间线。

### 为什么检索判断和 Query 生成合并为一次调用

替代方案是两次调用：第一次判断"要不要检索"，第二次生成"用什么 query"。合并的理由：

1. 两个判断在语义上强耦合——决定"需要检索"的同时，模型已经在心理上形成了检索方向。
2. 省一次 API 调用，减少约 300-500ms 延迟。
3. 便宜模型（haiku 级别）完全有能力在一次调用中同时完成两个任务。

合并的风险是模型偶尔在 `need: false` 时仍然返回 queries，但这通过 JSON 解析时忽略 `need: false` 场景下的 queries 即可处理。

### 为什么固定预算而不是动态竞争

替代方案是让各分区动态竞争上下文空间（如身份记忆多时挤压对话历史）。选择固定预算的理由：

1. 可预测性。固定预算下每个分区的行为是确定的，排查"为什么模型忘了某个规则"时可以直接检查对应分区是否被截断。
2. 防止级联效应。动态竞争中，一个分区的膨胀会挤压所有其他分区，导致难以追踪的行为变化。
3. 倒逼内容精简。固定预算迫使身份记忆和备忘录保持精简——这本身是件好事，冗长的身份记忆会稀释模型的注意力。
