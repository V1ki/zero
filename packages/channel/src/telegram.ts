import { readFile } from 'node:fs/promises'
import type { BotCommand, MenuButton, MessageEntity, ReactionType } from '@telegraf/types'
import type { File } from '@telegraf/types'
import { toErrorMessage } from '@zero-os/shared'
import { Telegraf } from 'telegraf'
import type { Channel, ImageAttachment, IncomingMessage, MessageHandler } from './base'
import {
  chunkTelegramRichText,
  markdownToTelegramRichText,
  type TelegramRichText,
} from './richtext'

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

export interface TelegramChannelConfig {
  name?: string
  botToken: string
  streaming?: boolean
}

export interface TelegramSentMessage {
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

export interface TelegramIncomingContext {
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

interface TelegramFileApi {
  getFile(fileId: string): Promise<File>
  getFileLink(file: File): Promise<URL>
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
    return await sendTelegramChannelRich(this.telegramApi, sessionId, content)
  }

  async replyRich(
    sessionId: string,
    messageId: number,
    content: string,
  ): Promise<TelegramSentMessage | null> {
    return await replyTelegramChannelRich(this.telegramApi, sessionId, messageId, content)
  }

  async editRich(sessionId: string, messageId: number, content: string): Promise<void> {
    await editTelegramChannelRich(this.telegramApi, sessionId, messageId, content)
  }

  async sendTyping(sessionId: string): Promise<void> {
    await sendTelegramTypingAction(this.telegramApi, sessionId)
  }

  async react(sessionId: string, messageId: number, emoji = '👀'): Promise<void> {
    await reactToTelegramMessage(this.telegramApi, sessionId, messageId, emoji)
  }

  async setMyCommands(
    commands: TelegramBotCommand[],
    options: TelegramSetMyCommandsOptions = {},
  ): Promise<void> {
    await setTelegramBotCommands(this.telegramApi, commands, options)
  }

  async getMyCommands(options: TelegramSetMyCommandsOptions = {}): Promise<TelegramBotCommand[]> {
    return await getTelegramBotCommands(this.telegramApi, options)
  }

  async setChatMenuButton(options: TelegramSetChatMenuButtonOptions = {}): Promise<void> {
    await setTelegramMenuButton(this.telegramApi, options)
  }

  async getChatMenuButton(
    options: TelegramGetChatMenuButtonOptions = {},
  ): Promise<TelegramMenuButtonConfig | null> {
    return await getTelegramMenuButton(this.telegramApi, options)
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

  private async buildIncomingMessage(ctx: TelegramIncomingContext): Promise<IncomingMessage> {
    return await buildTelegramIncomingMessage(ctx, this.bot?.telegram)
  }

  private get telegramApi(): (TelegramActionApi & TelegramMenuApi) | null {
    return this.bot ? (this.bot.telegram as TelegramActionApi & TelegramMenuApi) : null
  }
}

export async function buildTelegramIncomingMessage(
  ctx: TelegramIncomingContext,
  fileApi?: TelegramFileApi,
): Promise<IncomingMessage> {
  const message = ctx.message ?? {}
  const images = await extractTelegramImages(message, fileApi)
  const mediaHints = collectTelegramMediaHints(message)

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

function collectTelegramMediaHints(message: Record<string, unknown>): string[] {
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

async function extractTelegramImages(
  message: TelegramIncomingContext['message'],
  fileApi?: TelegramFileApi,
): Promise<ImageAttachment[]> {
  if (!fileApi) return []

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
      const info = await fileApi.getFile(fileId)
      const filePath = info.file_path
      if (!filePath) continue

      const fileUrl = await fileApi.getFileLink(info)
      const buf = await downloadTelegramFile(fileUrl)

      const mediaType = inferTelegramImageMediaType(filePath, message?.document?.mime_type)
      downloaded.push({ mediaType, data: buf.toString('base64') })
    } catch (err) {
      console.error('[TelegramChannel] Failed to download image file:', fileId, err)
    }
  }

  return downloaded
}

function inferTelegramImageMediaType(filePath: string, fallback?: string): string {
  if (fallback?.startsWith('image/')) return fallback
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'image/jpeg'
}

async function downloadTelegramFile(fileUrl: URL): Promise<Buffer> {
  if (fileUrl.protocol === 'file:') {
    return await readFile(fileUrl)
  }

  const response = await fetch(fileUrl)
  if (!response.ok) {
    throw new Error(`Telegram file download failed with status ${response.status}`)
  }

  return Buffer.from(await response.arrayBuffer())
}

interface TelegramActionApi extends TelegramMessageApi {
  sendChatAction(chatId: number, action: 'typing'): Promise<unknown>
  setMessageReaction(chatId: number, messageId: number, reactions: ReactionType[]): Promise<unknown>
}

type TelegramEntities = MessageEntity[]

interface TelegramMessageApi {
  sendMessage(
    chatId: number,
    text: string,
    options: {
      entities: TelegramEntities
      reply_parameters?: {
        message_id: number
      }
    },
  ): Promise<unknown>
  editMessageText(
    chatId: number,
    messageId: number,
    inlineMessageId: undefined,
    text: string,
    options: {
      entities: TelegramEntities
    },
  ): Promise<unknown>
}

interface TelegramMenuApi {
  setMyCommands(commands: TelegramBotCommand[], options: Record<string, unknown>): Promise<unknown>
  getMyCommands(options: Record<string, unknown>): Promise<BotCommand[]>
  setChatMenuButton(options: { chatId?: number; menuButton?: MenuButton }): Promise<unknown>
  getChatMenuButton(options: { chatId?: number }): Promise<MenuButton | null | undefined>
}

type TelegramMenuButton = MenuButton & {
  text?: string
  web_app?: {
    url?: string
  }
}

async function sendTelegramChannelRich(
  api: TelegramActionApi | null,
  sessionId: string,
  content: string,
): Promise<TelegramSentMessage | null> {
  if (!api) return null

  const chatId = parseTelegramChatId(sessionId)
  if (chatId === null) return null

  const rendered = markdownToTelegramRichText(content)
  return await sendTelegramRichText(api, chatId, rendered)
}

async function replyTelegramChannelRich(
  api: TelegramActionApi | null,
  sessionId: string,
  messageId: number,
  content: string,
): Promise<TelegramSentMessage | null> {
  if (!api) return null

  const chatId = parseTelegramChatId(sessionId)
  if (chatId === null) return null

  const rendered = markdownToTelegramRichText(content)
  return await sendTelegramRichText(api, chatId, rendered, messageId)
}

async function editTelegramChannelRich(
  api: TelegramActionApi | null,
  sessionId: string,
  messageId: number,
  content: string,
): Promise<void> {
  if (!api) return

  const chatId = parseTelegramChatId(sessionId)
  if (chatId === null) return

  const rendered = markdownToTelegramRichText(content)
  await editTelegramRichText(api, chatId, messageId, rendered)
}

async function sendTelegramRichText(
  telegram: TelegramMessageApi,
  chatId: number,
  rendered: TelegramRichText,
  replyToMessageId?: number,
): Promise<TelegramSentMessage | null> {
  const chunks = chunkTelegramRichText(rendered)
  if (chunks.length === 0) return null

  let firstMessage: TelegramSentMessage | null = null

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const sent = await telegram.sendMessage(chatId, chunk.text || ' ', {
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

async function editTelegramRichText(
  telegram: TelegramMessageApi,
  chatId: number,
  messageId: number,
  rendered: TelegramRichText,
): Promise<void> {
  const chunks = chunkTelegramRichText(rendered)
  if (chunks.length === 0) return

  const first = chunks[0]

  try {
    await telegram.editMessageText(chatId, messageId, undefined, first.text || ' ', {
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
    await telegram.sendMessage(chatId, chunks[i].text || ' ', {
      entities: chunks[i].entities as TelegramEntities,
    })
  }
}

async function sendTelegramTypingAction(
  api: TelegramActionApi | null,
  sessionId: string,
): Promise<void> {
  if (!api) return

  const chatId = parseTelegramChatId(sessionId)
  if (chatId === null) return

  await api.sendChatAction(chatId, 'typing')
}

async function reactToTelegramMessage(
  api: TelegramActionApi | null,
  sessionId: string,
  messageId: number,
  emoji: string,
): Promise<void> {
  if (!api) return

  const chatId = parseTelegramChatId(sessionId)
  if (chatId === null) return

  await api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji } as ReactionType])
}

async function setTelegramBotCommands(
  api: TelegramMenuApi | null,
  commands: TelegramBotCommand[],
  options: TelegramSetMyCommandsOptions = {},
): Promise<void> {
  if (!api) return
  await api.setMyCommands(commands, toApiSetMyCommandsOptions(options))
}

async function getTelegramBotCommands(
  api: TelegramMenuApi | null,
  options: TelegramSetMyCommandsOptions = {},
): Promise<TelegramBotCommand[]> {
  if (!api) return []
  const commands = await api.getMyCommands(toApiSetMyCommandsOptions(options))
  return commands.map(normalizeTelegramBotCommand)
}

async function setTelegramMenuButton(
  api: TelegramMenuApi | null,
  options: TelegramSetChatMenuButtonOptions = {},
): Promise<void> {
  if (!api) return
  await api.setChatMenuButton(toApiSetChatMenuButtonOptions(options))
}

async function getTelegramMenuButton(
  api: TelegramMenuApi | null,
  options: TelegramGetChatMenuButtonOptions = {},
): Promise<TelegramMenuButtonConfig | null> {
  if (!api) return null
  const menuButton = await api.getChatMenuButton(toApiGetChatMenuButtonOptions(options))
  return fromApiMenuButton(menuButton)
}

function parseTelegramChatId(sessionId: string): number | null {
  const chatId = Number(sessionId)
  return Number.isFinite(chatId) ? chatId : null
}

function toApiSetMyCommandsOptions(options: TelegramSetMyCommandsOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (options.scope) {
    out.scope = toApiCommandScope(options.scope)
  }
  if (typeof options.languageCode === 'string') {
    out.language_code = options.languageCode
  }
  return out
}

function normalizeTelegramBotCommand(command: BotCommand): TelegramBotCommand {
  return {
    command: String(command?.command ?? ''),
    description: String(command?.description ?? ''),
  }
}

function toApiSetChatMenuButtonOptions(options: TelegramSetChatMenuButtonOptions): {
  chatId?: number
  menuButton?: MenuButton
} {
  const out: { chatId?: number; menuButton?: MenuButton } = {}
  if (options.chatId !== undefined) {
    out.chatId = options.chatId
  }
  if (options.menuButton) {
    out.menuButton = toApiMenuButton(options.menuButton)
  }
  return out
}

function toApiGetChatMenuButtonOptions(options: TelegramGetChatMenuButtonOptions): {
  chatId?: number
} {
  if (options.chatId !== undefined) {
    return { chatId: options.chatId }
  }
  return {}
}

function fromApiMenuButton(
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

function toApiCommandScope(scope: TelegramCommandScopeConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { type: scope.type }
  if (scope.chatId !== undefined) {
    out.chat_id = scope.chatId
  }
  if (scope.userId !== undefined) {
    out.user_id = scope.userId
  }
  return out
}

function toApiMenuButton(menuButton: TelegramMenuButtonConfig): MenuButton {
  if (menuButton.type === 'web_app') {
    return {
      type: 'web_app',
      text: menuButton.text,
      web_app: { url: menuButton.webAppUrl },
    }
  }
  return { type: menuButton.type }
}
