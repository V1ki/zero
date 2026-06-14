import {
  type ClaudeOAuthSession,
  parseClaudeOAuthSession,
  serializeClaudeOAuthSession,
} from '@zero-os/model'
import type { Vault } from '@zero-os/secrets'
import { ManagedOAuthDriverBase } from '../../oauth/provider/driver-base'
import { createOAuthDriverSession } from '../../oauth/provider/driver-session'
import { type OAuthRefreshReason, OAuthTokenManagerBase } from '../../oauth/provider/token-manager'
import { buildOAuthRefreshFailureError } from '../../oauth/refresh'
import type { ManagedOAuthStatus } from '../../oauth/status'
import { getClaudeOAuthSessionRef } from './config'

export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const CLAUDE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
export const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
export const CLAUDE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
export const CLAUDE_SCOPE = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]
export const CLAUDE_PREEMPTIVE_REFRESH_WINDOW_MS = 15 * 60_000
export const CLAUDE_MIN_VALIDITY_MS = 60_000
export const CLAUDE_REAUTH_MESSAGE =
  'Claude OAuth session can no longer be refreshed. Please re-authenticate with `bun zero provider login anthropic`.'

export interface ClaudeOAuthInstanceOptions {
  providerName?: string
  tokenRef?: string
}

export interface ClaudeProfileResponse {
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

export interface ClaudeTokenExchangeResponse {
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

type ClaudeRefreshReason = OAuthRefreshReason

export class ClaudeOAuthDriver extends ManagedOAuthDriverBase<ClaudeOAuthSession> {
  readonly kind = 'anthropic' as const

  constructor(options: ClaudeOAuthInstanceOptions = {}) {
    const providerName = options.providerName ?? 'anthropic'
    const tokenRef = options.tokenRef ?? getClaudeOAuthSessionRef()

    super({
      providerName,
      callbackSuccessLabel: 'Claude',
      session: createOAuthDriverSession({
        providerName,
        tokenRef,
        readSession: readClaudeSessionFromVault,
        serializeSession: serializeClaudeOAuthSession,
        isSessionExpiring: isClaudeSessionExpiring,
        createSessionRefresher: (vault, context) => new ClaudeTokenManager(vault, context),
      }),
    })
  }

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
    return buildClaudeAuthorizationUrl(params)
  }

  async exchangeCode(params: {
    code: string
    state: string
    redirectUri: string
    codeVerifier: string
  }): Promise<ClaudeOAuthSession> {
    return await exchangeClaudeCode(params)
  }

  buildConnectedStatus(
    session: ClaudeOAuthSession,
    options: { attemptId?: string; requiresRestart: boolean },
  ): ManagedOAuthStatus {
    return this.buildConnectedOAuthStatus(session, options, {
      expiresAt: session.expiresAt,
      accountId: session.account?.accountUuid,
      accountEmail: session.account?.emailAddress,
      displayName: session.account?.displayName,
      subscriptionType: session.subscriptionType ?? null,
      rateLimitTier: session.rateLimitTier ?? null,
    })
  }
}

export class ClaudeTokenManager extends OAuthTokenManagerBase<
  ClaudeOAuthSession,
  ClaudeRefreshReason
> {
  constructor(vault: Vault, options: ClaudeOAuthInstanceOptions = {}) {
    const providerName = options.providerName ?? 'anthropic'
    const tokenRef = options.tokenRef ?? getClaudeOAuthSessionRef()
    super({
      providerLabel: 'Claude',
      providerName,
      loginCommand: 'bun zero provider login anthropic',
      preemptiveRefreshWindowMs: CLAUDE_PREEMPTIVE_REFRESH_WINDOW_MS,
      minValidityMs: CLAUDE_MIN_VALIDITY_MS,
      reauthMessage: CLAUDE_REAUTH_MESSAGE,
      readSession: () => readClaudeSessionFromVault(vault, tokenRef),
      persistSession: (session) => vault.set(tokenRef, serializeClaudeOAuthSession(session)),
      isSessionExpiring: (session, minValidityMs) =>
        isClaudeSessionExpiring(session, minValidityMs),
    })
  }

  protected async performRefresh(
    currentSession: ClaudeOAuthSession,
    _reason: ClaudeRefreshReason,
  ): Promise<ClaudeOAuthSession> {
    return await refreshClaudeOAuthSession(currentSession)
  }
}

export function readClaudeSessionFromVault(
  vault: Vault,
  tokenRef = getClaudeOAuthSessionRef(),
): ClaudeOAuthSession | null {
  return parseClaudeOAuthSession(vault.get(tokenRef))
}

export function isClaudeSessionExpiring(
  session: ClaudeOAuthSession,
  minValidityMs = CLAUDE_MIN_VALIDITY_MS,
): boolean {
  return Date.now() >= session.expiresAt - minValidityMs
}

export function buildClaudeAuthorizationUrl(params: {
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

export async function exchangeClaudeCode(params: {
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
  return buildClaudeSession(data, profile)
}

export async function refreshClaudeOAuthSession(
  currentSession: ClaudeOAuthSession,
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
    throw buildOAuthRefreshFailureError({
      providerLabel: 'Claude',
      status: response.status,
      statusText: response.statusText,
      body,
      reauthMessage: CLAUDE_REAUTH_MESSAGE,
      reauthCodes: ['invalid_grant', 'invalid_token'],
    })
  }

  const data = (await response.json()) as ClaudeTokenExchangeResponse
  const profile = data.access_token ? await fetchClaudeProfile(data.access_token) : null
  return buildClaudeSession(data, profile, currentSession.refreshToken, currentSession)
}

export async function fetchClaudeProfile(
  accessToken: string,
): Promise<ClaudeProfileResponse | null> {
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

export function buildClaudeSession(
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

  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    tokenType: data.token_type ?? fallbackSession?.tokenType ?? 'Bearer',
    scopes: resolveClaudeSessionScopes(data.scope, fallbackSession),
    subscriptionType: resolveClaudeSessionSubscriptionType(profile, fallbackSession),
    rateLimitTier: resolveClaudeSessionRateLimitTier(profile, fallbackSession),
    account: resolveClaudeSessionAccount(data, profile, fallbackSession),
  }
}

function resolveClaudeSessionScopes(
  scope: string | undefined,
  fallbackSession?: ClaudeOAuthSession,
): string[] {
  const scopes = scope?.split(' ').filter(Boolean) ?? []
  return scopes.length > 0 ? scopes : (fallbackSession?.scopes ?? CLAUDE_SCOPE)
}

function resolveClaudeSessionSubscriptionType(
  profile: ClaudeProfileResponse | null,
  fallbackSession?: ClaudeOAuthSession,
): ClaudeOAuthSession['subscriptionType'] {
  return (
    mapClaudeSubscriptionType(profile?.organization?.organization_type) ??
    fallbackSession?.subscriptionType ??
    null
  )
}

function resolveClaudeSessionRateLimitTier(
  profile: ClaudeProfileResponse | null,
  fallbackSession?: ClaudeOAuthSession,
): string | null {
  return profile?.organization?.rate_limit_tier ?? fallbackSession?.rateLimitTier ?? null
}

function resolveClaudeSessionAccount(
  data: ClaudeTokenExchangeResponse,
  profile: ClaudeProfileResponse | null,
  fallbackSession?: ClaudeOAuthSession,
): ClaudeOAuthSession['account'] {
  return {
    accountUuid: profile?.account?.uuid ?? data.account?.uuid,
    emailAddress: profile?.account?.email_address ?? data.account?.email_address,
    organizationUuid: profile?.organization?.uuid ?? data.organization?.uuid,
    displayName: profile?.account?.display_name ?? fallbackSession?.account?.displayName,
  }
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
