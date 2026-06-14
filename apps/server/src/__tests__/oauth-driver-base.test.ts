import { describe, expect, test } from 'bun:test'
import type { Vault } from '@zero-os/secrets'
import { ManagedOAuthDriverBase } from '../oauth/provider/driver-base'
import type { ManagedOAuthStatus } from '../oauth/status'

interface TestSession {
  value: string
  expired?: boolean
}

function createVault(): Vault {
  const values = new Map<string, string>()
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: string) => {
      values.set(key, value)
    },
  } as unknown as Vault
}

class TestOAuthDriver extends ManagedOAuthDriverBase<TestSession> {
  constructor(private readonly calls: string[] = []) {
    super({
      providerName: 'test',
      callbackSuccessLabel: 'Test',
      session: {
        tokenRef: 'provider_session',
        read: (vault, tokenRef) => {
          const raw = vault.get(tokenRef)
          return raw ? (JSON.parse(raw) as TestSession) : null
        },
        serialize: JSON.stringify,
        isExpiring: (session) => session.expired === true,
        createSessionRefresher: () => ({
          ensureFreshSession: async () => {
            this.calls.push('ensureFreshSession')
          },
          refreshSession: async (reason) => {
            this.calls.push(`refreshSession:${reason}`)
          },
        }),
      },
    })
  }

  buildAuthorizationUrl(): string {
    return 'https://example.test/oauth'
  }

  async exchangeCode(): Promise<TestSession> {
    return { value: 'exchanged' }
  }

  buildConnectedStatus(
    session: TestSession,
    options: { attemptId?: string; requiresRestart: boolean },
  ): ManagedOAuthStatus {
    return this.buildConnectedOAuthStatus(session, options)
  }
}

describe('ManagedOAuthDriverBase', () => {
  test('reads and writes provider sessions through the token ref', () => {
    const vault = createVault()
    const driver = new TestOAuthDriver()

    driver.writeSession(vault, { value: 'saved' })

    expect(driver.readSession(vault)).toEqual({ value: 'saved' })
  })

  test('refreshStatus delegates normal and forced refresh paths', async () => {
    const calls: string[] = []
    const driver = new TestOAuthDriver(calls)

    await driver.refreshStatus(createVault())
    await driver.refreshStatus(createVault(), { force: true })

    expect(calls).toEqual(['ensureFreshSession', 'refreshSession:unauthorized'])
  })

  test('builds connected and expired status through the driver session policy', () => {
    const driver = new TestOAuthDriver()

    expect(
      driver.buildConnectedStatus(
        { value: 'active' },
        { attemptId: 'attempt-1', requiresRestart: true },
      ),
    ).toEqual({
      provider: 'test',
      state: 'connected',
      authorized: true,
      attemptId: 'attempt-1',
      requiresRestart: true,
    })

    expect(
      driver.buildConnectedStatus({ value: 'old', expired: true }, { requiresRestart: false }),
    ).toEqual({
      provider: 'test',
      state: 'expired',
      authorized: false,
      attemptId: undefined,
      requiresRestart: false,
    })
  })
})
