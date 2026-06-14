import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { sendRawMessage, sendTextMessage } from './api-messages'
import type { ApiOptions, FetchImpl } from './api-transport'
import {
  MAX_MESSAGE_LENGTH,
  MSG_STATE_FINISH,
  MSG_TYPE_BOT,
  WEIXIN_CDN_BASE_URL,
} from './constants'
import {
  aesEncrypt,
  aesPaddedSize,
  encodeAesKeyForApi,
  randomAesKey,
  randomFileKey,
} from './crypto'
import { normalizeMarkdownForWeixin, splitForWeixinDelivery } from './markdown'
import {
  buildOutboundMediaItem,
  cleanMimeType,
  defaultImageFilename,
  extractMarkdownImageReferences,
  filenameFromUrl,
  normalizeImageReference,
  pickMediaType,
} from './media'
import { buildCdnUploadUrl, getUploadUrl, uploadCiphertext } from './media-api'

export interface WeixinDeliveryOptions {
  baseUrl: string
  token: string
  cdnBaseUrl?: string
  botAgent?: string
  accountId: string
  fetchImpl: FetchImpl
  sleep: (ms: number) => Promise<void>
  getContextToken: (accountId: string, chatId: string) => string | undefined
  sendChunkDelayMs: number
  sendChunkRetries: number
  sendChunkRetryDelayMs: number
  splitMultiline: boolean
}

export class WeixinDelivery {
  private readonly baseUrl: string
  private readonly token: string
  private readonly botAgent: string | undefined
  private readonly accountId: string
  private readonly fetchImpl: FetchImpl
  private readonly sleep: (ms: number) => Promise<void>
  private readonly getContextToken: (accountId: string, chatId: string) => string | undefined
  private readonly sendChunkDelayMs: number
  private readonly sendChunkRetries: number
  private readonly sendChunkRetryDelayMs: number
  private readonly splitMultiline: boolean
  private readonly attachments: WeixinOutboundAttachmentDelivery

  constructor(options: WeixinDeliveryOptions) {
    this.baseUrl = options.baseUrl
    this.token = options.token
    this.botAgent = options.botAgent
    this.accountId = options.accountId
    this.fetchImpl = options.fetchImpl
    this.sleep = options.sleep
    this.getContextToken = options.getContextToken
    this.sendChunkDelayMs = options.sendChunkDelayMs
    this.sendChunkRetries = options.sendChunkRetries
    this.sendChunkRetryDelayMs = options.sendChunkRetryDelayMs
    this.splitMultiline = options.splitMultiline
    this.attachments = new WeixinOutboundAttachmentDelivery({
      baseUrl: options.baseUrl,
      token: options.token,
      cdnBaseUrl: options.cdnBaseUrl,
      botAgent: options.botAgent,
      accountId: options.accountId,
      fetchImpl: options.fetchImpl,
      getContextToken: options.getContextToken,
    })
  }

  async sendToChat(chatId: string, content: string): Promise<void> {
    const { text, images } = extractMarkdownImageReferences(content)
    const formatted = normalizeMarkdownForWeixin(text)
    const chunks = splitForWeixinDelivery(formatted, {
      splitMultilineMessages: this.splitMultiline,
      maxLength: MAX_MESSAGE_LENGTH,
    }).filter((chunk) => chunk.trim().length > 0)

    const contextToken = this.contextToken(chatId)
    for (let i = 0; i < chunks.length; i += 1) {
      await this.sendChunkWithRetry(chatId, chunks[i], contextToken)
      if (i < chunks.length - 1 && this.sendChunkDelayMs > 0) {
        await this.sleep(this.sendChunkDelayMs)
      }
    }

    for (const image of images) {
      await this.sendImageReference(chatId, image.reference)
    }
  }

  async sendAttachment(
    chatId: string,
    bytes: Buffer,
    filename: string,
    mimeHint?: string,
  ): Promise<string> {
    return this.attachments.sendAttachment(chatId, bytes, filename, mimeHint)
  }

  private async sendImageReference(chatId: string, reference: string): Promise<void> {
    const resolved = await resolveWeixinImageReference(reference, this.fetchImpl)
    await this.sendAttachment(chatId, resolved.bytes, resolved.filename, resolved.mimeHint)
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

  private contextToken(chatId: string): string | undefined {
    return this.getContextToken(this.accountId, chatId)
  }

  private apiOpts(): ApiOptions {
    return { fetchImpl: this.fetchImpl, botAgent: this.botAgent }
  }
}

interface ResolvedWeixinImageReference {
  bytes: Buffer
  filename: string
  mimeHint?: string
}

async function resolveWeixinImageReference(
  reference: string,
  fetchImpl: FetchImpl,
): Promise<ResolvedWeixinImageReference> {
  const normalizedRef = normalizeImageReference(reference)

  if (normalizedRef.startsWith('data:')) {
    const match = normalizedRef.match(/^data:([^;,]+);base64,([\s\S]+)$/)
    if (!match) throw new Error('Unsupported inline image data URI')
    const mimeHint = match[1].trim()
    return {
      bytes: Buffer.from(match[2].replace(/\s/g, ''), 'base64'),
      filename: defaultImageFilename(mimeHint),
      mimeHint,
    }
  }

  if (normalizedRef.startsWith('http://') || normalizedRef.startsWith('https://')) {
    const response = await fetchImpl(normalizedRef, {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Image download HTTP ${response.status}`)
    const mimeHint = cleanMimeType(response.headers.get('content-type'))
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      filename: filenameFromUrl(normalizedRef, mimeHint),
      mimeHint,
    }
  }

  if (!existsSync(normalizedRef)) {
    throw new Error(`Image file not found: ${normalizedRef}`)
  }
  return {
    bytes: readFileSync(normalizedRef),
    filename: basename(normalizedRef) || 'image.png',
  }
}

interface WeixinOutboundAttachmentDeliveryOptions {
  baseUrl: string
  token: string
  cdnBaseUrl?: string
  botAgent?: string
  accountId: string
  fetchImpl: FetchImpl
  getContextToken: (accountId: string, chatId: string) => string | undefined
}

class WeixinOutboundAttachmentDelivery {
  private readonly baseUrl: string
  private readonly token: string
  private readonly cdnBaseUrl: string
  private readonly botAgent: string | undefined
  private readonly accountId: string
  private readonly fetchImpl: FetchImpl
  private readonly getContextToken: (accountId: string, chatId: string) => string | undefined

  constructor(options: WeixinOutboundAttachmentDeliveryOptions) {
    this.baseUrl = options.baseUrl
    this.token = options.token
    this.cdnBaseUrl = (options.cdnBaseUrl ?? WEIXIN_CDN_BASE_URL).replace(/\/$/, '')
    this.botAgent = options.botAgent
    this.accountId = options.accountId
    this.fetchImpl = options.fetchImpl
    this.getContextToken = options.getContextToken
  }

  async sendAttachment(
    chatId: string,
    bytes: Buffer,
    filename: string,
    mimeHint?: string,
  ): Promise<string> {
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
      uploadUrl = buildCdnUploadUrl(this.cdnBaseUrl, uploadParam, filekey)
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
    const contextToken = this.contextToken(chatId)
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

  private contextToken(chatId: string): string | undefined {
    return this.getContextToken(this.accountId, chatId)
  }

  private apiOpts(): ApiOptions {
    return { fetchImpl: this.fetchImpl, botAgent: this.botAgent }
  }
}
