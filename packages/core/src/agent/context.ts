import { createHash } from 'node:crypto'
import type {
  ContentBlock,
  EpisodeCompaction,
  Message,
  TimelineCompactionBlock,
  TimelineCompactionBlockLifecycle,
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

/**
 * Merge queued messages that sit between an assistant tool_use message and
 * its corresponding user tool_result message. The Anthropic API requires
 * that every assistant message containing tool_use blocks is immediately
 * followed by a user message with the matching tool_result blocks.
 *
 * When a user message arrives while the agent is executing tools, the session
 * stores it as a standalone 'queued' message in the history. This can break
 * the tool_use → tool_result pairing. This function detects that pattern and
 * merges the queued content into the tool_result message.
 */
export function mergeInterleavedQueuedMessages(messages: Message[]): Message[] {
  if (messages.length < 3) return messages

  // Phase 1: identify queued messages sandwiched between tool_use and tool_result
  const indicesToSkip = new Set<number>()
  const mergeInto = new Map<number, number[]>() // tool_result idx → queued indices

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'assistant' || !msg.content.some((b) => b.type === 'tool_use')) {
      continue
    }

    // Scan forward past queued messages
    const queuedIndices: number[] = []
    let j = i + 1
    while (j < messages.length && messages[j].messageType === 'queued') {
      queuedIndices.push(j)
      j++
    }

    if (queuedIndices.length === 0) continue

    // Check if the next non-queued message is a user message with tool_result
    if (
      j < messages.length &&
      messages[j].role === 'user' &&
      messages[j].content.some((b) => b.type === 'tool_result')
    ) {
      for (const qi of queuedIndices) indicesToSkip.add(qi)
      mergeInto.set(j, queuedIndices)
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
    return projectTimelineCompactionBlocks(
      prepared.cleaned,
      normalizeTimelineCompactionBlocks(options.timelineCompactionBlocks, sessionId),
      sessionId,
    )
  }

  return reduceHistoricalToolOutput(prepared.cleaned, prepared.turnBoundaries)
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

  return reduceHistoricalToolOutput(prepared.cleaned, prepared.turnBoundaries)
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

function reduceHistoricalToolOutput(messages: Message[], turnBoundaries: number[]): Message[] {
  // Assign turn indices by scanning from the end
  const turnAgeMap = buildTurnAgeMap(messages, turnBoundaries)
  // turnBoundaries[0] = most recent user text message index (turn 0)

  return messages.map((msg, idx) => {
    if (msg.role !== 'user') return msg
    const hasToolResult = msg.content.some((b) => b.type === 'tool_result')
    if (!hasToolResult) return msg

    const age = turnAgeMap.get(idx) ?? turnBoundaries.length
    const newContent = msg.content.map((block) => {
      if (block.type !== 'tool_result') return block

      // Already at maximum truncation — never re-process
      if (block.truncationLevel === 'status') return block

      // Recent turns: mark as full, no truncation
      if (age <= CONTEXT_PARAMS.history.fullRetainTurns) {
        if (!block.truncationLevel) block.truncationLevel = 'full'
        return block
      }

      // Already summarized and still in summary range — skip
      if (block.truncationLevel === 'summary' && age <= CONTEXT_PARAMS.history.summaryRetainTurns) {
        return block
      }

      // Needs summary truncation
      if (age <= CONTEXT_PARAMS.history.summaryRetainTurns) {
        const summarized = summarizeToolResult(block)
        block.content = summarized.content
        block.contentItems = undefined
        block.truncationLevel = 'summary'
        return block
      }

      // Needs status-only truncation
      const statusOnly = statusOnlyToolResult(block)
      block.content = statusOnly.content
      block.contentItems = undefined
      block.truncationLevel = 'status'
      return block
    })

    return { ...msg, content: newContent }
  })
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
  // Build a map: message index -> turn age (distance from most recent turn)
  const turnAgeMap = new Map<number, number>()
  for (let t = 0; t < turnBoundaries.length; t++) {
    const startIdx = turnBoundaries[t]
    const endIdx = t === 0 ? messages.length : turnBoundaries[t - 1]
    for (let i = startIdx; i < endIdx; i++) {
      turnAgeMap.set(i, t)
    }
  }
  // Messages before the oldest identified turn get max age
  if (turnBoundaries.length > 0) {
    const oldestTurnStart = turnBoundaries[turnBoundaries.length - 1]
    for (let i = 0; i < oldestTurnStart; i++) {
      turnAgeMap.set(i, turnBoundaries.length)
    }
  }

  return turnAgeMap
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
    return projectTimelineCompactionBlocks(messages, plan.activeExistingBlocks, options.sessionId)
  }
  if (!options.contextCompactor) {
    return projectTimelineCompactionBlocks(messages, plan.activeExistingBlocks, options.sessionId)
  }

  const createdBlocks: TimelineCompactionBlock[] = []
  for (const segment of plan.candidateSegments) {
    const block = await buildTimelineCompactionBlockAsync({
      messages,
      segment,
      options,
      skippedUnfinishedToolUseIds: plan.skippedUnfinishedToolUseIds,
    })
    if (block) createdBlocks.push(block)
  }

  return finalizeEpisodeCompaction(messages, options, plan.activeExistingBlocks, createdBlocks)
}

function planEpisodeCompaction(
  messages: Message[],
  turnBoundaries: number[],
  options: {
    sessionId: string
    timelineCompactionBlocks?: TimelineCompactionBlock[]
  },
): {
  activeExistingBlocks: TimelineCompactionBlock[]
  candidateSegments: Message[][]
  skippedUnfinishedToolUseIds: string[]
} {
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
): Message[] {
  const activeBlocks = sortTimelineCompactionBlocks([...activeExistingBlocks, ...createdBlocks])
  const projectedMessages = projectTimelineCompactionBlocks(
    messages,
    activeBlocks,
    options.sessionId,
  )
  const activeExistingBlockIds = new Set(activeExistingBlocks.map((block) => block.id))
  const nextBlocks = sortTimelineCompactionBlocks([
    ...(options.timelineCompactionBlocks ?? []).filter(
      (block) => !activeExistingBlockIds.has(block.id),
    ),
    ...activeBlocks,
  ])

  if (createdBlocks.length > 0) {
    options.onTimelineCompactionBlocksChanged?.(nextBlocks)
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
  return (
    segment.some(hasBlockingSignal) ||
    turnCount >= CONTEXT_PARAMS.history.episodeMinCompactTurns ||
    stableJsonLength(segment) >= CONTEXT_PARAMS.history.episodeMinCompactChars
  )
}

function hasBlockingSignal(message: Message): boolean {
  return (
    message.taskClosure?.action === 'block' ||
    message.controlKind === 'task_closure' ||
    message.content.some((block) => block.type === 'tool_result' && block.isError)
  )
}

function normalizeTimelineCompactionBlocks(
  blocks: TimelineCompactionBlock[] | undefined,
  sessionId: string,
): TimelineCompactionBlock[] {
  return sortTimelineCompactionBlocks(
    (blocks ?? []).filter((block) => block.sessionId === sessionId && block.status === 'active'),
  )
}

async function buildTimelineCompactionBlockAsync(params: {
  messages: Message[]
  segment: Message[]
  options: {
    workDir: string
    sessionId: string
    contextCompactor?: ContextCompactor
  }
  skippedUnfinishedToolUseIds: string[]
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
  const strategyVersion = 'timeline_compaction_block_v2'
  const blockId = buildTimelineCompactionBlockId(
    params.options.sessionId,
    coveredMessageIds[0],
    strategyVersion,
  )
  const modelOutput = await params.options.contextCompactor?.({
    sessionId: params.options.sessionId,
    blockId,
    strategyVersion,
    currentGoal,
    segment: params.segment,
    retainedMessages,
    episode,
    workingStateSummary,
  })
  if (!modelOutput) return undefined

  return buildTimelineCompactionBlockFromEpisode({
    ...params,
    episode,
    retainedMessages,
    currentGoal,
    workingStateSummary,
    modelOutput,
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
  const strategyVersion = 'timeline_compaction_block_v2'
  const blockId = buildTimelineCompactionBlockId(
    params.options.sessionId,
    coveredMessageIds[0],
    strategyVersion,
  )
  const evidence = episode.evidence
  const evidenceChars = evidence.reduce((total, item) => total + item.chars, 0)
  const evidenceBytes = evidence.reduce((total, item) => total + item.bytes, 0)
  const promptMessages = buildTimelineCompactionPromptMessages(
    blockId,
    params.options.sessionId,
    params.segment,
    episode,
    params.workingStateSummary,
    createdAt,
    updatedAt,
    strategyVersion,
    params.modelOutput,
  )

  return {
    id: blockId,
    sessionId: params.options.sessionId,
    status: 'active',
    strategy: episode.boundaryStrategy,
    strategyVersion,
    boundaryReason: episode.boundaryReason,
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
    generation: 1,
    episodes: [episode],
  }
}

function buildTimelineCompactionBlockId(
  sessionId: string,
  firstMessageId: string | undefined,
  strategyVersion: string,
): string {
  return `timeline_compaction_${hashText(
    `${sessionId}:${firstMessageId ?? 'empty'}:${strategyVersion}`,
  ).slice(0, 16)}`
}

function buildTimelineCompactionPromptMessages(
  blockId: string,
  sessionId: string,
  segment: Message[],
  episode: EpisodeCompaction,
  workingStateSummary: string,
  createdAt: string,
  updatedAt: string,
  strategyVersion: string,
  modelOutput: ContextCompactionModelOutput,
): Message[] {
  const summary = [
    `<timeline_compaction_block id="${blockId}" status="${episode.status}">`,
    `covered_messages: ${segment.length}`,
    `covered_range: ${segment[0]?.id ?? 'unknown'}..${segment.at(-1)?.id ?? 'unknown'}`,
    `covered_created_at: ${segment[0]?.createdAt ?? 'unknown'}..${segment.at(-1)?.createdAt ?? 'unknown'}`,
    `generated_at: ${updatedAt}`,
    `strategy: ${episode.boundaryStrategy}`,
    `strategy_version: ${strategyVersion}`,
    `boundary_reason: ${episode.boundaryReason}`,
    'trace: context_compaction timeline_compaction_block',
    formatContextCompactionSummary(episode, modelOutput),
    'working_state:',
    workingStateSummary,
    '</timeline_compaction_block>',
  ].join('\n')

  return [
    {
      id: blockId,
      sessionId,
      role: 'user',
      messageType: 'message',
      content: [{ type: 'text', text: summary }],
      createdAt,
    },
  ]
}

function formatContextCompactionSummary(
  episode: EpisodeCompaction,
  modelOutput: ContextCompactionModelOutput,
): string {
  const facts = modelOutput.confirmedFacts ?? []
  const blockers = modelOutput.openQuestions ?? episode.blockers
  return [
    '<context_compaction_summary source="model">',
    'summary:',
    modelOutput.summary.trim(),
    'confirmed_facts:',
    ...formatPromptList(facts, 8),
    'user_constraints:',
    ...formatPromptList(modelOutput.userConstraints ?? [], 8),
    'decisions:',
    ...formatPromptList(modelOutput.decisions ?? [], 8),
    'current_state:',
    ...formatPromptList(modelOutput.currentState ?? [], 8),
    'open_questions_or_blockers:',
    ...formatPromptList(blockers, 6),
    'next_actions:',
    ...formatPromptList(modelOutput.nextActions ?? [], 6),
    'do_not_infer:',
    ...formatPromptList(modelOutput.doNotInfer ?? [], 6),
    'key_evidence:',
    ...formatPromptList(modelOutput.keyEvidence ?? [], 10),
    'evidence_manifest:',
    ...formatEvidenceManifest(episode),
    '</context_compaction_summary>',
  ].join('\n')
}

function formatEvidenceManifest(episode: EpisodeCompaction): string[] {
  const limit = CONTEXT_PARAMS.history.episodePromptEvidenceLimit
  const items = episode.evidence
    .slice(0, limit)
    .map(
      (item) =>
        `- ${item.toolName}:${item.toolUseId}:${item.kind} path=${item.path} chars=${item.chars} sha256=${item.sha256.slice(0, 12)} summary=${truncateOneLine(item.summary ?? 'captured', 140)}`,
    )
  const omitted = episode.evidence.length - items.length
  if (omitted > 0) items.push(`- omitted_evidence_count=${omitted}`)
  return items.length > 0 ? items : ['- none']
}

function formatPromptList(items: string[], limit: number): string[] {
  const formatted = items
    .map((item) => truncateOneLine(item, 260))
    .filter((item) => item.length > 0)
    .slice(0, limit)
    .map((item) => `- ${item}`)
  const omitted = items.length - formatted.length
  if (omitted > 0) formatted.push(`- omitted_count=${omitted}`)
  return formatted.length > 0 ? formatted : ['- none']
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

function sortTimelineCompactionBlocks(
  blocks: TimelineCompactionBlock[],
): TimelineCompactionBlock[] {
  return [...blocks].sort((left, right) => {
    const time = left.coveredRange.startCreatedAt.localeCompare(right.coveredRange.startCreatedAt)
    return time === 0 ? left.id.localeCompare(right.id) : time
  })
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
  lifecycle: TimelineCompactionBlockLifecycle
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
  }
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

function summarizeToolResult(block: ToolResultBlock): ToolResultBlock {
  const summary =
    block.outputSummary ?? block.content.slice(0, CONTEXT_PARAMS.history.summaryMaxChars)
  const truncated = summary.length < block.content.length ? `${summary}...` : summary
  return { ...block, content: truncated, contentItems: undefined, truncationLevel: 'summary' }
}

function statusOnlyToolResult(block: ToolResultBlock): ToolResultBlock {
  if (block.isError) {
    const errorSnippet = block.content.slice(0, 100)
    return {
      ...block,
      content: `\u2717 failed: ${errorSnippet}`,
      contentItems: undefined,
      truncationLevel: 'status',
    }
  }
  return { ...block, content: '\u2713 success', contentItems: undefined, truncationLevel: 'status' }
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
