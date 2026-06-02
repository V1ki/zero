import { createHash, randomBytes } from 'node:crypto'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { URL } from 'node:url'
import type { Vault } from '@zero-os/secrets'
import { toErrorMessage } from '@zero-os/shared'

export const DEFAULT_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback'

export type ManagedOAuthProviderKind = 'chatgpt' | 'anthropic' | 'x-premium'
export type ManagedOAuthProvider = string

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

export interface ManagedOAuthCallbackConfig {
  redirectUri?: string
  listenHost?: string
  listenPort?: number
  callbackPath?: string
}

export interface ManagedOAuthDriver<Session = unknown> {
  readonly provider: ManagedOAuthProvider
  readonly kind?: ManagedOAuthProviderKind
  getCallbackConfig?(): ManagedOAuthCallbackConfig
  buildAuthorizationUrl(params: {
    state: string
    redirectUri: string
    codeVerifier: string
    codeChallenge: string
  }): string | Promise<string>
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
  refreshStatus?(vault: Vault, options?: { force?: boolean }): Promise<void>
  getCallbackSuccessHtml?(): string
}

export interface ManagedOAuthStatusRefreshOptions {
  strict?: boolean
  force?: boolean
}

interface ResolvedCallbackConfig {
  protocol: 'http:' | 'https:'
  listenHost: string
  listenPort: number
  callbackPath: string
}

interface PendingAttempt {
  id: string
  provider: ManagedOAuthProvider
  state: string
  codeVerifier: string
  redirectUri: string
  callbackPath: string
  server: Server | null
  status: ManagedOAuthStatus
}

export interface ManagedOAuthCoordinatorOptions {
  redirectUri?: string
  listenHost?: string
  listenPort?: number
  callbackPath?: string
}

export class ManagedOAuthCoordinator {
  private vault: Vault
  private drivers = new Map<ManagedOAuthProvider, ManagedOAuthDriver>()
  private attemptsByProvider = new Map<ManagedOAuthProvider, PendingAttempt>()
  private readonly defaultCallbackConfig: ResolvedCallbackConfig

  constructor(
    vault: Vault,
    drivers: ManagedOAuthDriver[],
    options: ManagedOAuthCoordinatorOptions = {},
  ) {
    this.vault = vault
    this.defaultCallbackConfig = this.parseDefaultCallbackConfig(options)

    for (const driver of drivers) {
      this.registerDriver(driver)
    }
  }

  registerDriver(driver: ManagedOAuthDriver): void {
    this.drivers.set(driver.provider, driver)
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

  async getStatusWithRefresh(
    provider: ManagedOAuthProvider,
    options: ManagedOAuthStatusRefreshOptions = {},
  ): Promise<ManagedOAuthStatus> {
    const attempt = this.attemptsByProvider.get(provider)
    if (attempt) {
      return this.getStatus(provider)
    }

    const driver = this.requireDriver(provider)
    const storedSession = driver.readSession(this.vault)
    if (!storedSession) {
      return this.buildIdleStatus(provider)
    }

    if (driver.refreshStatus) {
      try {
        await driver.refreshStatus(this.vault, {
          force: options.force ?? options.strict === true,
        })
      } catch (error) {
        if (options.strict) {
          return {
            provider,
            state: 'error',
            authorized: false,
            error: toErrorMessage(error),
            requiresRestart: false,
          }
        }
        // Fall back to the stored session status. Real request paths still handle
        // refresh errors explicitly; status reads stay best-effort.
      }
    }

    return this.getStatus(provider)
  }

  async start(provider: ManagedOAuthProvider): Promise<{ attemptId: string; url: string }> {
    const driver = this.requireDriver(provider)
    await this.resetAttempt(provider)

    const codeVerifier = randomBytes(32).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
    const state = randomBytes(16).toString('hex')
    const attemptId = randomBytes(12).toString('hex')

    const callbackConfig = this.resolveCallbackConfig(driver)
    const attempt: PendingAttempt = {
      id: attemptId,
      provider,
      state,
      codeVerifier,
      redirectUri: '',
      callbackPath: callbackConfig.callbackPath,
      server: null,
      status: {
        provider,
        state: 'waiting_for_callback',
        authorized: false,
        attemptId,
        requiresRestart: false,
      },
    }

    try {
      const callbackRuntime = await this.startAttemptServer(attempt, callbackConfig)
      attempt.server = callbackRuntime.server
      attempt.redirectUri = callbackRuntime.redirectUri
    } catch (error) {
      await this.resetAttempt(provider)
      throw error
    }

    this.attemptsByProvider.set(provider, attempt)

    try {
      return {
        attemptId,
        url: await driver.buildAuthorizationUrl({
          state,
          redirectUri: attempt.redirectUri,
          codeVerifier,
          codeChallenge,
        }),
      }
    } catch (error) {
      await this.resetAttempt(provider)
      throw error
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

  private parseDefaultCallbackConfig(
    options: ManagedOAuthCoordinatorOptions,
  ): ResolvedCallbackConfig {
    const redirectUri = options.redirectUri ?? DEFAULT_OAUTH_REDIRECT_URI
    const parsed = new URL(redirectUri)

    return {
      protocol: parsed.protocol === 'https:' ? 'https:' : 'http:',
      listenHost: options.listenHost ?? parsed.hostname,
      listenPort:
        options.listenPort ?? Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
      callbackPath: options.callbackPath ?? parsed.pathname,
    }
  }

  private resolveCallbackConfig(driver: ManagedOAuthDriver): ResolvedCallbackConfig {
    const driverConfig = driver.getCallbackConfig?.()
    if (!driverConfig) {
      return this.defaultCallbackConfig
    }

    if (driverConfig.redirectUri) {
      const parsed = new URL(driverConfig.redirectUri)
      return {
        protocol: parsed.protocol === 'https:' ? 'https:' : 'http:',
        listenHost: driverConfig.listenHost ?? parsed.hostname,
        listenPort:
          driverConfig.listenPort ??
          Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
        callbackPath: driverConfig.callbackPath ?? parsed.pathname,
      }
    }

    return {
      protocol: 'http:',
      listenHost: driverConfig.listenHost ?? this.defaultCallbackConfig.listenHost,
      listenPort: driverConfig.listenPort ?? this.defaultCallbackConfig.listenPort,
      callbackPath: driverConfig.callbackPath ?? this.defaultCallbackConfig.callbackPath,
    }
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

  private async startAttemptServer(
    attempt: PendingAttempt,
    callbackConfig: ResolvedCallbackConfig,
  ): Promise<{ server: Server; redirectUri: string }> {
    return await new Promise<{ server: Server; redirectUri: string }>((resolve, reject) => {
      const server = createServer((req, res) => {
        const requestUrl = new URL(
          req.url ?? '/',
          `${callbackConfig.protocol}//${callbackConfig.listenHost}`,
        )

        if (requestUrl.pathname !== attempt.callbackPath) {
          res.statusCode = 404
          res.end('Not found')
          return
        }

        const callbackState = requestUrl.searchParams.get('state')
        if (callbackState !== attempt.state) {
          this.updateAttempt(attempt.provider, {
            provider: attempt.provider,
            state: 'error',
            authorized: false,
            error: 'State validation failed.',
            attemptId: attempt.id,
            requiresRestart: false,
          })
          res.statusCode = 400
          res.end('State mismatch')
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
      server.listen(callbackConfig.listenPort, callbackConfig.listenHost, () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          server.close(() => reject(new Error('Failed to resolve OAuth callback server address.')))
          return
        }

        const { port } = address as AddressInfo
        resolve({
          server,
          redirectUri: `${callbackConfig.protocol}//${callbackConfig.listenHost}:${port}${callbackConfig.callbackPath}`,
        })
      })
    })
  }

  private async exchangeAndStore(attempt: PendingAttempt, code: string) {
    const driver = this.requireDriver(attempt.provider)

    try {
      const session = await driver.exchangeCode({
        code,
        state: attempt.state,
        redirectUri: attempt.redirectUri,
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
    } finally {
      await this.closeAttemptServer(attempt.provider)
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

  private async closeAttemptServer(provider: ManagedOAuthProvider) {
    const attempt = this.attemptsByProvider.get(provider)
    if (!attempt?.server) return

    const server = attempt.server
    attempt.server = null
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  private async resetAttempt(provider: ManagedOAuthProvider) {
    const attempt = this.attemptsByProvider.get(provider)
    if (!attempt) return

    await this.closeAttemptServer(provider)
    this.attemptsByProvider.delete(provider)
  }
}
