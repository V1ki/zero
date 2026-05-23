import { describe, expect, test } from 'bun:test'
import type { ToolContext } from '@zero-os/shared'
import { XSearchTool } from '../x-search'

function createContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'session-x-search',
    workDir: '/tmp',
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    ...overrides,
  } as ToolContext
}

describe('XSearchTool', () => {
  test('posts a Responses request with the x_search hosted tool', async () => {
    const captured: {
      url?: string
      headers?: HeadersInit
      body?: Record<string, unknown>
    } = {}

    const tool = new XSearchTool({
      credentialProvider: () => ({
        bearerToken: 'oauth-token',
        authorizationScheme: 'Bearer',
        baseUrl: 'https://api.x.ai/v1',
        source: 'x-premium-oauth',
      }),
      fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.url = String(input)
        captured.headers = init?.headers
        captured.body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        return new Response(
          JSON.stringify({
            output_text: 'People on X are discussing xAI.',
            citations: [{ url: 'https://x.com/xai/status/1', title: 'xAI post' }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }) as unknown as typeof fetch,
      maxRetries: 0,
    })

    const result = await tool.run(createContext(), {
      query: 'What are people saying about xAI on X?',
      allowed_x_handles: ['xai', '@grok'],
      from_date: '2026-04-01',
      to_date: '2026-04-10',
      enable_image_understanding: true,
    })

    expect(result.success).toBe(true)
    expect(captured.url).toBe('https://api.x.ai/v1/responses')
    expect(captured.headers).toMatchObject({
      Authorization: 'Bearer oauth-token',
      'Content-Type': 'application/json',
      'User-Agent': 'Zero-OS/x-search',
    })
    expect(captured.body).toMatchObject({
      model: 'grok-4.20-reasoning',
      store: false,
      input: [{ role: 'user', content: 'What are people saying about xAI on X?' }],
      tools: [
        {
          type: 'x_search',
          allowed_x_handles: ['xai', 'grok'],
          from_date: '2026-04-01',
          to_date: '2026-04-10',
          enable_image_understanding: true,
        },
      ],
    })
    expect(result.output).not.toContain('oauth-token')
    expect(JSON.parse(result.output)).toMatchObject({
      success: true,
      credential_source: 'x-premium-oauth',
      tool: 'x_search',
      answer: 'People on X are discussing xAI.',
    })
  })

  test('rejects conflicting handle filters before requesting xAI', async () => {
    let called = false
    const tool = new XSearchTool({
      credentialProvider: () => ({ bearerToken: 'token' }),
      fetchFn: (async () => {
        called = true
        return new Response('{}')
      }) as unknown as typeof fetch,
    })

    const result = await tool.run(createContext(), {
      query: 'xai',
      allowed_x_handles: ['xai'],
      excluded_x_handles: ['grok'],
    })

    expect(result.success).toBe(false)
    expect(result.output).toContain('cannot be used together')
    expect(called).toBe(false)
  })

  test('falls back to xai_api_key from secretResolver', async () => {
    const authorizations: string[] = []
    const tool = new XSearchTool({
      fetchFn: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        authorizations.push((init?.headers as Record<string, string>).Authorization)
        return new Response(JSON.stringify({ output_text: 'Found via API key.' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch,
      maxRetries: 0,
    })

    const result = await tool.run(
      createContext({
        secretResolver: (ref) => (ref === 'xai_api_key' ? 'xai-api-key' : undefined),
      }),
      { query: 'anything about xAI' },
    )

    expect(result.success).toBe(true)
    expect(authorizations).toEqual(['Bearer xai-api-key'])
    expect(JSON.parse(result.output)).toMatchObject({
      credential_source: 'xai-api-key',
      answer: 'Found via API key.',
    })
  })

  test('returns a structured error when no xAI credential is available', async () => {
    const tool = new XSearchTool()

    const result = await tool.run(createContext(), { query: 'xai' })

    expect(result.success).toBe(false)
    expect(result.output).toContain('No xAI credentials available')
  })
})
