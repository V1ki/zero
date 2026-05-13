import type {
  ContentBlock,
  EpisodeCompaction,
  Message,
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
  onEpisodeCompaction?: (event: EpisodeCompactionTraceEvent) => void
}

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
  event: 'episode_compaction'
  sessionId: string
  strategy: string
  boundaryReason: string
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
  if (messages.length === 0) return []

  const promptHistory = messages.filter((message) => message.messageType !== 'notification')

  // Merge queued messages that break tool_use → tool_result pairing
  const paired = mergeInterleavedQueuedMessages(promptHistory)
  const cleaned = options.requireThinkingForToolUse
    ? sanitizeConversationHistoryForSignedThinkingToolUse(paired)
    : paired

  const turnBoundaries = findTurnBoundaries(cleaned)
  if (options.enableEpisodeCompaction && options.evidenceWorkDir) {
    return compactEpisodeHistory(cleaned, turnBoundaries, {
      workDir: options.evidenceWorkDir,
      sessionId: options.sessionId ?? cleaned[0]?.sessionId ?? 'session',
      onEpisodeCompaction: options.onEpisodeCompaction,
    })
  }

  // Assign turn indices by scanning from the end
  const turnAgeMap = buildTurnAgeMap(cleaned, turnBoundaries)
  // turnBoundaries[0] = most recent user text message index (turn 0)

  return cleaned.map((msg, idx) => {
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

function compactEpisodeHistory(
  messages: Message[],
  turnBoundaries: number[],
  options: {
    workDir: string
    sessionId: string
    onEpisodeCompaction?: (event: EpisodeCompactionTraceEvent) => void
  },
): Message[] {
  if (turnBoundaries.length <= CONTEXT_PARAMS.history.episodeFullRetainTurns + 1) {
    return messages
  }

  const turnAgeMap = buildTurnAgeMap(messages, turnBoundaries)
  const compactable = new Set<number>()
  for (let index = 0; index < messages.length; index++) {
    const age = turnAgeMap.get(index) ?? turnBoundaries.length
    if (age <= CONTEXT_PARAMS.history.episodeFullRetainTurns) continue
    compactable.add(index)
  }

  const skippedUnfinishedToolUseIds = removeUnfinishedToolTurns(messages, compactable)

  const result: Message[] = []
  const episodes: EpisodeCompaction[] = []
  let index = 0
  while (index < messages.length) {
    if (!compactable.has(index)) {
      result.push(messages[index])
      index++
      continue
    }

    const start = index
    while (index < messages.length && compactable.has(index)) {
      index++
    }
    const episodeMessages = messages.slice(start, index)
    if (!episodeMessages.some((message) => message.content.some(isToolIoBlock))) {
      result.push(...episodeMessages)
      continue
    }

    const episode = buildEpisodeCompaction(episodeMessages, options)
    episodes.push(episode)
    result.push({
      id: episode.id,
      sessionId: options.sessionId,
      role: 'user',
      messageType: 'message',
      content: [{ type: 'text', text: episode.summary }],
      createdAt: episodeMessages[0]?.createdAt ?? now(),
    })
  }

  if (episodes.length === 0) {
    return messages
  }

  const workingState = buildWorkingStateCompaction({
    currentGoal: extractCurrentGoal(messages),
    retainedMessages: result,
    episodes,
  })
  const workingStateId = `working_state_${episodes
    .map((episode) => episode.id.replace(/^episode_/, ''))
    .join('_')}`
  const firstRetainedIndex = result.findIndex((message) => !message.id.startsWith('episode_'))
  const workingStateMessage: Message = {
    id: workingStateId,
    sessionId: options.sessionId,
    role: 'user',
    messageType: 'message',
    content: [{ type: 'text', text: formatWorkingState(workingState) }],
    createdAt: now(),
  }

  const compactedMessages =
    firstRetainedIndex < 0
      ? [...result, workingStateMessage]
      : [
          ...result.slice(0, firstRetainedIndex),
          workingStateMessage,
          ...result.slice(firstRetainedIndex),
        ]

  options.onEpisodeCompaction?.(
    buildEpisodeCompactionTraceEvent({
      sessionId: options.sessionId,
      messagesBefore: messages,
      messagesAfter: compactedMessages,
      episodes,
      workingStateId,
      skippedUnfinishedToolUseIds,
    }),
  )

  return compactedMessages
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
  messagesBefore: Message[]
  messagesAfter: Message[]
  episodes: EpisodeCompaction[]
  workingStateId: string
  skippedUnfinishedToolUseIds: string[]
}): EpisodeCompactionTraceEvent {
  const evidence = params.episodes.flatMap((episode) => episode.evidence)
  const compactedMessageIds = params.episodes.flatMap((episode) => episode.messageIds)
  const compactedMessageIdSet = new Set(compactedMessageIds)
  const retainedMessageIds = params.messagesBefore
    .map((message) => message.id)
    .filter((id) => !compactedMessageIdSet.has(id))
  const evidenceChars = evidence.reduce((total, item) => total + item.chars, 0)
  const evidenceBytes = evidence.reduce((total, item) => total + item.bytes, 0)

  return {
    event: 'episode_compaction',
    sessionId: params.sessionId,
    strategy: params.episodes[0]?.boundaryStrategy ?? 'none',
    boundaryReason: params.episodes[0]?.boundaryReason ?? 'No episode compaction was produced.',
    messagesBefore: params.messagesBefore.length,
    messagesAfter: params.messagesAfter.length,
    compactedMessageCount: compactedMessageIds.length,
    retainedMessageCount: retainedMessageIds.length,
    promptCharsBefore: stableJsonLength(params.messagesBefore),
    promptCharsAfter: stableJsonLength(params.messagesAfter),
    tokensBefore: estimateConversationTokens(params.messagesBefore),
    tokensAfter: estimateConversationTokens(params.messagesAfter),
    episodesCreated: params.episodes.length,
    workingStateId: params.workingStateId,
    episodeFullRetainTurns: CONTEXT_PARAMS.history.episodeFullRetainTurns,
    skippedUnfinishedToolUseIds: params.skippedUnfinishedToolUseIds,
    compactedMessageIds,
    retainedMessageIds,
    toolUseIds: params.episodes.flatMap((episode) => episode.toolUseIds),
    evidenceCount: evidence.length,
    evidenceChars,
    evidenceBytes,
    rawCharsMovedToEvidence: evidenceChars,
    evidence,
    episodes: params.episodes.map((episode) => ({
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

function stableJsonLength(value: unknown): number {
  return JSON.stringify(value).length
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
