import { URLSearchParams } from 'node:url'
import {
  type ChatGptOAuthSession,
  decodeChatGptAccountId,
  decodeChatGptTokenExpiry,
  parseChatGptOAuthSession,
  serializeChatGptOAuthSession,
} from '@zero-os/model'
import type { Vault } from '@zero-os/secrets'
import { getChatgptOAuthTokenRef } from './chatgpt-provider'
import {
  ManagedOAuthCoordinator,
  type ManagedOAuthDriver,
  type ManagedOAuthStatus,
} from './oauth-coordinator'

const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CHATGPT_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const CHATGPT_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CHATGPT_SCOPE = 'openid profile email offline_access'
const ORIGINATOR = 'zero-os'
const CHATGPT_PREEMPTIVE_REFRESH_WINDOW_MS = 15 * 60_000
const CHATGPT_MIN_VALIDITY_MS = 60_000
const CHATGPT_REAUTH_MESSAGE =
  'ChatGPT OAuth session can no longer be refreshed. Please re-authenticate with `bun zero provider login chatgpt`.'

export type ChatGptOAuthState =
  | 'idle'
  | 'waiting_for_callback'
  | 'authorizing'
  | 'connected'
  | 'expired'
  | 'error'

export interface ChatGptOAuthStatus extends ManagedOAuthStatus {
  provider: 'chatgpt'
  state: ChatGptOAuthState
}

type ChatGptRefreshReason = 'expiring' | 'unauthorized'

function readSessionFromVault(vault: Vault): ChatGptOAuthSession | null {
  return parseChatGptOAuthSession(vault.get(getChatgptOAuthTokenRef()))
}

function isSessionExpiring(session: ChatGptOAuthSession, minValidityMs = CHATGPT_MIN_VALIDITY_MS) {
  return Date.now() >= session.expiresAt - minValidityMs
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
  if (
    normalizedCode === 'refresh_token_expired' ||
    normalizedCode === 'refresh_token_reused' ||
    normalizedCode === 'refresh_token_invalidated' ||
    normalizedCode === 'invalid_grant'
  ) {
    return true
  }

  return status === 401
}

export class ChatGptOAuthDriver implements ManagedOAuthDriver<ChatGptOAuthSession> {
  readonly provider = 'chatgpt' as const

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

  async exchangeCode(params: {
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

    const data = (await response.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      token_type?: string
    }

    if (!data.access_token || !data.refresh_token || !data.token_type) {
      throw new Error('Token response missing fields.')
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
      refreshToken: data.refresh_token,
      expiresAt,
      tokenType: data.token_type,
      accountId,
    }
  }

  readSession(vault: Vault): ChatGptOAuthSession | null {
    return readSessionFromVault(vault)
  }

  writeSession(vault: Vault, session: ChatGptOAuthSession) {
    vault.set(getChatgptOAuthTokenRef(), serializeChatGptOAuthSession(session))
  }

  isSessionExpired(session: ChatGptOAuthSession): boolean {
    return isSessionExpiring(session)
  }

  buildConnectedStatus(
    session: ChatGptOAuthSession,
    options: { attemptId?: string; requiresRestart: boolean },
  ): ChatGptOAuthStatus {
    const expired = this.isSessionExpired(session)
    return {
      provider: 'chatgpt',
      state: expired ? 'expired' : 'connected',
      authorized: !expired,
      expiresAt: session.expiresAt,
      accountId: session.accountId,
      attemptId: options.attemptId,
      requiresRestart: options.requiresRestart,
    }
  }

  getCallbackSuccessHtml(): string {
    return '<html><body><h2>ZeRo OS</h2><p>ChatGPT authorization received. You can return to ZeRo OS.</p></body></html>'
  }
}

export class ChatGptOAuthBroker {
  private coordinator: ManagedOAuthCoordinator

  constructor(vault: Vault) {
    this.coordinator = new ManagedOAuthCoordinator(vault, [new ChatGptOAuthDriver()])
  }

  getStatus(): ChatGptOAuthStatus {
    return this.coordinator.getStatus('chatgpt') as ChatGptOAuthStatus
  }

  async start(): Promise<{ attemptId: string; url: string }> {
    return this.coordinator.start('chatgpt')
  }

  async completeFromInput(rawInput: string): Promise<ChatGptOAuthStatus> {
    return (await this.coordinator.completeFromInput('chatgpt', rawInput)) as ChatGptOAuthStatus
  }

  async waitForCompletion(timeoutMs = 120_000): Promise<ChatGptOAuthStatus> {
    return (await this.coordinator.waitForCompletion('chatgpt', timeoutMs)) as ChatGptOAuthStatus
  }
}

export class ChatGptTokenManager {
  private refreshPromise: Promise<ChatGptOAuthSession> | null = null
  private vault: Vault

  constructor(vault: Vault) {
    this.vault = vault
  }

  readSession(): ChatGptOAuthSession | null {
    return readSessionFromVault(this.vault)
  }

  async ensureFreshSession(options: { minValidityMs?: number } = {}): Promise<ChatGptOAuthSession> {
    const session = this.readSession()
    if (!session) {
      throw new Error(
        'ChatGPT OAuth credentials not found. Please run `bun zero provider login chatgpt`.',
      )
    }

    const minValidityMs = options.minValidityMs ?? CHATGPT_PREEMPTIVE_REFRESH_WINDOW_MS
    if (!isSessionExpiring(session, minValidityMs)) {
      return session
    }

    return this.refreshSession('expiring')
  }

  async refreshSession(reason: ChatGptRefreshReason): Promise<ChatGptOAuthSession> {
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    const currentSession = this.readSession()
    if (!currentSession) {
      throw new Error(
        'ChatGPT OAuth credentials not found. Please run `bun zero provider login chatgpt`.',
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
    currentSession: ChatGptOAuthSession,
    _reason: ChatGptRefreshReason,
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
      const detail = extractRefreshErrorDetail(body)
      if (isReauthRequiredRefreshFailure(response.status, detail)) {
        throw new Error(CHATGPT_REAUTH_MESSAGE)
      }

      const message = detail.message ?? body.trim() ?? response.statusText
      throw new Error(`ChatGPT OAuth token refresh failed: ${response.status} ${message}`.trim())
    }

    const data = (await response.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      token_type?: string
    }

    if (!data.access_token) {
      throw new Error('ChatGPT OAuth token refresh response missing access_token.')
    }

    const accountId = decodeChatGptAccountId(data.access_token)
    if (!accountId) {
      throw new Error('Failed to extract chatgpt_account_id from refreshed token.')
    }

    const expiresAt = resolveSessionExpiry(data.access_token, data.expires_in)
    if (!expiresAt) {
      throw new Error('Failed to determine refreshed token expiry.')
    }

    const refreshedSession: ChatGptOAuthSession = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? currentSession.refreshToken,
      expiresAt,
      tokenType: data.token_type ?? currentSession.tokenType,
      accountId,
    }

    if (isSessionExpiring(refreshedSession, CHATGPT_MIN_VALIDITY_MS)) {
      throw new Error(CHATGPT_REAUTH_MESSAGE)
    }

    this.vault.set(getChatgptOAuthTokenRef(), serializeChatGptOAuthSession(refreshedSession))
    return refreshedSession
  }
}
