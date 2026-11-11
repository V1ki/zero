import type { DingtalkChannel } from '@zero-os/channel'
import type { ChannelAdapter, ImageUploadResult, StreamAdapter, TypingHandle } from './adapter'

export class DingtalkAdapter implements ChannelAdapter {
  constructor(private readonly dingtalkChannel: DingtalkChannel) {}

  async reply(chatId: string, text: string, replyToMessageId?: string | number): Promise<void> {
    await this.dingtalkChannel.reply(chatId, text, replyToMessageId)
  }

  async showTyping(): Promise<TypingHandle | null> {
    return null
  }

  async createStreaming(): Promise<StreamAdapter | null> {
    return null
  }

  async uploadImage(imageBuffer: Buffer): Promise<ImageUploadResult | null> {
    const mediaId = await this.dingtalkChannel.uploadImage(imageBuffer)
    if (!mediaId) return null
    return { markdownRef: mediaId }
  }

  async sendImage(chatId: string, imageBuffer: Buffer): Promise<void> {
    await this.dingtalkChannel.sendImage(chatId, imageBuffer)
  }

  async markDone(): Promise<void> {
    // DingTalk regular robot messages do not expose emoji reactions.
  }

  async markError(): Promise<void> {
    // DingTalk regular robot messages do not expose emoji reactions.
  }
}
