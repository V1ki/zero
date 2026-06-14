import { createHash, randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import type { Vault } from '@zero-os/secrets'
import { toErrorMessage } from '@zero-os/shared'
import {
  type ResolvedOAuthCallbackConfig,
  parseOAuthAuthorizationInput,
  resolveOAuthCallbackConfig,
  startManagedOAuthCallbackServer,
} from './callback'
import type { ManagedOAuthDriver, ManagedOAuthProvider } from './driver'
import type { ManagedOAuthStatus } from './status'

export interface PendingOAuthAttempt {
  id: string
  provider: ManagedOAuthProvider
  state: string
  codeVerifier: string
  redirectUri: string
  callbackPath: string
  server: Server | null
  status: ManagedOAuthStatus
}

export interface CreatedOAuthAttempt {
  attempt: PendingOAuthAttempt
  codeChallenge: string
}

export function createPendingOAuthAttempt(
  provider: ManagedOAuthProvider,
  callbackPath: string,
): CreatedOAuthAttempt {
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const state = randomBytes(16).toString('hex')
  const attemptId = randomBytes(12).toString('hex')

  return {
    attempt: {
      id: attemptId,
      provider,
      state,
      codeVerifier,
      redirectUri: '',
      callbackPath,
      server: null,
      status: {
        provider,
        state: 'waiting_for_callback',
        authorized: false,
        attemptId,
        requiresRestart: false,
      },
    },
    codeChallenge,
  }
}

export function buildIdleOAuthStatus(provider: ManagedOAuthProvider): ManagedOAuthStatus {
  return {
    provider,
    state: 'idle',
    authorized: false,
    requiresRestart: false,
  }
}

export interface OAuthAttemptStatusRef {
  id: string
  provider: ManagedOAuthProvider
}

export function buildAuthorizingOAuthAttemptStatus(
  attempt: OAuthAttemptStatusRef,
): ManagedOAuthStatus {
  return {
    provider: attempt.provider,
    state: 'authorizing',
    authorized: false,
    attemptId: attempt.id,
    requiresRestart: false,
  }
}

export function buildOAuthAttemptErrorStatus(
  attempt: OAuthAttemptStatusRef,
  error: string,
): ManagedOAuthStatus {
  return {
    provider: attempt.provider,
    state: 'error',
    authorized: false,
    error,
    attemptId: attempt.id,
    requiresRestart: false,
  }
}

type DriverResolver = (provider: ManagedOAuthProvider) => ManagedOAuthDriver
type OAuthAttemptStatusUpdater = (
  provider: PendingOAuthAttempt['provider'],
  status: ManagedOAuthStatus,
) => void

export class ManagedOAuthAttempts {
  private readonly attemptsByProvider = new Map<ManagedOAuthProvider, PendingOAuthAttempt>()

  constructor(
    private readonly vault: Vault,
    private readonly resolveDriver: DriverResolver,
  ) {}

  get(provider: ManagedOAuthProvider): PendingOAuthAttempt | undefined {
    return this.attemptsByProvider.get(provider)
  }

  async start(
    provider: ManagedOAuthProvider,
    defaultCallbackConfig: ResolvedOAuthCallbackConfig,
  ): Promise<{ attemptId: string; url: string }> {
    const driver = this.resolveDriver(provider)
    const callbackConfig = resolveOAuthCallbackConfig(
      defaultCallbackConfig,
      driver.getCallbackConfig?.(),
    )
    const { attempt, codeChallenge } = await this.begin(provider, callbackConfig)

    try {
      return {
        attemptId: attempt.id,
        url: await driver.buildAuthorizationUrl({
          state: attempt.state,
          redirectUri: attempt.redirectUri,
          codeVerifier: attempt.codeVerifier,
          codeChallenge,
        }),
      }
    } catch (error) {
      await this.reset(provider)
      throw error
    }
  }

  async completeFromInput(provider: ManagedOAuthProvider, rawInput: string): Promise<void> {
    const attempt = this.attemptsByProvider.get(provider)
    if (!attempt) {
      throw new Error(`No active ${provider} OAuth attempt.`)
    }

    const code = resolveOAuthAttemptInputCode(attempt, rawInput)
    this.update(provider, buildAuthorizingOAuthAttemptStatus(attempt))
    await this.exchangeAndStore(attempt, code)
  }

  update(provider: ManagedOAuthProvider, status: ManagedOAuthStatus): void {
    const attempt = this.attemptsByProvider.get(provider)
    if (!attempt) return

    attempt.status = status
  }

  async reset(provider: ManagedOAuthProvider): Promise<void> {
    await this.closeServer(provider)
    this.attemptsByProvider.delete(provider)
  }

  private async begin(
    provider: ManagedOAuthProvider,
    callbackConfig: ResolvedOAuthCallbackConfig,
  ): Promise<CreatedOAuthAttempt> {
    await this.reset(provider)

    const createdAttempt = createPendingOAuthAttempt(provider, callbackConfig.callbackPath)
    const { attempt } = createdAttempt

    try {
      const callbackRuntime = await startOAuthAttemptServer({
        attempt,
        callbackConfig,
        resolveDriver: this.resolveDriver,
        update: (statusProvider, status) => this.update(statusProvider, status),
        onCode: (callbackAttempt, code) => this.exchangeAndStore(callbackAttempt, code),
      })
      attempt.server = callbackRuntime.server
      attempt.redirectUri = callbackRuntime.redirectUri
      this.attemptsByProvider.set(attempt.provider, attempt)
      return createdAttempt
    } catch (error) {
      await this.reset(provider)
      throw error
    }
  }

  private async closeServer(provider: ManagedOAuthProvider): Promise<void> {
    const attempt = this.attemptsByProvider.get(provider)
    if (!attempt) return

    await closeOAuthAttemptServer(attempt)
  }

  private async exchangeAndStore(attempt: PendingOAuthAttempt, code: string): Promise<void> {
    const driver = this.resolveDriver(attempt.provider)
    await exchangeAndStoreOAuthAttempt({
      attempt,
      code,
      driver,
      vault: this.vault,
      update: (provider, status) => this.update(provider, status),
      closeAttemptServer: (provider) => this.closeServer(provider),
    })
  }
}

function resolveOAuthAttemptInputCode(attempt: PendingOAuthAttempt, rawInput: string): string {
  const parsed = parseOAuthAuthorizationInput(rawInput)
  if (!parsed.code) {
    throw new Error('Authorization code not found in input.')
  }
  if (parsed.state && parsed.state !== attempt.state) {
    throw new Error('State validation failed.')
  }

  return parsed.code
}

async function exchangeAndStoreOAuthAttempt(options: {
  attempt: PendingOAuthAttempt
  code: string
  driver: ManagedOAuthDriver
  vault: Vault
  update: OAuthAttemptStatusUpdater
  closeAttemptServer(provider: PendingOAuthAttempt['provider']): Promise<void>
}): Promise<void> {
  const { attempt, code, driver, vault, update, closeAttemptServer } = options

  try {
    const session = await driver.exchangeCode({
      code,
      state: attempt.state,
      redirectUri: attempt.redirectUri,
      codeVerifier: attempt.codeVerifier,
    })

    driver.writeSession(vault, session)
    update(
      attempt.provider,
      driver.buildConnectedStatus(session, {
        attemptId: attempt.id,
        requiresRestart: true,
      }),
    )
  } catch (error) {
    update(attempt.provider, {
      provider: attempt.provider,
      state: 'error',
      authorized: false,
      error: toErrorMessage(error),
      attemptId: attempt.id,
      requiresRestart: false,
    })
  } finally {
    await closeAttemptServer(attempt.provider)
  }
}

type OAuthAttemptDriverResolver = (provider: ManagedOAuthProvider) => ManagedOAuthDriver
type OAuthAttemptCodeHandler = (attempt: PendingOAuthAttempt, code: string) => Promise<void>

async function startOAuthAttemptServer(options: {
  attempt: PendingOAuthAttempt
  callbackConfig: ResolvedOAuthCallbackConfig
  resolveDriver: OAuthAttemptDriverResolver
  update: OAuthAttemptStatusUpdater
  onCode: OAuthAttemptCodeHandler
}): Promise<{ server: PendingOAuthAttempt['server']; redirectUri: string }> {
  const { attempt, callbackConfig, resolveDriver, update, onCode } = options

  return await startManagedOAuthCallbackServer({
    attempt,
    callbackConfig,
    getSuccessHtml: () => {
      const driver = resolveDriver(attempt.provider)
      return (
        driver.getCallbackSuccessHtml?.() ??
        `<html><body><h2>ZeRo OS</h2><p>${attempt.provider} authorization received. You can return to ZeRo OS.</p></body></html>`
      )
    },
    onStatus: (status) => update(attempt.provider, status),
    onCode: (code) => onCode(attempt, code),
  })
}

async function closeOAuthAttemptServer(attempt: PendingOAuthAttempt): Promise<void> {
  if (!attempt.server) return

  const server = attempt.server
  attempt.server = null
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}
