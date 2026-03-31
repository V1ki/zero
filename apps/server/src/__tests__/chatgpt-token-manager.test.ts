import { afterEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseChatGptOAuthSession, serializeChatGptOAuthSession } from '@zero-os/model'
import { Vault } from '@zero-os/secrets'
import { ChatGptTokenManager } from '../chatgpt-oauth'
import { getChatgptOAuthTokenRef } from '../chatgpt-provider'

const originalFetch = globalThis.fetch

function makeJwt(payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

function makeAccessToken(accountId: string, expSeconds: number) {
  return makeJwt({
    exp: expSeconds,
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
    },
  })
}

function createVault() {
  const dir = mkdtempSync(join(tmpdir(), 'zero-chatgpt-token-manager-'))
  const vault = new Vault(randomBytes(32), join(dir, 'secrets.enc'))
  vault.load()
  return { dir, vault }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('ChatGptTokenManager', () => {
  test('returns the current session without refreshing when it is still valid', async () => {
    const { dir, vault } = createVault()
    const session = {
      accessToken: makeAccessToken('acct_valid', Math.floor(Date.now() / 1000) + 60 * 60),
      refreshToken: 'refresh-valid',
      expiresAt: Date.now() + 60 * 60 * 1000,
      tokenType: 'Bearer',
      accountId: 'acct_valid',
    }
    vault.set(getChatgptOAuthTokenRef(), serializeChatGptOAuthSession(session))

    const manager = new ChatGptTokenManager(vault)

    try {
      const resolved = await manager.ensureFreshSession()
      expect(resolved).toEqual(session)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refreshes expiring sessions and persists the updated token set', async () => {
    const { dir, vault } = createVault()
    const nowSeconds = Math.floor(Date.now() / 1000)
    vault.set(
      getChatgptOAuthTokenRef(),
      serializeChatGptOAuthSession({
        accessToken: makeAccessToken('acct_old', nowSeconds + 5 * 60),
        refreshToken: 'refresh-old',
        expiresAt: Date.now() + 5 * 60 * 1000,
        tokenType: 'Bearer',
        accountId: 'acct_old',
      }),
    )

    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      return new Response(
        JSON.stringify({
          access_token: makeAccessToken('acct_new', nowSeconds + 2 * 60 * 60),
          refresh_token: 'refresh-new',
          token_type: 'Bearer',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }) as unknown as typeof fetch

    const manager = new ChatGptTokenManager(vault)

    try {
      const refreshed = await manager.ensureFreshSession()
      expect(fetchCalls).toBe(1)
      expect(refreshed.refreshToken).toBe('refresh-new')
      expect(refreshed.accountId).toBe('acct_new')
      expect(refreshed.expiresAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000)

      const stored = parseChatGptOAuthSession(vault.get(getChatgptOAuthTokenRef()))
      expect(stored).toEqual(refreshed)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('surfaces a re-authentication error when the refresh token was invalidated', async () => {
    const { dir, vault } = createVault()
    vault.set(
      getChatgptOAuthTokenRef(),
      serializeChatGptOAuthSession({
        accessToken: makeAccessToken('acct_old', Math.floor(Date.now() / 1000) + 5 * 60),
        refreshToken: 'refresh-old',
        expiresAt: Date.now() + 5 * 60 * 1000,
        tokenType: 'Bearer',
        accountId: 'acct_old',
      }),
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: { code: 'refresh_token_invalidated', message: 'revoked' },
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        },
      )) as unknown as typeof fetch

    const manager = new ChatGptTokenManager(vault)

    try {
      await expect(manager.refreshSession('unauthorized')).rejects.toThrow(
        'ChatGPT OAuth session can no longer be refreshed',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
