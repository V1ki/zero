import type { FileAttachment, ImageAttachment, IncomingMessage } from '../base'

export interface DingtalkMediaDownloadRequest {
  downloadCode: string
  robotCode?: string
  fileName?: string
  mediaType?: string
}

export interface DingtalkDownloadedMedia {
  buffer: Buffer
  mediaType: string
  fileName?: string
}

export interface DingtalkRobotMessage {
  conversationId?: string
  conversationTitle?: string
  conversationType?: string | number
  chatbotCorpId?: string
  chatbotUserId?: string
  msgId?: string
  messageId?: string
  senderNick?: string
  isAdmin?: boolean
  senderStaffId?: string
  sessionWebhookExpiredTime?: number | string
  createAt?: number | string
  senderCorpId?: string
  senderId?: string
  sessionWebhook?: string
  robotCode?: string
  msgtype?: string
  text?: {
    content?: string
  }
  markdown?: {
    title?: string
    text?: string
  }
  richText?: DingtalkRichTextElement[]
  content?: string
  title?: string
  fileName?: string
  downloadCode?: string
  pictureDownloadCode?: string
  originalMsgId?: string
  isReplyMsg?: boolean
  repliedMsg?: DingtalkRepliedMessage
  [key: string]: unknown
}

export interface DingtalkRepliedMessage {
  createdAt?: number | string
  senderId?: string
  senderStaffId?: string
  msgId?: string
  messageId?: string
  msgType?: string
  msgtype?: string
  content?: unknown
  text?: unknown
  richText?: DingtalkRichTextElement[]
  [key: string]: unknown
}

export interface DingtalkRichTextElement {
  type?: string
  text?: string
  content?: string
  downloadCode?: string
  pictureDownloadCode?: string
  fileName?: string
  mediaType?: string
  [key: string]: unknown
}

export interface DingtalkRecallEventPayload {
  eventType?: string
  conversationId?: string
  openConversationId?: string
  chatId?: string
  msgId?: string
  messageId?: string
  recallMsgId?: string
  recallTime?: number | string
  createAt?: number | string
  recallType?: string
  operatorId?: string
  senderId?: string
  senderStaffId?: string
  [key: string]: unknown
}

export interface DingtalkIncomingMessageBuilderOptions {
  downloadMedia?: (request: DingtalkMediaDownloadRequest) => Promise<DingtalkDownloadedMedia | null>
  saveFile?: (media: DingtalkDownloadedMedia, fileName: string) => Promise<FileAttachment>
}

export class DingtalkIncomingMessageBuilder {
  constructor(private readonly options: DingtalkIncomingMessageBuilderOptions = {}) {}

  async build(data: unknown): Promise<IncomingMessage | null> {
    const msg = parseDingtalkRobotMessage(data)
    if (!msg) {
      console.warn('[DingtalkChannel] Received callback without robot message payload')
      return null
    }

    const parsed = await parseDingtalkIncomingContent(msg, this.options)
    const messageId = readString(msg.msgId) ?? readString(msg.messageId)
    const conversationId = readString(msg.conversationId)
    const senderId = readString(msg.senderStaffId) ?? readString(msg.senderId) ?? 'unknown'
    const reply = extractDingtalkReplyReference(msg)

    return {
      channelType: 'dingtalk',
      senderId,
      content: parsed.content,
      timestamp: normalizeDingtalkEventTime(msg.createAt) ?? new Date().toISOString(),
      metadata: {
        chatId: conversationId,
        conversationId,
        conversationTitle: readString(msg.conversationTitle),
        conversationType: readStringOrNumber(msg.conversationType),
        messageId,
        msgtype: readString(msg.msgtype),
        senderNick: readString(msg.senderNick),
        senderStaffId: readString(msg.senderStaffId),
        senderId: readString(msg.senderId),
        senderCorpId: readString(msg.senderCorpId),
        sessionWebhook: readString(msg.sessionWebhook),
        sessionWebhookExpiredTime: readNumber(msg.sessionWebhookExpiredTime),
        robotCode: readString(msg.robotCode),
        originalMsgId: reply?.originalMsgId,
        parentId: reply?.repliedMsgId,
        quotedMessageId: reply?.repliedMsgId,
        quotedMessageType: reply?.repliedMsgType,
        quotedSenderId: reply?.repliedSenderId,
        isReplyMsg: reply?.isReplyMsg,
      },
      images: parsed.images.length > 0 ? parsed.images : undefined,
      files: parsed.files.length > 0 ? parsed.files : undefined,
    }
  }

  buildRecalled(data: unknown): IncomingMessage | null {
    const event = parseDingtalkRecallEvent(data)
    if (!event) return null

    const messageId =
      readString(event.msgId) ?? readString(event.messageId) ?? readString(event.recallMsgId)
    const chatId =
      readString(event.conversationId) ??
      readString(event.openConversationId) ??
      readString(event.chatId)
    if (!messageId || !chatId) {
      console.warn('[DingtalkChannel] Received recall event without message id or conversation id')
      return null
    }

    const recalledAt =
      normalizeDingtalkEventTime(event.recallTime) ??
      normalizeDingtalkEventTime(event.createAt) ??
      new Date().toISOString()

    return {
      channelType: 'dingtalk',
      eventType: 'message_recalled',
      senderId:
        readString(event.operatorId) ??
        readString(event.senderStaffId) ??
        readString(event.senderId) ??
        'unknown',
      content: '',
      timestamp: recalledAt,
      metadata: {
        eventType: 'message_recalled',
        chatId,
        messageId,
        recallTime: recalledAt,
        recallType: readString(event.recallType) ?? readString(event.eventType),
      },
    }
  }
}

export async function parseDingtalkIncomingContent(
  msg: DingtalkRobotMessage,
  options: DingtalkIncomingMessageBuilderOptions = {},
): Promise<{ content: string; images: ImageAttachment[]; files: FileAttachment[] }> {
  const textParts: string[] = []
  const images: ImageAttachment[] = []
  const files: FileAttachment[] = []
  const msgtype = readString(msg.msgtype)

  const textContent = readString(msg.text?.content)
  if (textContent) textParts.push(textContent)

  const markdownText = readString(msg.markdown?.text)
  if (markdownText) textParts.push(markdownText)

  const rawContent = readContentText(msg.content)
  if (rawContent) textParts.push(rawContent)

  const reply = extractDingtalkReplyReference(msg)
  const quotedContent =
    readContentText(reply?.repliedMsg?.content) ?? readContentText(reply?.repliedMsg)
  if (quotedContent) textParts.unshift(formatDingtalkQuotedContent(quotedContent))

  if (Array.isArray(msg.richText)) {
    for (const element of msg.richText) {
      const elementText = readString(element.text) ?? readString(element.content)
      if (elementText) textParts.push(elementText)

      const imageCode = readString(element.pictureDownloadCode)
      if (imageCode) {
        const downloaded = await options.downloadMedia?.({
          downloadCode: imageCode,
          robotCode: readString(msg.robotCode),
          fileName: readString(element.fileName),
          mediaType: readString(element.mediaType) ?? 'image/png',
        })
        if (downloaded) images.push(toImageAttachment(downloaded))
      }

      const fileCode = readString(element.downloadCode)
      if (fileCode && !imageCode) {
        const fileName = readString(element.fileName) ?? 'dingtalk-file'
        const downloaded = await options.downloadMedia?.({
          downloadCode: fileCode,
          robotCode: readString(msg.robotCode),
          fileName,
          mediaType: readString(element.mediaType),
        })
        if (downloaded && options.saveFile) files.push(await options.saveFile(downloaded, fileName))
      }
    }
  }

  const pictureCode = readString(msg.pictureDownloadCode)
  if (pictureCode) {
    const downloaded = await options.downloadMedia?.({
      downloadCode: pictureCode,
      robotCode: readString(msg.robotCode),
      fileName: readString(msg.fileName),
      mediaType: 'image/png',
    })
    if (downloaded) images.push(toImageAttachment(downloaded))
  }

  const fileCode = readString(msg.downloadCode)
  if (fileCode && !pictureCode) {
    const fileName = readString(msg.fileName) ?? 'dingtalk-file'
    const downloaded = await options.downloadMedia?.({
      downloadCode: fileCode,
      robotCode: readString(msg.robotCode),
      fileName,
    })
    if (downloaded && options.saveFile) files.push(await options.saveFile(downloaded, fileName))
  }

  if (textParts.length === 0 && msgtype) {
    if (images.length > 0) textParts.push(`[${msgtype}]`)
    else if (files.length > 0)
      textParts.push(`[${msgtype}: ${files.map((file) => file.fileName).join(', ')}]`)
    else textParts.push(`[Unsupported DingTalk message type: ${msgtype}]`)
  }

  return {
    content: textParts.join('\n').trim(),
    images,
    files,
  }
}

export function parseDingtalkRobotMessage(data: unknown): DingtalkRobotMessage | null {
  const payload = unwrapDingtalkData(data)
  if (!payload || typeof payload !== 'object') return null

  const msg = payload as DingtalkRobotMessage
  if (!readString(msg.msgId) && !readString(msg.messageId)) return null
  return msg
}

export function parseDingtalkRecallEvent(data: unknown): DingtalkRecallEventPayload | null {
  const payload = unwrapDingtalkData(data)
  if (!payload || typeof payload !== 'object') return null

  const event = payload as DingtalkRecallEventPayload
  const eventType = readString(event.eventType)?.toLowerCase()
  const msgId =
    readString(event.msgId) ?? readString(event.messageId) ?? readString(event.recallMsgId)
  const chatId =
    readString(event.conversationId) ??
    readString(event.openConversationId) ??
    readString(event.chatId)

  if (eventType?.includes('recall') || eventType?.includes('withdraw')) {
    return msgId && chatId ? event : null
  }

  return readString(event.recallMsgId) && chatId ? event : null
}

export function normalizeDingtalkEventTime(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null || value === '') return undefined

  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined

  const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric
  return new Date(millis).toISOString()
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function readNumber(value: unknown): number | undefined {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}

function readStringOrNumber(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return readString(value)
}

function unwrapDingtalkData(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data

  const maybeStream = data as { data?: unknown }
  if (typeof maybeStream.data === 'string') {
    try {
      return JSON.parse(maybeStream.data)
    } catch {
      return null
    }
  }

  return maybeStream.data ?? data
}

function readContentText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown
      return readContentText(parsed) ?? value
    } catch {
      return value
    }
  }

  if (!isRecord(value)) return undefined

  const directText = readContentText(value.text) ?? readContentText(value.content)
  if (directText) return directText

  const richText = Array.isArray(value.richText)
    ? value.richText
    : isRecord(value.content) && Array.isArray(value.content.richText)
      ? value.content.richText
      : undefined
  if (richText) {
    const parts = richText
      .map((element) =>
        isRecord(element) ? (readString(element.text) ?? readString(element.content)) : undefined,
      )
      .filter((part): part is string => Boolean(part))
    if (parts.length > 0) return parts.join('\n')
  }

  return undefined
}

function extractDingtalkReplyReference(msg: DingtalkRobotMessage): {
  isReplyMsg?: boolean
  originalMsgId?: string
  repliedMsg?: DingtalkRepliedMessage
  repliedMsgId?: string
  repliedMsgType?: string
  repliedSenderId?: string
} | null {
  const replyPayload = findDingtalkReplyPayload(msg)
  if (!replyPayload) return null

  const repliedMsg = isRecord(replyPayload.repliedMsg)
    ? (replyPayload.repliedMsg as DingtalkRepliedMessage)
    : isRecord(msg.repliedMsg)
      ? msg.repliedMsg
      : undefined

  return {
    isReplyMsg: readBoolean(replyPayload.isReplyMsg) ?? readBoolean(msg.isReplyMsg),
    originalMsgId: readString(replyPayload.originalMsgId) ?? readString(msg.originalMsgId),
    repliedMsg,
    repliedMsgId:
      readString(repliedMsg?.msgId) ??
      readString(repliedMsg?.messageId) ??
      readString(replyPayload.originalMsgId) ??
      readString(msg.originalMsgId),
    repliedMsgType: readString(repliedMsg?.msgType) ?? readString(repliedMsg?.msgtype),
    repliedSenderId: readString(repliedMsg?.senderStaffId) ?? readString(repliedMsg?.senderId),
  }
}

function findDingtalkReplyPayload(msg: DingtalkRobotMessage): Record<string, unknown> | null {
  if (msg.isReplyMsg || msg.repliedMsg || msg.originalMsgId) return msg

  for (const value of Object.values(msg)) {
    if (!isRecord(value)) continue
    if (value.isReplyMsg || value.repliedMsg || value.originalMsgId) return value
  }

  return null
}

function formatDingtalkQuotedContent(quotedContent: string): string {
  const maxLen = 500
  const normalized = quotedContent.replace(/\s+/g, ' ').trim()
  const truncated =
    normalized.length > maxLen
      ? `${normalized.slice(0, maxLen)}...（原文共 ${normalized.length} 字，已截断）`
      : normalized
  return `> 引用: ${truncated}`
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toImageAttachment(media: DingtalkDownloadedMedia): ImageAttachment {
  return {
    mediaType: media.mediaType || 'image/png',
    data: media.buffer.toString('base64'),
  }
}
