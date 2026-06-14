import { afterEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeClaudeOAuthSession } from '@zero-os/model'
import { Vault } from '@zero-os/secrets'
import { getClaudeOAuthSessionRef } from '../providers/claude/config'
import { ClaudeUsageService } from '../providers/claude/usage'

const originalFetch = globalThis.fetch

function createVault() {
  const dir = mkdtempSync(join(tmpdir(), 'zero-claude-usage-'))
  const vault = new Vault(randomBytes(32), join(dir, 'secrets.enc'))
  vault.load()
  return { dir, vault }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('ClaudeUsageService', () => {
  test('returns empty usage for non-subscriber Claude sessions', async () => {
    const { dir, vault } = createVault()
    vault.set(
      getClaudeOAuthSessionRef(),
      serializeClaudeOAuthSession({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
        tokenType: 'Bearer',
        scopes: ['user:profile', 'user:inference'],
        subscriptionType: null,
      }),
    )

    const service = new ClaudeUsageService(vault)

    try {
      await expect(service.fetchUsage()).resolves.toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('fetches usage with a fresh Claude OAuth access token', async () => {
    const { dir, vault } = createVault()
    vault.set(
      getClaudeOAuthSessionRef(),
      serializeClaudeOAuthSession({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
        tokenType: 'Bearer',
        scopes: ['user:profile', 'user:inference'],
        subscriptionType: 'max',
      }),
    )

    let callCount = 0
    globalThis.fetch = (async () => {
      callCount += 1
      return new Response(
        JSON.stringify({
          five_hour: {
            utilization: 42,
            resets_at: '2026-04-01T10:00:00.000Z',
          },
          extra_usage: {
            is_enabled: true,
            monthly_limit: 100,
            used_credits: 17,
            utilization: 17,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }) as unknown as typeof fetch

    const service = new ClaudeUsageService(vault)

    try {
      const usage = await service.fetchUsage()
      expect(callCount).toBe(1)
      expect(usage).toEqual({
        five_hour: {
          utilization: 42,
          resets_at: '2026-04-01T10:00:00.000Z',
        },
        extra_usage: {
          is_enabled: true,
          monthly_limit: 100,
          used_credits: 17,
          utilization: 17,
        },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
