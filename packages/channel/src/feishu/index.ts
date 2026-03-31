import type { Readable } from 'node:stream'
import * as lark from '@larksuiteoapi/node-sdk'
import { describeError } from '@zero-os/shared'
import type {
  Channel,
  FileAttachment,
  ImageAttachment,
  IncomingMessage,
  MessageHandler,
} from '../base'
import { renderMarkdownForFeishu } from '../richtext/feishu'
import type { FeishuImageReference } from './image-resolver'
import { FeishuImageResolver } from './image-resolver'

export interface FeishuChannelConfig {
  name?: string
  appId: string
  appSecret: string
  encryptKey?: string
  verificationToken?: string
  /** Directory for saving downloaded file attachments. */
  downloadsDir?: string
}

export interface FeishuStreamingSession {
  /** Push accumulated text (not delta). CardKit diffs automatically. */
  update(fullText: string): Promise<void>
  /** Finalize the card: disable streaming mode, show final content. */
  complete(finalText: string): Promise<void>
  /** Abort the streaming card (e.g. on error). */
  abort(errorMessage?: string): Promise<void>
  /** Delete the attached streaming card message without showing an error state. */
  dismiss(): Promise<void>
  /** The card's message_id in the chat (available after first update). */
  readonly messageId: string | null
}

interface FeishuCardOptions {
  title?: string
  template?: string
}

interface FeishuBinaryResponse {
  getReadableStream: () => Readable
  headers?: unknown
}

interface FeishuMessagePayload {
  message_id?: string
  chat_id?: string
  chat_type?: string
  message_type?: string
  create_time?: string | number
  content?: string
  /** The message ID being replied to (quote-reply). */
  parent_id?: string
}

interface FeishuPostElement {
  tag?: string
  text?: string
  style?: string[]
  href?: string
  image_key?: string
  user_name?: string
  user_id?: string
  file_name?: string
  emoji_type?: string
}

interface FeishuImageTarget {
  chatId?: string
  replyToMessageId?: string
}

/**
 * Feishu (Lark) channel — sends and receives messages via Feishu bot.
 */
export class FeishuChannel implements Channel {
  readonly name: string
  readonly type = 'feishu'

  private client: lark.Client | null = null
  private eventDispatcher: lark.EventDispatcher | null = null
  private wsClient: lark.WSClient | null = null
  private messageHandler: MessageHandler | null = null
  private connected = false
  private config: FeishuChannelConfig
  private processedMessageIds: Set<string> = new Set()
  private static readonly MAX_TEXT_MESSAGE_BYTES = 150 * 1024
  private static readonly MAX_RICH_MESSAGE_BYTES = 30 * 1024
  private static readonly STREAMING_UPDATE_INTERVAL_MS = 300
  private static readonly STREAMING_ELEMENT_ID = 'streaming_content'

  constructor(config: FeishuChannelConfig) {
    this.config = config
    this.name = config.name ?? 'feishu'
  }

  async start(): Promise<void> {
    const sdkLogger = this.createSdkLogger()

    this.client = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.error,
      logger: sdkLogger,
    })

    this.eventDispatcher = new lark.EventDispatcher({
      encryptKey: this.config.encryptKey ?? '',
      verificationToken: this.config.verificationToken ?? '',
      loggerLevel: lark.LoggerLevel.error,
      logger: sdkLogger,
    })

    // Listen for incoming messages
    this.eventDispatcher.register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          if (!this.messageHandler) return

          const event =
            typeof data === 'object' && data !== null
              ? (data as {
                  sender?: {
                    sender_id?: {
                      open_id?: string
                    }
                  }
                  message?: FeishuMessagePayload
                })
              : undefined

          const msg = event?.message
          if (!msg) {
            console.warn('[FeishuChannel] Received event with no message payload')
            return
          }

          // Dedup: skip if this message_id was already processed
          const messageId = msg.message_id
          if (messageId && this.processedMessageIds.has(messageId)) {
            console.log('[FeishuChannel] Skipping duplicate message:', messageId)
            return
          }
          if (messageId) {
            this.processedMessageIds.add(messageId)
            // Prevent unbounded growth — trim oldest entry when exceeding 1000
            if (this.processedMessageIds.size > 1000) {
              const first = this.processedMessageIds.values().next().value
              if (first !== undefined) {
                this.processedMessageIds.delete(first)
              }
            }
          }

          console.log(
            '[FeishuChannel] im.message.receive_v1 from',
            event?.sender?.sender_id?.open_id ?? 'unknown',
          )
          const incoming = await this.buildIncomingMessage(data)
          if (!incoming) return

          // Fire-and-forget: return immediately so SDK sends ACK within 3s
          this.messageHandler(incoming).catch((err) => {
            console.error('[FeishuChannel] Async handler error:', describeError(err))
          })
        } catch (err) {
          console.error(
            '[FeishuChannel] Error handling im.message.receive_v1:',
            describeError(err),
          )
        }
      },
    })

    // Use WebSocket long connection for event delivery (no webhook/ngrok needed)
    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.trace,
      logger: sdkLogger,
    })
    await this.wsClient.start({ eventDispatcher: this.eventDispatcher })
  }

  async stop(): Promise<void> {
    this.wsClient?.close()
    this.wsClient = null
    this.connected = false
    this.client = null
    this.eventDispatcher = null
    this.processedMessageIds.clear()
  }

  async send(sessionId: string, content: string): Promise<void> {
    if (!this.client) return

    const card = this.detectCardJson(content)
    if (card) {
      const cardContent = JSON.stringify(card)
      try {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' as any },
          data: { receive_id: sessionId, msg_type: 'interactive', content: cardContent },
        })
        return
      } catch (error) {
        console.warn(
          '[FeishuChannel] Card JSON send failed, falling back to text:',
          describeError(error),
        )
      }
    }

    let rendered = renderMarkdownForFeishu(content, { preserveExternalImages: true })
    let unresolvedImages: FeishuImageReference[] = []

    // Resolve image references (URL / local path → img_key)
    if (this.client && new FeishuImageResolver({ client: this.client }).hasImages(rendered)) {
      const resolver = new FeishuImageResolver({ client: this.client })
      const originalRendered = rendered
      rendered = await resolver.resolveAll(originalRendered, 30_000)
      unresolvedImages = resolver.collectUnresolved(originalRendered)
    }

    const isNotification = content.startsWith('[notification]')
    const cleanContent = isNotification ? rendered.replace('[notification]', '').trim() : rendered
    const options = isNotification
      ? { title: 'ZeRo OS Notification', template: 'orange' }
      : undefined
    if (cleanContent.trim()) {
      const chunks = this.chunkRichContent(cleanContent, options)

      for (let i = 0; i < chunks.length; i++) {
        const chunkOptions = i === 0 ? options : undefined
        await this.sendCreateWithFallback(sessionId, chunks[i], chunkOptions)
      }
    }

    await this.deliverUnresolvedInlineImages(unresolvedImages, { chatId: sessionId }, 'send')
  }

  async sendStreaming(sessionId: string): Promise<FeishuStreamingSession> {
    return this.createStreamingSession(
      async (cardId) => {
        const response = await this.client!.im.message.create({
          data: {
            receive_id: sessionId,
            msg_type: 'interactive',
            content: this.buildCardReferenceContent(cardId),
          },
          params: { receive_id_type: 'chat_id' },
        })
        return response.data?.message_id ?? null
      },
      { chatId: sessionId },
    )
  }

  async replyStreaming(messageId: string): Promise<FeishuStreamingSession> {
    return this.createStreamingSession(
      async (cardId) => {
        const response = await this.client!.im.message.reply({
          path: { message_id: messageId },
          data: {
            msg_type: 'interactive',
            content: this.buildCardReferenceContent(cardId),
          },
        })
        return response.data?.message_id ?? null
      },
      { replyToMessageId: messageId },
    )
  }

  isConnected(): boolean {
    return this.connected
  }

  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler
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

  private async buildIncomingMessage(data: unknown): Promise<IncomingMessage | null> {
    const event =
      typeof data === 'object' && data !== null
        ? (data as {
            sender?: {
              sender_id?: {
                open_id?: string
              }
            }
            message?: FeishuMessagePayload
          })
        : undefined
    const msg = event?.message
    if (!msg) {
      console.warn('[FeishuChannel] Received event with no message payload')
      return null
    }

    const messageId = typeof msg.message_id === 'string' ? msg.message_id : ''
    let content = ''
    const images: ImageAttachment[] = []
    const files: FileAttachment[] = []

    if (msg.message_type === 'text') {
      try {
        const parsed = JSON.parse(msg.content ?? '{}')
        content = parsed.text ?? ''
      } catch (parseErr) {
        console.error(
          '[FeishuChannel] Failed to parse message content:',
          describeError(parseErr),
        )
        content = msg.content ?? ''
      }
    } else if (msg.message_type === 'post') {
      try {
        const parsed = JSON.parse(msg.content ?? '{}')
        const pendingImages: ImageAttachment[] = []
        content = this.parsePostContent(parsed, pendingImages)

        if (messageId) {
          const downloads = pendingImages
            .filter((image) => image.mediaType === '__pending__')
            .map((image) =>
              this.downloadMessageImage(messageId, image.data, 'Failed to download post image'),
            )
          const resolvedImages = await Promise.all(downloads)
          images.push(...resolvedImages.filter((image): image is ImageAttachment => image !== null))
        }

        if (images.length > 0) {
          content = this.removeImagePlaceholders(content)
        }

        if (images.length === 0 && this.isPureImagePlaceholder(content)) {
          content = '[图片下载失败]'
        }
      } catch (parseErr) {
        console.error(
          '[FeishuChannel] Failed to parse post content:',
          describeError(parseErr),
          'raw:',
          this.truncate(msg.content ?? '', 200),
        )
        content = msg.content ?? ''
      }
    } else if (msg.message_type === 'image') {
      try {
        const parsed = JSON.parse(msg.content ?? '{}')
        const imageKey = typeof parsed.image_key === 'string' ? parsed.image_key : ''
        const image =
          imageKey && messageId
            ? await this.downloadMessageImage(
                messageId,
                imageKey,
                'Failed to download image message',
              )
            : null

        if (image) {
          images.push(image)
          content = ''
        } else {
          content = '[图片下载失败]'
        }
      } catch (parseErr) {
        console.error(
          '[FeishuChannel] Failed to parse image message content:',
          describeError(parseErr),
        )
        content = '[图片下载失败]'
      }
    } else if (msg.message_type === 'file') {
      try {
        const parsed = JSON.parse(msg.content ?? '{}') as {
          file_key?: unknown
          file_name?: unknown
        }
        const fileKey = typeof parsed.file_key === 'string' ? parsed.file_key : ''
        const fileName =
          typeof parsed.file_name === 'string' && parsed.file_name.trim()
            ? parsed.file_name
            : 'unknown-file'
        const file =
          fileKey && messageId
            ? await this.downloadMessageFile(messageId, fileKey, fileName)
            : null

        if (file) {
          files.push(file)
          content = `[文件: ${file.fileName}]`
        } else {
          content = `[文件: ${fileName}] 下载失败`
        }
      } catch (parseErr) {
        console.error(
          '[FeishuChannel] Failed to parse file message content:',
          describeError(parseErr),
        )
        content = '[文件消息解析失败]'
      }
    } else {
      content = `[${msg.message_type} message]`
    }

    // Resolve quoted / replied-to message content
    if (msg.parent_id) {
      const quotedContent = await this.fetchQuotedContent(msg.parent_id).catch((err) => {
        console.warn('[FeishuChannel] Failed to resolve quoted message:', describeError(err))
        return null
      })
      if (quotedContent) {
        // Truncate long quoted content to avoid wasting context window
        const maxLen = 500
        const truncated =
          quotedContent.length > maxLen
            ? `${quotedContent.slice(0, maxLen)}…（原文共 ${quotedContent.length} 字，已截断）`
            : quotedContent
        content = `> 引用: ${truncated}\n\n${content}`
      }
    }

    return {
      channelType: 'feishu',
      senderId: event?.sender?.sender_id?.open_id ?? 'unknown',
      content,
      timestamp: new Date(Number(msg.create_time) * 1000).toISOString(),
      metadata: {
        chatId: msg.chat_id,
        messageId: msg.message_id,
        chatType: msg.chat_type,
        parentId: msg.parent_id,
      },
      images: images.length > 0 ? images : undefined,
      files: files.length > 0 ? files : undefined,
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
    if (!this.client) return

    const card = this.detectCardJson(content)
    if (card) {
      const cardContent = JSON.stringify(card)
      try {
        await this.client.im.message.reply({
          path: { message_id: messageId },
          data: { content: cardContent, msg_type: 'interactive' },
        })
        return
      } catch (error) {
        console.warn(
          '[FeishuChannel] Card JSON reply failed, falling back to text:',
          describeError(error),
        )
      }
    }

    let rendered = renderMarkdownForFeishu(content, { preserveExternalImages: true })
    let unresolvedImages: FeishuImageReference[] = []

    // Resolve image references (URL / local path → img_key)
    if (this.client && new FeishuImageResolver({ client: this.client }).hasImages(rendered)) {
      const resolver = new FeishuImageResolver({ client: this.client })
      const originalRendered = rendered
      rendered = await resolver.resolveAll(originalRendered, 30_000)
      unresolvedImages = resolver.collectUnresolved(originalRendered)
    }

    if (rendered.trim()) {
      const chunks = this.chunkRichContent(rendered)
      for (const chunk of chunks) {
        await this.sendReplyWithFallback(messageId, chunk)
      }
    }

    await this.deliverUnresolvedInlineImages(unresolvedImages, { replyToMessageId: messageId }, 'reply')
  }

  /**
   * Upload an image buffer to Feishu and send it as an image message.
   * @param chatId - Target chat ID
   * @param image - Image buffer or local file path
   * @param replyToMessageId - Optional message ID to reply to
   */
  async sendImage(chatId: string, image: Buffer | string, replyToMessageId?: string): Promise<void> {
    await this.sendImageMessage(image, { chatId, replyToMessageId })
  }

  /**
   * Upload an image buffer to Feishu and return the image_key.
   * Does not send a message.
   */
  async uploadImage(image: Buffer): Promise<string | null> {
    if (!this.client) return null

    const resolver = new FeishuImageResolver({ client: this.client })
    return resolver.uploadBuffer(image)
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
    if (!this.client) return

    try {
      const fileBuffer =
        typeof file === 'string' ? (await import('node:fs')).readFileSync(file) : file

      const fileType = this.detectFileType(fileName)

      const { Readable } = await import('node:stream')
      const uploadResp = await this.client.im.file.create({
        data: {
          file_type: fileType,
          file_name: fileName,
          file: Readable.from(fileBuffer),
        } as any,
      })

      const fileKey = (uploadResp as any)?.data?.file_key ?? (uploadResp as any)?.file_key
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
          params: { receive_id_type: 'chat_id' as any },
          data: { receive_id: chatId, msg_type: 'file', content },
        })
      }

      console.log(`[FeishuChannel] File "${fileName}" sent successfully`)
    } catch (error) {
      console.error('[FeishuChannel] Failed to send file:', describeError(error))
    }
  }

  private async deleteMessage(messageId: string): Promise<void> {
    if (!this.client) return
    await this.client.im.message.delete({
      path: { message_id: messageId },
    })
  }

  /**
   * Detect if text content is a complete Feishu card JSON.
   * Supports v1 (Message Card), v2 (CardKit), and template cards.
   * Returns the parsed card object or null.
   */
  private detectCardJson(text: string): Record<string, unknown> | null {
    const trimmed = text.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null

    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

      const card = parsed as Record<string, unknown>
      const data =
        typeof card.data === 'object' && card.data !== null
          ? (card.data as Record<string, unknown>)
          : null

      if (card.schema === '2.0') return card

      if (
        Array.isArray(card.elements) &&
        (card.config !== undefined || card.header !== undefined)
      ) {
        return card
      }

      if (card.type === 'template' && data?.template_id) return card

      if (
        (card.msg_type === 'interactive' || card.type === 'interactive') &&
        typeof card.card === 'object' &&
        card.card !== null &&
        !Array.isArray(card.card)
      ) {
        return card.card as Record<string, unknown>
      }

      return null
    } catch {
      return null
    }
  }

  /** Build JSON 2.0 interactive card payload. */
  private buildMarkdownCardV2(content: string, options?: FeishuCardOptions): string {
    const card: Record<string, unknown> = {
      schema: '2.0',
      body: {
        direction: 'vertical',
        elements: [{ tag: 'markdown', content }],
      },
    }

    if (options?.title) {
      card.header = {
        title: { tag: 'plain_text', content: options.title },
        ...(options.template ? { template: options.template } : {}),
      }
    }

    return JSON.stringify(card)
  }

  private buildStreamingCardV2(summary = 'Thinking...'): string {
    return JSON.stringify({
      schema: '2.0',
      config: {
        streaming_mode: true,
        summary: { content: summary },
      },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: '',
            text_align: 'left',
            element_id: FeishuChannel.STREAMING_ELEMENT_ID,
          },
        ],
      },
    })
  }

  private buildFinalStreamingCardV2(content: string): string {
    return JSON.stringify({
      schema: '2.0',
      body: {
        elements: [
          {
            tag: 'markdown',
            content,
            text_align: 'left',
          },
        ],
      },
    })
  }

  private buildCardReferenceContent(cardId: string): string {
    return JSON.stringify({
      type: 'card',
      data: {
        card_id: cardId,
      },
    })
  }

  /** Build post payload with md tag for fallback. */
  private buildPostContent(content: string, options?: FeishuCardOptions): string {
    const zhCn: Record<string, unknown> = {
      content: [[{ tag: 'md', text: content }]],
    }
    if (options?.title) {
      zhCn.title = options.title
    }
    return JSON.stringify({ zh_cn: zhCn })
  }

  /** Build text payload as last fallback. */
  private buildTextContent(content: string, options?: FeishuCardOptions): string {
    if (!options?.title) {
      return JSON.stringify({ text: content })
    }

    const text = content ? `${options.title}\n\n${content}` : options.title
    return JSON.stringify({ text })
  }

  /**
   * Split message by line with byte-size guard for rich payloads.
   * This avoids hitting Feishu's 30KB post/interactive limit.
   */
  private chunkRichContent(content: string, options?: FeishuCardOptions): string[] {
    const chunks = this.splitByLinePreserveLimit(
      content,
      FeishuChannel.MAX_RICH_MESSAGE_BYTES,
      (chunk) => this.buildMarkdownCardV2(chunk),
    )

    if (options?.title && chunks.length > 0) {
      const firstPayload = this.buildMarkdownCardV2(chunks[0], options)
      if (this.byteLength(firstPayload) > FeishuChannel.MAX_RICH_MESSAGE_BYTES) {
        const firstChunks = this.splitByLinePreserveLimit(
          chunks[0],
          FeishuChannel.MAX_RICH_MESSAGE_BYTES,
          (chunk) => this.buildMarkdownCardV2(chunk, options),
        )
        chunks.splice(0, 1, ...firstChunks)
      }
    }

    return chunks
  }

  private splitByLinePreserveLimit(
    content: string,
    maxBytes: number,
    payloadBuilder: (chunk: string) => string,
  ): string[] {
    if (this.byteLength(payloadBuilder(content)) <= maxBytes) {
      return [content]
    }

    const lines = content.split('\n')
    const chunks: string[] = []
    let current = ''

    for (const line of lines) {
      const candidate = current ? `${current}\n${line}` : line
      if (current && this.byteLength(payloadBuilder(candidate)) > maxBytes) {
        chunks.push(current)
        current = ''
      }

      if (this.byteLength(payloadBuilder(line)) <= maxBytes) {
        current = current ? `${current}\n${line}` : line
        continue
      }

      if (current) {
        chunks.push(current)
        current = ''
      }

      let remaining = line
      while (remaining.length > 0) {
        const prefix = this.takeLargestPrefix(remaining, maxBytes, payloadBuilder)
        if (!prefix) {
          chunks.push(remaining)
          remaining = ''
          continue
        }
        chunks.push(prefix)
        remaining = remaining.slice(prefix.length)
      }
    }

    if (current) {
      chunks.push(current)
    }

    return chunks.length > 0 ? chunks : [content]
  }

  private takeLargestPrefix(
    content: string,
    maxBytes: number,
    payloadBuilder: (chunk: string) => string,
  ): string {
    let lo = 1
    let hi = content.length
    let best = 0

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      const sample = content.slice(0, mid)
      if (this.byteLength(payloadBuilder(sample)) <= maxBytes) {
        best = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }

    return best > 0 ? content.slice(0, best) : ''
  }

  private byteLength(value: string): number {
    return Buffer.byteLength(value, 'utf8')
  }

  /**
   * Detect Feishu file type from file extension.
   */
  private detectFileType(fileName: string): string {
    const ext = fileName.toLowerCase().split('.').pop() ?? ''
    const typeMap: Record<string, string> = {
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

  private async sendImageMessage(
    image: Buffer | string,
    target: FeishuImageTarget,
  ): Promise<boolean> {
    if (!this.client) return false

    try {
      const imageBuffer =
        typeof image === 'string' ? (await import('node:fs')).readFileSync(image) : image

      const { Readable } = await import('node:stream')
      const uploadResp = await this.client.im.image.create({
        data: {
          image_type: 'message',
          image: Readable.from(imageBuffer) as any,
        },
      })

      const imageKey = (uploadResp as any)?.data?.image_key ?? (uploadResp as any)?.image_key
      if (!imageKey) {
        console.warn('[FeishuChannel] Image upload failed: no image_key in response')
        return false
      }

      const content = JSON.stringify({ image_key: imageKey })

      if (target.replyToMessageId) {
        await this.client.im.message.reply({
          path: { message_id: target.replyToMessageId },
          data: { content, msg_type: 'image' },
        })
      } else if (target.chatId) {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' as any },
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

  private async sendImageReference(
    reference: string,
    target: FeishuImageTarget,
  ): Promise<boolean> {
    // Normalize file:// URIs to local paths (e.g. file:///Users/foo/bar.png → /Users/foo/bar.png)
    const normalizedRef = reference.startsWith('file://')
      ? (() => {
          try {
            return new URL(reference).pathname
          } catch {
            return reference.replace(/^file:\/\//, '')
          }
        })()
      : reference

    if (normalizedRef.startsWith('http://') || normalizedRef.startsWith('https://')) {
      try {
        const resp = await fetch(normalizedRef, { signal: AbortSignal.timeout(15_000) })
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}`)
        }
        return await this.sendImageMessage(Buffer.from(await resp.arrayBuffer()), target)
      } catch (error) {
        console.warn(
          `[FeishuChannel] Failed to fetch fallback image ${normalizedRef}:`,
          describeError(error),
        )
        return false
      }
    }

    if (normalizedRef.startsWith('data:')) {
      const match = normalizedRef.match(/^data:[^;,]+;base64,([\s\S]+)$/)
      if (!match) {
        console.warn('[FeishuChannel] Unsupported inline image data URI')
        return false
      }
      return this.sendImageMessage(Buffer.from(match[1], 'base64'), target)
    }

    return this.sendImageMessage(normalizedRef, target)
  }

  private async deliverUnresolvedInlineImages(
    images: FeishuImageReference[],
    target: FeishuImageTarget,
    source: 'send' | 'reply' | 'streaming',
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
      await this.sendReplyWithFallback(target.replyToMessageId, notice)
    } else if (target.chatId) {
      await this.sendCreateWithFallback(target.chatId, notice)
    }

    console.warn(
      `[FeishuChannel] ${source} inline image fallback incomplete: ${failures} image(s) failed`,
    )
  }

  private buildInlineImageFailureNotice(failureCount: number): string {
    return failureCount === 1
      ? '有 1 张图片未能发送，请检查图片引用或稍后重试。'
      : `有 ${failureCount} 张图片未能发送，请检查图片引用或稍后重试。`
  }

  private async createStreamingSession(
    attachMessage: (cardId: string) => Promise<string | null>,
    fallbackTarget: FeishuImageTarget,
  ): Promise<FeishuStreamingSession> {
    if (!this.client) {
      throw new Error('Feishu client not initialized')
    }

    const cardId = await this.createStreamingCard()
    let initialMessageId: string | null = null
    try {
      initialMessageId = await attachMessage(cardId)
    } catch (error) {
      console.warn('[FeishuChannel] streaming card attach failed:', describeError(error))
      throw error
    }
    const client = this.client
    let messageId = initialMessageId
    let sequence = 0
    let closed = false
    let pendingText: string | null = null
    let latestRenderedText: string | null = null
    let lastDeliveredText: string | null = null
    let lastFlushAt = 0
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let scheduledFlush: Promise<void> | null = null
    let resolveScheduledFlush: (() => void) | null = null
    let flushChain: Promise<void> = Promise.resolve()
    const renderStreamingMarkdown = (text: string) =>
      renderMarkdownForFeishu(text, { preserveExternalImages: true })
    const imageResolver = new FeishuImageResolver({
      client,
      onImageResolved: () => {
        if (closed || latestRenderedText == null) return
        pendingText = latestRenderedText
        scheduleFlush()
      },
    })

    const clearFlushTimer = () => {
      if (!flushTimer) return
      clearTimeout(flushTimer)
      flushTimer = null
    }

    const markScheduledFlushDone = () => {
      resolveScheduledFlush?.()
      resolveScheduledFlush = null
      scheduledFlush = null
    }

    const nextSequence = () => {
      const current = sequence
      sequence += 1
      return current
    }

    const flushPending = async () => {
      clearFlushTimer()
      const text = pendingText
      const resolvedText = text == null ? null : imageResolver.resolveSync(text)
      if (resolvedText == null) {
        markScheduledFlushDone()
        return
      }

      if (resolvedText === lastDeliveredText) {
        pendingText = null
        markScheduledFlushDone()
        return
      }

      pendingText = null
      try {
        await client.cardkit.v1.cardElement.content({
          data: {
            content: resolvedText,
            sequence: nextSequence(),
          },
          path: {
            card_id: cardId,
            element_id: FeishuChannel.STREAMING_ELEMENT_ID,
          },
        })
        lastDeliveredText = resolvedText
        lastFlushAt = Date.now()
      } catch (error) {
        pendingText = text
        console.warn('[FeishuChannel] streaming update failed:', describeError(error))
      } finally {
        markScheduledFlushDone()
      }
    }

    const scheduleFlush = () => {
      if (closed) return
      if (flushTimer || pendingText == null) return

      const elapsed = Date.now() - lastFlushAt
      const delay = Math.max(0, FeishuChannel.STREAMING_UPDATE_INTERVAL_MS - elapsed)
      scheduledFlush ??= new Promise<void>((resolve) => {
        resolveScheduledFlush = resolve
      })

      flushTimer = setTimeout(() => {
        flushTimer = null
        flushChain = flushChain.then(() => flushPending())
      }, delay)
    }

    const finalizeCard = async (
      content: string,
      logLabel: string,
      options?: { alreadyClosed?: boolean },
    ) => {
      if (!options?.alreadyClosed) {
        if (closed) return
        closed = true
        pendingText = null
        clearFlushTimer()
        markScheduledFlushDone()
      }

      try {
        await flushChain
        await client.cardkit.v1.card.update({
          data: {
            card: {
              type: 'card_json',
              data: this.buildFinalStreamingCardV2(content),
            },
            sequence: nextSequence(),
          },
          path: { card_id: cardId },
        })
        lastDeliveredText = content
      } catch (error) {
        console.warn(`[FeishuChannel] ${logLabel}:`, describeError(error))
      }
    }

    const teardown = () => {
      if (closed) return false
      closed = true
      pendingText = null
      clearFlushTimer()
      markScheduledFlushDone()
      return true
    }

    return {
      get messageId() {
        return messageId
      },
      update: async (fullText: string) => {
        if (closed) return
        latestRenderedText = renderStreamingMarkdown(fullText)
        pendingText = latestRenderedText
        scheduleFlush()
      },
      complete: async (finalText: string) => {
        const rendered = renderStreamingMarkdown(finalText)
        latestRenderedText = rendered
        let unresolvedImages: FeishuImageReference[] = []
        const finalRendered =
          imageResolver.hasImages(rendered) || imageResolver.pendingCount > 0
            ? await imageResolver.resolveAll(rendered, 30_000)
            : imageResolver.resolveSync(rendered)
        unresolvedImages = imageResolver.collectUnresolved(rendered)
        await finalizeCard(finalRendered, 'streaming completion failed')
        await this.deliverUnresolvedInlineImages(unresolvedImages, fallbackTarget, 'streaming')
      },
      abort: async (errorMessage?: string) => {
        if (!teardown()) return
        let rendered = renderMarkdownForFeishu(
          errorMessage?.trim() || 'An error occurred while generating the response.',
        )
        rendered = imageResolver.resolveSync(rendered)
        await finalizeCard(rendered, 'streaming abort failed', { alreadyClosed: true })
      },
      dismiss: async () => {
        if (!teardown()) return

        try {
          await flushChain
          if (messageId) {
            await this.deleteMessage(messageId)
          }
        } catch (error) {
          console.warn('[FeishuChannel] streaming dismiss failed:', describeError(error))
        }
      },
    }
  }

  private async createStreamingCard(): Promise<string> {
    if (!this.client) {
      throw new Error('Feishu client not initialized')
    }

    try {
      const response = await this.client.cardkit.v1.card.create({
        data: {
          type: 'card_json',
          data: this.buildStreamingCardV2(),
        },
      })
      const cardId = response.data?.card_id
      if (!cardId) {
        throw new Error('CardKit create returned no card_id')
      }
      return cardId
    } catch (error) {
      console.warn('[FeishuChannel] streaming card create failed:', describeError(error))
      throw error
    }
  }

  private async sendCreateWithFallback(
    sessionId: string,
    content: string,
    options?: FeishuCardOptions,
  ): Promise<void> {
    if (!this.client) return

    const interactiveContent = this.buildMarkdownCardV2(content, options)
    if (this.byteLength(interactiveContent) <= FeishuChannel.MAX_RICH_MESSAGE_BYTES) {
      try {
        await this.client.im.message.create({
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

    const postContent = this.buildPostContent(content, options)
    if (this.byteLength(postContent) <= FeishuChannel.MAX_RICH_MESSAGE_BYTES) {
      try {
        await this.client.im.message.create({
          data: {
            receive_id: sessionId,
            msg_type: 'post',
            content: postContent,
          },
          params: { receive_id_type: 'chat_id' },
        })
        return
      } catch (postErr) {
        console.warn(
          '[FeishuChannel] post send failed, fallback to text:',
          describeError(postErr),
        )
      }
    } else {
      console.warn('[FeishuChannel] post payload exceeds size limit, fallback to text')
    }

    const textChunks = this.splitByLinePreserveLimit(
      content,
      FeishuChannel.MAX_TEXT_MESSAGE_BYTES,
      (chunk) => this.buildTextContent(chunk, options),
    )
    for (let i = 0; i < textChunks.length; i++) {
      await this.client.im.message.create({
        data: {
          receive_id: sessionId,
          msg_type: 'text',
          content: this.buildTextContent(textChunks[i], i === 0 ? options : undefined),
        },
        params: { receive_id_type: 'chat_id' },
      })
    }
  }

  private async sendReplyWithFallback(messageId: string, content: string): Promise<void> {
    if (!this.client) return

    const interactiveContent = this.buildMarkdownCardV2(content)
    if (this.byteLength(interactiveContent) <= FeishuChannel.MAX_RICH_MESSAGE_BYTES) {
      try {
        await this.client.im.message.reply({
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

    const postContent = this.buildPostContent(content)
    if (this.byteLength(postContent) <= FeishuChannel.MAX_RICH_MESSAGE_BYTES) {
      try {
        await this.client.im.message.reply({
          path: { message_id: messageId },
          data: {
            content: postContent,
            msg_type: 'post',
          },
        })
        return
      } catch (postErr) {
        console.warn(
          '[FeishuChannel] post reply failed, fallback to text:',
          describeError(postErr),
        )
      }
    } else {
      console.warn('[FeishuChannel] post reply payload exceeds size limit, fallback to text')
    }

    try {
      const textChunks = this.splitByLinePreserveLimit(
        content,
        FeishuChannel.MAX_TEXT_MESSAGE_BYTES,
        (chunk) => this.buildTextContent(chunk),
      )
      for (const textChunk of textChunks) {
        await this.client.im.message.reply({
          path: { message_id: messageId },
          data: {
            content: this.buildTextContent(textChunk),
            msg_type: 'text',
          },
        })
      }
    } catch (textErr) {
      console.error('[FeishuChannel] text reply fallback failed:', describeError(textErr))
      throw textErr
    }
  }

  private createSdkLogger() {
    const report = (
      level: 'error' | 'warn' | 'info' | 'debug' | 'trace',
      args: unknown[],
    ) => {
      const message = this.describeLogValue(args)
      if (!message) return
      this.updateConnectionStateFromSdkLog(level, message)
      if (level !== 'error' && level !== 'warn') return
      const log = level === 'error' ? console.error : console.warn
      log('[FeishuSDK]', message)
    }

    return {
      error: (...msg: unknown[]) => report('error', msg),
      warn: (...msg: unknown[]) => report('warn', msg),
      info: (...msg: unknown[]) => report('info', msg),
      debug: (...msg: unknown[]) => report('debug', msg),
      trace: (...msg: unknown[]) => report('trace', msg),
    }
  }

  private updateConnectionStateFromSdkLog(
    level: 'error' | 'warn' | 'info' | 'debug' | 'trace',
    message: string,
  ): void {
    if (!message.includes('[ws]')) return

    const normalized = message.toLowerCase()
    if (normalized.includes('ws connect success') || normalized.includes('reconnect success')) {
      if (!this.connected) {
        console.log('[FeishuChannel] WSClient connected')
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

  /**
   * Fetch the text content of a quoted (replied-to) message.
   * Uses the IM mget API to retrieve the message, then parses its content
   * into a human-readable text string.
   *
   * Returns `"senderName: content"` when sender info is available,
   * or just `content` otherwise. Returns null on any failure.
   */
  private async fetchQuotedContent(parentMessageId: string): Promise<string | null> {
    if (!this.client) return null

    try {
      // Use mget API (supports batch, but we only need one)
      const response = await (this.client as unknown as { request: (opts: unknown) => Promise<unknown> }).request({
        method: 'GET',
        url: '/open-apis/im/v1/messages/mget',
        params: {
          message_ids: parentMessageId,
          user_id_type: 'open_id',
        },
      })

      const data = response as {
        code?: number
        data?: {
          items?: Array<{
            msg_type?: string
            body?: { content?: string }
            sender?: { id?: string; sender_type?: string }
          }>
        }
      }

      if (data.code !== 0 || !data.data?.items?.length) return null

      const item = data.data.items[0]!
      const msgType = item.msg_type ?? 'text'
      const rawContent = item.body?.content ?? '{}'

      // Parse the content based on message type
      let textContent: string

      if (msgType === 'text') {
        try {
          const parsed = JSON.parse(rawContent)
          textContent = parsed.text ?? rawContent
        } catch {
          textContent = rawContent
        }
      } else if (msgType === 'post') {
        try {
          const parsed = JSON.parse(rawContent)
          const dummyImages: ImageAttachment[] = []
          textContent = this.parsePostContent(parsed, dummyImages)
          // Strip image placeholders from quoted content
          textContent = this.removeImagePlaceholders(textContent)
        } catch {
          textContent = rawContent
        }
      } else if (msgType === 'image') {
        textContent = '[图片]'
      } else if (msgType === 'file') {
        try {
          const parsed = JSON.parse(rawContent)
          textContent = `[文件: ${parsed.file_name ?? 'unknown'}]`
        } catch {
          textContent = '[文件]'
        }
      } else if (msgType === 'merge_forward') {
        textContent = '[合并转发消息]'
      } else if (msgType === 'interactive') {
        textContent = this.parseInteractiveCardContent(rawContent)
      } else {
        textContent = `[${msgType}]`
      }

      return textContent.trim() || null
    } catch (error) {
      console.warn(
        '[FeishuChannel] Failed to fetch quoted message:',
        describeError(error),
      )
      return null
    }
  }

  private async downloadMessageImage(
    messageId: string,
    fileKey: string,
    logContext: string,
  ): Promise<ImageAttachment | null> {
    if (!this.client) return null

    try {
      const response = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'image' },
      })
      return await this.readBinaryResponse(response)
    } catch (error) {
      console.error(`[FeishuChannel] ${logContext}:`, describeError(error))
      return null
    }
  }

  private async downloadMessageFile(
    messageId: string,
    fileKey: string,
    fileName: string,
  ): Promise<FileAttachment | null> {
    if (!this.client) return null

    try {
      const response = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'file' },
      })

      const buffer = await this.readResponseBuffer(response as FeishuBinaryResponse)

      const { mkdirSync, writeFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      const uploadsDir =
        this.config.downloadsDir ?? join(process.cwd(), '.zero', 'workspace', 'uploads')
      mkdirSync(uploadsDir, { recursive: true })

      const timestamp = Date.now()
      const safeFileName = fileName.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_')
      const localPath = join(uploadsDir, `${timestamp}_${safeFileName}`)
      writeFileSync(localPath, buffer)

      console.log(
        `[FeishuChannel] File "${fileName}" downloaded to ${localPath} (${buffer.length} bytes)`,
      )

      return {
        fileName,
        localPath,
        size: buffer.length,
      }
    } catch (error) {
      console.error(
        `[FeishuChannel] Failed to download file "${fileName}":`,
        describeError(error),
      )
      return null
    }
  }

  private async readResponseBuffer(response: FeishuBinaryResponse): Promise<Buffer> {
    const stream = response.getReadableStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  private async readBinaryResponse(response: FeishuBinaryResponse): Promise<ImageAttachment> {
    const buffer = await this.readResponseBuffer(response)
    return {
      mediaType: this.getResponseMediaType(response.headers),
      data: buffer.toString('base64'),
    }
  }

  private getResponseMediaType(headers: unknown): string {
    const contentType = this.getHeaderValue(headers, 'content-type')
    if (!contentType) return 'image/png'
    return contentType.split(';')[0]?.trim() || 'image/png'
  }

  private getHeaderValue(headers: unknown, headerName: string): string | undefined {
    if (!headers || typeof headers !== 'object') return undefined

    const lowerName = headerName.toLowerCase()
    const withGetter = headers as { get?: (name: string) => unknown }
    if (typeof withGetter.get === 'function') {
      const value = withGetter.get(headerName) ?? withGetter.get(lowerName)
      return typeof value === 'string' ? value : undefined
    }

    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== lowerName) continue
      if (typeof value === 'string') return value
      if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
    }

    return undefined
  }

  private describeLogValue(value: unknown): string {
    if (Array.isArray(value)) {
      return value
        .map((item) => this.describeLogValue(item))
        .filter(Boolean)
        .join(' | ')
    }

    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean' || value == null)
      return String(value)

    const errorSummary = describeError(value)
    if (errorSummary !== '[unknown error]') return errorSummary

    const objectName =
      value && typeof value === 'object' && 'constructor' in value
        ? (value as { constructor?: { name?: string } }).constructor?.name
        : undefined
    return objectName ? `[${objectName}]` : '[object]'
  }

  private isPureImagePlaceholder(content: string): boolean {
    const normalized = this.removeImagePlaceholders(content).replace(/\s+/g, '')
    return normalized.length === 0 && content.replace(/\s+/g, '').length > 0
  }

  private removeImagePlaceholders(content: string): string {
    return content
      .replace(/^\s*\[(?:图片|Image(?:\s*#?\d+)?)\]\s*$/gim, '')
      .replace(/(?:\r?\n){3,}/g, '\n\n')
      .trim()
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value
    return `${value.slice(0, Math.max(0, maxLength - 1))}…`
  }

  private isPostDocument(value: unknown): value is {
    title?: string
    content?: FeishuPostElement[][]
  } {
    return (
      typeof value === 'object' &&
      value !== null &&
      Array.isArray((value as { content?: unknown }).content)
    )
  }

  /**
   * Parse Feishu post (rich text) message into Markdown text + image attachments.
   *
   * Standard format: { "zh_cn": { "title": "...", "content": [[elements]] } }
   * Also handles: top-level { "title", "content" } without locale wrapper.
   */
  private parsePostContent(parsed: unknown, images: ImageAttachment[]): string {
    if (!parsed || typeof parsed !== 'object') {
      return this.extractTextFromJson(parsed)
    }

    const payload = parsed as {
      zh_cn?: { title?: string; content?: FeishuPostElement[][] }
      en_us?: { title?: string; content?: FeishuPostElement[][] }
      content?: FeishuPostElement[][]
      title?: string
      [key: string]: unknown
    }

    // Resolve locale wrapper: zh_cn > en_us > first locale-shaped value > top-level
    let doc:
      | {
          title?: string
          content?: FeishuPostElement[][]
        }
      | undefined
    if (this.isPostDocument(payload.zh_cn)) {
      doc = payload.zh_cn
    } else if (this.isPostDocument(payload.en_us)) {
      doc = payload.en_us
    } else {
      // Try each top-level value for a locale-shaped object { content: [[...]] }
      for (const val of Object.values(payload)) {
        if (this.isPostDocument(val)) {
          doc = val
          break
        }
      }
      // Fallback: top-level { content: [[...]] } without locale key
      if (!doc && Array.isArray(payload.content)) {
        doc = payload
      }
    }

    if (!doc?.content || !Array.isArray(doc.content)) {
      console.warn(
        '[FeishuChannel] Unrecognized post structure:',
        JSON.stringify(payload).slice(0, 200),
      )
      // Last resort: recursively extract all text values from the JSON
      return this.extractTextFromJson(payload)
    }

    const parts: string[] = []
    if (doc.title) parts.push(`# ${doc.title}`)

    for (const paragraph of doc.content) {
      if (!Array.isArray(paragraph)) continue
      const lineParts: string[] = []
      for (const el of paragraph) {
        lineParts.push(this.parsePostElement(el, images))
      }
      const line = lineParts.join('')
      if (line) parts.push(line)
    }

    const result = parts.join('\n\n')
    if (result.trim()) return result

    // Parsing succeeded structurally but no text extracted — extract from raw JSON
    console.warn(
      '[FeishuChannel] Post parsed but empty, extracting raw text:',
      JSON.stringify(payload).slice(0, 200),
    )
    return this.extractTextFromJson(payload)
  }

  /**
   * Convert a single post element to Markdown.
   */
  private parsePostElement(el: unknown, images: ImageAttachment[]): string {
    if (!el || typeof el !== 'object') return ''
    const element = el as FeishuPostElement

    switch (element.tag) {
      case 'text': {
        let t = element.text ?? ''
        const s = element.style
        if (s?.includes('bold')) t = `**${t}**`
        if (s?.includes('italic')) t = `*${t}*`
        if (s?.includes('lineThrough')) t = `~~${t}~~`
        if (s?.includes('underline')) t = `<u>${t}</u>`
        return t
      }
      case 'a':
        return element.href ? `[${element.text ?? ''}](${element.href})` : (element.text ?? '')
      case 'img':
        // Image download is async — handled separately by caller if client is available
        if (element.image_key) {
          // Queue image for download (caller handles async download)
          images.push({ mediaType: '__pending__', data: element.image_key })
        }
        return '[图片]'
      case 'at':
        return `@${element.user_name ?? element.user_id ?? 'user'}`
      case 'media':
        return `[${element.file_name ?? 'media'}]`
      case 'emotion':
        return element.emoji_type ? `:${element.emoji_type}:` : ''
      default:
        // Unknown tag — extract text if present
        return element.text ?? ''
    }
  }

  private parseInteractiveCardContent(rawJson: string): string {
    const fallback = '[卡片消息]'
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value)

    const getContentText = (value: unknown): string => {
      if (typeof value === 'string') return value.trim()
      if (!isRecord(value)) return ''
      return typeof value.content === 'string' ? value.content.trim() : ''
    }

    const joinTextBlocks = (parts: string[]): string =>
      parts
        .map((part) => part.trim())
        .filter(Boolean)
        .join('\n\n')

    const collectCardKitTexts = (elements: unknown): string[] => {
      if (!Array.isArray(elements)) return []

      const texts: string[] = []
      for (const element of elements) {
        if (!isRecord(element)) continue

        if (element.tag === 'markdown' && typeof element.content === 'string') {
          const content = element.content.trim()
          if (content) texts.push(content)
          continue
        }

        if (element.tag === 'column_set' && Array.isArray(element.columns)) {
          for (const column of element.columns) {
            if (!isRecord(column)) continue
            texts.push(...collectCardKitTexts(column.elements))
          }
          continue
        }

        if (Array.isArray(element.elements)) {
          texts.push(...collectCardKitTexts(element.elements))
        }
      }

      return texts
    }

    const collectLegacyCardTexts = (elements: unknown): string[] => {
      if (!Array.isArray(elements)) return []

      const getLegacyElementText = (element: Record<string, unknown>): string => {
        const nestedText = getContentText(element.text)
        if (nestedText) return nestedText

        if (element.tag === 'plain_text') {
          return getContentText(element)
        }

        return ''
      }

      const texts: string[] = []
      for (const element of elements) {
        if (!isRecord(element)) continue

        if (element.tag === 'markdown' && typeof element.content === 'string') {
          const content = element.content.trim()
          if (content) texts.push(content)
          continue
        }

        if (element.tag === 'div') {
          const content = getContentText(element.text)
          if (content) texts.push(content)
          continue
        }

        if (element.tag === 'note' && Array.isArray(element.elements)) {
          texts.push(...collectLegacyCardTexts(element.elements))
          continue
        }

        const directText = getLegacyElementText(element)
        if (directText) texts.push(directText)

        if (Array.isArray(element.elements)) {
          texts.push(...collectLegacyCardTexts(element.elements))
        }
      }

      return texts
    }

    const parseCard = (card: unknown): string => {
      if (!isRecord(card)) return fallback

      if (card.type === 'template') return fallback

      if (card.type === 'card' && isRecord(card.data) && typeof card.data.card_id === 'string') {
        return fallback
      }

      if (
        (card.msg_type === 'interactive' || card.type === 'interactive') &&
        isRecord(card.card)
      ) {
        return parseCard(card.card)
      }

      if (card.schema === '2.0') {
        const parts: string[] = []
        const title = isRecord(card.header) ? getContentText(card.header.title) : ''
        if (title) parts.push(`# ${title}`)

        const bodyElements = isRecord(card.body) ? card.body.elements : undefined
        const body = joinTextBlocks(collectCardKitTexts(bodyElements))
        if (body) parts.push(body)

        return joinTextBlocks(parts) || fallback
      }

      if (Array.isArray(card.elements) && (card.config !== undefined || card.header !== undefined)) {
        const parts: string[] = []
        const title = isRecord(card.header) ? getContentText(card.header.title) : ''
        if (title) parts.push(`# ${title}`)

        const body = joinTextBlocks(collectLegacyCardTexts(card.elements))
        if (body) parts.push(body)

        return joinTextBlocks(parts) || fallback
      }

      const extracted = this.extractTextFromJson(card).trim()
      return extracted || fallback
    }

    try {
      return parseCard(JSON.parse(rawJson))
    } catch {
      return fallback
    }
  }

  /**
   * Recursively extract all text values from an arbitrary JSON structure.
   * Used as last-resort when standard post parsing fails.
   */
  private extractTextFromJson(obj: unknown): string {
    if (typeof obj === 'string') return obj
    if (!obj || typeof obj !== 'object') return ''
    const texts: string[] = []
    for (const val of Object.values(obj)) {
      if (typeof val === 'string' && val.trim()) {
        texts.push(val)
      } else if (typeof val === 'object' && val !== null) {
        const nested = this.extractTextFromJson(val)
        if (nested) texts.push(nested)
      }
    }
    return texts.join(' ')
  }
}
