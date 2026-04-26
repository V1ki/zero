import { describe, expect, test } from 'bun:test'
import {
  ILinkError,
  buildCdnDownloadUrl,
  buildCdnUploadUrl,
  getBotQrCode,
  getQrCodeStatus,
  getUpdates,
  getUploadUrl,
  notifyStart,
  notifyStop,
  sendTextMessage,
  uploadCiphertext,
} from '../weixin/api'

interface UploadRequestCapture {
  rawsize?: unknown
  rawfilemd5?: unknown
  filesize?: unknown
}

function okJson(body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

describe('buildCdnDownloadUrl / buildCdnUploadUrl', () => {
  test('URL-encodes the encrypted query param', () => {
    const url = buildCdnDownloadUrl('https://cdn.example/c2c', 'a b/c=d')
    expect(url).toBe('https://cdn.example/c2c/download?encrypted_query_param=a%20b%2Fc%3Dd')
  })

  test('includes filekey in upload URL', () => {
    const url = buildCdnUploadUrl('https://cdn.example/c2c/', 'token', 'fk1')
    expect(url).toContain('filekey=fk1')
    expect(url).toContain('encrypted_query_param=token')
  })
})

describe('sendTextMessage', () => {
  test('injects base_info and context_token', async () => {
    let capturedBody: unknown
    const fetchImpl = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedBody = JSON.parse(String(init?.body ?? '{}'))
      return okJson({ ret: 0 })
    }
    await sendTextMessage(
      {
        baseUrl: 'https://api.example',
        token: 'tok',
        to: 'peer',
        text: 'hi',
        contextToken: 'ctx',
        clientId: 'cid',
      },
      { fetchImpl },
    )
    const body = capturedBody as {
      msg: { context_token?: string; item_list: unknown[] }
      base_info: { channel_version: string }
    }
    expect(body.base_info.channel_version).toBe('2.1.10')
    expect(body.msg.context_token).toBe('ctx')
    expect(Array.isArray(body.msg.item_list)).toBe(true)
  })

  test('rejects empty text', async () => {
    await expect(
      sendTextMessage(
        { baseUrl: 'x', token: 't', to: 'p', text: '   ', clientId: 'c' },
        { fetchImpl: async () => okJson({}) },
      ),
    ).rejects.toThrow()
  })

  test('throws ILinkError on non-ok response', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('boom', { status: 500 })
    await expect(
      sendTextMessage(
        { baseUrl: 'x', token: 't', to: 'p', text: 'hi', clientId: 'c' },
        { fetchImpl },
      ),
    ).rejects.toBeInstanceOf(ILinkError)
  })
})

describe('notifyStart / notifyStop', () => {
  test('post only base_info to notify endpoints', async () => {
    const calls: Array<{ url: string; body: { base_info?: { channel_version?: string } } }> = []
    const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as {
          base_info?: { channel_version?: string }
        },
      })
      return okJson({ ret: 0 })
    }

    await notifyStart({ baseUrl: 'https://api', token: 'tok' }, { fetchImpl })
    await notifyStop({ baseUrl: 'https://api', token: 'tok' }, { fetchImpl })

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/ilink/bot/msg/notifystart',
      '/ilink/bot/msg/notifystop',
    ])
    expect(calls.every((call) => call.body.base_info?.channel_version === '2.1.10')).toBe(true)
  })
})

describe('getUpdates', () => {
  test('returns payload on success', async () => {
    const fetchImpl = async (): Promise<Response> =>
      okJson({ ret: 0, get_updates_buf: 'c2', msgs: [{ message_id: 'm1' }] })
    const res = await getUpdates(
      { baseUrl: 'https://api', token: 't', syncBuf: 'c1' },
      { fetchImpl },
    )
    expect(res.get_updates_buf).toBe('c2')
    expect(res.msgs?.length).toBe(1)
  })

  test('AbortError / timeout becomes empty result', async () => {
    const fetchImpl = async (): Promise<Response> => {
      const err = new Error('aborted') as Error & { name: string }
      err.name = 'AbortError'
      throw err
    }
    const res = await getUpdates(
      { baseUrl: 'x', token: 't', syncBuf: 'cursor' },
      { fetchImpl },
    )
    expect(res.msgs).toEqual([])
    expect(res.get_updates_buf).toBe('cursor')
  })
})

describe('getUploadUrl', () => {
  test('sends rawfilemd5 and padded filesize', async () => {
    let captured: UploadRequestCapture | null = null
    const fetchImpl = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      captured = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return okJson({ upload_param: 'p', upload_full_url: 'https://cdn.example/upload/x' })
    }
    const resp = await getUploadUrl(
      {
        baseUrl: 'https://api',
        token: 'tok',
        toUserId: 'peer',
        mediaType: 1,
        filekey: 'fk',
        rawsize: 100,
        rawfilemd5: 'abc',
        filesize: 112,
        aesKeyHex: 'deadbeef',
      },
      { fetchImpl },
    )
    expect(resp.upload_full_url).toMatch(/^https:\/\/cdn/)
    expect(captured).not.toBeNull()
    const payload: UploadRequestCapture = captured ?? {}
    expect(payload.rawsize).toBe(100)
    expect(payload.filesize).toBe(112)
    expect(payload.rawfilemd5).toBe('abc')
  })
})

describe('uploadCiphertext', () => {
  test('returns x-encrypted-param header value', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response('', { status: 200, headers: { 'x-encrypted-param': 'ep-1' } })
    const result = await uploadCiphertext(
      { uploadUrl: 'https://cdn/x', ciphertext: Buffer.from('cipher') },
      { fetchImpl },
    )
    expect(result).toBe('ep-1')
  })

  test('throws when header missing', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('', { status: 200 })
    await expect(
      uploadCiphertext(
        { uploadUrl: 'https://cdn/x', ciphertext: Buffer.alloc(0) },
        { fetchImpl },
      ),
    ).rejects.toThrow()
  })

  test('retries server error and returns success header', async () => {
    let attempts = 0
    const fetchImpl = async (): Promise<Response> => {
      attempts += 1
      if (attempts === 1) return new Response('server error', { status: 500 })
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'ep-retry' } })
    }
    const result = await uploadCiphertext(
      { uploadUrl: 'https://cdn/x', ciphertext: Buffer.from('cipher') },
      { fetchImpl },
    )
    expect(result).toBe('ep-retry')
    expect(attempts).toBe(2)
  })

  test('does not retry 4xx client errors', async () => {
    let attempts = 0
    const fetchImpl = async (): Promise<Response> => {
      attempts += 1
      return new Response('bad request', {
        status: 400,
        headers: { 'x-error-message': 'invalid token' },
      })
    }
    await expect(
      uploadCiphertext(
        { uploadUrl: 'https://cdn/x', ciphertext: Buffer.from('cipher') },
        { fetchImpl },
      ),
    ).rejects.toThrow(/invalid token/)
    expect(attempts).toBe(1)
  })
})

describe('QR endpoints', () => {
  test('getBotQrCode uses GET and bot_type query', async () => {
    let capturedUrl = ''
    const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedUrl = String(url)
      expect(init?.method ?? 'GET').toBe('GET')
      return okJson({ qrcode: 'q', qrcode_img_content: 'data' })
    }
    const res = await getBotQrCode({}, { fetchImpl })
    expect(capturedUrl).toContain('bot_type=3')
    expect(res.qrcode).toBe('q')
  })

  test('getQrCodeStatus encodes qrcode', async () => {
    let capturedUrl = ''
    const fetchImpl = async (url: RequestInfo | URL): Promise<Response> => {
      capturedUrl = String(url)
      return okJson({ status: 'wait' })
    }
    await getQrCodeStatus({ baseUrl: 'https://api', qrcode: 'abc=def' }, { fetchImpl })
    expect(capturedUrl).toContain('qrcode=abc%3Ddef')
  })
})
