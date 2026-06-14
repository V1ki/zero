import type { Message, TimelineCompactionBlock } from '@zero-os/shared'
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
