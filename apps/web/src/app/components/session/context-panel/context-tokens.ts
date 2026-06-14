import { estimateTokens } from '@zero-os/shared'

export interface ContentBlockLike {
  type: string
  [key: string]: unknown
}

export interface MessageLike {
  id: string
  role: string
  messageType: string
  content: ContentBlockLike[]
  createdAt: string
  model?: string
  controlKind?: string
}

export interface ToolResultContentItemLike {
  type: string
  text?: string
  mediaType?: string
  data?: string
}

export interface RequestToolCallLike {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface RequestToolResultLike {
  type?: string
  toolUseId: string
  content?: string
  isError?: boolean
  outputSummary?: string
  contentItems?: ToolResultContentItemLike[]
}

export interface RequestMemoryInjectionLike {
  layer: 'layer1' | 'layer2'
  source: 'retrieved_memories' | 'memory_hint'
  formattedText: string
}

export interface RequestQueuedInjectionLike {
  count: number
  formattedText: string
  messages: Array<{
    timestamp: string
    content: string
    imageCount: number
    mediaTypes: string[]
  }>
}

export interface RequestTokenLike {
  input: number
  output: number
  cacheWrite?: number
  cacheRead?: number
  reasoning?: number
}

export interface LlmRequestLike {
  id: string
  turnIndex?: number
  parentId?: string
  model: string
  provider: string
  userPrompt: string
  response: string
  stopReason: string
  toolUseCount: number
  toolCalls?: RequestToolCallLike[]
  toolResults?: RequestToolResultLike[]
  queuedInjection?: RequestQueuedInjectionLike
  memoryInjections?: RequestMemoryInjectionLike[]
  tokens: RequestTokenLike
  cost: number
  durationMs?: number
  ts: string
}

export interface TokenUsageSummary {
  total: number
  input?: number
  output?: number
  cacheWrite?: number
  cacheRead?: number
  reasoning?: number
  effectiveInput?: number
  cost?: number
  durationMs?: number
  source: 'estimate' | 'request'
}

export interface ContentTokenParts {
  text: number
  images: number
  toolCalls: number
  toolResults: number
  thinking: number
  other: number
}

export interface ContextTokenSection {
  key: string
  label: string
  tokens: number
  detail?: string
  tone: 'system' | 'user' | 'assistant' | 'tool' | 'memory' | 'cache' | 'other'
}

export interface ContextTokenHotspot {
  id: string
  label: string
  tokens: number
  detail: string
}

export interface ContextTokenSummary {
  estimatedContextTokens: number
  latestRequest?: TokenUsageSummary & {
    id: string
    model: string
    provider: string
    ts: string
  }
  cumulative: {
    totalTokens: number
    inputTokens: number
    outputTokens: number
    cacheWriteTokens: number
    cacheReadTokens: number
    reasoningTokens: number
    effectiveInputTokens: number
    totalCost: number
    requestCount: number
  }
  sections: ContextTokenSection[]
  hotspots: ContextTokenHotspot[]
}

export function estimateContentTokenParts(content: ContentBlockLike[]): ContentTokenParts {
  const parts: ContentTokenParts = {
    text: 0,
    images: 0,
    toolCalls: 0,
    toolResults: 0,
    thinking: 0,
    other: 0,
  }

  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.text += estimateTokens(asText(block.text))
        break
      case 'image':
        parts.images += 300
        break
      case 'thinking':
        parts.thinking += estimateTokens(asText(block.thinking))
        break
      case 'tool_use':
        parts.toolCalls += estimateTokens(asText(block.name))
        parts.toolCalls += estimateTokens(safeStringify(block.input ?? {}))
        break
      case 'tool_result':
        parts.toolResults += estimateTokens(asText(block.content))
        parts.toolResults += estimateContentItemsTokens(block.contentItems)
        break
      default:
        parts.other += estimateTokens(safeStringify(block))
        break
    }
  }

  return parts
}

export function sumContentTokenParts(parts: ContentTokenParts): number {
  return (
    parts.text + parts.images + parts.toolCalls + parts.toolResults + parts.thinking + parts.other
  )
}

export function estimateContentTokens(content: ContentBlockLike[]): number {
  return sumContentTokenParts(estimateContentTokenParts(content))
}

export function estimateToolResultTokens(
  content?: string,
  contentItems?: ToolResultContentItemLike[],
): number {
  if (!content && (!contentItems || contentItems.length === 0)) return 0
  return estimateContentTokens([{ type: 'tool_result', content: content ?? '', contentItems }])
}

export function tokenUsageFromRequest(request: LlmRequestLike): TokenUsageSummary {
  const input = request.tokens.input
  const output = request.tokens.output
  const cacheWrite = request.tokens.cacheWrite ?? 0
  const cacheRead = request.tokens.cacheRead ?? 0
  const reasoning = request.tokens.reasoning ?? 0

  return {
    total: input + output,
    input,
    output,
    cacheWrite,
    cacheRead,
    reasoning,
    effectiveInput: input + cacheWrite + cacheRead,
    cost: request.cost,
    durationMs: request.durationMs,
    source: 'request',
  }
}

export function estimatedTokenUsage(total: number): TokenUsageSummary | undefined {
  if (total <= 0) return undefined

  return {
    total,
    source: 'estimate',
  }
}

export function buildContextTokenSummary(input: {
  messages: MessageLike[]
  systemPrompt?: string
  llmRequests: LlmRequestLike[]
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  effectiveInputTokens: number
  totalCost: number
  requestCount: number
}): ContextTokenSummary {
  const sections = new Map<string, ContextTokenSection>()
  const hotspots: ContextTokenHotspot[] = []
  const latestRequest = pickLatestRequest(input.llmRequests)

  addContextTokenSection(sections, {
    key: 'system',
    label: 'System',
    tokens: estimateTokens(input.systemPrompt ?? ''),
    detail: 'prompt',
    tone: 'system',
  })

  for (const message of input.messages) {
    if (message.messageType === 'notification') continue

    const parts = estimateContentTokenParts(message.content)
    const messageTokens = sumContentTokenParts(parts)
    if (messageTokens > 0) {
      hotspots.push({
        id: message.id,
        label: formatContextMessageLabel(message),
        tokens: messageTokens,
        detail: previewContextMessage(message),
      })
    }

    if (message.role === 'user') {
      if (parts.toolResults > 0) {
        addContextTokenSection(sections, {
          key: 'tool-results',
          label: 'Tool Results',
          tokens: parts.toolResults,
          detail: 'returned into context',
          tone: 'tool',
        })
      }
      const userPromptTokens = parts.text + parts.other
      if (userPromptTokens > 0 && message.messageType !== 'control') {
        addContextTokenSection(sections, {
          key: 'user',
          label: 'User',
          tokens: userPromptTokens,
          detail: 'prompts',
          tone: 'user',
        })
      }
    } else if (message.role === 'assistant') {
      const assistantTokens = parts.text + parts.other
      if (assistantTokens > 0) {
        addContextTokenSection(sections, {
          key: 'assistant',
          label: 'Assistant',
          tokens: assistantTokens,
          detail: 'visible replies',
          tone: 'assistant',
        })
      }
      if (parts.thinking > 0) {
        addContextTokenSection(sections, {
          key: 'thinking',
          label: 'Thinking',
          tokens: parts.thinking,
          detail: 'stored reasoning',
          tone: 'assistant',
        })
      }
      if (parts.toolCalls > 0) {
        addContextTokenSection(sections, {
          key: 'tool-calls',
          label: 'Tool Calls',
          tokens: parts.toolCalls,
          detail: 'call JSON',
          tone: 'tool',
        })
      }
    }

    if (parts.images > 0) {
      addContextTokenSection(sections, {
        key: 'images',
        label: 'Images',
        tokens: parts.images,
        detail: '300 each est.',
        tone: 'other',
      })
    }

    if (message.messageType === 'control') {
      const controlTokens = parts.text + parts.other
      if (controlTokens > 0) {
        addContextTokenSection(sections, {
          key: 'control',
          label: 'Control',
          tokens: controlTokens,
          detail: message.controlKind,
          tone: 'other',
        })
      }
    }
  }

  const latestMemoryTokens =
    latestRequest?.memoryInjections?.reduce((sum, injection) => {
      return sum + estimateTokens(injection.formattedText)
    }, 0) ?? 0
  addContextTokenSection(sections, {
    key: 'memory',
    label: 'Memory',
    tokens: latestMemoryTokens,
    detail: 'latest injection',
    tone: 'memory',
  })

  const latestQueuedTokens = latestRequest?.queuedInjection
    ? estimateTokens(latestRequest.queuedInjection.formattedText)
    : 0
  addContextTokenSection(sections, {
    key: 'queued',
    label: 'Queued',
    tokens: latestQueuedTokens,
    detail: 'latest injection',
    tone: 'other',
  })

  const rows = finalizeContextTokenSections(sections)
  const estimatedContextTokens = rows.reduce((sum, section) => sum + section.tokens, 0)

  return {
    estimatedContextTokens,
    latestRequest: latestRequest
      ? {
          ...tokenUsageFromRequest(latestRequest),
          id: latestRequest.id,
          model: latestRequest.model,
          provider: latestRequest.provider,
          ts: latestRequest.ts,
        }
      : undefined,
    cumulative: {
      totalTokens: input.totalTokens,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      cacheReadTokens: input.cacheReadTokens,
      reasoningTokens: input.reasoningTokens,
      effectiveInputTokens: input.effectiveInputTokens,
      totalCost: input.totalCost,
      requestCount: input.requestCount,
    },
    sections: rows,
    hotspots: hotspots.sort((left, right) => right.tokens - left.tokens).slice(0, 5),
  }
}

function estimateContentItemsTokens(value: unknown): number {
  if (!Array.isArray(value)) return 0

  let total = 0
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as ToolResultContentItemLike
    if (record.type === 'text') total += estimateTokens(record.text ?? '')
    if (record.type === 'image') total += 300
  }
  return total
}

function pickLatestRequest(requests: LlmRequestLike[]): LlmRequestLike | undefined {
  return [...requests]
    .filter((request) => request.tokens && typeof request.ts === 'string')
    .sort((left, right) => left.ts.localeCompare(right.ts))
    .at(-1)
}

function formatContextMessageLabel(message: MessageLike): string {
  if (message.messageType === 'control') return formatControlKind(message.controlKind)
  if (message.role === 'assistant') return 'Assistant'
  if (message.role === 'user' && message.content.some((block) => block.type === 'tool_result')) {
    return 'Tool Result'
  }
  if (message.role === 'user') return 'User'
  return message.role
}

function previewContextMessage(message: MessageLike): string {
  const text = message.content
    .flatMap((block) => {
      if (block.type === 'text') return [asText(block.text)]
      if (block.type === 'tool_use')
        return [`${asText(block.name)} ${safeStringify(block.input ?? {})}`]
      if (block.type === 'tool_result')
        return [asText(block.outputSummary) || asText(block.content)]
      if (block.type === 'thinking') return [asText(block.thinking)]
      if (block.type === 'image') return ['image']
      return []
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  return text.length > 88 ? `${text.slice(0, 85).trimEnd()}...` : text
}

function formatControlKind(controlKind: string | undefined): string {
  if (!controlKind) return 'Control'
  return controlKind
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function addContextTokenSection(
  sections: Map<string, ContextTokenSection>,
  next: ContextTokenSection,
): void {
  if (next.tokens <= 0) return

  const current = sections.get(next.key)
  if (!current) {
    sections.set(next.key, next)
    return
  }

  sections.set(next.key, {
    ...current,
    tokens: current.tokens + next.tokens,
    detail: current.detail ?? next.detail,
  })
}

function finalizeContextTokenSections(
  sections: Map<string, ContextTokenSection>,
): ContextTokenSection[] {
  return Array.from(sections.values())
    .filter((section) => section.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens)
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}
