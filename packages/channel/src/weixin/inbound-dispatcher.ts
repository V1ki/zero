import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileAttachment, ImageAttachment } from '../base'
import type { MessageHandler, IncomingMessage as ZeroIncomingMessage } from '../base'
import { RecentMessageTracker } from '../message-tracker'
import type { ApiOptions } from './api-transport'
import { ITEM_FILE, ITEM_IMAGE, ITEM_VIDEO, ITEM_VOICE, MESSAGE_DEDUP_TTL_MS } from './constants'
import { aesDecrypt, parseAesKey } from './crypto'
import { extractText, guessChatType, safeId } from './inbound'
import { buildCdnDownloadUrl, downloadBytes } from './media-api'
import type { ContextTokenStore } from './storage'
import type { IncomingMessage as ILinkIncomingMessage, IncomingMediaItem, Policy } from './types'

interface WeixinInboundDispatcherOptions {
  accountId: string
  channelName: string
  cdnBaseUrl: string
  dmPolicy: Policy
  groupPolicy: Policy
  allowFrom?: string[]
  groupAllowFrom?: string[]
  tokenStore: ContextTokenStore
  getApiOptions: () => ApiOptions
  getMessageHandler: () => MessageHandler | null
  maybeFetchTypingTicket: (chatId: string, contextToken: string | undefined) => void
}

export class WeixinInboundDispatcher {
  private readonly accountId: string
  private readonly channelName: string
  private readonly dmPolicy: Policy
  private readonly groupPolicy: Policy
  private readonly allowFrom: Set<string>
  private readonly groupAllowFrom: Set<string>
  private readonly tokenStore: ContextTokenStore
  private readonly mediaCollector: WeixinInboundMediaCollector
  private readonly getMessageHandler: () => MessageHandler | null
  private readonly maybeFetchTypingTicket: (
    chatId: string,
    contextToken: string | undefined,
  ) => void
  private readonly processedMessages = new RecentMessageTracker({ ttlMs: MESSAGE_DEDUP_TTL_MS })

  constructor(options: WeixinInboundDispatcherOptions) {
    this.accountId = options.accountId
    this.channelName = options.channelName
    this.dmPolicy = options.dmPolicy
    this.groupPolicy = options.groupPolicy
    this.allowFrom = new Set((options.allowFrom ?? []).map((s) => s.trim()).filter(Boolean))
    this.groupAllowFrom = new Set(
      (options.groupAllowFrom ?? []).map((s) => s.trim()).filter(Boolean),
    )
    this.tokenStore = options.tokenStore
    this.mediaCollector = new WeixinInboundMediaCollector(options.cdnBaseUrl, options.getApiOptions)
    this.getMessageHandler = options.getMessageHandler
    this.maybeFetchTypingTicket = options.maybeFetchTypingTicket
  }

  async processSafe(message: ILinkIncomingMessage): Promise<void> {
    try {
      await this.process(message)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(
        `[WeixinChannel] inbound message failed channel=${this.channelName} sender=${safeId(message.from_user_id)}: ${reason}`,
      )
    }
  }

  async process(message: ILinkIncomingMessage): Promise<void> {
    const senderId = String(message.from_user_id ?? '').trim()
    if (!senderId) {
      console.log(
        `[WeixinChannel] ignored inbound channel=${this.channelName} reason=missingSender`,
      )
      return
    }
    if (senderId === this.accountId) {
      console.log(
        `[WeixinChannel] ignored inbound channel=${this.channelName} sender=${safeId(senderId)} reason=selfMessage`,
      )
      return
    }

    const messageId = String(message.message_id ?? '').trim()
    if (!this.processedMessages.shouldProcess(messageId)) {
      console.log(
        `[WeixinChannel] ignored inbound channel=${this.channelName} sender=${safeId(senderId)} message=${safeId(messageId)} reason=duplicate`,
      )
      return
    }

    const { chatType, chatId } = guessChatType(message, this.accountId)
    if (!this.isAllowedMessage(chatType, chatId, senderId)) return

    const contextToken = String(message.context_token ?? '').trim()
    if (contextToken) this.tokenStore.set(this.accountId, chatId, contextToken)
    this.maybeFetchTypingTicket(chatId, contextToken || undefined)

    const items = message.item_list ?? []
    console.log(
      `[WeixinChannel] received ${chatType} message channel=${this.channelName} chat=${safeId(chatId)} sender=${safeId(senderId)} message=${safeId(messageId)} items=${items.length}`,
    )
    const text = extractText(items)
    const { images, files } = await this.mediaCollector.collect(items)

    if (!text && images.length === 0 && files.length === 0) {
      const itemTypes = items.map((item) => item.type).join(',')
      console.log(
        `[WeixinChannel] ignored inbound channel=${this.channelName} chat=${safeId(chatId)} sender=${safeId(senderId)} message=${safeId(messageId)} reason=emptyContent itemTypes=${itemTypes || 'none'}`,
      )
      return
    }

    const outbound: ZeroIncomingMessage = {
      channelType: 'weixin',
      senderId,
      content: text,
      timestamp:
        typeof message.create_time_ms === 'number'
          ? new Date(message.create_time_ms).toISOString()
          : new Date().toISOString(),
      metadata: {
        chatType,
        chatId,
        messageId: messageId || undefined,
        accountId: this.accountId,
        sessionId: message.session_id,
        seq: message.seq,
      },
      images,
      files,
    }
    await this.getMessageHandler()?.(outbound)
  }

  private isAllowedMessage(chatType: string, chatId: string, senderId: string): boolean {
    if (chatType === 'group') {
      if (this.groupPolicy === 'disabled') {
        console.log(
          `[WeixinChannel] ignored group message channel=${this.channelName} chat=${safeId(chatId)} reason=groupPolicyDisabled`,
        )
        return false
      }
      if (this.groupPolicy === 'allowlist' && !this.groupAllowFrom.has(chatId)) {
        console.log(
          `[WeixinChannel] ignored group message channel=${this.channelName} chat=${safeId(chatId)} reason=groupNotAllowed`,
        )
        return false
      }
      return true
    }

    if (this.dmPolicy === 'disabled') {
      console.log(
        `[WeixinChannel] ignored dm message channel=${this.channelName} sender=${safeId(senderId)} reason=dmPolicyDisabled`,
      )
      return false
    }
    if (this.dmPolicy === 'allowlist' && !this.allowFrom.has(senderId)) {
      console.log(
        `[WeixinChannel] ignored dm message channel=${this.channelName} sender=${safeId(senderId)} reason=dmNotAllowed`,
      )
      return false
    }
    return true
  }
}

type MediaDescriptor = {
  encrypt_query_param?: string
  aes_key?: string
  full_url?: string
}

class WeixinInboundMediaCollector {
  constructor(
    private readonly cdnBaseUrl: string,
    private readonly getApiOptions: () => ApiOptions,
  ) {}

  async collect(items: IncomingMediaItem[]): Promise<{
    images: ImageAttachment[]
    files: FileAttachment[]
  }> {
    const images: ImageAttachment[] = []
    const files: FileAttachment[] = []

    for (const item of items) {
      await this.collectMedia(item, images, files)
      const refItem = item.ref_msg?.message_item
      if (refItem) await this.collectMedia(refItem, images, files)
    }

    return { images, files }
  }

  private async collectMedia(
    item: IncomingMediaItem,
    images: ImageAttachment[],
    files: FileAttachment[],
  ): Promise<void> {
    if (item.type === ITEM_IMAGE) {
      const bytes = await this.downloadImage(item)
      if (bytes) images.push({ mediaType: 'image/jpeg', data: bytes.toString('base64') })
      return
    }
    if (item.type === ITEM_VIDEO) {
      const bytes = await this.downloadMedia(item.video_item?.media, 120_000)
      if (bytes) {
        const path = writeMediaCacheFile('video', bytes, 'video.mp4')
        files.push({ fileName: 'video.mp4', localPath: path, size: bytes.length })
      }
      return
    }
    if (item.type === ITEM_FILE) {
      const media = item.file_item?.media
      const filename = String(item.file_item?.file_name ?? 'document.bin')
      const bytes = await this.downloadMedia(media, 60_000)
      if (bytes) {
        const path = writeMediaCacheFile('file', bytes, filename)
        files.push({ fileName: filename, localPath: path, size: bytes.length })
      }
      return
    }
    if (item.type === ITEM_VOICE) {
      if (item.voice_item?.text) return
      const bytes = await this.downloadMedia(item.voice_item?.media, 60_000)
      if (bytes) {
        const path = writeMediaCacheFile('voice', bytes, 'voice.silk')
        files.push({ fileName: 'voice.silk', localPath: path, size: bytes.length })
      }
    }
  }

  private async downloadImage(item: IncomingMediaItem): Promise<Buffer | null> {
    const media = item.image_item?.media
    const directAes = item.image_item?.aeskey
    const aesKeyB64 =
      typeof directAes === 'string' && /^[0-9a-fA-F]+$/.test(directAes)
        ? Buffer.from(directAes, 'ascii').toString('base64')
        : media?.aes_key
    return this.downloadMediaWith(media, aesKeyB64, 30_000)
  }

  private async downloadMedia(
    media: MediaDescriptor | undefined,
    timeoutMs: number,
  ): Promise<Buffer | null> {
    return this.downloadMediaWith(media, media?.aes_key, timeoutMs)
  }

  private async downloadMediaWith(
    media: MediaDescriptor | undefined,
    aesKeyB64: string | undefined,
    timeoutMs: number,
  ): Promise<Buffer | null> {
    if (!media) return null
    try {
      let url: string
      if (media.encrypt_query_param) {
        url = buildCdnDownloadUrl(this.cdnBaseUrl, media.encrypt_query_param)
      } else if (media.full_url) {
        url = media.full_url
      } else {
        return null
      }
      const raw = await downloadBytes({ url, timeoutMs }, this.getApiOptions())
      if (!aesKeyB64) return raw
      return aesDecrypt(raw, parseAesKey(aesKeyB64))
    } catch {
      return null
    }
  }
}

function writeMediaCacheFile(kind: string, bytes: Buffer, filename: string): string {
  const dir = mediaCacheDir(kind)
  const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 12)
  const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'blob'
  const path = join(dir, `${hash}-${safeName}`)
  writeFileSync(path, bytes)
  return path
}

function mediaCacheDir(kind: string): string {
  const dir = join(tmpdir(), 'zero-weixin-cache', kind)
  mkdirSync(dir, { recursive: true })
  return dir
}
