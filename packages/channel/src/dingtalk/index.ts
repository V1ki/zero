import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeError } from '@zero-os/shared'
import {
  DWClient,
  type DWClientDownStream,
  EventAck,
  type EventAckData,
  TOPIC_ROBOT,
} from 'dingtalk-stream'
import type { Channel, MessageHandler } from '../base'
import { RecentMessageTracker } from '../message-tracker'
import {
  type DingtalkDownloadedMedia,
  DingtalkIncomingMessageBuilder,
  type DingtalkMediaDownloadRequest,
  type DingtalkRobotMessage,
  readNumber,
  readString,
} from './incoming-message'

const DEFAULT_API_BASE_URL = 'https://api.dingtalk.com'

export interface DingtalkChannelConfig {
  name?: string
  clientId: string
  clientSecret: string
  robotCode?: string
  downloadsDir?: string
  apiBaseUrl?: string
  debug?: boolean
  keepAlive?: boolean
  clientFactory?: (options: DingtalkClientFactoryOptions) => DingtalkStreamClient
  fetch?: typeof fetch
}

export interface DingtalkClientFactoryOptions {
  clientId: string
  clientSecret: string
  debug?: boolean
  keepAlive?: boolean
}

export interface DingtalkStreamClient {
  connected?: boolean
  registered?: boolean
  registerCallbackListener(
    eventId: string,
    callback: (message: DWClientDownStream) => void,
  ): DingtalkStreamClient
  registerAllEventListener(
    callback: (message: DWClientDownStream) => EventAckData,
  ): DingtalkStreamClient
  connect(): Promise<void>
  disconnect(): void
  getAccessToken(): Promise<unknown>
  socketCallBackResponse(messageId: string, result: unknown): void
}

interface DingtalkReplyTarget {
  sessionWebhook: string
  expiresAt?: number
  senderStaffId?: string
  robotCode?: string
}

interface DingtalkUploadResponse {
  mediaId?: string
  media_id?: string
  data?: {
    mediaId?: string
    media_id?: string
  }
}

interface DingtalkApiErrorBody {
  errcode?: unknown
  errCode?: unknown
  errorCode?: unknown
  code?: unknown
  errmsg?: unknown
  errMsg?: unknown
  message?: unknown
  msg?: unknown
  success?: unknown
}

/**
 * DingTalk channel for enterprise/internal application robots using Stream mode.
 * Incoming messages are received over the long-lived Stream connection; replies
 * use the short-lived sessionWebhook included in each robot callback.
 */
export class DingtalkChannel implements Channel {
  readonly name: string
  readonly type = 'dingtalk'

  private readonly config: DingtalkChannelConfig
  private readonly apiBaseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly incomingBuilder: DingtalkIncomingMessageBuilder
  private readonly recentMessages = new RecentMessageTracker({ maxSize: 1_000, ttlMs: 60 * 60_000 })
  private readonly targetsByMessageId = new Map<string, DingtalkReplyTarget>()
  private readonly targetsByConversationId = new Map<string, DingtalkReplyTarget>()
  private client: DingtalkStreamClient | null = null
  private messageHandler: MessageHandler | null = null
  private running = false

  constructor(config: DingtalkChannelConfig) {
    this.config = config
    this.name = config.name ?? 'dingtalk'
    this.apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL
    this.fetchImpl = config.fetch ?? fetch
    this.incomingBuilder = new DingtalkIncomingMessageBuilder({
      downloadMedia: (request) => this.downloadMedia(request),
      saveFile: (media, fileName) => this.saveFile(media, fileName),
    })
  }

  async start(): Promise<void> {
    if (this.running) return

    this.client = this.createClient()
    this.client
      .registerCallbackListener(TOPIC_ROBOT, (message) => {
        this.ackCallback(message)
        this.handleRobotMessage(message).catch((error) => {
          console.error(
            '[DingtalkChannel] Async robot message handler error:',
            describeError(error),
          )
        })
      })
      .registerAllEventListener((message) => {
        this.handleEvent(message).catch((error) => {
          console.error('[DingtalkChannel] Async event handler error:', describeError(error))
        })
        return { status: EventAck.SUCCESS }
      })

    await this.client.connect()
    this.running = true
  }

  async stop(): Promise<void> {
    this.client?.disconnect()
    this.client = null
    this.running = false
  }

  async send(sessionId: string, content: string): Promise<void> {
    await this.sendMarkdown(this.requireTarget(sessionId), content)
  }

  async reply(chatId: string, content: string, replyToMessageId?: string | number): Promise<void> {
    await this.sendMarkdown(this.requireTarget(chatId, replyToMessageId), content)
  }

  async uploadImage(image: Buffer, mediaType = 'image/png'): Promise<string | null> {
    const token = await this.getAccessToken()
    if (!token) return null

    const form = new FormData()
    form.append('media', new Blob([new Uint8Array(image)], { type: mediaType }), 'image.png')

    const response = await this.fetchImpl(`${this.apiBaseUrl}/v1.0/robot/messageFiles/upload`, {
      method: 'POST',
      headers: {
        'x-acs-dingtalk-access-token': token,
      },
      body: form,
    })

    if (!response.ok) {
      console.warn('[DingtalkChannel] Image upload failed:', response.status, await response.text())
      return null
    }

    const body = (await response.json().catch(() => null)) as DingtalkUploadResponse | null
    return body?.mediaId ?? body?.media_id ?? body?.data?.mediaId ?? body?.data?.media_id ?? null
  }

  async sendImage(chatId: string, image: Buffer): Promise<void> {
    const mediaId = await this.uploadImage(image)
    if (!mediaId) return
    await this.sendMarkdown(this.requireTarget(chatId), `![image](${mediaId})`)
  }

  isConnected(): boolean {
    return this.running && Boolean(this.client?.connected ?? this.client?.registered ?? false)
  }

  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  getCapabilities() {
    return {
      streaming: false,
      inlineImages: true,
      imageMessages: true,
      mentions: true,
      threadReply: false,
      markdownNotes:
        'DingTalk robot replies support Markdown and MediaId image references through sessionWebhook. The sessionWebhook reply API does not expose Feishu-style native quote-reply UI, and regular robot messages do not support editing previously sent text, so live streaming updates are disabled.',
    }
  }

  private createClient(): DingtalkStreamClient {
    if (this.config.clientFactory) {
      return this.config.clientFactory({
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        debug: this.config.debug,
        keepAlive: this.config.keepAlive,
      })
    }

    return new DWClient({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      debug: this.config.debug,
      keepAlive: this.config.keepAlive,
    })
  }

  private async handleRobotMessage(message: DWClientDownStream): Promise<void> {
    if (!this.messageHandler) return

    const incoming = await this.incomingBuilder.build(message)
    if (!incoming) return

    const messageId = readString(incoming.metadata?.messageId)
    if (!this.recentMessages.shouldProcess(messageId)) return

    this.rememberReplyTarget(parseStreamData(message.data), incoming.metadata)
    this.messageHandler(incoming).catch((error) => {
      console.error('[DingtalkChannel] Async message handler error:', describeError(error))
    })
  }

  private async handleEvent(message: DWClientDownStream): Promise<void> {
    if (!this.messageHandler) return

    const recalled = this.incomingBuilder.buildRecalled(message)
    if (!recalled) return

    const messageId = readString(recalled.metadata?.messageId)
    const recallKey = messageId ? `recall:${messageId}` : undefined
    if (!this.recentMessages.shouldProcess(recallKey)) return

    this.messageHandler(recalled).catch((error) => {
      console.error('[DingtalkChannel] Async recall handler error:', describeError(error))
    })
  }

  private ackCallback(message: DWClientDownStream): void {
    const messageId = message.headers?.messageId
    if (!messageId) return

    try {
      this.client?.socketCallBackResponse(messageId, { status: EventAck.SUCCESS })
    } catch (error) {
      console.warn('[DingtalkChannel] Failed to acknowledge callback:', describeError(error))
    }
  }

  private rememberReplyTarget(
    msg: DingtalkRobotMessage | null,
    metadata: Record<string, unknown> | undefined,
  ): void {
    const sessionWebhook = readString(metadata?.sessionWebhook) ?? readString(msg?.sessionWebhook)
    if (!sessionWebhook) return

    const target: DingtalkReplyTarget = {
      sessionWebhook,
      expiresAt:
        readNumber(metadata?.sessionWebhookExpiredTime) ??
        readNumber(msg?.sessionWebhookExpiredTime),
      senderStaffId: readString(metadata?.senderStaffId) ?? readString(msg?.senderStaffId),
      robotCode:
        readString(metadata?.robotCode) ?? readString(msg?.robotCode) ?? this.config.robotCode,
    }

    const messageId = readString(metadata?.messageId) ?? readString(msg?.msgId)
    const conversationId = readString(metadata?.conversationId) ?? readString(msg?.conversationId)
    if (messageId) this.targetsByMessageId.set(messageId, target)
    if (conversationId) this.targetsByConversationId.set(conversationId, target)
  }

  private requireTarget(
    conversationId: string,
    replyToMessageId?: string | number,
  ): DingtalkReplyTarget {
    const target =
      (replyToMessageId !== undefined
        ? this.getFreshTarget(this.targetsByMessageId.get(String(replyToMessageId)))
        : undefined) ?? this.getFreshTarget(this.targetsByConversationId.get(conversationId))

    if (!target) {
      throw new Error(`No active DingTalk sessionWebhook for conversation "${conversationId}"`)
    }

    return target
  }

  private getFreshTarget(target: DingtalkReplyTarget | undefined): DingtalkReplyTarget | undefined {
    if (!target) return undefined
    if (target.expiresAt && target.expiresAt <= Date.now()) return undefined
    return target
  }

  private async sendMarkdown(target: DingtalkReplyTarget, text: string): Promise<void> {
    const token = await this.getAccessToken()
    const response = await this.fetchImpl(target.sessionWebhook, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'x-acs-dingtalk-access-token': token } : {}),
      },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: {
          title: buildDingtalkMarkdownTitle(text),
          text,
        },
      }),
    })

    const responseText = await response.text()
    const errorDetail = describeDingtalkApiError(responseText)
    if (!response.ok || errorDetail) {
      const httpDetail = response.ok
        ? ''
        : `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
      throw new Error(
        `DingTalk sessionWebhook reply failed${httpDetail ? `: ${httpDetail}` : ''}${
          errorDetail ? `${httpDetail ? ' - ' : ': '}${errorDetail}` : ''
        }`,
      )
    }
  }

  private async downloadMedia(
    request: DingtalkMediaDownloadRequest,
  ): Promise<DingtalkDownloadedMedia | null> {
    const token = await this.getAccessToken()
    const robotCode = request.robotCode ?? this.config.robotCode
    if (!token || !robotCode) return null

    const response = await this.fetchImpl(`${this.apiBaseUrl}/v1.0/robot/messageFiles/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify({
        downloadCode: request.downloadCode,
        robotCode,
      }),
    })

    if (!response.ok) {
      console.warn('[DingtalkChannel] Media download URL lookup failed:', response.status)
      return null
    }

    const body = (await response.json().catch(() => null)) as {
      downloadUrl?: string
      url?: string
      data?: { downloadUrl?: string; url?: string }
    } | null
    const downloadUrl = body?.downloadUrl ?? body?.url ?? body?.data?.downloadUrl ?? body?.data?.url
    if (!downloadUrl) return null

    const binary = await this.fetchImpl(downloadUrl)
    if (!binary.ok) {
      console.warn('[DingtalkChannel] Media binary download failed:', binary.status)
      return null
    }

    return {
      buffer: Buffer.from(await binary.arrayBuffer()),
      mediaType:
        binary.headers.get('content-type')?.split(';')[0]?.trim() ||
        request.mediaType ||
        'application/octet-stream',
      fileName: request.fileName,
    }
  }

  private async saveFile(media: DingtalkDownloadedMedia, fileName: string) {
    const downloadsDir =
      this.config.downloadsDir ?? join(process.cwd(), '.zero', 'workspace', 'uploads')
    if (!existsSync(downloadsDir)) mkdirSync(downloadsDir, { recursive: true })

    const safeFileName = fileName.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_')
    const localPath = join(downloadsDir, `${Date.now()}_${safeFileName}`)
    writeFileSync(localPath, media.buffer)

    return {
      fileName,
      localPath,
      size: media.buffer.length,
    }
  }

  private async getAccessToken(): Promise<string | undefined> {
    try {
      const token = await this.client?.getAccessToken()
      if (typeof token === 'string') return token
      if (token && typeof token === 'object') {
        const record = token as { access_token?: string; accessToken?: string }
        return record.access_token ?? record.accessToken
      }
    } catch (error) {
      console.warn('[DingtalkChannel] Failed to get access token:', describeError(error))
    }
    return undefined
  }
}

function parseStreamData(data: string): DingtalkRobotMessage | null {
  try {
    return JSON.parse(data) as DingtalkRobotMessage
  } catch {
    return null
  }
}

function buildDingtalkMarkdownTitle(text: string): string {
  const firstLine = text
    .split('\n')
    .map((line) => line.replace(/[#*_`>[\]()]/g, '').trim())
    .find(Boolean)
  return (firstLine ?? 'ZeRo OS').slice(0, 40)
}

function describeDingtalkApiError(responseText: string): string | null {
  if (!responseText.trim()) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(responseText)
  } catch {
    return null
  }

  if (!isRecord(parsed)) return null

  const body = parsed as DingtalkApiErrorBody
  const code = firstPresent(body.errcode, body.errCode, body.errorCode, body.code)

  if (body.success === false || isFailureCode(code)) {
    const message = firstString(body.errmsg, body.errMsg, body.message, body.msg)
    const parts = [
      code !== undefined ? `code=${String(code)}` : null,
      message ? `message=${message}` : null,
    ].filter((part): part is string => Boolean(part))
    return parts.length > 0 ? parts.join(', ') : 'business error'
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstPresent(...values: unknown[]): unknown | undefined {
  return values.find((value) => value !== undefined && value !== null && value !== '')
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

function isFailureCode(code: unknown): boolean {
  if (code === undefined || code === null || code === '') return false
  if (typeof code === 'number') return code !== 0
  if (typeof code === 'string') {
    const normalized = code.trim().toLowerCase()
    return normalized !== '0' && normalized !== 'ok' && normalized !== 'success'
  }
  return false
}

export { DingtalkIncomingMessageBuilder } from './incoming-message'
export type {
  DingtalkDownloadedMedia,
  DingtalkMediaDownloadRequest,
  DingtalkRecallEventPayload,
  DingtalkRobotMessage,
} from './incoming-message'
