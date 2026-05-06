import { readFile } from 'node:fs/promises'
import type { BotCommand, File, MenuButton, MessageEntity, ReactionType } from '@telegraf/types'
import { Telegraf } from 'telegraf'
import { toErrorMessage } from '@zero-os/shared'
import type { Channel, ImageAttachment, IncomingMessage, MessageHandler } from '../base'
import {
  type TelegramRichText,
  chunkTelegramRichText,
  markdownToTelegramRichText,
} from '../richtext'

export interface TelegramChannelConfig {
  name?: string
  botToken: string
  streaming?: boolean
}

export interface TelegramBotCommand {
  command: string
  description: string
}

export interface TelegramCommandScopeConfig {
  type:
    | 'default'
    | 'all_private_chats'
    | 'all_group_chats'
    | 'all_chat_administrators'
    | 'chat'
    | 'chat_administrators'
    | 'chat_member'
  chatId?: number | string
  userId?: number
}

export interface TelegramSetMyCommandsOptions {
  scope?: TelegramCommandScopeConfig
  languageCode?: string
}

export type TelegramMenuButtonConfig =
  | { type: 'default' }
  | { type: 'commands' }
  | {
      type: 'web_app'
      text: string
      webAppUrl: string
    }

export interface TelegramSetChatMenuButtonOptions {
  chatId?: number
  menuButton?: TelegramMenuButtonConfig
}

export interface TelegramGetChatMenuButtonOptions {
  chatId?: number
}

interface TelegramSentMessage {
  message_id: number
}

interface TelegramPhotoSize {
  file_id?: string
  width?: number
  height?: number
  file_size?: number
}

interface TelegramDocument {
  file_id?: string
  mime_type?: string
}

interface TelegramIncomingContext {
  from?: {
    id?: number
    username?: string
    first_name?: string
  }
  chat?: {
    id?: number
    type?: string
  }
  message?: {
    date?: number
    message_id?: number
    text?: string
    caption?: string
    photo?: TelegramPhotoSize[]
    document?: TelegramDocument
    video?: unknown
    animation?: unknown
    audio?: unknown
    voice?: unknown
    sticker?: unknown
    location?: unknown
    contact?: unknown
  }
}

type TelegramEntities = MessageEntity[]
type TelegramMenuButton = MenuButton & {
  text?: string
  web_app?: {
    url?: string
  }
}

/**
 * Telegram channel — sends and receives messages via Telegram bot.
 */
export class TelegramChannel implements Channel {
  readonly name: string
  readonly type = 'telegram'

  private bot: Telegraf | null = null
  private messageHandler: MessageHandler | null = null
  private running = false
  private config: TelegramChannelConfig

  constructor(config: TelegramChannelConfig) {
    this.config = config
    this.name = config.name ?? 'telegram'
  }

  async start(): Promise<void> {
    this.bot = new Telegraf(this.config.botToken)
    this.bot.catch((err, ctx) => {
      console.error('[TelegramChannel] Middleware error:', err, 'update_id:', ctx.update?.update_id)
    })

    // Handle all message types in one place so media/caption/images are preserved.
    this.bot.on('message', async (ctx) => {
      if (!this.messageHandler) return

      try {
        const incoming = await this.buildIncomingMessage(ctx)

        // Fire-and-forget so long-running agent work does not block Telegraf update handling.
        this.messageHandler(incoming).catch((err) => {
          console.error('[TelegramChannel] Async message handler error:', err)
        })
      } catch (err) {
        console.error('[TelegramChannel] Failed to build incoming message:', err)
      }
    })

    // Launch in polling mode (non-blocking)
    this.bot.launch().catch((err) => {
      this.running = false
      console.error('[TelegramChannel] Launch error:', err)
    })
    this.running = true
  }

  async stop(): Promise<void> {
    if (this.bot) {
      this.bot.stop('ZeRo OS shutdown')
      this.running = false
      this.bot = null
    }
  }

  async send(sessionId: string, content: string): Promise<void> {
    await this.sendRich(sessionId, content)
  }

  async reply(sessionId: string, messageId: number, content: string): Promise<void> {
    await this.replyRich(sessionId, messageId, content)
  }

  async sendRich(sessionId: string, content: string): Promise<TelegramSentMessage | null> {
    if (!this.bot) return null

    const chatId = this.parseChatId(sessionId)
    if (chatId === null) return null

    const rendered = markdownToTelegramRichText(content)
    return await this.sendRendered(chatId, rendered)
  }

  async replyRich(
    sessionId: string,
    messageId: number,
    content: string,
  ): Promise<TelegramSentMessage | null> {
    if (!this.bot) return null

    const chatId = this.parseChatId(sessionId)
    if (chatId === null) return null

    const rendered = markdownToTelegramRichText(content)
    return await this.sendRendered(chatId, rendered, messageId)
  }

  async editRich(sessionId: string, messageId: number, content: string): Promise<void> {
    if (!this.bot) return

    const chatId = this.parseChatId(sessionId)
    if (chatId === null) return

    const rendered = markdownToTelegramRichText(content)
    const chunks = chunkTelegramRichText(rendered)
    if (chunks.length === 0) return

    const first = chunks[0]

    try {
      await this.bot.telegram.editMessageText(chatId, messageId, undefined, first.text || ' ', {
        entities: first.entities as TelegramEntities,
      })
    } catch (err) {
      const message = toErrorMessage(err)
      // Ignore no-op edits during throttled streaming updates.
      if (!message.includes('message is not modified')) {
        throw err
      }
    }

    for (let i = 1; i < chunks.length; i++) {
      await this.bot.telegram.sendMessage(chatId, chunks[i].text || ' ', {
        entities: chunks[i].entities as TelegramEntities,
      })
    }
  }

  async sendTyping(sessionId: string): Promise<void> {
    if (!this.bot) return

    const chatId = this.parseChatId(sessionId)
    if (chatId === null) return

    await this.bot.telegram.sendChatAction(chatId, 'typing')
  }

  async react(sessionId: string, messageId: number, emoji = '👀'): Promise<void> {
    if (!this.bot) return

    const chatId = this.parseChatId(sessionId)
    if (chatId === null) return

    await this.bot.telegram.setMessageReaction(chatId, messageId, [
      { type: 'emoji', emoji } as ReactionType,
    ])
  }

  async setMyCommands(
    commands: TelegramBotCommand[],
    options: TelegramSetMyCommandsOptions = {},
  ): Promise<void> {
    if (!this.bot) return
    await this.bot.telegram.setMyCommands(commands, this.toApiSetMyCommandsOptions(options))
  }

  async getMyCommands(options: TelegramSetMyCommandsOptions = {}): Promise<TelegramBotCommand[]> {
    if (!this.bot) return []
    const commands = await this.bot.telegram.getMyCommands(this.toApiSetMyCommandsOptions(options))
    return commands.map((cmd: BotCommand) => ({
      command: String(cmd?.command ?? ''),
      description: String(cmd?.description ?? ''),
    }))
  }

  async setChatMenuButton(options: TelegramSetChatMenuButtonOptions = {}): Promise<void> {
    if (!this.bot) return
    await this.bot.telegram.setChatMenuButton(this.toApiSetChatMenuButtonOptions(options))
  }

  async getChatMenuButton(
    options: TelegramGetChatMenuButtonOptions = {},
  ): Promise<TelegramMenuButtonConfig | null> {
    if (!this.bot) return null
    const menuButton = await this.bot.telegram.getChatMenuButton(
      this.toApiGetChatMenuButtonOptions(options),
    )
    return this.fromApiMenuButton(menuButton)
  }

  isConnected(): boolean {
    return this.running
  }

  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  getCapabilities() {
    return {
      streaming: this.config.streaming ?? true,
      inlineImages: false,
      imageMessages: true,
      fileMessages: true,
      interactiveCards: false,
      mentions: true,
      reactions: true,
      threadReply: true,
      markdownNotes:
        'Telegram supports a subset of Markdown (bold, italic, code, links). ' +
        'Images cannot be inlined in text — send as separate photo messages.',
      maxMessageLength: 4096,
    }
  }

  private parseChatId(sessionId: string): number | null {
    const chatId = Number(sessionId)
    return Number.isFinite(chatId) ? chatId : null
  }

  private toApiSetMyCommandsOptions(
    options: TelegramSetMyCommandsOptions,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    if (options.scope) {
      out.scope = this.toApiCommandScope(options.scope)
    }
    if (typeof options.languageCode === 'string') {
      out.language_code = options.languageCode
    }
    return out
  }

  private toApiCommandScope(scope: TelegramCommandScopeConfig): Record<string, unknown> {
    const out: Record<string, unknown> = { type: scope.type }
    if (scope.chatId !== undefined) {
      out.chat_id = scope.chatId
    }
    if (scope.userId !== undefined) {
      out.user_id = scope.userId
    }
    return out
  }

  private toApiSetChatMenuButtonOptions(options: TelegramSetChatMenuButtonOptions): {
    chatId?: number
    menuButton?: MenuButton
  } {
    const out: { chatId?: number; menuButton?: MenuButton } = {}
    if (options.chatId !== undefined) {
      out.chatId = options.chatId
    }
    if (options.menuButton) {
      out.menuButton = this.toApiMenuButton(options.menuButton)
    }
    return out
  }

  private toApiGetChatMenuButtonOptions(options: TelegramGetChatMenuButtonOptions): {
    chatId?: number
  } {
    if (options.chatId !== undefined) {
      return { chatId: options.chatId }
    }
    return {}
  }

  private toApiMenuButton(menuButton: TelegramMenuButtonConfig): MenuButton {
    if (menuButton.type === 'web_app') {
      return {
        type: 'web_app',
        text: menuButton.text,
        web_app: { url: menuButton.webAppUrl },
      }
    }
    return { type: menuButton.type }
  }

  private fromApiMenuButton(
    menuButton: TelegramMenuButton | null | undefined,
  ): TelegramMenuButtonConfig | null {
    if (!menuButton || typeof menuButton !== 'object') return null

    if (menuButton.type === 'web_app') {
      return {
        type: 'web_app',
        text: String(menuButton.text ?? ''),
        webAppUrl: String(menuButton.web_app?.url ?? ''),
      }
    }

    if (menuButton.type === 'commands') {
      return { type: 'commands' }
    }

    if (menuButton.type === 'default') {
      return { type: 'default' }
    }

    return null
  }

  private async sendRendered(
    chatId: number,
    rendered: TelegramRichText,
    replyToMessageId?: number,
  ): Promise<TelegramSentMessage | null> {
    if (!this.bot) return null

    const chunks = chunkTelegramRichText(rendered)
    if (chunks.length === 0) return null

    let firstMessage: TelegramSentMessage | null = null

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const sent = await this.bot.telegram.sendMessage(chatId, chunk.text || ' ', {
        entities: chunk.entities as TelegramEntities,
        ...(i === 0 && replyToMessageId
          ? {
              reply_parameters: {
                message_id: replyToMessageId,
              },
            }
          : {}),
      })

      if (!firstMessage) {
        firstMessage = sent as TelegramSentMessage
      }
    }

    return firstMessage
  }

  private async buildIncomingMessage(ctx: TelegramIncomingContext): Promise<IncomingMessage> {
    const message = ctx.message ?? {}
    const images = await this.extractImages(message)
    const mediaHints = this.collectMediaHints(message)

    let content = '[non-text message]'
    if (typeof message.text === 'string' && message.text.trim()) {
      content = message.text
    } else if (typeof message.caption === 'string' && message.caption.trim()) {
      content = message.caption
    } else if (mediaHints.length > 0) {
      content = mediaHints.join(' ')
    }

    const senderId =
      ctx.from?.id != null
        ? String(ctx.from.id)
        : ctx.chat?.id != null
          ? String(ctx.chat.id)
          : 'unknown'

    const tsSec = typeof message.date === 'number' ? message.date : Math.floor(Date.now() / 1000)

    return {
      channelType: 'telegram',
      senderId,
      content,
      timestamp: new Date(tsSec * 1000).toISOString(),
      metadata: {
        chatId: ctx.chat?.id ?? ctx.from?.id,
        messageId: message.message_id,
        chatType: ctx.chat?.type,
        username: ctx.from?.username,
        firstName: ctx.from?.first_name,
        hasMedia: mediaHints.length > 0,
        mediaHints,
      },
      images: images.length > 0 ? images : undefined,
    }
  }

  private collectMediaHints(message: Record<string, unknown>): string[] {
    const hints: string[] = []
    if (Array.isArray(message.photo) && message.photo.length > 0) hints.push('[photo]')
    if (message.video) hints.push('[video]')
    if (message.document) hints.push('[document]')
    if (message.animation) hints.push('[animation]')
    if (message.audio) hints.push('[audio]')
    if (message.voice) hints.push('[voice]')
    if (message.sticker) hints.push('[sticker]')
    if (message.location) hints.push('[location]')
    if (message.contact) hints.push('[contact]')
    return hints
  }

  private async extractImages(
    message: TelegramIncomingContext['message'],
  ): Promise<ImageAttachment[]> {
    if (!this.bot) return []

    const fileIds = new Set<string>()

    const photoSizes = Array.isArray(message?.photo) ? message.photo : []
    if (photoSizes.length > 0) {
      const best = photoSizes.slice().sort((a, b) => {
        const areaA = (a?.width ?? 0) * (a?.height ?? 0)
        const areaB = (b?.width ?? 0) * (b?.height ?? 0)
        if (areaA !== areaB) return areaB - areaA
        return (b?.file_size ?? 0) - (a?.file_size ?? 0)
      })[0]
      if (best?.file_id) fileIds.add(best.file_id)
    }

    if (message?.document?.mime_type?.startsWith?.('image/') && message.document?.file_id) {
      fileIds.add(message.document.file_id)
    }

    const downloaded: ImageAttachment[] = []
    for (const fileId of fileIds) {
      try {
        const info = await this.bot.telegram.getFile(fileId)
        const filePath = info.file_path
        if (!filePath) continue

        const fileUrl = await this.bot.telegram.getFileLink(info as File)
        const buf = await this.downloadTelegramFile(fileUrl)

        const mediaType = this.inferImageMediaType(filePath, message?.document?.mime_type)
        downloaded.push({ mediaType, data: buf.toString('base64') })
      } catch (err) {
        console.error('[TelegramChannel] Failed to download image file:', fileId, err)
      }
    }

    return downloaded
  }

  private inferImageMediaType(filePath: string, fallback?: string): string {
    if (fallback?.startsWith('image/')) return fallback
    const lower = filePath.toLowerCase()
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
    if (lower.endsWith('.png')) return 'image/png'
    if (lower.endsWith('.webp')) return 'image/webp'
    if (lower.endsWith('.gif')) return 'image/gif'
    return 'image/jpeg'
  }

  private async downloadTelegramFile(fileUrl: URL): Promise<Buffer> {
    if (fileUrl.protocol === 'file:') {
      return await readFile(fileUrl)
    }

    const response = await fetch(fileUrl)
    if (!response.ok) {
      throw new Error(`Telegram file download failed with status ${response.status}`)
    }

    return Buffer.from(await response.arrayBuffer())
  }
}
