import {
  type DecisionLogEntry,
  type DecisionType,
  type TraceKind,
  asRecord,
  asString,
  flattenTraceSpans,
} from '@zero-os/observe'
import {
  type LlmRequestLike,
  type TokenUsageSummary,
  estimateContentTokens,
  estimateToolResultTokens,
  estimatedTokenUsage,
  tokenUsageFromRequest,
} from './context-tokens'
import {
  type MemoryInjectionEntry,
  isMemoryHintText,
  isMemoryInjectText,
  pickMemoryInjectionPreview,
  readMemoryRetrievalDetail,
} from './memory-retrieval'

export interface ContentBlock {
  type: string
  [key: string]: unknown
}

export interface Message {
  id: string
  role: string
  messageType: string
  controlKind?: string
  content: ContentBlock[]
  model?: string
  createdAt: string
}

export interface SessionTaskClosureEvent {
  ts: string
  event: 'task_closure_decision' | 'task_closure_failed'
  sessionId?: string
  action?: 'finish' | 'continue' | 'block'
  reason: string
  classifierRequest: {
    prompt: string
    maxTokens: number
  }
  failureStage?: 'parse_classifier_response' | 'request_classifier'
  classifierResponseRaw?: string
  assistantMessageId?: string
  assistantMessageCreatedAt?: string
  error?: string
}

export interface TaskClosureTimelineItem {
  type: 'task-closure'
  id: string
  event: SessionTaskClosureEvent['event']
  action?: SessionTaskClosureEvent['action']
  reason: string
  failureStage?: SessionTaskClosureEvent['failureStage']
  classifierRequest?: SessionTaskClosureEvent['classifierRequest']
  classifierResponseRaw?: string
  assistantMessageId?: string
  assistantMessageCreatedAt?: string
  error?: string
  createdAt: string
}

export type SessionDecisionType = DecisionType

export type SessionDecisionEvent = Omit<DecisionLogEntry, 'sourceKind'> & {
  sourceKind: string
}

export interface DecisionTimelineItem {
  type: 'decision'
  id: string
  decisionType: SessionDecisionType
  outcome: string
  context?: Record<string, unknown>
  detail?: Record<string, unknown>
  rationale?: string
  durationMs?: number
  sourceKind: string
  createdAt: string
}

export interface SystemEventTimelineItem {
  type: 'system-event'
  variant: 'warning' | 'info'
  text: string
  createdAt: string
  label?: string
  chips?: string[]
  source?: 'notification' | 'control' | 'trace'
  controlKind?: string
}

export interface TraceSpan {
  id: string
  parentId?: string
  sessionId: string
  kind?: TraceKind
  name: string
  startTime: string
  endTime?: string
  durationMs?: number
  status: 'running' | 'success' | 'error'
  data?: Record<string, unknown>
  metadata?: Record<string, unknown>
  children: TraceSpan[]
}

interface TimelineToolResult {
  toolUseId: string
  content?: string
  isError?: boolean
  outputSummary?: string
  contentItems?: ToolResultContentItem[]
}

interface TimelineRequestLike {
  id?: string
  turnIndex?: number
  parentId?: string
  ts?: string
  model?: string
  provider?: string
  userPrompt?: string
  response?: string
  stopReason?: string
  toolUseCount?: number
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>
  memoryInjections?: MemoryInjectionEntry[]
  toolResults?: TimelineToolResult[]
  tokens?: {
    input: number
    output: number
    cacheWrite?: number
    cacheRead?: number
    reasoning?: number
  }
  cost?: number
  durationMs?: number
}

interface TaskClosureTraceDetails {
  event?: SessionTaskClosureEvent['event']
  called?: boolean
  action?: SessionTaskClosureEvent['action']
  reason?: string
  failureStage?: SessionTaskClosureEvent['failureStage']
  classifierRequest?: SessionTaskClosureEvent['classifierRequest']
  classifierResponseRaw?: string
  assistantMessageId?: string
  assistantMessageCreatedAt?: string
  error?: string
}

export interface SubAgentChildToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  summary?: string
  contentItems?: ToolResultContentItem[]
  isError?: boolean
  durationMs?: number
}

export type ToolResultContentItem =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string }

export interface MemoryNudgeTimelineItem {
  type: 'memory-nudge'
  id: string
  prompt: string
  createdAt: string
  source: 'control' | 'trace'
  iteration?: number
  memoryWritten?: boolean
  durationMs?: number
  status: TraceSpan['status']
  relatedToolCalls: SubAgentChildToolCall[]
}

export interface SubAgentTimelineItem {
  type: 'sub-agent'
  agentId: string
  label: string
  role?: string
  model?: string
  instruction: string
  status: 'running' | 'waiting' | 'completed' | 'errored' | 'closed'
  output?: string
  durationMs?: number
  spawnToolCallId: string
  childToolCalls: SubAgentChildToolCall[]
  traceSpan?: TraceSpan | null
  createdAt: string
}

export type TimelineItem =
  | {
      type: 'user-message'
      text: string
      queued: boolean
      images?: Array<{ mediaType: string; data: string }>
      createdAt: string
      tokenUsage?: TokenUsageSummary
    }
  | {
      type: 'agent-text'
      messageId: string
      text: string
      model?: string
      createdAt: string
      tokenUsage?: TokenUsageSummary
    }
  | {
      type: 'tool-call'
      id: string
      name: string
      input: Record<string, unknown>
      result?: string
      summary?: string
      contentItems?: ToolResultContentItem[]
      isError?: boolean
      status?: TraceSpan['status']
      durationMs?: number
      createdAt: string
      tokenUsage?: TokenUsageSummary
      resultTokenUsage?: TokenUsageSummary
    }
  | DecisionTimelineItem
  | TaskClosureTimelineItem
  | SystemEventTimelineItem
  | MemoryNudgeTimelineItem
  | SubAgentTimelineItem

export function buildTimeline(
  messages: Message[],
  traces: TraceSpan[] = [],
  taskClosureEvents: SessionTaskClosureEvent[] = [],
  decisions: SessionDecisionEvent[] = [],
  llmRequests: TimelineRequestLike[] = [],
): TimelineItem[] {
  const items: TimelineItem[] = []
  const toolResults = buildToolResultMap(messages, traces, llmRequests)
  const toolDurations = extractToolDurations(traces)
  const toolStatuses = extractToolStatuses(traces)
  const requestMatcher = createRequestTokenMatcher(llmRequests)
  const matchedMemoryInjectionTexts = buildMatchedMemoryInjectionTextSet(decisions, llmRequests)
  const handledSubAgentIds = new Set<string>()
  const spawnToolCallIds = new Set<string>()
  const memoryNudgeSpans = collectMemoryNudgeSpans(traces)
  const usedMemoryNudgeSpanIds = new Set<string>()
  const nestedMemoryNudgeToolUseIds = buildMemoryNudgeToolUseIdSet(memoryNudgeSpans, traces)

  for (const msg of messages) {
    if (msg.messageType === 'control') {
      if (msg.controlKind === 'memory_nudge') {
        items.push(
          buildMemoryNudgeTimelineItemFromMessage(
            msg,
            memoryNudgeSpans,
            usedMemoryNudgeSpanIds,
            traces,
            toolResults,
            toolDurations,
          ),
        )
        continue
      }
      const event = buildControlSystemEvent(msg)
      if (event) items.push(event)
      continue
    }

    if (msg.messageType === 'notification') {
      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text as string)
        .join('\n')
      if (text) {
        if (isMemoryInjectText(text) && matchedMemoryInjectionTexts.has(text.trim())) {
          continue
        }
        const isMemoryNotice = isMemoryInjectText(text) || isMemoryHintText(text)
        const isWarning =
          !isMemoryNotice &&
          (text.toLowerCase().includes('timeout') ||
            text.toLowerCase().includes('error') ||
            text.toLowerCase().includes('degrad'))
        const event: SystemEventTimelineItem = {
          type: 'system-event',
          variant: isWarning ? 'warning' : 'info',
          text,
          createdAt: msg.createdAt,
          label: isMemoryNotice ? 'Memory Notice' : undefined,
          source: 'notification',
        }
        items.push(event)
      }
      continue
    }

    if (msg.role === 'user') {
      if (msg.messageType === 'queued') {
        continue
      }

      const hasToolResultBlocks = msg.content.some((b) => b.type === 'tool_result')
      if (hasToolResultBlocks) {
        continue
      }

      const textBlocks = msg.content.filter((b) => b.type === 'text')
      const imageBlocks = msg.content
        .filter((b) => b.type === 'image')
        .map((b) => ({
          mediaType: b.mediaType as string,
          data: b.data as string,
        }))

      if (textBlocks.length > 0 || imageBlocks.length > 0) {
        const text = textBlocks.map((b) => b.text as string).join('\n')
        items.push({
          type: 'user-message',
          text,
          queued: false,
          images: imageBlocks.length > 0 ? imageBlocks : undefined,
          createdAt: msg.createdAt,
          tokenUsage: estimatedTokenUsage(estimateContentTokens(msg.content)),
        })
      }
      continue
    }

    if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if (block.type === 'text') {
          items.push({
            type: 'agent-text',
            messageId: msg.id,
            text: block.text as string,
            model: msg.model,
            createdAt: msg.createdAt,
            tokenUsage: requestMatcher.claimAssistantText(block.text as string),
          })
        } else if (block.type === 'tool_use') {
          const toolName = block.name as string
          const toolId = block.id as string
          const toolInput = (block.input as Record<string, unknown>) ?? {}
          const result = toolResults.get(toolId)

          if (nestedMemoryNudgeToolUseIds.has(toolId)) {
            continue
          }

          if (toolName === 'spawn_agent') {
            // Try multiple sources for agentId:
            // 1. Parse from tool result JSON (may be artifactized to non-JSON)
            // 2. Look in trace spans for spawn_agent tool span metadata
            // 3. Fall back to toolId
            const agentIdFromResult =
              (result?.content ? tryParseJsonField(result.content, 'agent_id') : null) ??
              (result?.content ? tryParseJsonField(result.content, 'agentId') : null)
            const agentIdFromTrace = findAgentIdFromTraceSpan(traces, toolId)
            const agentId =
              agentIdFromResult ??
              agentIdFromTrace ??
              (toolInput.agent_id as string | undefined) ??
              (toolInput.agentId as string | undefined) ??
              toolId

            const labelFromResult = result?.content
              ? tryParseJsonField(result.content, 'label')
              : null
            const labelFromTrace = findLabelFromTraceSpan(traces, toolId)
            const label =
              (toolInput.label as string | undefined) ??
              labelFromResult ??
              labelFromTrace ??
              (toolInput.name as string | undefined) ??
              agentId
            const role = toolInput.role as string | undefined
            const instruction = (toolInput.instruction as string | undefined) ?? ''

            const waitInfo = findWaitAgentResult(messages, agentId, toolResults)
            const traceSpan = findSubAgentSpan(traces, agentId, toolId)
            const traceInfo = getSubAgentTraceInfoFromSpan(traceSpan)
            const model =
              asString(toolInput.model) ??
              (result?.content ? tryParseJsonField(result.content, 'model') : null) ??
              waitInfo?.model ??
              traceInfo?.model ??
              findModelFromTraceSpan(traces, toolId, agentId)
            const childToolCalls = extractSubAgentChildToolCallsFromSpan(traceSpan)

            handledSubAgentIds.add(agentId)
            spawnToolCallIds.add(toolId)

            // Prefer trace-based duration (actual agent runtime) over wait_agent or tool span duration
            const resolvedDurationMs = traceInfo?.durationMs ?? waitInfo?.durationMs
            const resolvedStatus = (() => {
              if (waitInfo?.status === 'waiting') return 'waiting' as const
              if (traceInfo?.status && traceInfo.status !== 'running') return traceInfo.status
              if (waitInfo?.status) return waitInfo.status
              if (traceInfo?.status) return traceInfo.status
              return result?.isError ? ('errored' as const) : ('running' as const)
            })()
            const resolvedOutput = waitInfo?.output ?? traceInfo?.output

            items.push({
              type: 'sub-agent',
              agentId,
              label,
              role,
              model: model ?? undefined,
              instruction,
              status: resolvedStatus,
              output: resolvedOutput,
              durationMs: resolvedDurationMs,
              spawnToolCallId: toolId,
              childToolCalls,
              traceSpan,
              createdAt: msg.createdAt,
            })
          } else if (
            (toolName === 'wait_agent' ||
              toolName === 'close_agent' ||
              toolName === 'send_input') &&
            isHandledSubAgentTool(toolInput, handledSubAgentIds)
          ) {
            // Skip — already represented by the sub-agent block
          } else {
            items.push({
              type: 'tool-call',
              id: toolId,
              name: toolName,
              input: toolInput,
              result: result?.content,
              summary: result?.summary,
              contentItems: result?.contentItems,
              isError: result?.isError,
              status:
                toolStatuses.get(toolId) ??
                (result ? (result.isError ? 'error' : 'success') : 'running'),
              durationMs: toolDurations.get(toolId),
              createdAt: msg.createdAt,
              tokenUsage: requestMatcher.claimToolCall(toolId),
              resultTokenUsage: estimatedTokenUsage(
                estimateToolResultTokens(result?.content, result?.contentItems),
              ),
            })
          }
        }
      }
    }
  }

  items.push(...buildDecisionEvents(decisions))
  items.push(...buildTaskClosureEvents(traces, taskClosureEvents))
  items.push(
    ...buildTraceMemoryNudgeItems(
      memoryNudgeSpans,
      usedMemoryNudgeSpanIds,
      traces,
      toolResults,
      toolDurations,
    ),
  )
  return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

function createRequestTokenMatcher(llmRequests: TimelineRequestLike[]) {
  const requests = llmRequests
    .flatMap((request) => normalizeTimelineRequest(request))
    .sort((left, right) => left.ts.localeCompare(right.ts))
  const usedRequestIds = new Set<string>()

  const claim = (
    predicate: (request: LlmRequestLike) => boolean,
  ): TokenUsageSummary | undefined => {
    const request = requests.find(
      (candidate) => !usedRequestIds.has(candidate.id) && predicate(candidate),
    )
    if (!request) return undefined
    usedRequestIds.add(request.id)
    return tokenUsageFromRequest(request)
  }

  return {
    claimAssistantText(text: string): TokenUsageSummary | undefined {
      const normalizedText = normalizeRequestText(text)
      if (!normalizedText) return undefined

      return claim((request) => {
        const response = normalizeRequestText(request.response)
        return response === normalizedText || response.includes(normalizedText)
      })
    },

    claimToolCall(toolUseId: string): TokenUsageSummary | undefined {
      return claim((request) => {
        return request.toolCalls?.some((toolCall) => toolCall.id === toolUseId) === true
      })
    },
  }
}

function normalizeTimelineRequest(request: TimelineRequestLike): LlmRequestLike[] {
  if (
    !request.id ||
    !request.model ||
    !request.provider ||
    request.userPrompt === undefined ||
    request.response === undefined ||
    !request.stopReason ||
    !request.tokens ||
    request.cost === undefined ||
    !request.ts
  ) {
    return []
  }

  return [
    {
      id: request.id,
      turnIndex: request.turnIndex,
      parentId: request.parentId,
      model: request.model,
      provider: request.provider,
      userPrompt: request.userPrompt,
      response: request.response,
      stopReason: request.stopReason,
      toolUseCount: request.toolUseCount ?? request.toolCalls?.length ?? 0,
      toolCalls: request.toolCalls,
      toolResults: request.toolResults,
      memoryInjections: request.memoryInjections,
      tokens: request.tokens,
      cost: request.cost,
      durationMs: request.durationMs,
      ts: request.ts,
    },
  ]
}

function normalizeRequestText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function buildControlSystemEvent(message: Message): SystemEventTimelineItem | null {
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text as string)
    .join('\n')
    .trim()

  if (!text) return null

  const controlKind = message.controlKind
  const sanitizedText = sanitizeSystemEventText(text)
  const chips = controlKind ? buildControlEventChips(controlKind) : undefined

  return {
    type: 'system-event',
    variant: controlKind === 'empty_retry' ? 'warning' : 'info',
    text: summarizeControlEventText(controlKind, sanitizedText),
    createdAt: message.createdAt,
    label: controlKind ? formatControlKindLabel(controlKind) : 'System Event',
    chips,
    source: 'control',
    controlKind,
  }
}

function collectMemoryNudgeSpans(traces: TraceSpan[]): TraceSpan[] {
  return flattenTraceSpans(traces)
    .filter((span) => span.name === 'memory_nudge')
    .sort(compareTimelineSpans)
}

function buildMemoryNudgeTimelineItemFromMessage(
  message: Message,
  memoryNudgeSpans: TraceSpan[],
  usedMemoryNudgeSpanIds: Set<string>,
  traces: TraceSpan[],
  toolResults: Map<string, TimelineToolResultData>,
  toolDurations: Map<string, number>,
): MemoryNudgeTimelineItem {
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text as string)
    .join('\n')
    .trim()
  const matchedSpan = findMatchingMemoryNudgeSpan(
    message.createdAt,
    memoryNudgeSpans,
    usedMemoryNudgeSpanIds,
  )

  if (matchedSpan) {
    usedMemoryNudgeSpanIds.add(matchedSpan.id)
  }

  return buildMemoryNudgeTimelineItem({
    id: `memory-nudge-msg-${message.id}`,
    prompt: sanitizeSystemEventText(extractMemoryNudgePrompt(matchedSpan) ?? text),
    createdAt: message.createdAt,
    source: 'control',
    iteration: extractMemoryNudgeIteration(matchedSpan),
    memoryWritten: matchedSpan ? asBoolean(matchedSpan.metadata?.memoryWritten) : undefined,
    durationMs: matchedSpan?.durationMs,
    status: matchedSpan?.status ?? 'success',
    relatedToolCalls: matchedSpan
      ? extractMemoryNudgeRelatedToolCalls(matchedSpan, traces, toolResults, toolDurations)
      : [],
  })
}

function buildTraceMemoryNudgeItems(
  memoryNudgeSpans: TraceSpan[],
  usedMemoryNudgeSpanIds: Set<string>,
  traces: TraceSpan[],
  toolResults: Map<string, TimelineToolResultData>,
  toolDurations: Map<string, number>,
): MemoryNudgeTimelineItem[] {
  return memoryNudgeSpans
    .filter((span) => !usedMemoryNudgeSpanIds.has(span.id))
    .map((span) => {
      usedMemoryNudgeSpanIds.add(span.id)
      return mapMemoryNudgeTraceSpan(span, traces, toolResults, toolDurations)
    })
}

function mapMemoryNudgeTraceSpan(
  span: TraceSpan,
  traces: TraceSpan[],
  toolResults: Map<string, TimelineToolResultData>,
  toolDurations: Map<string, number>,
): MemoryNudgeTimelineItem {
  const metadata = span.metadata ?? {}
  return buildMemoryNudgeTimelineItem({
    id: `memory-nudge-trace-${span.id}`,
    prompt: sanitizeSystemEventText(
      extractMemoryNudgePrompt(span) ?? '当前阶段已完成。请快速评估是否需要保留跨会话记忆。',
    ),
    createdAt: span.endTime ?? span.startTime,
    source: 'trace',
    iteration: extractMemoryNudgeIteration(span),
    memoryWritten: asBoolean(metadata.memoryWritten),
    durationMs: span.durationMs,
    status: span.status,
    relatedToolCalls: extractMemoryNudgeRelatedToolCalls(span, traces, toolResults, toolDurations),
  })
}

function buildMemoryNudgeTimelineItem(
  item: Omit<MemoryNudgeTimelineItem, 'type'>,
): MemoryNudgeTimelineItem {
  return {
    type: 'memory-nudge',
    ...item,
  }
}

function extractMemoryNudgePrompt(span: TraceSpan | null | undefined): string | undefined {
  if (!span) return undefined
  const metadata = span.metadata ?? {}
  const nudge = asRecord(span.data?.memoryNudge)
  return (
    asString(nudge?.prompt) ?? asString(span.data?.prompt) ?? asString(metadata.prompt) ?? undefined
  )
}

function extractMemoryNudgeIteration(span: TraceSpan | null | undefined): number | undefined {
  if (!span) return undefined
  const metadata = span.metadata ?? {}
  const nudge = asRecord(span.data?.memoryNudge)
  return numberFromUnknown(metadata.iteration) ?? numberFromUnknown(nudge?.iteration)
}

function findMatchingMemoryNudgeSpan(
  createdAt: string,
  memoryNudgeSpans: TraceSpan[],
  usedMemoryNudgeSpanIds: Set<string>,
): TraceSpan | null {
  const targetTime = Date.parse(createdAt)
  const candidates = memoryNudgeSpans.filter((span) => !usedMemoryNudgeSpanIds.has(span.id))
  if (candidates.length === 0) return null

  if (!Number.isFinite(targetTime)) {
    return candidates[0] ?? null
  }

  let bestMatch: TraceSpan | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const span of candidates) {
    const referenceTime = Date.parse(span.endTime ?? span.startTime)
    if (!Number.isFinite(referenceTime)) {
      if (!bestMatch) bestMatch = span
      continue
    }

    const distance = Math.abs(referenceTime - targetTime)
    if (distance < bestDistance) {
      bestDistance = distance
      bestMatch = span
    }
  }

  return bestMatch
}

function buildMemoryNudgeToolUseIdSet(
  memoryNudgeSpans: TraceSpan[],
  traces: TraceSpan[],
): Set<string> {
  const toolUseIds = new Set<string>()

  for (const span of memoryNudgeSpans) {
    for (const toolSpan of findMemoryToolSpansForNudge(span, traces)) {
      const toolUseId = asString(toolSpan.metadata?.toolUseId)
      if (toolUseId) toolUseIds.add(toolUseId)
    }
  }

  return toolUseIds
}

function extractMemoryNudgeRelatedToolCalls(
  memoryNudgeSpan: TraceSpan,
  traces: TraceSpan[],
  toolResults: Map<string, TimelineToolResultData>,
  toolDurations: Map<string, number>,
): SubAgentChildToolCall[] {
  const relatedToolCalls: SubAgentChildToolCall[] = []
  const seenToolIds = new Set<string>()

  for (const toolSpan of findMemoryToolSpansForNudge(memoryNudgeSpan, traces)) {
    const metadata = toolSpan.metadata ?? {}
    const toolUseId = asString(metadata.toolUseId) ?? toolSpan.id
    if (seenToolIds.has(toolUseId)) continue
    seenToolIds.add(toolUseId)

    const toolName = asString(metadata.toolName) ?? toolSpan.name.replace(/^tool:/, '') ?? 'memory'
    const toolResult = toolResults.get(toolUseId)
    relatedToolCalls.push({
      id: toolUseId,
      name: toolName,
      input: asRecord(metadata.input) ?? {},
      result: toolResult?.content ?? normalizeTraceToolResult(toolName, asString(metadata.result)),
      summary:
        toolResult?.summary ??
        normalizeToolText(
          asString(metadata.outputSummary) ?? asString(toolSpan.data?.outputSummary),
        ),
      contentItems: toolResult?.contentItems,
      isError: toolResult?.isError === true || toolSpan.status === 'error',
      durationMs: toolDurations.get(toolUseId) ?? toolSpan.durationMs,
    })
  }

  return relatedToolCalls
}

function findMemoryToolSpansForNudge(memoryNudgeSpan: TraceSpan, traces: TraceSpan[]): TraceSpan[] {
  const startTime = Date.parse(memoryNudgeSpan.startTime)
  const endTime = Date.parse(memoryNudgeSpan.endTime ?? memoryNudgeSpan.startTime)
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return []

  return flattenTraceSpans(traces)
    .filter((span) => span.sessionId === memoryNudgeSpan.sessionId)
    .filter((span) => span.id !== memoryNudgeSpan.id)
    .filter(isMemoryToolSpan)
    .filter((span) => doesSpanOverlapWindow(span, startTime, endTime))
    .sort(compareTimelineSpans)
}

function isMemoryToolSpan(span: TraceSpan): boolean {
  if (!span.name.startsWith('tool:')) return false
  const toolName = (
    asString(span.metadata?.toolName) ?? span.name.replace(/^tool:/, '')
  ).toLowerCase()
  return toolName === 'memory' || toolName === 'memory_search' || toolName === 'memory_read'
}

function doesSpanOverlapWindow(span: TraceSpan, windowStart: number, windowEnd: number): boolean {
  const spanStart = Date.parse(span.startTime)
  const spanEnd = Date.parse(span.endTime ?? span.startTime)
  if (!Number.isFinite(spanStart) || !Number.isFinite(spanEnd)) return false
  return spanStart <= windowEnd && spanEnd >= windowStart
}

function compareTimelineSpans(left: TraceSpan, right: TraceSpan): number {
  const leftTime = Date.parse(left.startTime)
  const rightTime = Date.parse(right.startTime)

  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime
  }

  return left.name.localeCompare(right.name)
}

function summarizeControlEventText(controlKind: string | undefined, text: string): string {
  if (!text) return 'Internal control step'

  if (controlKind === 'memory_nudge') {
    const questionSentence = text.match(/^(.+?[?？])/u)?.[1]?.trim()
    if (questionSentence) return questionSentence
    const firstSentence = text.match(/^[^!?。！？]+[!?。！？]?/u)?.[0]?.trim()
    return firstSentence || truncateSystemEventText(text)
  }

  return truncateSystemEventText(text)
}

function sanitizeSystemEventText(text: string): string {
  return text
    .replace(/<\/?system_notice>/g, ' ')
    .replace(/<\/?memory_hint>/g, ' ')
    .replace(/<\/?memory_inject[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateSystemEventText(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 197).trimEnd()}...`
}

function formatControlKindLabel(controlKind: string): string {
  if (controlKind === 'memory_nudge') return 'Memory Nudge'
  if (controlKind === 'task_closure') return 'Task Closure Prompt'
  if (controlKind === 'queued_injection') return 'Queued Injection'
  if (controlKind === 'empty_retry') return 'Empty Retry'
  if (controlKind === 'continuation') return 'Continuation'

  return controlKind
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function buildControlEventChips(controlKind: string): string[] | undefined {
  if (controlKind === 'memory_nudge') return ['post-turn', 'memory check']
  if (controlKind === 'queued_injection') return ['queue']
  if (controlKind === 'task_closure') return ['closure gate']
  if (controlKind === 'empty_retry') return ['retry']
  return undefined
}

function buildMatchedMemoryInjectionTextSet(
  decisions: SessionDecisionEvent[],
  llmRequests: TimelineRequestLike[],
): Set<string> {
  const matched = new Set<string>()

  for (const decision of filterDisplayableDecisions(decisions)) {
    if (decision.decisionType !== 'memory_retrieval') continue
    const detail = readMemoryRetrievalDetail(decision.detail)
    const preview = pickMemoryInjectionPreview(
      { outcome: decision.outcome, createdAt: decision.ts },
      detail,
      llmRequests.map((request) => ({
        turnIndex: 'turnIndex' in request ? request.turnIndex : undefined,
        ts: 'ts' in request && typeof request.ts === 'string' ? request.ts : decision.ts,
        memoryInjections:
          'memoryInjections' in request && Array.isArray(request.memoryInjections)
            ? request.memoryInjections
            : undefined,
      })),
    )

    for (const injection of preview) {
      matched.add(injection.formattedText.trim())
    }
  }

  return matched
}

function buildTaskClosureEvents(
  traces: TraceSpan[],
  taskClosureEvents: SessionTaskClosureEvent[],
): TimelineItem[] {
  const flattenedTraces = flattenTraceSpans(traces)
  const traceItems = flattenedTraces
    .flatMap((span) => {
      if (span.name === 'task_closure_decision') {
        return [mapTaskClosureDecision(span)]
      }
      if (span.name === 'task_closure_failed') {
        return [mapTaskClosureFailed(span)]
      }
      return []
    })
    .filter((item): item is TaskClosureTimelineItem => item !== null)

  const sessionItems = filterDuplicateTaskClosureEvents(flattenedTraces, taskClosureEvents).map(
    (event, index) => mapSessionTaskClosureEvent(event, index),
  )
  return [...traceItems, ...sessionItems]
}

function buildDecisionEvents(decisions: SessionDecisionEvent[]): DecisionTimelineItem[] {
  return filterDisplayableDecisions(decisions).map((decision) => ({
    type: 'decision',
    id: decision.id,
    decisionType: decision.decisionType,
    outcome: decision.outcome,
    context: decision.context,
    detail: decision.detail,
    rationale: decision.rationale,
    durationMs: decision.durationMs,
    sourceKind: decision.sourceKind,
    createdAt: decision.ts,
  }))
}

export function filterDisplayableDecisions(
  decisions: SessionDecisionEvent[],
): SessionDecisionEvent[] {
  return decisions.filter((decision) => decision.decisionType !== 'task_closure')
}

export function filterDuplicateTaskClosureEvents(
  traces: TraceSpan[],
  taskClosureEvents: SessionTaskClosureEvent[],
): SessionTaskClosureEvent[] {
  const traceKeys = new Set(
    traces.map(getTaskClosureTraceKey).filter((key): key is string => key !== null),
  )

  return taskClosureEvents.filter((event) => {
    const eventKey = getSessionTaskClosureEventKey(event)
    return eventKey === null || !traceKeys.has(eventKey)
  })
}

function mapSessionTaskClosureEvent(
  event: SessionTaskClosureEvent,
  index: number,
): TaskClosureTimelineItem {
  const createdAt = event.assistantMessageCreatedAt ?? event.ts

  return buildTaskClosureTimelineItem({
    id: `tc-sess-${index}`,
    event: event.event,
    action: event.action,
    reason: event.reason,
    failureStage: event.failureStage,
    classifierRequest: event.classifierRequest,
    classifierResponseRaw: event.classifierResponseRaw,
    assistantMessageId: event.assistantMessageId,
    assistantMessageCreatedAt: event.assistantMessageCreatedAt,
    error: event.error,
    createdAt,
  })
}

function mapTaskClosureDecision(span: TraceSpan): TaskClosureTimelineItem | null {
  const details = getTaskClosureTraceDetails(span)
  const createdAt = details.assistantMessageCreatedAt ?? span.endTime ?? span.startTime

  if (details.called === false) return null

  return buildTaskClosureTimelineItem({
    id: `tc-trace-${span.id}`,
    event: details.event ?? 'task_closure_decision',
    action: details.action,
    reason: details.reason ?? '',
    failureStage: details.failureStage,
    classifierRequest: details.classifierRequest,
    classifierResponseRaw: details.classifierResponseRaw,
    assistantMessageId: details.assistantMessageId,
    assistantMessageCreatedAt: details.assistantMessageCreatedAt,
    error: details.error,
    createdAt,
  })
}

function mapTaskClosureFailed(span: TraceSpan): TaskClosureTimelineItem {
  const details = getTaskClosureTraceDetails(span)
  return buildTaskClosureTimelineItem({
    id: `tc-trace-${span.id}`,
    event: details.event ?? 'task_closure_failed',
    action: details.action,
    reason: details.reason ?? 'task closure failed',
    failureStage: details.failureStage,
    classifierRequest: details.classifierRequest,
    classifierResponseRaw: details.classifierResponseRaw,
    assistantMessageId: details.assistantMessageId,
    assistantMessageCreatedAt: details.assistantMessageCreatedAt,
    error: details.error,
    createdAt: details.assistantMessageCreatedAt ?? span.endTime ?? span.startTime,
  })
}

function buildTaskClosureTimelineItem(
  item: Omit<TaskClosureTimelineItem, 'type'>,
): TaskClosureTimelineItem {
  return {
    type: 'task-closure',
    ...item,
  }
}

function extractToolDurations(traces: TraceSpan[]): Map<string, number> {
  const toolDurations = new Map<string, number>()

  for (const span of flattenTraceSpans(traces)) {
    if (!span.name.startsWith('tool:') || typeof span.durationMs !== 'number') continue
    const toolUseId =
      span.metadata && typeof span.metadata.toolUseId === 'string' ? span.metadata.toolUseId : null
    if (!toolUseId) continue
    toolDurations.set(toolUseId, span.durationMs)
  }

  return toolDurations
}

function extractToolStatuses(traces: TraceSpan[]): Map<string, TraceSpan['status']> {
  const toolStatuses = new Map<string, TraceSpan['status']>()

  for (const span of flattenTraceSpans(traces)) {
    if (!span.name.startsWith('tool:')) continue
    const toolUseId =
      span.metadata && typeof span.metadata.toolUseId === 'string' ? span.metadata.toolUseId : null
    if (!toolUseId) continue
    toolStatuses.set(toolUseId, span.status)
  }

  return toolStatuses
}

function buildToolResultMap(
  messages: Message[],
  traces: TraceSpan[],
  llmRequests: TimelineRequestLike[],
): Map<string, TimelineToolResultData> {
  const toolResults = new Map<string, TimelineToolResultData>()
  const toolNames = buildToolNameMap(messages, traces)

  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'system') continue
    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue
      const toolUseId = block.toolUseId as string
      mergeToolResult(toolResults, toolUseId, toolNames.get(toolUseId) ?? 'generic', {
        content: asString(block.content),
        summary: asString(block.outputSummary),
        contentItems: normalizeToolResultContentItems(block.contentItems),
        isError: block.isError === true,
      })
    }
  }

  for (const request of llmRequests) {
    for (const result of request.toolResults ?? []) {
      mergeToolResult(toolResults, result.toolUseId, toolNames.get(result.toolUseId) ?? 'generic', {
        content: result.content,
        summary: result.outputSummary,
        contentItems: result.contentItems,
        isError: result.isError === true,
      })
    }
  }

  for (const span of flattenTraceSpans(traces)) {
    if (!span.name.startsWith('tool:')) continue
    const metadata = span.metadata ?? {}
    const data = span.data ?? {}
    const toolUseId = asString(metadata.toolUseId)
    if (!toolUseId) continue

    const toolName = asString(metadata.toolName) ?? span.name.replace('tool:', '')
    const traceResult = normalizeTraceToolResult(toolName, asString(metadata.result))
    const traceSummary = normalizeToolText(
      asString(metadata.outputSummary) ?? asString(data.outputSummary),
    )

    mergeToolResult(toolResults, toolUseId, toolName, {
      content: traceResult,
      summary: traceSummary,
      isError: span.status === 'error',
    })
  }

  return toolResults
}

function buildToolNameMap(messages: Message[], traces: TraceSpan[]): Map<string, string> {
  const toolNames = new Map<string, string>()

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const block of msg.content) {
      if (block.type !== 'tool_use') continue
      if (typeof block.id === 'string' && typeof block.name === 'string') {
        toolNames.set(block.id, block.name.toLowerCase())
      }
    }
  }

  for (const span of flattenTraceSpans(traces)) {
    if (!span.name.startsWith('tool:')) continue
    const toolUseId = asString(span.metadata?.toolUseId)
    const toolName = asString(span.metadata?.toolName) ?? span.name.replace('tool:', '')
    if (toolUseId && toolName) {
      toolNames.set(toolUseId, toolName.toLowerCase())
    }
  }

  return toolNames
}

function mergeToolResult(
  target: Map<string, TimelineToolResultData>,
  toolUseId: string,
  toolName: string,
  incoming: TimelineToolResultData,
) {
  const current = target.get(toolUseId)

  target.set(toolUseId, {
    content: pickPreferredToolText(toolName, current?.content, incoming.content, 'content'),
    summary: pickPreferredToolText(
      toolName,
      current?.summary,
      incoming.summary ?? incoming.content,
      'summary',
    ),
    contentItems:
      incoming.contentItems && incoming.contentItems.length > 0
        ? incoming.contentItems
        : current?.contentItems,
    isError: current?.isError === true || incoming.isError === true,
  })
}

interface TimelineToolResultData {
  content?: string
  summary?: string
  contentItems?: ToolResultContentItem[]
  isError?: boolean
}

function normalizeToolResultContentItems(value: unknown): ToolResultContentItem[] | undefined {
  if (!Array.isArray(value)) return undefined

  const items = value.flatMap((item): ToolResultContentItem[] => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      return [{ type: 'text', text: record.text }]
    }
    if (
      record.type === 'image' &&
      typeof record.mediaType === 'string' &&
      typeof record.data === 'string'
    ) {
      return [{ type: 'image', mediaType: record.mediaType, data: record.data }]
    }
    return []
  })

  return items.length > 0 ? items : undefined
}

function pickPreferredToolText(
  toolName: string,
  current: string | undefined,
  incoming: string | undefined,
  purpose: 'content' | 'summary',
): string | undefined {
  const normalizedCurrent = normalizeToolText(current)
  const normalizedIncoming = normalizeToolText(incoming)
  if (!normalizedIncoming) return normalizedCurrent
  if (!normalizedCurrent) return normalizedIncoming

  return scoreToolResultText(toolName, normalizedIncoming, purpose) >
    scoreToolResultText(toolName, normalizedCurrent, purpose)
    ? normalizedIncoming
    : normalizedCurrent
}

function scoreToolResultText(
  toolName: string,
  value: string,
  purpose: 'content' | 'summary',
): number {
  const trimmed = normalizeToolText(value)
  if (!trimmed) return 0
  if (isGenericToolStatusText(trimmed)) return purpose === 'summary' ? 1 : 0

  let score = purpose === 'summary' ? 1 : 2

  if (toolName === 'bash' && trimmed.startsWith('Executed:')) {
    score += purpose === 'summary' ? 1 : 0
  } else if (trimmed.startsWith('Wrote ') || trimmed.startsWith('Edited ')) {
    score += 2
  }

  if (/\[stderr\]/.test(trimmed)) score += 4
  if (/traceback|error|failed|http \d{3}/i.test(trimmed)) score += 4
  if (trimmed.includes('\n')) score += 5
  if (trimmed.length > 200) score += 5
  else if (trimmed.length > 80) score += 4
  else if (trimmed.length > 24) score += 3
  else score += 1

  return score
}

function normalizeTraceToolResult(toolName: string, value: string | undefined): string | undefined {
  const text = normalizeToolText(value)
  if (!text) return undefined
  if (toolName === 'bash' && text.startsWith('Executed:')) return undefined
  return text
}

function normalizeToolText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function isGenericToolStatusText(value: string): boolean {
  const normalized = value
    .replace(/^[✓✔]\s*/u, '')
    .replace(/^[✗✘]\s*/u, '')
    .trim()
    .toLowerCase()

  return (
    normalized === 'success' ||
    normalized === 'ok' ||
    normalized === 'done' ||
    normalized === 'completed' ||
    normalized === 'passed'
  )
}

function getTaskClosureTraceKey(span: TraceSpan): string | null {
  const details = getTaskClosureTraceDetails(span)
  const assistantMessageId = details.assistantMessageId ?? ''

  if (span.name === 'task_closure_decision') {
    if (details.called === false) return null

    const action = details.action ?? 'unknown'
    const reason = details.reason ?? ''
    return `decision|${action}|${reason}|${assistantMessageId}`
  }

  if (span.name === 'task_closure_failed') {
    const reason = details.reason ?? 'task_closure_failed'
    const failureStage = details.failureStage ?? 'unknown'
    return `failed|${failureStage}|${reason}|${assistantMessageId}`
  }

  return null
}

function getSessionTaskClosureEventKey(event: SessionTaskClosureEvent): string | null {
  const assistantMessageId = event.assistantMessageId ?? ''

  if (event.event === 'task_closure_decision') {
    return `decision|${event.action ?? 'unknown'}|${event.reason ?? ''}|${assistantMessageId}`
  }

  if (event.event === 'task_closure_failed') {
    return `failed|${event.failureStage ?? 'unknown'}|${event.reason ?? ''}|${assistantMessageId}`
  }

  return null
}

export function extractFilesTouched(items: TimelineItem[]): string[] {
  const files = new Set<string>()
  for (const item of items) {
    if (item.type === 'tool-call') {
      const path = getTouchedPath(item.input)
      if (path) files.add(path)
    }
    if (item.type === 'memory-nudge') {
      for (const childToolCall of item.relatedToolCalls) {
        const path = getTouchedPath(childToolCall.input)
        if (path) files.add(path)
      }
    }
    if (item.type === 'sub-agent') {
      for (const childToolCall of item.childToolCalls) {
        const path = getTouchedPath(childToolCall.input)
        if (path) files.add(path)
      }
    }
  }
  return Array.from(files)
}

function getTouchedPath(input: Record<string, unknown>): string | null {
  if (typeof input.path === 'string') return input.path
  if (typeof input.file_path === 'string') return input.file_path
  return null
}

export function getTaskClosureTraceDetails(span: TraceSpan): TaskClosureTraceDetails {
  const metadata = span.metadata ?? {}
  const closure = asRecord(asRecord(span.data)?.closure)
  const action = asAction(asString(closure?.action)) ?? asAction(asString(metadata.action))
  const reason = asString(closure?.reason) ?? asString(metadata.reason)

  return {
    event:
      asTaskClosureEvent(asString(closure?.event)) ??
      asTaskClosureEvent(
        span.name === 'task_closure_decision' || span.name === 'task_closure_failed'
          ? span.name
          : undefined,
      ),
    called:
      asBoolean(closure?.called) ??
      asBoolean(metadata.called) ??
      (action !== undefined || reason !== undefined ? true : undefined),
    action,
    reason,
    failureStage:
      asFailureStage(asString(closure?.failureStage)) ??
      asFailureStage(asString(metadata.failureStage)),
    classifierRequest: resolveClassifierRequest(
      closure?.classifierRequest,
      metadata.classifierRequest,
    ),
    classifierResponseRaw:
      asString(closure?.classifierResponseRaw) ?? asString(metadata.classifierResponseRaw),
    assistantMessageId:
      asString(closure?.assistantMessageId) ?? asString(metadata.assistantMessageId),
    assistantMessageCreatedAt:
      asString(closure?.assistantMessageCreatedAt) ?? asString(metadata.assistantMessageCreatedAt),
    error: asString(closure?.error) ?? asString(metadata.error),
  }
}

function resolveClassifierRequest(
  value: unknown,
  fallback: unknown,
): SessionTaskClosureEvent['classifierRequest'] | undefined {
  if (isClassifierRequest(value)) return value
  if (isClassifierRequest(fallback)) return fallback
  return undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asTaskClosureEvent(value: unknown): SessionTaskClosureEvent['event'] | undefined {
  return value === 'task_closure_decision' || value === 'task_closure_failed' ? value : undefined
}

function asAction(value: unknown): SessionTaskClosureEvent['action'] | undefined {
  return value === 'finish' || value === 'continue' || value === 'block' ? value : undefined
}

function asFailureStage(value: unknown): SessionTaskClosureEvent['failureStage'] | undefined {
  return value === 'parse_classifier_response' || value === 'request_classifier' ? value : undefined
}

function isClassifierRequest(
  value: unknown,
): value is SessionTaskClosureEvent['classifierRequest'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.prompt === 'string' && typeof candidate.maxTokens === 'number'
}

function tryParseJsonField(json: string, field: string): string | null {
  try {
    const parsed = JSON.parse(json)
    if (parsed && typeof parsed === 'object' && typeof parsed[field] === 'string') {
      return parsed[field]
    }
  } catch {
    // not valid JSON
  }
  return null
}

/**
 * Find agentId from trace spans by matching the spawn_agent tool call ID.
 * The spawn_agent tool span's metadata contains spawnedAgentId.
 * Alternatively, the sub_agent span's data contains spawnedByRequestId or agentId.
 */
function findAgentIdFromTraceSpan(traces: TraceSpan[], toolUseId: string): string | null {
  const allSpans = flattenTraceSpans(traces)

  // Strategy 1: Find spawn_agent tool span with matching toolUseId in metadata
  for (const span of allSpans) {
    const meta = span.metadata ?? {}
    if (
      span.name === 'tool:spawn_agent' &&
      meta.toolUseId === toolUseId &&
      typeof meta.spawnedAgentId === 'string'
    ) {
      return meta.spawnedAgentId
    }
  }

  // Strategy 2: Find sub_agent span that is a child of the spawn_agent tool span
  for (const span of allSpans) {
    if (span.name === 'tool:spawn_agent') {
      const meta = span.metadata ?? {}
      if (meta.toolUseId === toolUseId) {
        // Look at children for sub_agent span
        for (const child of span.children ?? []) {
          if (child.name.startsWith('sub_agent:')) {
            const childData = child.data ?? {}
            const childMeta = child.metadata ?? {}
            return (childData.agentId as string) ?? (childMeta.agentId as string) ?? child.id
          }
        }
      }
    }
  }

  return null
}

/**
 * Find label from trace spans by matching the spawn_agent tool call ID.
 */
function findLabelFromTraceSpan(traces: TraceSpan[], toolUseId: string): string | null {
  const allSpans = flattenTraceSpans(traces)

  for (const span of allSpans) {
    const meta = span.metadata ?? {}
    if (
      span.name === 'tool:spawn_agent' &&
      meta.toolUseId === toolUseId &&
      typeof meta.spawnedAgentLabel === 'string'
    ) {
      return meta.spawnedAgentLabel
    }
  }

  // Try extracting from sub_agent span name: "sub_agent:label"
  for (const span of allSpans) {
    if (span.name === 'tool:spawn_agent') {
      const meta = span.metadata ?? {}
      if (meta.toolUseId === toolUseId) {
        for (const child of span.children ?? []) {
          if (child.name.startsWith('sub_agent:')) {
            return child.name.replace('sub_agent:', '')
          }
        }
      }
    }
  }

  return null
}

function findModelFromTraceSpan(
  traces: TraceSpan[],
  toolUseId: string,
  agentId?: string,
): string | null {
  const allSpans = flattenTraceSpans(traces)

  for (const span of allSpans) {
    const meta = span.metadata ?? {}
    const data = span.data ?? {}
    if (span.name === 'tool:spawn_agent' && meta.toolUseId === toolUseId) {
      const model = asString(meta.spawnedAgentModel) ?? asString(data.spawnedAgentModel)
      if (model) return model

      for (const child of span.children ?? []) {
        if (child.name === 'sub_agent' || child.name.startsWith('sub_agent:')) {
          const childModel = findModelInSpanTree(child)
          if (childModel) return childModel
        }
      }
    }
  }

  if (agentId) {
    for (const span of allSpans) {
      const metadata = span.metadata ?? {}
      const data = span.data ?? {}
      const isSubAgent =
        span.name === 'sub_agent' ||
        span.name.startsWith('sub_agent:') ||
        metadata.kind === 'sub_agent' ||
        data.kind === 'sub_agent'
      if (isSubAgent && (metadata.agentId === agentId || data.agentId === agentId)) {
        const model = findModelInSpanTree(span)
        if (model) return model
      }
    }
  }

  return null
}

function findWaitAgentResult(
  messages: Message[],
  agentId: string,
  toolResults: Map<string, TimelineToolResultData>,
): {
  status: 'waiting' | 'completed' | 'errored' | 'closed'
  output?: string
  durationMs?: number
  model?: string
} | null {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const block of msg.content) {
      if (block.type !== 'tool_use') continue
      const name = block.name as string
      if (name !== 'wait_agent' && name !== 'close_agent') continue
      const input = (block.input as Record<string, unknown>) ?? {}
      const targetId =
        (input.agentId as string | undefined) ?? (input.agent_id as string | undefined)
      const ids = Array.isArray(input.ids) ? (input.ids as string[]) : undefined
      const isMatch = targetId === agentId || ids?.includes(agentId)
      if (!isMatch) continue
      const result = toolResults.get(block.id as string)
      if (!result?.content) continue

      let status: 'waiting' | 'completed' | 'errored' | 'closed' =
        name === 'close_agent' ? 'closed' : 'completed'
      let output: string | undefined
      let durationMs: number | undefined
      let model: string | undefined

      try {
        const parsed = JSON.parse(result.content)
        if (parsed && typeof parsed === 'object') {
          const record = asRecord(parsed)
          const statuses = asRecord(record?.statuses)
          const agentRecord = asRecord(statuses?.[agentId]) ?? record
          const state = asString(agentRecord?.state) ?? asString(agentRecord?.status)
          if (state === 'waiting') status = 'waiting'
          else if (state === 'errored' || state === 'error' || state === 'failed')
            status = 'errored'
          else if (state === 'closed') status = 'closed'
          else if (state === 'completed') status = 'completed'

          output =
            typeof agentRecord?.output === 'string'
              ? agentRecord.output
              : typeof agentRecord?.result === 'string'
                ? agentRecord.result
                : undefined
          if (typeof agentRecord?.durationMs === 'number') durationMs = agentRecord.durationMs
          if (typeof agentRecord?.elapsedMs === 'number') durationMs = agentRecord.elapsedMs
          model = asString(agentRecord?.model) ?? asString(record?.model)
        }
      } catch {
        output = result.content
      }

      if (result.isError) status = 'errored'
      return { status, output, durationMs, model }
    }
  }
  return null
}

/**
 * Find the sub_agent span associated with a spawn_agent call.
 * Strategy 1: match by agentId in sub_agent span data/metadata
 * Strategy 2: find tool:spawn_agent span by toolUseId, then take its sub_agent child
 */
function findSubAgentSpan(
  traces: TraceSpan[],
  agentId: string,
  spawnToolCallId?: string,
): TraceSpan | null {
  const allSpans = flattenTraceSpans(traces)

  // Strategy 1: match by agentId
  for (const span of allSpans) {
    const metadata = span.metadata ?? {}
    const data = span.data ?? {}
    const isSubAgent =
      span.name === 'sub_agent' ||
      span.name.startsWith('sub_agent:') ||
      metadata.kind === 'sub_agent' ||
      data.kind === 'sub_agent'
    if (isSubAgent && (metadata.agentId === agentId || data.agentId === agentId)) {
      return span
    }
  }

  // Strategy 2: find via spawn_agent tool span → child sub_agent span
  if (spawnToolCallId) {
    for (const span of allSpans) {
      const meta = span.metadata ?? {}
      if (span.name === 'tool:spawn_agent' && meta.toolUseId === spawnToolCallId) {
        for (const child of span.children ?? []) {
          if (
            child.name === 'sub_agent' ||
            child.name.startsWith('sub_agent:') ||
            child.data?.kind === 'sub_agent'
          ) {
            return child
          }
        }
      }
    }
  }

  return null
}

function extractSubAgentChildToolCallsFromSpan(
  agentSpan: TraceSpan | null,
): SubAgentChildToolCall[] {
  if (!agentSpan) return []

  const childCalls: SubAgentChildToolCall[] = []
  for (const child of flattenTraceSpans(agentSpan.children ?? [])) {
    if (!child.name.startsWith('tool:')) continue
    const meta = child.metadata ?? {}
    const data = child.data ?? {}
    childCalls.push({
      id: (meta.toolUseId as string) ?? child.id,
      name: child.name.replace('tool:', ''),
      input: (meta.input as Record<string, unknown>) ?? {},
      result: (meta.result as string) ?? undefined,
      summary: (meta.outputSummary as string) ?? (data.outputSummary as string) ?? undefined,
      isError: child.status === 'error' ? true : undefined,
      durationMs: child.durationMs,
    })
  }
  return childCalls
}

/**
 * Extract the real duration and status from the sub_agent trace span.
 * This is the actual agent execution time, not just the spawn call time.
 */
function getSubAgentTraceInfoFromSpan(agentSpan: TraceSpan | null): {
  durationMs?: number
  status?: 'completed' | 'errored' | 'running' | 'closed'
  output?: string
  model?: string
} | null {
  if (!agentSpan) return null

  const data = agentSpan.data ?? {}
  const status =
    agentSpan.status === 'success'
      ? ('completed' as const)
      : agentSpan.status === 'error'
        ? ('errored' as const)
        : ('running' as const)

  return {
    durationMs: (data.durationMs as number) ?? agentSpan.durationMs ?? undefined,
    status,
    output: (data.output as string) ?? (data.outputSummary as string) ?? undefined,
    model: findModelInSpanTree(agentSpan) ?? undefined,
  }
}

function findModelInSpanTree(span: TraceSpan): string | null {
  const directModel =
    asString(span.metadata?.model) ??
    asString(span.data?.model) ??
    asString(asRecord(span.data?.request)?.model)
  if (directModel) return directModel

  for (const child of span.children ?? []) {
    const childModel = findModelInSpanTree(child)
    if (childModel) return childModel
  }

  return null
}

function isHandledSubAgentTool(
  input: Record<string, unknown>,
  handledSubAgentIds: Set<string>,
): boolean {
  const targetId =
    (input.agentId as string | undefined) ??
    (input.agent_id as string | undefined) ??
    (input.id as string | undefined)
  if (targetId !== undefined && handledSubAgentIds.has(targetId)) return true

  if (Array.isArray(input.ids)) {
    return input.ids.some((id) => typeof id === 'string' && handledSubAgentIds.has(id))
  }

  return false
}
