import { createHash, randomBytes } from 'node:crypto'
import { type Server, createServer } from 'node:http'
import { URL } from 'node:url'
import {
  type ChatGptOAuthSession,
  decodeChatGptAccountId,
  decodeChatGptTokenExpiry,
  parseChatGptOAuthSession,
  serializeChatGptOAuthSession,
} from '@zero-os/model'
import { toErrorMessage } from '@zero-os/shared'
import type { Vault } from '@zero-os/secrets'
import { getChatgptOAuthTokenRef } from './chatgpt-provider'

const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CHATGPT_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const CHATGPT_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CHATGPT_REDIRECT_URI = 'http://localhost:1455/auth/callback'
const CHATGPT_SCOPE = 'openid profile email offline_access'
const CALLBACK_PATH = '/auth/callback'
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

export interface ChatGptOAuthStatus {
  provider: 'chatgpt'
  state: ChatGptOAuthState
  authorized: boolean
  error?: string
  attemptId?: string
  expiresAt?: number
  accountId?: string
  requiresRestart: boolean
}

interface PendingAttempt {
  id: string
  state: string
  codeVerifier: string
  server: Server
  status: ChatGptOAuthStatus
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
            : (typeof parsed.message === 'string' ? parsed.message : error),
      }
    }

    if (error && typeof error === 'object') {
      const typedError = error as Record<string, unknown>
      return {
        code:
          typeof typedError.code === 'string'
            ? typedError.code
            : (typeof parsed.code === 'string' ? parsed.code : undefined),
        message:
          typeof typedError.message === 'string'
            ? typedError.message
            : (typeof parsed.error_description === 'string'
                ? parsed.error_description
                : (typeof parsed.message === 'string' ? parsed.message : undefined)),
      }
    }

    return {
      code: typeof parsed.code === 'string' ? parsed.code : undefined,
      message:
        typeof parsed.error_description === 'string'
          ? parsed.error_description
          : (typeof parsed.message === 'string' ? parsed.message : undefined),
    }
  } catch {
    return { message: body.trim() }
  }
}

function isReauthRequiredRefreshFailure(status: number, detail: { code?: string; message?: string }) {
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

export class ChatGptOAuthBroker {
  private vault: Vault
  private attempt: PendingAttempt | null = null

  constructor(vault: Vault) {
    this.vault = vault
  }

  getStatus(): ChatGptOAuthStatus {
    const session = this.readStoredSession()
    if (this.attempt) {
      if (this.attempt.status.state === 'connected' && session) {
        return {
          provider: 'chatgpt',
          state: this.isExpired(session) ? 'expired' : 'connected',
          authorized: !this.isExpired(session),
          expiresAt: session.expiresAt,
          accountId: session.accountId,
          attemptId: this.attempt.id,
          requiresRestart: true,
        }
      }
      return this.attempt.status
    }

    if (!session) {
      return {
        provider: 'chatgpt',
        state: 'idle',
        authorized: false,
        requiresRestart: false,
      }
    }

    return {
      provider: 'chatgpt',
      state: this.isExpired(session) ? 'expired' : 'connected',
      authorized: !this.isExpired(session),
      expiresAt: session.expiresAt,
      accountId: session.accountId,
      requiresRestart: false,
    }
  }

  async start(): Promise<{ attemptId: string; url: string }> {
    await this.resetAttempt()

    const codeVerifier = randomBytes(32).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
    const state = randomBytes(16).toString('hex')
    const attemptId = randomBytes(12).toString('hex')

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CHATGPT_CLIENT_ID,
      redirect_uri: CHATGPT_REDIRECT_URI,
      scope: CHATGPT_SCOPE,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: ORIGINATOR,
    })

    const server = await this.startServer(attemptId, state, codeVerifier)

    this.attempt = {
      id: attemptId,
      state,
      codeVerifier,
      server,
      status: {
        provider: 'chatgpt',
        state: 'waiting_for_callback',
        authorized: false,
        attemptId,
        requiresRestart: false,
      },
    }

    return {
      attemptId,
      url: `${CHATGPT_AUTHORIZE_URL}?${params.toString()}`,
    }
  }

  async completeFromInput(rawInput: string): Promise<ChatGptOAuthStatus> {
    if (!this.attempt) {
      throw new Error('No active ChatGPT OAuth attempt.')
    }

    const parsed = this.parseAuthorizationInput(rawInput)
    if (!parsed.code) {
      throw new Error('Authorization code not found in input.')
    }
    if (parsed.state && parsed.state !== this.attempt.state) {
      throw new Error('State validation failed.')
    }

    await this.exchangeAndStore(parsed.code, this.attempt)
    return this.getStatus()
  }

  async waitForCompletion(timeoutMs = 120_000): Promise<ChatGptOAuthStatus> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const status = this.getStatus()
      if (status.state === 'connected' || status.state === 'expired' || status.state === 'error') {
        return status
      }
      await Bun.sleep(500)
    }

    throw new Error('Timed out waiting for ChatGPT OAuth callback.')
  }

  private async startServer(
    attemptId: string,
    state: string,
    codeVerifier: string,
  ): Promise<Server> {
    return await new Promise<Server>((resolve, reject) => {
      const server = createServer((req, res) => {
        const requestUrl = new URL(req.url ?? '/', 'http://localhost:1455')
        if (requestUrl.pathname !== CALLBACK_PATH) {
          res.statusCode = 404
          res.end('Not found')
          return
        }

        const code = requestUrl.searchParams.get('code')
        const callbackState = requestUrl.searchParams.get('state')
        if (callbackState !== state) {
          this.updateAttempt({
            provider: 'chatgpt',
            state: 'error',
            authorized: false,
            error: 'State validation failed.',
            attemptId,
            requiresRestart: false,
          })
          res.statusCode = 400
          res.end('State mismatch')
          return
        }

        if (!code) {
          this.updateAttempt({
            provider: 'chatgpt',
            state: 'error',
            authorized: false,
            error: 'Missing authorization code.',
            attemptId,
            requiresRestart: false,
          })
          res.statusCode = 400
          res.end('Missing code')
          return
        }

        this.updateAttempt({
          provider: 'chatgpt',
          state: 'authorizing',
          authorized: false,
          attemptId,
          requiresRestart: false,
        })

        res.statusCode = 200
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(
          '<html><body><h2>ZeRo OS</h2><p>ChatGPT authorization received. You can return to ZeRo OS.</p></body></html>',
        )

        void this.exchangeAndStore(code, {
          id: attemptId,
          state,
          codeVerifier,
          server,
          status: this.getStatus(),
        })
      })

      server.once('error', (err) => reject(err))
      server.listen(1455, 'localhost', () => resolve(server))
    })
  }

  private async exchangeAndStore(code: string, attempt: PendingAttempt): Promise<void> {
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CHATGPT_CLIENT_ID,
        code,
        code_verifier: attempt.codeVerifier,
        redirect_uri: CHATGPT_REDIRECT_URI,
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

      const session: ChatGptOAuthSession = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
        tokenType: data.token_type,
        accountId,
      }

      this.vault.set(getChatgptOAuthTokenRef(), serializeChatGptOAuthSession(session))
      this.updateAttempt({
        provider: 'chatgpt',
        state: 'connected',
        authorized: true,
        expiresAt: session.expiresAt,
        accountId: session.accountId,
        attemptId: attempt.id,
        requiresRestart: true,
      })
    } catch (error) {
      this.updateAttempt({
        provider: 'chatgpt',
        state: 'error',
        authorized: false,
        error: toErrorMessage(error),
        attemptId: attempt.id,
        requiresRestart: false,
      })
    } finally {
      await this.resetAttemptServer()
    }
  }

  private parseAuthorizationInput(rawInput: string): { code: string | null; state: string | null } {
    const trimmed = rawInput.trim()
    if (!trimmed) return { code: null, state: null }

    if (/^https?:\/\//i.test(trimmed)) {
      const url = new URL(trimmed)
      return {
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
      }
    }

    return {
      code: trimmed,
      state: null,
    }
  }

  private readStoredSession(): ChatGptOAuthSession | null {
    return readSessionFromVault(this.vault)
  }

  private isExpired(session: ChatGptOAuthSession) {
    return isSessionExpiring(session)
  }

  private updateAttempt(status: ChatGptOAuthStatus) {
    if (!this.attempt) return
    this.attempt.status = status
  }

  private async resetAttemptServer() {
    if (!this.attempt) return
    await new Promise<void>((resolve) => {
      this.attempt?.server.close(() => resolve())
    })
  }

  private async resetAttempt() {
    if (!this.attempt) return
    await this.resetAttemptServer()
    this.attempt = null
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

  async ensureFreshSession(
    options: { minValidityMs?: number } = {},
  ): Promise<ChatGptOAuthSession> {
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
