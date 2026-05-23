import { describe, expect, test } from 'bun:test'
import type { Message } from '@zero-os/shared'
import { generateId, now } from '@zero-os/shared'
import { XResponsesAdapter } from '../adapters/x-resp'

function makeMessage(role: 'user' | 'assistant', text: string): Message {
  return {
    id: generateId(),
    sessionId: 'test',
    role,
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt: now(),
  }
}

function makeXPremiumSessionJson(expMs: number, accessToken: string, tokenType = 'Bearer') {
  return JSON.stringify({
    accessToken,
    refreshToken: 'refresh-token',
    expiresAt: expMs,
    tokenType,
    scopes: ['openid', 'profile', 'email', 'offline_access', 'grok-cli:access', 'api:access'],
  })
}

describe('X Responses Adapter', () => {
  test('refreshes expiring tokens before sending the request', async () => {
    let currentSession = makeXPremiumSessionJson(Date.now() + 30 * 1000, 'old-x-token', 'bearer')
    let refreshCalls = 0
    const headersSeen: string[] = []
    const urlsSeen: string[] = []
    const bodiesSeen: Array<Record<string, unknown>> = []

    const adapter = new XResponsesAdapter({
      providerName: 'x-premium',
      baseUrl: 'https://api.x.ai/v1',
      auth: { type: 'oauth2', oauthTokenRef: 'x_premium_oauth_session' },
      modelConfig: {
        modelId: 'grok-4.3',
        maxContext: 256000,
        maxOutput: 8192,
        capabilities: [],
        tags: [],
      },
      oauthTokenProvider: () => currentSession,
      oauthTokenRefresher: async () => {
        refreshCalls += 1
        currentSession = makeXPremiumSessionJson(Date.now() + 2 * 60 * 60 * 1000, 'new-x-token')
      },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urlsSeen.push(String(input))
      headersSeen.push((init?.headers as Record<string, string>).Authorization)
      bodiesSeen.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(
        JSON.stringify({
          id: 'resp_x_1',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 12, output_tokens: 3 },
          model: 'grok-4.3',
          status: 'completed',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }) as unknown as typeof fetch

    try {
      const response = await adapter.complete({
        messages: [makeMessage('user', 'Hello')],
        stream: false,
        model: 'x-premium/grok-4.3',
      })

      expect(refreshCalls).toBe(1)
      expect(urlsSeen).toEqual(['https://api.x.ai/v1/responses'])
      expect(headersSeen).toEqual(['Bearer new-x-token'])
      expect(bodiesSeen[0].model).toBe('grok-4.3')
      expect(bodiesSeen[0].store).toBe(false)
      expect(response.content).toEqual([{ type: 'text', text: 'ok' }])
      expect(response.usage).toEqual({
        input: 12,
        output: 3,
        cacheWrite: undefined,
        cacheRead: undefined,
        reasoning: undefined,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('retries once after a 401 with refreshed credentials', async () => {
    let currentSession = makeXPremiumSessionJson(
      Date.now() + 2 * 60 * 60 * 1000,
      'old-x-token',
      'bearer',
    )
    let refreshCalls = 0
    let requestCount = 0
    const headersSeen: string[] = []

    const adapter = new XResponsesAdapter({
      providerName: 'x-premium',
      baseUrl: 'https://api.x.ai/v1',
      auth: { type: 'oauth2', oauthTokenRef: 'x_premium_oauth_session' },
      modelConfig: {
        modelId: 'grok-4.3',
        maxContext: 256000,
        maxOutput: 8192,
        capabilities: [],
        tags: [],
      },
      oauthTokenProvider: () => currentSession,
      oauthTokenRefresher: async () => {
        refreshCalls += 1
        currentSession = makeXPremiumSessionJson(Date.now() + 2 * 60 * 60 * 1000, 'new-x-token')
      },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestCount += 1
      headersSeen.push((init?.headers as Record<string, string>).Authorization)

      if (requestCount === 1) {
        return new Response('unauthorized', { status: 401 })
      }

      return new Response(
        JSON.stringify({
          id: 'resp_x_2',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'retried' }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
          model: 'grok-4.3',
          status: 'completed',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }) as unknown as typeof fetch

    try {
      const response = await adapter.complete({
        messages: [makeMessage('user', 'Hello')],
        stream: false,
      })

      expect(refreshCalls).toBe(1)
      expect(requestCount).toBe(2)
      expect(headersSeen[0]).toBe('Bearer old-x-token')
      expect(headersSeen[1]).toBe('Bearer new-x-token')
      expect(response.content).toEqual([{ type: 'text', text: 'retried' }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
