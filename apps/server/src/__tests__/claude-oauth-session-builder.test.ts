import { describe, expect, test } from 'bun:test'
import { CLAUDE_SCOPE, buildClaudeSession } from '../providers/claude/oauth'

describe('buildClaudeSession', () => {
  test('builds a session from token response and profile details', () => {
    const session = buildClaudeSession(
      {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 7200,
        token_type: 'Bearer',
        scope: 'user:profile user:inference',
        account: {
          uuid: 'acct-token',
          email_address: 'token@example.com',
        },
        organization: {
          uuid: 'org-token',
        },
      },
      {
        account: {
          uuid: 'acct-profile',
          email_address: 'profile@example.com',
          display_name: 'Claude User',
        },
        organization: {
          uuid: 'org-profile',
          organization_type: 'claude_max',
          rate_limit_tier: 'tier-max',
        },
      },
    )

    expect(session.refreshToken).toBe('refresh-token')
    expect(session.scopes).toEqual(['user:profile', 'user:inference'])
    expect(session.subscriptionType).toBe('max')
    expect(session.rateLimitTier).toBe('tier-max')
    expect(session.account).toEqual({
      accountUuid: 'acct-profile',
      emailAddress: 'profile@example.com',
      organizationUuid: 'org-profile',
      displayName: 'Claude User',
    })
    expect(session.expiresAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000)
  })

  test('uses fallback session values when refresh response omits optional details', () => {
    const fallbackSession = {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() + 30_000,
      tokenType: 'Bearer',
      scopes: ['user:profile'],
      subscriptionType: 'pro',
      rateLimitTier: 'tier-pro',
      account: {
        accountUuid: 'acct-old',
        emailAddress: 'old@example.com',
        displayName: 'Old User',
      },
    }

    const session = buildClaudeSession(
      {
        access_token: 'access-token',
        expires_in: 7200,
      },
      null,
      fallbackSession.refreshToken,
      fallbackSession,
    )

    expect(session.refreshToken).toBe('old-refresh')
    expect(session.scopes).toEqual(['user:profile'])
    expect(session.subscriptionType).toBe('pro')
    expect(session.rateLimitTier).toBe('tier-pro')
    expect(session.account?.displayName).toBe('Old User')
  })

  test('rejects token responses without required credentials or expiry', () => {
    expect(() => buildClaudeSession({ refresh_token: 'refresh-token' }, null)).toThrow(
      /missing access_token/,
    )
    expect(() => buildClaudeSession({ access_token: 'access-token' }, null)).toThrow(
      /missing expires_in/,
    )
    expect(() =>
      buildClaudeSession({ access_token: 'access-token', expires_in: 7200 }, null),
    ).toThrow(/missing refresh_token/)
  })

  test('uses default Claude scopes when neither response nor fallback provides scopes', () => {
    const session = buildClaudeSession(
      {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 7200,
      },
      null,
    )

    expect(session.scopes).toEqual(CLAUDE_SCOPE)
  })
})
