import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import type { CompletionRequest, ContentBlock, Message } from '@zero-os/shared'
import { generateId, now } from '@zero-os/shared'
import { AnthropicAdapter } from '../adapters/anthropic'

/**
 * Anthropic adapter tests.
 * Real API tests run when either:
 *   1. ANTHROPIC_API_KEY env var is set (API Key mode), or
 *   2. Vault contains CLAUDE_CODE_OAUTH_TOKEN (OAuth mode, matches project provider config)
 * Pure logic tests always run.
 */

// --- credential resolution: env var API key OR vault OAuth token ---
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? ''

let ANTHROPIC_OAUTH_TOKEN = ''
try {
  const { getMasterKey } = await import('../../../secrets/src/keychain')
  const { Vault } = await import('../../../secrets/src/vault')
  const masterKey = await getMasterKey()
  const vault = new Vault(masterKey, join(__dirname, '../../../../.zero/secrets.enc'))
  vault.load()
  ANTHROPIC_OAUTH_TOKEN = vault.get('CLAUDE_CODE_OAUTH_TOKEN')?.trim() ?? ''
} catch {
  // vault unavailable — rely on env var
}

const HAS_KEY = ANTHROPIC_API_KEY.length > 0 || ANTHROPIC_OAUTH_TOKEN.length > 0

function createAdapter(): AnthropicAdapter {
  // prefer OAuth if available (matches project provider config), fall back to API key
  if (ANTHROPIC_OAUTH_TOKEN) {
    return new AnthropicAdapter({
      baseUrl: 'https://api.anthropic.com',
      auth: { type: 'oauth2', oauthTokenRef: 'CLAUDE_CODE_OAUTH_TOKEN' },
      modelConfig: {
        modelId: 'claude-sonnet-4-6',
        maxContext: 200000,
        maxOutput: 8192,
        capabilities: ['tools', 'vision'],
        tags: ['balanced'],
      },
      oauthToken: ANTHROPIC_OAUTH_TOKEN,
    })
  }
  return new AnthropicAdapter({
    baseUrl: 'https://api.anthropic.com',
    auth: { type: 'api_key', apiKeyRef: 'anthropic' },
    modelConfig: {
      modelId: 'claude-sonnet-4-6',
      maxContext: 200000,
      maxOutput: 8192,
      capabilities: ['tools', 'vision'],
      tags: ['balanced'],
    },
    apiKey: ANTHROPIC_API_KEY || 'dummy',
  })
}

const adapter = createAdapter()

/** API-key-mode adapter for pure logic tests that must not have OAuth identity prepended. */
function createApiKeyAdapter(): AnthropicAdapter {
  return new AnthropicAdapter({
    baseUrl: 'https://api.anthropic.com',
    auth: { type: 'api_key', apiKeyRef: 'anthropic' },
    modelConfig: {
      modelId: 'claude-sonnet-4-6',
      maxContext: 200000,
      maxOutput: 8192,
      capabilities: ['tools', 'vision'],
      tags: ['balanced'],
    },
    apiKey: 'dummy',
  })
}

type ConvertedAnthropicMessage = {
  role: string
  content: Array<Record<string, unknown>>
}

type ParsedAnthropicContent = Array<{
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}>

interface AnthropicAdapterTestHarness {
  client: {
    messages: {
      create: (params: Record<string, unknown>) => Promise<unknown>
      stream?: () => never
    }
  }
  convertMessages(req: CompletionRequest): Anthropic.MessageParam[]
  convertTools(tools: CompletionRequest['tools']): Anthropic.Tool[] | undefined
  mapStopReason(reason: string | null): string
  parseContent(content: Array<Record<string, unknown>>): ContentBlock[]
  extractReasoningContent(content: Array<Record<string, unknown>>): string | undefined
}

function getAnthropicHarness(instance: AnthropicAdapter): AnthropicAdapterTestHarness {
  return instance as unknown as AnthropicAdapterTestHarness
}

function expectDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message)
  }
  return value
}

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

function makeClaudeOAuthSessionJson(
  accessToken: string,
  expiresAt: number,
  overrides: Partial<{
    refreshToken: string
    tokenType: string
    scopes: string[]
    subscriptionType: string | null
  }> = {},
) {
  return JSON.stringify({
    accessToken,
    refreshToken: overrides.refreshToken ?? 'refresh-token',
    expiresAt,
    tokenType: overrides.tokenType ?? 'Bearer',
    scopes:
      overrides.scopes ?? ['user:profile', 'user:inference', 'user:sessions:claude_code'],
    subscriptionType: overrides.subscriptionType ?? 'max',
  })
}

describe('Anthropic Adapter (Pure Logic)', () => {
  test('convertMessages correctly handles text messages', () => {
    const messages: Message[] = [makeMessage('user', 'Hello'), makeMessage('assistant', 'Hi there')]

    const converted = getAnthropicHarness(adapter).convertMessages({
      messages,
    } as CompletionRequest) as unknown as ConvertedAnthropicMessage[]
    expect(converted).toHaveLength(2)
    expect(converted[0].role).toBe('user')
    expect(converted[0].content[0].type).toBe('text')
    expect(converted[0].content[0].text).toBe('Hello')
    expect(converted[1].role).toBe('assistant')
    expect(converted[1].content[0].text).toBe('Hi there')
  })

  test('convertMessages correctly handles tool_result blocks', () => {
    const toolCallId = `toolu_${generateId()}`
    const messages: Message[] = [
      makeMessage('user', 'What is 2 + 2?'),
      {
        id: generateId(),
        sessionId: 'test',
        role: 'assistant',
        messageType: 'message',
        content: [
          {
            type: 'tool_use',
            id: toolCallId,
            name: 'calculator',
            input: { expression: '2 + 2' },
          },
        ],
        createdAt: now(),
      },
      {
        id: generateId(),
        sessionId: 'test',
        role: 'user',
        messageType: 'message',
        content: [
          {
            type: 'tool_result',
            toolUseId: toolCallId,
            content: '4',
          },
        ],
        createdAt: now(),
      },
    ]

    const converted = getAnthropicHarness(adapter).convertMessages({
      messages,
    } as CompletionRequest) as unknown as ConvertedAnthropicMessage[]

    // Should be: user, assistant (with tool_use), user (with tool_result)
    const roles = converted.map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'user'])

    // Verify assistant message has tool_use block
    const assistantMsg = expectDefined(
      converted.find((m) => m.role === 'assistant'),
      'expected assistant message',
    )
    expect(assistantMsg.content[0].type).toBe('tool_use')
    expect(assistantMsg.content[0].id).toBe(toolCallId)
    expect(assistantMsg.content[0].name).toBe('calculator')

    // Verify the tool_result user message
    const toolResultMsg = converted[2]
    expect(toolResultMsg.content[0].type).toBe('tool_result')
    expect(toolResultMsg.content[0].tool_use_id).toBe(toolCallId)
    expect(toolResultMsg.content[0].content).toBe('4')
  })

  test('convertTools maps to Anthropic format', () => {
    const tools: CompletionRequest['tools'] = [
      {
        name: 'calculator',
        description: 'Calculate math',
        parameters: { type: 'object', properties: { expr: { type: 'string' } } },
      },
    ]
    const converted = expectDefined(
      getAnthropicHarness(adapter).convertTools(tools),
      'expected converted tools',
    )
    expect(converted).toHaveLength(1)
    expect(converted[0].name).toBe('calculator')
    expect(converted[0].description).toBe('Calculate math')
    expect(converted[0].input_schema).toMatchObject({
      type: 'object',
      properties: { expr: { type: 'string' } },
    })
  })

  test('convertTools returns undefined for empty array', () => {
    expect(getAnthropicHarness(adapter).convertTools([])).toBeUndefined()
    expect(getAnthropicHarness(adapter).convertTools(undefined)).toBeUndefined()
  })

  test('mapStopReason maps Anthropic stop reasons correctly', () => {
    expect(getAnthropicHarness(adapter).mapStopReason('end_turn')).toBe('end_turn')
    expect(getAnthropicHarness(adapter).mapStopReason('tool_use')).toBe('tool_use')
    expect(getAnthropicHarness(adapter).mapStopReason('max_tokens')).toBe('max_tokens')
    expect(getAnthropicHarness(adapter).mapStopReason(null)).toBe('end_turn')
    expect(getAnthropicHarness(adapter).mapStopReason('unknown')).toBe('end_turn')
  })

  test('parseContent handles text blocks', () => {
    const content = [{ type: 'text', text: 'Hello world' }]
    const parsed = getAnthropicHarness(adapter).parseContent(content) as ParsedAnthropicContent
    expect(parsed).toHaveLength(1)
    expect(parsed[0].type).toBe('text')
    expect(parsed[0].text).toBe('Hello world')
  })

  test('parseContent handles tool_use blocks', () => {
    const content = [{ type: 'tool_use', id: 'toolu_123', name: 'calc', input: { expr: '1+1' } }]
    const parsed = getAnthropicHarness(adapter).parseContent(content) as ParsedAnthropicContent
    expect(parsed).toHaveLength(1)
    expect(parsed[0].type).toBe('tool_use')
    expect(parsed[0].id).toBe('toolu_123')
    expect(parsed[0].name).toBe('calc')
    expect(parsed[0].input).toEqual({ expr: '1+1' })
  })

  test('parseContent ignores thinking blocks in assistant-visible content', () => {
    const content = [
      { type: 'thinking', thinking: 'private chain', signature: 'sig_1' },
      { type: 'text', text: 'Visible answer' },
    ]

    const parsed = getAnthropicHarness(adapter).parseContent(content) as ParsedAnthropicContent

    expect(parsed).toEqual([{ type: 'text', text: 'Visible answer' }])
  })

  test('extractReasoningContent reads thinking blocks only', () => {
    const reasoning = getAnthropicHarness(adapter).extractReasoningContent([
      { type: 'thinking', thinking: 'step one', signature: 'sig_1' },
      { type: 'redacted_thinking' },
      { type: 'thinking', thinking: 'step two', signature: 'sig_2' },
    ])

    expect(reasoning).toBe('step one\nstep two')
  })

  test('apiType is anthropic_messages', () => {
    expect(adapter.apiType).toBe('anthropic_messages')
  })

  test('stream uses raw SSE create and maps tool events correctly', async () => {
    const streamAdapter = createAdapter()
    const calls: Array<Record<string, unknown>> = []
    let helperCalled = false
    getAnthropicHarness(streamAdapter).client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params)
          return (async function* () {
            yield {
              type: 'message_start',
              message: {
                model: 'claude-sonnet-4-6',
                usage: { input_tokens: 11, output_tokens: 0 },
              },
            }
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            }
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'hello' },
            }
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: 'internal-summary' },
            }
            yield {
              type: 'content_block_stop',
              index: 0,
            }
            yield {
              type: 'content_block_start',
              index: 2,
              content_block: { type: 'redacted_thinking' },
            }
            yield {
              type: 'content_block_stop',
              index: 2,
            }
            yield {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'tool_use', id: 'toolu_123', name: 'calculator', input: {} },
            }
            yield {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '{"expr":"1+1"}' },
            }
            yield {
              type: 'content_block_stop',
              index: 1,
            }
            yield {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use' },
              usage: { output_tokens: 7 },
            }
            yield {
              type: 'message_stop',
            }
          })()
        },
        stream: () => {
          helperCalled = true
          throw new Error('messages.stream should not be used')
        },
      },
    }

    const events: Array<{ type: string; data: unknown }> = []
    for await (const event of streamAdapter.stream({
      messages: [makeMessage('user', 'test')],
      stream: true,
      maxTokens: 123,
    })) {
      events.push(event)
    }

    expect(helperCalled).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0].stream).toBe(true)
    expect(calls[0].max_tokens).toBe(123)
    expect(calls[0].thinking).toEqual({ type: 'adaptive' })
    expect(events).toEqual([
      { type: 'text_delta', data: { text: 'hello' } },
      { type: 'reasoning_delta', data: { text: 'internal-summary' } },
      { type: 'tool_use_start', data: { id: 'toolu_123', name: 'calculator' } },
      { type: 'tool_use_delta', data: { arguments: '{"expr":"1+1"}' } },
      { type: 'tool_use_end', data: { id: 'toolu_123' } },
      {
        type: 'done',
        data: {
          model: 'claude-sonnet-4-6',
          usage: { input: 11, output: 7, cacheWrite: undefined, cacheRead: undefined },
          finishReason: 'tool_use',
        },
      },
    ])
  })

  test('complete uses adaptive thinking by default for Claude 4.6', async () => {
    const thinkingAdapter = new AnthropicAdapter({
      baseUrl: 'https://api.anthropic.com',
      auth: { type: 'api_key', apiKeyRef: 'anthropic' },
      modelConfig: {
        modelId: 'claude-sonnet-4-6',
        maxContext: 200000,
        maxOutput: 8192,
        capabilities: ['tools', 'vision'],
        tags: ['balanced'],
      },
      apiKey: 'dummy',
    })

    const calls: Array<Record<string, unknown>> = []
    getAnthropicHarness(thinkingAdapter).client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params)
          return {
            id: 'msg_123',
            content: [
              { type: 'thinking', thinking: 'internal summary', signature: 'sig_1' },
              { type: 'text', text: 'final answer' },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 11, output_tokens: 7 },
            model: 'claude-sonnet-4-6',
          }
        },
      },
    }

    const result = await thinkingAdapter.complete({
      messages: [makeMessage('user', 'test')],
      stream: false,
      maxTokens: 2048,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].thinking).toEqual({ type: 'adaptive' })
    expect(result.reasoningContent).toBe('internal summary')
  })

  test('complete ignores legacy thinkingTokens config and still uses adaptive thinking', async () => {
    const thinkingAdapter = new AnthropicAdapter({
      baseUrl: 'https://api.anthropic.com',
      auth: { type: 'api_key', apiKeyRef: 'anthropic' },
      modelConfig: {
        modelId: 'claude-sonnet-4-6',
        maxContext: 200000,
        maxOutput: 8192,
        thinkingTokens: 2048,
        capabilities: ['tools', 'vision'],
        tags: ['balanced'],
      },
      apiKey: 'dummy',
    })

    const calls: Array<Record<string, unknown>> = []
    getAnthropicHarness(thinkingAdapter).client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params)
          return {
            id: 'msg_124',
            content: [{ type: 'text', text: 'answer' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 11, output_tokens: 7 },
            model: 'claude-sonnet-4-6',
          }
        },
      },
    }

    await thinkingAdapter.complete({
      messages: [makeMessage('user', 'test')],
      stream: false,
      maxTokens: 4096,
    })

    expect(calls[0].thinking).toEqual({ type: 'adaptive' })
  })

  test('complete uses top-level automatic prompt caching', async () => {
    const cachingAdapter = createApiKeyAdapter()
    const calls: Array<Record<string, unknown>> = []
    getAnthropicHarness(cachingAdapter).client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params)
          return {
            id: 'msg_cache_001',
            content: [{ type: 'text', text: 'cached answer' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 11, output_tokens: 7 },
            model: 'claude-sonnet-4-6',
          }
        },
      },
    }

    await cachingAdapter.complete({
      messages: [makeMessage('user', 'test')],
      tools: [
        {
          name: 'read',
          description: 'Read files',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
        {
          name: 'bash',
          description: 'Run shell commands',
          parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
        },
      ],
      system: 'You are a cached assistant.',
      stream: false,
      maxTokens: 512,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(calls[0].system).toEqual([
      {
        type: 'text',
        text: 'You are a cached assistant.',
      },
    ])
    expect(calls[0].tools).toEqual([
      {
        name: 'read',
        description: 'Read files',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
      {
        name: 'bash',
        description: 'Run shell commands',
        input_schema: { type: 'object', properties: { cmd: { type: 'string' } } },
      },
    ])
  })

  test('stream reuses the same automatic prompt caching request shape', async () => {
    const cachingAdapter = createApiKeyAdapter()
    const calls: Array<Record<string, unknown>> = []
    getAnthropicHarness(cachingAdapter).client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params)
          return (async function* () {
            yield {
              type: 'message_start',
              message: {
                model: 'claude-sonnet-4-6',
                usage: { input_tokens: 11, output_tokens: 0 },
              },
            }
            yield {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 7 },
            }
            yield {
              type: 'message_stop',
            }
          })()
        },
      },
    }

    const events: Array<{ type: string; data: unknown }> = []
    for await (const event of cachingAdapter.stream({
      messages: [makeMessage('user', 'test')],
      tools: [
        {
          name: 'read',
          description: 'Read files',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
      system: 'You are a cached assistant.',
      stream: true,
      maxTokens: 512,
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      {
        type: 'done',
        data: {
          model: 'claude-sonnet-4-6',
          usage: { input: 11, output: 7, cacheWrite: undefined, cacheRead: undefined },
          finishReason: 'end_turn',
        },
      },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].stream).toBe(true)
    expect(calls[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(calls[0].system).toEqual([
      {
        type: 'text',
        text: 'You are a cached assistant.',
      },
    ])
    expect(calls[0].tools).toEqual([
      {
        name: 'read',
        description: 'Read files',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ])
  })

  test('applies automatic prompt caching even when system and tools are absent', async () => {
    const cachingAdapter = createApiKeyAdapter()
    const calls: Array<Record<string, unknown>> = []
    getAnthropicHarness(cachingAdapter).client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params)
          return {
            id: 'msg_cache_002',
            content: [{ type: 'text', text: 'plain answer' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 11, output_tokens: 7 },
            model: 'claude-sonnet-4-6',
          }
        },
      },
    }

    await cachingAdapter.complete({
      messages: [makeMessage('user', 'test')],
      stream: false,
      maxTokens: 512,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(calls[0].system).toBeUndefined()
    expect(calls[0].tools).toBeUndefined()
  })

  test('oauth requests prepend Claude Code identity to the system prompt', async () => {
    const oauthAdapter = new AnthropicAdapter({
      baseUrl: 'https://api.anthropic.com',
      auth: { type: 'oauth2', oauthTokenRef: 'CLAUDE_CODE_OAUTH_TOKEN' },
      modelConfig: {
        modelId: 'claude-sonnet-4-6',
        maxContext: 200000,
        maxOutput: 8192,
        capabilities: ['tools', 'vision'],
        tags: ['balanced'],
      },
      oauthToken: 'sk-ant-oat-test',
    })

    const calls: Array<Record<string, unknown>> = []
    getAnthropicHarness(oauthAdapter).client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params)
          return {
            id: 'msg_oauth_001',
            content: [{ type: 'text', text: 'hello' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 11, output_tokens: 7 },
            model: 'claude-sonnet-4-6',
          }
        },
      },
    }

    await oauthAdapter.complete({
      messages: [makeMessage('user', 'test')],
      system: 'You are a cached assistant.',
      stream: false,
      maxTokens: 512,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].system).toEqual([
      {
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
      {
        type: 'text',
        text: 'You are a cached assistant.',
      },
    ])
  })

  test('oauth requests refresh expiring sessions before sending Anthropic requests', async () => {
    const originalFetch = globalThis.fetch
    let currentSession = makeClaudeOAuthSessionJson('claude-stale-token', Date.now() + 2 * 60_000)
    const seenAuthHeaders: string[] = []
    let refreshCalls = 0

    const oauthAdapter = new AnthropicAdapter({
      baseUrl: 'https://api.anthropic.test',
      auth: { type: 'oauth2', oauthTokenRef: 'CLAUDE_CODE_OAUTH_TOKEN' },
      modelConfig: {
        modelId: 'claude-sonnet-4-6',
        maxContext: 200000,
        maxOutput: 8192,
        capabilities: ['tools', 'vision'],
        tags: ['balanced'],
      },
      oauthToken: currentSession,
      oauthTokenProvider: () => currentSession,
      oauthTokenRefresher: async () => {
        refreshCalls += 1
        currentSession = makeClaudeOAuthSessionJson(
          'claude-fresh-token',
          Date.now() + 30 * 60_000,
        )
      },
    })

    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers)
      seenAuthHeaders.push(headers.get('authorization') ?? '')
      return new Response(
        JSON.stringify({
          id: 'msg_refresh_001',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 9, output_tokens: 4 },
          model: 'claude-sonnet-4-6',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    }) as typeof fetch

    try {
      const response = await oauthAdapter.complete({
        messages: [makeMessage('user', 'refresh me')],
        stream: false,
      })

      expect(response.content[0]).toEqual({ type: 'text', text: 'ok' })
      expect(refreshCalls).toBe(1)
      expect(seenAuthHeaders).toEqual(['Bearer claude-fresh-token'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('oauth requests retry once after a 401 with refreshed credentials', async () => {
    const originalFetch = globalThis.fetch
    let currentSession = makeClaudeOAuthSessionJson(
      'claude-unauthorized-token',
      Date.now() + 30 * 60_000,
    )
    const seenAuthHeaders: string[] = []
    let refreshCalls = 0

    const oauthAdapter = new AnthropicAdapter({
      baseUrl: 'https://api.anthropic.test',
      auth: { type: 'oauth2', oauthTokenRef: 'CLAUDE_CODE_OAUTH_TOKEN' },
      modelConfig: {
        modelId: 'claude-sonnet-4-6',
        maxContext: 200000,
        maxOutput: 8192,
        capabilities: ['tools', 'vision'],
        tags: ['balanced'],
      },
      oauthToken: currentSession,
      oauthTokenProvider: () => currentSession,
      oauthTokenRefresher: async (reason) => {
        expect(reason).toBe('unauthorized')
        refreshCalls += 1
        currentSession = makeClaudeOAuthSessionJson('claude-retried-token', Date.now() + 3600_000)
      },
    })

    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers)
      const authorization = headers.get('authorization') ?? ''
      seenAuthHeaders.push(authorization)

      if (authorization === 'Bearer claude-unauthorized-token') {
        return new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'authentication_error',
              message: 'expired',
            },
          }),
          {
            status: 401,
            headers: { 'content-type': 'application/json' },
          },
        )
      }

      return new Response(
        JSON.stringify({
          id: 'msg_retry_001',
          content: [{ type: 'text', text: 'retried' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 7, output_tokens: 3 },
          model: 'claude-sonnet-4-6',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    }) as typeof fetch

    try {
      const response = await oauthAdapter.complete({
        messages: [makeMessage('user', 'retry me')],
        stream: false,
      })

      expect(response.content[0]).toEqual({ type: 'text', text: 'retried' })
      expect(refreshCalls).toBe(1)
      expect(seenAuthHeaders).toEqual([
        'Bearer claude-unauthorized-token',
        'Bearer claude-retried-token',
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('oauth requests refresh already-expired sessions before failing reauth', async () => {
    const originalFetch = globalThis.fetch
    let currentSession = makeClaudeOAuthSessionJson('claude-expired-token', Date.now() - 5_000)
    const seenAuthHeaders: string[] = []
    let refreshCalls = 0

    const oauthAdapter = new AnthropicAdapter({
      baseUrl: 'https://api.anthropic.test',
      auth: { type: 'oauth2', oauthTokenRef: 'CLAUDE_CODE_OAUTH_TOKEN' },
      modelConfig: {
        modelId: 'claude-sonnet-4-6',
        maxContext: 200000,
        maxOutput: 8192,
        capabilities: ['tools', 'vision'],
        tags: ['balanced'],
      },
      oauthToken: currentSession,
      oauthTokenProvider: () => currentSession,
      oauthTokenRefresher: async (reason) => {
        expect(reason).toBe('expiring')
        refreshCalls += 1
        currentSession = makeClaudeOAuthSessionJson(
          'claude-after-expired-refresh',
          Date.now() + 30 * 60_000,
        )
      },
    })

    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers)
      seenAuthHeaders.push(headers.get('authorization') ?? '')
      return new Response(
        JSON.stringify({
          id: 'msg_expired_refresh_001',
          content: [{ type: 'text', text: 'expired-ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 9, output_tokens: 5 },
          model: 'claude-sonnet-4-6',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    }) as typeof fetch

    try {
      const response = await oauthAdapter.complete({
        messages: [makeMessage('user', 'expired refresh')],
        stream: false,
      })

      expect(response.content[0]).toEqual({ type: 'text', text: 'expired-ok' })
      expect(refreshCalls).toBe(1)
      expect(seenAuthHeaders).toEqual(['Bearer claude-after-expired-refresh'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// Real API tests — only run when ANTHROPIC_API_KEY env var is set
describe.skipIf(!HAS_KEY)('Anthropic Adapter (Real API)', () => {
  test('complete returns a valid response', async () => {
    const response = await adapter.complete({
      messages: [makeMessage('user', 'Say "hello world" and nothing else.')],
      stream: false,
      maxTokens: 50,
    })

    expect(response.id).toBeDefined()
    expect(response.content.length).toBeGreaterThan(0)
    expect(response.content[0].type).toBe('text')
    expect(response.stopReason).toBeDefined()
    expect(response.usage.input).toBeGreaterThan(0)
    expect(response.usage.output).toBeGreaterThan(0)
  }, 30000)

  test('healthCheck returns true for valid endpoint', async () => {
    const healthy = await adapter.healthCheck()
    expect(healthy).toBe(true)
  }, 30000)
})
