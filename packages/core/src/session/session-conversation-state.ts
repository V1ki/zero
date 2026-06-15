import type { Message, MessageChannelSource, TimelineCompactionBlock } from '@zero-os/shared'
import {
  type SessionTailRollbackRemovedMessage,
  summarizeRollbackMessage,
} from './session-messages'

export interface SessionTailRollbackResult {
  ok: boolean
  status: 'ok' | 'invalid_count' | 'turn_in_progress'
  dryRun: boolean
  requestedCount: number
  beforeCount: number
  afterCount: number
  removed: SessionTailRollbackRemovedMessage[]
  reason?: string
  error?: string
}

export interface SessionMessageRecallResult {
  matched: boolean
  changed: boolean
  status: 'not_found' | 'recalled' | 'already_recalled'
  messageId?: string
  previousMessageType?: Message['messageType']
}

export class SessionConversationState {
  readonly messages: Message[]
  readonly injectedMemoryIds: Map<string, string>

  private compactionBlocks: TimelineCompactionBlock[]

  constructor(
    options: {
      messages?: Message[]
      timelineCompactionBlocks?: TimelineCompactionBlock[]
      injectedMemoryIds?: Map<string, string>
    } = {},
  ) {
    this.messages = options.messages ?? []
    this.compactionBlocks = options.timelineCompactionBlocks ?? []
    this.injectedMemoryIds = options.injectedMemoryIds ?? new Map<string, string>()
  }

  get timelineCompactionBlocks(): TimelineCompactionBlock[] {
    return this.compactionBlocks
  }

  get messageCount(): number {
    return this.messages.length
  }

  replaceTimelineCompactionBlocks(blocks: TimelineCompactionBlock[]): void {
    this.compactionBlocks = blocks
  }

  markExternalMessageRecalled(options: {
    source: MessageChannelSource
    recalledAt: string
    recallType?: string
  }): SessionMessageRecallResult {
    const message = this.messages.find((candidate) =>
      matchesMessageSource(candidate.source, options.source),
    )
    if (!message) {
      return {
        matched: false,
        changed: false,
        status: 'not_found',
      }
    }

    if (message.recalled) {
      return {
        matched: true,
        changed: false,
        status: 'already_recalled',
        messageId: message.id,
        previousMessageType: message.messageType,
      }
    }

    const previousMessageType = message.messageType
    message.messageType = 'notification'
    message.recalled = {
      externalMessageId: options.source.messageId ?? '',
      recalledAt: options.recalledAt,
      ...(options.recallType ? { recallType: options.recallType } : {}),
    }
    message.content = [{ type: 'text', text: '用户已撤回这条消息。' }]

    return {
      matched: true,
      changed: true,
      status: 'recalled',
      messageId: message.id,
      previousMessageType,
    }
  }

  rollbackTailMessages(options: {
    count: number
    dryRun?: boolean
    reason?: string
    isTurnInProgress(): boolean
    onApplied?: (event: { removeCount: number; reason?: string }) => void
  }): SessionTailRollbackResult {
    const requestedCount = Math.trunc(options.count)
    const beforeCount = this.messages.length
    const dryRun = options.dryRun ?? true
    const reason = options.reason?.trim() || undefined

    if (
      !Number.isFinite(options.count) ||
      !Number.isInteger(options.count) ||
      requestedCount <= 0
    ) {
      return {
        ok: false,
        status: 'invalid_count',
        dryRun,
        requestedCount: options.count,
        beforeCount,
        afterCount: beforeCount,
        removed: [],
        reason,
        error: 'count must be a positive integer',
      }
    }

    if (options.isTurnInProgress()) {
      return {
        ok: false,
        status: 'turn_in_progress',
        dryRun,
        requestedCount,
        beforeCount,
        afterCount: beforeCount,
        removed: [],
        reason,
        error: 'session has a turn in progress',
      }
    }

    const removeCount = Math.min(requestedCount, beforeCount)
    const startIndex = beforeCount - removeCount
    const removed = this.messages
      .slice(startIndex)
      .map((message, offset) => summarizeRollbackMessage(message, startIndex + offset))
    const afterCount = beforeCount - removeCount

    if (!dryRun && removeCount > 0) {
      this.messages.length = afterCount
      options.onApplied?.({ removeCount, reason })
    }

    return {
      ok: true,
      status: 'ok',
      dryRun,
      requestedCount,
      beforeCount,
      afterCount,
      removed,
      reason,
    }
  }

  getMessagesSnapshot(): Message[] {
    return [...this.messages]
  }

  getTimelineCompactionBlocksSnapshot(): TimelineCompactionBlock[] {
    return [...this.compactionBlocks]
  }
}

function matchesMessageSource(
  candidate: MessageChannelSource | undefined,
  expected: MessageChannelSource,
): boolean {
  if (!candidate?.messageId || !expected.messageId) return false
  if (String(candidate.messageId) !== String(expected.messageId)) return false
  if (candidate.channelType !== expected.channelType) return false
  if (expected.channelName && candidate.channelName !== expected.channelName) return false
  if (expected.channelId && candidate.channelId !== expected.channelId) return false
  return true
}
