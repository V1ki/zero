import type { TelegramChannel } from '@zero-os/channel'
import type { ChannelAdapter, StreamAdapter, TypingHandle } from './channel-adapter'
import { createTelegramStreamFlusher, reconcileTelegramFinalText } from './telegram-streaming'

export interface TelegramAdapterOptions {
  streaming?: boolean
}

export class TelegramAdapter implements ChannelAdapter {
  constructor(
    private readonly telegramChannel: TelegramChannel,
    private readonly options: TelegramAdapterOptions = {},
  ) {}

  async reply(chatId: string, text: string, replyToMessageId?: string | number): Promise<void> {
    if (replyToMessageId !== undefined && replyToMessageId !== null) {
      await this.telegramChannel.replyRich(chatId, Number(replyToMessageId), text)
      return
    }
    await this.telegramChannel.sendRich(chatId, text)
  }

  async showTyping(chatId: string, messageId?: string | number): Promise<TypingHandle | null> {
    await this.telegramChannel.sendTyping(chatId).catch(() => {})

    if (messageId !== undefined && messageId !== null) {
      await this.telegramChannel.react(chatId, Number(messageId), '👀').catch(() => {})
    }

    return {
      clear: async () => {},
    }
  }

  async createStreaming(chatId: string, replyToMessageId?: string | number): Promise<StreamAdapter | null> {
    if (this.options.streaming === false) return null

    let streamText = ''
    const flusher = createTelegramStreamFlusher({
      minIntervalMs: 350,
      getText: () => streamText,
      sendInitial: async (text) => {
        const sent =
          replyToMessageId !== undefined && replyToMessageId !== null
            ? await this.telegramChannel.replyRich(chatId, Number(replyToMessageId), text)
            : await this.telegramChannel.sendRich(chatId, text)
        return sent?.message_id ?? null
      },
      edit: async (sentMessageId, text) => {
        await this.telegramChannel.editRich(chatId, sentMessageId, text)
      },
    })

    return {
      update: async (fullText: string) => {
        streamText = fullText
        await this.telegramChannel.sendTyping(chatId).catch(() => {})
        await flusher.flush(false)
      },
      complete: async (finalText: string) => {
        streamText = reconcileTelegramFinalText(streamText, finalText)
        if (!streamText) return
        await flusher.flush(true)
      },
      abort: async (errorMessage?: string) => {
        const text = errorMessage?.trim()
        if (!text) return
        streamText = text
        await flusher.flush(true)
      },
    }
  }

  async markDone(chatId: string, messageId?: string | number): Promise<void> {
    if (messageId === undefined || messageId === null) return
    await this.telegramChannel.react(chatId, Number(messageId), '✅')
  }

  async markError(chatId: string, messageId?: string | number): Promise<void> {
    if (messageId === undefined || messageId === null) return
    await this.telegramChannel.react(chatId, Number(messageId), '❌')
  }
}
