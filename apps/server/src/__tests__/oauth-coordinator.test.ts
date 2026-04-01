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
    const coordinator = new ManagedOAuthCoordinator(
      vault,
      [createDriver('chatgpt'), createDriver('claude')],
      {
        redirectUri: 'http://localhost:0/auth/callback',
        listenPort: 0,
      },
    )

    try {
      const chatgptStart = await coordinator.start('chatgpt')
      const chatgptState = new URL(chatgptStart.url).searchParams.get('state')
      expect(chatgptState).toBeTruthy()

      const chatgptStatus = await coordinator.completeFromInput(
        'chatgpt',
        `http://localhost:0/auth/callback?code=chatgpt-code&state=${chatgptState}`,
      )
      expect(chatgptStatus.provider).toBe('chatgpt')
      expect(chatgptStatus.state).toBe('connected')
      expect(chatgptStatus.requiresRestart).toBe(true)

      const claudeStart = await coordinator.start('claude')
      const claudeState = new URL(claudeStart.url).searchParams.get('state')
      expect(claudeState).toBeTruthy()

      const claudeStatus = await coordinator.completeFromInput(
        'claude',
        `http://localhost:0/auth/callback?code=claude-code&state=${claudeState}`,
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
