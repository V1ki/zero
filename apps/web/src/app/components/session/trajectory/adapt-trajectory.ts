/**
 * Session → trajectory adapter: the only producer of trajectory view data in
 * this app. Projects the ZeRo OS session detail (messages, LLM request log,
 * trace spans) into the vendored TrajectorySnapshot contract consumed by the
 * ported DeepSeek Harness trajectory view.
 *
 * Scope: sessions recorded with trace.jsonl (full request metadata). Sessions
 * without request entries still render their message flow; the request layer
 * and timing overview are then empty.
 */

import type {
  ContentBlock as LooseContentBlock,
  Message,
  SessionDetail,
  SessionRequestEntry,
} from '../detail/useSessionDetailData'
import type {
  TaskClosureClassifierResponseView,
  TimelineCompactionBlock,
  TraceSpan,
} from '../timeline/timeline'
import { formatDurationMillis } from './trajectory-record'
import type {
  AssistantBlock,
  AssistantRequestView,
  ContentBlock,
  ContextGateUsage,
  ContextMessageNode,
  ConversationLocation,
  ConversationPromptSnapshot,
  RequestView,
  RunningToolCall,
  SteeringMessageNode,
  ToolEvidenceView,
  ToolResultNode,
  ToolSchema,
  TrajectorySnapshot,
} from './types'

/** Client view of a session compaction block (subset of TimelineCompactionBlock). */
type CompactionBlockLike = Pick<
  TimelineCompactionBlock,
  'id' | 'summary' | 'coveredMessageCount' | 'createdAt'
>

interface ToolCallInfo {
  name: string
  argsRaw: string
}

/*
 * Message blocks arrive as the loose client shape { type: string; [key: string]:
 * unknown }. These local aliases describe the block payloads the adapter reads;
 * the guards validate the loose data before narrowing.
 */
type TextBlock = { type: 'text'; text: string }
type ThinkingBlock = { type: 'thinking'; thinking: string }
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
type ToolResultBlock = {
  type: 'tool_result'
  toolUseId: string
  content: string
  isError?: boolean
}

type EvidenceLike = { kind?: unknown; path?: unknown; chars?: unknown; sha256?: unknown }

function isEvidenceLike(value: unknown): value is EvidenceLike {
  return typeof value === 'object' && value !== null
}

/**
 * Extract the persisted evidence pointer from a tool_use/tool_result block.
 * @param block - loose message content block that may carry `evidence`.
 * @returns validated evidence view, or null when absent/malformed.
 */
function toEvidencePointer(block: LooseContentBlock): ToolEvidenceView | null {
  if (!isEvidenceLike(block.evidence)) return null
  const evidence = block.evidence
  if (typeof evidence.path !== 'string' || evidence.path === '') return null
  return {
    kind: typeof evidence.kind === 'string' ? evidence.kind : 'evidence',
    path: evidence.path,
    ...(typeof evidence.chars === 'number' ? { chars: evidence.chars } : {}),
    ...(typeof evidence.sha256 === 'string' && evidence.sha256 !== ''
      ? { sha256: evidence.sha256 }
      : {}),
  }
}

function toEpochMillis(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function isTextBlock(block: LooseContentBlock): block is TextBlock {
  return block.type === 'text' && typeof block.text === 'string'
}

function isThinkingBlock(block: LooseContentBlock): block is ThinkingBlock {
  return block.type === 'thinking' && typeof block.thinking === 'string'
}

function isToolUse(block: LooseContentBlock): block is ToolUseBlock {
  return (
    block.type === 'tool_use' &&
    typeof block.id === 'string' &&
    typeof block.name === 'string' &&
    typeof block.input === 'object' &&
    block.input !== null
  )
}

function isToolResult(block: LooseContentBlock): block is ToolResultBlock {
  return (
    block.type === 'tool_result' &&
    typeof block.toolUseId === 'string' &&
    typeof block.content === 'string'
  )
}

/** Convert one ZeRo content block into the trajectory view block model. */
function toContentBlock(block: LooseContentBlock): ContentBlock | null {
  if (isTextBlock(block)) return { type: 'text', text: block.text }
  if (isThinkingBlock(block)) return { type: 'reasoning', text: block.thinking }
  if (block.type === 'image') return { type: 'image', attachment: block }
  return null
}

/** Convert assistant message blocks into the UI classification, source order kept. */
function toAssistantBlocks(content: readonly LooseContentBlock[]): AssistantBlock[] {
  const blocks: AssistantBlock[] = []
  for (const block of content) {
    if (isTextBlock(block)) {
      blocks.push({ kind: 'text', text: block.text })
    } else if (isThinkingBlock(block)) {
      blocks.push({ kind: 'reasoning', text: block.thinking })
    } else if (block.type === 'image') {
      blocks.push({ kind: 'image', attachment: block })
    } else if (isToolUse(block)) {
      blocks.push({
        kind: 'tool-call',
        callId: block.id,
        name: block.name,
        argsRaw: JSON.stringify(block.input),
      })
    }
  }
  return blocks
}

/** Build call-head info (name + serialized args) keyed by tool-use block id. */
function indexToolCalls(requests: readonly SessionRequestEntry[]): Map<string, ToolCallInfo> {
  const calls = new Map<string, ToolCallInfo>()
  for (const request of requests) {
    for (const call of request.toolCalls ?? []) {
      if (!calls.has(call.id)) {
        calls.set(call.id, { name: call.name, argsRaw: JSON.stringify(call.input) })
      }
    }
  }
  return calls
}

/** Flatten exported trace trees once so every projection sees nested spans. */
function flattenTraceSpans(spans: readonly TraceSpan[]): TraceSpan[] {
  const flattened: TraceSpan[] = []
  const visit = (span: TraceSpan) => {
    flattened.push(span)
    for (const child of span.children) visit(child)
  }
  for (const span of spans) visit(span)
  return flattened
}

interface ToolSpanIndex {
  byRequest: ReadonlyMap<string, readonly TraceSpan[]>
  byToolUseId: ReadonlyMap<string, TraceSpan>
}

/** Index nested tool spans by both request and stable tool-use identity. */
function indexToolSpans(spans: readonly TraceSpan[]): ToolSpanIndex {
  const byRequest = new Map<string, TraceSpan[]>()
  const byToolUseId = new Map<string, TraceSpan>()
  for (const span of spans) {
    if (span.kind !== 'tool_call') continue
    const requestId = span.data?.requestId
    if (typeof requestId === 'string') {
      const bucket = byRequest.get(requestId)
      if (bucket === undefined) byRequest.set(requestId, [span])
      else bucket.push(span)
    }
    const toolUseId = span.metadata?.toolUseId ?? span.data?.toolUseId
    if (typeof toolUseId === 'string') byToolUseId.set(toolUseId, span)
  }
  for (const bucket of byRequest.values()) {
    bucket.sort((left, right) => left.startTime.localeCompare(right.startTime))
  }
  return { byRequest, byToolUseId }
}

function requestStepIndexes(requests: readonly SessionRequestEntry[]): Map<string, number> {
  const requestById = new Map(requests.map((request) => [request.id, request]))
  const memo = new Map<string, number>()
  const visiting = new Set<string>()
  const depth = (request: SessionRequestEntry): number => {
    const known = memo.get(request.id)
    if (known !== undefined) return known
    if (visiting.has(request.id)) return 0
    visiting.add(request.id)
    const parent = request.parentId === undefined ? undefined : requestById.get(request.parentId)
    const step =
      parent !== undefined && parent.turnIndex === request.turnIndex ? depth(parent) + 1 : 0
    visiting.delete(request.id)
    memo.set(request.id, step)
    return step
  }
  for (const request of requests) depth(request)
  return memo
}

/** Derive request start/end from the log timestamp and duration. */
function requestTiming(entry: SessionRequestEntry): {
  startedAt: number
  completedAt: number | null
} {
  const ts = toEpochMillis(entry.ts)
  if (ts === null) return { startedAt: 0, completedAt: null }
  if (entry.durationMs === undefined) return { startedAt: ts, completedAt: ts }
  return { startedAt: ts - entry.durationMs, completedAt: ts }
}

function usageOf(entry: SessionRequestEntry): Record<string, number> {
  const usage: Record<string, number> = {}
  if (entry.tokens.input !== undefined) usage.inputTokens = entry.tokens.input
  if (entry.tokens.output !== undefined) usage.outputTokens = entry.tokens.output
  if (entry.tokens.cacheRead !== undefined) usage.cacheReadTokens = entry.tokens.cacheRead
  if (entry.tokens.cacheWrite !== undefined) usage.cacheWriteTokens = entry.tokens.cacheWrite
  if (entry.tokens.reasoning !== undefined) usage.reasoningTokens = entry.tokens.reasoning
  return usage
}

/**
 * Pair each request with the assistant message it produced. Preferred key: the
 * request's tool-call ids exactly match the assistant message's tool_use ids.
 * Fallback: k-th unpaired request pairs with the k-th unpaired assistant message.
 */
function pairRequestsWithAssistants(
  messages: readonly Message[],
  requests: readonly SessionRequestEntry[],
): Map<string, SessionRequestEntry> {
  const assistants: Message[] = []
  for (const message of messages) {
    if (message.role === 'assistant' && message.messageType === 'message') {
      assistants.push(message)
    }
  }
  const pairByToolCalls = (request: SessionRequestEntry): Message | undefined => {
    const callIds = new Set((request.toolCalls ?? []).map((call) => call.id))
    if (callIds.size === 0) return undefined
    return assistants.find((message) =>
      message.content.some((block) => isToolUse(block) && callIds.has(block.id)),
    )
  }
  const requestByAssistantId = new Map<string, SessionRequestEntry>()
  const unpairedRequests: SessionRequestEntry[] = []
  for (const request of requests) {
    const owner = pairByToolCalls(request)
    if (owner === undefined || requestByAssistantId.has(owner.id)) {
      unpairedRequests.push(request)
    } else {
      requestByAssistantId.set(owner.id, request)
    }
  }
  const unpairedAssistants = assistants
    .filter((message) => !requestByAssistantId.has(message.id))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  for (const request of unpairedRequests) {
    const ts = request.ts
    // Nearest assistant completed at or before the request log timestamp.
    let owner: Message | undefined
    for (const candidate of unpairedAssistants) {
      if (candidate.createdAt.localeCompare(ts) <= 0) owner = candidate
      else break
    }
    if (owner === undefined) owner = unpairedAssistants[0]
    if (owner === undefined) break
    requestByAssistantId.set(owner.id, request)
    unpairedAssistants.splice(unpairedAssistants.indexOf(owner), 1)
  }
  return requestByAssistantId
}

export interface BuildTrajectoryOptions {
  /** Compaction blocks attached to the session (optional detail). */
  compactionBlocks?: readonly CompactionBlockLike[]
  /** Task-closure gate events (finish/continue/block) in log order. */
  taskClosureEvents?: readonly TaskClosureEventLike[]
  /**
   * Current tool registry definitions used to fill in description/parameters
   * for catalogs whose historical snapshot only recorded tool names. Entries
   * enriched this way are marked with `source: 'registry'`.
   */
  toolSchemas?: readonly ToolSchema[]
  /** Sub-agent spawn events with resolved lifecycle status, in log order. */
  subAgentEvents?: readonly SubAgentEventLike[]
  /** Memory nudge events (span-derived only) in log order. */
  memoryNudgeEvents?: readonly MemoryNudgeEventLike[]
}

/** Client view of a task-closure gate event (subset of SessionTaskClosureEvent). */
export interface TaskClosureEventLike {
  ts: string
  event: 'task_closure_decision' | 'task_closure_failed'
  action?: 'finish' | 'continue' | 'block'
  reason: string
  /** Assistant message the gate judged; joins the event to its trace span. */
  assistantMessageId?: string
  /** The question the gate asked the classifier, with its token cap. */
  classifierRequest?: { prompt: string; maxTokens?: number }
  /** Structured completion the decision was parsed from (the gate's answer). */
  classifierResponse?: TaskClosureClassifierResponseView
  /** Raw completion text, persisted only when parsing it failed. */
  classifierResponseRaw?: string
  failureStage?: 'parse_classifier_response' | 'request_classifier'
  error?: string
}

/** Client view of a memory nudge (subset of MemoryNudgeTimelineItem). */
export interface MemoryNudgeEventLike {
  ts: string
  prompt: string
  source: 'control' | 'trace'
  iteration?: number
  memoryWritten?: boolean
  durationMs?: number
  status: string
  relatedToolCalls?: readonly MemoryNudgeToolCallLike[]
}

/** Client view of one memory tool call a nudge performed (subset of SubAgentChildToolCall). */
export interface MemoryNudgeToolCallLike {
  name: string
  input: Record<string, unknown>
  result?: string
  summary?: string
  isError?: boolean
  durationMs?: number
}

/** Client view of a sub-agent spawn (subset of SubAgentTimelineItem). */
export interface SubAgentEventLike {
  ts: string
  agentId: string
  label: string
  model?: string
  status: string
  instruction: string
}

/** Friendly source labels for control gate kinds, shown on CONTEXT records. */
const CONTROL_GATE_KINDS: Record<string, string> = {
  task_closure: 'task closure',
  background_tool_completed: 'background tool',
  memory_nudge: 'memory nudge',
  continuation: 'continuation',
  empty_retry: 'empty retry',
  queued_injection: 'queued injection',
}

/**
 * Classify a control message into its CONTEXT source label.
 * @param controlKind - control kind carried on the message, when present.
 * @returns the gate label for the record's Source field.
 */
function controlGateKind(controlKind: string | null): string {
  if (controlKind !== null && CONTROL_GATE_KINDS[controlKind] !== undefined) {
    return CONTROL_GATE_KINDS[controlKind]
  }
  return 'system event'
}

/**
 * Classify a notification injection (memory vs generic system notice).
 * @param content - converted text blocks of the notification message.
 * @returns the gate label for the record's Source field.
 */
function injectionGateKind(content: readonly ContentBlock[]): string {
  const text = content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join(' ')
    .trimStart()
  return text.startsWith('<memory_inject') || text.startsWith('<memory_hint')
    ? 'memory'
    : 'notification'
}

/**
 * Read the closure metadata a task-closure trace span records.
 * @param span - Sanitized trace span.
 * @returns The span's data.closure record, or null when absent.
 */
function closureSpanData(span: TraceSpan): { assistantMessageId?: unknown } | null {
  const closure = span.data?.closure
  return typeof closure === 'object' && closure !== null
    ? (closure as { assistantMessageId?: unknown })
    : null
}

/**
 * Loose view of the request entry an llm_request trace span records.
 * @param span - Sanitized trace span.
 * @returns The span's data.request record, or null when absent.
 */
function llmRequestSpanData(
  span: TraceSpan,
): { tokens?: unknown; response?: unknown; model?: unknown } | null {
  const request = span.data?.request
  return typeof request === 'object' && request !== null
    ? (request as { tokens?: unknown; response?: unknown; model?: unknown })
    : null
}

const GATE_USAGE_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const

/**
 * Token usage a single llm_request span recorded.
 * @param span - Sanitized trace span.
 * @returns Partial gate usage, or null when the span recorded no tokens.
 */
function llmRequestUsage(span: TraceSpan): Partial<ContextGateUsage> | null {
  const tokens = llmRequestSpanData(span)?.tokens
  if (typeof tokens !== 'object' || tokens === null) return null
  const record = tokens as Record<string, unknown>
  const usage: Partial<ContextGateUsage> = {}
  for (const key of GATE_USAGE_KEYS) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) usage[key] = value
  }
  return Object.keys(usage).length === 0 ? null : usage
}

/**
 * Sum token usage across every llm_request span a memory nudge contains.
 * @param requests - llm_request spans that ran inside one nudge window.
 * @returns Total gate usage, or undefined when none recorded tokens.
 */
function sumNudgeUsage(requests: readonly TraceSpan[]): ContextGateUsage | undefined {
  const usage: ContextGateUsage = {}
  let found = false
  for (const request of requests) {
    const part = llmRequestUsage(request)
    if (part === null) continue
    found = true
    for (const key of GATE_USAGE_KEYS) {
      const value = part[key]
      if (value !== undefined) usage[key] = (usage[key] ?? 0) + value
    }
  }
  return found ? usage : undefined
}

/** Loose view of the decision record a memory_retrieval_decision span carries. */
interface MemoryRetrievalDecisionView {
  prompt?: unknown
  system?: unknown
  response?: unknown
  need?: unknown
  queries?: unknown
  searches?: unknown
  usedFallbackSelection?: unknown
  tokens?: unknown
  durationMs?: unknown
  selectedMemories?: unknown
  model?: unknown
}

/**
 * Read the nudge reply a memory_nudge span recorded at runtime. Nudge answers
 * never reach the session transcript, so the span's captured response is the
 * only source for the record's Result pane.
 * @param span - Sanitized memory_nudge trace span, when one matched the event.
 * @returns The recorded reply text, or null when the span carries none.
 */
function memoryNudgeSpanResponse(span: TraceSpan | undefined): string | null {
  const record = span?.data?.memoryNudge as { response?: unknown } | undefined
  const response = record?.response
  return typeof response === 'string' && response.trim() !== '' ? response.trim() : null
}

/**
 * Read the layer-1 retrieval decision off a trace span.
 * @param span - Sanitized trace span.
 * @returns The span's data.memoryRetrievalDecision record, or null.
 */
function memoryRetrievalSpanData(span: TraceSpan): MemoryRetrievalDecisionView | null {
  const decision = span.data?.memoryRetrievalDecision
  return typeof decision === 'object' && decision !== null
    ? (decision as MemoryRetrievalDecisionView)
    : null
}

/**
 * Filter an unknown span field down to its string entries.
 * @param value - Loose span field.
 * @returns String list, empty when the field is not a string array.
 */
function spanStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

/** One memory a retrieval decision selected for context injection. */
interface RetrievedMemoryView {
  title: string
  type?: string
  score?: number
}

/**
 * Normalize the memories a retrieval decision selected.
 * @param value - Loose selectedMemories span field.
 * @returns Titled memories in recorded order.
 */
function memoryRetrievalSelections(value: unknown): RetrievedMemoryView[] {
  if (!Array.isArray(value)) return []
  const out: RetrievedMemoryView[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { title?: unknown; type?: unknown; score?: unknown }
    if (typeof record.title !== 'string' || record.title === '') continue
    out.push({
      title: record.title,
      ...(typeof record.type === 'string' && record.type !== '' ? { type: record.type } : {}),
      ...(typeof record.score === 'number' && Number.isFinite(record.score)
        ? { score: record.score }
        : {}),
    })
  }
  return out
}

/**
 * Render one selected memory as a Result-pane line.
 * @param memory - Selected memory view.
 * @returns Line with title, type, and match score when recorded.
 */
function memoryRetrievalLine(memory: RetrievedMemoryView): string {
  const parts = [memory.title]
  if (memory.type !== undefined) parts.push(memory.type)
  if (memory.score !== undefined) parts.push(`score ${memory.score.toFixed(2)}`)
  return `- ${parts.join(' · ')}`
}

/** One memory candidate an executed search returned. */
interface MemorySearchResultView {
  title: string
  type?: string
  score?: number
  vector?: number
  recency?: number
  keyword?: number
  preview?: string
}

/** One executed memory search recorded on a retrieval decision span. */
interface MemorySearchView {
  query: string
  mode?: string
  topN?: number
  minScore?: number
  resultCount: number
  results: MemorySearchResultView[]
}

/**
 * Normalize the memory searches a retrieval decision executed, including the
 * per-query candidates the search returned before selection.
 * @param value - Loose searches span field.
 * @returns Searches with their candidate results in recorded order.
 */
function memoryRetrievalSearches(value: unknown): MemorySearchView[] {
  if (!Array.isArray(value)) return []
  const out: MemorySearchView[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as {
      query?: unknown
      mode?: unknown
      options?: unknown
      resultCount?: unknown
      results?: unknown
    }
    if (typeof record.query !== 'string' || record.query === '') continue
    const options =
      typeof record.options === 'object' && record.options !== null
        ? (record.options as { topN?: unknown; minScore?: unknown })
        : {}
    const results: MemorySearchResultView[] = Array.isArray(record.results)
      ? record.results.flatMap((item): MemorySearchResultView[] => {
          if (typeof item !== 'object' || item === null) return []
          const hit = item as {
            title?: unknown
            type?: unknown
            score?: unknown
            contentPreview?: unknown
            scoreBreakdown?: unknown
          }
          if (typeof hit.title !== 'string' || hit.title === '') return []
          const breakdown =
            typeof hit.scoreBreakdown === 'object' && hit.scoreBreakdown !== null
              ? (hit.scoreBreakdown as { keyword?: unknown; recency?: unknown; vector?: unknown })
              : {}
          return [
            {
              title: hit.title,
              ...(typeof hit.type === 'string' && hit.type !== '' ? { type: hit.type } : {}),
              ...(typeof hit.score === 'number' && Number.isFinite(hit.score)
                ? { score: hit.score }
                : {}),
              ...(typeof breakdown.vector === 'number' && Number.isFinite(breakdown.vector)
                ? { vector: breakdown.vector }
                : {}),
              ...(typeof breakdown.recency === 'number' && Number.isFinite(breakdown.recency)
                ? { recency: breakdown.recency }
                : {}),
              ...(typeof breakdown.keyword === 'number' && Number.isFinite(breakdown.keyword)
                ? { keyword: breakdown.keyword }
                : {}),
              ...(typeof hit.contentPreview === 'string' && hit.contentPreview.trim() !== ''
                ? { preview: hit.contentPreview }
                : {}),
            },
          ]
        })
      : []
    out.push({
      query: record.query,
      ...(typeof record.mode === 'string' && record.mode !== '' ? { mode: record.mode } : {}),
      ...(typeof options.topN === 'number' && Number.isFinite(options.topN)
        ? { topN: options.topN }
        : {}),
      ...(typeof options.minScore === 'number' && Number.isFinite(options.minScore)
        ? { minScore: options.minScore }
        : {}),
      ...(typeof record.resultCount === 'number' && Number.isFinite(record.resultCount)
        ? { resultCount: record.resultCount }
        : { resultCount: results.length }),
      results,
    })
  }
  return out
}

/**
 * Render one executed memory search as Result-pane lines: the query headline
 * with mode, hit count, and threshold options, then nested candidate lines.
 * @param search - Search view.
 * @returns Query line plus one indented block per returned candidate.
 */
function memorySearchLines(search: MemorySearchView): string {
  const parts = [search.query]
  if (search.mode !== undefined) parts.push(search.mode)
  parts.push(`${search.resultCount} ${search.resultCount === 1 ? 'result' : 'results'}`)
  const options: string[] = []
  if (search.topN !== undefined) options.push(`topN ${search.topN}`)
  if (search.minScore !== undefined) options.push(`minScore ${search.minScore.toFixed(2)}`)
  if (options.length > 0) parts.push(options.join(' · '))
  const lines = [`- ${parts.join(' · ')}`]
  for (const result of search.results) {
    const hit = [result.title]
    if (result.type !== undefined) hit.push(result.type)
    if (result.score !== undefined) hit.push(`score ${result.score.toFixed(2)}`)
    const breakdown: string[] = []
    if (result.vector !== undefined) breakdown.push(`vector ${result.vector.toFixed(2)}`)
    if (result.recency !== undefined) breakdown.push(`recency ${result.recency.toFixed(2)}`)
    if (result.keyword !== undefined) breakdown.push(`keyword ${result.keyword.toFixed(2)}`)
    if (breakdown.length > 0) hit.push(breakdown.join(' · '))
    lines.push(`  - ${hit.join(' · ')}`)
    if (result.preview !== undefined) {
      const preview = result.preview.replace(/\s+/g, ' ').trim()
      lines.push(`    ${preview.length > 100 ? `${preview.slice(0, 100)}…` : preview}`)
    }
  }
  return lines.join('\n')
}

/**
 * Token usage a retrieval decision recorded for its side loop.
 * @param decision - Retrieval decision view.
 * @returns Gate usage with the recorded numeric token fields.
 */
function memoryRetrievalUsage(
  decision: MemoryRetrievalDecisionView | null,
): ContextGateUsage | undefined {
  const tokens = decision?.tokens
  if (typeof tokens !== 'object' || tokens === null) return undefined
  const record = tokens as Record<string, unknown>
  const usage: ContextGateUsage = {}
  let found = false
  for (const key of GATE_USAGE_KEYS) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      usage[key] = value
      found = true
    }
  }
  return found ? usage : undefined
}

/**
 * Headline for a memory nudge's ledger row, mirroring the legacy nudge card:
 * the memory write when one landed, otherwise the prompt's first sentence.
 * @param prompt - Full nudge prompt.
 * @param toolCalls - Memory tool calls performed during the nudge.
 * @returns Short headline text.
 */
function memoryNudgeHeadline(
  prompt: string,
  toolCalls: readonly MemoryNudgeToolCallLike[],
): string {
  const write = toolCalls.find(
    (call) =>
      call.name === 'memory' && (call.input.action === 'create' || call.input.action === 'update'),
  )
  if (write !== undefined) {
    const title =
      typeof write.input.title === 'string' && write.input.title !== ''
        ? write.input.title
        : write.summary
    if (title !== undefined && title !== '') {
      const type =
        typeof write.input.type === 'string' && write.input.type !== ''
          ? write.input.type
          : 'memory'
      return `Recorded ${type}: ${title}`
    }
  }
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  return normalized.match(/^(.+?[?？。!！])/u)?.[1]?.trim() ?? normalized
}

/**
 * Human label for one memory tool call, from its most identifying input field.
 * @param call - Memory tool call performed during a nudge.
 * @returns Label text, or '' when no field identifies the call.
 */
function memoryToolCallLabel(call: MemoryNudgeToolCallLike): string {
  if (call.name === 'memory_search') {
    return typeof call.input.query === 'string' ? call.input.query : ''
  }
  if (call.name === 'memory_read') {
    if (typeof call.input.path === 'string') return call.input.path
    return typeof call.input.id === 'string' ? call.input.id : ''
  }
  if (call.name === 'memory') {
    if (typeof call.input.title === 'string' && call.input.title !== '') {
      return call.input.title
    }
    return typeof call.input.action === 'string' ? `memory.${call.input.action}` : ''
  }
  return ''
}

/**
 * Render one memory tool call as a detail-pane line with label, outcome, and
 * duration, plus the recorded summary when present.
 * @param call - Memory tool call performed during a nudge.
 * @returns Single detail line (summary continues on an indented line).
 */
function memoryToolCallLine(call: MemoryNudgeToolCallLike): string {
  const label = memoryToolCallLabel(call)
  const status = call.isError === true ? 'error' : 'ok'
  const duration =
    call.durationMs === undefined ? '' : ` · ${formatDurationMillis(call.durationMs)}`
  const summary =
    call.summary === undefined || call.summary.trim() === ''
      ? ''
      : `\n  ${call.summary.replace(/\s+/g, ' ').trim().slice(0, 240)}`
  return `- ${call.name}${label === '' ? '' : `: ${label}`} · ${status}${duration}${summary}`
}

/**
 * Read the loose controlKind field off a loose client message.
 * @param message - session message with optional extra fields.
 * @returns the control kind string, or null when absent.
 */
function readControlKind(message: Message): string | null {
  const value = (message as { controlKind?: unknown }).controlKind
  return typeof value === 'string' ? value : null
}

/** One context snapshot's prompt state, in span-clock order. */
interface SnapshotPrompt {
  time: number
  system: string
  tools: ToolSchema[]
}

/**
 * Extract prompt states from snapshot trace spans. Snapshots record the tool
 * catalog as a name list; richer entries pass through when present.
 * @param spans - sanitized trace spans.
 * @returns snapshot prompt states sorted by span start time.
 */
/**
 * Fill in description/parameters for name-only tool catalog entries from the
 * current registry, marking enriched entries so the UI can attribute them.
 * @param tools - catalog as recorded historically (names, possibly definitions).
 * @param registry - current tool registry definitions keyed by name.
 * @returns the catalog with registry definitions applied where missing.
 */
function enrichToolSchemas(
  tools: readonly ToolSchema[],
  registry: ReadonlyMap<string, ToolSchema>,
): ToolSchema[] {
  return tools.map((tool) => {
    const definition = registry.get(tool.name)
    if (definition === undefined || tool.parameters !== undefined) return tool
    return { ...definition, name: tool.name, source: 'registry' }
  })
}

function readSnapshotPrompts(spans: readonly TraceSpan[]): SnapshotPrompt[] {
  const out: SnapshotPrompt[] = []
  for (const span of spans) {
    if (span.kind !== 'snapshot') continue
    const time = toEpochMillis(span.startTime)
    const snapshot = span.data?.snapshot
    if (time === null || typeof snapshot !== 'object' || snapshot === null) continue
    const record = snapshot as Record<string, unknown>
    const system = typeof record.systemPrompt === 'string' ? record.systemPrompt : ''
    if (!Array.isArray(record.tools)) continue
    const tools: ToolSchema[] = []
    for (const entry of record.tools) {
      if (typeof entry === 'string') tools.push({ name: entry })
      else if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === 'string'
      ) {
        tools.push(entry as ToolSchema)
      }
    }
    out.push({ time, system, tools })
  }
  return out.sort((left, right) => left.time - right.time)
}

/**
 * Compare two tool catalogs by name list.
 * @param left - first catalog.
 * @param right - second catalog.
 * @returns true when both catalogs list the same tool names in order.
 */
function sameToolNames(left: readonly ToolSchema[], right: readonly ToolSchema[]): boolean {
  return left.length === right.length && left.every((tool, i) => tool.name === right[i]?.name)
}

/**
 * Assemble the trajectory snapshot for one session.
 * @param session - session detail with the message flow.
 * @param requests - projected LLM request log entries.
 * @param spans - sanitized trace spans (tool_call timings, compaction spans).
 * @param options - optional compaction block data.
 * @returns the trajectory snapshot consumed by TrajectoryView.
 */
export function buildTrajectorySnapshot(
  session: SessionDetail,
  requests: readonly SessionRequestEntry[],
  spans: readonly TraceSpan[],
  options: BuildTrajectoryOptions = {},
): TrajectorySnapshot {
  const messageContent = (message: Message) => message.content
  const flatSpans = flattenTraceSpans(spans)
  const toolCallsById = indexToolCalls(requests)
  // Persisted evidence pointers keyed by tool-use id, from either side of the
  // tool pair; the result-side pointer wins when both exist.
  const toolEvidenceById = new Map<string, ToolEvidenceView>()
  // Backfill call heads from assistant message blocks so sessions without a
  // request log still pair tool results with their calls.
  for (const message of session.messages) {
    for (const block of messageContent(message)) {
      if (!isToolUse(block)) continue
      if (!toolCallsById.has(block.id)) {
        toolCallsById.set(block.id, { name: block.name, argsRaw: JSON.stringify(block.input) })
      }
      const evidence = toEvidencePointer(block)
      if (evidence !== null && !toolEvidenceById.has(block.id)) {
        toolEvidenceById.set(block.id, evidence)
      }
    }
  }
  const toolSpans = indexToolSpans(flatSpans)
  const requestByAssistantId = pairRequestsWithAssistants(session.messages, requests)
  const requestSteps = requestStepIndexes(requests)
  const requestsByStart = [...requests].sort(
    (left, right) => requestTiming(left).startedAt - requestTiming(right).startedAt,
  )
  const requestTurnAtOrAfter = (time: number): number | undefined =>
    requestsByStart.find((request) => requestTiming(request).startedAt >= time)?.turnIndex

  // Walk the message flow assigning synthetic seqs while persisted requests own
  // turn/step identity. Message-derived counters remain only as an old-data fallback.
  const nodes: TrajectorySnapshot['eventNodes'][number][] = []
  const eventLocations = new Map<number, ConversationLocation>()
  const requestViews: RequestView[] = []
  const runningCalls: RunningToolCall[] = []
  const toolResultNodes = new Map<string, ToolResultNode>()
  const toolResultOwners = new Map<string, { turn: number; step: number }>()
  const requestLocations = new Map<string, { turn: number; step: number }>()

  let seq = 0
  let turn = 0
  let stepInTurn = 0

  const noteLocation = (nodeSeq: number, nodeTurn: number, nodeStep: number) => {
    eventLocations.set(nodeSeq, {
      kind: 'step',
      turn: { turn: nodeTurn },
      step: { step: nodeStep },
    })
  }

  for (const message of session.messages) {
    const content = messageContent(message)
    const time = toEpochMillis(message.createdAt) ?? 0

    // Gate and injection messages surface as CONTEXT (control notices, memory
    // injections) or steering USER (queued human input) records instead of
    // being dropped from the ledger.
    if (message.messageType === 'control' || message.messageType === 'notification') {
      const converted = content
        .map(toContentBlock)
        .filter((block): block is ContentBlock => block !== null)
      if (converted.length > 0) {
        const nodeSeq = seq
        seq += 2
        const kind =
          message.messageType === 'control'
            ? controlGateKind(readControlKind(message))
            : injectionGateKind(converted)
        const node: ContextMessageNode = {
          kind: 'context',
          seq: nodeSeq,
          time,
          content: converted,
          source: { kind },
          provenance: { role: 'system', name: kind },
          form: message.messageType,
        }
        nodes.push(node)
        noteLocation(nodeSeq, turn, stepInTurn)
      }
      continue
    }

    if (message.role === 'user' && message.messageType === 'queued') {
      const converted = content
        .map(toContentBlock)
        .filter((block): block is ContentBlock => block !== null)
      if (converted.length > 0) {
        const nodeSeq = seq
        seq += 2
        const node: SteeringMessageNode = {
          kind: 'steering',
          messageId: message.id,
          seq: nodeSeq,
          time,
          content: converted,
          source: { kind: 'user' },
        }
        nodes.push(node)
        noteLocation(nodeSeq, turn, stepInTurn)
      }
      continue
    }

    if (message.role === 'user' && message.messageType === 'message') {
      const hasToolResults = content.some(isToolResult)
      if (!hasToolResults) {
        turn = requestTurnAtOrAfter(time) ?? turn + 1
        stepInTurn = 0
        const nodeSeq = seq
        seq += 2
        const converted = content
          .map(toContentBlock)
          .filter((block): block is ContentBlock => block !== null)
        nodes.push({
          kind: 'user',
          seq: nodeSeq,
          time,
          content: converted,
          source: { kind: 'user' },
        })
        noteLocation(nodeSeq, turn, stepInTurn)
      }
      for (const block of content) {
        if (!isToolResult(block)) continue
        const nodeSeq = seq
        seq += 2
        const owner = toolResultOwners.get(block.toolUseId)
        const node: ToolResultNode = {
          kind: 'tool-result',
          seq: nodeSeq,
          time,
          callId: block.toolUseId,
          call: toolCallsById.get(block.toolUseId) ?? null,
          callTime: time,
          content: [{ type: 'text', text: block.content }],
          isError: block.isError === true,
          evidence: toEvidencePointer(block) ?? toolEvidenceById.get(block.toolUseId) ?? null,
          callView: null,
          resultView: null,
          subCalls: [],
        }
        nodes.push(node)
        toolResultNodes.set(node.callId, node)
        const location = owner ?? { turn, step: stepInTurn }
        noteLocation(nodeSeq, location.turn, location.step)
      }
      continue
    }

    if (message.role === 'assistant' && message.messageType === 'message') {
      const request = requestByAssistantId.get(message.id)
      const messageTurn = request?.turnIndex ?? turn
      const step = request === undefined ? stepInTurn : (requestSteps.get(request.id) ?? 0)
      turn = messageTurn
      stepInTurn = Math.max(stepInTurn, step + 1)
      const nodeSeq = seq
      seq += 2
      const blocks = toAssistantBlocks(content)
      const timing =
        request === undefined
          ? undefined
          : (() => {
              const { startedAt, completedAt } = requestTiming(request)
              return {
                stepStartTime: startedAt,
                firstTokenTime: null,
                completedTime: completedAt ?? time,
              }
            })()
      nodes.push({
        kind: 'assistant',
        seq: nodeSeq,
        messageId: message.id,
        time,
        turn: messageTurn,
        step,
        blocks,
        ...(request === undefined
          ? {}
          : {
              usage: usageOf(request),
              provenance: { provider: request.provider, model: request.model },
              requestConfig: { provider: request.provider, model: request.model },
            }),
        ...(timing === undefined ? {} : { timing }),
      })
      noteLocation(nodeSeq, messageTurn, step)

      for (const block of blocks) {
        if (block.kind === 'tool-call') {
          toolResultOwners.set(block.callId, { turn: messageTurn, step })
        }
      }

      if (request !== undefined) {
        const { startedAt, completedAt } = requestTiming(request)
        requestLocations.set(request.id, { turn: messageTurn, step })
        requestViews.push({
          purpose: 'assistant',
          turn: messageTurn,
          step,
          startSeq: nodeSeq,
          startedAt,
          completedAt,
          status: 'complete',
          provenance: { provider: request.provider, model: request.model },
          requestConfig: { provider: request.provider, model: request.model },
          usage: usageOf(request),
          resultSeq: nodeSeq,
        })
      }
    }
  }

  // Attach precise per-call timing from tool_call trace spans; running spans
  // without a settled message block surface as in-flight calls. Tool-result
  // nodes may appear later in the message flow than their issuing assistant,
  // so this pass runs after the walk.
  for (const request of requests) {
    const location = requestLocations.get(request.id)
    if (location === undefined) continue
    const callSpans = toolSpans.byRequest.get(request.id) ?? []
    const calls = request.toolCalls ?? []
    for (const [index, call] of calls.entries()) {
      const span = toolSpans.byToolUseId.get(call.id) ?? callSpans[index]
      if (span === undefined) continue
      const startTime = toEpochMillis(span.startTime)
      if (startTime === null) continue
      if (span.status === 'running') {
        runningCalls.push({
          callId: call.id,
          name: call.name,
          argsRaw: JSON.stringify(call.input),
          turn: location.turn,
          step: location.step,
          time: startTime,
          callView: null,
          subCalls: [],
        })
        continue
      }
      const toolNode = toolResultNodes.get(call.id)
      if (toolNode !== undefined) {
        toolNode.callTime = startTime
        const endTime = toEpochMillis(span.endTime)
        if (endTime !== null) toolNode.time = endTime
      }
    }
  }

  // Compaction markers and task-closure gates insert chronologically between
  // walk-assigned seqs; the claim helper keeps inserted seqs unique. Tail
  // insertions claim upward so same-timestamp events keep log order. Compaction
  // requests carry turn = null so the view places them between turns.
  const usedSeqs = new Set(nodes.map((node) => node.seq))
  let maxUsedSeq = -1
  for (const used of usedSeqs) if (used > maxUsedSeq) maxUsedSeq = used
  const claimSeqBefore = (before: number | undefined): number => {
    let candidate = before === undefined ? maxUsedSeq + 1 : before - 1
    while (usedSeqs.has(candidate)) candidate -= 1
    usedSeqs.add(candidate)
    if (candidate > maxUsedSeq) maxUsedSeq = candidate
    return candidate
  }
  const nodeAfter = (time: number) => nodes.find((node) => node.time > time)

  const compactionSpans = flatSpans.filter((span) => span.kind === 'context_compaction')
  for (const block of options.compactionBlocks ?? []) {
    const time = toEpochMillis(block.createdAt) ?? 0
    const insertBefore = nodeAfter(time)
    const nodeSeq = claimSeqBefore(insertBefore === undefined ? undefined : insertBefore.seq)
    nodes.push({
      kind: 'compaction',
      seq: nodeSeq,
      time,
      summary: block.summary,
      summaryEventSeq: null,
      shadowedItemCount: block.coveredMessageCount,
      shadowedTokenCount: null,
    })
    eventLocations.set(nodeSeq, { kind: 'turn', turn: { turn } })
    const span = compactionSpans.find((candidate) => {
      const compaction = candidate.data?.compaction
      const nestedBlockId =
        typeof compaction === 'object' && compaction !== null
          ? (compaction as { blockId?: unknown }).blockId
          : undefined
      return (
        candidate.data?.blockId === block.id ||
        candidate.metadata?.blockId === block.id ||
        nestedBlockId === block.id
      )
    })
    const startedAt = toEpochMillis(span?.startTime ?? block.createdAt) ?? 0
    const completedAt = toEpochMillis(span?.endTime ?? undefined)
    requestViews.push({
      purpose: 'compaction',
      turn: null,
      step: 0,
      startSeq: nodeSeq,
      startedAt,
      completedAt: span === undefined ? completedAt : (completedAt ?? startedAt),
      status:
        span?.status === 'error' ? 'error' : span?.status === 'running' ? 'running' : 'complete',
      replacementSeq: nodeSeq,
      // Surface the compaction summary in the COMPACTED section's detail pane.
      ...(block.summary !== undefined && block.summary !== ''
        ? { summary: [{ type: 'text', text: block.summary }] }
        : {}),
    })
  }

  // Task-closure gates (finish/continue/block) land as CONTEXT records next to
  // the assistant turn they judged. The row shows the parsed verdict; the
  // captured question/answer pair rides on gateQa and renders tool-style with
  // separate Payload (classifier prompt) and Result (classifier output) detail.
  // The gate's own trace span supplies timing; the classifier response carries
  // its token usage. Spans join events by the judged assistant message id,
  // falling back to an exact end-time match.
  const closureSpans = flatSpans.filter((span) => span.name === 'task_closure_decision')
  for (const event of options.taskClosureEvents ?? []) {
    const time = toEpochMillis(event.ts)
    if (time === null) continue
    const action = event.action ?? (event.event === 'task_closure_failed' ? 'failed' : 'unknown')
    const insertBefore = nodeAfter(time)
    const nodeSeq = claimSeqBefore(insertBefore === undefined ? undefined : insertBefore.seq)
    const label = `task closure ${action}`
    const answerParts: string[] = []
    const answer =
      event.classifierResponseRaw !== undefined && event.classifierResponseRaw !== ''
        ? event.classifierResponseRaw
        : (event.classifierResponse?.content ?? [])
            .map((block) => (typeof block.text === 'string' ? block.text : ''))
            .filter((text) => text !== '')
            .join('\n')
    if (answer !== '') answerParts.push(answer)
    const reasoning = event.classifierResponse?.reasoningContent
    if (reasoning !== undefined && reasoning !== '') {
      answerParts.push(`Classifier reasoning:\n${reasoning}`)
    }
    if (event.event === 'task_closure_failed') {
      const failureDetail = [
        event.failureStage === undefined ? null : `stage: ${event.failureStage}`,
        event.error === undefined || event.error === '' ? null : `error: ${event.error}`,
      ].filter((part): part is string => part !== null)
      if (failureDetail.length > 0) {
        answerParts.push(`Failure detail:\n${failureDetail.join('\n')}`)
      }
    }
    const span =
      closureSpans.find((candidate) => {
        if (event.assistantMessageId === undefined) return false
        const closure = closureSpanData(candidate)
        return closure?.assistantMessageId === event.assistantMessageId
      }) ?? closureSpans.find((candidate) => toEpochMillis(candidate.endTime) === time)
    const spanStart = span === undefined ? null : toEpochMillis(span.startTime)
    const spanEnd = span === undefined ? null : toEpochMillis(span.endTime)
    const gateQa =
      answerParts.length === 0
        ? undefined
        : {
            question: event.classifierRequest?.prompt ?? '',
            answer: answerParts.join('\n\n'),
            ...(spanStart === null ? {} : { startedAt: spanStart }),
            ...(spanStart === null || spanEnd === null
              ? {}
              : { durationMs: Math.max(0, spanEnd - spanStart) }),
            ...(event.classifierResponse?.usage === undefined
              ? {}
              : { usage: event.classifierResponse.usage }),
          }
    nodes.push({
      kind: 'context',
      seq: nodeSeq,
      time,
      content: [{ type: 'text', text: `${label}: ${event.reason}` }],
      ...(gateQa === undefined ? {} : { gateQa }),
      source: {
        kind: 'task closure',
        action,
        ...(event.classifierRequest?.maxTokens === undefined
          ? {}
          : { maxTokens: event.classifierRequest.maxTokens }),
        ...(event.classifierResponse?.model === undefined
          ? {}
          : { model: event.classifierResponse.model }),
      },
      provenance: { role: 'system', name: label },
      form: 'task-closure',
    })
    let anchor: ConversationLocation | undefined
    for (const node of nodes) {
      if (node.time > time) break
      if (node.kind === 'assistant') {
        anchor = { kind: 'step', turn: { turn: node.turn }, step: { step: node.step } }
      }
    }
    eventLocations.set(nodeSeq, anchor ?? { kind: 'turn', turn: { turn } })
  }

  // Sub-agent spawns land as CONTEXT records at their spawn point with the
  // resolved lifecycle status, so the ledger tells the whole delegation story.
  for (const event of options.subAgentEvents ?? []) {
    const time = toEpochMillis(event.ts)
    if (time === null) continue
    const insertBefore = nodeAfter(time)
    const nodeSeq = claimSeqBefore(insertBefore === undefined ? undefined : insertBefore.seq)
    const heading = `sub-agent ${event.label}${
      event.model === undefined || event.model === '' ? '' : ` (${event.model})`
    }: ${event.status}`
    nodes.push({
      kind: 'context',
      seq: nodeSeq,
      time,
      content: [
        {
          type: 'text',
          text:
            event.instruction === '' ? heading : `${heading}\n${event.instruction.slice(0, 240)}`,
        },
      ],
      source: { kind: 'sub-agent', status: event.status },
      provenance: { role: 'system', name: `sub-agent ${event.agentId}` },
      form: 'sub-agent',
    })
    let anchor: ConversationLocation | undefined
    for (const node of nodes) {
      if (node.time > time) break
      if (node.kind === 'assistant') {
        anchor = { kind: 'step', turn: { turn: node.turn }, step: { step: node.step } }
      }
    }
    eventLocations.set(nodeSeq, anchor ?? { kind: 'turn', turn: { turn } })
  }

  // Span-derived memory nudges land as CONTEXT records; nudges that already
  // surface through their control message in the walk above are skipped so
  // they are not listed twice. The row shows the ledger headline; the nudge
  // prompt and its outcome ride on gateQa and render tool-style with separate
  // Payload and Result detail. The nudge's own trace span supplies timing and
  // the reply it recorded at runtime (nudge answers stay out of the session
  // transcript), while the llm_request spans it contains carry the token
  // usage and a response fallback for spans without a captured reply.
  const nudgeSpans = flatSpans.filter((span) => span.name === 'memory_nudge')
  for (const event of options.memoryNudgeEvents ?? []) {
    if (event.source !== 'trace') continue
    const time = toEpochMillis(event.ts)
    if (time === null) continue
    const insertBefore = nodeAfter(time)
    const nodeSeq = claimSeqBefore(insertBefore === undefined ? undefined : insertBefore.seq)
    const toolCalls = event.relatedToolCalls ?? []
    const state =
      event.memoryWritten === undefined
        ? ''
        : event.memoryWritten
          ? ' · memory written'
          : ' · no memory written'
    const duration =
      event.durationMs === undefined ? '' : ` · ${formatDurationMillis(event.durationMs)}`
    const failure = event.status !== 'success' ? ` · ${event.status}` : ''
    const heading = `memory nudge${
      event.iteration === undefined ? '' : ` #${event.iteration}`
    }${state}${duration}${failure}`
    const span =
      nudgeSpans.find((candidate) => toEpochMillis(candidate.endTime) === time) ??
      nudgeSpans.find((candidate) => {
        const start = toEpochMillis(candidate.startTime)
        const end = toEpochMillis(candidate.endTime)
        return start !== null && end !== null && start <= time && time <= end
      })
    const spanStart = span === undefined ? null : toEpochMillis(span.startTime)
    const spanEnd = span === undefined ? null : toEpochMillis(span.endTime)
    const nudgeRequests =
      spanStart === null || spanEnd === null
        ? []
        : flatSpans.filter((candidate) => {
            if (candidate.name !== 'llm_request') return false
            const start = toEpochMillis(candidate.startTime)
            const end = toEpochMillis(candidate.endTime)
            return start !== null && end !== null && start >= spanStart - 1 && end <= spanEnd + 1
          })
    const usage = sumNudgeUsage(nudgeRequests)
    let response: string | null = memoryNudgeSpanResponse(span)
    let model: string | undefined
    for (const candidate of nudgeRequests) {
      const data = llmRequestSpanData(candidate)
      if (model === undefined && typeof data?.model === 'string' && data.model !== '') {
        model = data.model
      }
      if (response === null && typeof data?.response === 'string' && data.response.trim() !== '') {
        response = data.response.trim()
      }
    }
    const answerParts: string[] = []
    if (toolCalls.length > 0) {
      answerParts.push(
        `Memory steps (${toolCalls.length}):\n${toolCalls.map(memoryToolCallLine).join('\n')}`,
      )
    }
    if (response !== null) answerParts.push(`Response:\n${response}`)
    if (answerParts.length === 0) {
      answerParts.push(
        event.memoryWritten === undefined
          ? 'No recorded output.'
          : event.memoryWritten
            ? 'Memory written.'
            : 'No memory written.',
      )
    }
    const durationMs =
      spanStart !== null && spanEnd !== null ? Math.max(0, spanEnd - spanStart) : event.durationMs
    const startedAt =
      spanStart ?? (event.durationMs === undefined ? null : time - Math.max(0, event.durationMs))
    const gateQa = {
      question: event.prompt,
      answer: answerParts.join('\n\n'),
      ...(startedAt === null ? {} : { startedAt }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(usage === undefined ? {} : { usage }),
    }
    nodes.push({
      kind: 'context',
      seq: nodeSeq,
      time,
      content: [
        { type: 'text', text: `${heading}\n${memoryNudgeHeadline(event.prompt, toolCalls)}` },
      ],
      gateQa,
      source: {
        kind: 'memory nudge',
        memoryWritten: event.memoryWritten,
        ...(model === undefined ? {} : { model }),
      },
      provenance: { role: 'system', name: 'memory nudge' },
      form: 'memory-nudge',
    })
    let anchor: ConversationLocation | undefined
    for (const node of nodes) {
      if (node.time > time) break
      if (node.kind === 'assistant') {
        anchor = { kind: 'step', turn: { turn: node.turn }, step: { step: node.step } }
      }
    }
    eventLocations.set(nodeSeq, anchor ?? { kind: 'turn', turn: { turn } })
  }

  // Layer-1 memory retrieval runs beside the loop after every user message;
  // its span carries the full decision record (trigger prompt, generated
  // queries, selected memories, side-loop usage). Selected memories were
  // injected into the request context, so those records badge as CONTEXT,
  // while decisions that selected nothing stay GATEWAY side calls.
  const retrievalSpans = flatSpans.filter(
    (span) => span.name === 'memory_retrieval_decision' && span.metadata?.layer === 'layer1',
  )
  for (const span of retrievalSpans) {
    const start = toEpochMillis(span.startTime)
    if (start === null) continue
    const decision = memoryRetrievalSpanData(span)
    const end = toEpochMillis(span.endTime)
    const insertBefore = nodeAfter(start)
    const nodeSeq = claimSeqBefore(insertBefore === undefined ? undefined : insertBefore.seq)
    const queries = spanStringList(decision?.queries)
    const searches = memoryRetrievalSearches(decision?.searches)
    const selected = memoryRetrievalSelections(decision?.selectedMemories)
    const injected = selected.length > 0
    const durationMs =
      typeof decision?.durationMs === 'number' && Number.isFinite(decision.durationMs)
        ? decision.durationMs
        : end === null
          ? undefined
          : Math.max(0, end - start)
    const noun = selected.length === 1 ? 'memory' : 'memories'
    const heading = `memory retrieval · ${
      injected ? `${selected.length} ${noun} injected` : 'no memories injected'
    }${durationMs === undefined ? '' : ` · ${formatDurationMillis(durationMs)}`}${
      span.status !== 'success' ? ` · ${span.status}` : ''
    }`
    const answerParts: string[] = []
    // Searches carry the executed queries plus their candidate hits, which
    // supersedes the plain generated-query list when the runtime recorded them.
    if (searches.length > 0) {
      answerParts.push(
        `Memory searches (${searches.length}):\n${searches.map(memorySearchLines).join('\n')}`,
      )
    } else if (queries.length > 0) {
      answerParts.push(`Queries (${queries.length}):\n${queries.map((q) => `- ${q}`).join('\n')}`)
    }
    if (selected.length > 0) {
      const fallbackSuffix = decision?.usedFallbackSelection === true ? ' · fallback selection' : ''
      answerParts.push(
        `Selected memories (${selected.length})${fallbackSuffix}:\n${selected
          .map(memoryRetrievalLine)
          .join('\n')}`,
      )
    }
    if (typeof decision?.response === 'string' && decision.response.trim() !== '') {
      answerParts.push(`Response:\n${decision.response.trim()}`)
    }
    if (answerParts.length === 0) {
      answerParts.push(decision?.need === false ? 'No memories needed.' : 'No memories selected.')
    }
    const usage = memoryRetrievalUsage(decision)
    const model =
      typeof decision?.model === 'string' && decision.model !== '' ? decision.model : undefined
    // The side loop's payload pairs its instruction with the trigger message,
    // mirroring how the task-closure gate's prompt embeds its classifier
    // instruction; older spans without the recorded system show the trigger
    // alone.
    const prompt = typeof decision?.prompt === 'string' ? decision.prompt : ''
    const system = typeof decision?.system === 'string' ? decision.system.trim() : ''
    const question = system === '' ? prompt : `${system}\n\n${prompt}`
    nodes.push({
      kind: 'context',
      seq: nodeSeq,
      time: start,
      content: [{ type: 'text', text: `${heading}\n${queries[0] ?? 'no queries generated'}` }],
      gateQa: {
        question,
        answer: answerParts.join('\n\n'),
        startedAt: start,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(usage === undefined ? {} : { usage }),
      },
      source: {
        kind: 'memory retrieval',
        injected,
        count: selected.length,
        ...(model === undefined ? {} : { model }),
      },
      provenance: { role: 'system', name: 'memory retrieval' },
      form: 'memory-retrieval',
    })
    let retrievalAnchor: ConversationLocation | undefined
    for (const node of nodes) {
      if (node.time > start) break
      if (node.kind === 'assistant') {
        retrievalAnchor = { kind: 'step', turn: { turn: node.turn }, step: { step: node.step } }
      }
    }
    eventLocations.set(nodeSeq, retrievalAnchor ?? { kind: 'turn', turn: { turn } })
  }

  // Context snapshots drive the SYSTEM records: the initial prompt (system
  // message + tool catalog) rides on the first assistant request, and later
  // tool/system changes land on the next request with the previous state for
  // the diff view. Without snapshots, the session system prompt alone still
  // renders as the opening SYSTEM record with an empty catalog.
  const fallbackSystemPrompt = session.systemPrompt
  const assistantViews = requestViews.filter(
    (view): view is AssistantRequestView => view.purpose === 'assistant',
  )
  const toolRegistry = new Map<string, ToolSchema>(
    (options.toolSchemas ?? []).map((tool) => [tool.name, tool]),
  )
  const snapshotPrompts = readSnapshotPrompts(flatSpans).map((prompt) => ({
    ...prompt,
    tools: enrichToolSchemas(prompt.tools, toolRegistry),
  }))
  const promptOf = (
    view: AssistantRequestView,
    state: { system: string; tools: ToolSchema[] },
  ): ConversationPromptSnapshot => ({
    config: view.requestConfig ?? { provider: '', model: '' },
    system: state.system,
    tools: state.tools,
  })
  let promptCursor = 0
  let previousState: { system: string; tools: ToolSchema[] } | null = null
  for (const snapshotPrompt of snapshotPrompts) {
    const fallbackSystem: string =
      previousState?.system ??
      (typeof fallbackSystemPrompt === 'string' ? fallbackSystemPrompt : '')
    const nextState: { system: string; tools: ToolSchema[] } = {
      system: snapshotPrompt.system !== '' ? snapshotPrompt.system : fallbackSystem,
      tools: snapshotPrompt.tools,
    }
    const systemChanged = previousState !== null && nextState.system !== previousState.system
    const toolsChanged =
      previousState !== null && !sameToolNames(nextState.tools, previousState.tools)
    if (previousState !== null && !systemChanged && !toolsChanged) {
      previousState = nextState
      continue
    }
    while (
      promptCursor < assistantViews.length &&
      (assistantViews[promptCursor].promptChange !== undefined ||
        (previousState !== null && assistantViews[promptCursor].startedAt < snapshotPrompt.time))
    ) {
      promptCursor += 1
    }
    const target = assistantViews[promptCursor]
    if (target === undefined) {
      previousState = nextState
      continue
    }
    target.prompt = promptOf(target, nextState)
    target.promptChange =
      previousState === null
        ? {
            seq: -1,
            time: toEpochMillis(session.createdAt) ?? target.startedAt,
            kind: 'initial',
          }
        : {
            seq: target.startSeq,
            time: snapshotPrompt.time,
            kind:
              systemChanged && toolsChanged
                ? 'system-and-tools'
                : toolsChanged
                  ? 'tools'
                  : 'system',
            previous: promptOf(target, previousState),
          }
    previousState = nextState
  }
  if (
    previousState === null &&
    typeof fallbackSystemPrompt === 'string' &&
    fallbackSystemPrompt !== ''
  ) {
    const firstAssistant = assistantViews[0]
    if (firstAssistant !== undefined) {
      firstAssistant.prompt = promptOf(firstAssistant, {
        system: fallbackSystemPrompt,
        tools: [],
      })
      firstAssistant.promptChange = {
        seq: -1,
        time: toEpochMillis(session.createdAt) ?? firstAssistant.startedAt,
        kind: 'initial',
      }
    }
  }

  const callSchemas = new Map<string, ToolSchema>()
  for (const [callId, call] of toolCallsById) {
    const schema = toolRegistry.get(call.name)
    if (schema !== undefined) callSchemas.set(callId, { ...schema, source: 'registry' })
  }

  nodes.sort((left, right) => left.seq - right.seq)
  requestViews.sort((left, right) => left.startSeq - right.startSeq)

  return {
    eventNodes: nodes,
    eventLocations,
    requests: requestViews,
    callSchemas,
    partial: null,
    runningCalls,
  }
}
