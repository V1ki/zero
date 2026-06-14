import { type ApiOptions, ILinkError, postJson } from './api-transport'
import { API_TIMEOUT_MS, EP_GET_UPLOAD_URL } from './constants'
import type { UploadUrlResponse } from './types'

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
  return postJson(
    opts.fetchImpl ?? globalThis.fetch,
    {
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
    },
    opts,
  )
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
