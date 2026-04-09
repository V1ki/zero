import { afterEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseClaudeOAuthSession, serializeClaudeOAuthSession } from '@zero-os/model'
import { Vault } from '@zero-os/secrets'
import { ClaudeTokenManager } from '../claude-oauth'
import { getClaudeOAuthSessionRef } from '../claude-provider'

const originalFetch = globalThis.fetch

function createVault() {
  const dir = mkdtempSync(join(tmpdir(), 'zero-claude-token-manager-'))
  const vault = new Vault(randomBytes(32), join(dir, 'secrets.enc'))
  vault.load()
  return { dir, vault }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('ClaudeTokenManager', () => {
  test('returns the current session without refreshing when it is still valid', async () => {
    const { dir, vault } = createVault()
    const session = {
      accessToken: 'access-valid',
      refreshToken: 'refresh-valid',
      expiresAt: Date.now() + 60 * 60 * 1000,
      tokenType: 'Bearer',
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier-max',
      account: {
        accountUuid: 'acct_valid',
        emailAddress: 'valid@example.com',
      },
    }
    vault.set(getClaudeOAuthSessionRef(), serializeClaudeOAuthSession(session))

    const manager = new ClaudeTokenManager(vault)

    try {
      const resolved = await manager.ensureFreshSession()
      expect(resolved).toEqual(session)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refreshes expiring sessions and persists the updated Claude session JSON', async () => {
    const { dir, vault } = createVault()
    vault.set(
      getClaudeOAuthSessionRef(),
      serializeClaudeOAuthSession({
        accessToken: 'access-old',
        refreshToken: 'refresh-old',
        expiresAt: Date.now() + 5 * 60 * 1000,
        tokenType: 'Bearer',
        scopes: ['user:profile', 'user:inference'],
        subscriptionType: 'pro',
        rateLimitTier: 'tier-pro',
        account: {
          accountUuid: 'acct_old',
          emailAddress: 'old@example.com',
        },
      }),
    )

    let fetchCalls = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetchCalls += 1
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('/v1/oauth/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'access-new',
            refresh_token: 'refresh-new',
            expires_in: 7200,
            token_type: 'Bearer',
            scope: 'user:profile user:inference',
            account: {
              uuid: 'acct_new',
              email_address: 'new@example.com',
            },
            organization: {
              uuid: 'org_new',
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }

      return new Response(
        JSON.stringify({
          account: {
            uuid: 'acct_new',
            email_address: 'new@example.com',
            display_name: 'Claude User',
          },
          organization: {
            uuid: 'org_new',
            organization_type: 'claude_max',
            rate_limit_tier: 'tier-max',
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }) as unknown as typeof fetch

    const manager = new ClaudeTokenManager(vault)

    try {
      const refreshed = await manager.ensureFreshSession()
      expect(fetchCalls).toBe(2)
      expect(refreshed.accessToken).toBe('access-new')
      expect(refreshed.refreshToken).toBe('refresh-new')
      expect(refreshed.subscriptionType).toBe('max')
      expect(refreshed.account?.displayName).toBe('Claude User')
      expect(refreshed.expiresAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000)

      const stored = parseClaudeOAuthSession(vault.get(getClaudeOAuthSessionRef()))
      expect(stored).toEqual(refreshed)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('surfaces a re-authentication error when the refresh grant is rejected', async () => {
    const { dir, vault } = createVault()
    vault.set(
      getClaudeOAuthSessionRef(),
      serializeClaudeOAuthSession({
        accessToken: 'access-old',
        refreshToken: 'refresh-old',
        expiresAt: Date.now() + 5 * 60 * 1000,
        tokenType: 'Bearer',
        scopes: ['user:profile', 'user:inference'],
      }),
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'refresh token expired',
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        },
      )) as unknown as typeof fetch

    const manager = new ClaudeTokenManager(vault)

    try {
      await expect(manager.refreshSession('unauthorized')).rejects.toThrow(
        /Claude OAuth session can no longer be refreshed.*status=401.*code=invalid_grant/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
