import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { type ProviderAdapter, computeCost } from '@zero-os/model'
import type { Tracer } from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  CompressionResult,
  Message,
  ModelPricing,
  ReasoningEffort,
  SecretFilter,
  TimelineCompactionTopic,
  TimelineCompactionValidation,
  ToolContext,
  ToolEvidence,
} from '@zero-os/shared'
import { estimateMessageTokens, generateId, now, toErrorMessage } from '@zero-os/shared'
import type {
  ContextCompactionModelInput,
  ContextCompactionModelOutput,
  ToolEnvironmentDigest,
} from './context'
import { CONTEXT_PARAMS } from './params'

export const CONTEXT_COMPACTION_PROMPT_VERSION = 'context_compaction_zh_xml_n10_n08_n02_n09_v1'

export const CONTEXT_COMPACTION_SYSTEM_PROMPT = [
  '你是 ZeRo OS 专用的 Context Compaction Model。',
  '你的任务是把一段已经稳定的会话历史压缩成可继续工作的语义状态，而不是拼接原始消息。',
  '必须区分用户明确要求、工具结果证据、模型推断和仍然未解决的问题。',
  '必须覆盖工具调用；大型 tool_result 可能先被压缩成 tool_environment_digest，请把 digest 当作局部环境观察证据，必要时引用 raw evidence path。',
  '只返回 XML，不要返回 Markdown、JSON 或额外解释。',
].join('\n')

export const TOOL_ENVIRONMENT_DIGEST_PROMPT_VERSION = 'tool_io_environment_digest_nl_v1'

const TOOL_ENVIRONMENT_DIGEST_SYSTEM_PROMPT = [
  '你是 ZeRo OS 专用的 Tool IO Environment Digest Model。',
  '你的任务是把局部 tool_use + tool_result 原始 IO 压缩成环境观察摘要。',
  '不要解释工具为什么被调用，也不要推断完整任务意图；这一层只描述工具实际运行、观察、产出和仍需回看的 raw evidence。',
  '路径、URL、ID、文件名、目录名、命令 flag、配置 key、模型名、函数名、类名属于 exact handle，必须尽量原样保留。',
  '输出简洁中文自然语言，不要 JSON、XML 或 Markdown fence。',
].join('\n')

interface MessageReference {
  ref: string
  id: string
  role: Message['role']
  messageType: Message['messageType']
  createdAt: string
}

interface ToolReference {
  ref: string
  toolUseId: string
  toolName: string
  messageRefs: string[]
  inputEvidence?: ToolEvidence
  resultEvidence?: ToolEvidence
  inputPreview?: string
  resultPreview?: string
  resultStatus: 'success' | 'error' | 'missing_result'
}

interface ContextCompactionReferenceIndex {
  messages: MessageReference[]
  tools: ToolReference[]
  messageByRef: Map<string, MessageReference>
  toolByRef: Map<string, ToolReference>
  toolRefByUseId: Map<string, ToolReference>
  toolDigestByUseId: Map<string, ToolEnvironmentDigest>
}

function buildContextCompactionReferenceIndex(
  input: ContextCompactionModelInput,
): ContextCompactionReferenceIndex {
  const messages = input.segment.map((message, index) => ({
    ref: `E${index + 1}`,
    id: message.id,
    role: message.role,
    messageType: message.messageType,
    createdAt: message.createdAt,
  }))
  const messageRefById = new Map(messages.map((item) => [item.id, item.ref]))
  const evidenceByKey = new Map(
    input.episode.evidence.map((item) => [`${item.toolUseId}:${item.kind}`, item] as const),
  )
  const toolByUseId = new Map<string, ToolReference>()

  for (const message of input.segment) {
    const messageRef = messageRefById.get(message.id)
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        const existing = toolByUseId.get(block.id)
        toolByUseId.set(block.id, {
          ref: existing?.ref ?? '',
          toolUseId: block.id,
          toolName: block.name,
          messageRefs: uniqueStrings(
            [...(existing?.messageRefs ?? []), messageRef].filter(Boolean),
          ),
          inputEvidence:
            block.evidence ??
            evidenceByKey.get(`${block.id}:tool_use_input`) ??
            existing?.inputEvidence,
          resultEvidence: existing?.resultEvidence,
          inputPreview: previewToolInput(block.input),
          resultPreview: existing?.resultPreview,
          resultStatus: existing?.resultStatus ?? 'missing_result',
        })
      }

      if (block.type === 'tool_result') {
        const existing = toolByUseId.get(block.toolUseId)
        toolByUseId.set(block.toolUseId, {
          ref: existing?.ref ?? '',
          toolUseId: block.toolUseId,
          toolName: existing?.toolName ?? 'unknown_tool',
          messageRefs: uniqueStrings(
            [...(existing?.messageRefs ?? []), messageRef].filter(Boolean),
          ),
          inputEvidence: existing?.inputEvidence,
          resultEvidence:
            block.evidence ??
            evidenceByKey.get(`${block.toolUseId}:tool_result_output`) ??
            existing?.resultEvidence,
          inputPreview: existing?.inputPreview,
          resultPreview: previewToolResult(block.content, block.outputSummary),
          resultStatus: block.isError ? 'error' : 'success',
        })
      }
    }
  }

  const tools = Array.from(toolByUseId.values()).map((tool, index) => ({
    ...tool,
    ref: `K${index + 1}`,
  }))
  const toolByRef = new Map(tools.map((tool) => [tool.ref, tool]))
  const toolRefByUseId = new Map(tools.map((tool) => [tool.toolUseId, tool]))
  const toolDigestByUseId = new Map<string, ToolEnvironmentDigest>()
  for (const digest of input.toolEnvironmentDigests ?? []) {
    for (const toolUseId of digest.toolUseIds) {
      toolDigestByUseId.set(toolUseId, digest)
    }
  }

  return {
    messages,
    tools,
    messageByRef: new Map(messages.map((message) => [message.ref, message])),
    toolByRef,
    toolRefByUseId,
    toolDigestByUseId,
  }
}

function previewToolInput(input: Record<string, unknown>): string {
  const serialized = JSON.stringify(input)
  if (serialized.length > CONTEXT_PARAMS.history.summaryMaxChars * 4) {
    return `raw tool input captured in evidence; chars=${serialized.length}`
  }
  return compactLine(serialized, 900)
}

function previewToolResult(content: string, outputSummary?: string): string {
  const summary = outputSummary?.trim()
  if (summary) return `output_summary=${compactLine(summary, 760)} raw_chars=${content.length}`
  if (content.length > CONTEXT_PARAMS.history.summaryMaxChars * 4) {
    return `raw tool_result included in covered_messages; chars=${content.length}`
  }
  return compactLine(firstUsefulLines(content, 5), 900)
}

function boundedJoin(items: string[], separator: string, maxChars: number): string {
  const included: string[] = []
  let total = 0
  for (const item of items) {
    const nextTotal = total + item.length + (included.length > 0 ? separator.length : 0)
    if (nextTotal > maxChars) break
    included.push(item)
    total = nextTotal
  }
  const omitted = items.length - included.length
  if (omitted > 0) included.push(`<omitted_messages count="${omitted}" />`)
  return included.join(separator)
}

function extractXmlElement(value: string, tagName: string): string | undefined {
  const match = value.match(new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`))
  return match?.[0]
}

function firstTagBody(value: string | undefined, tagName: string): string | undefined {
  if (!value) return undefined
  const match = value.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`))
  return match?.[1]?.trim()
}

function firstTagText(value: string | undefined, tagName: string): string | undefined {
  const body = firstTagBody(value, tagName)
  return body
    ? decodeXml(
        body
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
    : undefined
}

function parseAttributes(value: string): Record<string, string> {
  return Object.fromEntries(
    Array.from(value.matchAll(/([a-zA-Z0-9_:-]+)="([^"]*)"/g)).map((match) => [
      match[1],
      decodeXml(match[2] ?? ''),
    ]),
  )
}

function parseItemList(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const items = Array.from(value.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g))
    .map((match) =>
      decodeXml(
        (match[1] ?? '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      ),
    )
    .filter(Boolean)
  return items.length > 0 ? uniqueStrings(items) : undefined
}

function parseRefList(value: string | undefined): string[] {
  if (!value) return []
  return uniqueStrings(
    value
      .split(/[\s,;]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  )
}

function normalizeTopicStatus(value: string | undefined): TimelineCompactionTopic['status'] {
  if (value === 'completed' || value === 'in_progress' || value === 'blocked') return value
  return 'unknown'
}

function extractJsonObject(value: string): string | undefined {
  const withoutFence = value.replace(/```(?:json)?/g, '').trim()
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  return withoutFence.slice(start, end + 1)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value
    .map((item) => (typeof item === 'string' ? item.trim() : undefined))
    .filter((item): item is string => Boolean(item))
  return strings.length > 0 ? strings : undefined
}

function firstUsefulLines(value: string, maxLines: number): string {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join(' | ')
}

function escapeCdata(value: string): string {
  return value.replaceAll(']]>', ']]]]><![CDATA[>')
}

function compactLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, stableStringifyReplacer, 2)
}

function stableStringifyReplacer(_key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  )
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value?.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function readEvidencePayload(evidence: ToolEvidence | undefined): string | undefined {
  if (!evidence || !existsSync(evidence.path)) return undefined
  try {
    return readFileSync(evidence.path, 'utf-8')
  } catch {
    return undefined
  }
}

function truncateRawForCompaction(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false }
  const headChars = Math.floor(maxChars * 0.65)
  const tailChars = Math.floor(maxChars * 0.25)
  const omitted = value.length - headChars - tailChars
  return {
    text: [
      value.slice(0, headChars),
      '',
      `[tool_result_raw_omitted chars=${omitted}]`,
      '',
      value.slice(-tailChars),
    ].join('\n'),
    truncated: true,
  }
}

function sanitizeText(text: string, secretFilter?: SecretFilter): string {
  return secretFilter ? secretFilter.filter(text) : text
}

function extractResponseText(response: CompletionResponse): string {
  return response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}

function filterTraceValue(value: unknown, secretFilter?: SecretFilter): unknown {
  if (typeof value === 'string') {
    return secretFilter ? secretFilter.filter(value) : value
  }

  if (Array.isArray(value)) {
    return value.map((item) => filterTraceValue(item, secretFilter))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
        key,
        filterTraceValue(nestedValue, secretFilter),
      ]),
    )
  }

  return value
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars - 3)}...`
}

export function parseContextCompactionModelOutput(
  value: string,
  input?: ContextCompactionModelInput,
): ContextCompactionModelOutput | undefined {
  const xml = extractXmlElement(value, 'context_compaction')
  if (!xml) return parseLegacyJsonOutput(value, input)

  const refs = input ? buildContextCompactionReferenceIndex(input) : undefined
  const summary = firstTagText(xml, 'block_summary') ?? firstTagText(xml, 'summary')
  const topics = parseTopics(xml, refs)
  const userConstraints = parseItemList(firstTagBody(xml, 'user_constraints'))
  const doNotInfer = parseItemList(firstTagBody(xml, 'do_not_infer'))
  const validation = validateParsedOutput(
    {
      summary,
      topics,
    },
    refs,
  )

  if (!summary) return undefined

  return {
    summary,
    topics,
    validation,
    confirmedFacts: uniqueStrings(topics.flatMap((topic) => topic.confirmedFacts ?? [])),
    userConstraints,
    decisions: uniqueStrings(topics.flatMap((topic) => topic.decisions ?? [])),
    currentState: uniqueStrings(topics.flatMap((topic) => topic.currentState ?? [])),
    openQuestions: uniqueStrings(topics.flatMap((topic) => topic.openQuestions ?? [])),
    nextActions: uniqueStrings(topics.flatMap((topic) => topic.nextActions ?? [])),
    doNotInfer,
    keyEvidence: uniqueStrings(topics.flatMap((topic) => topic.evidence ?? [])),
  }
}

export function isContextCompactionModelOutputUsable(
  output: ContextCompactionModelOutput | undefined,
): output is ContextCompactionModelOutput {
  return Boolean(output?.summary && output.validation?.status !== 'failed')
}

function parseTopics(
  xml: string,
  refs: ContextCompactionReferenceIndex | undefined,
): TimelineCompactionTopic[] {
  const topicsBody = firstTagBody(xml, 'topics') ?? xml
  const topicMatches = Array.from(topicsBody.matchAll(/<topic\b([^>]*)>([\s\S]*?)<\/topic>/g))

  return topicMatches.map((match, index) => {
    const attrs = parseAttributes(match[1] ?? '')
    const body = match[2] ?? ''
    const sourceMessageRefs = parseRefList(attrs.message_refs ?? firstTagText(body, 'message_refs'))
    const toolRefs = parseRefList(attrs.tool_refs ?? firstTagText(body, 'tool_refs'))
    const sourceMessageIds = refs
      ? sourceMessageRefs.flatMap((ref) => {
          const message = refs.messageByRef.get(ref)
          return message ? [message.id] : []
        })
      : []
    const toolUseIds = refs
      ? toolRefs.flatMap((ref) => {
          const tool = refs.toolByRef.get(ref)
          return tool ? [tool.toolUseId] : []
        })
      : []

    return {
      id: attrs.id?.trim() || `T${index + 1}`,
      title: firstTagText(body, 'title') ?? `Topic ${index + 1}`,
      status: normalizeTopicStatus(attrs.status),
      summary: firstTagText(body, 'summary') ?? '',
      sourceMessageRefs,
      sourceMessageIds,
      toolRefs,
      toolUseIds,
      confirmedFacts: parseItemList(firstTagBody(body, 'confirmed_facts')),
      decisions: parseItemList(firstTagBody(body, 'decisions')),
      currentState: parseItemList(firstTagBody(body, 'current_state')),
      openQuestions: parseItemList(firstTagBody(body, 'open_questions')),
      nextActions: parseItemList(firstTagBody(body, 'next_actions')),
      evidence: parseItemList(firstTagBody(body, 'evidence')),
      needsRawReview: attrs.needs_raw_review === 'true',
    }
  })
}

function validateParsedOutput(
  parsed: {
    summary?: string
    topics: TimelineCompactionTopic[]
  },
  refs: ContextCompactionReferenceIndex | undefined,
): TimelineCompactionValidation {
  const errors: string[] = []
  const warnings: string[] = []

  if (!parsed.summary?.trim()) errors.push('missing_block_summary')
  if (parsed.topics.length === 0) errors.push('missing_topics')
  if (parsed.topics.length > 12) warnings.push('topic_count_gt_12')

  const expectedToolRefs = refs?.tools.map((tool) => tool.ref) ?? []
  const expectedMessageRefs = refs?.messages.map((message) => message.ref) ?? []
  const expectedToolRefSet = new Set(expectedToolRefs)
  const expectedMessageRefSet = new Set(expectedMessageRefs)
  const coveredToolRefs = uniqueStrings(parsed.topics.flatMap((topic) => topic.toolRefs))
  const coveredMessageRefs = uniqueStrings(
    parsed.topics.flatMap((topic) => topic.sourceMessageRefs),
  )
  const invalidToolRefs = coveredToolRefs.filter((ref) => !expectedToolRefSet.has(ref))
  const invalidMessageRefs = coveredMessageRefs.filter((ref) => !expectedMessageRefSet.has(ref))
  const missingToolRefs = expectedToolRefs.filter((ref) => !coveredToolRefs.includes(ref))

  for (const topic of parsed.topics) {
    if (!topic.summary.trim()) errors.push(`topic_${topic.id}_missing_summary`)
    if (topic.sourceMessageRefs.length === 0) errors.push(`topic_${topic.id}_missing_message_refs`)
    if (topic.toolRefs.some((ref) => ref.startsWith('E'))) {
      errors.push(`topic_${topic.id}_has_message_ref_in_tool_refs`)
    }
  }

  if (invalidToolRefs.length > 0) errors.push(`invalid_tool_refs:${invalidToolRefs.join(',')}`)
  if (invalidMessageRefs.length > 0)
    errors.push(`invalid_message_refs:${invalidMessageRefs.join(',')}`)
  if (missingToolRefs.length > 0) errors.push(`missing_tool_refs:${missingToolRefs.join(',')}`)

  return {
    status: errors.length > 0 ? 'failed' : 'passed',
    promptVersion: CONTEXT_COMPACTION_PROMPT_VERSION,
    topicCount: parsed.topics.length,
    expectedToolRefs,
    coveredToolRefs,
    invalidToolRefs,
    missingToolRefs,
    expectedMessageRefs,
    coveredMessageRefs,
    invalidMessageRefs,
    errors,
    warnings,
  }
}

function parseLegacyJsonOutput(
  value: string,
  input?: ContextCompactionModelInput,
): ContextCompactionModelOutput | undefined {
  const jsonText = extractJsonObject(value)
  if (!jsonText) return undefined

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>
    const summary = asString(parsed.summary)
    if (!summary) return undefined
    const refs = input ? buildContextCompactionReferenceIndex(input) : undefined
    const sourceMessageRefs = refs?.messages.map((message) => message.ref) ?? []
    const sourceMessageIds = refs?.messages.map((message) => message.id) ?? []
    const toolRefs = refs?.tools.map((tool) => tool.ref) ?? []
    const toolUseIds = refs?.tools.map((tool) => tool.toolUseId) ?? []
    const topic: TimelineCompactionTopic = {
      id: 'T1',
      title: 'Legacy JSON compaction',
      status: 'unknown',
      summary,
      sourceMessageRefs,
      sourceMessageIds,
      toolRefs,
      toolUseIds,
      confirmedFacts: asStringArray(parsed.confirmedFacts),
      decisions: asStringArray(parsed.decisions),
      currentState: asStringArray(parsed.currentState),
      openQuestions: asStringArray(parsed.openQuestions),
      nextActions: asStringArray(parsed.nextActions),
      evidence: asStringArray(parsed.keyEvidence),
      needsRawReview: true,
    }

    return {
      summary,
      topics: [topic],
      validation: {
        status: 'legacy',
        promptVersion: CONTEXT_COMPACTION_PROMPT_VERSION,
        topicCount: 1,
        expectedToolRefs: toolRefs,
        coveredToolRefs: toolRefs,
        invalidToolRefs: [],
        missingToolRefs: [],
        expectedMessageRefs: sourceMessageRefs,
        coveredMessageRefs: sourceMessageRefs,
        invalidMessageRefs: [],
        errors: [],
        warnings: ['legacy_json_output'],
      },
      confirmedFacts: asStringArray(parsed.confirmedFacts),
      userConstraints: asStringArray(parsed.userConstraints),
      decisions: asStringArray(parsed.decisions),
      currentState: asStringArray(parsed.currentState),
      openQuestions: asStringArray(parsed.openQuestions),
      nextActions: asStringArray(parsed.nextActions),
      doNotInfer: asStringArray(parsed.doNotInfer),
      keyEvidence: asStringArray(parsed.keyEvidence),
    }
  } catch {
    return undefined
  }
}

export function buildContextCompactionPrompt(input: ContextCompactionModelInput): string {
  const refs = buildContextCompactionReferenceIndex(input)
  const evidenceManifest = formatModelEvidenceManifest(input.episode.evidence)
  const messageIndex = refs.messages
    .map(
      (item) =>
        `- ${item.ref} id=${item.id} role=${item.role} type=${item.messageType} created_at=${item.createdAt}`,
    )
    .join('\n')
  const toolIndex = refs.tools.map(formatToolReference).join('\n')
  const toolEnvironmentDigestManifest = formatToolEnvironmentDigestManifest(
    input.toolEnvironmentDigests ?? [],
    refs,
  )
  const transcript = boundedJoin(
    input.segment.map((message, index) => renderMessageForCompaction(message, index, refs)),
    '\n\n',
    CONTEXT_PARAMS.history.compactionPromptTranscriptMaxChars,
  )

  return `<instruction prompt_version="${CONTEXT_COMPACTION_PROMPT_VERSION}">
请分析并压缩 covered_messages 中的会话历史，输出给未来 agent 继续工作的上下文。

核心目标：
- 压缩结果会在 prompt 主线上替代这些原始消息；大型 tool IO 会优先以 tool_environment_digest 进入 prompt。
- tool_environment_digest 只是局部环境观察：它说明工具实际跑了什么、看到了什么、产出了什么、保留了哪些 handle；它不解释完整任务动机。
- evidence path 是审计和回看来源；如果 digest 标注仍需回看原文，需要在 topic evidence 中保留对应 K 引用和 path。
- 不要把 tool_use / tool_result 原文简单堆叠进 summary；主 compaction 要结合用户消息和工具环境观察，解释这些工具在任务状态中意味着什么。
- 允许把同一窗口内非连续消息合并成同一个 topic，例如 E1-E5 与 E9-E10 讨论同一问题时，可以放在同一 topic。
- 后面的消息可以更正前面的结论；请在 topic 中保留这种修正关系。
- block/topic 必须能被审计：每个 topic 都要写 source message refs 和 tool refs。

分类与边界规则：
- 优先按“任务/问题/组件状态”切 topic，而不是按连续 turn 机械切分。
- read / write / edit / bash / memory 等工具必须作为判断边界的重要证据。
- 如果工具只是探索同一问题，应放在同一 topic；如果它切换到新问题或新组件，应另起 topic。
- 对 blocked、权限缺失、信息缺失、未完成状态要明确标记，不能写成已完成。
- 保留用户真实约束、明确否定、纠正、模型选择、路径、session id、commit id、测试结果等关键细节。

输出格式要求：
只返回一个 <context_compaction> XML。不要 Markdown fence。

<context_compaction prompt_version="${CONTEXT_COMPACTION_PROMPT_VERSION}">
  <block_summary>一句到三句，总结这个压缩块代表的工作状态。</block_summary>
  <topics>
    <topic id="T1" status="completed|in_progress|blocked|unknown" message_refs="E1,E2" tool_refs="K1,K2" needs_raw_review="false">
      <title>短标题</title>
      <summary>这个 topic 怎么来的、干了什么、为什么这么做、现在结论是什么。</summary>
      <confirmed_facts>
        <item>只写由用户消息或工具结果支持的事实。</item>
      </confirmed_facts>
      <decisions>
        <item>已经确定的设计或实现决定。</item>
      </decisions>
      <current_state>
        <item>未来 agent 继续工作必须知道的状态。</item>
      </current_state>
      <open_questions>
        <item>仍未解决、需要回看证据或等待用户的信息。</item>
      </open_questions>
      <next_actions>
        <item>如果继续这个 topic，合理的下一步。</item>
      </next_actions>
      <evidence>
        <item>K1 result path=... 说明为什么需要回看。</item>
      </evidence>
    </topic>
  </topics>
  <user_constraints>
    <item>用户明确提出、后续必须遵守的约束。</item>
  </user_constraints>
  <do_not_infer>
    <item>不能从这段历史中擅自推断的内容。</item>
  </do_not_infer>
  <self_check>
    <item>确认所有 K 引用都只来自 tool_index。</item>
    <item>确认 tool_refs 中没有 E 引用。</item>
    <item>确认每个 topic 都有 message_refs。</item>
  </self_check>
</context_compaction>
</instruction>

<metadata>
session_id: ${input.sessionId}
block_id: ${input.blockId}
strategy_version: ${input.strategyVersion}
prompt_version: ${CONTEXT_COMPACTION_PROMPT_VERSION}
current_goal: ${input.currentGoal}
covered_message_count: ${input.segment.length}
tool_ref_count: ${refs.tools.length}
tool_use_ids: ${input.episode.toolUseIds.join(', ') || 'none'}
episode_status: ${input.episode.status}
tool_environment_digest_count: ${input.toolEnvironmentDigests?.length ?? 0}
</metadata>

<message_index>
${messageIndex || '- none'}
</message_index>

<tool_index>
${toolIndex || '- none'}
</tool_index>

<evidence_manifest>
${evidenceManifest || '- none'}
</evidence_manifest>

<tool_environment_digests>
${toolEnvironmentDigestManifest || '- none'}
</tool_environment_digests>

<working_state_before_model>
${input.workingStateSummary}
</working_state_before_model>

<covered_messages>
${transcript}
</covered_messages>`
}

function formatToolReference(tool: ToolReference): string {
  const inputEvidence = tool.inputEvidence
    ? ` input_evidence=${tool.inputEvidence.path} input_sha256=${tool.inputEvidence.sha256.slice(0, 12)}`
    : ''
  const resultEvidence = tool.resultEvidence
    ? ` result_evidence=${tool.resultEvidence.path} result_sha256=${tool.resultEvidence.sha256.slice(0, 12)}`
    : ''
  const previews = [
    tool.inputPreview ? `  input_preview: ${tool.inputPreview}` : undefined,
    tool.resultPreview ? `  result_preview: ${tool.resultPreview}` : undefined,
  ].filter((item): item is string => Boolean(item))

  return [
    `- ${tool.ref} tool=${tool.toolName} use_id=${tool.toolUseId} messages=${tool.messageRefs.join(',') || 'none'} result=${tool.resultStatus}${inputEvidence}${resultEvidence}`,
    ...previews,
  ].join('\n')
}

function formatModelEvidenceManifest(evidence: ToolEvidence[]): string {
  const limit = CONTEXT_PARAMS.history.episodePromptEvidenceLimit
  const lines = evidence
    .slice(0, limit)
    .map(
      (item) =>
        `- ${item.toolName}:${item.toolUseId}:${item.kind} path=${item.path} chars=${item.chars} sha256=${item.sha256.slice(0, 12)} summary=${compactLine(item.summary ?? 'captured', 180)}`,
    )
  const omitted = evidence.length - lines.length
  if (omitted > 0) {
    lines.push(`- omitted_evidence count=${omitted} reason=evidence_manifest_limit_${limit}`)
  }
  return lines.join('\n')
}

function formatToolEnvironmentDigestManifest(
  digests: ToolEnvironmentDigest[],
  refs: ContextCompactionReferenceIndex,
): string {
  return digests
    .map((digest) => {
      const toolRefs = digest.toolUseIds
        .map((toolUseId) => refs.toolRefByUseId.get(toolUseId)?.ref ?? toolUseId)
        .join(',')
      const messageRefs = digest.messageIds
        .map((messageId) => refs.messages.find((message) => message.id === messageId)?.ref)
        .filter((item): item is string => Boolean(item))
        .join(',')
      return [
        `<tool_environment_digest id="${digest.id}" scope="${digest.scope}" tool_refs="${toolRefs}" message_refs="${messageRefs}" raw_chars="${digest.rawChars}" digest_chars="${digest.digestChars}">`,
        escapeXml(digest.summary),
        '</tool_environment_digest>',
      ].join('\n')
    })
    .join('\n\n')
}

function renderMessageForCompaction(
  message: Message,
  index: number,
  refs: ContextCompactionReferenceIndex,
): string {
  const messageRef = refs.messages[index]?.ref ?? `E${index + 1}`
  const parts = message.content.map((block) => {
    if (block.type === 'text') return compactLine(block.text, 1400)
    if (block.type === 'tool_use') {
      const toolRef = refs.toolRefByUseId.get(block.id)?.ref ?? block.id
      const preview =
        refs.toolRefByUseId.get(block.id)?.inputPreview ?? previewToolInput(block.input)
      return `[tool_use ref=${toolRef} name=${block.name} id=${block.id}] input=${preview}`
    }
    if (block.type === 'tool_result') {
      const toolRef = refs.toolRefByUseId.get(block.toolUseId)?.ref ?? block.toolUseId
      const tool = refs.toolRefByUseId.get(block.toolUseId)
      const digest = refs.toolDigestByUseId.get(block.toolUseId)
      if (digest) {
        return `[tool_result ref=${toolRef} id=${block.toolUseId} status=${
          block.isError ? 'error' : 'success'
        }]\n${formatToolResultDigestReference(block, tool, digest)}`
      }
      const content = formatToolResultRawForCompaction(block, tool)
      return `[tool_result ref=${toolRef} id=${block.toolUseId} status=${
        block.isError ? 'error' : 'success'
      }]\n${content}`
    }
    if (block.type === 'thinking') return '[thinking omitted]'
    return `[${block.type}]`
  })

  return [
    `<message ref="${messageRef}" id="${message.id}" role="${message.role}" type="${message.messageType}" created_at="${message.createdAt}">`,
    parts.join('\n'),
    '</message>',
  ].join('\n')
}

function formatToolResultRawForCompaction(
  block: Extract<Message['content'][number], { type: 'tool_result' }>,
  tool: ToolReference | undefined,
): string {
  const evidence = tool?.resultEvidence ?? block.evidence
  const raw = readEvidencePayload(evidence) ?? block.content
  const maxChars = CONTEXT_PARAMS.history.compactionPromptToolResultMaxChars
  const formatted = truncateRawForCompaction(raw, maxChars)
  const metadata = [
    block.outputSummary ? `output_summary=${block.outputSummary}` : undefined,
    `raw_chars=${raw.length}`,
    evidence ? `evidence_path=${evidence.path}` : undefined,
    formatted.truncated ? `raw_truncated=true kept_chars=${formatted.text.length}` : undefined,
  ]
    .filter((item): item is string => Boolean(item))
    .join(' ')

  return [
    metadata ? `[tool_result_metadata ${metadata}]` : undefined,
    '<tool_result_raw><![CDATA[',
    escapeCdata(formatted.text),
    ']]></tool_result_raw>',
  ]
    .filter((item): item is string => Boolean(item))
    .join('\n')
}

function formatToolResultDigestReference(
  block: Extract<Message['content'][number], { type: 'tool_result' }>,
  tool: ToolReference | undefined,
  digest: ToolEnvironmentDigest,
): string {
  const evidence = tool?.resultEvidence ?? block.evidence
  const metadata = [
    `digest_id=${digest.id}`,
    `digest_scope=${digest.scope}`,
    block.outputSummary ? `output_summary=${block.outputSummary}` : undefined,
    evidence ? `evidence_path=${evidence.path}` : undefined,
    evidence ? `raw_chars=${evidence.chars}` : `raw_chars=${block.content.length}`,
    'raw_replaced_by_tool_environment_digest=true',
  ]
    .filter((item): item is string => Boolean(item))
    .join(' ')
  return `[tool_environment_digest_ref ${metadata}]`
}

interface CompressionTraceOptions {
  tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan' | 'getSpan'>
  parentSpanId?: string
  agentName?: string
  providerName?: string
  modelLabel?: string
  pricing?: ModelPricing
  secretFilter?: SecretFilter
}

/**
 * Compress conversation history when it exceeds the budget.
 * Splits into "to summarize" and "retained" sections.
 * Uses an LLM call to generate a summary of the old messages.
 */
export async function compressConversation(
  messages: Message[],
  conversationBudget: number,
  adapter: ProviderAdapter,
  sessionId: string,
  meta?: { parentSessionId?: string },
  trace?: CompressionTraceOptions,
): Promise<CompressionResult> {
  const tokensBefore = messages.reduce((sum, m) => sum + estimateMessageTokens(m.content) + 4, 0)

  const retainBudget = Math.floor(conversationBudget * CONTEXT_PARAMS.compression.retainRatio)
  let retainedTokens = 0
  let splitIndex = messages.length

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(messages[i].content) + 4
    if (retainedTokens + msgTokens > retainBudget) break
    retainedTokens += msgTokens
    splitIndex = i
  }

  const minRetainMessages = CONTEXT_PARAMS.compression.minRetainTurns * 2
  const minRetain = Math.max(0, messages.length - minRetainMessages)
  splitIndex = Math.min(splitIndex, minRetain)

  while (
    splitIndex > 0 &&
    splitIndex < messages.length &&
    messages[splitIndex - 1].role === 'assistant' &&
    messages[splitIndex - 1].content.some((b) => b.type === 'tool_use') &&
    messages[splitIndex].role === 'user' &&
    messages[splitIndex].content.some((b) => b.type === 'tool_result')
  ) {
    splitIndex--
  }

  if (splitIndex <= 0) {
    return {
      summary: '',
      retainedMessages: [...messages],
      stats: {
        messagesBefore: messages.length,
        messagesAfter: messages.length,
        tokensBefore,
        tokensAfter: tokensBefore,
        compressedRange: undefined,
      },
    }
  }

  const toSummarize = messages.slice(0, splitIndex)
  const retained = messages.slice(splitIndex)
  const summaryResponse = await generateSummary(toSummarize, adapter, sessionId, meta, trace)
  const summary = summaryResponse.text

  const summaryMessage: Message = {
    id: generateId(),
    sessionId,
    role: 'user',
    messageType: 'message',
    content: [
      {
        type: 'text',
        text: `[以下是之前对话的摘要]\n\n${summary}\n\n[摘要结束，以下是最近的对话]`,
      },
    ],
    createdAt: now(),
  }

  const retainedMessages = [summaryMessage, ...retained]
  const tokensAfter = retainedMessages.reduce(
    (sum, m) => sum + estimateMessageTokens(m.content) + 4,
    0,
  )

  return {
    summary,
    retainedMessages,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: retainedMessages.length,
      tokensBefore,
      tokensAfter,
      compressedRange: `0..${splitIndex - 1}`,
    },
  }
}

async function generateSummary(
  messages: Message[],
  adapter: ProviderAdapter,
  sessionId: string,
  meta?: { parentSessionId?: string },
  trace?: CompressionTraceOptions,
): Promise<{ text: string; response: CompletionResponse }> {
  const conversationText = messages
    .map((m) => {
      const role = m.role
      const textParts = m.content
        .map((b) => {
          if (b.type === 'text') return b.text
          if (b.type === 'tool_use') return `[调用工具: ${b.name}]`
          if (b.type === 'tool_result') return `[工具结果: ${b.content.slice(0, 200)}]`
          return ''
        })
        .filter(Boolean)
        .join('\n')
      return `${role}: ${textParts}`
    })
    .join('\n\n')

  const prompt = `<instruction>
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
${conversationText}
</conversation>`

  const traceSpanId = trace?.tracer?.startSpan(sessionId, 'compression', trace.parentSpanId, {
    kind: 'llm_request',
    agentName: trace.agentName,
    metadata: {
      purpose: 'compression',
    },
  })?.id
  const startTime = Date.now()

  try {
    const response = await adapter.complete({
      messages: [
        {
          id: generateId(),
          sessionId: 'compression',
          role: 'user',
          messageType: 'message',
          content: [{ type: 'text', text: prompt }],
          createdAt: now(),
        },
      ],
      system: '你是一个对话摘要助手。请将提供的对话历史压缩为简洁的摘要。',
      stream: false,
      maxTokens: 1024,
      meta: {
        sessionId: messages[0]?.sessionId ?? 'compression',
        purpose: 'compression',
        ...(meta?.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
      },
    })

    const responseText = response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('\n')
    const durationMs = Date.now() - startTime

    if (traceSpanId) {
      trace.tracer?.updateSpan(traceSpanId, {
        data: {
          compression: {
            model: trace.modelLabel ?? response.model,
            provider: trace.providerName ?? 'unknown',
            prompt: truncateText(sanitizeText(prompt, trace.secretFilter), 500),
            response: truncateText(sanitizeText(responseText, trace.secretFilter), 500),
            compressedMessageCount: messages.length,
            tokens: {
              input: response.usage.input,
              output: response.usage.output,
              cacheWrite: response.usage.cacheWrite,
              cacheRead: response.usage.cacheRead,
              reasoning: response.usage.reasoning,
            },
            cost: computeCost(response.usage, trace.pricing),
            durationMs,
          },
        },
        metadata: {
          compressedMessageCount: messages.length,
        },
      })
    }

    return {
      text: responseText,
      response,
    }
  } catch (error) {
    if (traceSpanId) {
      trace.tracer?.updateSpan(traceSpanId, {
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      })
      trace.tracer?.endSpan(traceSpanId, 'error')
    }
    throw error
  } finally {
    if (traceSpanId) {
      const current = trace.tracer?.getSpan?.(traceSpanId)
      if (current && !current.endTime) {
        trace.tracer?.endSpan(traceSpanId, 'success')
      }
    }
  }
}

export type ContextCompactionTracer = Pick<
  Tracer,
  'startSpan' | 'updateSpan' | 'endSpan' | 'getSpan'
> & {
  logSession?: Tracer['logSession']
}

export interface ContextCompactionRuntime {
  adapter: ProviderAdapter
  sessionId: string
  agentName?: string
  parentSpanId?: string
  turnIndex: number
  reasoningEffort?: ReasoningEffort
  parentSessionId?: string
  modelLabel?: string
  providerName?: string
  pricing?: ModelPricing
  tracer?: ContextCompactionTracer
  secretFilter?: SecretFilter
  logger?: Pick<ToolContext['logger'], 'warn'>
}

interface ToolIoDigestPair {
  toolUseId: string
  toolName: string
  toolRef: string
  toolMessageRef: string
  resultMessageRef: string
  toolMessageId: string
  resultMessageId: string
  toolMessageIndex: number
  resultMessageIndex: number
  inputRaw: string
  resultRaw: string
  outputSummary?: string
  isError?: boolean
  resultEvidence?: ToolEvidence
  rawChars: number
}

interface ToolIoDigestGroup {
  id: string
  scope: ToolEnvironmentDigest['scope']
  pairs: ToolIoDigestPair[]
  rawChars: number
}

interface ToolEnvironmentDigestRuntime {
  adapter: ProviderAdapter
  sessionId: string
  parentSpanId?: string
  turnIndex: number
  reasoningEffort?: ReasoningEffort
  parentSessionId?: string
  modelLabel?: string
  providerName?: string
  pricing?: ModelPricing
  tracer?: ContextCompactionTracer
  secretFilter?: SecretFilter
  logger?: Pick<ToolContext['logger'], 'warn'>
}

async function generateToolEnvironmentDigests(
  input: ContextCompactionModelInput,
  runtime: ToolEnvironmentDigestRuntime,
): Promise<ToolEnvironmentDigest[]> {
  const refs = buildContextCompactionReferenceIndex(input)
  const pairs = collectToolIoDigestPairs(input.segment, refs)
  const groups = planToolIoDigestGroups(input.blockId, pairs)
  if (groups.length === 0) return []

  const digests: ToolEnvironmentDigest[] = []
  for (const group of groups) {
    try {
      const digest = await requestToolEnvironmentDigestModel({
        group,
        adapter: runtime.adapter,
        sessionId: runtime.sessionId,
        parentSessionId: runtime.parentSessionId,
        modelLabel: runtime.modelLabel,
        providerName: runtime.providerName,
        pricing: runtime.pricing,
        turnIndex: runtime.turnIndex,
        reasoningEffort: runtime.reasoningEffort,
        parentSpanId: runtime.parentSpanId,
        tracer: runtime.tracer,
        secretFilter: runtime.secretFilter,
      })
      if (digest) digests.push(digest)
    } catch (error) {
      const errorMessage = toErrorMessage(error)
      runtime.logger?.warn('tool_environment_digest_failed', {
        sessionId: runtime.sessionId,
        blockId: input.blockId,
        groupId: group.id,
        error: errorMessage,
      })
      runtime.tracer?.logSession?.(runtime.sessionId, 'warn', 'tool_environment_digest.failed', {
        turnIndex: runtime.turnIndex,
        blockId: input.blockId,
        groupId: group.id,
        toolUseIds: group.pairs.map((pair) => pair.toolUseId),
        error: errorMessage,
      })
    }
  }
  return digests
}

function collectToolIoDigestPairs(
  messages: Message[],
  refs: ReturnType<typeof buildContextCompactionReferenceIndex>,
): ToolIoDigestPair[] {
  const pending = new Map<
    string,
    {
      toolUseId: string
      toolName: string
      toolRef: string
      toolMessageRef: string
      toolMessageId: string
      toolMessageIndex: number
      inputRaw: string
    }
  >()
  const pairs: ToolIoDigestPair[] = []

  messages.forEach((message, messageIndex) => {
    const messageRef = refs.messages[messageIndex]?.ref ?? `E${messageIndex + 1}`
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        const tool = refs.toolRefByUseId.get(block.id)
        pending.set(block.id, {
          toolUseId: block.id,
          toolName: block.name,
          toolRef: tool?.ref ?? block.id,
          toolMessageRef: messageRef,
          toolMessageId: message.id,
          toolMessageIndex: messageIndex,
          inputRaw: stableStringify(block.input),
        })
      }

      if (block.type === 'tool_result') {
        const toolUse = pending.get(block.toolUseId)
        const tool = refs.toolRefByUseId.get(block.toolUseId)
        const resultEvidence = tool?.resultEvidence ?? block.evidence
        const resultRaw = readEvidencePayload(resultEvidence) ?? block.content
        const inputRaw = toolUse?.inputRaw ?? ''
        pairs.push({
          toolUseId: block.toolUseId,
          toolName: toolUse?.toolName ?? tool?.toolName ?? 'unknown_tool',
          toolRef: toolUse?.toolRef ?? tool?.ref ?? block.toolUseId,
          toolMessageRef: toolUse?.toolMessageRef ?? 'unknown_tool_message',
          resultMessageRef: messageRef,
          toolMessageId: toolUse?.toolMessageId ?? 'unknown_tool_message',
          resultMessageId: message.id,
          toolMessageIndex: toolUse?.toolMessageIndex ?? messageIndex,
          resultMessageIndex: messageIndex,
          inputRaw,
          resultRaw,
          outputSummary: block.outputSummary,
          isError: block.isError,
          resultEvidence,
          rawChars: inputRaw.length + resultRaw.length + (block.outputSummary?.length ?? 0),
        })
        pending.delete(block.toolUseId)
      }
    }
  })

  return pairs.sort((left, right) => left.toolMessageIndex - right.toolMessageIndex)
}

function planToolIoDigestGroups(blockId: string, pairs: ToolIoDigestPair[]): ToolIoDigestGroup[] {
  const groups: ToolIoDigestGroup[] = []
  const maxPairs = Math.max(1, CONTEXT_PARAMS.history.toolDigestMaxPairs)
  let current: ToolIoDigestPair[] = []

  const flush = () => {
    if (current.length === 0) return
    const rawChars = current.reduce((sum, pair) => sum + pair.rawChars, 0)
    if (
      (current.length === 1 && rawChars >= CONTEXT_PARAMS.history.toolDigestMinRawChars) ||
      (current.length > 1 && rawChars >= CONTEXT_PARAMS.history.toolDigestGroupMinRawChars)
    ) {
      groups.push(buildToolIoDigestGroup(blockId, current))
    } else {
      for (const pair of current) {
        if (pair.rawChars >= CONTEXT_PARAMS.history.toolDigestMinRawChars) {
          groups.push(buildToolIoDigestGroup(blockId, [pair]))
        }
      }
    }
    current = []
  }

  for (const pair of pairs) {
    current.push(pair)
    if (current.length >= maxPairs) flush()
  }
  flush()
  return groups
}

function buildToolIoDigestGroup(blockId: string, pairs: ToolIoDigestPair[]): ToolIoDigestGroup {
  const rawChars = pairs.reduce((sum, pair) => sum + pair.rawChars, 0)
  const scope: ToolEnvironmentDigest['scope'] = pairs.length > 1 ? 'group' : 'single'
  return {
    id: `tool_digest_${hashText([blockId, scope, ...pairs.map((pair) => pair.toolUseId)].join('|')).slice(0, 16)}`,
    scope,
    pairs: [...pairs],
    rawChars,
  }
}

function buildToolEnvironmentDigestPrompt(group: ToolIoDigestGroup): string {
  return [
    `<instruction prompt_version="${TOOL_ENVIRONMENT_DIGEST_PROMPT_VERSION}">`,
    '请将下面的局部 tool_use + tool_result 原始 IO 压缩成环境摘要。',
    '这一层没有完整会话上下文；不要解释工具为什么被调用，不要推断用户意图。',
    '输出自然语言中文，保留 exact handles，并说明哪些原文仍需回看。',
    '',
    '建议结构：',
    '环境摘要：这组工具 IO 展示了什么环境状态、文件/网络/命令/数据结果。',
    '逐工具摘要：T1/K1 tool_name/use_id；输入关键参数；结果关键观察；错误或产物。',
    '可复用原文标识：路径、URL、ID、文件名、命令 flag、模型名、配置 key 等。',
    '仍需回看原文：过大、过碎或不能安全省略的 raw evidence path / tool ref。',
    '</instruction>',
    '',
    `<tool_packets digest_id="${group.id}" scope="${group.scope}" raw_chars="${group.rawChars}">`,
    ...group.pairs.flatMap((pair, index) => renderToolDigestPacket(pair, index + 1)),
    '</tool_packets>',
  ].join('\n')
}

function renderToolDigestPacket(pair: ToolIoDigestPair, index: number): string[] {
  const maxRawChars = CONTEXT_PARAMS.history.toolDigestMaxRawCharsPerTool
  const result = truncateRawForCompaction(pair.resultRaw, maxRawChars)
  const input = truncateRawForCompaction(pair.inputRaw, Math.min(12000, maxRawChars))
  return [
    `<tool_packet ref="T${index}" tool_ref="${pair.toolRef}" tool_use_id="${pair.toolUseId}" tool_name="${pair.toolName}" tool_message_ref="${pair.toolMessageRef}" result_message_ref="${pair.resultMessageRef}" status="${pair.isError ? 'error' : 'success'}" raw_chars="${pair.rawChars}">`,
    pair.outputSummary
      ? `<output_summary>${escapeXml(pair.outputSummary)}</output_summary>`
      : undefined,
    pair.resultEvidence
      ? `<raw_evidence path="${escapeXml(pair.resultEvidence.path)}" chars="${pair.resultEvidence.chars}" sha256="${pair.resultEvidence.sha256.slice(0, 12)}" />`
      : undefined,
    '<tool_use_input_raw><![CDATA[',
    escapeCdata(input.text),
    ']]></tool_use_input_raw>',
    '<tool_result_raw><![CDATA[',
    escapeCdata(result.text),
    ']]></tool_result_raw>',
    '</tool_packet>',
  ].filter((item): item is string => Boolean(item))
}

interface ToolEnvironmentDigestRequestOptions {
  group: ToolIoDigestGroup
  adapter: ProviderAdapter
  sessionId: string
  parentSessionId?: string
  modelLabel?: string
  providerName?: string
  pricing?: ModelPricing
  turnIndex: number
  reasoningEffort: ReasoningEffort | undefined
  parentSpanId?: string
  tracer?: ContextCompactionTracer
  secretFilter?: SecretFilter
}

async function requestToolEnvironmentDigestModel(
  params: ToolEnvironmentDigestRequestOptions,
): Promise<ToolEnvironmentDigest | undefined> {
  const prompt = buildToolEnvironmentDigestPrompt(params.group)
  const span = params.tracer?.startSpan(
    params.sessionId,
    'tool_environment_digest_model',
    params.parentSpanId,
    {
      kind: 'llm_request',
      data: {
        toolEnvironmentDigest: {
          groupId: params.group.id,
          scope: params.group.scope,
          toolUseIds: params.group.pairs.map((pair) => pair.toolUseId),
          rawChars: params.group.rawChars,
          promptChars: prompt.length,
          promptVersion: TOOL_ENVIRONMENT_DIGEST_PROMPT_VERSION,
          model: params.modelLabel,
        },
      },
      metadata: {
        turnIndex: params.turnIndex,
        purpose: 'tool_io_digest',
        groupId: params.group.id,
        promptVersion: TOOL_ENVIRONMENT_DIGEST_PROMPT_VERSION,
      },
    },
  )
  const request: CompletionRequest = {
    messages: [
      {
        id: generateId(),
        sessionId: params.sessionId,
        role: 'user',
        messageType: 'message',
        content: [{ type: 'text', text: prompt }],
        createdAt: now(),
      },
    ],
    system: TOOL_ENVIRONMENT_DIGEST_SYSTEM_PROMPT,
    stream: false,
    maxTokens: CONTEXT_PARAMS.history.toolDigestMaxOutputTokens,
    reasoningEffort: params.reasoningEffort,
    meta: {
      sessionId: params.sessionId,
      purpose: 'tool_io_digest',
      ...(params.parentSessionId ? { parentSessionId: params.parentSessionId } : {}),
    },
  }

  params.tracer?.logSession?.(params.sessionId, 'debug', 'tool_environment_digest.model_request', {
    traceSpanId: span?.id,
    turnIndex: params.turnIndex,
    groupId: params.group.id,
    promptVersion: TOOL_ENVIRONMENT_DIGEST_PROMPT_VERSION,
    model: params.modelLabel,
    provider: params.providerName,
    request: filterTraceValue(request, params.secretFilter),
  })

  const startedAt = Date.now()
  try {
    const response = await params.adapter.complete(request)
    const durationMs = Date.now() - startedAt
    const text = extractResponseText(response).trim()
    const usable = text.length >= 40
    const cost = computeCost(response.usage, params.pricing)
    const model = params.modelLabel ?? response.model
    const provider = params.providerName ?? 'unknown'

    params.tracer?.logSession?.(
      params.sessionId,
      usable ? 'debug' : 'warn',
      usable ? 'tool_environment_digest.model_response' : 'tool_environment_digest.model_invalid',
      {
        traceSpanId: span?.id,
        turnIndex: params.turnIndex,
        groupId: params.group.id,
        durationMs,
        responseChars: text.length,
        response: filterTraceValue(response, params.secretFilter),
        digestText: filterTraceValue(text, params.secretFilter),
        cost,
      },
    )

    if (span) {
      params.tracer?.updateSpan(span.id, {
        data: {
          toolEnvironmentDigest: {
            groupId: params.group.id,
            scope: params.group.scope,
            rawChars: params.group.rawChars,
            digestChars: text.length,
            promptChars: prompt.length,
            promptVersion: TOOL_ENVIRONMENT_DIGEST_PROMPT_VERSION,
            model,
            provider,
            usable,
            cost,
          },
        },
        metadata: {
          turnIndex: params.turnIndex,
          groupId: params.group.id,
          usable,
          model,
        },
      })
      params.tracer?.endSpan(span.id, usable ? 'success' : 'error', { durationMs })
    }

    if (!usable) return undefined
    return {
      id: params.group.id,
      scope: params.group.scope,
      toolUseIds: params.group.pairs.map((pair) => pair.toolUseId),
      messageIds: uniqueStrings(
        params.group.pairs.flatMap((pair) => [pair.toolMessageId, pair.resultMessageId]),
      ),
      rawChars: params.group.rawChars,
      digestChars: text.length,
      summary: text,
      model: {
        promptVersion: TOOL_ENVIRONMENT_DIGEST_PROMPT_VERSION,
        usedModel: model,
        usedProvider: provider,
      },
    }
  } catch (error) {
    if (span) {
      params.tracer?.endSpan(span.id, 'error', {
        durationMs: Date.now() - startedAt,
        error: toErrorMessage(error),
      })
    }
    throw error
  }
}

export async function generateContextCompaction(
  input: ContextCompactionModelInput,
  runtime: ContextCompactionRuntime,
): Promise<ContextCompactionModelOutput | undefined> {
  const primaryModel = runtime.modelLabel
  const primaryProvider = runtime.providerName
  const span = runtime.tracer?.startSpan(
    runtime.sessionId,
    'context_compaction_model',
    runtime.parentSpanId,
    {
      kind: 'llm_request',
      agentName: runtime.agentName,
      data: {
        contextCompactionModel: {
          blockId: input.blockId,
          coveredMessageCount: input.segment.length,
          evidenceCount: input.episode.evidence.length,
          promptVersion: CONTEXT_COMPACTION_PROMPT_VERSION,
          toolDigestPromptVersion: TOOL_ENVIRONMENT_DIGEST_PROMPT_VERSION,
          primaryModel,
        },
      },
      metadata: {
        turnIndex: runtime.turnIndex,
        purpose: 'compression',
        blockId: input.blockId,
        strategyVersion: input.strategyVersion,
        promptVersion: CONTEXT_COMPACTION_PROMPT_VERSION,
      },
    },
  )

  try {
    const toolEnvironmentDigests = await generateToolEnvironmentDigests(input, {
      ...runtime,
      parentSpanId: span?.id,
    })
    const modelInput: ContextCompactionModelInput =
      toolEnvironmentDigests.length > 0 ? { ...input, toolEnvironmentDigests } : input
    const prompt = buildContextCompactionPrompt(modelInput)
    const result = await requestContextCompactionModel({
      input: modelInput,
      prompt,
      adapter: runtime.adapter,
      sessionId: runtime.sessionId,
      parentSessionId: runtime.parentSessionId,
      modelLabel: primaryModel,
      providerName: primaryProvider,
      pricing: runtime.pricing,
      phase: 'primary',
      turnIndex: runtime.turnIndex,
      reasoningEffort: runtime.reasoningEffort,
      traceSpanId: span?.id,
      tracer: runtime.tracer,
      secretFilter: runtime.secretFilter,
      logger: runtime.logger,
    })
    if (isContextCompactionModelOutputUsable(result.parsed)) {
      const output = {
        ...result.parsed,
        model: {
          promptVersion: CONTEXT_COMPACTION_PROMPT_VERSION,
          primaryModel,
          primaryProvider,
          usedModel: result.model,
          usedProvider: result.provider,
          attempts: 1,
        },
      }
      finishContextCompactionSpan(span?.id, {
        input: modelInput,
        output,
        promptChars: prompt.length,
        responseChars: result.responseChars,
        turnIndex: runtime.turnIndex,
        durationMs: result.durationMs,
        toolEnvironmentDigests,
        tracer: runtime.tracer,
      })
      return output
    }

    finishContextCompactionSpan(span?.id, {
      input: modelInput,
      output: result.parsed,
      promptChars: prompt.length,
      responseChars: result.responseChars,
      turnIndex: runtime.turnIndex,
      durationMs: result.durationMs,
      status: 'error',
      model: result.model,
      provider: result.provider,
      toolEnvironmentDigests,
      tracer: runtime.tracer,
    })
    return undefined
  } catch (error) {
    const errorMessage = toErrorMessage(error)
    runtime.logger?.warn('context_compaction_model_failed', {
      sessionId: runtime.sessionId,
      blockId: input.blockId,
      error: errorMessage,
    })
    runtime.tracer?.logSession?.(runtime.sessionId, 'warn', 'context_compaction.model_failed', {
      traceSpanId: span?.id,
      turnIndex: runtime.turnIndex,
      blockId: input.blockId,
      error: errorMessage,
    })
    if (span) {
      runtime.tracer?.endSpan(span.id, 'error', {
        error: errorMessage,
      })
    }
    return undefined
  }
}

function finishContextCompactionSpan(
  spanId: string | undefined,
  params: {
    input: ContextCompactionModelInput
    output: ContextCompactionModelOutput | undefined
    promptChars: number
    responseChars: number
    turnIndex: number
    durationMs?: number
    status?: 'success' | 'error'
    model?: string
    provider?: string
    toolEnvironmentDigests?: ToolEnvironmentDigest[]
    tracer?: ContextCompactionTracer
  },
): void {
  if (!spanId) return
  const usable = isContextCompactionModelOutputUsable(params.output)
  params.tracer?.updateSpan(spanId, {
    data: {
      contextCompactionModel: {
        blockId: params.input.blockId,
        coveredMessageCount: params.input.segment.length,
        evidenceCount: params.input.episode.evidence.length,
        promptChars: params.promptChars,
        responseChars: params.responseChars,
        promptVersion: CONTEXT_COMPACTION_PROMPT_VERSION,
        toolDigestPromptVersion: TOOL_ENVIRONMENT_DIGEST_PROMPT_VERSION,
        toolDigestCount: params.toolEnvironmentDigests?.length ?? 0,
        toolDigestRawChars:
          params.toolEnvironmentDigests?.reduce((sum, digest) => sum + digest.rawChars, 0) ?? 0,
        toolDigestChars:
          params.toolEnvironmentDigests?.reduce((sum, digest) => sum + digest.digestChars, 0) ?? 0,
        parsed: Boolean(params.output),
        validation: params.output?.validation,
        topicCount: params.output?.topics?.length ?? 0,
        model: params.output?.model?.usedModel ?? params.model,
        provider: params.output?.model?.usedProvider ?? params.provider,
        attempts: params.output?.model?.attempts,
      },
    },
    metadata: {
      turnIndex: params.turnIndex,
      blockId: params.input.blockId,
      parsed: Boolean(params.output),
      validationStatus: params.output?.validation?.status,
      model: params.output?.model?.usedModel ?? params.model,
    },
  })
  params.tracer?.endSpan(spanId, params.status ?? (usable ? 'success' : 'error'), {
    durationMs: params.durationMs,
    parsed: Boolean(params.output),
    validationStatus: params.output?.validation?.status,
  })
}

async function requestContextCompactionModel(params: {
  input: ContextCompactionModelInput
  prompt: string
  adapter: ProviderAdapter
  sessionId: string
  parentSessionId?: string
  modelLabel?: string
  providerName?: string
  pricing?: ModelPricing
  phase: 'primary'
  turnIndex: number
  reasoningEffort: ReasoningEffort | undefined
  traceSpanId?: string
  tracer?: ContextCompactionTracer
  secretFilter?: SecretFilter
  logger?: Pick<ToolContext['logger'], 'warn'>
}): Promise<{
  parsed: ContextCompactionModelOutput | undefined
  responseChars: number
  durationMs: number
  model: string
  provider: string
}> {
  const request: CompletionRequest = {
    messages: [
      {
        id: generateId(),
        sessionId: params.sessionId,
        role: 'user',
        messageType: 'message',
        content: [{ type: 'text', text: params.prompt }],
        createdAt: now(),
      },
    ],
    system: CONTEXT_COMPACTION_SYSTEM_PROMPT,
    stream: false,
    maxTokens: 16384,
    reasoningEffort: params.reasoningEffort,
    meta: {
      sessionId: params.sessionId,
      purpose: 'compression',
      ...(params.parentSessionId ? { parentSessionId: params.parentSessionId } : {}),
    },
  }

  params.tracer?.logSession?.(params.sessionId, 'debug', 'context_compaction.model_request', {
    traceSpanId: params.traceSpanId,
    turnIndex: params.turnIndex,
    blockId: params.input.blockId,
    phase: params.phase,
    promptVersion: CONTEXT_COMPACTION_PROMPT_VERSION,
    model: params.modelLabel,
    provider: params.providerName,
    request: filterTraceValue(request, params.secretFilter),
  })

  const startedAt = Date.now()
  const response = await params.adapter.complete(request)
  const durationMs = Date.now() - startedAt
  const text = extractResponseText(response)
  const parsed = parseContextCompactionModelOutput(text, params.input)
  const validationStatus = parsed?.validation?.status
  const usable = isContextCompactionModelOutputUsable(parsed)
  const reason = usable ? undefined : describeContextCompactionFailure(text, parsed, response)
  const cost = computeCost(response.usage, params.pricing)
  const model = params.modelLabel ?? response.model
  const provider = params.providerName ?? 'unknown'

  if (!usable) {
    params.logger?.warn('context_compaction_model_invalid', {
      sessionId: params.sessionId,
      blockId: params.input.blockId,
      turnIndex: params.turnIndex,
      phase: params.phase,
      reason,
      responseChars: text.length,
      validationStatus,
      model,
      provider,
    })
  }

  params.tracer?.logSession?.(
    params.sessionId,
    usable ? 'debug' : 'warn',
    usable ? 'context_compaction.model_response' : 'context_compaction.model_invalid',
    {
      traceSpanId: params.traceSpanId,
      turnIndex: params.turnIndex,
      blockId: params.input.blockId,
      phase: params.phase,
      durationMs,
      responseChars: text.length,
      reason,
      validation: filterTraceValue(parsed?.validation, params.secretFilter),
      response: filterTraceValue(response, params.secretFilter),
      parsed: filterTraceValue(parsed, params.secretFilter),
      cost,
    },
  )

  return {
    parsed,
    responseChars: text.length,
    durationMs,
    model,
    provider,
  }
}

function describeContextCompactionFailure(
  text: string,
  parsed: ContextCompactionModelOutput | undefined,
  response: CompletionResponse,
): string | undefined {
  const trimmed = text.trim()
  const hasThinkingOnly = response.content.some((block) => block.type === 'thinking')
  if (!trimmed) {
    return hasThinkingOnly ? 'empty_final_text_with_reasoning' : 'empty_final_text'
  }

  if (!extractXmlElement(text, 'context_compaction')) {
    return text.includes('<context_compaction')
      ? 'incomplete_context_compaction_xml'
      : 'missing_context_compaction_xml'
  }

  if (!parsed) return 'unparsed_context_compaction_xml'

  if (parsed.validation?.status === 'failed') {
    const errors =
      parsed.validation.errors.length > 0 ? parsed.validation.errors.join(',') : 'unknown'
    return `validation_failed:${errors}`
  }

  if (!parsed.summary?.trim()) return 'missing_block_summary'
  return 'parsed_but_unusable'
}
