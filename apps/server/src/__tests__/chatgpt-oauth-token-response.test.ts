import { describe, expect, test } from 'bun:test'
import type { ChatGptOAuthSession } from '@zero-os/model'
import { buildChatGptSession } from '../providers/chatgpt/oauth'

function createAccessToken(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${header}.${payload}.`
}

function createChatGptAccessToken(options: { accountId?: string; exp?: number } = {}) {
  return createAccessToken({
    exp: options.exp ?? Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': {
      chatgpt_account_id: options.accountId ?? 'acct_test',
    },
  })
}

describe('buildChatGptSession', () => {
  test('builds a session from a complete token response', () => {
    const before = Date.now()
    const session = buildChatGptSession({
      access_token: createChatGptAccessToken({ accountId: 'acct_new' }),
      refresh_token: 'refresh-new',
      expires_in: 120,
      token_type: 'bearer',
    })

    expect(session.accessToken).toBeTruthy()
    expect(session.refreshToken).toBe('refresh-new')
    expect(session.accountId).toBe('acct_new')
    expect(session.tokenType).toBe('Bearer')
    expect(session.expiresAt).toBeGreaterThanOrEqual(before + 120_000)
  })

  test('uses refresh and token type fallbacks for refresh responses', () => {
    const fallbackSession: ChatGptOAuthSession = {
      accessToken: 'old-token',
      refreshToken: 'refresh-existing',
      expiresAt: 1,
      tokenType: 'Bearer',
      accountId: 'acct_old',
    }

    const session = buildChatGptSession(
      {
        access_token: createChatGptAccessToken({ accountId: 'acct_refreshed', exp: 2_000_000_000 }),
      },
      fallbackSession,
    )

    expect(session.refreshToken).toBe('refresh-existing')
    expect(session.tokenType).toBe('Bearer')
    expect(session.accountId).toBe('acct_refreshed')
    expect(session.expiresAt).toBe(2_000_000_000_000)
  })

  test('rejects token responses without usable account or expiry claims', () => {
    expect(() =>
      buildChatGptSession({
        access_token: createAccessToken({ exp: 2_000_000_000 }),
        refresh_token: 'refresh',
        token_type: 'Bearer',
      }),
    ).toThrow('Failed to extract chatgpt_account_id from token.')

    expect(() =>
      buildChatGptSession({
        access_token: createAccessToken({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct_test',
          },
        }),
        refresh_token: 'refresh',
        token_type: 'Bearer',
      }),
    ).toThrow('Failed to determine token expiry from token response.')
  })
})
