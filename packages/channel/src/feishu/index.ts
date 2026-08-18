import * as lark from '@larksuiteoapi/node-sdk'
import { describeError } from '@zero-os/shared'
import type { Channel, MessageHandler } from '../base'
import { RecentMessageTracker } from '../message-tracker'
import { renderMarkdownForFeishu } from '../richtext/feishu'
import {
  FEISHU_MAX_RICH_MESSAGE_BYTES,
  FEISHU_MAX_TEXT_MESSAGE_BYTES,
  type FeishuCardOptions,
  buildFeishuCardReferenceContent,
  buildFeishuMarkdownCardV2,
  buildFeishuPostContent,
  buildFeishuTextContent,
  byteLength,
  chunkFeishuRichContent,
  detectFeishuCardJson,
  splitByLinePreserveLimit,
} from './card'
import { type FeishuImageReference, FeishuImageResolver } from './image-resolver'
import { readFeishuImageReferenceBuffer } from './image-source'
import { type FeishuIncomingEventPayload, FeishuIncomingMessageBuilder } from './incoming-message'
import {
  type FeishuImageTarget,
  type FeishuStreamingSession,
  createFeishuStreamingSession,
} from './streaming-session'
import { readFeishuUploadKey, uploadFeishuImageBuffer } from './upload'

export interface FeishuChannelConfig {
  name?: string
  appId: string
  appSecret: string
  encryptKey?: string
  verificationToken?: string
  /** Directory for saving downloaded file attachments. */
  downloadsDir?: string
}

export type { FeishuStreamingSession }

type FeishuFileType = 'stream' | 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt'
type FeishuInlineImageSource = 'send' | 'reply' | 'streaming'

interface FeishuWsClient {
  start(params: { eventDispatcher: lark.EventDispatcher }): Promise<void>
  close(params?: { force?: boolean }): void
}

export interface FeishuChannelFactories {
  createClient(options: ConstructorParameters<typeof lark.Client>[0]): lark.Client
  createEventDispatcher(
    options: ConstructorParameters<typeof lark.EventDispatcher>[0],
  ): lark.EventDispatcher
  createWsClient(options: ConstructorParameters<typeof lark.WSClient>[0]): FeishuWsClient
}

const defaultFeishuChannelFactories: FeishuChannelFactories = {
  createClient: (options) => new lark.Client(options),
  createEventDispatcher: (options) => new lark.EventDispatcher(options),
  createWsClient: (options) => new lark.WSClient(options),
}

async function sendCreateWithFallback(
  client: lark.Client | null,
  sessionId: string,
  content: string,
  options?: FeishuCardOptions,
): Promise<void> {
  if (!client) return

  const interactiveContent = buildFeishuMarkdownCardV2(content, options)
  if (byteLength(interactiveContent) <= FEISHU_MAX_RICH_MESSAGE_BYTES) {
    try {
      await client.im.message.create({
        data: {
          receive_id: sessionId,
          msg_type: 'interactive',
          content: interactiveContent,
        },
        params: { receive_id_type: 'chat_id' },
      })
      return
    } catch (interactiveErr) {
      console.warn(
        '[FeishuChannel] interactive send failed, fallback to post:',
        describeError(interactiveErr),
      )
    }
  } else {
    console.warn('[FeishuChannel] interactive payload exceeds size limit, fallback to post')
  }

  const postContent = buildFeishuPostContent(content, options)
  if (byteLength(postContent) <= FEISHU_MAX_RICH_MESSAGE_BYTES) {
    try {
      await client.im.message.create({
        data: {
          receive_id: sessionId,
          msg_type: 'post',
          content: postContent,
        },
        params: { receive_id_type: 'chat_id' },
      })
      return
    } catch (postErr) {
      console.warn('[FeishuChannel] post send failed, fallback to text:', describeError(postErr))
    }
  } else {
    console.warn('[FeishuChannel] post payload exceeds size limit, fallback to text')
  }

  const textChunks = splitByLinePreserveLimit(content, FEISHU_MAX_TEXT_MESSAGE_BYTES, (chunk) =>
    buildFeishuTextContent(chunk, options),
  )
  for (let i = 0; i < textChunks.length; i++) {
    await client.im.message.create({
      data: {
        receive_id: sessionId,
        msg_type: 'text',
        content: buildFeishuTextContent(textChunks[i], i === 0 ? options : undefined),
      },
      params: { receive_id_type: 'chat_id' },
    })
  }
}

async function sendReplyWithFallback(
  client: lark.Client | null,
  messageId: string,
  content: string,
): Promise<void> {
  if (!client) return

  const interactiveContent = buildFeishuMarkdownCardV2(content)
  if (byteLength(interactiveContent) <= FEISHU_MAX_RICH_MESSAGE_BYTES) {
    try {
      await client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: interactiveContent,
          msg_type: 'interactive',
        },
      })
      return
    } catch (interactiveErr) {
      console.warn(
        '[FeishuChannel] interactive reply failed, fallback to post:',
        describeError(interactiveErr),
      )
    }
  } else {
    console.warn('[FeishuChannel] interactive reply payload exceeds size limit, fallback to post')
  }

  const postContent = buildFeishuPostContent(content)
  if (byteLength(postContent) <= FEISHU_MAX_RICH_MESSAGE_BYTES) {
    try {
      await client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: postContent,
          msg_type: 'post',
        },
      })
      return
    } catch (postErr) {
      console.warn('[FeishuChannel] post reply failed, fallback to text:', describeError(postErr))
    }
  } else {
    console.warn('[FeishuChannel] post reply payload exceeds size limit, fallback to text')
  }

  try {
    const textChunks = splitByLinePreserveLimit(content, FEISHU_MAX_TEXT_MESSAGE_BYTES, (chunk) =>
      buildFeishuTextContent(chunk),
    )
    for (const textChunk of textChunks) {
      await client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: buildFeishuTextContent(textChunk),
          msg_type: 'text',
        },
      })
    }
  } catch (textErr) {
    console.error('[FeishuChannel] text reply fallback failed:', describeError(textErr))
    throw textErr
  }
}

interface FeishuMediaDeliveryOptions {
  getClient: () => lark.Client | null
}

class FeishuMediaDelivery {
  constructor(private readonly options: FeishuMediaDeliveryOptions) {}

  async sendImage(
    chatId: string,
    image: Buffer | string,
    replyToMessageId?: string,
  ): Promise<void> {
    await this.sendImageMessage(image, { chatId, replyToMessageId })
  }

  async uploadImage(image: Buffer): Promise<string | null> {
    const client = this.client
    if (!client) return null

    try {
      return await uploadFeishuImageBuffer(client, image)
    } catch (error) {
      console.warn('[FeishuChannel] Image upload failed:', describeError(error))
      return null
    }
  }

  async sendFile(
    chatId: string,
    file: Buffer | string,
    fileName: string,
    replyToMessageId?: string,
  ): Promise<void> {
    if (!this.client) return

    try {
      const fileBuffer =
        typeof file === 'string' ? (await import('node:fs')).readFileSync(file) : file

      const fileType = this.detectFileType(fileName)

      const uploadResp = await this.client.im.file.create({
        data: {
          file_type: fileType,
          file_name: fileName,
          file: fileBuffer,
        },
      })

      const fileKey = readFeishuUploadKey(uploadResp, 'file_key')
      if (!fileKey) {
        console.warn('[FeishuChannel] File upload failed: no file_key in response')
        return
      }

      const content = JSON.stringify({ file_key: fileKey })

      if (replyToMessageId) {
        await this.client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content, msg_type: 'file' },
        })
      } else {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'file', content },
        })
      }

      console.log(`[FeishuChannel] File "${fileName}" sent successfully`)
    } catch (error) {
      console.error('[FeishuChannel] Failed to send file:', describeError(error))
    }
  }

  async deliverUnresolvedInlineImages(
    images: FeishuImageReference[],
    target: FeishuImageTarget,
    source: FeishuInlineImageSource,
  ): Promise<void> {
    if (images.length === 0) return

    let failures = 0
    for (const image of images) {
      const delivered = await this.sendImageReference(image.reference, target)
      if (!delivered) {
        failures += 1
      }
    }

    if (failures === 0) return

    const notice = this.buildInlineImageFailureNotice(failures)
    if (target.replyToMessageId) {
      await sendReplyWithFallback(this.client, target.replyToMessageId, notice)
    } else if (target.chatId) {
      await sendCreateWithFallback(this.client, target.chatId, notice)
    }

    console.warn(
      `[FeishuChannel] ${source} inline image fallback incomplete: ${failures} image(s) failed`,
    )
  }

  private get client(): lark.Client | null {
    return this.options.getClient()
  }

  private async sendImageMessage(
    image: Buffer | string,
    target: FeishuImageTarget,
  ): Promise<boolean> {
    const client = this.client
    if (!client) return false

    try {
      const imageBuffer =
        typeof image === 'string' ? await readFeishuImageReferenceBuffer(image) : image

      const imageKey = await uploadFeishuImageBuffer(client, imageBuffer)
      if (!imageKey) {
        console.warn('[FeishuChannel] Image upload failed: no image_key in response')
        return false
      }

      const content = JSON.stringify({ image_key: imageKey })

      if (target.replyToMessageId) {
        await client.im.message.reply({
          path: { message_id: target.replyToMessageId },
          data: { content, msg_type: 'image' },
        })
      } else if (target.chatId) {
        await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: target.chatId, msg_type: 'image', content },
        })
      } else {
        return false
      }

      console.log('[FeishuChannel] Image sent successfully')
      return true
    } catch (error) {
      console.error('[FeishuChannel] Failed to send image:', describeError(error))
      return false
    }
  }

  private async sendImageReference(reference: string, target: FeishuImageTarget): Promise<boolean> {
    try {
      return await this.sendImageMessage(await readFeishuImageReferenceBuffer(reference), target)
    } catch (error) {
      console.warn(
        `[FeishuChannel] Failed to read fallback image ${reference}:`,
        describeError(error),
      )
      return false
    }
  }

  private detectFileType(fileName: string): FeishuFileType {
    const ext = fileName.toLowerCase().split('.').pop() ?? ''
    const typeMap: Record<string, FeishuFileType> = {
      opus: 'opus',
      ogg: 'opus',
      mp4: 'mp4',
      mov: 'mp4',
      avi: 'mp4',
      mkv: 'mp4',
      webm: 'mp4',
      pdf: 'pdf',
      doc: 'doc',
      docx: 'doc',
      xls: 'xls',
      xlsx: 'xls',
      csv: 'xls',
      ppt: 'ppt',
      pptx: 'ppt',
    }
    return typeMap[ext] ?? 'stream'
  }

  private buildInlineImageFailureNotice(failureCount: number): string {
    return failureCount === 1
      ? '有 1 张图片未能发送，请检查图片引用或稍后重试。'
      : `有 ${failureCount} 张图片未能发送，请检查图片引用或稍后重试。`
  }
}

/**
 * Feishu (Lark) channel — sends and receives messages via Feishu bot.
 */
export class FeishuChannel implements Channel {
  readonly name: string
  readonly type = 'feishu'

  private client: lark.Client | null = null
  private eventDispatcher: lark.EventDispatcher | null = null
  private wsClient: FeishuWsClient | null = null
  private connectionState: FeishuConnectionState
  private config: FeishuChannelConfig
  private incomingReceiver: FeishuIncomingEventReceiver
  private mediaDelivery: FeishuMediaDelivery
  private messageDelivery: FeishuMessageDelivery
  private streamingDelivery: FeishuStreamingDelivery
  private lifecycleGeneration = 0
  private runningRequested = false
  private activeStart: { generation: number; promise: Promise<void> } | null = null
  private recoveryPromise: Promise<void> | null = null

  constructor(
    config: FeishuChannelConfig,
    private readonly factories: FeishuChannelFactories = defaultFeishuChannelFactories,
  ) {
    this.config = config
    this.name = config.name ?? 'feishu'
    this.connectionState = new FeishuConnectionState(this.name)
    const incomingBuilder = new FeishuIncomingMessageBuilder({
      getClient: () => this.client,
      downloadsDir: config.downloadsDir,
    })
    this.incomingReceiver = new FeishuIncomingEventReceiver({
      channelName: this.name,
      incomingBuilder,
    })
    this.mediaDelivery = new FeishuMediaDelivery({
      getClient: () => this.client,
    })
    this.streamingDelivery = new FeishuStreamingDelivery({
      getClient: () => this.client,
      deliverUnresolvedInlineImages: (images, target, source) =>
        this.mediaDelivery.deliverUnresolvedInlineImages(images, target, source),
    })
    this.messageDelivery = new FeishuMessageDelivery({
      getClient: () => this.client,
      mediaDelivery: this.mediaDelivery,
    })
  }

  start(): Promise<void> {
    this.runningRequested = true

    if (this.recoveryPromise) return this.recoveryPromise

    const activeStart = this.activeStart
    if (activeStart?.generation === this.lifecycleGeneration) {
      return activeStart.promise
    }
    if (this.wsClient) return Promise.resolve()

    const generation = ++this.lifecycleGeneration
    const promise = this.startGeneration(generation)
    const trackedPromise = promise.finally(() => {
      if (this.activeStart?.promise === trackedPromise) {
        this.activeStart = null
      }
    })
    this.activeStart = { generation, promise: trackedPromise }
    return trackedPromise
  }

  async stop(): Promise<void> {
    this.runningRequested = false
    this.lifecycleGeneration++
    this.activeStart = null
    this.recoveryPromise = null

    const wsClient = this.detachClients()
    this.connectionState.reset()
    this.incomingReceiver.reset()
    wsClient?.close()
  }

  recover(): Promise<void> {
    this.runningRequested = true
    if (this.recoveryPromise) return this.recoveryPromise

    const promise = this.recoverTransport()
    const trackedPromise = promise.finally(() => {
      if (this.recoveryPromise === trackedPromise) {
        this.recoveryPromise = null
      }
    })
    this.recoveryPromise = trackedPromise
    return trackedPromise
  }

  async send(sessionId: string, content: string): Promise<void> {
    await this.messageDelivery.send(sessionId, content)
  }

  async sendStreaming(sessionId: string): Promise<FeishuStreamingSession> {
    return this.streamingDelivery.sendStreaming(sessionId)
  }

  async replyStreaming(messageId: string): Promise<FeishuStreamingSession> {
    return this.streamingDelivery.replyStreaming(messageId)
  }

  isConnected(): boolean {
    return this.connectionState.isConnected()
  }

  setMessageHandler(handler: MessageHandler): void {
    this.incomingReceiver.setMessageHandler(handler)
  }

  getCapabilities() {
    return {
      streaming: true,
      inlineImages: true,
      imageMessages: true,
      fileMessages: true,
      interactiveCards: true,
      mentions: true,
      reactions: true,
      threadReply: true,
      markdownNotes:
        'Feishu cards use a non-standard Markdown dialect. H1-H3 are not supported (use H4+). ' +
        'Inline images can be written with standard markdown using Feishu image keys (img_xxx), local absolute paths (/Users/...), file:// URIs, or http(s) URLs; the channel will auto-upload and convert them. ' +
        'Obsidian wikilink images ![[path]] are also supported and auto-converted.',
      maxMessageLength: 30000,
    }
  }

  /**
   * Add an emoji reaction to a message. Returns the reaction_id (for later removal) or null on failure.
   */
  async react(messageId: string, emojiType: string): Promise<string | null> {
    if (!this.client) return null
    try {
      const resp = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      })
      return (resp as { reaction_id?: string }).reaction_id ?? null
    } catch {
      return null
    }
  }

  /**
   * Remove a reaction by its reaction_id.
   */
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    if (!this.client) return
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      })
    } catch {}
  }

  /**
   * Reply to a specific message (quote-reply).
   */
  async reply(messageId: string, content: string): Promise<void> {
    await this.messageDelivery.reply(messageId, content)
  }

  /**
   * Upload an image buffer to Feishu and send it as an image message.
   * @param chatId - Target chat ID
   * @param image - Image buffer or local file path
   * @param replyToMessageId - Optional message ID to reply to
   */
  async sendImage(
    chatId: string,
    image: Buffer | string,
    replyToMessageId?: string,
  ): Promise<void> {
    await this.mediaDelivery.sendImage(chatId, image, replyToMessageId)
  }

  /**
   * Upload an image buffer to Feishu and return the image_key.
   * Does not send a message.
   */
  async uploadImage(image: Buffer): Promise<string | null> {
    return this.mediaDelivery.uploadImage(image)
  }

  /**
   * Upload a file to Feishu and send it as a file message.
   * @param chatId - Target chat ID
   * @param file - File buffer or local file path
   * @param fileName - Display name of the file
   * @param replyToMessageId - Optional message ID to reply to
   */
  async sendFile(
    chatId: string,
    file: Buffer | string,
    fileName: string,
    replyToMessageId?: string,
  ): Promise<void> {
    await this.mediaDelivery.sendFile(chatId, file, fileName, replyToMessageId)
  }

  private async recoverTransport(): Promise<void> {
    const generation = ++this.lifecycleGeneration
    this.activeStart = null

    const wsClient = this.detachClients()
    this.connectionState.reset()
    wsClient?.close({ force: true })

    if (!this.runningRequested || generation !== this.lifecycleGeneration) return
    await this.startGeneration(generation)
  }

  private async startGeneration(generation: number): Promise<void> {
    const sdkLogger = this.connectionState.createSdkLogger({
      isCurrent: () => this.runningRequested && generation === this.lifecycleGeneration,
    })
    const client = this.factories.createClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.error,
      logger: sdkLogger,
    })
    const eventDispatcher = this.factories.createEventDispatcher({
      encryptKey: this.config.encryptKey ?? '',
      verificationToken: this.config.verificationToken ?? '',
      loggerLevel: lark.LoggerLevel.error,
      logger: sdkLogger,
    })
    this.incomingReceiver.register(eventDispatcher)

    // Use WebSocket long connection for event delivery (no webhook/ngrok needed).
    const wsClient = this.factories.createWsClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.trace,
      logger: sdkLogger,
    })

    if (!this.runningRequested || generation !== this.lifecycleGeneration) {
      this.closeRetiredTransport(wsClient)
      return
    }

    this.client = client
    this.eventDispatcher = eventDispatcher
    this.wsClient = wsClient

    try {
      await wsClient.start({ eventDispatcher })
    } catch (error) {
      if (generation !== this.lifecycleGeneration || !this.runningRequested) {
        this.closeRetiredTransport(wsClient)
        return
      }

      this.lifecycleGeneration++
      if (this.wsClient === wsClient) {
        this.detachClients()
        this.connectionState.reset()
      }
      this.closeRetiredTransport(wsClient)
      throw error
    }

    if (
      generation !== this.lifecycleGeneration ||
      !this.runningRequested ||
      this.wsClient !== wsClient
    ) {
      this.closeRetiredTransport(wsClient)
    }
  }

  private detachClients(): FeishuWsClient | null {
    const wsClient = this.wsClient
    this.wsClient = null
    this.client = null
    this.eventDispatcher = null
    return wsClient
  }

  private closeRetiredTransport(wsClient: FeishuWsClient): void {
    try {
      wsClient.close({ force: true })
    } catch (error) {
      console.warn(
        `[FeishuChannel:${this.name}] Failed to close retired transport:`,
        describeError(error),
      )
    }
  }
}

type FeishuSdkLogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'

export class FeishuConnectionState {
  private connected = false

  constructor(private readonly channelName = 'feishu') {}

  isConnected(): boolean {
    return this.connected
  }

  reset(): void {
    this.connected = false
  }

  createSdkLogger(options: { isCurrent?: () => boolean } = {}) {
    const report = (level: FeishuSdkLogLevel, args: unknown[]) => {
      const message = this.describeLogValue(args)
      if (!message) return

      if (options.isCurrent?.() ?? true) {
        this.updateFromSdkLog(level, message)
      }
      if (level !== 'error' && level !== 'warn') return

      const log = level === 'error' ? console.error : console.warn
      log(`[FeishuSDK:${this.channelName}]`, message)
    }

    return {
      error: (...msg: unknown[]) => report('error', msg),
      warn: (...msg: unknown[]) => report('warn', msg),
      info: (...msg: unknown[]) => report('info', msg),
      debug: (...msg: unknown[]) => report('debug', msg),
      trace: (...msg: unknown[]) => report('trace', msg),
    }
  }

  updateFromSdkLog(level: FeishuSdkLogLevel, message: string): void {
    if (!message.includes('[ws]')) return

    const normalized = message.toLowerCase()
    if (normalized.includes('ws connect success') || normalized.includes('reconnect success')) {
      if (!this.connected) {
        console.log(`[FeishuChannel:${this.channelName}] WSClient connected`)
      }
      this.connected = true
      return
    }

    if (level === 'error') {
      this.connected = false
      return
    }

    if (
      normalized.includes('client closed') ||
      normalized.includes('ws error') ||
      normalized.includes('ws connect failed') ||
      normalized.includes('connect failed') ||
      normalized.includes('reconnect')
    ) {
      this.connected = false
    }
  }

  private describeLogValue(value: unknown): string {
    if (Array.isArray(value)) {
      return value
        .map((item) => this.describeLogValue(item))
        .filter(Boolean)
        .join(' | ')
    }

    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
      return String(value)
    }

    const errorSummary = describeError(value)
    if (errorSummary !== '[unknown error]') return errorSummary

    const objectName =
      value && typeof value === 'object' && 'constructor' in value
        ? (value as { constructor?: { name?: string } }).constructor?.name
        : undefined
    return objectName ? `[${objectName}]` : '[object]'
  }
}

interface FeishuIncomingEventReceiverOptions {
  channelName: string
  incomingBuilder: Pick<FeishuIncomingMessageBuilder, 'build' | 'buildRecalled'>
  processedMessages?: RecentMessageTracker
  recalledMessages?: RecentMessageTracker
}

export class FeishuIncomingEventReceiver {
  private messageHandler: MessageHandler | null = null
  private processedMessages: RecentMessageTracker
  private recalledMessages: RecentMessageTracker

  constructor(private readonly options: FeishuIncomingEventReceiverOptions) {
    this.processedMessages =
      options.processedMessages ?? new RecentMessageTracker({ maxSize: 1000 })
    this.recalledMessages = options.recalledMessages ?? new RecentMessageTracker({ maxSize: 1000 })
  }

  register(dispatcher: lark.EventDispatcher): void {
    dispatcher.register({
      'im.message.receive_v1': (data: unknown) => this.handleReceived(data),
      'im.message.recalled_v1': (data: unknown) => this.handleRecalled(data),
    })
  }

  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  reset(): void {
    this.processedMessages.clear()
    this.recalledMessages.clear()
  }

  async handle(data: unknown): Promise<void> {
    await this.handleReceived(data)
  }

  async handleReceived(data: unknown): Promise<void> {
    const handler = this.messageHandler
    if (!handler) return

    try {
      const event = this.unwrapEvent<FeishuIncomingEventPayload>(data)
      const msg = event?.message
      if (!msg) {
        console.warn('[FeishuChannel] Received event with no message payload')
        return
      }

      const messageId = msg.message_id
      if (this.recalledMessages.has(messageId)) {
        console.log('[FeishuChannel] Skipping recalled message:', messageId)
        return
      }
      if (!this.processedMessages.shouldProcess(messageId ? `receive:${messageId}` : undefined)) {
        console.log('[FeishuChannel] Skipping duplicate message:', messageId)
        return
      }

      console.log(
        `[FeishuChannel:${this.options.channelName}] im.message.receive_v1 from ${
          event?.sender?.sender_id?.open_id ?? 'unknown'
        } chat=${msg.chat_id ?? 'unknown'} message=${messageId ?? 'unknown'} type=${
          msg.message_type ?? 'unknown'
        }`,
      )

      const incoming = await this.options.incomingBuilder.build(data)
      if (!incoming) return

      // Fire-and-forget: return immediately so SDK sends ACK within 3s.
      handler(incoming).catch((err) => {
        console.error('[FeishuChannel] Async handler error:', describeError(err))
      })
    } catch (err) {
      console.error('[FeishuChannel] Error handling im.message.receive_v1:', describeError(err))
    }
  }

  async handleRecalled(data: unknown): Promise<void> {
    const handler = this.messageHandler
    if (!handler) return

    try {
      const event = this.unwrapEvent<{
        message_id?: string
        chat_id?: string
        recall_type?: string
      }>(data)
      const messageId = event?.message_id
      if (!messageId) {
        console.warn('[FeishuChannel] Received recall event with no message_id')
        return
      }

      this.recalledMessages.remember(messageId)
      if (!this.processedMessages.shouldProcess(`recall:${messageId}`)) {
        console.log('[FeishuChannel] Skipping duplicate recall event:', messageId)
        return
      }

      console.log(
        `[FeishuChannel:${this.options.channelName}] im.message.recalled_v1 chat=${
          event?.chat_id ?? 'unknown'
        } message=${messageId} type=${event?.recall_type ?? 'unknown'}`,
      )

      const incoming = await this.options.incomingBuilder.buildRecalled(data)
      if (!incoming) return

      handler(incoming).catch((err) => {
        console.error('[FeishuChannel] Async recall handler error:', describeError(err))
      })
    } catch (err) {
      console.error('[FeishuChannel] Error handling im.message.recalled_v1:', describeError(err))
    }
  }

  private unwrapEvent<T>(data: unknown): T | undefined {
    if (typeof data !== 'object' || data === null) return undefined

    const maybeWrapped = data as { event?: unknown }
    if (maybeWrapped.event && typeof maybeWrapped.event === 'object') {
      return maybeWrapped.event as T
    }

    return data as T
  }
}

interface FeishuMessageDeliveryOptions {
  getClient: () => lark.Client | null
  mediaDelivery: FeishuMediaDelivery
}

class FeishuMessageDelivery {
  constructor(private readonly options: FeishuMessageDeliveryOptions) {}

  async send(chatId: string, content: string): Promise<void> {
    if (!this.client) return

    const card = detectFeishuCardJson(content)
    if (card) {
      try {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
        })
        return
      } catch (error) {
        console.warn(
          '[FeishuChannel] Card JSON send failed, falling back to text:',
          describeError(error),
        )
      }
    }

    const { rendered, unresolvedImages } = await this.prepareContent(content)
    const isNotification = content.startsWith('[notification]')
    const cleanContent = isNotification ? rendered.replace('[notification]', '').trim() : rendered
    const options = isNotification
      ? { title: 'ZeRo OS Notification', template: 'orange' as const }
      : undefined

    if (cleanContent.trim()) {
      const chunks = chunkFeishuRichContent(cleanContent, options)
      for (let i = 0; i < chunks.length; i++) {
        await sendCreateWithFallback(this.client, chatId, chunks[i], i === 0 ? options : undefined)
      }
    }

    await this.options.mediaDelivery.deliverUnresolvedInlineImages(
      unresolvedImages,
      { chatId },
      'send',
    )
  }

  async reply(messageId: string, content: string): Promise<void> {
    if (!this.client) return

    const card = detectFeishuCardJson(content)
    if (card) {
      try {
        await this.client.im.message.reply({
          path: { message_id: messageId },
          data: { content: JSON.stringify(card), msg_type: 'interactive' },
        })
        return
      } catch (error) {
        console.warn(
          '[FeishuChannel] Card JSON reply failed, falling back to text:',
          describeError(error),
        )
      }
    }

    const { rendered, unresolvedImages } = await this.prepareContent(content)
    if (rendered.trim()) {
      for (const chunk of chunkFeishuRichContent(rendered)) {
        await sendReplyWithFallback(this.client, messageId, chunk)
      }
    }

    await this.options.mediaDelivery.deliverUnresolvedInlineImages(
      unresolvedImages,
      { replyToMessageId: messageId },
      'reply',
    )
  }

  private async prepareContent(
    content: string,
  ): Promise<{ rendered: string; unresolvedImages: FeishuImageReference[] }> {
    let rendered = renderMarkdownForFeishu(content, { preserveExternalImages: true })
    let unresolvedImages: FeishuImageReference[] = []

    if (this.client) {
      const resolver = new FeishuImageResolver({ client: this.client })
      if (resolver.hasImages(rendered)) {
        const originalRendered = rendered
        rendered = await resolver.resolveAll(originalRendered, 30_000)
        unresolvedImages = resolver.collectUnresolved(originalRendered)
      }
    }

    return { rendered, unresolvedImages }
  }

  private get client(): lark.Client | null {
    return this.options.getClient()
  }
}

interface FeishuStreamingDeliveryOptions {
  getClient: () => lark.Client | null
  deliverUnresolvedInlineImages: (
    images: FeishuImageReference[],
    target: FeishuImageTarget,
    source: 'streaming',
  ) => Promise<void>
}

class FeishuStreamingDelivery {
  constructor(private readonly options: FeishuStreamingDeliveryOptions) {}

  async sendStreaming(sessionId: string): Promise<FeishuStreamingSession> {
    const client = this.getRequiredClient()
    return this.createSession(
      client,
      async (cardId) => {
        const response = await client.im.message.create({
          data: {
            receive_id: sessionId,
            msg_type: 'interactive',
            content: buildFeishuCardReferenceContent(cardId),
          },
          params: { receive_id_type: 'chat_id' },
        })
        return response.data?.message_id ?? null
      },
      { chatId: sessionId },
    )
  }

  async replyStreaming(messageId: string): Promise<FeishuStreamingSession> {
    const client = this.getRequiredClient()
    return this.createSession(
      client,
      async (cardId) => {
        const response = await client.im.message.reply({
          path: { message_id: messageId },
          data: {
            msg_type: 'interactive',
            content: buildFeishuCardReferenceContent(cardId),
          },
        })
        return response.data?.message_id ?? null
      },
      { replyToMessageId: messageId },
    )
  }

  private createSession(
    client: lark.Client,
    attachMessage: (cardId: string) => Promise<string | null>,
    fallbackTarget: FeishuImageTarget,
  ): Promise<FeishuStreamingSession> {
    return createFeishuStreamingSession({
      client,
      attachMessage,
      fallbackTarget,
      deliverUnresolvedInlineImages: this.options.deliverUnresolvedInlineImages,
      deleteMessage: (messageId) => this.deleteMessage(messageId),
    })
  }

  private async deleteMessage(messageId: string): Promise<void> {
    const client = this.options.getClient()
    if (!client) return

    await client.im.message.delete({
      path: { message_id: messageId },
    })
  }

  private getRequiredClient(): lark.Client {
    const client = this.options.getClient()
    if (!client) {
      throw new Error('Feishu client not initialized')
    }
    return client
  }
}
