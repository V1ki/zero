import { afterEach, describe, expect, test } from 'bun:test'
import { exchangeXPremiumCode } from '../providers/x-premium'

const originalFetch = globalThis.fetch

const discovery = {
  authorization_endpoint: 'https://auth.x.ai/oauth/authorize',
  token_endpoint: 'https://auth.x.ai/oauth/token',
}

function makeJwt(payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('exchangeXPremiumCode', () => {
  test('posts form-encoded PKCE fields and builds a session', async () => {
    let tokenRequestBody = ''

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/.well-known/openid-configuration')) {
        return new Response(JSON.stringify(discovery), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      tokenRequestBody = String(init?.body ?? '')
      return new Response(
        JSON.stringify({
          access_token: makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: 'refresh-token',
          token_type: 'bearer',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }) as unknown as typeof fetch

    const session = await exchangeXPremiumCode(
      {
        code: 'code-123',
        redirectUri: 'http://127.0.0.1:56121/callback',
        codeVerifier: 'verifier-123',
      },
      5000,
    )

    const body = new URLSearchParams(tokenRequestBody)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('code-123')
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:56121/callback')
    expect(body.get('code_verifier')).toBe('verifier-123')
    expect(body.get('code_challenge')).toBeTruthy()
    expect(body.get('code_challenge_method')).toBe('S256')
    expect(session.refreshToken).toBe('refresh-token')
    expect(session.tokenType).toBe('Bearer')
    expect(session.tokenEndpoint).toBe(discovery.token_endpoint)
  })

  test('surfaces plan entitlement failures without suggesting another login', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/.well-known/openid-configuration')) {
        return new Response(JSON.stringify(discovery), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    await expect(
      exchangeXPremiumCode(
        {
          code: 'code-123',
          redirectUri: 'http://127.0.0.1:56121/callback',
          codeVerifier: 'verifier-123',
        },
        5000,
      ),
    ).rejects.toThrow(/not authorized for xAI API access.*re-authentication usually will not/)
  })
})
