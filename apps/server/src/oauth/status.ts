import type { Vault } from '@zero-os/secrets'
import { toErrorMessage } from '@zero-os/shared'
import { type PendingOAuthAttempt, buildIdleOAuthStatus } from './attempt'
import type { ManagedOAuthDriver, ManagedOAuthProvider } from './driver'

const DEFAULT_POLL_INTERVAL_MS = 500

export type ManagedOAuthState =
  | 'idle'
  | 'waiting_for_callback'
  | 'authorizing'
  | 'connected'
  | 'expired'
  | 'error'

export interface ManagedOAuthSessionStatusDetails {
  expiresAt?: number
  accountId?: string
  accountEmail?: string
  displayName?: string
  subscriptionType?: string | null
  rateLimitTier?: string | null
}

export interface ManagedOAuthStatus extends ManagedOAuthSessionStatusDetails {
  provider: ManagedOAuthProvider
  state: ManagedOAuthState
  authorized: boolean
  error?: string
  attemptId?: string
  requiresRestart: boolean
}

export interface ManagedOAuthStatusRefreshOptions {
  strict?: boolean
  force?: boolean
}

interface ReadManagedOAuthStatusOptions {
  provider: ManagedOAuthProvider
  driver: ManagedOAuthDriver
  vault: Vault
  attempt?: PendingOAuthAttempt
}

interface RefreshManagedOAuthStatusOptions {
  provider: ManagedOAuthProvider
  driver: ManagedOAuthDriver
  vault: Vault
  options: ManagedOAuthStatusRefreshOptions
}

export function readManagedOAuthStatus({
  provider,
  driver,
  vault,
  attempt,
}: ReadManagedOAuthStatusOptions): ManagedOAuthStatus {
  const storedSession = driver.readSession(vault)

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
    return buildIdleOAuthStatus(provider)
  }

  return driver.buildConnectedStatus(storedSession, {
    requiresRestart: false,
  })
}

export async function refreshManagedOAuthStatus({
  provider,
  driver,
  vault,
  options,
}: RefreshManagedOAuthStatusOptions): Promise<ManagedOAuthStatus> {
  const storedSession = driver.readSession(vault)
  if (!storedSession) {
    return buildIdleOAuthStatus(provider)
  }

  if (driver.refreshStatus) {
    try {
      await driver.refreshStatus(vault, {
        force: options.force ?? options.strict === true,
      })
    } catch (error) {
      const storedStatus = readManagedOAuthStatus({
        provider,
        driver,
        vault,
      })
      if (options.strict || storedStatus.state === 'expired') {
        return buildManagedOAuthRefreshErrorStatus(provider, error)
      }
      // Status reads stay best-effort; request paths still handle refresh errors explicitly.
    }
  }

  return readManagedOAuthStatus({
    provider,
    driver,
    vault,
  })
}

export async function waitForManagedOAuthCompletion(options: {
  provider: ManagedOAuthProvider
  getStatus(provider: ManagedOAuthProvider): ManagedOAuthStatus
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<ManagedOAuthStatus> {
  const {
    provider,
    getStatus,
    timeoutMs = 120_000,
    sleep = (ms: number) => Bun.sleep(ms),
  } = options

  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const status = getStatus(provider)
    if (isManagedOAuthCompletionStatus(status)) {
      return status
    }
    await sleep(DEFAULT_POLL_INTERVAL_MS)
  }

  throw new Error(`Timed out waiting for ${provider} OAuth callback.`)
}

export function buildManagedOAuthRefreshErrorStatus(
  provider: ManagedOAuthProvider,
  error: unknown,
): ManagedOAuthStatus {
  return {
    provider,
    state: 'error',
    authorized: false,
    error: toErrorMessage(error),
    requiresRestart: false,
  }
}

function isManagedOAuthCompletionStatus(status: ManagedOAuthStatus): boolean {
  return status.state === 'connected' || status.state === 'expired' || status.state === 'error'
}
