import { createHash } from 'node:crypto'
import type {
  ContentBlock,
  EpisodeCompaction,
  Message,
  TimelineCompactionBlock,
  TimelineCompactionBlockLifecycle,
  TimelineCompactionModelInfo,
  TimelineCompactionTopic,
  TimelineCompactionValidation,
  ToolEvidence,
  ToolResultBlock,
} from '@zero-os/shared'
import { estimateMessageTokens, hasSignedThinkingBlock, now } from '@zero-os/shared'
import { buildEpisodeCompaction, buildWorkingStateCompaction, formatWorkingState } from './evidence'
import { CONTEXT_PARAMS } from './params'

export interface ConversationHistoryOptions {
  requireThinkingForToolUse?: boolean
  enableEpisodeCompaction?: boolean
  evidenceWorkDir?: string
  sessionId?: string
  timelineCompactionBlocks?: TimelineCompactionBlock[]
  onTimelineCompactionBlocksChanged?: (blocks: TimelineCompactionBlock[]) => void
  onEpisodeCompaction?: (event: EpisodeCompactionTraceEvent) => void
  contextCompactor?: ContextCompactor
}

export interface ContextCompactionModelInput {
  sessionId: string
  blockId: string
  strategyVersion: string
  currentGoal: string
  segment: Message[]
  retainedMessages: Message[]
  episode: EpisodeCompaction
  workingStateSummary: string
}

export interface ContextCompactionModelOutput {
  summary: string
  topics?: TimelineCompactionTopic[]
  validation?: TimelineCompactionValidation
  model?: TimelineCompactionModelInfo
  confirmedFacts?: string[]
  userConstraints?: string[]
  decisions?: string[]
  currentState?: string[]
  openQuestions?: string[]
  nextActions?: string[]
  doNotInfer?: string[]
  keyEvidence?: string[]
}

export type ContextCompactor = (
  input: ContextCompactionModelInput,
) => Promise<ContextCompactionModelOutput | undefined>

export interface EpisodeCompactionTraceEpisode {
  id: string
  status: EpisodeCompaction['status']
  goal: string
  scope: string[]
  messageIds: string[]
  toolUseIds: string[]
  evidenceCount: number
  evidenceChars: number
  evidenceBytes: number
  blockerCount: number
}

export interface EpisodeCompactionTraceEvent {
  event: 'timeline_compaction_block'
  sessionId: string
  lifecycle: TimelineCompactionBlockLifecycle
  blockId: string
  blockStatus: TimelineCompactionBlock['status']
  blockGeneration: number
  strategy: string
  boundaryReason: string
  strategyVersion: string
  messagesBefore: number
  messagesAfter: number
  compactedMessageCount: number
  retainedMessageCount: number
  promptCharsBefore: number
  promptCharsAfter: number
  tokensBefore: number
  tokensAfter: number
  episodesCreated: number
  workingStateId: string
  episodeFullRetainTurns: number
  skippedUnfinishedToolUseIds: string[]
  compactedMessageIds: string[]
  retainedMessageIds: string[]
  toolUseIds: string[]
  evidenceCount: number
  evidenceChars: number
  evidenceBytes: number
  rawCharsMovedToEvidence: number
  coveredRange: TimelineCompactionBlock['coveredRange']
  coveredMessageIds: string[]
  evidenceWriteStatusCounts: {
    created: number
    existing: number
  }
  evidence: ToolEvidence[]
  episodes: EpisodeCompactionTraceEpisode[]
  topicCount?: number
  validationStatus?: string
  validationErrors?: string[]
  validationWarnings?: string[]
  model?: string
  provider?: string
  promptVersion?: string
  modelAttempts?: number
  supersedesBlockIds?: string[]
  supersededByBlockId?: string
}

export function reduceHistoricalToolOutput(
  messages: Message[],
  turnBoundaries: number[],
): Message[] {
  // Assign turn indices by scanning from the end.
  const turnAgeMap = buildTurnAgeMap(messages, turnBoundaries)

  return messages.map((msg, idx) => {
    if (msg.role !== 'user') return msg
    const hasToolResult = msg.content.some((b) => b.type === 'tool_result')
    if (!hasToolResult) return msg

    const age = turnAgeMap.get(idx) ?? turnBoundaries.length
    const newContent = msg.content.map((block) => {
      if (block.type !== 'tool_result') return block

      // Already at maximum truncation; never re-process.
      if (block.truncationLevel === 'status') return block

      if (age <= CONTEXT_PARAMS.history.fullRetainTurns) {
        if (!block.truncationLevel) block.truncationLevel = 'full'
        return block
      }

      if (block.truncationLevel === 'summary' && age <= CONTEXT_PARAMS.history.summaryRetainTurns) {
        return block
      }

      if (age <= CONTEXT_PARAMS.history.summaryRetainTurns) {
        const summarized = summarizeToolResult(block)
        block.content = summarized.content
        block.contentItems = undefined
        block.truncationLevel = 'summary'
        return block
      }

      const statusOnly = statusOnlyToolResult(block)
      block.content = statusOnly.content
      block.contentItems = undefined
      block.truncationLevel = 'status'
      return block
    })

    return { ...msg, content: newContent }
  })
}

function reducePromptToolOutputs(messages: Message[], turnBoundaries: number[]): Message[] {
  return reduceToolOutputsUnderPromptPressure(reduceHistoricalToolOutput(messages, turnBoundaries))
}

function findTurnBoundaries(messages: Message[]): number[] {
  const turnBoundaries: number[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (startsTopLevelTurn(msg)) {
      turnBoundaries.push(i)
    }
  }
  return turnBoundaries
}

function buildTurnAgeMap(messages: Message[], turnBoundaries: number[]): Map<number, number> {
  const turnAgeMap = new Map<number, number>()
  for (let t = 0; t < turnBoundaries.length; t++) {
    const startIdx = turnBoundaries[t]
    const endIdx = t === 0 ? messages.length : turnBoundaries[t - 1]
    for (let i = startIdx; i < endIdx; i++) {
      turnAgeMap.set(i, t)
    }
  }

  if (turnBoundaries.length > 0) {
    const oldestTurnStart = turnBoundaries[turnBoundaries.length - 1]
    for (let i = 0; i < oldestTurnStart; i++) {
      turnAgeMap.set(i, turnBoundaries.length)
    }
  }

  return turnAgeMap
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJsonLength(value: unknown): number {
  return JSON.stringify(value).length
}

function truncateOneLine(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized
}

function findContainingTurnStart(messages: Message[], messageIndex: number): number {
  for (let index = messageIndex; index >= 0; index--) {
    if (startsTopLevelTurn(messages[index])) return index
  }
  return 0
}

function findContainingTurnEnd(messages: Message[], turnStart: number): number {
  for (let index = turnStart + 1; index < messages.length; index++) {
    if (startsTopLevelTurn(messages[index])) return index
  }
  return messages.length
}

function isToolIoBlock(block: ContentBlock): boolean {
  return block.type === 'tool_use' || block.type === 'tool_result'
}

function extractCurrentGoal(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!startsTopLevelTurn(message)) continue
    const text = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text.trim()] : []))
      .find((value) => value.length > 0)
    if (text) return text.length > 240 ? `${text.slice(0, 240)}...` : text
  }
  return 'Continue the current session task.'
}

function startsTopLevelTurn(message: Message): boolean {
  return (
    message.role === 'user' &&
    message.messageType === 'message' &&
    message.content.some((block) => block.type === 'text')
  )
}

/**
 * Estimate total tokens in a conversation history.
 */
export function estimateConversationTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    total += estimateMessageTokens(msg.content)
    total += 4 // overhead per message (role, metadata)
  }
  return total
}

function reduceToolOutputsUnderPromptPressure(messages: Message[]): Message[] {
  if (JSON.stringify(messages).length <= CONTEXT_PARAMS.history.promptPressureCharsThreshold) {
    return messages
  }

  const toolResults: ToolResultBlock[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'tool_result') toolResults.push(block)
    }
  }

  const fullRetain = CONTEXT_PARAMS.history.promptPressureFullToolResults
  const summaryRetain = CONTEXT_PARAMS.history.promptPressureSummaryToolResults
  for (let index = 0; index < toolResults.length; index++) {
    const block = toolResults[index]
    const age = toolResults.length - 1 - index
    if (block.truncationLevel === 'status') continue
    if (age < fullRetain) {
      if (!block.truncationLevel) block.truncationLevel = 'full'
      continue
    }

    if (age < fullRetain + summaryRetain) {
      const summarized = summarizeToolResult(block)
      block.content = summarized.content
      block.contentItems = undefined
      block.truncationLevel = 'summary'
      continue
    }

    const statusOnly = statusOnlyToolResult(block)
    block.content = statusOnly.content
    block.contentItems = undefined
    block.truncationLevel = 'status'
  }

  return messages
}

function summarizeToolResult(block: ToolResultBlock): ToolResultBlock {
  const summary =
    block.outputSummary ?? block.content.slice(0, CONTEXT_PARAMS.history.summaryMaxChars)
  const truncated = summary.length < block.content.length ? `${summary}...` : summary
  return {
    ...block,
    content: appendRetainedHandles(truncated, block.content),
    contentItems: undefined,
    truncationLevel: 'summary',
  }
}

function statusOnlyToolResult(block: ToolResultBlock): ToolResultBlock {
  if (block.isError) {
    const errorSnippet = block.content.slice(0, 100)
    return {
      ...block,
      content: appendRetainedHandles(`\u2717 failed: ${errorSnippet}`, block.content),
      contentItems: undefined,
      truncationLevel: 'status',
    }
  }
  return {
    ...block,
    content: appendRetainedHandles('\u2713 success', block.content),
    contentItems: undefined,
    truncationLevel: 'status',
  }
}

const RETAINED_HANDLE_URL_PATTERN = /https?:\/\/[^\s"'<>）)、,；;]+/g
// Paths are boundary-anchored so a segment like /tmp inside /repo/tmp/... is
// never captured as a truncated path starting mid-token.
const RETAINED_HANDLE_ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s"'(<（【=])(\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)+)/g
const RETAINED_HANDLE_RELATIVE_PATH_PATTERN =
  /(?:^|[\s"'(<（【=])((?:\.zero|~|\.)\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*)/g
const RETAINED_HANDLE_FILE_PATTERN = /[A-Za-z0-9_][A-Za-z0-9_.-]{2,}\.[A-Za-z][A-Za-z0-9]{0,7}/g
const RETAINED_HANDLE_FLAG_PATTERN = /(?:^|[\s"'=(])-{1,2}[A-Za-z][A-Za-z0-9_-]{2,}/g

/**
 * Exact handles (URLs, paths, filenames, command flags) that later turns
 * frequently reuse as tool arguments. Truncated tool results keep a bounded
 * list of them so heavy compaction does not sever the link to previously
 * produced artifacts.
 */
export function extractRetainedHandles(text: string): string[] {
  const categories = extractRetainedHandlesByCategory(text)
  return [...categories.urls, ...categories.paths, ...categories.files, ...categories.flags]
}

interface RetainedHandleCategories {
  urls: string[]
  paths: string[]
  files: string[]
  flags: string[]
}

function extractRetainedHandlesByCategory(text: string): RetainedHandleCategories {
  const push = (list: string[], seen: Set<string>, value: string) => {
    const handle = value.replace(/[.,;:)\]}>'"]+$/, '')
    if (handle.length < 4 || seen.has(handle)) return
    seen.add(handle)
    list.push(handle)
  }
  const urls: string[] = []
  const paths: string[] = []
  const files: string[] = []
  const flags: string[] = []
  const urlSeen = new Set<string>()
  const pathSeen = new Set<string>()
  const fileSeen = new Set<string>()
  const flagSeen = new Set<string>()
  for (const match of text.matchAll(RETAINED_HANDLE_URL_PATTERN)) push(urls, urlSeen, match[0])
  for (const match of text.matchAll(RETAINED_HANDLE_ABSOLUTE_PATH_PATTERN))
    push(paths, pathSeen, match[1])
  for (const match of text.matchAll(RETAINED_HANDLE_RELATIVE_PATH_PATTERN))
    push(paths, pathSeen, match[1])
  for (const match of text.matchAll(RETAINED_HANDLE_FILE_PATTERN)) {
    // Skip bare filenames already contained in a longer path or URL handle.
    const contained =
      paths.some((path) => path.includes(match[0])) || urls.some((url) => url.includes(match[0]))
    if (!contained) push(files, fileSeen, match[0])
  }
  for (const match of text.matchAll(RETAINED_HANDLE_FLAG_PATTERN)) push(flags, flagSeen, match[0])
  return { urls, paths, files, flags }
}

function appendRetainedHandles(content: string, original: string): string {
  const handles = extractRetainedHandles(original).filter((handle) => !content.includes(handle))
  if (handles.length === 0) return content
  const maxHandles = CONTEXT_PARAMS.history.handleRetentionMaxHandles
  const maxChars = CONTEXT_PARAMS.history.handleRetentionMaxChars
  const kept: string[] = []
  let keptChars = 0
  for (const handle of handles) {
    if (kept.length >= maxHandles || keptChars + handle.length > maxChars) break
    kept.push(handle)
    keptChars += handle.length + 2
  }
  if (kept.length === 0) return content
  return `${content}\nretained_handles: ${kept.join(', ')}`
}

const TIMELINE_RECOMPACT_STRATEGY = 'semantic_recompact_raw_history_v1'
const TIMELINE_RECOMPACT_BOUNDARY_REASON =
  'Recompacted active timeline blocks from original raw messages and tool evidence because the projected prompt was still block-heavy or oversized.'
const TIMELINE_SINGLE_BLOCK_RECOVERY_MARKER = 'single_block_oversize_recovery=1'
const timelineCompactionStrategyVersion = 'timeline_compaction_block_v3'
const deterministicFallbackPromptVersion = 'context_compaction_deterministic_fallback_v1'

async function buildTimelineCompactionBlock(params: {
  messages: Message[]
  segment: Message[]
  options: {
    workDir: string
    sessionId: string
    contextCompactor?: ContextCompactor
  }
  skippedUnfinishedToolUseIds: string[]
  generation?: number
  supersedesBlockIds?: string[]
  strategyOverride?: string
  boundaryReasonOverride?: string
}): Promise<TimelineCompactionBlock | undefined> {
  const episode = buildEpisodeCompaction(params.segment, params.options)
  const coveredMessageIds = params.segment.map((message) => message.id)
  const coveredMessageIdSet = new Set(coveredMessageIds)
  const retainedMessages = params.messages.filter((message) => !coveredMessageIdSet.has(message.id))
  const currentGoal = extractCurrentGoal(params.messages)
  const workingState = buildWorkingStateCompaction({
    currentGoal,
    retainedMessages,
    episodes: [episode],
  })
  const workingStateSummary = formatWorkingState(workingState)
  const strategyVersion = timelineCompactionStrategyVersion
  const blockId = buildTimelineCompactionBlockId(
    params.options.sessionId,
    coveredMessageIds[0],
    strategyVersion,
    params.generation,
  )
  const modelOutput =
    (await params.options.contextCompactor?.({
      sessionId: params.options.sessionId,
      blockId,
      strategyVersion,
      currentGoal,
      segment: params.segment,
      retainedMessages,
      episode,
      workingStateSummary,
    })) ??
    buildDeterministicFallbackCompaction({
      sessionId: params.options.sessionId,
      blockId,
      strategyVersion,
      currentGoal,
      episode,
      workingStateSummary,
    })

  return buildTimelineCompactionBlockFromEpisode({
    ...params,
    episode,
    retainedMessages,
    currentGoal,
    workingStateSummary,
    modelOutput,
  })
}

function normalizeTimelineCompactionBlocks(
  blocks: TimelineCompactionBlock[] | undefined,
  sessionId: string,
): TimelineCompactionBlock[] {
  return sortTimelineCompactionBlocks(
    (blocks ?? []).filter((block) => block.sessionId === sessionId && block.status === 'active'),
  )
}

function projectTimelineCompactionBlocks(
  messages: Message[],
  blocks: TimelineCompactionBlock[],
  sessionId: string,
): Message[] {
  const activeBlocks = normalizeTimelineCompactionBlocks(blocks, sessionId)
  if (activeBlocks.length === 0) return messages

  const blocksByFirstMessageId = new Map<string, TimelineCompactionBlock>()
  const coveredMessageIds = new Set<string>()
  for (const block of activeBlocks) {
    const firstMessageId = block.coveredMessageIds[0]
    if (firstMessageId) blocksByFirstMessageId.set(firstMessageId, block)
    for (const messageId of block.coveredMessageIds) {
      coveredMessageIds.add(messageId)
    }
  }

  const projected: Message[] = []
  for (const message of messages) {
    const block = blocksByFirstMessageId.get(message.id)
    if (block) {
      projected.push({
        id: block.id,
        sessionId: block.sessionId,
        role: 'user',
        messageType: 'message',
        content: [{ type: 'text', text: block.summary }],
        createdAt: block.coveredRange.startCreatedAt,
      })
    }
    if (coveredMessageIds.has(message.id)) continue
    projected.push(message)
  }

  return projected
}

function projectTimelineCompactionBlocksForPrompt(
  messages: Message[],
  blocks: TimelineCompactionBlock[],
  sessionId: string,
): Message[] {
  const projected = projectTimelineCompactionBlocks(messages, blocks, sessionId)
  return reducePromptToolOutputs(projected, findTurnBoundaries(projected))
}

function sortTimelineCompactionBlocks(
  blocks: TimelineCompactionBlock[],
): TimelineCompactionBlock[] {
  return [...blocks].sort((left, right) => {
    const time = left.coveredRange.startCreatedAt.localeCompare(right.coveredRange.startCreatedAt)
    return time === 0 ? left.id.localeCompare(right.id) : time
  })
}

function buildTimelineCompactionBlockFromEpisode(params: {
  messages: Message[]
  segment: Message[]
  options: {
    workDir: string
    sessionId: string
  }
  skippedUnfinishedToolUseIds: string[]
  generation?: number
  supersedesBlockIds?: string[]
  strategyOverride?: string
  boundaryReasonOverride?: string
  episode: EpisodeCompaction
  retainedMessages: Message[]
  currentGoal: string
  workingStateSummary: string
  modelOutput: ContextCompactionModelOutput
}): TimelineCompactionBlock {
  const episode = params.episode
  const coveredMessageIds = params.segment.map((message) => message.id)
  const createdAt = now()
  const updatedAt = now()
  const strategyVersion = timelineCompactionStrategyVersion
  const blockId = buildTimelineCompactionBlockId(
    params.options.sessionId,
    coveredMessageIds[0],
    strategyVersion,
    params.generation,
  )
  const evidence = episode.evidence
  const evidenceChars = evidence.reduce((total, item) => total + item.chars, 0)
  const evidenceBytes = evidence.reduce((total, item) => total + item.bytes, 0)
  const promptMessages = buildTimelineCompactionPromptMessages({
    blockId,
    sessionId: params.options.sessionId,
    segment: params.segment,
    episode,
    workingStateSummary: params.workingStateSummary,
    createdAt,
    updatedAt,
    strategyVersion,
    modelOutput: params.modelOutput,
    strategy: params.strategyOverride ?? episode.boundaryStrategy,
    boundaryReason: params.boundaryReasonOverride ?? episode.boundaryReason,
  })

  return {
    id: blockId,
    sessionId: params.options.sessionId,
    status: 'active',
    strategy: params.strategyOverride ?? episode.boundaryStrategy,
    strategyVersion,
    boundaryReason: params.boundaryReasonOverride ?? episode.boundaryReason,
    summary: promptMessages[0].content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n'),
    workingStateSummary: params.workingStateSummary,
    coveredMessageIds,
    coveredRange: {
      startMessageId: params.segment[0]?.id ?? blockId,
      endMessageId: params.segment.at(-1)?.id ?? blockId,
      startCreatedAt: params.segment[0]?.createdAt ?? createdAt,
      endCreatedAt: params.segment.at(-1)?.createdAt ?? updatedAt,
    },
    coveredMessageCount: coveredMessageIds.length,
    toolUseIds: episode.toolUseIds,
    evidence,
    evidenceCount: evidence.length,
    evidenceChars,
    evidenceBytes,
    rawCharsMovedToEvidence: evidenceChars,
    skippedUnfinishedToolUseIds: params.skippedUnfinishedToolUseIds,
    episodeFullRetainTurns: CONTEXT_PARAMS.history.episodeFullRetainTurns,
    promptCharsBefore: stableJsonLength(params.messages),
    promptCharsAfter: stableJsonLength(promptMessages),
    tokensBefore: estimateConversationTokens(params.messages),
    tokensAfter: estimateConversationTokens(promptMessages),
    createdAt,
    updatedAt,
    generation: params.generation ?? 1,
    episodes: [episode],
    topics: params.modelOutput.topics,
    validation: params.modelOutput.validation,
    model: params.modelOutput.model,
    supersedesBlockIds: params.supersedesBlockIds,
  }
}

function buildTimelineCompactionBlockId(
  sessionId: string,
  firstMessageId: string | undefined,
  strategyVersion: string,
  generation = 1,
): string {
  return `timeline_compaction_${hashText(
    `${sessionId}:${firstMessageId ?? 'empty'}:${strategyVersion}:${generation}`,
  ).slice(0, 16)}`
}

/**
 * Deterministic handle trail for a compacted segment: bounded exact handles
 * extracted from the covered raw messages. This survives even when the model
 * summary drops artifact paths/URLs that later turns still need. The segment is
 * scanned newest-first because recent artifacts are the most likely to be
 * reused by upcoming tool calls.
 */
function formatSegmentRetainedHandles(segment: Message[]): string {
  const maxHandles = CONTEXT_PARAMS.history.blockHandleRetentionMaxHandles
  const maxChars = CONTEXT_PARAMS.history.blockHandleRetentionMaxChars
  const handles: string[] = []
  const seen = new Set<string>()
  let keptChars = 0
  const isFull = () => handles.length >= maxHandles || keptChars >= maxChars
  const collect = (text: string) => {
    for (const handle of extractRetainedHandles(text)) {
      if (isFull() || keptChars + handle.length > maxChars) return
      if (seen.has(handle)) continue
      seen.add(handle)
      handles.push(handle)
      keptChars += handle.length + 2
    }
  }
  const blockText = (block: ContentBlock): string => {
    if (block.type === 'tool_use') return JSON.stringify(block.input)
    if (block.type === 'tool_result')
      return [block.outputSummary, block.content].filter(Boolean).join('\n')
    if (block.type === 'text') return block.text
    return ''
  }
  for (let index = segment.length - 1; index >= 0; index--) {
    for (const block of segment[index].content) {
      const text = blockText(block)
      if (text) collect(text)
    }
    if (isFull()) break
  }
  if (handles.length === 0) return ''
  return `retained_handles: ${handles.join(', ')}`
}

function buildTimelineCompactionPromptMessages(params: {
  blockId: string
  sessionId: string
  segment: Message[]
  episode: EpisodeCompaction
  workingStateSummary: string
  createdAt: string
  updatedAt: string
  strategyVersion: string
  modelOutput: ContextCompactionModelOutput
  strategy: string
  boundaryReason: string
}): Message[] {
  const summary = [
    `<timeline_compaction_block id="${params.blockId}" status="${params.episode.status}">`,
    `covered_messages: ${params.segment.length}`,
    `covered_range: ${params.segment[0]?.id ?? 'unknown'}..${params.segment.at(-1)?.id ?? 'unknown'}`,
    `covered_created_at: ${params.segment[0]?.createdAt ?? 'unknown'}..${params.segment.at(-1)?.createdAt ?? 'unknown'}`,
    `generated_at: ${params.updatedAt}`,
    `strategy: ${params.strategy}`,
    `strategy_version: ${params.strategyVersion}`,
    `boundary_reason: ${params.boundaryReason}`,
    params.modelOutput.model?.promptVersion
      ? `prompt_version: ${params.modelOutput.model.promptVersion}`
      : '',
    params.modelOutput.validation
      ? `validation_status: ${params.modelOutput.validation.status}`
      : '',
    params.modelOutput.topics ? `topic_count: ${params.modelOutput.topics.length}` : '',
    'trace: context_compaction timeline_compaction_block',
    formatContextCompactionSummary(params.episode, params.modelOutput),
    formatSegmentRetainedHandles(params.segment),
    'working_state:',
    params.workingStateSummary,
    '</timeline_compaction_block>',
  ].join('\n')

  return [
    {
      id: params.blockId,
      sessionId: params.sessionId,
      role: 'user',
      messageType: 'message',
      content: [{ type: 'text', text: summary }],
      createdAt: params.createdAt,
    },
  ]
}

function buildDeterministicFallbackCompaction(params: {
  sessionId: string
  blockId: string
  strategyVersion: string
  currentGoal: string
  episode: EpisodeCompaction
  workingStateSummary: string
}): ContextCompactionModelOutput {
  const topicStatus = params.episode.status === 'blocked' ? 'blocked' : 'unknown'
  const evidence = params.episode.evidence
    .slice(0, CONTEXT_PARAMS.history.episodePromptEvidenceLimit)
    .map(
      (item) =>
        `${item.toolName}:${item.toolUseId}:${item.kind} path=${item.path} chars=${item.chars}`,
    )
  const fallbackWarning =
    'semantic_compaction_unavailable; deterministic fallback preserved evidence pointers'

  return {
    summary: [
      `Deterministic fallback for ${params.episode.messageIds.length} older messages in ${params.sessionId} because semantic context compaction did not return usable output.`,
      `block_id=${params.blockId} strategy_version=${params.strategyVersion}`,
      params.episode.summary,
    ]
      .filter((item) => item.trim().length > 0)
      .join('\n'),
    topics: [
      {
        id: 'T1',
        title: truncateOneLine(params.episode.goal || 'Compacted historical work', 100),
        status: topicStatus,
        summary: truncateOneLine(params.episode.summary, 1000),
        sourceMessageRefs: [],
        sourceMessageIds: params.episode.messageIds,
        toolRefs: [],
        toolUseIds: params.episode.toolUseIds,
        confirmedFacts: params.episode.confirmedFacts,
        currentState: [
          `current_goal=${truncateOneLine(params.currentGoal || 'unknown', 240)}`,
          'Use retained recent turns as the authoritative high-fidelity context.',
          'Read evidence paths only when exact raw tool IO is needed.',
        ],
        openQuestions: params.episode.blockers,
        nextActions: [
          'Continue from the retained recent turn; do not replay full historical tool IO.',
        ],
        evidence,
        needsRawReview: params.episode.evidence.length > 0,
      },
    ],
    confirmedFacts: params.episode.confirmedFacts,
    currentState: [
      'Semantic compaction was unavailable; this block is an evidence-preserving deterministic fallback.',
      params.workingStateSummary,
    ],
    openQuestions: params.episode.blockers,
    nextActions: ['Continue from retained recent turns.'],
    doNotInfer: [
      'Do not treat this deterministic fallback as a full semantic summary.',
      'Do not claim raw tool output was reviewed unless an evidence path is opened.',
    ],
    keyEvidence: evidence,
    validation: {
      status: 'legacy',
      promptVersion: deterministicFallbackPromptVersion,
      topicCount: 1,
      expectedToolRefs: [],
      coveredToolRefs: [],
      invalidToolRefs: [],
      missingToolRefs: [],
      expectedMessageRefs: [],
      coveredMessageRefs: [],
      invalidMessageRefs: [],
      errors: [],
      warnings: [fallbackWarning],
    },
    model: {
      promptVersion: deterministicFallbackPromptVersion,
      primaryModel: 'local',
      primaryProvider: 'deterministic',
      usedModel: 'deterministic-fallback',
      usedProvider: 'local',
      attempts: 0,
    },
  }
}

function formatContextCompactionSummary(
  episode: EpisodeCompaction,
  modelOutput: ContextCompactionModelOutput,
): string {
  const source =
    modelOutput.model?.usedModel === 'deterministic-fallback' ? 'deterministic_fallback' : 'model'
  const promptEvidence = episode.evidence.slice(
    0,
    CONTEXT_PARAMS.history.episodePromptEvidenceLimit,
  )
  const omittedEvidenceCount = episode.evidence.length - promptEvidence.length
  const lines = [
    `<context_compaction_summary source="${source}">`,
    'summary:',
    modelOutput.summary,
    'topics:',
    ...(modelOutput.topics ?? []).map(
      (topic) =>
        `- ${topic.id} [${topic.status}] ${topic.title}: ${truncateOneLine(topic.summary, 280)}`,
    ),
    'confirmed_facts:',
    ...(modelOutput.confirmedFacts ?? episode.confirmedFacts).map((item) => `- ${item}`),
    'current_state:',
    ...(modelOutput.currentState ?? []).map((item) => `- ${item}`),
    'open_questions_or_blockers:',
    ...(modelOutput.openQuestions ?? episode.blockers).map((item) => `- ${item}`),
    'next_actions:',
    ...(modelOutput.nextActions ?? []).map((item) => `- ${item}`),
    'do_not_infer:',
    ...(modelOutput.doNotInfer ?? []).map((item) => `- ${item}`),
    'key_evidence:',
    ...(modelOutput.keyEvidence ?? episode.needsRawReview).map((item) => `- ${item}`),
    'evidence_manifest:',
    ...promptEvidence.map(
      (item) =>
        `- ${item.toolName}:${item.toolUseId}:${item.kind} path=${item.path} chars=${item.chars} sha256=${item.sha256.slice(0, 12)}`,
    ),
    omittedEvidenceCount > 0
      ? `- omitted_evidence_count=${omittedEvidenceCount} total_evidence_count=${episode.evidence.length}; full manifest remains in artifacts and trace metadata`
      : '',
    '</context_compaction_summary>',
  ]
  return lines.filter((line) => line.trim().length > 0).join('\n')
}

export function sanitizeConversationHistoryForSignedThinkingToolUse(
  messages: Message[],
): Message[] {
  const invalidToolUseIds = new Set<string>()
  const sanitized: Message[] = []

  for (const message of messages) {
    if (
      message.role === 'assistant' &&
      message.content.some((block) => block.type === 'tool_use')
    ) {
      const hasThinking = hasSignedThinkingBlock(message.content)

      if (!hasThinking) {
        const content = message.content.filter((block) => {
          if (block.type === 'thinking') return false
          if (block.type !== 'tool_use') return true
          invalidToolUseIds.add(block.id)
          return false
        })

        if (content.length > 0) {
          sanitized.push({ ...message, content })
        }
        continue
      }
    }

    if (
      invalidToolUseIds.size > 0 &&
      message.role === 'user' &&
      message.content.some(
        (block) => block.type === 'tool_result' && invalidToolUseIds.has(block.toolUseId),
      )
    ) {
      const content = message.content.filter(
        (block) => block.type !== 'tool_result' || !invalidToolUseIds.has(block.toolUseId),
      )
      if (content.length > 0) {
        sanitized.push({ ...message, content })
      }
      continue
    }

    if (
      message.role === 'assistant' &&
      message.content.some((block) => block.type === 'thinking') &&
      !message.content.some((block) => block.type === 'tool_use')
    ) {
      const content = message.content.filter((block) => block.type !== 'thinking')
      if (content.length > 0) {
        sanitized.push({ ...message, content })
      }
      continue
    }

    sanitized.push(message)
  }

  return sanitized.length === messages.length &&
    sanitized.every((message, index) => message === messages[index])
    ? messages
    : sanitized
}

function isMergeableInterleavedToolMessage(message: Message): boolean {
  return (
    message.messageType === 'queued' ||
    (message.messageType === 'control' && message.controlKind === 'background_tool_completed')
  )
}

function toolUseIds(message: Message): string[] {
  if (message.role !== 'assistant') return []
  return message.content.flatMap((block) =>
    block.type === 'tool_use' && block.id ? [block.id] : [],
  )
}

function toolResultIds(message: Message): Set<string> {
  if (message.role !== 'user') return new Set()
  return new Set(
    message.content.flatMap((block) =>
      block.type === 'tool_result' && block.toolUseId ? [block.toolUseId] : [],
    ),
  )
}

/**
 * Reorder persisted history so tool_result carrier messages sit immediately
 * after their assistant tool_use message. Unlike mergeInterleavedQueuedMessages,
 * this preserves queued/control messages as standalone timeline records.
 */
export function repairInterleavedToolResultOrder(messages: Message[]): Message[] {
  if (messages.length < 3) return messages

  let repaired: Message[] | undefined
  const current = () => repaired ?? messages

  for (let i = 0; i < current().length - 1; i++) {
    const assistant = current()[i]
    const ids = toolUseIds(assistant)
    if (ids.length === 0) continue

    const nextIds = toolResultIds(current()[i + 1])
    const missing = ids.filter((id) => !nextIds.has(id))
    if (missing.length === 0) continue

    let matchIndex: number | undefined
    for (let j = i + 1; j < current().length; j++) {
      const candidateIds = toolResultIds(current()[j])
      if (missing.every((id) => candidateIds.has(id))) {
        matchIndex = j
        break
      }
      if (!isMergeableInterleavedToolMessage(current()[j])) {
        break
      }
    }

    if (matchIndex === undefined) continue

    if (!repaired) repaired = [...messages]
    const [toolResult] = repaired.splice(matchIndex, 1)
    if (toolResult) repaired.splice(i + 1, 0, toolResult)
    i++
  }

  return repaired ?? messages
}

/**
 * Merge queued/control messages that sit between an assistant tool_use message
 * and its corresponding user tool_result message. The Anthropic API requires
 * that every assistant message containing tool_use blocks is immediately
 * followed by a user message with the matching tool_result blocks.
 *
 * When a user message or background control event arrives while the agent is
 * executing tools, the session stores it as a standalone message in the
 * history. This can break the tool_use → tool_result pairing. This function
 * detects that pattern and merges the interleaved content into the tool_result
 * message used for the model prompt.
 */
export function mergeInterleavedQueuedMessages(messages: Message[]): Message[] {
  if (messages.length < 3) return messages

  // Phase 1: identify mergeable messages sandwiched between tool_use and tool_result
  const indicesToSkip = new Set<number>()
  const mergeInto = new Map<number, number[]>() // tool_result idx -> interleaved indices

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const ids = toolUseIds(msg)
    if (ids.length === 0) continue

    // Scan forward past messages that are safe to fold into the next tool_result.
    const interleavedIndices: number[] = []
    let j = i + 1
    while (j < messages.length && isMergeableInterleavedToolMessage(messages[j])) {
      interleavedIndices.push(j)
      j++
    }

    if (interleavedIndices.length === 0) continue

    // Check if the next non-queued message is a user message with tool_result
    if (
      j < messages.length &&
      messages[j].role === 'user' &&
      ids.every((id) => toolResultIds(messages[j]).has(id))
    ) {
      for (const qi of interleavedIndices) indicesToSkip.add(qi)
      mergeInto.set(j, interleavedIndices)
    }
  }

  if (indicesToSkip.size === 0) return messages

  // Phase 2: build output — skip standalone queued, merge into tool_result
  const result: Message[] = []
  for (let i = 0; i < messages.length; i++) {
    if (indicesToSkip.has(i)) continue

    if (mergeInto.has(i)) {
      const extraContent: ContentBlock[] = []
      const queuedIndices = mergeInto.get(i) ?? []
      for (const qi of queuedIndices) {
        extraContent.push(...messages[qi].content)
      }
      result.push({ ...messages[i], content: [...messages[i].content, ...extraContent] })
    } else {
      result.push(messages[i])
    }
  }

  return result
}

/**
 * Prepare conversation history with progressive tool output reduction.
 * Mutates tool_result blocks in the input messages array to persist truncation
 * levels across turns for cache-friendly idempotency. Returns a shallow copy
 * of the prepared messages array.
 *
 * Turn counting: each user message with a text block starts a new turn.
 * Turns are numbered from the end: most recent turn = 0.
 *
 * 0-3 turns: full tool output preserved
 * 4-8 turns: tool_result content truncated to ~200 chars summary
 * 9+ turns: tool_result replaced with success/failure status only
 */
export function prepareConversationHistory(
  messages: Message[],
  options: ConversationHistoryOptions = {},
): Message[] {
  const prepared = prepareConversationHistoryBase(messages, options)
  if (!prepared) return []

  if (options.enableEpisodeCompaction && options.evidenceWorkDir) {
    const sessionId = options.sessionId ?? prepared.cleaned[0]?.sessionId ?? 'session'
    return projectTimelineCompactionBlocksForPrompt(
      prepared.cleaned,
      normalizeTimelineCompactionBlocks(options.timelineCompactionBlocks, sessionId),
      sessionId,
    )
  }

  return reducePromptToolOutputs(prepared.cleaned, prepared.turnBoundaries)
}

export async function prepareConversationHistoryWithCompaction(
  messages: Message[],
  options: ConversationHistoryOptions = {},
): Promise<Message[]> {
  const prepared = prepareConversationHistoryBase(messages, options)
  if (!prepared) return []

  if (options.enableEpisodeCompaction && options.evidenceWorkDir) {
    return compactEpisodeHistoryAsync(prepared.cleaned, prepared.turnBoundaries, {
      workDir: options.evidenceWorkDir,
      sessionId: options.sessionId ?? prepared.cleaned[0]?.sessionId ?? 'session',
      timelineCompactionBlocks: options.timelineCompactionBlocks,
      onTimelineCompactionBlocksChanged: options.onTimelineCompactionBlocksChanged,
      onEpisodeCompaction: options.onEpisodeCompaction,
      contextCompactor: options.contextCompactor,
    })
  }

  return reducePromptToolOutputs(prepared.cleaned, prepared.turnBoundaries)
}

async function compactEpisodeHistoryAsync(
  messages: Message[],
  turnBoundaries: number[],
  options: {
    workDir: string
    sessionId: string
    timelineCompactionBlocks?: TimelineCompactionBlock[]
    onTimelineCompactionBlocksChanged?: (blocks: TimelineCompactionBlock[]) => void
    onEpisodeCompaction?: (event: EpisodeCompactionTraceEvent) => void
    contextCompactor?: ContextCompactor
  },
): Promise<Message[]> {
  const plan = planEpisodeCompaction(messages, turnBoundaries, options)
  if (plan.candidateSegments.length === 0) {
    const recompactPlan = planTimelineRecompaction(messages, plan.activeExistingBlocks)
    if (recompactPlan && options.contextCompactor) {
      const recompactBlock = await buildTimelineCompactionBlock({
        messages,
        segment: recompactPlan.segment,
        options,
        skippedUnfinishedToolUseIds: plan.skippedUnfinishedToolUseIds,
        generation: recompactPlan.generation,
        supersedesBlockIds: plan.activeExistingBlocks.map((block) => block.id),
        strategyOverride: TIMELINE_RECOMPACT_STRATEGY,
        boundaryReasonOverride: recompactPlan.reason,
      })
      if (recompactBlock) {
        const supersededBlocks = plan.activeExistingBlocks.map((block) => ({
          ...block,
          status: 'superseded' as const,
          supersededAt: recompactBlock.createdAt,
          updatedAt: recompactBlock.createdAt,
          supersededByBlockId: recompactBlock.id,
        }))
        return finalizeEpisodeCompaction(
          messages,
          options,
          plan.activeExistingBlocks,
          [recompactBlock],
          supersededBlocks,
        )
      }
    }
    return projectTimelineCompactionBlocksForPrompt(
      messages,
      plan.activeExistingBlocks,
      options.sessionId,
    )
  }
  if (!options.contextCompactor) {
    return projectTimelineCompactionBlocksForPrompt(
      messages,
      plan.activeExistingBlocks,
      options.sessionId,
    )
  }

  const createdBlocks: TimelineCompactionBlock[] = []
  for (const segment of plan.candidateSegments) {
    const block = await buildTimelineCompactionBlock({
      messages,
      segment,
      options,
      skippedUnfinishedToolUseIds: plan.skippedUnfinishedToolUseIds,
    })
    if (block) createdBlocks.push(block)
  }

  const recompactPlan = planTimelineRecompaction(messages, [
    ...plan.activeExistingBlocks,
    ...createdBlocks,
  ])
  if (recompactPlan) {
    const recompactBlock = await buildTimelineCompactionBlock({
      messages,
      segment: recompactPlan.segment,
      options,
      skippedUnfinishedToolUseIds: plan.skippedUnfinishedToolUseIds,
      generation: recompactPlan.generation,
      supersedesBlockIds: plan.activeExistingBlocks.map((block) => block.id),
      strategyOverride: TIMELINE_RECOMPACT_STRATEGY,
      boundaryReasonOverride: recompactPlan.reason,
    })
    if (recompactBlock) {
      const supersededBlocks = plan.activeExistingBlocks.map((block) => ({
        ...block,
        status: 'superseded' as const,
        supersededAt: recompactBlock.createdAt,
        updatedAt: recompactBlock.createdAt,
        supersededByBlockId: recompactBlock.id,
      }))
      return finalizeEpisodeCompaction(
        messages,
        options,
        plan.activeExistingBlocks,
        [recompactBlock],
        supersededBlocks,
      )
    }
  }

  return finalizeEpisodeCompaction(messages, options, plan.activeExistingBlocks, createdBlocks, [])
}

function finalizeEpisodeCompaction(
  messages: Message[],
  options: {
    sessionId: string
    timelineCompactionBlocks?: TimelineCompactionBlock[]
    onTimelineCompactionBlocksChanged?: (blocks: TimelineCompactionBlock[]) => void
    onEpisodeCompaction?: (event: EpisodeCompactionTraceEvent) => void
  },
  activeExistingBlocks: TimelineCompactionBlock[],
  createdBlocks: TimelineCompactionBlock[],
  supersededBlocks: TimelineCompactionBlock[] = [],
): Message[] {
  const supersededBlockIds = new Set(supersededBlocks.map((block) => block.id))
  const activeBlocks = sortTimelineCompactionBlocks(
    [...activeExistingBlocks, ...createdBlocks].filter(
      (block) => !supersededBlockIds.has(block.id),
    ),
  )
  const projectedMessages = projectTimelineCompactionBlocksForPrompt(
    messages,
    activeBlocks,
    options.sessionId,
  )
  const replacementBlockIds = new Set([
    ...activeExistingBlocks.map((block) => block.id),
    ...createdBlocks.map((block) => block.id),
    ...supersededBlocks.map((block) => block.id),
  ])
  const nextBlocks = sortTimelineCompactionBlocks([
    ...(options.timelineCompactionBlocks ?? []).filter(
      (block) => !replacementBlockIds.has(block.id),
    ),
    ...supersededBlocks,
    ...activeBlocks,
  ])

  if (createdBlocks.length > 0 || supersededBlocks.length > 0) {
    options.onTimelineCompactionBlocksChanged?.(nextBlocks)
  }

  for (const block of supersededBlocks) {
    options.onEpisodeCompaction?.(
      buildEpisodeCompactionTraceEvent({
        sessionId: options.sessionId,
        lifecycle: 'superseded',
        block,
        messagesBefore: messages,
        messagesAfter: projectedMessages,
      }),
    )
  }

  for (const block of createdBlocks) {
    options.onEpisodeCompaction?.(
      buildEpisodeCompactionTraceEvent({
        sessionId: options.sessionId,
        lifecycle: 'created',
        block,
        messagesBefore: messages,
        messagesAfter: projectedMessages,
      }),
    )
  }

  return projectedMessages
}

interface EpisodeCompactionPlan {
  activeExistingBlocks: TimelineCompactionBlock[]
  candidateSegments: Message[][]
  skippedUnfinishedToolUseIds: string[]
}

interface TimelineRecompactionPlan {
  segment: Message[]
  generation: number
  reason: string
}

function planEpisodeCompaction(
  messages: Message[],
  turnBoundaries: number[],
  options: {
    sessionId: string
    timelineCompactionBlocks?: TimelineCompactionBlock[]
  },
): EpisodeCompactionPlan {
  const activeExistingBlocks = normalizeTimelineCompactionBlocks(
    options.timelineCompactionBlocks,
    options.sessionId,
  )

  if (turnBoundaries.length <= CONTEXT_PARAMS.history.episodeFullRetainTurns + 1) {
    return { activeExistingBlocks, candidateSegments: [], skippedUnfinishedToolUseIds: [] }
  }

  const alreadyCoveredMessageIds = new Set(
    activeExistingBlocks.flatMap((block) => block.coveredMessageIds),
  )
  const turnAgeMap = buildTurnAgeMap(messages, turnBoundaries)
  const compactable = new Set<number>()
  for (let index = 0; index < messages.length; index++) {
    const age = turnAgeMap.get(index) ?? turnBoundaries.length
    if (age <= CONTEXT_PARAMS.history.episodeFullRetainTurns) continue
    if (alreadyCoveredMessageIds.has(messages[index].id)) continue
    compactable.add(index)
  }

  const skippedUnfinishedToolUseIds = removeUnfinishedToolTurns(messages, compactable)
  const candidateSegments = collectCompactableSegments(messages, compactable).filter(
    shouldCompactSegment,
  )

  return { activeExistingBlocks, candidateSegments, skippedUnfinishedToolUseIds }
}

function planTimelineRecompaction(
  messages: Message[],
  activeBlocks: TimelineCompactionBlock[],
): TimelineRecompactionPlan | undefined {
  const sortedBlocks = sortTimelineCompactionBlocks(activeBlocks)
  if (sortedBlocks.length === 0) return undefined

  const projectedMessages = projectTimelineCompactionBlocks(
    messages,
    sortedBlocks,
    messages[0]?.sessionId ?? 'session',
  )
  const projectedChars = stableJsonLength(projectedMessages)
  const isSingleBlock = sortedBlocks.length === 1
  const blockHeavy =
    sortedBlocks.length >= CONTEXT_PARAMS.history.timelineRecompactBlockCountThreshold
  const stillOversized = projectedChars >= CONTEXT_PARAMS.history.timelineRecompactCharsThreshold
  if (!blockHeavy && !stillOversized) return undefined
  if (
    isSingleBlock &&
    sortedBlocks[0]?.boundaryReason.includes(TIMELINE_SINGLE_BLOCK_RECOVERY_MARKER)
  ) {
    return undefined
  }

  const messageIds = new Set(sortedBlocks.flatMap((block) => block.coveredMessageIds))
  const segment = messages.filter((message) => messageIds.has(message.id))
  if (!shouldCompactSegment(segment)) return undefined

  const generation = Math.max(...sortedBlocks.map((block) => block.generation ?? 1)) + 1
  const reason = [
    TIMELINE_RECOMPACT_BOUNDARY_REASON,
    `active_block_count=${sortedBlocks.length}`,
    `projected_chars=${projectedChars}`,
    `threshold_blocks=${CONTEXT_PARAMS.history.timelineRecompactBlockCountThreshold}`,
    `threshold_chars=${CONTEXT_PARAMS.history.timelineRecompactCharsThreshold}`,
    isSingleBlock ? TIMELINE_SINGLE_BLOCK_RECOVERY_MARKER : '',
  ]
    .filter((item) => item.length > 0)
    .join(' ')

  return { segment, generation, reason }
}

function collectCompactableSegments(messages: Message[], compactable: Set<number>): Message[][] {
  const segments: Message[][] = []
  let index = 0

  while (index < messages.length) {
    if (!compactable.has(index)) {
      index++
      continue
    }

    const start = index
    while (index < messages.length && compactable.has(index)) {
      index++
    }
    const segment = messages.slice(start, index)
    if (segment.some((message) => message.content.some(isToolIoBlock))) {
      segments.push(segment)
    }
  }

  return segments
}

function shouldCompactSegment(segment: Message[]): boolean {
  const turnCount = segment.filter(startsTopLevelTurn).length
  const chars = stableJsonLength(segment)
  return (
    segment.some(hasBlockingSignal) ||
    turnCount >= CONTEXT_PARAMS.history.episodeMinCompactTurns ||
    (turnCount >= 2 && chars >= CONTEXT_PARAMS.history.episodeMinCompactChars) ||
    chars >= CONTEXT_PARAMS.history.episodeUrgentCompactChars
  )
}

function hasBlockingSignal(message: Message): boolean {
  return (
    message.taskClosure?.action === 'block' ||
    message.controlKind === 'task_closure' ||
    message.content.some((block) => block.type === 'tool_result' && block.isError)
  )
}

function removeUnfinishedToolTurns(messages: Message[], compactable: Set<number>): string[] {
  const toolUseIds = new Map<string, number>()
  const toolResultIds = new Set<string>()
  const skippedToolUseIds: string[] = []

  for (let index = 0; index < messages.length; index++) {
    for (const block of messages[index].content) {
      if (block.type === 'tool_use') toolUseIds.set(block.id, index)
      if (block.type === 'tool_result') toolResultIds.add(block.toolUseId)
    }
  }

  for (const [toolUseId, messageIndex] of toolUseIds) {
    if (toolResultIds.has(toolUseId)) continue
    const turnStart = findContainingTurnStart(messages, messageIndex)
    const turnEnd = findContainingTurnEnd(messages, turnStart)
    let removedFromCompaction = false
    for (let index = turnStart; index < turnEnd; index++) {
      removedFromCompaction = compactable.delete(index) || removedFromCompaction
    }
    if (removedFromCompaction) skippedToolUseIds.push(toolUseId)
  }

  return skippedToolUseIds
}

function buildEpisodeCompactionTraceEvent(params: {
  sessionId: string
  lifecycle: EpisodeCompactionTraceEvent['lifecycle']
  block: TimelineCompactionBlock
  messagesBefore: Message[]
  messagesAfter: Message[]
}): EpisodeCompactionTraceEvent {
  const evidence = params.block.evidence
  const compactedMessageIds = params.block.coveredMessageIds
  const compactedMessageIdSet = new Set(compactedMessageIds)
  const retainedMessageIds = params.messagesBefore
    .map((message) => message.id)
    .filter((id) => !compactedMessageIdSet.has(id))
  const evidenceWriteStatusCounts = evidence.reduce(
    (counts, item) => {
      if (item.writeStatus === 'created') counts.created++
      else counts.existing++
      return counts
    },
    { created: 0, existing: 0 },
  )

  return {
    event: 'timeline_compaction_block',
    sessionId: params.sessionId,
    lifecycle: params.lifecycle,
    blockId: params.block.id,
    blockStatus: params.block.status,
    blockGeneration: params.block.generation,
    strategy: params.block.strategy,
    boundaryReason: params.block.boundaryReason,
    strategyVersion: params.block.strategyVersion,
    messagesBefore: params.messagesBefore.length,
    messagesAfter: params.messagesAfter.length,
    compactedMessageCount: compactedMessageIds.length,
    retainedMessageCount: retainedMessageIds.length,
    promptCharsBefore: stableJsonLength(params.messagesBefore),
    promptCharsAfter: stableJsonLength(params.messagesAfter),
    tokensBefore: estimateConversationTokens(params.messagesBefore),
    tokensAfter: estimateConversationTokens(params.messagesAfter),
    episodesCreated: params.block.episodes.length,
    workingStateId: `${params.block.id}:working_state`,
    episodeFullRetainTurns: params.block.episodeFullRetainTurns,
    skippedUnfinishedToolUseIds: params.block.skippedUnfinishedToolUseIds,
    compactedMessageIds,
    retainedMessageIds,
    toolUseIds: params.block.toolUseIds,
    evidenceCount: params.block.evidenceCount,
    evidenceChars: params.block.evidenceChars,
    evidenceBytes: params.block.evidenceBytes,
    rawCharsMovedToEvidence: params.block.rawCharsMovedToEvidence,
    coveredRange: params.block.coveredRange,
    coveredMessageIds: params.block.coveredMessageIds,
    evidenceWriteStatusCounts,
    evidence,
    episodes: params.block.episodes.map((episode) => ({
      id: episode.id,
      status: episode.status,
      goal: episode.goal,
      scope: episode.scope,
      messageIds: episode.messageIds,
      toolUseIds: episode.toolUseIds,
      evidenceCount: episode.evidence.length,
      evidenceChars: episode.evidence.reduce((total, item) => total + item.chars, 0),
      evidenceBytes: episode.evidence.reduce((total, item) => total + item.bytes, 0),
      blockerCount: episode.blockers.length,
    })),
    topicCount: params.block.topics?.length,
    validationStatus: params.block.validation?.status,
    validationErrors: params.block.validation?.errors,
    validationWarnings: params.block.validation?.warnings,
    model: params.block.model?.usedModel,
    provider: params.block.model?.usedProvider,
    promptVersion: params.block.model?.promptVersion,
    modelAttempts: params.block.model?.attempts,
    supersedesBlockIds: params.block.supersedesBlockIds,
    supersededByBlockId: params.block.supersededByBlockId,
  }
}

function prepareConversationHistoryBase(
  messages: Message[],
  options: ConversationHistoryOptions,
): { cleaned: Message[]; turnBoundaries: number[] } | undefined {
  if (messages.length === 0) return undefined

  const promptHistory = messages.filter((message) => message.messageType !== 'notification')

  // Merge queued messages that break tool_use → tool_result pairing
  const paired = mergeInterleavedQueuedMessages(promptHistory)
  const cleaned = options.requireThinkingForToolUse
    ? sanitizeConversationHistoryForSignedThinkingToolUse(paired)
    : paired

  const turnBoundaries = findTurnBoundaries(cleaned)
  return { cleaned, turnBoundaries }
}
