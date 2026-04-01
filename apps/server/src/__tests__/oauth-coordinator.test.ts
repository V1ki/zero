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
  provider: 'chatgpt' | 'claude'
  accessToken: string
  expiresAt: number
}

function createVault() {
  const dir = mkdtempSync(join(tmpdir(), 'zero-oauth-coordinator-'))
  const vault = new Vault(randomBytes(32), join(dir, 'secrets.enc'))
  vault.load()
  return { dir, vault }
}

function createDriver(provider: 'chatgpt' | 'claude'): ManagedOAuthDriver<FakeSession> {
  const key = `${provider}_session`

  return {
    provider,
    getCallbackConfig() {
      if (provider === 'claude') {
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
  }
}

describe('ManagedOAuthCoordinator', () => {
  test('completes a provider attempt via manual callback input and persists provider state', async () => {
    const { dir, vault } = createVault()
    const coordinator = new ManagedOAuthCoordinator(vault, [
      createDriver('chatgpt'),
      createDriver('claude'),
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

      const claudeStart = await coordinator.start('claude')
      const claudeUrl = new URL(claudeStart.url)
      const claudeState = claudeUrl.searchParams.get('state')
      const claudeRedirectUri = claudeUrl.searchParams.get('redirect_uri')
      expect(claudeState).toBeTruthy()
      expect(claudeRedirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/)

      const claudeStatus = await coordinator.completeFromInput(
        'claude',
        `${claudeRedirectUri}?code=claude-code&state=${claudeState}`,
      )
      expect(claudeStatus.provider).toBe('claude')
      expect(claudeStatus.state).toBe('connected')
      expect(vault.get('chatgpt_session')).toContain('chatgpt-code')
      expect(vault.get('claude_session')).toContain('claude-code')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
