import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vault } from '@zero-os/secrets'
import {
  ManagedOAuthCoordinator,
  type ManagedOAuthDriver,
  type ManagedOAuthStatus,
} from '../oauth-coordinator'

interface FakeSession {
  provider: 'chatgpt' | 'anthropic'
  accessToken: string
  expiresAt: number
}

function createVault() {
  const dir = mkdtempSync(join(tmpdir(), 'zero-oauth-coordinator-'))
  const vault = new Vault(randomBytes(32), join(dir, 'secrets.enc'))
  vault.load()
  return { dir, vault }
}

function createDriver(
  provider: 'chatgpt' | 'anthropic',
  options: { onRefreshStatus?: (vault: Vault) => Promise<void> | void } = {},
): ManagedOAuthDriver<FakeSession> {
  const key = `${provider}_session`

  return {
    provider,
    getCallbackConfig() {
      if (provider === 'anthropic') {
        return {
          listenHost: 'localhost',
          listenPort: 0,
          callbackPath: '/callback',
        }
      }

      return {
        redirectUri: 'http://localhost:1455/auth/callback',
      }
    },
    buildAuthorizationUrl({ state, redirectUri }) {
      return `https://example.test/${provider}/oauth?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`
    },
    async exchangeCode({ code }) {
      return {
        provider,
        accessToken: `${provider}:${code}`,
        expiresAt: Date.now() + 60_000,
      }
    },
    readSession(vault) {
      const raw = vault.get(key)
      return raw ? (JSON.parse(raw) as FakeSession) : null
    },
    writeSession(vault, session) {
      vault.set(key, JSON.stringify(session))
    },
    isSessionExpired(session) {
      return Date.now() >= session.expiresAt
    },
    buildConnectedStatus(session, options): ManagedOAuthStatus {
      return {
        provider,
        state: this.isSessionExpired(session) ? 'expired' : 'connected',
        authorized: !this.isSessionExpired(session),
        expiresAt: session.expiresAt,
        requiresRestart: options.requiresRestart,
        attemptId: options.attemptId,
      }
    },
    async refreshStatus(vault) {
      await options.onRefreshStatus?.(vault)
    },
  }
}

describe('ManagedOAuthCoordinator', () => {
  test('completes a provider attempt via manual callback input and persists provider state', async () => {
    const { dir, vault } = createVault()
    const coordinator = new ManagedOAuthCoordinator(vault, [
      createDriver('chatgpt'),
      createDriver('anthropic'),
    ])

    try {
      const chatgptStart = await coordinator.start('chatgpt')
      const chatgptUrl = new URL(chatgptStart.url)
      const chatgptState = chatgptUrl.searchParams.get('state')
      const chatgptRedirectUri = chatgptUrl.searchParams.get('redirect_uri')
      expect(chatgptState).toBeTruthy()
      expect(chatgptRedirectUri).toBe('http://localhost:1455/auth/callback')

      const chatgptStatus = await coordinator.completeFromInput(
        'chatgpt',
        `${chatgptRedirectUri}?code=chatgpt-code&state=${chatgptState}`,
      )
      expect(chatgptStatus.provider).toBe('chatgpt')
      expect(chatgptStatus.state).toBe('connected')
      expect(chatgptStatus.requiresRestart).toBe(true)

      const claudeStart = await coordinator.start('anthropic')
      const claudeUrl = new URL(claudeStart.url)
      const claudeState = claudeUrl.searchParams.get('state')
      const claudeRedirectUri = claudeUrl.searchParams.get('redirect_uri')
      expect(claudeState).toBeTruthy()
      expect(claudeRedirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/)

      const claudeStatus = await coordinator.completeFromInput(
        'anthropic',
        `${claudeRedirectUri}?code=claude-code&state=${claudeState}`,
      )
      expect(claudeStatus.provider).toBe('anthropic')
      expect(claudeStatus.state).toBe('connected')
      expect(vault.get('chatgpt_session')).toContain('chatgpt-code')
      expect(vault.get('anthropic_session')).toContain('claude-code')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('getStatusWithRefresh refreshes stored sessions before reporting status', async () => {
    const { dir, vault } = createVault()
    const coordinator = new ManagedOAuthCoordinator(vault, [
      createDriver('chatgpt', {
        async onRefreshStatus(vault) {
          vault.set(
            'chatgpt_session',
            JSON.stringify({
              provider: 'chatgpt',
              accessToken: 'chatgpt:fresh',
              expiresAt: Date.now() + 5 * 60_000,
            } satisfies FakeSession),
          )
        },
      }),
    ])

    try {
      vault.set(
        'chatgpt_session',
        JSON.stringify({
          provider: 'chatgpt',
          accessToken: 'chatgpt:stale',
          expiresAt: Date.now() - 1_000,
        } satisfies FakeSession),
      )

      const status = await coordinator.getStatusWithRefresh('chatgpt')

      expect(status.state).toBe('connected')
      expect(status.authorized).toBe(true)
      expect(vault.get('chatgpt_session')).toContain('chatgpt:fresh')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('strict getStatusWithRefresh reports refresh failures instead of stored status', async () => {
    const { dir, vault } = createVault()
    const coordinator = new ManagedOAuthCoordinator(vault, [
      createDriver('chatgpt', {
        async onRefreshStatus() {
          throw new Error('refresh token invalid')
        },
      }),
    ])

    try {
      vault.set(
        'chatgpt_session',
        JSON.stringify({
          provider: 'chatgpt',
          accessToken: 'chatgpt:stored',
          expiresAt: Date.now() + 5 * 60_000,
        } satisfies FakeSession),
      )

      const softStatus = await coordinator.getStatusWithRefresh('chatgpt')
      expect(softStatus.state).toBe('connected')

      const hardStatus = await coordinator.getStatusWithRefresh('chatgpt', { strict: true })
      expect(hardStatus.state).toBe('error')
      expect(hardStatus.authorized).toBe(false)
      expect(hardStatus.error).toBe('refresh token invalid')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
