import { createHash, randomBytes } from 'node:crypto'
import { URLSearchParams } from 'node:url'
import {
  type XPremiumOAuthSession,
  decodeXPremiumAccount,
  decodeXPremiumTokenExpiry,
  getXPremiumAuthorizationScheme,
  parseXPremiumOAuthSession,
  serializeXPremiumOAuthSession,
} from '@zero-os/model'
import type { Vault } from '@zero-os/secrets'
import {
  ManagedOAuthCoordinator,
  type ManagedOAuthDriver,
  type ManagedOAuthStatus,
} from './oauth-coordinator'
import { getXPremiumOAuthSessionRef } from './x-premium-provider'

const XAI_OAUTH_ISSUER = 'https://auth.x.ai'
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`
const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const XAI_OAUTH_SCOPE = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'grok-cli:access',
  'api:access',
]
const XAI_REDIRECT_HOST = '127.0.0.1'
const XAI_REDIRECT_PORT = 56121
const XAI_REDIRECT_PATH = '/callback'
const X_PREMIUM_PREEMPTIVE_REFRESH_WINDOW_MS = 2 * 60_000
const X_PREMIUM_MIN_VALIDITY_MS = 60_000
const X_PREMIUM_REAUTH_MESSAGE =
  'X Premium OAuth session can no longer be refreshed. Please re-authenticate with `bun zero provider login x-premium`.'
const X_PREMIUM_TIER_DENIED_MESSAGE =
  'This X Premium OAuth account is not authorized for xAI API access. xAI may restrict API/OAuth access by plan tier; re-authentication usually will not change this. Use XAI_API_KEY with an API-key provider if available, or check the subscription at https://x.ai/grok.'

export type XPremiumOAuthState =
  | 'idle'
  | 'waiting_for_callback'
  | 'authorizing'
  | 'connected'
  | 'expired'
  | 'error'

export interface XPremiumOAuthStatus extends ManagedOAuthStatus {
  provider: string
  state: XPremiumOAuthState
}

type XPremiumRefreshReason = 'expiring' | 'unauthorized'

interface XPremiumOAuthInstanceOptions {
  providerName?: string
  tokenRef?: string
}

interface XPremiumDiscovery {
  authorizationEndpoint: string
  tokenEndpoint: string
}

interface XPremiumTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
  id_token?: string
}

function readSessionFromVault(
  vault: Vault,
  tokenRef = getXPremiumOAuthSessionRef(),
): XPremiumOAuthSession | null {
  return parseXPremiumOAuthSession(vault.get(tokenRef))
}

function isSessionExpiring(
  session: XPremiumOAuthSession,
  minValidityMs = X_PREMIUM_MIN_VALIDITY_MS,
) {
  return Date.now() >= session.expiresAt - minValidityMs
}

function parseScopes(scope: string | undefined): string[] {
  return scope?.split(' ').filter(Boolean) ?? XAI_OAUTH_SCOPE
}

function resolveSessionExpiry(accessToken: string, expiresInSeconds: number | undefined) {
  if (typeof expiresInSeconds === 'number' && Number.isFinite(expiresInSeconds)) {
    return Date.now() + expiresInSeconds * 1000
  }

  return decodeXPremiumTokenExpiry(accessToken)
}

function buildCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url')
}

function validateXPremiumOAuthEndpoint(url: string, field: string) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') {
    throw new Error(`xAI OIDC discovery returned a non-HTTPS ${field}: ${url}`)
  }

  const host = parsed.hostname.toLowerCase()
  if (host !== 'x.ai' && !host.endsWith('.x.ai')) {
    throw new Error(`xAI OIDC discovery ${field} host "${host}" is not on the xAI origin.`)
  }
}

async function discoverXPremiumOAuth(): Promise<XPremiumDiscovery> {
  const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`xAI OIDC discovery failed: ${response.status} ${await response.text()}`)
  }

  const payload = (await response.json()) as Record<string, unknown>
  const authorizationEndpoint =
    typeof payload.authorization_endpoint === 'string' ? payload.authorization_endpoint.trim() : ''
  const tokenEndpoint =
    typeof payload.token_endpoint === 'string' ? payload.token_endpoint.trim() : ''

  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error('xAI OIDC discovery response was missing required endpoints.')
  }

  validateXPremiumOAuthEndpoint(authorizationEndpoint, 'authorization_endpoint')
  validateXPremiumOAuthEndpoint(tokenEndpoint, 'token_endpoint')

  return {
    authorizationEndpoint,
    tokenEndpoint,
  }
}

function extractRefreshErrorDetail(body: string): { code?: string; message?: string } {
  if (!body.trim()) return {}

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const error = parsed.error
    if (typeof error === 'string') {
      return {
        code: error,
        message:
          typeof parsed.error_description === 'string'
            ? parsed.error_description
            : typeof parsed.message === 'string'
              ? parsed.message
              : error,
      }
    }

    if (error && typeof error === 'object') {
      const typedError = error as Record<string, unknown>
      return {
        code:
          typeof typedError.code === 'string'
            ? typedError.code
            : typeof parsed.code === 'string'
              ? parsed.code
              : undefined,
        message:
          typeof typedError.message === 'string'
            ? typedError.message
            : typeof parsed.error_description === 'string'
              ? parsed.error_description
              : typeof parsed.message === 'string'
                ? parsed.message
                : undefined,
      }
    }

    return {
      code: typeof parsed.code === 'string' ? parsed.code : undefined,
      message:
        typeof parsed.error_description === 'string'
          ? parsed.error_description
          : typeof parsed.message === 'string'
            ? parsed.message
            : undefined,
    }
  } catch {
    return { message: body.trim() }
  }
}

function isReauthRequiredRefreshFailure(
  status: number,
  detail: { code?: string; message?: string },
) {
  const normalizedCode = detail.code?.toLowerCase()
  return normalizedCode === 'invalid_grant' || normalizedCode === 'invalid_token' || status === 401
}

function buildReauthErrorMessage(status: number, detail: { code?: string; message?: string }) {
  const context: string[] = []
  if (status > 0) context.push(`status=${status}`)
  if (detail.code) {
    context.push(`code=${detail.code}`)
  } else if (detail.message) {
    const normalizedMessage = detail.message.trim().replace(/\s+/g, ' ')
    if (normalizedMessage) context.push(`reason=${normalizedMessage.slice(0, 120)}`)
  }

  return context.length > 0
    ? `${X_PREMIUM_REAUTH_MESSAGE} [${context.join(', ')}]`
    : X_PREMIUM_REAUTH_MESSAGE
}

function buildTierDeniedError(prefix: string, body: string) {
  const detail = body.trim()
  return new Error(
    `${prefix}.${detail ? ` Response: ${detail}.` : ''} ${X_PREMIUM_TIER_DENIED_MESSAGE}`,
  )
}

function buildSession(
  data: XPremiumTokenResponse,
  tokenEndpoint: string,
  fallbackRefreshToken?: string,
  fallbackSession?: XPremiumOAuthSession,
): XPremiumOAuthSession {
  if (!data.access_token) {
    throw new Error('X Premium OAuth token response missing access_token.')
  }

  const refreshToken = data.refresh_token ?? fallbackRefreshToken
  if (!refreshToken) {
    throw new Error('X Premium OAuth token response missing refresh_token.')
  }

  const expiresAt = resolveSessionExpiry(data.access_token, data.expires_in)
  if (!expiresAt) {
    throw new Error('Failed to determine X Premium OAuth token expiry.')
  }

  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt,
    tokenType: getXPremiumAuthorizationScheme(
      data.token_type ?? fallbackSession?.tokenType ?? 'Bearer',
    ),
    scopes: parseScopes(data.scope),
    idToken: data.id_token ?? fallbackSession?.idToken,
    tokenEndpoint,
    account:
      decodeXPremiumAccount(data.id_token) ??
      decodeXPremiumAccount(data.access_token) ??
      fallbackSession?.account,
  }
}

export class XPremiumOAuthDriver implements ManagedOAuthDriver<XPremiumOAuthSession> {
  readonly provider: string
  readonly kind = 'x-premium' as const
  private tokenRef: string

  constructor(options: XPremiumOAuthInstanceOptions = {}) {
    this.provider = options.providerName ?? 'x-premium'
    this.tokenRef = options.tokenRef ?? getXPremiumOAuthSessionRef()
  }

  getCallbackConfig() {
    return {
      listenHost: XAI_REDIRECT_HOST,
      listenPort: XAI_REDIRECT_PORT,
      callbackPath: XAI_REDIRECT_PATH,
    }
  }

  async buildAuthorizationUrl(params: {
    state: string
    redirectUri: string
    codeVerifier: string
    codeChallenge: string
  }): Promise<string> {
    const discovery = await discoverXPremiumOAuth()
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: XAI_OAUTH_CLIENT_ID,
      redirect_uri: params.redirectUri,
      scope: XAI_OAUTH_SCOPE.join(' '),
      code_challenge: params.codeChallenge,
      code_challenge_method: 'S256',
      state: params.state,
      nonce: randomBytes(16).toString('hex'),
      plan: 'generic',
      referrer: 'zero-os',
    })

    return `${discovery.authorizationEndpoint}?${query.toString()}`
  }

  async exchangeCode(params: {
    code: string
    state: string
    redirectUri: string
    codeVerifier: string
  }): Promise<XPremiumOAuthSession> {
    const discovery = await discoverXPremiumOAuth()
    const codeChallenge = buildCodeChallenge(params.codeVerifier)
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: XAI_OAUTH_CLIENT_ID,
      code_verifier: params.codeVerifier,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })

    const response = await fetch(discovery.tokenEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })

    if (!response.ok) {
      const body = await response.text()
      if (response.status === 403) {
        throw buildTierDeniedError('xAI token exchange failed with HTTP 403', body)
      }
      throw new Error(`xAI token exchange failed: ${response.status} ${body}`)
    }

    return buildSession((await response.json()) as XPremiumTokenResponse, discovery.tokenEndpoint)
  }

  readSession(vault: Vault): XPremiumOAuthSession | null {
    return readSessionFromVault(vault, this.tokenRef)
  }

  writeSession(vault: Vault, session: XPremiumOAuthSession) {
    vault.set(this.tokenRef, serializeXPremiumOAuthSession(session))
  }

  isSessionExpired(session: XPremiumOAuthSession): boolean {
    return isSessionExpiring(session)
  }

  buildConnectedStatus(
    session: XPremiumOAuthSession,
    options: { attemptId?: string; requiresRestart: boolean },
  ): XPremiumOAuthStatus {
    const expired = this.isSessionExpired(session)
    return {
      provider: this.provider,
      state: expired ? 'expired' : 'connected',
      authorized: !expired,
      expiresAt: session.expiresAt,
      accountId: session.account?.subject,
      accountEmail: session.account?.emailAddress,
      displayName: session.account?.displayName ?? session.account?.username,
      attemptId: options.attemptId,
      requiresRestart: options.requiresRestart,
    }
  }

  async refreshStatus(vault: Vault, options: { force?: boolean } = {}): Promise<void> {
    const manager = new XPremiumTokenManager(vault, {
      providerName: this.provider,
      tokenRef: this.tokenRef,
    })
    if (options.force) {
      await manager.refreshSession('unauthorized')
      return
    }
    await manager.ensureFreshSession()
  }

  getCallbackSuccessHtml(): string {
    return '<html><body><h2>ZeRo OS</h2><p>X Premium authorization received. You can return to ZeRo OS.</p></body></html>'
  }
}

export class XPremiumOAuthBroker {
  private coordinator: ManagedOAuthCoordinator

  constructor(vault: Vault) {
    this.coordinator = new ManagedOAuthCoordinator(vault, [new XPremiumOAuthDriver()])
  }

  getStatus(): XPremiumOAuthStatus {
    return this.coordinator.getStatus('x-premium') as XPremiumOAuthStatus
  }

  async start(): Promise<{ attemptId: string; url: string }> {
    return this.coordinator.start('x-premium')
  }

  async completeFromInput(rawInput: string): Promise<XPremiumOAuthStatus> {
    return (await this.coordinator.completeFromInput('x-premium', rawInput)) as XPremiumOAuthStatus
  }

  async waitForCompletion(timeoutMs = 120_000): Promise<XPremiumOAuthStatus> {
    return (await this.coordinator.waitForCompletion('x-premium', timeoutMs)) as XPremiumOAuthStatus
  }
}

export class XPremiumTokenManager {
  private refreshPromise: Promise<XPremiumOAuthSession> | null = null
  private vault: Vault
  private providerName: string
  private tokenRef: string

  constructor(vault: Vault, options: XPremiumOAuthInstanceOptions = {}) {
    this.vault = vault
    this.providerName = options.providerName ?? 'x-premium'
    this.tokenRef = options.tokenRef ?? getXPremiumOAuthSessionRef()
  }

  readSession(): XPremiumOAuthSession | null {
    return readSessionFromVault(this.vault, this.tokenRef)
  }

  async ensureFreshSession(
    options: { minValidityMs?: number } = {},
  ): Promise<XPremiumOAuthSession> {
    const session = this.readSession()
    if (!session) {
      throw new Error(
        `X Premium OAuth credentials not found for ${this.providerName}. Please run \`bun zero provider login x-premium\`.`,
      )
    }

    const minValidityMs = options.minValidityMs ?? X_PREMIUM_PREEMPTIVE_REFRESH_WINDOW_MS
    if (!isSessionExpiring(session, minValidityMs)) {
      return session
    }

    return this.refreshSession('expiring')
  }

  async refreshSession(reason: XPremiumRefreshReason): Promise<XPremiumOAuthSession> {
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    const currentSession = this.readSession()
    if (!currentSession) {
      throw new Error(
        `X Premium OAuth credentials not found for ${this.providerName}. Please run \`bun zero provider login x-premium\`.`,
      )
    }

    const refreshPromise = this.performRefresh(currentSession, reason).finally(() => {
      if (this.refreshPromise === refreshPromise) {
        this.refreshPromise = null
      }
    })

    this.refreshPromise = refreshPromise
    return refreshPromise
  }

  private async performRefresh(
    currentSession: XPremiumOAuthSession,
    _reason: XPremiumRefreshReason,
  ): Promise<XPremiumOAuthSession> {
    const tokenEndpoint =
      currentSession.tokenEndpoint ?? (await discoverXPremiumOAuth()).tokenEndpoint
    validateXPremiumOAuthEndpoint(tokenEndpoint, 'token_endpoint')

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: currentSession.refreshToken,
    })

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })

    if (!response.ok) {
      const body = await response.text()
      const detail = extractRefreshErrorDetail(body)
      if (response.status === 403) {
        throw buildTierDeniedError('xAI token refresh failed with HTTP 403', body)
      }
      if (isReauthRequiredRefreshFailure(response.status, detail)) {
        throw new Error(buildReauthErrorMessage(response.status, detail))
      }

      const message = detail.message ?? body.trim() ?? response.statusText
      throw new Error(`X Premium OAuth token refresh failed: ${response.status} ${message}`.trim())
    }

    const refreshedSession = buildSession(
      (await response.json()) as XPremiumTokenResponse,
      tokenEndpoint,
      currentSession.refreshToken,
      currentSession,
    )

    if (isSessionExpiring(refreshedSession, X_PREMIUM_MIN_VALIDITY_MS)) {
      throw new Error(X_PREMIUM_REAUTH_MESSAGE)
    }

    this.vault.set(this.tokenRef, serializeXPremiumOAuthSession(refreshedSession))
    return refreshedSession
  }
}
