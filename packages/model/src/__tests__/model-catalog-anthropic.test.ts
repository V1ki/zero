import { describe, expect, test } from 'bun:test'
import type { ProviderConfig } from '@zero-os/shared'
import { AnthropicModelsDiscoveryDriver, parseAnthropicModels } from '../catalog/anthropic'

const provider: ProviderConfig = {
  apiType: 'anthropic_messages',
  baseUrl: 'https://api.anthropic.com',
  auth: { type: 'oauth2', oauthTokenRef: 'claude_oauth_session' },
  models: {},
}

const session = JSON.stringify({
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 60_000,
  tokenType: 'Bearer',
  scopes: ['user:inference'],
  account: { accountUuid: 'account-1' },
})

function modelPayload(id: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'model',
    id,
    display_name: id,
    created_at: '2026-09-01T00:00:00Z',
    max_input_tokens: 1_000_000,
    max_tokens: 128_000,
    capabilities: {
      image_input: { supported: true },
      thinking: { supported: true, types: { adaptive: { supported: true } } },
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        max: { supported: true },
      },
    },
    ...overrides,
  }
}

describe('parseAnthropicModels', () => {
  test('normalizes Models API records into catalog descriptors', () => {
    const models = parseAnthropicModels(
      { data: [modelPayload('claude-fable-5-1', { display_name: 'Claude Fable 5.1' })] },
      { authKind: 'oauth' },
    )

    expect(models).toEqual([
      expect.objectContaining({
        modelId: 'claude-fable-5-1',
        modelName: 'claude-fable-5-1',
        displayName: 'Claude Fable 5.1',
        family: 'claude',
        lane: 'fable',
        version: '5.1',
        maxContext: 1_000_000,
        maxOutput: 128_000,
        capabilities: ['tools', 'vision', 'reasoning'],
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        tags: ['anthropic', 'claude', 'fable', '5.1', 'tools', 'vision', 'reasoning', 'oauth'],
      }),
    ])
    expect(models[0].provenance).toMatchObject({
      maxContext: 'provider',
      maxOutput: 'provider',
      capabilities: 'provider',
      supportedReasoningEfforts: 'provider',
    })
  })

  test('infers identity for current and legacy id shapes', () => {
    const models = parseAnthropicModels({
      data: [
        { type: 'model', id: 'claude-opus-5-5' },
        { type: 'model', id: 'claude-opus-4-8' },
        { type: 'model', id: 'claude-3-5-sonnet-20241022' },
        { type: 'model', id: 'claude-3-haiku-20240307' },
        { type: 'model', id: 'claude-mythos-preview' },
      ],
    })
    const byId = new Map(models.map((model) => [model.modelId, model]))

    expect(byId.get('claude-opus-5-5')).toMatchObject({ lane: 'opus', version: '5.5' })
    expect(byId.get('claude-opus-4-8')).toMatchObject({ lane: 'opus', version: '4.8' })
    expect(byId.get('claude-3-5-sonnet-20241022')).toMatchObject({
      lane: 'sonnet',
      version: '3.5',
    })
    expect(byId.get('claude-3-haiku-20240307')).toMatchObject({ lane: 'haiku', version: '3' })
    expect(byId.get('claude-mythos-preview')).toMatchObject({ family: 'claude' })
    expect(byId.get('claude-mythos-preview')?.lane).toBeUndefined()
  })

  test('falls back to system defaults when the API omits limits and capabilities', () => {
    const models = parseAnthropicModels({
      data: [
        { type: 'model', id: 'claude-opus-4-8' },
        { type: 'model' },
        { id: 'x', type: 'other' },
      ],
    })

    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      maxContext: 200_000,
      maxOutput: 8192,
      capabilities: ['tools', 'vision', 'reasoning'],
      supportedReasoningEfforts: [],
    })
    expect(models[0].provenance).toMatchObject({
      maxContext: 'system_default',
      maxOutput: 'system_default',
      capabilities: 'system_default',
    })
    expect(models[0].tags).not.toContain('oauth')
  })
})

describe('AnthropicModelsDiscoveryDriver', () => {
  test('scopes discovery to Anthropic Messages providers', () => {
    const driver = new AnthropicModelsDiscoveryDriver()
    expect(driver.supports('anthropic', provider)).toBe(true)
    expect(driver.supports('anthropic-max', provider)).toBe(true)
    expect(
      driver.supports('claude-work', {
        ...provider,
        auth: { ...provider.auth, managedOAuthProvider: 'anthropic' },
      }),
    ).toBe(true)
    expect(
      driver.supports('relay', {
        ...provider,
        baseUrl: 'https://api.anthropic.com/',
        auth: { type: 'api_key', apiKeyRef: 'anthropic_api_key' },
      }),
    ).toBe(true)
    expect(driver.supports('relay', { ...provider, baseUrl: 'https://relay.example.com' })).toBe(
      false,
    )
    expect(driver.supports('deepseek', { ...provider, apiType: 'anthropic-deepseek' })).toBe(false)
  })

  test('discovers, paginates and verifies with the Claude Code OAuth transport', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const driver = new AnthropicModelsDiscoveryDriver(async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.includes('/v1/models')) {
        const afterId = new URL(url).searchParams.get('after_id')
        return afterId
          ? Response.json({
              data: [modelPayload('claude-opus-5-5')],
              has_more: false,
              last_id: 'claude-opus-5-5',
            })
          : Response.json({
              data: [modelPayload('claude-fable-5-1')],
              has_more: true,
              last_id: 'claude-fable-5-1',
            })
      }
      return Response.json({ id: 'msg_1', type: 'message', content: [] })
    })
    const context = {
      providerName: 'anthropic',
      provider,
      secretGetter: (ref: string) => (ref === 'claude_oauth_session' ? session : undefined),
      signal: new AbortController().signal,
    }

    const discovered = await driver.discover(context)
    const verified = await driver.verify(context, discovered.scope, discovered.models[0])

    expect(discovered.scope).toMatchObject({
      providerName: 'anthropic',
      providerKind: 'anthropic',
      transport: 'anthropic_messages:https://api.anthropic.com',
      apiType: 'anthropic_messages',
    })
    expect(discovered.models.map((model) => model.modelId)).toEqual([
      'claude-fable-5-1',
      'claude-opus-5-5',
    ])
    expect(verified).toEqual({ ok: true })

    expect(requests[0].url).toBe('https://api.anthropic.com/v1/models?limit=1000&beta=true')
    expect(requests[1].url).toContain('after_id=claude-fable-5-1')
    expect(requests[2].url).toBe('https://api.anthropic.com/v1/messages?beta=true')

    const listHeaders = new Headers(requests[0].init?.headers)
    expect(listHeaders.get('authorization')).toBe('Bearer access-token')
    expect(listHeaders.get('anthropic-version')).toBe('2023-06-01')
    expect(listHeaders.get('anthropic-beta')).toContain('oauth-2025-04-20')
    expect(listHeaders.get('x-api-key')).toBeNull()

    const body = JSON.parse(String(requests[2].init?.body)) as Record<string, unknown>
    expect(body.model).toBe('claude-fable-5-1')
    expect(body.max_tokens).toBe(8)
    expect(body.system).toEqual([
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
    ])
    expect(body.thinking).toBeUndefined()
  })

  test('uses x-api-key for api_key providers without the OAuth transport extras', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const driver = new AnthropicModelsDiscoveryDriver(async (input, init) => {
      requests.push({ url: String(input), init })
      return Response.json({ data: [modelPayload('claude-opus-5')], has_more: false })
    })
    const apiKeyProvider: ProviderConfig = {
      ...provider,
      auth: { type: 'api_key', apiKeyRef: 'anthropic_api_key' },
    }
    const context = {
      providerName: 'anthropic-api',
      provider: apiKeyProvider,
      secretGetter: (ref: string) => (ref === 'anthropic_api_key' ? 'sk-ant-test' : undefined),
      signal: new AbortController().signal,
    }

    const discovered = await driver.discover(context)
    await driver.verify(context, discovered.scope, discovered.models[0])

    expect(requests[0].url).toBe('https://api.anthropic.com/v1/models?limit=1000')
    const headers = new Headers(requests[0].init?.headers)
    expect(headers.get('x-api-key')).toBe('sk-ant-test')
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('anthropic-beta')).toBeNull()
    const body = JSON.parse(String(requests[1].init?.body)) as Record<string, unknown>
    expect(body.system).toBeUndefined()
    expect(discovered.models[0].tags).not.toContain('oauth')
  })

  test('keeps the account fingerprint stable across access token rotation', () => {
    const driver = new AnthropicModelsDiscoveryDriver()
    const rotated = JSON.stringify({ ...JSON.parse(session), accessToken: 'rotated-token' })
    const scopeA = driver.resolveScope({
      providerName: 'anthropic',
      provider,
      secretGetter: () => session,
    })
    const scopeB = driver.resolveScope({
      providerName: 'anthropic',
      provider,
      secretGetter: () => rotated,
    })
    expect(scopeA?.accountFingerprint).toBeDefined()
    expect(scopeA?.accountFingerprint).toBe(scopeB?.accountFingerprint ?? '')
    expect(scopeA?.accountFingerprint).not.toContain('account-1')
    expect(
      driver.resolveScope({ providerName: 'anthropic', provider, secretGetter: () => undefined }),
    ).toBeUndefined()
  })

  test('marks not-found, forbidden and model-level 400 rejections as unavailable', async () => {
    const cases: Array<{ status: number; body: unknown; reason: string }> = [
      {
        status: 404,
        body: { type: 'error', error: { type: 'not_found_error', message: 'model: nope' } },
        reason: 'not_found_error',
      },
      {
        status: 403,
        body: { type: 'error', error: { type: 'permission_error', message: 'no access' } },
        reason: 'permission_error',
      },
      {
        status: 400,
        body: {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'The model claude-x is not supported' },
        },
        reason: 'invalid_request_error',
      },
      {
        status: 400,
        body: {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message:
              'Claude Code 2.1.97 does not support this model; version 2.1.280 or newer is required.',
          },
        },
        reason: 'invalid_request_error',
      },
    ]
    for (const testCase of cases) {
      const driver = new AnthropicModelsDiscoveryDriver(
        async () => new Response(JSON.stringify(testCase.body), { status: testCase.status }),
      )
      const context = {
        providerName: 'anthropic',
        provider,
        secretGetter: () => session,
        signal: new AbortController().signal,
      }
      const scope = driver.resolveScope(context)
      if (!scope) throw new Error('expected discovery scope')
      await expect(
        driver.verify(context, scope, { modelName: 'claude-x', modelId: 'claude-x' }),
      ).resolves.toEqual({ ok: false, reason: testCase.reason })
    }
  })

  test('surfaces request-shape 400s and server errors instead of marking models unavailable', async () => {
    for (const [status, body] of [
      [
        400,
        { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: bad' } },
      ],
      [429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }],
      [529, { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }],
    ] as const) {
      const driver = new AnthropicModelsDiscoveryDriver(
        async () => new Response(JSON.stringify(body), { status }),
      )
      const context = {
        providerName: 'anthropic',
        provider,
        secretGetter: () => session,
        signal: new AbortController().signal,
      }
      const scope = driver.resolveScope(context)
      if (!scope) throw new Error('expected discovery scope')
      await expect(
        driver.verify(context, scope, { modelName: 'claude-x', modelId: 'claude-x' }),
      ).rejects.toThrow(`HTTP ${status}`)
    }
  })

  test('rejects an empty or failed listing without inventing models', async () => {
    const driver = new AnthropicModelsDiscoveryDriver(async () => new Response('', { status: 500 }))
    await expect(
      driver.discover({
        providerName: 'anthropic',
        provider,
        secretGetter: () => session,
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow('HTTP 500')
  })
})

describe('Anthropic catalog authentication recovery', () => {
  test('retries a 401 once with refreshed credentials', async () => {
    let stored = session
    const headers: string[] = []
    const reasons: string[] = []
    const driver = new AnthropicModelsDiscoveryDriver(
      async (_url, init) => {
        headers.push(new Headers(init?.headers).get('authorization') ?? '')
        return headers.length === 1
          ? new Response(null, { status: 401 })
          : Response.json({ data: [modelPayload('claude-opus-5-5')], has_more: false })
      },
      async (_context, reason) => {
        reasons.push(reason)
        if (reason === 'unauthorized')
          stored = JSON.stringify({ ...JSON.parse(session), accessToken: 'fresh-token' })
      },
    )
    const result = await driver.discover({
      providerName: 'anthropic',
      provider,
      secretGetter: () => stored,
      signal: AbortSignal.timeout(1000),
    })
    expect(result.models[0].modelId).toBe('claude-opus-5-5')
    expect(headers).toEqual(['Bearer access-token', 'Bearer fresh-token'])
    expect(reasons).toEqual(['expiring', 'unauthorized'])
  })

  test('surfaces persistent 401 and refresh grant failures without looping', async () => {
    for (const failRefresh of [false, true]) {
      let calls = 0
      const driver = new AnthropicModelsDiscoveryDriver(
        async () => {
          calls++
          return new Response(null, { status: 401 })
        },
        async (_context, reason) => {
          if (failRefresh && reason === 'unauthorized') throw new Error('refresh grant rejected')
        },
      )
      await expect(
        driver.discover({
          providerName: 'anthropic',
          provider,
          secretGetter: () => session,
          signal: AbortSignal.timeout(1000),
        }),
      ).rejects.toThrow(failRefresh ? 'refresh grant rejected' : 'HTTP 401')
      expect(calls).toBe(failRefresh ? 1 : 2)
    }
  })

  test('does not retry api_key providers on 401', async () => {
    let calls = 0
    let refreshes = 0
    const driver = new AnthropicModelsDiscoveryDriver(
      async () => {
        calls++
        return new Response(null, { status: 401 })
      },
      async () => {
        refreshes++
      },
    )
    await expect(
      driver.discover({
        providerName: 'anthropic',
        provider: { ...provider, auth: { type: 'api_key', apiKeyRef: 'anthropic_api_key' } },
        secretGetter: () => 'sk-ant-test',
        signal: AbortSignal.timeout(1000),
      }),
    ).rejects.toThrow('HTTP 401')
    expect(calls).toBe(1)
    expect(refreshes).toBe(0)
  })
})
