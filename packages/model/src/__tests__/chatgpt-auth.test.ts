import { describe, expect, test } from 'bun:test'
import {
  decodeChatGptAccountId,
  decodeChatGptTokenExpiry,
  getChatGptAuthorizationScheme,
  parseChatGptOAuthSession,
  serializeChatGptOAuthSession,
} from '../auth/chatgpt'
import type { ChatGptOAuthSession } from '../auth/chatgpt'

function makeJwt(payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

describe('ChatGPT OAuth helpers', () => {
  test('serialize and parse roundtrip', () => {
    const session: ChatGptOAuthSession = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60_000,
      tokenType: 'Bearer',
      accountId: 'acct_123',
    }

    const parsed = parseChatGptOAuthSession(serializeChatGptOAuthSession(session))
    expect(parsed).toEqual(session)
  })

  test('parse returns null for invalid payload', () => {
    expect(parseChatGptOAuthSession('not-json')).toBeNull()
    expect(parseChatGptOAuthSession(JSON.stringify({ accessToken: 'x' }))).toBeNull()
  })

  test('decodeChatGptAccountId reads nested JWT claim', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_nested_456',
      },
    })

    expect(decodeChatGptAccountId(token)).toBe('acct_nested_456')
  })

  test('decodeChatGptAccountId returns null when claim missing', () => {
    const token = makeJwt({ sub: 'user_1' })
    expect(decodeChatGptAccountId(token)).toBeNull()
  })

  test('decodeChatGptTokenExpiry reads exp claim in milliseconds', () => {
    const token = makeJwt({
      exp: 1_710_000_000,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_nested_456',
      },
    })

    expect(decodeChatGptTokenExpiry(token)).toBe(1_710_000_000_000)
  })

  test('decodeChatGptTokenExpiry returns null when exp claim missing', () => {
    const token = makeJwt({ sub: 'user_1' })
    expect(decodeChatGptTokenExpiry(token)).toBeNull()
  })

  test('getChatGptAuthorizationScheme normalizes bearer casing', () => {
    expect(getChatGptAuthorizationScheme('bearer')).toBe('Bearer')
    expect(getChatGptAuthorizationScheme('Bearer')).toBe('Bearer')
    expect(getChatGptAuthorizationScheme('DPoP')).toBe('DPoP')
  })
})
