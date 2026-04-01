import { createHash, randomBytes } from 'node:crypto'
import { type Server, createServer } from 'node:http'
import { URL } from 'node:url'
import type { Vault } from '@zero-os/secrets'
import { toErrorMessage } from '@zero-os/shared'

export const DEFAULT_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback'

export type ManagedOAuthProvider = 'chatgpt' | 'claude'

export type ManagedOAuthState =
  | 'idle'
  | 'waiting_for_callback'
  | 'authorizing'
  | 'connected'
  | 'expired'
  | 'error'

export interface ManagedOAuthStatus {
  provider: string
  state: ManagedOAuthState
  authorized: boolean
  error?: string
  attemptId?: string
  expiresAt?: number
  accountId?: string
  accountEmail?: string
  displayName?: string
  subscriptionType?: string | null
  rateLimitTier?: string | null
  requiresRestart: boolean
}

export interface ManagedOAuthDriver<Session = unknown> {
  readonly provider: ManagedOAuthProvider
  buildAuthorizationUrl(params: {
    state: string
    redirectUri: string
    codeVerifier: string
    codeChallenge: string
  }): string
  exchangeCode(params: {
    code: string
    state: string
    redirectUri: string
    codeVerifier: string
  }): Promise<Session>
  readSession(vault: Vault): Session | null
  writeSession(vault: Vault, session: Session): void
  isSessionExpired(session: Session): boolean
  buildConnectedStatus(
    session: Session,
    options: {
      attemptId?: string
      requiresRestart: boolean
    },
  ): ManagedOAuthStatus
  getCallbackSuccessHtml?(): string
}

interface PendingAttempt {
  id: string
  provider: ManagedOAuthProvider
  state: string
  codeVerifier: string
  status: ManagedOAuthStatus
}

export interface ManagedOAuthCoordinatorOptions {
  redirectUri?: string
  listenHost?: string
  listenPort?: number
}

export class ManagedOAuthCoordinator {
  private vault: Vault
  private drivers = new Map<ManagedOAuthProvider, ManagedOAuthDriver>()
  private attemptsByProvider = new Map<ManagedOAuthProvider, PendingAttempt>()
  private attemptsByState = new Map<string, PendingAttempt>()
  private server: Server | null = null
  private readonly redirectUri: string
  private readonly callbackPath: string
  private readonly listenHost: string
  private readonly listenPort: number
  private readonly callbackOrigin: string

  constructor(
    vault: Vault,
    drivers: ManagedOAuthDriver[],
    options: ManagedOAuthCoordinatorOptions = {},
  ) {
    this.vault = vault
    this.redirectUri = options.redirectUri ?? DEFAULT_OAUTH_REDIRECT_URI

    const parsed = new URL(this.redirectUri)
    this.callbackPath = parsed.pathname
    this.listenHost = options.listenHost ?? parsed.hostname
    this.listenPort =
      options.listenPort ?? Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
    this.callbackOrigin = `${parsed.protocol}//${parsed.host}`

    for (const driver of drivers) {
      this.drivers.set(driver.provider, driver)
    }
  }

  supportsProvider(provider: string): provider is ManagedOAuthProvider {
    return this.drivers.has(provider as ManagedOAuthProvider)
  }

  getStatus(provider: ManagedOAuthProvider): ManagedOAuthStatus {
    const driver = this.requireDriver(provider)
    const attempt = this.attemptsByProvider.get(provider)
    const storedSession = driver.readSession(this.vault)

    if (attempt) {
      if (attempt.status.state === 'connected' && storedSession) {
        return driver.buildConnectedStatus(storedSession, {
          attemptId: attempt.id,
          requiresRestart: true,
        })
      }

      return attempt.status
    }

    if (!storedSession) {
      return this.buildIdleStatus(provider)
    }

    return driver.buildConnectedStatus(storedSession, {
      requiresRestart: false,
    })
  }

  async start(provider: ManagedOAuthProvider): Promise<{ attemptId: string; url: string }> {
    const driver = this.requireDriver(provider)
    await this.ensureServer()
    this.clearAttempt(provider)

    const codeVerifier = randomBytes(32).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
    const state = randomBytes(16).toString('hex')
    const attemptId = randomBytes(12).toString('hex')

    const attempt: PendingAttempt = {
      id: attemptId,
      provider,
      state,
      codeVerifier,
      status: {
        provider,
        state: 'waiting_for_callback',
        authorized: false,
        attemptId,
        requiresRestart: false,
      },
    }

    this.attemptsByProvider.set(provider, attempt)
    this.attemptsByState.set(state, attempt)

    return {
      attemptId,
      url: driver.buildAuthorizationUrl({
        state,
        redirectUri: this.redirectUri,
        codeVerifier,
        codeChallenge,
      }),
    }
  }

  async completeFromInput(
    provider: ManagedOAuthProvider,
    rawInput: string,
  ): Promise<ManagedOAuthStatus> {
    const attempt = this.attemptsByProvider.get(provider)
    if (!attempt) {
      throw new Error(`No active ${provider} OAuth attempt.`)
    }

    const parsed = this.parseAuthorizationInput(rawInput)
    if (!parsed.code) {
      throw new Error('Authorization code not found in input.')
    }
    if (parsed.state && parsed.state !== attempt.state) {
      throw new Error('State validation failed.')
    }

    this.updateAttempt(provider, {
      provider,
      state: 'authorizing',
      authorized: false,
      attemptId: attempt.id,
      requiresRestart: false,
    })

    await this.exchangeAndStore(attempt, parsed.code)
    return this.getStatus(provider)
  }

  async waitForCompletion(
    provider: ManagedOAuthProvider,
    timeoutMs = 120_000,
  ): Promise<ManagedOAuthStatus> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const status = this.getStatus(provider)
      if (status.state === 'connected' || status.state === 'expired' || status.state === 'error') {
        return status
      }
      await Bun.sleep(500)
    }

    throw new Error(`Timed out waiting for ${provider} OAuth callback.`)
  }

  private buildIdleStatus(provider: ManagedOAuthProvider): ManagedOAuthStatus {
    return {
      provider,
      state: 'idle',
      authorized: false,
      requiresRestart: false,
    }
  }

  private requireDriver(provider: ManagedOAuthProvider): ManagedOAuthDriver {
    const driver = this.drivers.get(provider)
    if (!driver) {
      throw new Error(`Unsupported OAuth provider: ${provider}`)
    }
    return driver
  }

  private async ensureServer() {
    if (this.server) return

    this.server = await new Promise<Server>((resolve, reject) => {
      const server = createServer((req, res) => {
        const requestUrl = new URL(req.url ?? '/', this.callbackOrigin)
        if (requestUrl.pathname !== this.callbackPath) {
          res.statusCode = 404
          res.end('Not found')
          return
        }

        const callbackState = requestUrl.searchParams.get('state')
        const attempt = callbackState ? this.attemptsByState.get(callbackState) : undefined
        if (!attempt) {
          res.statusCode = 400
          res.end('Unknown OAuth attempt')
          return
        }

        const code = requestUrl.searchParams.get('code')
        if (!code) {
          this.updateAttempt(attempt.provider, {
            provider: attempt.provider,
            state: 'error',
            authorized: false,
            error: 'Missing authorization code.',
            attemptId: attempt.id,
            requiresRestart: false,
          })
          res.statusCode = 400
          res.end('Missing code')
          return
        }

        this.updateAttempt(attempt.provider, {
          provider: attempt.provider,
          state: 'authorizing',
          authorized: false,
          attemptId: attempt.id,
          requiresRestart: false,
        })

        const driver = this.requireDriver(attempt.provider)
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(
          driver.getCallbackSuccessHtml?.() ??
            `<html><body><h2>ZeRo OS</h2><p>${attempt.provider} authorization received. You can return to ZeRo OS.</p></body></html>`,
        )

        void this.exchangeAndStore(attempt, code)
      })

      server.once('error', (error) => reject(error))
      server.listen(this.listenPort, this.listenHost, () => resolve(server))
    })
  }

  private async exchangeAndStore(attempt: PendingAttempt, code: string) {
    const driver = this.requireDriver(attempt.provider)

    try {
      const session = await driver.exchangeCode({
        code,
        state: attempt.state,
        redirectUri: this.redirectUri,
        codeVerifier: attempt.codeVerifier,
      })

      driver.writeSession(this.vault, session)
      this.updateAttempt(
        attempt.provider,
        driver.buildConnectedStatus(session, {
          attemptId: attempt.id,
          requiresRestart: true,
        }),
      )
    } catch (error) {
      this.updateAttempt(attempt.provider, {
        provider: attempt.provider,
        state: 'error',
        authorized: false,
        error: toErrorMessage(error),
        attemptId: attempt.id,
        requiresRestart: false,
      })
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

  private updateAttempt(provider: ManagedOAuthProvider, status: ManagedOAuthStatus) {
    const attempt = this.attemptsByProvider.get(provider)
    if (!attempt) return
    attempt.status = status
  }

  private clearAttempt(provider: ManagedOAuthProvider) {
    const existing = this.attemptsByProvider.get(provider)
    if (!existing) return

    this.attemptsByProvider.delete(provider)
    this.attemptsByState.delete(existing.state)
  }
}
