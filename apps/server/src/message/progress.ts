import { type Message, describeError, extractAssistantText } from '@zero-os/shared'
import type { ChannelAdapter, StreamAdapter } from '../channels/adapter'

export class MessageProgressDelivery {
  readonly onTextDelta?: (delta: string, meta: { turnId: string }) => void
  readonly onProgress = (newMsg: Message): void => {
    if (!this.options.canDeliverToCurrentSession()) return
    const text = extractAssistantTextFromMessage(newMsg)
    if (!text) return

    if (this.streaming) {
      if (this.progressState.accept(newMsg.id, text) && !this.streamingProgress?.hasSeenDelta) {
        this.streamingProgress?.appendProgressText(text)
      }
      return
    }

    this.replyDelivery.send(newMsg.id, text)
  }

  private readonly progressState = new MessageProgressState()
  private readonly replyDelivery: MessageProgressReplyDelivery
  private readonly streamingProgress: MessageStreamingProgress | null

  constructor(
    private readonly options: {
      streaming: StreamAdapter | null
      channelAdapter: ChannelAdapter
      channelName: string
      chatId: string
      messageId?: string | number
      canDeliverToCurrentSession(): boolean
    },
  ) {
    this.replyDelivery = new MessageProgressReplyDelivery(
      {
        channelAdapter: options.channelAdapter,
        channelName: options.channelName,
        chatId: options.chatId,
        messageId: options.messageId,
      },
      this.progressState,
    )
    this.streamingProgress = options.streaming
      ? new MessageStreamingProgress(options.streaming, {
          channelAdapter: options.channelAdapter,
          channelName: options.channelName,
          chatId: options.chatId,
          messageId: options.messageId,
          canDeliverToCurrentSession: options.canDeliverToCurrentSession,
        })
      : null
    this.onTextDelta = this.streamingProgress?.handleTextDelta
  }

  get lastSentMsgId(): string | null {
    return this.progressState.lastSentMsgId
  }

  get streaming(): StreamAdapter | null {
    return this.streamingProgress?.streaming ?? null
  }

  get streamText(): string {
    return this.streamingProgress?.streamText ?? ''
  }

  async flush(): Promise<void> {
    await this.streamingProgress?.flush()
  }
}

function extractAssistantTextFromMessage(msg: Message): string {
  if (msg.role !== 'assistant') return ''
  return extractAssistantText(msg.content).trim()
}

class MessageProgressState {
  lastSentMsgId: string | null = null
  private lastProgressText: string | null = null

  accept(messageId: string, text: string): boolean {
    if (text === this.lastProgressText) return false
    this.lastProgressText = text
    this.lastSentMsgId = messageId
    return true
  }
}

interface MessageProgressReplyDeliveryOptions {
  channelAdapter: ChannelAdapter
  channelName: string
  chatId: string
  messageId?: string | number
}

class MessageProgressReplyDelivery {
  private firstReply = true

  constructor(
    private readonly options: MessageProgressReplyDeliveryOptions,
    private readonly state: MessageProgressState,
  ) {}

  send(messageId: string, text: string): void {
    if (!this.state.accept(messageId, text)) return

    if (this.firstReply && this.options.messageId !== undefined) {
      this.firstReply = false
      this.options.channelAdapter
        .reply(this.options.chatId, text, this.options.messageId)
        .catch((err) => this.logProgressSendError(err))
      return
    }

    this.options.channelAdapter
      .reply(this.options.chatId, text)
      .catch((err) => this.logProgressSendError(err))
  }

  private logProgressSendError(error: unknown): void {
    console.error(
      `[ZeRo OS] ${this.options.channelName} progressive send error:`,
      describeError(error),
    )
  }
}

class MessageStreamingProgress {
  streaming: StreamAdapter | null
  streamText = ''
  private seenDelta = false
  private lastTurnId: string | null = null
  private turnRotateChain: Promise<void> = Promise.resolve()

  constructor(
    streaming: StreamAdapter,
    private readonly options: {
      channelAdapter: ChannelAdapter
      channelName: string
      chatId: string
      messageId?: string | number
      canDeliverToCurrentSession(): boolean
    },
  ) {
    this.streaming = streaming
  }

  get hasSeenDelta(): boolean {
    return this.seenDelta
  }

  appendProgressText(text: string): void {
    this.streamText = this.streamText ? `${this.streamText}\n\n${text}` : text
    this.queueStreamingUpdate(this.streamText)
  }

  readonly handleTextDelta = (delta: string, meta: { turnId: string }): void => {
    if (!delta) return
    if (!this.options.canDeliverToCurrentSession()) return
    this.seenDelta = true

    if (this.lastTurnId && this.lastTurnId !== meta.turnId && this.streamText) {
      const prevText = this.streamText
      const previousStreaming = this.streaming
      this.streamText = ''
      this.turnRotateChain = this.turnRotateChain.then(async () => {
        if (!previousStreaming) return
        this.streaming = await rotateStreamingTurn({
          previousStreaming,
          previousText: prevText,
          channelAdapter: this.options.channelAdapter,
          channelName: this.options.channelName,
          chatId: this.options.chatId,
          messageId: this.options.messageId,
        })
      })
    }

    this.lastTurnId = meta.turnId
    this.streamText += delta
    this.queueStreamingUpdate(this.streamText)
  }

  async flush(): Promise<void> {
    await this.turnRotateChain
  }

  private queueStreamingUpdate(textSnapshot: string): void {
    this.turnRotateChain = this.turnRotateChain.then(() =>
      updateStreamingText(this.streaming, textSnapshot, this.options.channelName),
    )
  }
}

async function updateStreamingText(
  streaming: StreamAdapter | null,
  textSnapshot: string,
  channelName: string,
): Promise<void> {
  if (!streaming) return
  try {
    await streaming.update(textSnapshot)
  } catch (err) {
    console.error(`[ZeRo OS] ${channelName} streaming update error:`, describeError(err))
  }
}

async function rotateStreamingTurn(options: {
  previousStreaming: StreamAdapter
  previousText: string
  channelAdapter: ChannelAdapter
  channelName: string
  chatId: string
  messageId?: string | number
}): Promise<StreamAdapter | null> {
  try {
    await options.previousStreaming.complete(options.previousText)
    if (!options.channelAdapter.createStreaming) return null
    return await options.channelAdapter.createStreaming(options.chatId, options.messageId)
  } catch (err) {
    console.error(
      `[ZeRo OS] ${options.channelName} streaming turn rotate error:`,
      describeError(err),
    )
    return null
  }
}
