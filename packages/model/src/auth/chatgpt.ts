const CHATGPT_ACCOUNT_CLAIM_PATH = ['https://api.openai.com/auth', 'chatgpt_account_id'] as const

export interface ChatGptOAuthSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  tokenType: string
  accountId: string
}

export function serializeChatGptOAuthSession(session: ChatGptOAuthSession): string {
  return JSON.stringify(session)
}

export function parseChatGptOAuthSession(raw: string | undefined): ChatGptOAuthSession | null {
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const accessToken = typeof parsed.accessToken === 'string' ? parsed.accessToken : undefined
    const refreshToken = typeof parsed.refreshToken === 'string' ? parsed.refreshToken : undefined
    const expiresAt = typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined
    const tokenType = typeof parsed.tokenType === 'string' ? parsed.tokenType : undefined
    const accountId = typeof parsed.accountId === 'string' ? parsed.accountId : undefined

    if (!accessToken || !refreshToken || !expiresAt || !tokenType || !accountId) {
      return null
    }

    return {
      accessToken,
      refreshToken,
      expiresAt,
      tokenType,
      accountId,
    }
  } catch {
    return null
  }
}

export function decodeChatGptAccountId(accessToken: string): string | null {
  const claims = decodeJwtPayload(accessToken)
  if (!claims) return null

  let current: unknown = claims
  for (const key of CHATGPT_ACCOUNT_CLAIM_PATH) {
    if (!current || typeof current !== 'object' || !(key in current)) {
      return null
    }
    current = (current as Record<string, unknown>)[key]
  }

  return typeof current === 'string' && current.trim() ? current : null
}

export function decodeChatGptTokenExpiry(accessToken: string): number | null {
  const claims = decodeJwtPayload(accessToken)
  if (!claims) return null

  const exp = claims.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length < 2) return null

  try {
    const payload = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=')

    return JSON.parse(Buffer.from(payload, 'base64').toString('utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}
