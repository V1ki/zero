/**
 * iLink Bot API wrapper.
 *
 * Mirrors Hermes Agent's weixin.py but factored into pure-function helpers
 * and an injectable `fetch` so every call is testable without real network.
 */

import {
  API_TIMEOUT_MS,
  CHANNEL_VERSION,
  CONFIG_TIMEOUT_MS,
  EP_GET_BOT_QR,
  EP_GET_CONFIG,
  EP_GET_QR_STATUS,
  EP_GET_UPDATES,
  EP_GET_UPLOAD_URL,
  EP_NOTIFY_START,
  EP_NOTIFY_STOP,
  EP_SEND_MESSAGE,
  EP_SEND_TYPING,
  ILINK_APP_CLIENT_VERSION,
  ILINK_APP_ID,
  ITEM_TEXT,
  LONG_POLL_TIMEOUT_MS,
  MSG_STATE_FINISH,
  MSG_TYPE_BOT,
  QR_TIMEOUT_MS,
} from './constants'
import { randomWechatUin } from './crypto'
import type {
  GetUpdatesResponse,
  IncomingMessage,
  QrCodeResponse,
  QrStatusResponse,
  UploadUrlResponse,
} from './types'

export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ApiOptions {
  fetchImpl?: FetchImpl
}

export interface NotifyResponse {
  ret?: number
  errmsg?: string
}

export class ILinkError extends Error {
  constructor(
    message: string,
    public readonly endpoint: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'ILinkError'
  }
}

function buildHeaders(token: string | null, body: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

function jsonStringify(payload: unknown): string {
  return JSON.stringify(payload)
}

async function postJson<T>(
  fetchImpl: FetchImpl,
  params: {
    baseUrl: string
    endpoint: string
    payload: Record<string, unknown>
    token: string | null
    timeoutMs: number
  },
): Promise<T> {
  const url = `${params.baseUrl.replace(/\/$/, '')}/${params.endpoint}`
  const body = jsonStringify({ ...params.payload, base_info: { channel_version: CHANNEL_VERSION } })
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: buildHeaders(params.token, body),
    body,
    signal: AbortSignal.timeout(params.timeoutMs),
  })
  const raw = await response.text()
  if (!response.ok) {
    throw new ILinkError(
      `iLink POST ${params.endpoint} HTTP ${response.status}: ${raw.slice(0, 200)}`,
      params.endpoint,
      response.status,
    )
  }
  return JSON.parse(raw) as T
}

async function getJson<T>(
  fetchImpl: FetchImpl,
  params: { baseUrl: string; endpoint: string; timeoutMs: number },
): Promise<T> {
  const url = `${params.baseUrl.replace(/\/$/, '')}/${params.endpoint}`
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    },
    signal: AbortSignal.timeout(params.timeoutMs),
  })
  const raw = await response.text()
  if (!response.ok) {
    throw new ILinkError(
      `iLink GET ${params.endpoint} HTTP ${response.status}: ${raw.slice(0, 200)}`,
      params.endpoint,
      response.status,
    )
  }
  return JSON.parse(raw) as T
}

function isAbortError(err: unknown): boolean {
  if (!err) return false
  if (err instanceof Error && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'TimeoutError') return true
  return false
}

export async function getUpdates(
  params: { baseUrl: string; token: string; syncBuf: string; timeoutMs?: number },
  opts: ApiOptions = {},
): Promise<GetUpdatesResponse> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const timeoutMs = params.timeoutMs ?? LONG_POLL_TIMEOUT_MS
  try {
    return await postJson<GetUpdatesResponse>(fetchImpl, {
      baseUrl: params.baseUrl,
      endpoint: EP_GET_UPDATES,
      payload: { get_updates_buf: params.syncBuf },
      token: params.token,
      timeoutMs,
    })
  } catch (err) {
    if (isAbortError(err)) {
      return { ret: 0, msgs: [], get_updates_buf: params.syncBuf }
    }
    throw err
  }
}

export async function notifyStart(
  params: { baseUrl: string; token: string },
  opts: ApiOptions = {},
): Promise<NotifyResponse> {
  return postJson(opts.fetchImpl ?? globalThis.fetch, {
    baseUrl: params.baseUrl,
    endpoint: EP_NOTIFY_START,
    payload: {},
    token: params.token,
    timeoutMs: CONFIG_TIMEOUT_MS,
  })
}

export async function notifyStop(
  params: { baseUrl: string; token: string },
  opts: ApiOptions = {},
): Promise<NotifyResponse> {
  return postJson(opts.fetchImpl ?? globalThis.fetch, {
    baseUrl: params.baseUrl,
    endpoint: EP_NOTIFY_STOP,
    payload: {},
    token: params.token,
    timeoutMs: CONFIG_TIMEOUT_MS,
  })
}

export async function sendTextMessage(
  params: {
    baseUrl: string
    token: string
    to: string
    text: string
    contextToken?: string
    clientId: string
  },
  opts: ApiOptions = {},
): Promise<void> {
  if (!params.text || !params.text.trim()) {
    throw new Error('sendTextMessage: text must not be empty')
  }
  const msg: Record<string, unknown> = {
    from_user_id: '',
    to_user_id: params.to,
    client_id: params.clientId,
    message_type: MSG_TYPE_BOT,
    message_state: MSG_STATE_FINISH,
    item_list: [{ type: ITEM_TEXT, text_item: { text: params.text } }],
  }
  if (params.contextToken) msg.context_token = params.contextToken
  await postJson(opts.fetchImpl ?? globalThis.fetch, {
    baseUrl: params.baseUrl,
    endpoint: EP_SEND_MESSAGE,
    payload: { msg },
    token: params.token,
    timeoutMs: API_TIMEOUT_MS,
  })
}

export async function sendRawMessage(
  params: {
    baseUrl: string
    token: string
    msg: Record<string, unknown>
  },
  opts: ApiOptions = {},
): Promise<void> {
  await postJson(opts.fetchImpl ?? globalThis.fetch, {
    baseUrl: params.baseUrl,
    endpoint: EP_SEND_MESSAGE,
    payload: { msg: params.msg },
    token: params.token,
    timeoutMs: API_TIMEOUT_MS,
  })
}

export async function sendTyping(
  params: {
    baseUrl: string
    token: string
    toUserId: string
    typingTicket: string
    status: number
  },
  opts: ApiOptions = {},
): Promise<void> {
  await postJson(opts.fetchImpl ?? globalThis.fetch, {
    baseUrl: params.baseUrl,
    endpoint: EP_SEND_TYPING,
    payload: {
      ilink_user_id: params.toUserId,
      typing_ticket: params.typingTicket,
      status: params.status,
    },
    token: params.token,
    timeoutMs: CONFIG_TIMEOUT_MS,
  })
}

export async function getTypingConfig(
  params: {
    baseUrl: string
    token: string
    userId: string
    contextToken?: string
  },
  opts: ApiOptions = {},
): Promise<{ typing_ticket?: string } & Record<string, unknown>> {
  const payload: Record<string, unknown> = { ilink_user_id: params.userId }
  if (params.contextToken) payload.context_token = params.contextToken
  return postJson(opts.fetchImpl ?? globalThis.fetch, {
    baseUrl: params.baseUrl,
    endpoint: EP_GET_CONFIG,
    payload,
    token: params.token,
    timeoutMs: CONFIG_TIMEOUT_MS,
  })
}

export async function getUploadUrl(
  params: {
    baseUrl: string
    token: string
    toUserId: string
    mediaType: number
    filekey: string
    rawsize: number
    rawfilemd5: string
    filesize: number
    aesKeyHex: string
  },
  opts: ApiOptions = {},
): Promise<UploadUrlResponse> {
  return postJson(opts.fetchImpl ?? globalThis.fetch, {
    baseUrl: params.baseUrl,
    endpoint: EP_GET_UPLOAD_URL,
    payload: {
      filekey: params.filekey,
      media_type: params.mediaType,
      to_user_id: params.toUserId,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      no_need_thumb: true,
      aeskey: params.aesKeyHex,
    },
    token: params.token,
    timeoutMs: API_TIMEOUT_MS,
  })
}

/**
 * POST encrypted media bytes to CDN. Returns the `x-encrypted-param` header
 * which is required as the download token for the receiver.
 */
export async function uploadCiphertext(
  params: { uploadUrl: string; ciphertext: Buffer },
  opts: ApiOptions = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(params.uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(params.ciphertext),
        signal: AbortSignal.timeout(120_000),
      })
      if (response.status >= 400 && response.status < 500) {
        const raw = response.headers.get('x-error-message') ?? (await response.text())
        throw new ILinkError(
          `CDN upload client error HTTP ${response.status}: ${raw.slice(0, 200)}`,
          'cdn-upload',
          response.status,
        )
      }
      if (!response.ok) {
        const raw = await response.text()
        lastError = new ILinkError(
          `CDN upload HTTP ${response.status}: ${raw.slice(0, 200)}`,
          'cdn-upload',
          response.status,
        )
        continue
      }
      const encryptedParam = response.headers.get('x-encrypted-param')
      if (encryptedParam) return encryptedParam
      lastError = new ILinkError('CDN upload missing x-encrypted-param header', 'cdn-upload')
    } catch (err) {
      if (err instanceof ILinkError && err.status && err.status >= 400 && err.status < 500) {
        throw err
      }
      lastError = err
    }
  }
  throw lastError ?? new ILinkError('CDN upload failed after retries', 'cdn-upload')
}

export function buildCdnDownloadUrl(cdnBaseUrl: string, encryptedQueryParam: string): string {
  return `${cdnBaseUrl.replace(/\/$/, '')}/download?encrypted_query_param=${encodeURIComponent(
    encryptedQueryParam,
  )}`
}

export function buildCdnUploadUrl(
  cdnBaseUrl: string,
  uploadParam: string,
  filekey: string,
): string {
  return (
    `${cdnBaseUrl.replace(/\/$/, '')}/upload` +
    `?encrypted_query_param=${encodeURIComponent(uploadParam)}` +
    `&filekey=${encodeURIComponent(filekey)}`
  )
}

export async function downloadBytes(
  params: { url: string; timeoutMs?: number },
  opts: ApiOptions = {},
): Promise<Buffer> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const response = await fetchImpl(params.url, {
    method: 'GET',
    signal: AbortSignal.timeout(params.timeoutMs ?? 60_000),
  })
  if (!response.ok) {
    throw new ILinkError(`download HTTP ${response.status}`, 'cdn-download', response.status)
  }
  const ab = await response.arrayBuffer()
  return Buffer.from(ab)
}

export async function getBotQrCode(
  params: { baseUrl?: string; botType?: string } = {},
  opts: ApiOptions = {},
): Promise<QrCodeResponse> {
  const baseUrl = params.baseUrl ?? 'https://ilinkai.weixin.qq.com'
  const botType = params.botType ?? '3'
  return getJson(opts.fetchImpl ?? globalThis.fetch, {
    baseUrl,
    endpoint: `${EP_GET_BOT_QR}?bot_type=${encodeURIComponent(botType)}`,
    timeoutMs: QR_TIMEOUT_MS,
  })
}

export async function getQrCodeStatus(
  params: { baseUrl: string; qrcode: string },
  opts: ApiOptions = {},
): Promise<QrStatusResponse> {
  return getJson(opts.fetchImpl ?? globalThis.fetch, {
    baseUrl: params.baseUrl,
    endpoint: `${EP_GET_QR_STATUS}?qrcode=${encodeURIComponent(params.qrcode)}`,
    timeoutMs: QR_TIMEOUT_MS,
  })
}

export function incomingMessagesFrom(response: GetUpdatesResponse): IncomingMessage[] {
  return Array.isArray(response.msgs) ? response.msgs : []
}
