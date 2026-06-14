import { URLSearchParams } from 'node:url'
import {
  type ChatGptOAuthSession,
  decodeChatGptAccountId,
  decodeChatGptTokenExpiry,
  getChatGptAuthorizationScheme,
  parseChatGptOAuthSession,
  serializeChatGptOAuthSession,
} from '@zero-os/model'
import type { Vault } from '@zero-os/secrets'
import { ManagedOAuthDriverBase } from '../../oauth/provider/driver-base'
import { createOAuthDriverSession } from '../../oauth/provider/driver-session'
import { type OAuthRefreshReason, OAuthTokenManagerBase } from '../../oauth/provider/token-manager'
import { buildOAuthRefreshFailureError } from '../../oauth/refresh'
import type { ManagedOAuthStatus } from '../../oauth/status'
import { getChatgptOAuthTokenRef } from './config'

export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CHATGPT_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const CHATGPT_PREEMPTIVE_REFRESH_WINDOW_MS = 15 * 60_000
export const CHATGPT_MIN_VALIDITY_MS = 60_000
export const CHATGPT_REAUTH_MESSAGE =
  'ChatGPT OAuth session can no longer be refreshed. Please re-authenticate with `bun zero provider login chatgpt`.'

const CHATGPT_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const CHATGPT_SCOPE = 'openid profile email offline_access'
const ORIGINATOR = 'zero-os'

export interface ChatGptOAuthInstanceOptions {
  providerName?: string
  tokenRef?: string
}

export interface ChatGptTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
}

type ChatGptRefreshReason = OAuthRefreshReason

export class ChatGptOAuthDriver extends ManagedOAuthDriverBase<ChatGptOAuthSession> {
  readonly kind = 'chatgpt' as const

  constructor(options: ChatGptOAuthInstanceOptions = {}) {
    const providerName = options.providerName ?? 'chatgpt'
    const tokenRef = options.tokenRef ?? getChatgptOAuthTokenRef()

    super({
      providerName,
      callbackSuccessLabel: 'ChatGPT',
      session: createOAuthDriverSession({
        providerName,
        tokenRef,
        readSession: readChatGptSessionFromVault,
        serializeSession: serializeChatGptOAuthSession,
        isSessionExpiring: isChatGptSessionExpiring,
        createSessionRefresher: (vault, context) => new ChatGptTokenManager(vault, context),
      }),
    })
  }

  getCallbackConfig() {
    return {
      redirectUri: 'http://localhost:1455/auth/callback',
    }
  }

  buildAuthorizationUrl(params: {
    state: string
    redirectUri: string
    codeVerifier: string
    codeChallenge: string
  }): string {
    return buildChatGptAuthorizationUrl(params)
  }

  async exchangeCode(params: {
    code: string
    state: string
    redirectUri: string
    codeVerifier: string
  }): Promise<ChatGptOAuthSession> {
    return await exchangeChatGptCode(params)
  }

  buildConnectedStatus(
    session: ChatGptOAuthSession,
    options: { attemptId?: string; requiresRestart: boolean },
  ): ManagedOAuthStatus {
    return this.buildConnectedOAuthStatus(session, options, {
      expiresAt: session.expiresAt,
      accountId: session.accountId,
    })
  }
}

export class ChatGptTokenManager extends OAuthTokenManagerBase<
  ChatGptOAuthSession,
  ChatGptRefreshReason
> {
  constructor(vault: Vault, options: ChatGptOAuthInstanceOptions = {}) {
    const providerName = options.providerName ?? 'chatgpt'
    const tokenRef = options.tokenRef ?? getChatgptOAuthTokenRef()
    super({
      providerLabel: 'ChatGPT',
      providerName,
      loginCommand: 'bun zero provider login chatgpt',
      preemptiveRefreshWindowMs: CHATGPT_PREEMPTIVE_REFRESH_WINDOW_MS,
      minValidityMs: CHATGPT_MIN_VALIDITY_MS,
      reauthMessage: CHATGPT_REAUTH_MESSAGE,
      readSession: () => readChatGptSessionFromVault(vault, tokenRef),
      persistSession: (session) => vault.set(tokenRef, serializeChatGptOAuthSession(session)),
      isSessionExpiring: (session, minValidityMs) =>
        isChatGptSessionExpiring(session, minValidityMs),
    })
  }

  protected async performRefresh(
    currentSession: ChatGptOAuthSession,
    _reason: ChatGptRefreshReason,
  ): Promise<ChatGptOAuthSession> {
    return await refreshChatGptOAuthSession(currentSession)
  }
}

export function readChatGptSessionFromVault(
  vault: Vault,
  tokenRef = getChatgptOAuthTokenRef(),
): ChatGptOAuthSession | null {
  return parseChatGptOAuthSession(vault.get(tokenRef))
}

export function isChatGptSessionExpiring(
  session: ChatGptOAuthSession,
  minValidityMs = CHATGPT_MIN_VALIDITY_MS,
): boolean {
  return Date.now() >= session.expiresAt - minValidityMs
}

export function buildChatGptAuthorizationUrl(params: {
  state: string
  redirectUri: string
  codeVerifier: string
  codeChallenge: string
}): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CHATGPT_CLIENT_ID,
    redirect_uri: params.redirectUri,
    scope: CHATGPT_SCOPE,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    state: params.state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: ORIGINATOR,
  })

  return `${CHATGPT_AUTHORIZE_URL}?${query.toString()}`
}

export async function exchangeChatGptCode(params: {
  code: string
  state: string
  redirectUri: string
  codeVerifier: string
}): Promise<ChatGptOAuthSession> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CHATGPT_CLIENT_ID,
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
  })

  const response = await fetch(CHATGPT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`)
  }

  return buildChatGptSession((await response.json()) as ChatGptTokenResponse)
}

export async function refreshChatGptOAuthSession(
  currentSession: ChatGptOAuthSession,
): Promise<ChatGptOAuthSession> {
  const response = await fetch(CHATGPT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: CHATGPT_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: currentSession.refreshToken,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw buildOAuthRefreshFailureError({
      providerLabel: 'ChatGPT',
      status: response.status,
      statusText: response.statusText,
      body,
      reauthMessage: CHATGPT_REAUTH_MESSAGE,
      reauthCodes: [
        'refresh_token_expired',
        'refresh_token_reused',
        'refresh_token_invalidated',
        'invalid_grant',
      ],
      includeReauthContext: false,
    })
  }

  return buildChatGptSession((await response.json()) as ChatGptTokenResponse, currentSession)
}

export function buildChatGptSession(
  data: ChatGptTokenResponse,
  fallbackSession?: ChatGptOAuthSession,
): ChatGptOAuthSession {
  if (!data.access_token) {
    throw new Error('ChatGPT OAuth token response missing access_token.')
  }

  const refreshToken = data.refresh_token ?? fallbackSession?.refreshToken
  if (!refreshToken) {
    throw new Error('ChatGPT OAuth token response missing refresh_token.')
  }

  const tokenType = data.token_type ?? fallbackSession?.tokenType
  if (!tokenType) {
    throw new Error('ChatGPT OAuth token response missing token_type.')
  }

  const accountId = decodeChatGptAccountId(data.access_token)
  if (!accountId) {
    throw new Error('Failed to extract chatgpt_account_id from token.')
  }

  const expiresAt = resolveSessionExpiry(data.access_token, data.expires_in)
  if (!expiresAt) {
    throw new Error('Failed to determine token expiry from token response.')
  }

  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt,
    tokenType: getChatGptAuthorizationScheme(tokenType),
    accountId,
  }
}

function resolveSessionExpiry(
  accessToken: string,
  expiresInSeconds: number | undefined,
): number | null {
  if (typeof expiresInSeconds === 'number' && Number.isFinite(expiresInSeconds)) {
    return Date.now() + expiresInSeconds * 1000
  }

  return decodeChatGptTokenExpiry(accessToken)
}
