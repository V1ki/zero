import type { FeishuChannel, FeishuStreamingSession } from '@zero-os/channel'
import type { ChannelAdapter, ImageUploadResult, StreamAdapter, TypingHandle } from './adapter'

interface FeishuAdapterOptions {
  activeStreamingSessions?: Set<FeishuStreamingSession>
}

export class FeishuAdapter implements ChannelAdapter {
  constructor(
    private readonly feishuChannel: FeishuChannel,
    private readonly options: FeishuAdapterOptions = {},
  ) {}

  async reply(chatId: string, text: string, replyToMessageId?: string | number): Promise<void> {
    if (replyToMessageId !== undefined && replyToMessageId !== null) {
      await this.feishuChannel.reply(String(replyToMessageId), text)
      return
    }
    await this.feishuChannel.send(chatId, text)
  }

  async showTyping(_chatId: string, messageId?: string | number): Promise<TypingHandle | null> {
    if (!messageId) return null

    const reactionId = await this.feishuChannel.react(String(messageId), 'Typing')
    if (!reactionId) return null

    return {
      clear: async () => {
        await this.feishuChannel.removeReaction(String(messageId), reactionId)
      },
    }
  }

  async createStreaming(
    chatId: string,
    replyToMessageId?: string | number,
  ): Promise<StreamAdapter | null> {
    return await createFeishuStreamingAdapter({
      feishuChannel: this.feishuChannel,
      activeStreamingSessions: this.options.activeStreamingSessions,
      chatId,
      replyToMessageId,
    })
  }

  async markDone(_chatId: string, messageId?: string | number): Promise<void> {
    if (!messageId) return
    await this.feishuChannel.react(String(messageId), 'DONE')
  }

  async uploadImage(imageBuffer: Buffer): Promise<ImageUploadResult | null> {
    const imageKey = await this.feishuChannel.uploadImage(imageBuffer)
    if (!imageKey) return null
    return { markdownRef: imageKey }
  }

  async sendImage(chatId: string, imageBuffer: Buffer): Promise<void> {
    await this.feishuChannel.sendImage(chatId, imageBuffer)
  }
}

export interface FeishuStreamingAdapterOptions {
  feishuChannel: Pick<FeishuChannel, 'replyStreaming' | 'sendStreaming'>
  activeStreamingSessions?: Set<FeishuStreamingSession>
  chatId: string
  replyToMessageId?: string | number
}

export async function createFeishuStreamingAdapter({
  feishuChannel,
  activeStreamingSessions,
  chatId,
  replyToMessageId,
}: FeishuStreamingAdapterOptions): Promise<StreamAdapter> {
  const rawSession =
    replyToMessageId !== undefined && replyToMessageId !== null
      ? await feishuChannel.replyStreaming(String(replyToMessageId))
      : await feishuChannel.sendStreaming(chatId)

  activeStreamingSessions?.add(rawSession)

  const release = () => {
    activeStreamingSessions?.delete(rawSession)
  }

  return {
    update: async (fullText: string) => {
      await rawSession.update(fullText)
    },
    complete: async (finalText: string) => {
      try {
        if (finalText.trim()) {
          await rawSession.complete(finalText)
        } else {
          await rawSession.dismiss()
        }
      } finally {
        release()
      }
    },
    abort: async (errorMessage?: string) => {
      try {
        await rawSession.abort(errorMessage)
      } finally {
        release()
      }
    },
  }
}
