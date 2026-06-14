import { CHANNEL_VERSION, ILINK_APP_CLIENT_VERSION, ILINK_APP_ID } from './constants'
import { randomWechatUin } from './crypto'

export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface ApiOptions {
  fetchImpl?: FetchImpl
  botAgent?: string
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

const DEFAULT_BOT_AGENT = 'OpenClaw'
const BOT_AGENT_MAX_LEN = 256

export function sanitizeBotAgent(raw: string | undefined): string {
  if (!raw || typeof raw !== 'string') return DEFAULT_BOT_AGENT
  const trimmed = raw.trim()
  if (!trimmed) return DEFAULT_BOT_AGENT

  const productRe = /^[A-Za-z0-9_.-]{1,32}\/[A-Za-z0-9_.+-]{1,32}$/
  const commentCharRe = /^[\x20-\x27\x2A-\x7E]{1,64}$/
  const rawTokens = trimmed.split(/\s+/)
  const tokens: string[] = []

  for (let i = 0; i < rawTokens.length; i += 1) {
    const tok = rawTokens[i]
    if (tok.startsWith('(') && !tok.endsWith(')')) {
      let acc = tok
      while (i + 1 < rawTokens.length && !acc.endsWith(')')) {
        i += 1
        acc += ` ${rawTokens[i]}`
      }
      tokens.push(acc)
    } else {
      tokens.push(tok)
    }
  }

  const accepted: string[] = []
  let pendingProduct: string | null = null
  for (const tok of tokens) {
    if (tok.startsWith('(') && tok.endsWith(')')) {
      const inner = tok.slice(1, -1)
      if (pendingProduct && commentCharRe.test(inner)) {
        accepted.push(`${pendingProduct} (${inner})`)
        pendingProduct = null
      } else if (pendingProduct) {
        accepted.push(pendingProduct)
        pendingProduct = null
      }
      continue
    }
    if (pendingProduct) {
      accepted.push(pendingProduct)
      pendingProduct = null
    }
    if (productRe.test(tok)) pendingProduct = tok
  }
  if (pendingProduct) accepted.push(pendingProduct)
  if (accepted.length === 0) return DEFAULT_BOT_AGENT

  const joined = accepted.join(' ')
  if (Buffer.byteLength(joined, 'utf-8') <= BOT_AGENT_MAX_LEN) return joined

  const truncated: string[] = []
  let len = 0
  for (const token of accepted) {
    const add = (truncated.length === 0 ? 0 : 1) + Buffer.byteLength(token, 'utf-8')
    if (len + add > BOT_AGENT_MAX_LEN) break
    truncated.push(token)
    len += add
  }
  return truncated.length > 0 ? truncated.join(' ') : DEFAULT_BOT_AGENT
}

export function buildBaseInfo(botAgent?: string): { channel_version: string; bot_agent: string } {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: sanitizeBotAgent(botAgent),
  }
}

function buildHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
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

export async function postJson<T>(
  fetchImpl: FetchImpl,
  params: {
    baseUrl: string
    endpoint: string
    payload: Record<string, unknown>
    token: string | null
    timeoutMs: number
  },
  opts: Pick<ApiOptions, 'botAgent'> = {},
): Promise<T> {
  const url = `${params.baseUrl.replace(/\/$/, '')}/${params.endpoint}`
  const body = jsonStringify({ ...params.payload, base_info: buildBaseInfo(opts.botAgent) })
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: buildHeaders(params.token),
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

export async function getJson<T>(
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

export function isAbortError(err: unknown): boolean {
  if (!err) return false
  if (err instanceof Error && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'TimeoutError') return true
  return false
}
