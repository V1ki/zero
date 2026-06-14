import { describe, expect, test } from 'bun:test'
import type { Vault } from '@zero-os/secrets'
import { ManagedOAuthAttempts } from '../oauth/attempt'
import type { ManagedOAuthDriver } from '../oauth/driver'
import type { ManagedOAuthStatus } from '../oauth/status'

interface FakeSession {
  code: string
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

function createDriver(
  options: { onExchange?: (params: { code: string; state: string }) => void } = {},
): ManagedOAuthDriver<FakeSession> {
  return {
    provider: 'chatgpt',
    buildAuthorizationUrl({ state, redirectUri }) {
      return `https://example.test/oauth?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`
    },
    async exchangeCode({ code, state }) {
      options.onExchange?.({ code, state })
      return { code }
    },
    readSession() {
      return null
    },
    writeSession(vault, session) {
      vault.set('chatgpt_session', JSON.stringify(session))
    },
    buildConnectedStatus(session, options): ManagedOAuthStatus {
      return {
        provider: 'chatgpt',
        state: 'connected',
        authorized: true,
        attemptId: options.attemptId,
        requiresRestart: options.requiresRestart,
        displayName: session.code,
      }
    },
  }
}

function createAttempts(driver = createDriver(), vault = createVault()) {
  return {
    vault,
    attempts: new ManagedOAuthAttempts(vault, () => driver),
  }
}

const callbackConfig = {
  protocol: 'http:',
  listenHost: 'localhost',
  listenPort: 0,
  callbackPath: '/auth/callback',
} as const

describe('ManagedOAuthAttempts', () => {
  test('starts a callback server and stores the pending attempt', async () => {
    const { attempts } = createAttempts()

    try {
      const { attemptId, url } = await attempts.start('chatgpt', callbackConfig)
      const attempt = attempts.get('chatgpt')
      if (!attempt) throw new Error('Attempt was not stored.')

      expect(attempt.id).toBe(attemptId)
      expect(attempt.redirectUri).toMatch(/^http:\/\/localhost:\d+\/auth\/callback$/)
      expect(attempt.server).not.toBeNull()
      expect(new URL(url).searchParams.get('state')).toBe(attempt.state)
    } finally {
      await attempts.reset('chatgpt')
    }
  })

  test('completes a pasted callback URL and persists the connected session', async () => {
    const vault = createVault()
    let exchangedCode: string | undefined
    let exchangedState: string | undefined
    const { attempts } = createAttempts(
      createDriver({
        onExchange({ code, state }) {
          exchangedCode = code
          exchangedState = state
        },
      }),
      vault,
    )

    try {
      await attempts.start('chatgpt', callbackConfig)
      const attempt = attempts.get('chatgpt')
      if (!attempt) throw new Error('Attempt was not stored.')

      await attempts.completeFromInput(
        'chatgpt',
        `${attempt.redirectUri}?code=manual-code&state=${attempt.state}`,
      )

      expect(exchangedCode).toBe('manual-code')
      expect(exchangedState).toBe(attempt.state)
      expect(vault.get('chatgpt_session')).toContain('manual-code')
      expect(attempt.status.state).toBe('connected')
      expect(attempt.server).toBeNull()
    } finally {
      await attempts.reset('chatgpt')
    }
  })

  test('rejects pasted input without an authorization code', async () => {
    const { attempts } = createAttempts()

    try {
      await attempts.start('chatgpt', callbackConfig)
      const attempt = attempts.get('chatgpt')
      if (!attempt) throw new Error('Attempt was not stored.')

      await expect(
        attempts.completeFromInput('chatgpt', `${attempt.redirectUri}?state=${attempt.state}`),
      ).rejects.toThrow('Authorization code not found in input.')
    } finally {
      await attempts.reset('chatgpt')
    }
  })

  test('rejects pasted input with a mismatched state', async () => {
    const { attempts } = createAttempts()

    try {
      await attempts.start('chatgpt', callbackConfig)
      const attempt = attempts.get('chatgpt')
      if (!attempt) throw new Error('Attempt was not stored.')

      await expect(
        attempts.completeFromInput(
          'chatgpt',
          `${attempt.redirectUri}?code=manual-code&state=wrong-state`,
        ),
      ).rejects.toThrow('State validation failed.')
    } finally {
      await attempts.reset('chatgpt')
    }
  })

  test('reset closes the callback server and removes the attempt', async () => {
    const { attempts } = createAttempts()

    await attempts.start('chatgpt', callbackConfig)
    const attempt = attempts.get('chatgpt')
    if (!attempt) throw new Error('Attempt was not stored.')

    await attempts.reset('chatgpt')

    expect(attempt.server).toBeNull()
    expect(attempts.get('chatgpt')).toBeUndefined()
  })
})
