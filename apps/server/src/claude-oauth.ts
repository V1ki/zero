import {
  type ClaudeOAuthSession,
  parseClaudeOAuthSession,
  serializeClaudeOAuthSession,
} from '@zero-os/model'
import type { Vault } from '@zero-os/secrets'
import { getClaudeOAuthSessionRef } from './claude-provider'
import {
  ManagedOAuthCoordinator,
  type ManagedOAuthDriver,
  type ManagedOAuthStatus,
} from './oauth-coordinator'

const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CLAUDE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const CLAUDE_SCOPE = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]
const CLAUDE_PREEMPTIVE_REFRESH_WINDOW_MS = 15 * 60_000
const CLAUDE_MIN_VALIDITY_MS = 60_000
const CLAUDE_REAUTH_MESSAGE =
  'Claude OAuth session can no longer be refreshed. Please re-authenticate with `bun zero provider login anthropic`.'

export type ClaudeOAuthState =
  | 'idle'
  | 'waiting_for_callback'
  | 'authorizing'
  | 'connected'
  | 'expired'
  | 'error'

export interface ClaudeOAuthStatus extends ManagedOAuthStatus {
  provider: 'anthropic'
  state: ClaudeOAuthState
}

type ClaudeRefreshReason = 'expiring' | 'unauthorized'

interface ClaudeTokenExchangeResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
  account?: {
    uuid?: string
    email_address?: string
  }
  organization?: {
    uuid?: string
  }
}

interface ClaudeProfileResponse {
  account?: {
    uuid?: string
    email_address?: string
    display_name?: string
  }
  organization?: {
    uuid?: string
    organization_type?: string
    rate_limit_tier?: string | null
  }
}

function readSessionFromVault(vault: Vault): ClaudeOAuthSession | null {
  return parseClaudeOAuthSession(vault.get(getClaudeOAuthSessionRef()))
}

function isSessionExpiring(session: ClaudeOAuthSession, minValidityMs = CLAUDE_MIN_VALIDITY_MS) {
  return Date.now() >= session.expiresAt - minValidityMs
}

function parseScopes(scope: string | undefined): string[] {
  return scope?.split(' ').filter(Boolean) ?? []
}

function mapClaudeSubscriptionType(
  organizationType: string | undefined,
): ClaudeOAuthSession['subscriptionType'] {
  switch (organizationType) {
    case 'claude_max':
      return 'max'
    case 'claude_pro':
      return 'pro'
    case 'claude_enterprise':
      return 'enterprise'
    case 'claude_team':
      return 'team'
    default:
      return null
  }
}

async function fetchClaudeProfile(accessToken: string): Promise<ClaudeProfileResponse | null> {
  try {
    const response = await fetch(CLAUDE_PROFILE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      return null
    }

    return (await response.json()) as ClaudeProfileResponse
  } catch {
    return null
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

function buildSession(
  data: ClaudeTokenExchangeResponse,
  profile: ClaudeProfileResponse | null,
  fallbackRefreshToken?: string,
  fallbackSession?: ClaudeOAuthSession,
): ClaudeOAuthSession {
  if (!data.access_token) {
    throw new Error('Claude OAuth token response missing access_token.')
  }

  if (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in)) {
    throw new Error('Claude OAuth token response missing expires_in.')
  }

  const refreshToken = data.refresh_token ?? fallbackRefreshToken
  if (!refreshToken) {
    throw new Error('Claude OAuth token response missing refresh_token.')
  }

  const scopes = parseScopes(data.scope)
  const account = {
    accountUuid: profile?.account?.uuid ?? data.account?.uuid,
    emailAddress: profile?.account?.email_address ?? data.account?.email_address,
    organizationUuid: profile?.organization?.uuid ?? data.organization?.uuid,
    displayName: profile?.account?.display_name ?? fallbackSession?.account?.displayName,
  }

  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    tokenType: data.token_type ?? fallbackSession?.tokenType ?? 'Bearer',
    scopes: scopes.length > 0 ? scopes : (fallbackSession?.scopes ?? CLAUDE_SCOPE),
    subscriptionType:
      mapClaudeSubscriptionType(profile?.organization?.organization_type) ??
      fallbackSession?.subscriptionType ??
      null,
    rateLimitTier: profile?.organization?.rate_limit_tier ?? fallbackSession?.rateLimitTier ?? null,
    account,
  }
}

export class ClaudeOAuthDriver implements ManagedOAuthDriver<ClaudeOAuthSession> {
  readonly provider = 'anthropic' as const

  getCallbackConfig() {
    return {
      listenHost: 'localhost',
      listenPort: 0,
      callbackPath: '/callback',
    }
  }

  buildAuthorizationUrl(params: {
    state: string
    redirectUri: string
    codeVerifier: string
    codeChallenge: string
  }): string {
    const url = new URL(CLAUDE_AUTHORIZE_URL)
    url.searchParams.set('code', 'true')
    url.searchParams.set('client_id', CLAUDE_CLIENT_ID)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', params.redirectUri)
    url.searchParams.set('scope', CLAUDE_SCOPE.join(' '))
    url.searchParams.set('code_challenge', params.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', params.state)
    return url.toString()
  }

  async exchangeCode(params: {
    code: string
    state: string
    redirectUri: string
    codeVerifier: string
  }): Promise<ClaudeOAuthSession> {
    const response = await fetch(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: params.redirectUri,
        client_id: CLAUDE_CLIENT_ID,
        code_verifier: params.codeVerifier,
        state: params.state,
      }),
    })

    if (!response.ok) {
      throw new Error(`Claude token exchange failed: ${response.status} ${await response.text()}`)
    }

    const data = (await response.json()) as ClaudeTokenExchangeResponse
    const profile = data.access_token ? await fetchClaudeProfile(data.access_token) : null
    return buildSession(data, profile)
  }

  readSession(vault: Vault): ClaudeOAuthSession | null {
    return readSessionFromVault(vault)
  }

  writeSession(vault: Vault, session: ClaudeOAuthSession) {
    vault.set(getClaudeOAuthSessionRef(), serializeClaudeOAuthSession(session))
  }

  isSessionExpired(session: ClaudeOAuthSession): boolean {
    return isSessionExpiring(session)
  }

  buildConnectedStatus(
    session: ClaudeOAuthSession,
    options: { attemptId?: string; requiresRestart: boolean },
  ): ClaudeOAuthStatus {
    const expired = this.isSessionExpired(session)
    return {
      provider: 'anthropic',
      state: expired ? 'expired' : 'connected',
      authorized: !expired,
      expiresAt: session.expiresAt,
      accountId: session.account?.accountUuid,
      accountEmail: session.account?.emailAddress,
      displayName: session.account?.displayName,
      subscriptionType: session.subscriptionType ?? null,
      rateLimitTier: session.rateLimitTier ?? null,
      attemptId: options.attemptId,
      requiresRestart: options.requiresRestart,
    }
  }

  async refreshStatus(vault: Vault): Promise<void> {
    await new ClaudeTokenManager(vault).ensureFreshSession()
  }

  getCallbackSuccessHtml(): string {
    return '<html><body><h2>ZeRo OS</h2><p>Claude authorization received. You can return to ZeRo OS.</p></body></html>'
  }
}

export class ClaudeOAuthBroker {
  private coordinator: ManagedOAuthCoordinator

  constructor(vault: Vault) {
    this.coordinator = new ManagedOAuthCoordinator(vault, [new ClaudeOAuthDriver()])
  }

  getStatus(): ClaudeOAuthStatus {
    return this.coordinator.getStatus('anthropic') as ClaudeOAuthStatus
  }

  async start(): Promise<{ attemptId: string; url: string }> {
    return this.coordinator.start('anthropic')
  }

  async completeFromInput(rawInput: string): Promise<ClaudeOAuthStatus> {
    return (await this.coordinator.completeFromInput('anthropic', rawInput)) as ClaudeOAuthStatus
  }

  async waitForCompletion(timeoutMs = 120_000): Promise<ClaudeOAuthStatus> {
    return (await this.coordinator.waitForCompletion('anthropic', timeoutMs)) as ClaudeOAuthStatus
  }
}

export class ClaudeTokenManager {
  private refreshPromise: Promise<ClaudeOAuthSession> | null = null
  private vault: Vault

  constructor(vault: Vault) {
    this.vault = vault
  }

  readSession(): ClaudeOAuthSession | null {
    return readSessionFromVault(this.vault)
  }

  async ensureFreshSession(options: { minValidityMs?: number } = {}): Promise<ClaudeOAuthSession> {
    const session = this.readSession()
    if (!session) {
      throw new Error(
        'Claude OAuth credentials not found. Please run `bun zero provider login anthropic`.',
      )
    }

    const minValidityMs = options.minValidityMs ?? CLAUDE_PREEMPTIVE_REFRESH_WINDOW_MS
    if (!isSessionExpiring(session, minValidityMs)) {
      return session
    }

    return this.refreshSession('expiring')
  }

  async refreshSession(reason: ClaudeRefreshReason): Promise<ClaudeOAuthSession> {
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    const currentSession = this.readSession()
    if (!currentSession) {
      throw new Error(
        'Claude OAuth credentials not found. Please run `bun zero provider login anthropic`.',
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
    currentSession: ClaudeOAuthSession,
    _reason: ClaudeRefreshReason,
  ): Promise<ClaudeOAuthSession> {
    const response = await fetch(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: currentSession.refreshToken,
        client_id: CLAUDE_CLIENT_ID,
        scope: currentSession.scopes.join(' '),
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      const detail = extractRefreshErrorDetail(body)
      if (isReauthRequiredRefreshFailure(response.status, detail)) {
        throw new Error(CLAUDE_REAUTH_MESSAGE)
      }

      const message = detail.message ?? body.trim() ?? response.statusText
      throw new Error(`Claude OAuth token refresh failed: ${response.status} ${message}`.trim())
    }

    const data = (await response.json()) as ClaudeTokenExchangeResponse
    const profile = data.access_token ? await fetchClaudeProfile(data.access_token) : null
    const refreshedSession = buildSession(
      data,
      profile,
      currentSession.refreshToken,
      currentSession,
    )

    if (isSessionExpiring(refreshedSession, CLAUDE_MIN_VALIDITY_MS)) {
      throw new Error(CLAUDE_REAUTH_MESSAGE)
    }

    this.vault.set(getClaudeOAuthSessionRef(), serializeClaudeOAuthSession(refreshedSession))
    return refreshedSession
  }
}
