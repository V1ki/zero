import { describe, expect, test } from 'bun:test'
import type { Vault } from '@zero-os/secrets'
import { createPendingOAuthAttempt } from '../oauth/attempt'
import type { ManagedOAuthDriver } from '../oauth/driver'
import { readManagedOAuthStatus, refreshManagedOAuthStatus } from '../oauth/status'
import type { ManagedOAuthStatus } from '../oauth/status'

interface FakeSession {
  expiresAt: number
}

function createVault(): Vault {
  return {} as Vault
}

function createDriver(options: {
  session?: FakeSession | null
  onRefreshStatus?: (vault: Vault, options?: { force?: boolean }) => Promise<void> | void
}): ManagedOAuthDriver<FakeSession> {
  let session = options.session ?? null
  const isSessionExpired = (nextSession: FakeSession) => Date.now() >= nextSession.expiresAt

  return {
    provider: 'chatgpt',
    buildAuthorizationUrl() {
      return 'https://example.test/oauth'
    },
    async exchangeCode() {
      return { expiresAt: Date.now() + 60_000 }
    },
    readSession() {
      return session
    },
    writeSession(_vault, nextSession) {
      session = nextSession
    },
    buildConnectedStatus(nextSession, statusOptions): ManagedOAuthStatus {
      const expired = isSessionExpired(nextSession)
      return {
        provider: 'chatgpt',
        state: expired ? 'expired' : 'connected',
        authorized: !expired,
        expiresAt: nextSession.expiresAt,
        attemptId: statusOptions.attemptId,
        requiresRestart: statusOptions.requiresRestart,
      }
    },
    async refreshStatus(vault, refreshOptions) {
      await options.onRefreshStatus?.(vault, refreshOptions)
    },
  }
}

describe('OAuth status helpers', () => {
  test('reads idle status when no stored session exists', () => {
    const status = readManagedOAuthStatus({
      provider: 'chatgpt',
      driver: createDriver({}),
      vault: createVault(),
    })

    expect(status).toEqual({
      provider: 'chatgpt',
      state: 'idle',
      authorized: false,
      requiresRestart: false,
    })
  })

  test('reports a completed attempt from the stored session and marks restart required', () => {
    const { attempt } = createPendingOAuthAttempt('chatgpt', '/callback')
    attempt.status = {
      provider: 'chatgpt',
      state: 'connected',
      authorized: true,
      attemptId: attempt.id,
      requiresRestart: false,
    }

    const status = readManagedOAuthStatus({
      provider: 'chatgpt',
      driver: createDriver({ session: { expiresAt: Date.now() + 60_000 } }),
      vault: createVault(),
      attempt,
    })

    expect(status.state).toBe('connected')
    expect(status.authorized).toBe(true)
    expect(status.attemptId).toBe(attempt.id)
    expect(status.requiresRestart).toBe(true)
  })

  test('strict refresh reports refresh errors instead of stored status', async () => {
    let receivedForce: boolean | undefined

    const status = await refreshManagedOAuthStatus({
      provider: 'chatgpt',
      driver: createDriver({
        session: { expiresAt: Date.now() + 60_000 },
        async onRefreshStatus(_vault, options) {
          receivedForce = options?.force
          throw new Error('refresh token invalid')
        },
      }),
      vault: createVault(),
      options: { strict: true },
    })

    expect(receivedForce).toBe(true)
    expect(status).toEqual({
      provider: 'chatgpt',
      state: 'error',
      authorized: false,
      error: 'refresh token invalid',
      requiresRestart: false,
    })
  })

  test('soft refresh reports an error when the stored session is already expired', async () => {
    let receivedForce: boolean | undefined

    const status = await refreshManagedOAuthStatus({
      provider: 'chatgpt',
      driver: createDriver({
        session: { expiresAt: Date.now() - 1_000 },
        async onRefreshStatus(_vault, options) {
          receivedForce = options?.force
          throw new Error('refresh token invalid')
        },
      }),
      vault: createVault(),
      options: {},
    })

    expect(receivedForce).toBe(false)
    expect(status).toEqual({
      provider: 'chatgpt',
      state: 'error',
      authorized: false,
      error: 'refresh token invalid',
      requiresRestart: false,
    })
  })
})
