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
} from '../context-panel/context-tokens'
import {
  type MemoryInjectionEntry,
  isMemoryHintText,
  isMemoryInjectText,
  pickMemoryInjectionPreview,
  readMemoryRetrievalDetail,
} from '../memory/memory-retrieval'

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

/** Structured classifier completion persisted with a task-closure event. */
export interface TaskClosureClassifierResponseView {
  id?: string
  content?: readonly { type?: string; text?: string }[]
  reasoningContent?: string
  stopReason?: string
  model?: string
  usage?: {
    input?: number
    cacheRead?: number
    cacheWrite?: number
    output?: number
    reasoning?: number
  }
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
  /** Structured completion the decision was parsed from, when persisted. */
  classifierResponse?: TaskClosureClassifierResponseView
  failureStage?: 'parse_classifier_response' | 'request_classifier'
  /** Raw completion text, persisted only when parsing it failed. */
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
  | { type: 'image'; mediaType: string; data?: string; imageRef?: ImageRefPointer }

export interface ImageRefPointer {
  path?: string
  relativePath?: string
  sha256?: string
  bytes?: number
  error?: string
}

export interface ToolEvidencePointer {
  kind: 'tool_use_input' | 'tool_result_output'
  sessionId?: string
  toolUseId: string
  toolName: string
  path: string
  chars?: number
  bytes?: number
  sha256?: string
  summary?: string
  strategy?: string
}

export interface TimelineToolResultInput {
  toolUseId: string
  content?: string
  isError?: boolean
  outputSummary?: string
  contentItems?: ToolResultContentItem[]
  evidence?: ToolEvidencePointer
}

export interface TimelineToolResultData {
  content?: string
  summary?: string
  contentItems?: ToolResultContentItem[]
  evidence?: ToolEvidencePointer
  isError?: boolean
}

export interface TimelineCompactionBlock {
  id: string
  sessionId: string
  status: 'active' | 'superseded'
  strategy: string
  strategyVersion: string
  boundaryReason: string
  summary: string
  workingStateSummary: string
  coveredMessageIds: string[]
  coveredRange: {
    startMessageId: string
    endMessageId: string
    startCreatedAt: string
    endCreatedAt: string
  }
  coveredMessageCount: number
  toolUseIds: string[]
  evidence: unknown[]
  evidenceCount: number
  evidenceChars: number
  evidenceBytes: number
  rawCharsMovedToEvidence: number
  skippedUnfinishedToolUseIds: string[]
  episodeFullRetainTurns: number
  createdAt: string
  updatedAt: string
  generation: number
  topics?: TimelineCompactionTopic[]
  validation?: TimelineCompactionValidation
  model?: TimelineCompactionModelInfo
  supersedesBlockIds?: string[]
  supersededByBlockId?: string
}

export interface TimelineCompactionTopic {
  id: string
  title: string
  status: 'completed' | 'in_progress' | 'blocked' | 'unknown'
  summary: string
  sourceMessageRefs: string[]
  sourceMessageIds: string[]
  toolRefs: string[]
  toolUseIds: string[]
  confirmedFacts?: string[]
  decisions?: string[]
  currentState?: string[]
  openQuestions?: string[]
  nextActions?: string[]
  evidence?: string[]
  needsRawReview?: boolean
}

export interface TimelineCompactionValidation {
  status: 'passed' | 'failed' | 'legacy'
  promptVersion?: string
  topicCount: number
  expectedToolRefs: string[]
  coveredToolRefs: string[]
  invalidToolRefs: string[]
  missingToolRefs: string[]
  errors: string[]
  warnings: string[]
}

export interface TimelineCompactionModelInfo {
  promptVersion: string
  primaryModel?: string
  usedModel?: string
  attempts: number
}

export interface CompactionBlockTimelineItem {
  type: 'compaction-block'
  id: string
  summary: string
  workingStateSummary: string
  coveredMessageCount: number
  coveredRange: TimelineCompactionBlock['coveredRange']
  strategy: string
  strategyVersion: string
  boundaryReason: string
  generation: number
  evidence: ToolEvidencePointer[]
  evidenceCount: number
  evidenceChars: number
  evidenceBytes: number
  skippedUnfinishedToolUseIds: string[]
  coveredMessages: Message[]
  createdAt: string
  updatedAt: string
  topics?: TimelineCompactionTopic[]
  validation?: TimelineCompactionValidation
  model?: TimelineCompactionModelInfo
  supersedesBlockIds?: string[]
  supersededByBlockId?: string
}

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
  /** Decisions recorded inside the sub-agent, rendered as its thinking. */
  decisions?: DecisionTimelineItem[]
  traceSpan?: TraceSpan | null
  createdAt: string
}

export type TimelineItem =
  | {
      type: 'user-message'
      text: string
      queued: boolean
      images?: Array<{ mediaType: string; data?: string; imageRef?: ImageRefPointer }>
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
      /** Trace decisions folded into this assistant step, rendered as thinking. */
      thinking?: DecisionTimelineItem[]
    }
  | {
      type: 'tool-call'
      id: string
      name: string
      input: Record<string, unknown>
      result?: string
      summary?: string
      contentItems?: ToolResultContentItem[]
      evidence?: ToolEvidencePointer[]
      isError?: boolean
      status?: TraceSpan['status']
      durationMs?: number
      createdAt: string
      tokenUsage?: TokenUsageSummary
      resultTokenUsage?: TokenUsageSummary
    }
  | CompactionBlockTimelineItem
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
  timelineCompactionBlocks: TimelineCompactionBlock[] = [],
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
  const compactionBlocksAfterMessage = buildTimelineCompactionProjection(
    messages,
    timelineCompactionBlocks,
  )
  const decisionOwnership = assignDecisionOwners(buildDecisionEvents(decisions), traces, messages)
  let previousMessageId: string | null = null

  for (const msg of messages) {
    if (previousMessageId !== null) {
      const compactionBlock = compactionBlocksAfterMessage.get(previousMessageId)
      if (compactionBlock) {
        items.push(compactionBlock)
      }
    }
    previousMessageId = msg.id

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
        .flatMap((b) => normalizeImageItem(b))

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
      const messageDecisions = decisionOwnership.byMessageId.get(msg.id)
      let pendingThinking = messageDecisions
      if (messageDecisions !== undefined && !msg.content.some((block) => block.type === 'text')) {
        // Tool-only assistant steps still carry their thinking as a text-less
        // agent row so the decisions stay grouped with the step.
        items.push({
          type: 'agent-text',
          messageId: msg.id,
          text: '',
          model: msg.model,
          createdAt: msg.createdAt,
          thinking: messageDecisions,
        })
        pendingThinking = undefined
      }
      for (const block of msg.content) {
        if (block.type === 'text') {
          items.push({
            type: 'agent-text',
            messageId: msg.id,
            text: block.text as string,
            model: msg.model,
            createdAt: msg.createdAt,
            tokenUsage: requestMatcher.claimAssistantText(block.text as string),
            ...(pendingThinking !== undefined ? { thinking: pendingThinking } : {}),
          })
          pendingThinking = undefined
        } else if (block.type === 'tool_use') {
          const toolName = block.name as string
          const toolId = block.id as string
          const toolInput = (block.input as Record<string, unknown>) ?? {}
          const result = toolResults.get(toolId)
          const evidence = normalizeEvidencePointers([block.evidence, result?.evidence])

          if (nestedMemoryNudgeToolUseIds.has(toolId)) {
            continue
          }

          if (toolName === 'spawn_agent') {
            items.push(
              buildSubAgentTimelineItem({
                messages,
                traces,
                toolId,
                toolInput,
                result,
                toolResults,
                handledSubAgentIds,
                spawnToolCallIds,
                decisionsBySpawnToolId: decisionOwnership.bySpawnToolId,
                createdAt: msg.createdAt,
              }),
            )
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
              evidence,
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

  items.push(...decisionOwnership.standalone)
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
  if (previousMessageId !== null) {
    const compactionBlock = compactionBlocksAfterMessage.get(previousMessageId)
    if (compactionBlock) {
      items.push(compactionBlock)
    }
  }
  return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

/**
 * Projects active timeline compaction blocks as slim appended markers placed
 * right after the last covered message. Covered messages keep rendering in
 * the main lane; the block only marks where the context was compressed.
 */
function buildTimelineCompactionProjection(
  messages: Message[],
  blocks: TimelineCompactionBlock[],
): Map<string, CompactionBlockTimelineItem> {
  const messageById = new Map(messages.map((message) => [message.id, message]))
  const blocksByLastCoveredMessageId = new Map<string, CompactionBlockTimelineItem>()

  for (const block of blocks) {
    if (block.status !== 'active') continue

    const coveredMessages = block.coveredMessageIds.flatMap((messageId) => {
      const message = messageById.get(messageId)
      return message ? [message] : []
    })
    if (coveredMessages.length === 0) continue

    blocksByLastCoveredMessageId.set(coveredMessages[coveredMessages.length - 1].id, {
      type: 'compaction-block',
      id: block.id,
      summary: block.summary,
      workingStateSummary: block.workingStateSummary,
      coveredMessageCount: block.coveredMessageCount,
      coveredRange: block.coveredRange,
      strategy: block.strategy,
      strategyVersion: block.strategyVersion,
      boundaryReason: block.boundaryReason,
      generation: block.generation,
      evidence: normalizeEvidencePointers(block.evidence) ?? [],
      evidenceCount: block.evidenceCount,
      evidenceChars: block.evidenceChars,
      evidenceBytes: block.evidenceBytes,
      skippedUnfinishedToolUseIds: block.skippedUnfinishedToolUseIds,
      coveredMessages,
      createdAt: block.coveredRange.endCreatedAt,
      updatedAt: block.updatedAt,
      topics: block.topics ?? [],
      validation: block.validation,
      model: block.model,
      supersedesBlockIds: block.supersedesBlockIds,
      supersededByBlockId: block.supersededByBlockId,
    })
  }

  return blocksByLastCoveredMessageId
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

export interface DecisionOwnership {
  /** Decisions folded into the assistant message that produced them. */
  byMessageId: Map<string, DecisionTimelineItem[]>
  /** Sub-agent decisions keyed by the spawn_agent tool-use id they ran under. */
  bySpawnToolId: Map<string, DecisionTimelineItem[]>
  /** Decisions whose trace span is missing; they stay as standalone rows. */
  standalone: DecisionTimelineItem[]
}

/**
 * Assign each decision to the timeline entry that owns it so decisions render
 * as assistant (or sub-agent) thinking instead of standalone rows.
 *
 * Decisions are projected from llm_request spans: sub-agent requests sit under
 * their spawn tool span and belong to the sub-agent block; main-agent requests
 * pair with the assistant message carrying their tool calls, falling back to
 * the nearest assistant at or after the decision time for text-only requests.
 */
function assignDecisionOwners(
  decisionItems: DecisionTimelineItem[],
  traces: TraceSpan[],
  messages: Message[],
): DecisionOwnership {
  const ownership: DecisionOwnership = {
    byMessageId: new Map(),
    bySpawnToolId: new Map(),
    standalone: [],
  }
  if (decisionItems.length === 0) return ownership

  const spanById = new Map(flattenTraceSpans(traces).map((span) => [span.id, span]))
  const assistants = messages.filter((message) => message.role === 'assistant')
  const messageByToolUseId = new Map<string, Message>()
  for (const message of assistants) {
    for (const block of message.content) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        messageByToolUseId.set(block.id, message)
      }
    }
  }

  const addTo = (
    map: Map<string, DecisionTimelineItem[]>,
    key: string,
    item: DecisionTimelineItem,
  ) => {
    const existing = map.get(key)
    if (existing) existing.push(item)
    else map.set(key, [item])
  }

  for (const decision of decisionItems) {
    const span = spanById.get(decision.id)
    if (span === undefined) {
      ownership.standalone.push(decision)
      continue
    }

    let ancestor = span.parentId === undefined ? undefined : spanById.get(span.parentId)
    let depth = 0
    let handled = false
    while (ancestor !== undefined && depth++ < 16) {
      if (ancestor.kind === 'tool_call' || ancestor.name.startsWith('tool:')) {
        const spawnToolUseId = asString(ancestor.metadata?.toolUseId)
        if (spawnToolUseId !== undefined) {
          addTo(ownership.bySpawnToolId, spawnToolUseId, decision)
        } else {
          ownership.standalone.push(decision)
        }
        handled = true
        break
      }
      ancestor = ancestor.parentId === undefined ? undefined : spanById.get(ancestor.parentId)
    }
    if (handled) continue

    // Main-agent request: pair through its tool calls when available.
    const request = asRecord(span.data?.request)
    const toolCalls = Array.isArray(request?.toolCalls) ? request.toolCalls : []
    const owner = toolCalls
      .map((call) => messageByToolUseId.get(asString(asRecord(call)?.id) ?? ''))
      .find((message) => message !== undefined)
    if (owner !== undefined) {
      addTo(ownership.byMessageId, owner.id, decision)
      continue
    }
    // Text-only requests leave no tool link; use the assistant that follows.
    const byTime =
      assistants.find((message) => message.createdAt.localeCompare(decision.createdAt) >= 0) ??
      assistants[assistants.length - 1]
    if (byTime !== undefined) {
      addTo(ownership.byMessageId, byTime.id, decision)
    } else {
      ownership.standalone.push(decision)
    }
  }
  return ownership
}

function buildTaskClosureEvents(
  traces: TraceSpan[],
  taskClosureEvents: SessionTaskClosureEvent[],
): TaskClosureTimelineItem[] {
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

export interface TaskClosureTraceDetails {
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

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function buildSubAgentTimelineItem(params: {
  messages: Message[]
  traces: TraceSpan[]
  toolId: string
  toolInput: Record<string, unknown>
  result?: TimelineToolResultData
  toolResults: Map<string, TimelineToolResultData>
  handledSubAgentIds: Set<string>
  spawnToolCallIds: Set<string>
  decisionsBySpawnToolId?: Map<string, DecisionTimelineItem[]>
  createdAt: string
}): SubAgentTimelineItem {
  const {
    messages,
    traces,
    toolId,
    toolInput,
    result,
    toolResults,
    handledSubAgentIds,
    spawnToolCallIds,
    decisionsBySpawnToolId,
    createdAt,
  } = params

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

  const labelFromResult = result?.content ? tryParseJsonField(result.content, 'label') : null
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

  return {
    type: 'sub-agent',
    agentId,
    label,
    role,
    model: model ?? undefined,
    instruction,
    status: resolveSubAgentStatus({
      waitStatus: waitInfo?.status,
      traceStatus: traceInfo?.status,
      result,
    }),
    // The span's recorded output is the agent's own final report; the wait
    // result may carry an unrelated background-tool notice when wait_agent
    // itself went background, so the span wins whenever it recorded output.
    output:
      traceInfo?.output !== undefined && traceInfo.output !== ''
        ? traceInfo.output
        : waitInfo?.output,
    durationMs: traceInfo?.durationMs ?? waitInfo?.durationMs,
    spawnToolCallId: toolId,
    childToolCalls,
    ...(decisionsBySpawnToolId?.has(toolId)
      ? { decisions: decisionsBySpawnToolId.get(toolId) }
      : {}),
    traceSpan,
    createdAt,
  }
}

/**
 * Collect sub-agent lifecycle items across the whole message history,
 * including messages inside active compaction ranges. Delegation records are
 * cross-cutting session structure, so consumers like the trajectory ledger
 * keep them even when the covered conversation is summarized away, while the
 * chat timeline keeps skipping covered messages.
 * @param messages - Full session message history, compaction included.
 * @param traces - Sanitized trace spans for the session.
 * @returns One sub-agent item per spawn_agent call, in message order.
 */
export function collectSubAgentTimelineItems(
  messages: Message[],
  traces: TraceSpan[] = [],
): SubAgentTimelineItem[] {
  const toolResults = buildToolResultMap(messages, traces, [])
  const handledSubAgentIds = new Set<string>()
  const spawnToolCallIds = new Set<string>()
  const items: SubAgentTimelineItem[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const block of msg.content) {
      if (block.type !== 'tool_use' || block.name !== 'spawn_agent') continue
      const toolId = block.id as string
      items.push(
        buildSubAgentTimelineItem({
          messages,
          traces,
          toolId,
          toolInput: (block.input as Record<string, unknown>) ?? {},
          result: toolResults.get(toolId),
          toolResults,
          handledSubAgentIds,
          spawnToolCallIds,
          createdAt: msg.createdAt,
        }),
      )
    }
  }
  return items
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

function resolveSubAgentStatus({
  waitStatus,
  traceStatus,
  result,
}: {
  waitStatus?: 'waiting' | 'completed' | 'errored' | 'closed'
  traceStatus?: 'completed' | 'errored' | 'running' | 'closed'
  result?: TimelineToolResultData
}) {
  if (waitStatus === 'waiting') return 'waiting'
  if (traceStatus && traceStatus !== 'running') return traceStatus
  if (waitStatus) return waitStatus
  if (traceStatus) return traceStatus
  return result?.isError ? 'errored' : 'running'
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

interface WaitAgentTimelineResult {
  status: 'waiting' | 'completed' | 'errored' | 'closed'
  output?: string
  durationMs?: number
  model?: string
}

function findWaitAgentResult(
  messages: Message[],
  agentId: string,
  toolResults: Map<string, TimelineToolResultData>,
): WaitAgentTimelineResult | null {
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

      return parseWaitAgentResult(name, result, agentId)
    }
  }
  return null
}

function parseWaitAgentResult(
  toolName: string,
  result: TimelineToolResultData,
  agentId: string,
): WaitAgentTimelineResult {
  const content = result.content ?? ''
  let status: WaitAgentTimelineResult['status'] =
    toolName === 'close_agent' ? 'closed' : 'completed'
  let output: string | undefined
  let durationMs: number | undefined
  let model: string | undefined

  try {
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object') {
      const record = asRecord(parsed)
      const statuses = asRecord(record?.statuses)
      const agentRecord = asRecord(statuses?.[agentId]) ?? record
      const state = asString(agentRecord?.state) ?? asString(agentRecord?.status)
      status = statusFromState(state) ?? status
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
    output = content
  }

  if (result.isError) status = 'errored'
  return { status, output, durationMs, model }
}

function statusFromState(state: string | undefined): WaitAgentTimelineResult['status'] | undefined {
  if (state === 'waiting') return 'waiting'
  if (state === 'errored' || state === 'error' || state === 'failed') return 'errored'
  if (state === 'closed') return 'closed'
  if (state === 'completed') return 'completed'
  return undefined
}

function findAgentIdFromTraceSpan(traces: TraceSpan[], toolUseId: string): string | null {
  const allSpans = flattenTraceSpans(traces)

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

  for (const span of allSpans) {
    if (span.name !== 'tool:spawn_agent') continue
    const meta = span.metadata ?? {}
    if (meta.toolUseId !== toolUseId) continue
    for (const child of span.children ?? []) {
      if (child.name.startsWith('sub_agent:')) {
        const childData = child.data ?? {}
        const childMeta = child.metadata ?? {}
        return (childData.agentId as string) ?? (childMeta.agentId as string) ?? child.id
      }
    }
  }

  return null
}

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

  for (const span of allSpans) {
    if (span.name !== 'tool:spawn_agent') continue
    const meta = span.metadata ?? {}
    if (meta.toolUseId !== toolUseId) continue
    for (const child of span.children ?? []) {
      if (child.name.startsWith('sub_agent:')) {
        return child.name.replace('sub_agent:', '')
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

function findSubAgentSpan(
  traces: TraceSpan[],
  agentId: string,
  spawnToolCallId?: string,
): TraceSpan | null {
  const allSpans = flattenTraceSpans(traces)

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

  if (spawnToolCallId) {
    for (const span of allSpans) {
      const meta = span.metadata ?? {}
      if (span.name !== 'tool:spawn_agent' || meta.toolUseId !== spawnToolCallId) continue
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

function extractToolDurations(traces: TraceSpan[]): Map<string, number> {
  const toolDurations = new Map<string, number>()

  for (const span of flattenTraceSpans(traces)) {
    if (!span.name.startsWith('tool:') || typeof span.durationMs !== 'number') continue
    const toolUseId = getTraceToolUseId(span)
    if (!toolUseId) continue
    toolDurations.set(toolUseId, span.durationMs)
  }

  return toolDurations
}

function extractToolStatuses(traces: TraceSpan[]): Map<string, TraceSpan['status']> {
  const toolStatuses = new Map<string, TraceSpan['status']>()

  for (const span of flattenTraceSpans(traces)) {
    if (!span.name.startsWith('tool:')) continue
    const toolUseId = getTraceToolUseId(span)
    if (!toolUseId) continue
    toolStatuses.set(toolUseId, span.status)
  }

  return toolStatuses
}

function getTraceToolUseId(span: TraceSpan): string | null {
  const toolUseId = span.metadata?.toolUseId
  return typeof toolUseId === 'string' ? toolUseId : null
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

export interface TimelineRequestLike {
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
  toolResults?: TimelineToolResultInput[]
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

function truncateSystemEventText(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 197).trimEnd()}...`
}

function formatControlKindLabel(controlKind: string): string {
  if (controlKind === 'memory_nudge') return 'Memory Nudge'
  if (controlKind === 'task_closure') return 'Task Closure Prompt'
  if (controlKind === 'queued_injection') return 'Queued Injection'
  if (controlKind === 'background_tool_completed') return 'Background Tool Completed'
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
  if (controlKind === 'background_tool_completed') return ['background', 'tool']
  if (controlKind === 'task_closure') return ['closure gate']
  if (controlKind === 'empty_retry') return ['retry']
  return undefined
}

function sanitizeSystemEventText(text: string): string {
  return text
    .replace(/<\/?system_notice>/g, ' ')
    .replace(/<\/?memory_hint>/g, ' ')
    .replace(/<\/?memory_inject[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeEvidencePointers(values: unknown[]): ToolEvidencePointer[] | undefined {
  const pointers = values.flatMap((value) => {
    const pointer = normalizeToolEvidence(value)
    return pointer ? [pointer] : []
  })
  return pointers.length > 0 ? pointers : undefined
}

function normalizeToolEvidence(value: unknown): ToolEvidencePointer | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const kind = record.kind
  const toolUseId = asString(record.toolUseId)
  const toolName = asString(record.toolName)
  const path = asString(record.path)
  if (
    (kind !== 'tool_use_input' && kind !== 'tool_result_output') ||
    !toolUseId ||
    !toolName ||
    !path
  ) {
    return undefined
  }

  return {
    kind,
    sessionId: asString(record.sessionId),
    toolUseId,
    toolName,
    path,
    chars: asOptionalNumber(record.chars),
    bytes: asOptionalNumber(record.bytes),
    sha256: asString(record.sha256),
    summary: asString(record.summary),
    strategy: asString(record.strategy),
  }
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

interface TimelineToolResultRequestLike {
  toolResults?: TimelineToolResultInput[]
}

function buildToolResultMap(
  messages: Message[],
  traces: TraceSpan[],
  llmRequests: TimelineToolResultRequestLike[],
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
        evidence: normalizeToolEvidence(block.evidence),
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
        evidence: normalizeToolEvidence(result.evidence),
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
    evidence: incoming.evidence ?? current?.evidence,
    isError: current?.isError === true || incoming.isError === true,
  })
}

function normalizeToolResultContentItems(value: unknown): ToolResultContentItem[] | undefined {
  if (!Array.isArray(value)) return undefined

  const items = value.flatMap((item): ToolResultContentItem[] => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      return [{ type: 'text', text: record.text }]
    }
    if (record.type === 'image' && typeof record.mediaType === 'string') {
      const data = typeof record.data === 'string' ? record.data : undefined
      const imageRef = normalizeImageRef(record.imageRef)
      if (data || imageRef) {
        return [{ type: 'image', mediaType: record.mediaType, data, imageRef }]
      }
    }
    return []
  })

  return items.length > 0 ? items : undefined
}

function normalizeImageItem(value: unknown): Extract<ToolResultContentItem, { type: 'image' }>[] {
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  if (record.type !== 'image' || typeof record.mediaType !== 'string') return []

  const data = typeof record.data === 'string' ? record.data : undefined
  const imageRef = normalizeImageRef(record.imageRef)
  if (!data && !imageRef) return []
  return [{ type: 'image', mediaType: record.mediaType, data, imageRef }]
}

function normalizeImageRef(value: unknown): ImageRefPointer | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  return {
    path: typeof record.path === 'string' ? record.path : undefined,
    relativePath: typeof record.relativePath === 'string' ? record.relativePath : undefined,
    sha256: typeof record.sha256 === 'string' ? record.sha256 : undefined,
    bytes: typeof record.bytes === 'number' ? record.bytes : undefined,
    error: typeof record.error === 'string' ? record.error : undefined,
  }
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

function collectMemoryNudgeSpans(traces: TraceSpan[]): TraceSpan[] {
  return flattenTraceSpans(traces)
    .filter((span) => span.name === 'memory_nudge')
    .sort(compareTimelineSpans)
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
