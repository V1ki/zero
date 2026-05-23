import { afterEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseXPremiumOAuthSession, serializeXPremiumOAuthSession } from '@zero-os/model'
import { Vault } from '@zero-os/secrets'
import { XPremiumOAuthDriver, XPremiumTokenManager } from '../x-premium-oauth'
import { getXPremiumOAuthSessionRef } from '../x-premium-provider'

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

function createVault() {
  const dir = mkdtempSync(join(tmpdir(), 'zero-x-premium-token-manager-'))
  const vault = new Vault(randomBytes(32), join(dir, 'secrets.enc'))
  vault.load()
  return { dir, vault }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('XPremiumOAuthDriver', () => {
  test('buildAuthorizationUrl follows the xAI OAuth PKCE flow', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(discovery), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch

    const driver = new XPremiumOAuthDriver()
    const url = new URL(
      await driver.buildAuthorizationUrl({
        state: 'state-123',
        redirectUri: 'http://127.0.0.1:56121/callback',
        codeVerifier: 'verifier-123',
        codeChallenge: 'challenge-123',
      }),
    )

    expect(`${url.origin}${url.pathname}`).toBe(discovery.authorization_endpoint)
    expect(url.searchParams.get('client_id')).toBe('b1a00492-073a-47ea-816f-4c329264a828')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:56121/callback')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-123')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('state-123')
    expect(url.searchParams.get('plan')).toBe('generic')
    expect(url.searchParams.get('referrer')).toBe('zero-os')
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'openid',
      'profile',
      'email',
      'offline_access',
      'grok-cli:access',
      'api:access',
    ])
  })

  test('exchangeCode posts form-encoded PKCE fields and builds a session', async () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 3600
    const idToken = makeJwt({
      sub: 'x-user-1',
      email: 'x@example.com',
      name: 'X User',
      preferred_username: 'xuser',
    })
    const accessToken = makeJwt({ exp: expSeconds })
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
          access_token: accessToken,
          refresh_token: 'refresh-token',
          id_token: idToken,
          token_type: 'bearer',
          scope: 'openid profile email offline_access grok-cli:access api:access',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }) as unknown as typeof fetch

    const driver = new XPremiumOAuthDriver()
    const session = await driver.exchangeCode({
      code: 'code-123',
      state: 'state-123',
      redirectUri: 'http://127.0.0.1:56121/callback',
      codeVerifier: 'verifier-123',
    })

    const body = new URLSearchParams(tokenRequestBody)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('code-123')
    expect(body.get('code_verifier')).toBe('verifier-123')
    expect(body.get('code_challenge')).toBeTruthy()
    expect(body.get('code_challenge_method')).toBe('S256')
    expect(session.accessToken).toBe(accessToken)
    expect(session.refreshToken).toBe('refresh-token')
    expect(session.tokenType).toBe('Bearer')
    expect(session.account?.emailAddress).toBe('x@example.com')
    expect(session.tokenEndpoint).toBe(discovery.token_endpoint)
  })
})

describe('XPremiumTokenManager', () => {
  test('refreshes expiring sessions and persists the updated token set', async () => {
    const { dir, vault } = createVault()
    const nowSeconds = Math.floor(Date.now() / 1000)
    vault.set(
      getXPremiumOAuthSessionRef(),
      serializeXPremiumOAuthSession({
        accessToken: makeJwt({ exp: nowSeconds + 30 }),
        refreshToken: 'refresh-old',
        expiresAt: Date.now() + 30_000,
        tokenType: 'Bearer',
        scopes: ['openid', 'profile'],
        tokenEndpoint: discovery.token_endpoint,
      }),
    )

    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      return new Response(
        JSON.stringify({
          access_token: makeJwt({ exp: nowSeconds + 7200 }),
          refresh_token: 'refresh-new',
          expires_in: 7200,
          token_type: 'bearer',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }) as unknown as typeof fetch

    const manager = new XPremiumTokenManager(vault)

    try {
      const refreshed = await manager.ensureFreshSession()
      expect(fetchCalls).toBe(1)
      expect(refreshed.refreshToken).toBe('refresh-new')
      expect(refreshed.tokenType).toBe('Bearer')
      expect(refreshed.expiresAt).toBeGreaterThan(Date.now() + 60 * 60 * 1000)

      const stored = parseXPremiumOAuthSession(vault.get(getXPremiumOAuthSessionRef()))
      expect(stored).toEqual(refreshed)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('surfaces xAI plan entitlement failures without suggesting another login', async () => {
    const { dir, vault } = createVault()
    vault.set(
      getXPremiumOAuthSessionRef(),
      serializeXPremiumOAuthSession({
        accessToken: makeJwt({ exp: Math.floor(Date.now() / 1000) + 30 }),
        refreshToken: 'refresh-old',
        expiresAt: Date.now() + 30_000,
        tokenType: 'Bearer',
        scopes: ['openid', 'profile'],
        tokenEndpoint: discovery.token_endpoint,
      }),
    )

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch

    const manager = new XPremiumTokenManager(vault)

    try {
      await expect(manager.refreshSession('unauthorized')).rejects.toThrow(
        /not authorized for xAI API access.*re-authentication usually will not change this/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
