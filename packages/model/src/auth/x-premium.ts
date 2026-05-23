export interface XPremiumOAuthAccount {
  subject?: string
  emailAddress?: string
  displayName?: string
  username?: string
}

export interface XPremiumOAuthSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  tokenType: string
  scopes: string[]
  idToken?: string
  tokenEndpoint?: string
  account?: XPremiumOAuthAccount
}

export function getXPremiumAuthorizationScheme(tokenType: string): string {
  return tokenType.trim().toLowerCase() === 'bearer' ? 'Bearer' : tokenType
}

export function serializeXPremiumOAuthSession(session: XPremiumOAuthSession): string {
  return JSON.stringify(session)
}

export function parseXPremiumOAuthSession(raw: string | undefined): XPremiumOAuthSession | null {
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const accessToken = typeof parsed.accessToken === 'string' ? parsed.accessToken : undefined
    const refreshToken = typeof parsed.refreshToken === 'string' ? parsed.refreshToken : undefined
    const expiresAt = typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined
    const tokenType = typeof parsed.tokenType === 'string' ? parsed.tokenType : undefined
    const scopes = Array.isArray(parsed.scopes)
      ? parsed.scopes.filter((value): value is string => typeof value === 'string')
      : undefined

    if (!accessToken || !refreshToken || !expiresAt || !tokenType || !scopes) {
      return null
    }

    const rawAccount =
      parsed.account && typeof parsed.account === 'object'
        ? (parsed.account as Record<string, unknown>)
        : undefined

    return {
      accessToken,
      refreshToken,
      expiresAt,
      tokenType,
      scopes,
      idToken: typeof parsed.idToken === 'string' ? parsed.idToken : undefined,
      tokenEndpoint: typeof parsed.tokenEndpoint === 'string' ? parsed.tokenEndpoint : undefined,
      account: rawAccount
        ? {
            subject: typeof rawAccount.subject === 'string' ? rawAccount.subject : undefined,
            emailAddress:
              typeof rawAccount.emailAddress === 'string' ? rawAccount.emailAddress : undefined,
            displayName:
              typeof rawAccount.displayName === 'string' ? rawAccount.displayName : undefined,
            username: typeof rawAccount.username === 'string' ? rawAccount.username : undefined,
          }
        : undefined,
    }
  } catch {
    return null
  }
}

export function decodeXPremiumTokenExpiry(token: string): number | null {
  const claims = decodeJwtPayload(token)
  if (!claims) return null

  const exp = claims.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null
}

export function decodeXPremiumAccount(token: string | undefined): XPremiumOAuthAccount | undefined {
  if (!token) return undefined
  const claims = decodeJwtPayload(token)
  if (!claims) return undefined

  return {
    subject: typeof claims.sub === 'string' ? claims.sub : undefined,
    emailAddress: typeof claims.email === 'string' ? claims.email : undefined,
    displayName: typeof claims.name === 'string' ? claims.name : undefined,
    username:
      typeof claims.preferred_username === 'string'
        ? claims.preferred_username
        : typeof claims.username === 'string'
          ? claims.username
          : undefined,
  }
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
