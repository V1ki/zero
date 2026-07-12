import { describe, expect, test } from 'bun:test'
import type { ProviderConfig } from '@zero-os/shared'
import { ChatGptCodexDiscoveryDriver, parseChatGptCodexModels } from '../catalog/chatgpt-codex'

const provider: ProviderConfig = {
  apiType: 'openai_responses',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  auth: { type: 'oauth2', oauthTokenRef: 'chatgpt_oauth_token' },
  models: {},
}

const session = JSON.stringify({
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 60_000,
  tokenType: 'Bearer',
  accountId: 'account-1',
})

describe('ChatGptCodexDiscoveryDriver', () => {
  test('parses Codex metadata into normalized model descriptors', () => {
    const models = parseChatGptCodexModels({
      models: [
        {
          slug: 'gpt-5.6-sol',
          display_name: 'GPT-5.6-Sol',
          description: 'Latest frontier agentic coding model.',
          max_context_window: 372000,
          max_output_tokens: 128000,
          default_reasoning_level: 'low',
          supported_reasoning_levels: [
            { effort: 'low' },
            { effort: 'medium' },
            { effort: 'high' },
            { effort: 'xhigh' },
          ],
          input_modalities: ['text', 'image'],
          apply_patch_tool_type: 'freeform',
          reasoning_summary_format: 'experimental',
        },
      ],
    })

    expect(models).toEqual([
      expect.objectContaining({
        modelId: 'gpt-5.6-sol',
        modelName: 'gpt-5.6-sol',
        displayName: 'GPT-5.6-Sol',
        family: 'gpt',
        version: '5.6',
        lane: 'sol',
        maxContext: 372000,
        maxOutput: 128000,
        capabilities: ['tools', 'vision', 'reasoning'],
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      }),
    ])
  })

  test('uses conservative output defaults and ignores malformed records', () => {
    const models = parseChatGptCodexModels({
      data: [{ slug: 'gpt-5.6-terra', max_context_window: 372000 }, { title: 'missing id' }],
    })

    expect(models).toHaveLength(1)
    expect(models[0].maxOutput).toBe(8192)
    expect(models[0].provenance?.maxOutput).toBe('system_default')
  })

  test('scopes discovery to the ChatGPT Codex transport', () => {
    const driver = new ChatGptCodexDiscoveryDriver()
    expect(driver.supports('chatgpt', provider)).toBe(true)
    expect(
      driver.supports('chatgpt', {
        ...provider,
        baseUrl: 'https://chatgpt.com/backend-api',
      }),
    ).toBe(false)
    expect(
      driver.supports('openai', {
        ...provider,
        auth: { ...provider.auth, managedOAuthProvider: undefined },
      }),
    ).toBe(false)
  })

  test('discovers and verifies models without exposing credentials', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const driver = new ChatGptCodexDiscoveryDriver(async (input, init) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.includes('/models?')) {
        return Response.json({ models: [{ slug: 'gpt-5.6-sol', max_context_window: 372000 }] })
      }
      return new Response(
        'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.6-sol"}}\n\n',
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    })
    const context = {
      providerName: 'chatgpt',
      provider,
      secretGetter: (ref: string) => (ref === 'chatgpt_oauth_token' ? session : undefined),
      signal: new AbortController().signal,
    }

    const discovered = await driver.discover(context)
    const verified = await driver.verify(context, discovered.scope, discovered.models[0])

    expect(discovered.models.map((model) => model.modelId)).toEqual(['gpt-5.6-sol'])
    expect(verified).toEqual({ ok: true })
    expect(requests[0].url).toContain('/backend-api/codex/models?client_version=')
    expect(requests[1].url).toEndWith('/backend-api/codex/responses')
    expect((requests[0].init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer access-token',
    )
  })

  test('marks model-level 404 verification as unavailable', async () => {
    const driver = new ChatGptCodexDiscoveryDriver(async () => new Response('', { status: 404 }))
    const context = {
      providerName: 'chatgpt',
      provider,
      secretGetter: () => session,
      signal: new AbortController().signal,
    }
    const scope = driver.resolveScope(context)
    expect(scope).toBeDefined()
    if (!scope) throw new Error('expected discovery scope')

    await expect(
      driver.verify(context, scope, { modelName: 'gpt-5.6-luna', modelId: 'gpt-5.6-luna' }),
    ).resolves.toEqual({ ok: false, reason: 'http_404' })
  })

  test('rejects a model that fails inside an HTTP 200 SSE stream', async () => {
    const driver = new ChatGptCodexDiscoveryDriver(
      async () =>
        new Response(
          'data: {"type":"response.failed","response":{"error":{"code":"model_not_found","message":"Model does not exist"}}}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    )
    const context = {
      providerName: 'chatgpt',
      provider,
      secretGetter: () => session,
      signal: new AbortController().signal,
    }
    const scope = driver.resolveScope(context)
    expect(scope).toBeDefined()
    if (!scope) throw new Error('expected discovery scope')

    await expect(
      driver.verify(context, scope, { modelName: 'gpt-5.6-luna', modelId: 'gpt-5.6-luna' }),
    ).resolves.toEqual({ ok: false, reason: 'model_not_found' })
  })
})
