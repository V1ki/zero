import type { Message, MessageChannelSource, Session as SessionData } from '@zero-os/shared'
import { Mutex, now as currentTimestamp, generateId } from '@zero-os/shared'
import type { QueuedMessage } from '../agent/queue'
import { type SessionImageAttachment, createUserMessage } from './session-messages'

export interface SessionTurnHealth {
  readonly inProgress: boolean
  readonly startedAt: number | null
  readonly lastProgressAt: number | null
  readonly idleForMs: number
  readonly queueDepth: number
  readonly interruptRequested: boolean
}

export class SessionTurnRuntime {
  private mutex = new Mutex()
  private interruptFlag = false
  private abortFlag = false
  private messageQueue: QueuedMessage[] = []
  private nextTurnIndex: number
  private readonly now: () => number
  private startedAt: number | null = null
  private lastProgressAt: number | null = null

  constructor(options: { nextTurnIndex?: number; now?: () => number } = {}) {
    this.nextTurnIndex = options.nextTurnIndex ?? 1
    this.now = options.now ?? Date.now
  }

  isTurnInProgress(): boolean {
    return this.mutex.isLocked()
  }

  waitForTurnComplete(): Promise<void> {
    return this.mutex.waitForUnlock()
  }

  async acquireTurn(lockId = generateId()): Promise<string> {
    await this.mutex.acquire(lockId)
    const acquiredAt = this.now()
    this.startedAt = acquiredAt
    this.lastProgressAt = acquiredAt
    this.interruptFlag = this.messageQueue.length > 0
    this.abortFlag = false
    return lockId
  }

  releaseTurn(lockId: string): void {
    this.mutex.release(lockId)
    this.startedAt = null
    this.lastProgressAt = null
  }

  markProgress(): void {
    if (!this.isTurnInProgress()) return
    this.lastProgressAt = this.now()
  }

  getHealth(): Readonly<SessionTurnHealth> {
    const inProgress = this.isTurnInProgress()
    const observedAt = this.now()
    const lastProgressAt = inProgress ? this.lastProgressAt : null

    return Object.freeze({
      inProgress,
      startedAt: inProgress ? this.startedAt : null,
      lastProgressAt,
      idleForMs:
        inProgress && lastProgressAt !== null ? Math.max(0, observedAt - lastProgressAt) : 0,
      queueDepth: this.messageQueue.length,
      interruptRequested: this.interruptFlag,
    })
  }

  isStalled(idleTimeoutMs: number): boolean {
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 0) return false
    const health = this.getHealth()
    return health.inProgress && health.idleForMs >= idleTimeoutMs
  }

  queueMessage(options: {
    content: string
    images?: SessionImageAttachment[]
    source?: MessageChannelSource
    messageType?: Message['messageType']
    controlKind?: Message['controlKind']
    messages: Message[]
    data: SessionData
    persistState(): void
    emitSessionUpdate(event: {
      sessionId: string
      event: string
      messageCount: number
      queuedMessageId?: string
    }): void
    onApplied?: () => void
  }): void {
    const timestamp = currentTimestamp()
    this.messageQueue.push({
      content: options.content,
      images: options.images,
      source: options.source,
      timestamp,
      onApplied: options.onApplied,
    })
    options.messages.push(
      createUserMessage({
        sessionId: options.data.id,
        text: options.content,
        createdAt: timestamp,
        images: options.images,
        source: options.source,
        messageType: options.messageType ?? 'queued',
        controlKind: options.controlKind,
      }),
    )
    options.data.updatedAt = timestamp
    options.persistState()
    options.emitSessionUpdate?.({
      sessionId: options.data.id,
      event: 'message_queued',
      messageCount: options.messages.length,
    })
    this.interruptFlag = true
  }

  shouldInterrupt(): boolean {
    return this.interruptFlag
  }

  requestAbort(): boolean {
    if (!this.isTurnInProgress()) return false
    this.abortFlag = true
    return true
  }

  shouldAbort(): boolean {
    return this.abortFlag
  }

  drainQueuedMessages(): QueuedMessage[] {
    const messages = [...this.messageQueue]
    this.messageQueue.length = 0
    this.interruptFlag = false
    return messages
  }

  removeQueuedMessagesBySource(source: MessageChannelSource): number {
    const before = this.messageQueue.length
    const nextQueue = this.messageQueue.filter(
      (message) => !matchesMessageSource(message.source, source),
    )
    this.messageQueue = nextQueue
    if (before !== nextQueue.length) {
      this.interruptFlag = nextQueue.length > 0
    }
    return before - nextQueue.length
  }

  allocateTurnIndex(): number {
    const turnIndex = this.nextTurnIndex
    this.nextTurnIndex += 1
    return turnIndex
  }

  getLeakState(): { queueLength: number; interruptFlag: boolean } {
    return {
      queueLength: this.messageQueue.length,
      interruptFlag: this.interruptFlag,
    }
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
