import type { WeixinChannel } from '@zero-os/channel'
import type { ChannelAdapter, StreamAdapter, TypingHandle } from './channel-adapter'

/**
 * Weixin channel adapter — bridges the Channel's chat protocol to the
 * internal ChannelAdapter surface. Weixin does not support message editing,
 * so `createStreaming` returns null and upper layers fall back to plain
 * `reply()`.
 */
export class WeixinAdapter implements ChannelAdapter {
  constructor(private readonly channel: WeixinChannel) {}

  async reply(chatId: string, text: string): Promise<void> {
    await this.channel.sendToChat(chatId, text)
  }

  async showTyping(chatId: string): Promise<TypingHandle | null> {
    await this.channel.sendTypingIndicator(chatId).catch(() => {})
    return {
      clear: async () => {
        // no dedicated typing-stop flow in our channel wrapper; expiring
        // ticket handles it
      },
    }
  }

  async createStreaming(): Promise<StreamAdapter | null> {
    return null
  }

  async sendImage(chatId: string, imageBuffer: Buffer): Promise<void> {
    await this.channel.sendAttachment(chatId, imageBuffer, 'image.png', 'image/png')
  }

  async markDone(): Promise<void> {
    // Weixin does not support reactions
  }

  async markError(): Promise<void> {
    // Weixin does not support reactions
  }
}
