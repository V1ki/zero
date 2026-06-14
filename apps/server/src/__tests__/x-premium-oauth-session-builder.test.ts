import { describe, expect, test } from 'bun:test'
import { buildXPremiumSession } from '../providers/x-premium'

function makeJwt(payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

describe('buildXPremiumSession', () => {
  test('builds a session from a token response and id token account claims', () => {
    const expiresIn = 3600
    const idToken = makeJwt({
      sub: 'x-user-1',
      email: 'x@example.com',
      name: 'X User',
      preferred_username: 'xuser',
    })

    const session = buildXPremiumSession(
      {
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + expiresIn }),
        refresh_token: 'refresh-token',
        expires_in: expiresIn,
        token_type: 'bearer',
        scope: 'openid profile email',
        id_token: idToken,
      },
      'https://auth.x.ai/oauth/token',
    )

    expect(session.refreshToken).toBe('refresh-token')
    expect(session.tokenType).toBe('Bearer')
    expect(session.scopes).toEqual(['openid', 'profile', 'email'])
    expect(session.idToken).toBe(idToken)
    expect(session.account?.emailAddress).toBe('x@example.com')
    expect(session.expiresAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000)
  })

  test('uses refresh and account fallbacks during refresh responses', () => {
    const fallbackSession = {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() + 30_000,
      tokenType: 'Bearer',
      scopes: ['openid'],
      tokenEndpoint: 'https://auth.x.ai/oauth/token',
      account: {
        subject: 'x-user-1',
        emailAddress: 'x@example.com',
        displayName: 'X User',
      },
    }

    const session = buildXPremiumSession(
      {
        access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 7200 }),
        expires_in: 7200,
      },
      'https://auth.x.ai/oauth/token',
      fallbackSession.refreshToken,
      fallbackSession,
    )

    expect(session.refreshToken).toBe('old-refresh')
    expect(session.account).toEqual(fallbackSession.account)
    expect(session.tokenType).toBe('Bearer')
  })

  test('rejects token responses without usable credentials or expiry', () => {
    expect(() =>
      buildXPremiumSession({ refresh_token: 'refresh-token' }, 'https://auth.x.ai/oauth/token'),
    ).toThrow(/missing access_token/)
    expect(() =>
      buildXPremiumSession({ access_token: 'bad-token' }, 'https://auth.x.ai/oauth/token'),
    ).toThrow(/missing refresh_token/)
    expect(() =>
      buildXPremiumSession(
        { access_token: 'bad-token', refresh_token: 'refresh-token' },
        'https://auth.x.ai/oauth/token',
      ),
    ).toThrow(/token expiry/)
  })
})
