/**
 * Weixin channel — long-polls the iLink Bot API and routes incoming messages
 * into the Zero channel pipeline.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Channel,
  ChannelCapabilities,
  FileAttachment,
  ImageAttachment,
  MessageHandler,
  IncomingMessage as ZeroIncomingMessage,
} from '../base'
import {
  type ApiOptions,
  type FetchImpl,
  buildCdnDownloadUrl,
  downloadBytes,
  getTypingConfig,
  getUpdates,
  getUploadUrl,
  notifyStart,
  notifyStop,
  sendRawMessage,
  sendTextMessage,
  sendTyping,
  uploadCiphertext,
} from './api'
import {
  BACKOFF_DELAY_MS,
  ILINK_BASE_URL,
  ITEM_FILE,
  ITEM_IMAGE,
  ITEM_TEXT,
  ITEM_VIDEO,
  ITEM_VOICE,
  MAX_CONSECUTIVE_FAILURES,
  MAX_MESSAGE_LENGTH,
  MEDIA_FILE,
  MEDIA_IMAGE,
  MEDIA_VIDEO,
  MEDIA_VOICE,
  MESSAGE_DEDUP_TTL_MS,
  MSG_STATE_FINISH,
  MSG_TYPE_BOT,
  RETRY_DELAY_MS,
  SESSION_EXPIRED_ERRCODE,
  SESSION_EXPIRED_PAUSE_MS,
  TYPING_START,
  TYPING_STOP,
  WEIXIN_CDN_BASE_URL,
} from './constants'
import {
  aesDecrypt,
  aesEncrypt,
  aesPaddedSize,
  encodeAesKeyForApi,
  parseAesKey,
  randomAesKey,
  randomFileKey,
} from './crypto'
import { normalizeMarkdownForWeixin, splitForWeixinDelivery } from './markdown'
import { ContextTokenStore, MessageDeduplicator, loadSyncBuf, saveSyncBuf } from './storage'
import type {
  ChatType,
  IncomingMessage as ILinkIncomingMessage,
  IncomingMediaItem,
  Policy,
  WeixinChannelConfig,
} from './types'

export interface WeixinChannelRuntimeOptions {
  /** Override fetch for tests */
  fetchImpl?: FetchImpl
  /** Override clock (ms since epoch) for tests */
  now?: () => number
  /** Sleep helper so tests can short-circuit backoff */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

function makeAbortError(): Error {
  const error = new Error('aborted') as Error & { name: string }
  error.name = 'AbortError'
  return error
}

function safeId(value: unknown): string {
  const id = String(value ?? '').trim()
  if (!id) return 'unknown'
  if (id.length <= 12) return id
  return `${id.slice(0, 6)}...${id.slice(-4)}`
}

export function guessChatType(
  message: ILinkIncomingMessage,
  _accountId: string,
): { chatType: ChatType; chatId: string } {
  // @tencent-weixin/openclaw-weixin declares only direct chats and routes
  // inbound messages by from_user_id. Some getUpdates payloads include
  // to_user_id/session_id-like fields, but they are not reliable group targets.
  return { chatType: 'dm', chatId: String(message.from_user_id ?? '').trim() }
}

function extractText(items: IncomingMediaItem[]): string {
  for (const item of items) {
    if (item.type === ITEM_TEXT) {
      const base = String(item.text_item?.text ?? '')
      const refItem = item.ref_msg?.message_item
      if (refItem) {
        const refType = refItem.type
        if (
          refType === ITEM_IMAGE ||
          refType === ITEM_VIDEO ||
          refType === ITEM_FILE ||
          refType === ITEM_VOICE
        ) {
          const title = item.ref_msg?.title ?? ''
          const prefix = title ? `[引用媒体: ${title}]\n` : '[引用媒体]\n'
          return `${prefix}${base}`.trim()
        }
        const parts: string[] = []
        if (item.ref_msg?.title) parts.push(String(item.ref_msg.title))
        const refText = extractText([refItem])
        if (refText) parts.push(refText)
        if (parts.length > 0) return `[引用: ${parts.join(' | ')}]\n${base}`.trim()
      }
      return base
    }
  }
  for (const item of items) {
    if (item.type === ITEM_VOICE) {
      const voiceText = String(item.voice_item?.text ?? '')
      if (voiceText) return voiceText
    }
  }
  return ''
}

function cacheDir(kind: string): string {
  const dir = join(tmpdir(), 'zero-weixin-cache', kind)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeCacheFile(kind: string, bytes: Buffer, filename: string): string {
  const dir = cacheDir(kind)
  const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 12)
  const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'blob'
  const path = join(dir, `${hash}-${safeName}`)
  writeFileSync(path, bytes)
  return path
}

export class WeixinChannel implements Channel {
  readonly name: string
  readonly type = 'weixin' as const

  private readonly accountId: string
  private readonly token: string
  private readonly baseUrl: string
  private readonly cdnBaseUrl: string
  private readonly botAgent: string | undefined
  private readonly homeDir: string
  private readonly dmPolicy: Policy
  private readonly groupPolicy: Policy
  private readonly allowFrom: Set<string>
  private readonly groupAllowFrom: Set<string>
  private readonly sendChunkDelayMs: number
  private readonly sendChunkRetries: number
  private readonly sendChunkRetryDelayMs: number
  private readonly splitMultiline: boolean

  private readonly tokenStore: ContextTokenStore
  private readonly dedup: MessageDeduplicator
  private readonly typingCache = new Map<string, { ticket: string; ts: number }>()

  private messageHandler: MessageHandler | null = null
  private pollAbort: AbortController | null = null
  private pollTask: Promise<void> | null = null
  private running = false
  private connected = false
  private pausedUntilMs: number | null = null

  private readonly baseFetchImpl: FetchImpl
  private readonly fetchImpl: FetchImpl
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(config: WeixinChannelConfig, runtime: WeixinChannelRuntimeOptions = {}) {
    if (!config.accountId) throw new Error('WeixinChannel: accountId is required')
    if (!config.token) throw new Error('WeixinChannel: token is required')
    if (!config.homeDir) throw new Error('WeixinChannel: homeDir is required')

    this.name = config.name ?? 'weixin'
    this.accountId = config.accountId
    this.token = config.token
    this.baseUrl = (config.baseUrl ?? ILINK_BASE_URL).replace(/\/$/, '')
    this.cdnBaseUrl = (config.cdnBaseUrl ?? WEIXIN_CDN_BASE_URL).replace(/\/$/, '')
    this.botAgent = config.botAgent
    this.homeDir = config.homeDir
    this.dmPolicy = config.dmPolicy ?? 'open'
    this.groupPolicy = config.groupPolicy ?? 'disabled'
    this.allowFrom = new Set((config.allowFrom ?? []).map((s) => s.trim()).filter(Boolean))
    this.groupAllowFrom = new Set(
      (config.groupAllowFrom ?? []).map((s) => s.trim()).filter(Boolean),
    )
    this.sendChunkDelayMs = config.sendChunkDelayMs ?? 350
    this.sendChunkRetries = config.sendChunkRetries ?? 2
    this.sendChunkRetryDelayMs = config.sendChunkRetryDelayMs ?? 1000
    this.splitMultiline = config.splitMultilineMessages ?? false

    this.tokenStore = new ContextTokenStore(this.homeDir)
    this.dedup = new MessageDeduplicator(MESSAGE_DEDUP_TTL_MS)

    const baseFetch = runtime.fetchImpl ?? globalThis.fetch
    this.baseFetchImpl = baseFetch
    this.fetchImpl = async (input, init) => {
      const abortSignal = this.pollAbort?.signal
      if (!abortSignal) return baseFetch(input, init)
      if (abortSignal.aborted) throw makeAbortError()
      let onAbort: (() => void) | undefined
      const abortPromise = new Promise<never>((_, reject) => {
        onAbort = () => {
          reject(makeAbortError())
        }
        abortSignal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        return await Promise.race([baseFetch(input, init), abortPromise])
      } finally {
        if (onAbort) abortSignal.removeEventListener('abort', onAbort)
      }
    }
    this.sleep = runtime.sleep ?? DEFAULT_SLEEP
    this.now = runtime.now ?? (() => Date.now())
  }

  async start(): Promise<void> {
    if (this.running) return
    this.tokenStore.restore(this.accountId)
    this.running = true
    this.connected = true
    this.pollAbort = new AbortController()
    try {
      const response = await notifyStart(
        { baseUrl: this.baseUrl, token: this.token },
        this.apiOpts(),
      )
      if (response.ret !== undefined && response.ret !== 0) {
        console.warn(
          `[WeixinChannel] notifyStart returned ret=${response.ret} channel=${this.name}`,
        )
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`[WeixinChannel] notifyStart failed channel=${this.name}: ${reason}`)
    }
    this.pollTask = this.pollLoop()
  }

  async stop(): Promise<void> {
    this.running = false
    this.pollAbort?.abort()
    const task = this.pollTask
    this.pollTask = null
    this.pollAbort = null
    if (task) {
      try {
        await task
      } catch {
        // expected on abort
      }
    }
    try {
      const response = await notifyStop(
        { baseUrl: this.baseUrl, token: this.token },
        this.apiOpts(),
      )
      if (response.ret !== undefined && response.ret !== 0) {
        console.warn(`[WeixinChannel] notifyStop returned ret=${response.ret} channel=${this.name}`)
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(`[WeixinChannel] notifyStop failed channel=${this.name}: ${reason}`)
    }
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  getCapabilities(): ChannelCapabilities {
    return {
      streaming: false,
      inlineImages: false,
      imageMessages: true,
      fileMessages: true,
      interactiveCards: false,
      mentions: false,
      reactions: false,
      threadReply: false,
      maxMessageLength: MAX_MESSAGE_LENGTH,
      markdownNotes: `Weixin does not support H1 headings (converted to 【Title】). H2+ become **bold**. Tables are flattened to \`- key: value\` lists. Sent messages cannot be edited. Long content is split into multiple bubbles at ${MAX_MESSAGE_LENGTH} chars.`,
    }
  }

  private apiOpts(): ApiOptions {
    return { fetchImpl: this.fetchImpl, botAgent: this.botAgent }
  }

  private assertNotSessionPaused(): void {
    const pausedUntil = this.pausedUntilMs
    if (!pausedUntil || this.now() >= pausedUntil) {
      if (pausedUntil) this.pausedUntilMs = null
      return
    }
    throw new Error(
      `Weixin session paused after ${SESSION_EXPIRED_ERRCODE}; retry after ${new Date(
        pausedUntil,
      ).toISOString()}`,
    )
  }

  private isSessionPaused(): boolean {
    try {
      this.assertNotSessionPaused()
      return false
    } catch {
      return true
    }
  }

  private async pollLoop(): Promise<void> {
    let syncBuf = loadSyncBuf(this.homeDir, this.accountId)
    let timeoutMs: number | undefined
    let consecutiveFailures = 0

    while (this.running) {
      try {
        const response = await getUpdates(
          { baseUrl: this.baseUrl, token: this.token, syncBuf, timeoutMs },
          this.apiOpts(),
        )
        const suggested = response.longpolling_timeout_ms
        if (typeof suggested === 'number' && suggested > 0) timeoutMs = suggested

        const ret = response.ret ?? 0
        const errcode = response.errcode ?? 0
        if (ret !== 0 || errcode !== 0) {
          if (ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE) {
            this.pausedUntilMs = this.now() + SESSION_EXPIRED_PAUSE_MS
            await this.sleep(SESSION_EXPIRED_PAUSE_MS)
            consecutiveFailures = 0
            continue
          }
          consecutiveFailures += 1
          const delay =
            consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS
          await this.sleep(delay)
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0
          continue
        }

        consecutiveFailures = 0
        const newBuf = String(response.get_updates_buf ?? '')
        if (newBuf) {
          syncBuf = newBuf
          saveSyncBuf(this.homeDir, this.accountId, syncBuf)
        }
        const messages = response.msgs ?? []
        if (messages.length > 0) {
          console.log(
            `[WeixinChannel] poll returned channel=${this.name} messages=${messages.length}`,
          )
        }
        for (const msg of messages) {
          void this.processMessageSafe(msg)
        }
      } catch {
        if (!this.running) break
        consecutiveFailures += 1
        const delay =
          consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS
        await this.sleep(delay)
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0
      }
    }
  }

  private async processMessageSafe(message: ILinkIncomingMessage): Promise<void> {
    try {
      await this.processMessage(message)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(
        `[WeixinChannel] inbound message failed channel=${this.name} sender=${safeId(message.from_user_id)}: ${reason}`,
      )
    }
  }

  private async processMessage(message: ILinkIncomingMessage): Promise<void> {
    const senderId = String(message.from_user_id ?? '').trim()
    if (!senderId) {
      console.log(`[WeixinChannel] ignored inbound channel=${this.name} reason=missingSender`)
      return
    }
    if (senderId === this.accountId) {
      console.log(
        `[WeixinChannel] ignored inbound channel=${this.name} sender=${safeId(senderId)} reason=selfMessage`,
      )
      return
    }

    const messageId = String(message.message_id ?? '').trim()
    if (messageId && this.dedup.isDuplicate(messageId)) {
      console.log(
        `[WeixinChannel] ignored inbound channel=${this.name} sender=${safeId(senderId)} message=${safeId(messageId)} reason=duplicate`,
      )
      return
    }

    const { chatType, chatId } = guessChatType(message, this.accountId)
    if (chatType === 'group') {
      if (this.groupPolicy === 'disabled') {
        console.log(
          `[WeixinChannel] ignored group message channel=${this.name} chat=${safeId(chatId)} reason=groupPolicyDisabled`,
        )
        return
      }
      if (this.groupPolicy === 'allowlist' && !this.groupAllowFrom.has(chatId)) {
        console.log(
          `[WeixinChannel] ignored group message channel=${this.name} chat=${safeId(chatId)} reason=groupNotAllowed`,
        )
        return
      }
    } else {
      if (this.dmPolicy === 'disabled') {
        console.log(
          `[WeixinChannel] ignored dm message channel=${this.name} sender=${safeId(senderId)} reason=dmPolicyDisabled`,
        )
        return
      }
      if (this.dmPolicy === 'allowlist' && !this.allowFrom.has(senderId)) {
        console.log(
          `[WeixinChannel] ignored dm message channel=${this.name} sender=${safeId(senderId)} reason=dmNotAllowed`,
        )
        return
      }
    }

    const contextToken = String(message.context_token ?? '').trim()
    if (contextToken) this.tokenStore.set(this.accountId, chatId, contextToken)
    void this.maybeFetchTypingTicket(chatId, contextToken || undefined)

    const items = message.item_list ?? []
    console.log(
      `[WeixinChannel] received ${chatType} message channel=${this.name} chat=${safeId(chatId)} sender=${safeId(senderId)} message=${safeId(messageId)} items=${items.length}`,
    )
    const text = extractText(items)
    const images: ImageAttachment[] = []
    const files: FileAttachment[] = []

    for (const item of items) {
      await this.collectMedia(item, images, files)
      const refItem = item.ref_msg?.message_item
      if (refItem) await this.collectMedia(refItem, images, files)
    }

    if (!text && images.length === 0 && files.length === 0) {
      const itemTypes = items.map((item) => item.type).join(',')
      console.log(
        `[WeixinChannel] ignored inbound channel=${this.name} chat=${safeId(chatId)} sender=${safeId(senderId)} message=${safeId(messageId)} reason=emptyContent itemTypes=${itemTypes || 'none'}`,
      )
      return
    }

    const outbound: ZeroIncomingMessage = {
      channelType: this.type,
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
    await this.messageHandler?.(outbound)
  }

  private async maybeFetchTypingTicket(
    chatId: string,
    contextToken: string | undefined,
  ): Promise<void> {
    const cached = this.typingCache.get(chatId)
    if (cached && Date.now() - cached.ts < 600_000) return
    try {
      const response = await getTypingConfig(
        {
          baseUrl: this.baseUrl,
          token: this.token,
          userId: chatId,
          contextToken,
        },
        this.apiOpts(),
      )
      const ticket = typeof response.typing_ticket === 'string' ? response.typing_ticket : ''
      if (ticket) this.typingCache.set(chatId, { ticket, ts: Date.now() })
    } catch {
      // non-fatal
    }
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
        const path = writeCacheFile('video', bytes, 'video.mp4')
        files.push({ fileName: 'video.mp4', localPath: path, size: bytes.length })
      }
      return
    }
    if (item.type === ITEM_FILE) {
      const media = item.file_item?.media
      const filename = String(item.file_item?.file_name ?? 'document.bin')
      const bytes = await this.downloadMedia(media, 60_000)
      if (bytes) {
        const path = writeCacheFile('file', bytes, filename)
        files.push({ fileName: filename, localPath: path, size: bytes.length })
      }
      return
    }
    if (item.type === ITEM_VOICE) {
      if (item.voice_item?.text) return
      const bytes = await this.downloadMedia(item.voice_item?.media, 60_000)
      if (bytes) {
        const path = writeCacheFile('voice', bytes, 'voice.silk')
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
    media: { encrypt_query_param?: string; aes_key?: string; full_url?: string } | undefined,
    timeoutMs: number,
  ): Promise<Buffer | null> {
    return this.downloadMediaWith(media, media?.aes_key, timeoutMs)
  }

  private async downloadMediaWith(
    media: { encrypt_query_param?: string; full_url?: string } | undefined,
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
      const raw = await downloadBytes({ url, timeoutMs }, this.apiOpts())
      if (!aesKeyB64) return raw
      return aesDecrypt(raw, parseAesKey(aesKeyB64))
    } catch {
      return null
    }
  }

  async send(_sessionId: string, content: string): Promise<void> {
    await this.sendToChat(_sessionId, content)
  }

  /**
   * Internal send — accepts the chat identifier directly (the chatId stored in
   * metadata by processMessage). This is used by the adapter layer.
   */
  async sendToChat(chatId: string, content: string): Promise<void> {
    this.assertNotSessionPaused()
    const formatted = normalizeMarkdownForWeixin(content)
    const chunks = splitForWeixinDelivery(formatted, {
      splitMultilineMessages: this.splitMultiline,
      maxLength: MAX_MESSAGE_LENGTH,
    }).filter((c) => c.trim().length > 0)

    const contextToken = this.tokenStore.get(this.accountId, chatId)
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]
      await this.sendChunkWithRetry(chatId, chunk, contextToken)
      if (i < chunks.length - 1 && this.sendChunkDelayMs > 0) {
        await this.sleep(this.sendChunkDelayMs)
      }
    }
  }

  private async sendChunkWithRetry(
    chatId: string,
    chunk: string,
    contextToken: string | undefined,
  ): Promise<void> {
    let lastError: unknown = null
    for (let attempt = 0; attempt <= this.sendChunkRetries; attempt += 1) {
      try {
        await sendTextMessage(
          {
            baseUrl: this.baseUrl,
            token: this.token,
            to: chatId,
            text: chunk,
            contextToken,
            clientId: `zero-weixin-${randomUUID()}`,
          },
          this.apiOpts(),
        )
        return
      } catch (err) {
        lastError = err
        if (attempt >= this.sendChunkRetries) break
        await this.sleep(this.sendChunkRetryDelayMs * (attempt + 1))
      }
    }
    throw lastError ?? new Error('sendChunkWithRetry: unknown error')
  }

  async sendTypingIndicator(chatId: string): Promise<void> {
    await this.sendTypingStatus(chatId, TYPING_START)
  }

  async clearTypingIndicator(chatId: string): Promise<void> {
    await this.sendTypingStatus(chatId, TYPING_STOP)
  }

  private async sendTypingStatus(chatId: string, status: number): Promise<void> {
    if (this.isSessionPaused()) return
    const cached = this.typingCache.get(chatId)
    if (!cached) return
    try {
      await sendTyping(
        {
          baseUrl: this.baseUrl,
          token: this.token,
          toUserId: chatId,
          typingTicket: cached.ticket,
          status,
        },
        this.apiOpts(),
      )
    } catch {
      // non-fatal
    }
  }

  /**
   * Upload an in-memory file as a Weixin attachment. Used by the adapter for
   * both image attachments and generic file sends.
   */
  async sendAttachment(
    chatId: string,
    bytes: Buffer,
    filename: string,
    mimeHint?: string,
  ): Promise<string> {
    this.assertNotSessionPaused()
    const mediaType = pickMediaType(filename, mimeHint)
    const filekey = randomFileKey()
    const aesKey = randomAesKey()
    const rawsize = bytes.length
    const rawfilemd5 = createHash('md5').update(bytes).digest('hex')
    const uploadResponse = await getUploadUrl(
      {
        baseUrl: this.baseUrl,
        token: this.token,
        toUserId: chatId,
        mediaType,
        filekey,
        rawsize,
        rawfilemd5,
        filesize: aesPaddedSize(rawsize),
        aesKeyHex: aesKey.toString('hex'),
      },
      this.apiOpts(),
    )
    const ciphertext = aesEncrypt(bytes, aesKey)
    const uploadFullUrl = String(uploadResponse.upload_full_url ?? '')
    const uploadParam = String(uploadResponse.upload_param ?? '')
    let uploadUrl: string
    if (uploadFullUrl) {
      uploadUrl = uploadFullUrl
    } else if (uploadParam) {
      uploadUrl =
        `${this.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}` +
        `&filekey=${encodeURIComponent(filekey)}`
    } else {
      throw new Error('getUploadUrl returned no upload target')
    }
    const encryptedQueryParam = await uploadCiphertext({ uploadUrl, ciphertext }, this.apiOpts())
    const aesKeyForApi = encodeAesKeyForApi(aesKey)
    const mediaItem = buildOutboundMediaItem({
      mediaType,
      filename,
      rawsize,
      ciphertextSize: ciphertext.length,
      encryptQueryParam: encryptedQueryParam,
      aesKeyForApi,
      rawfilemd5,
    })
    const contextToken = this.tokenStore.get(this.accountId, chatId)
    const clientId = `zero-weixin-${randomUUID()}`
    await sendRawMessage(
      {
        baseUrl: this.baseUrl,
        token: this.token,
        msg: {
          from_user_id: '',
          to_user_id: chatId,
          client_id: clientId,
          message_type: MSG_TYPE_BOT,
          message_state: MSG_STATE_FINISH,
          item_list: [mediaItem],
          ...(contextToken ? { context_token: contextToken } : {}),
        },
      },
      this.apiOpts(),
    )
    return clientId
  }
}

function pickMediaType(filename: string, mimeHint?: string): number {
  const lower = filename.toLowerCase()
  const mime = mimeHint?.toLowerCase() ?? ''
  if (mime.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp)$/.test(lower)) return MEDIA_IMAGE
  if (mime.startsWith('video/') || /\.(mp4|mov|webm)$/.test(lower)) return MEDIA_VIDEO
  if (mime.startsWith('audio/') || /\.(silk|mp3|wav|m4a|ogg)$/.test(lower)) return MEDIA_VOICE
  return MEDIA_FILE
}

function buildOutboundMediaItem(params: {
  mediaType: number
  filename: string
  rawsize: number
  ciphertextSize: number
  encryptQueryParam: string
  aesKeyForApi: string
  rawfilemd5: string
}): Record<string, unknown> {
  const media = {
    encrypt_query_param: params.encryptQueryParam,
    aes_key: params.aesKeyForApi,
    encrypt_type: 1,
  }
  if (params.mediaType === MEDIA_IMAGE) {
    return { type: ITEM_IMAGE, image_item: { media, mid_size: params.ciphertextSize } }
  }
  if (params.mediaType === MEDIA_VIDEO) {
    return {
      type: ITEM_VIDEO,
      video_item: {
        media,
        video_size: params.ciphertextSize,
        play_length: 0,
        video_md5: params.rawfilemd5,
      },
    }
  }
  if (params.mediaType === MEDIA_VOICE) {
    return { type: ITEM_VOICE, voice_item: { media, playtime: 0 } }
  }
  return {
    type: ITEM_FILE,
    file_item: { media, file_name: params.filename, len: String(params.rawsize) },
  }
}
