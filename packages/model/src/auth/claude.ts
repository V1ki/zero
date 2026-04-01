export interface ClaudeOAuthAccount {
  accountUuid?: string
  emailAddress?: string
  organizationUuid?: string
  displayName?: string
}

export interface ClaudeOAuthSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  tokenType: string
  scopes: string[]
  subscriptionType?: string | null
  rateLimitTier?: string | null
  account?: ClaudeOAuthAccount
}

export function serializeClaudeOAuthSession(session: ClaudeOAuthSession): string {
  return JSON.stringify(session)
}

export function parseClaudeOAuthSession(raw: string | undefined): ClaudeOAuthSession | null {
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
      subscriptionType:
        typeof parsed.subscriptionType === 'string' || parsed.subscriptionType === null
          ? parsed.subscriptionType
          : undefined,
      rateLimitTier:
        typeof parsed.rateLimitTier === 'string' || parsed.rateLimitTier === null
          ? parsed.rateLimitTier
          : undefined,
      account: rawAccount
        ? {
            accountUuid:
              typeof rawAccount.accountUuid === 'string' ? rawAccount.accountUuid : undefined,
            emailAddress:
              typeof rawAccount.emailAddress === 'string' ? rawAccount.emailAddress : undefined,
            organizationUuid:
              typeof rawAccount.organizationUuid === 'string'
                ? rawAccount.organizationUuid
                : undefined,
            displayName:
              typeof rawAccount.displayName === 'string' ? rawAccount.displayName : undefined,
          }
        : undefined,
    }
  } catch {
    return null
  }
}

export function resolveClaudeOAuthAccessToken(raw: string | undefined): string | undefined {
  const session = parseClaudeOAuthSession(raw)
  return session?.accessToken ?? raw
}
