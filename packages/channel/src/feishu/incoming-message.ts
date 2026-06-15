import type { Readable } from 'node:stream'
import type * as lark from '@larksuiteoapi/node-sdk'
import { describeError } from '@zero-os/shared'
import type { FileAttachment, ImageAttachment, IncomingMessage } from '../base'
import {
  extractTextFromJson,
  isPureImagePlaceholder,
  removeImagePlaceholders,
  truncateText,
} from './content-utils'
import { parseInteractiveCardContent as parseFeishuInteractiveCardContent } from './interactive-card-parser'

export interface FeishuMessagePayload {
  message_id?: string
  chat_id?: string
  chat_type?: string
  message_type?: string
  create_time?: string | number
  content?: string
  /** The message ID being replied to (quote-reply). */
  parent_id?: string
}

export interface FeishuIncomingEventPayload {
  sender?: {
    sender_id?: {
      open_id?: string
    }
  }
  message?: FeishuMessagePayload
}

export interface FeishuMessageRecalledEventPayload {
  message_id?: string
  chat_id?: string
  recall_time?: string | number
  recall_type?: string
}

interface FeishuWrappedEventPayload<T> {
  header?: {
    create_time?: string | number
  }
  event?: T
}

export interface ParsedFeishuIncomingContent {
  content: string
  images: ImageAttachment[]
  files: FileAttachment[]
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

interface FeishuIncomingMessageBuilderOptions {
  getClient: () => lark.Client | null
  downloadsDir?: string
}

interface FeishuBinaryResponse {
  getReadableStream: () => Readable
  headers?: unknown
}

export class FeishuIncomingMessageBuilder {
  private readonly mediaDownloader: FeishuIncomingMediaDownloader
  private readonly quotedMessageResolver: FeishuQuotedMessageResolver

  constructor(private readonly options: FeishuIncomingMessageBuilderOptions) {
    this.mediaDownloader = new FeishuIncomingMediaDownloader(options)
    this.quotedMessageResolver = new FeishuQuotedMessageResolver(options)
  }

  async build(data: unknown): Promise<IncomingMessage | null> {
    const event = unwrapFeishuEvent<FeishuIncomingEventPayload>(data)
    const msg = event?.message
    if (!msg) {
      console.warn('[FeishuChannel] Received event with no message payload')
      return null
    }

    const parsed = await parseFeishuIncomingMessageContent(msg, this.mediaDownloader)
    let { content } = parsed
    const { files, images } = parsed

    if (msg.parent_id) {
      const quotedContent = await this.quotedMessageResolver
        .fetchQuotedContent(msg.parent_id)
        .catch((err) => {
          console.warn('[FeishuChannel] Failed to resolve quoted message:', describeError(err))
          return null
        })
      if (quotedContent) {
        content = `${formatFeishuQuotedContent(quotedContent)}\n\n${content}`
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

  async buildRecalled(data: unknown): Promise<IncomingMessage | null> {
    const event = unwrapFeishuEvent<FeishuMessageRecalledEventPayload>(data)
    const messageId = event?.message_id
    const chatId = event?.chat_id
    if (!messageId || !chatId) {
      console.warn('[FeishuChannel] Received recall event without message_id or chat_id')
      return null
    }

    const recalledAt = normalizeFeishuEventTime(event.recall_time) ?? new Date().toISOString()

    return {
      channelType: 'feishu',
      eventType: 'message_recalled',
      senderId: 'unknown',
      content: '',
      timestamp: recalledAt,
      metadata: {
        eventType: 'message_recalled',
        chatId,
        messageId,
        recallTime: recalledAt,
        recallType: event.recall_type,
      },
    }
  }
}

function unwrapFeishuEvent<T>(data: unknown): T | undefined {
  if (!data || typeof data !== 'object') return undefined

  const wrapped = data as FeishuWrappedEventPayload<T>
  if (wrapped.event && typeof wrapped.event === 'object') return wrapped.event

  return data as T
}

function normalizeFeishuEventTime(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null || value === '') return undefined

  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined

  const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric
  return new Date(millis).toISOString()
}

class FeishuIncomingMediaDownloader {
  constructor(private readonly options: FeishuIncomingMessageBuilderOptions) {}

  async downloadMessageImage(
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

  async downloadMessageFile(
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
        this.options.downloadsDir ?? join(process.cwd(), '.zero', 'workspace', 'uploads')
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
      console.error(`[FeishuChannel] Failed to download file "${fileName}":`, describeError(error))
      return null
    }
  }

  private get client(): lark.Client | null {
    return this.options.getClient()
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
}

async function parseFeishuIncomingMessageContent(
  msg: FeishuMessagePayload,
  mediaDownloader: FeishuIncomingMediaDownloader,
): Promise<ParsedFeishuIncomingContent> {
  const messageId = typeof msg.message_id === 'string' ? msg.message_id : ''
  const images: ParsedFeishuIncomingContent['images'] = []
  const files: ParsedFeishuIncomingContent['files'] = []
  let content = ''

  if (msg.message_type === 'text') {
    content = parseFeishuTextMessageContent(msg)
  } else if (msg.message_type === 'post') {
    content = await parseFeishuPostMessageContent(msg, messageId, mediaDownloader, images)
  } else if (msg.message_type === 'image') {
    content = await parseFeishuImageMessageContent(msg, messageId, mediaDownloader, images)
  } else if (msg.message_type === 'file') {
    content = await parseFeishuFileMessageContent(msg, messageId, mediaDownloader, files)
  } else {
    content = `[${msg.message_type} message]`
  }

  return { content, images, files }
}

function parseFeishuTextMessageContent(msg: FeishuMessagePayload): string {
  try {
    const parsed = JSON.parse(msg.content ?? '{}')
    return parsed.text ?? ''
  } catch (parseErr) {
    console.error('[FeishuChannel] Failed to parse message content:', describeError(parseErr))
    return msg.content ?? ''
  }
}

async function parseFeishuPostMessageContent(
  msg: FeishuMessagePayload,
  messageId: string,
  mediaDownloader: FeishuIncomingMediaDownloader,
  images: ImageAttachment[],
): Promise<string> {
  try {
    const parsed = JSON.parse(msg.content ?? '{}')
    const pendingImages: ImageAttachment[] = []
    let content = parseFeishuPostContent(parsed, pendingImages)

    if (messageId) {
      const downloads = pendingImages
        .filter((image) => image.mediaType === '__pending__')
        .map((image) =>
          mediaDownloader.downloadMessageImage(
            messageId,
            image.data,
            'Failed to download post image',
          ),
        )
      const resolvedImages = await Promise.all(downloads)
      images.push(...resolvedImages.filter((image): image is ImageAttachment => image !== null))
    }

    if (images.length > 0) {
      content = removeImagePlaceholders(content)
    }

    if (images.length === 0 && isPureImagePlaceholder(content)) {
      content = '[图片下载失败]'
    }

    return content
  } catch (parseErr) {
    console.error(
      '[FeishuChannel] Failed to parse post content:',
      describeError(parseErr),
      'raw:',
      truncateText(msg.content ?? '', 200),
    )
    return msg.content ?? ''
  }
}

async function parseFeishuImageMessageContent(
  msg: FeishuMessagePayload,
  messageId: string,
  mediaDownloader: FeishuIncomingMediaDownloader,
  images: ImageAttachment[],
): Promise<string> {
  try {
    const parsed = JSON.parse(msg.content ?? '{}')
    const imageKey = typeof parsed.image_key === 'string' ? parsed.image_key : ''
    const image =
      imageKey && messageId
        ? await mediaDownloader.downloadMessageImage(
            messageId,
            imageKey,
            'Failed to download image message',
          )
        : null

    if (image) {
      images.push(image)
      return ''
    }
    return '[图片下载失败]'
  } catch (parseErr) {
    console.error('[FeishuChannel] Failed to parse image message content:', describeError(parseErr))
    return '[图片下载失败]'
  }
}

async function parseFeishuFileMessageContent(
  msg: FeishuMessagePayload,
  messageId: string,
  mediaDownloader: FeishuIncomingMediaDownloader,
  files: ParsedFeishuIncomingContent['files'],
): Promise<string> {
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
        ? await mediaDownloader.downloadMessageFile(messageId, fileKey, fileName)
        : null

    if (file) {
      files.push(file)
      return `[文件: ${file.fileName}]`
    }
    return `[文件: ${fileName}] 下载失败`
  } catch (parseErr) {
    console.error('[FeishuChannel] Failed to parse file message content:', describeError(parseErr))
    return '[文件消息解析失败]'
  }
}

function parseFeishuPostContent(parsed: unknown, images: ImageAttachment[]): string {
  if (!parsed || typeof parsed !== 'object') {
    return extractTextFromJson(parsed)
  }

  const payload = parsed as {
    zh_cn?: { title?: string; content?: FeishuPostElement[][] }
    en_us?: { title?: string; content?: FeishuPostElement[][] }
    content?: FeishuPostElement[][]
    title?: string
    [key: string]: unknown
  }

  const doc = resolvePostDocument(payload)
  if (!doc?.content || !Array.isArray(doc.content)) {
    console.warn(
      '[FeishuChannel] Unrecognized post structure:',
      JSON.stringify(payload).slice(0, 200),
    )
    return extractTextFromJson(payload)
  }

  const parts: string[] = []
  if (doc.title) parts.push(`# ${doc.title}`)

  for (const paragraph of doc.content) {
    if (!Array.isArray(paragraph)) continue
    const line = paragraph.map((el) => parsePostElement(el, images)).join('')
    if (line) parts.push(line)
  }

  const result = parts.join('\n\n')
  if (result.trim()) return result

  console.warn(
    '[FeishuChannel] Post parsed but empty, extracting raw text:',
    JSON.stringify(payload).slice(0, 200),
  )
  return extractTextFromJson(payload)
}

function resolvePostDocument(payload: {
  zh_cn?: { title?: string; content?: FeishuPostElement[][] }
  en_us?: { title?: string; content?: FeishuPostElement[][] }
  content?: FeishuPostElement[][]
  title?: string
  [key: string]: unknown
}):
  | {
      title?: string
      content?: FeishuPostElement[][]
    }
  | undefined {
  if (isPostDocument(payload.zh_cn)) return payload.zh_cn
  if (isPostDocument(payload.en_us)) return payload.en_us

  for (const val of Object.values(payload)) {
    if (isPostDocument(val)) return val
  }

  return Array.isArray(payload.content) ? payload : undefined
}

function isPostDocument(value: unknown): value is {
  title?: string
  content?: FeishuPostElement[][]
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  )
}

function parsePostElement(el: unknown, images: ImageAttachment[]): string {
  if (!el || typeof el !== 'object') return ''
  const element = el as FeishuPostElement

  switch (element.tag) {
    case 'text': {
      let text = element.text ?? ''
      const style = element.style
      if (style?.includes('bold')) text = `**${text}**`
      if (style?.includes('italic')) text = `*${text}*`
      if (style?.includes('lineThrough')) text = `~~${text}~~`
      if (style?.includes('underline')) text = `<u>${text}</u>`
      return text
    }
    case 'a':
      return element.href ? `[${element.text ?? ''}](${element.href})` : (element.text ?? '')
    case 'img':
      if (element.image_key) {
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
      return element.text ?? ''
  }
}

class FeishuQuotedMessageResolver {
  constructor(private readonly options: FeishuIncomingMessageBuilderOptions) {}

  async fetchQuotedContent(parentMessageId: string): Promise<string | null> {
    if (!this.client) return null

    try {
      const response = await (
        this.client as unknown as { request: (opts: unknown) => Promise<unknown> }
      ).request({
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

      const [item] = data.data.items
      if (!item) return null

      return this.parseQuotedItemText(item).trim() || null
    } catch (error) {
      console.warn('[FeishuChannel] Failed to fetch quoted message:', describeError(error))
      return null
    }
  }

  private get client(): lark.Client | null {
    return this.options.getClient()
  }

  private parseQuotedItemText(item: {
    msg_type?: string
    body?: { content?: string }
  }): string {
    const msgType = item.msg_type ?? 'text'
    const rawContent = item.body?.content ?? '{}'

    if (msgType === 'text') {
      return parseQuotedText(rawContent)
    }
    if (msgType === 'post') {
      return parseQuotedPost(rawContent)
    }
    if (msgType === 'image') {
      return '[图片]'
    }
    if (msgType === 'file') {
      return parseQuotedFile(rawContent)
    }
    if (msgType === 'merge_forward') {
      return '[合并转发消息]'
    }
    if (msgType === 'interactive') {
      return parseFeishuInteractiveCardContent(rawContent)
    }
    return `[${msgType}]`
  }
}

function formatFeishuQuotedContent(quotedContent: string): string {
  const maxLen = 500
  const truncated =
    quotedContent.length > maxLen
      ? `${quotedContent.slice(0, maxLen)}…（原文共 ${quotedContent.length} 字，已截断）`
      : quotedContent
  return `> 引用: ${truncated}`
}

function parseQuotedText(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent)
    return parsed.text ?? rawContent
  } catch {
    return rawContent
  }
}

function parseQuotedPost(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent)
    const dummyImages: ImageAttachment[] = []
    const textContent = parseFeishuPostContent(parsed, dummyImages)
    return removeImagePlaceholders(textContent)
  } catch {
    return rawContent
  }
}

function parseQuotedFile(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent)
    return `[文件: ${parsed.file_name ?? 'unknown'}]`
  } catch {
    return '[文件]'
  }
}
