import type { Message, Session as SessionData } from '@zero-os/shared'
import { Mutex, generateId, now } from '@zero-os/shared'
import type { QueuedMessage } from '../agent/queue'
import { type SessionImageAttachment, createUserMessage } from './session-messages'

export class SessionTurnRuntime {
  private mutex = new Mutex()
  private interruptFlag = false
  private messageQueue: QueuedMessage[] = []
  private nextTurnIndex: number

  constructor(options: { nextTurnIndex?: number } = {}) {
    this.nextTurnIndex = options.nextTurnIndex ?? 1
  }

  isTurnInProgress(): boolean {
    return this.mutex.isLocked()
  }

  waitForTurnComplete(): Promise<void> {
    return this.mutex.waitForUnlock()
  }

  async acquireTurn(lockId = generateId()): Promise<string> {
    await this.mutex.acquire(lockId)
    this.interruptFlag = false
    return lockId
  }

  releaseTurn(lockId: string): void {
    this.mutex.release(lockId)
  }

  queueMessage(options: {
    content: string
    images?: SessionImageAttachment[]
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
    const timestamp = now()
    this.messageQueue.push({
      content: options.content,
      images: options.images,
      timestamp,
      onApplied: options.onApplied,
    })
    options.messages.push(
      createUserMessage({
        sessionId: options.data.id,
        text: options.content,
        createdAt: timestamp,
        images: options.images,
        messageType: 'queued',
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

  drainQueuedMessages(): QueuedMessage[] {
    const messages = [...this.messageQueue]
    this.messageQueue.length = 0
    this.interruptFlag = false
    return messages
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
