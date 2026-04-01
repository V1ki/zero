import { describe, expect, test } from 'bun:test'
import {
  parseClaudeOAuthSession,
  resolveClaudeOAuthAccessToken,
  serializeClaudeOAuthSession,
} from '../auth/claude'

describe('Claude OAuth auth helpers', () => {
  test('serializes and parses Claude OAuth session JSON', () => {
    const raw = serializeClaudeOAuthSession({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 1234567890,
      tokenType: 'Bearer',
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier-max',
      account: {
        accountUuid: 'acct_123',
        emailAddress: 'user@example.com',
        organizationUuid: 'org_123',
        displayName: 'Claude User',
      },
    })

    expect(parseClaudeOAuthSession(raw)).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 1234567890,
      tokenType: 'Bearer',
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'tier-max',
      account: {
        accountUuid: 'acct_123',
        emailAddress: 'user@example.com',
        organizationUuid: 'org_123',
        displayName: 'Claude User',
      },
    })
  })

  test('resolves the access token from stored Claude session JSON', () => {
    const raw = serializeClaudeOAuthSession({
      accessToken: 'resolved-access-token',
      refreshToken: 'refresh-token',
      expiresAt: 1234567890,
      tokenType: 'Bearer',
      scopes: ['user:profile'],
    })

    expect(resolveClaudeOAuthAccessToken(raw)).toBe('resolved-access-token')
    expect(resolveClaudeOAuthAccessToken('raw-token-fallback')).toBe('raw-token-fallback')
  })
})
