import { describe, expect, test } from 'bun:test'
import type { CompletionRequest, CompletionResponse, Message, TokenUsage } from '@zero-os/shared'
import { generateId, now } from '@zero-os/shared'
import type OpenAI from 'openai'
import { OpenAIResponsesAdapter } from '../adapters/openai-resp'

const adapter = new OpenAIResponsesAdapter({
  baseUrl: 'https://api.example.com',
  auth: { type: 'api_key', apiKeyRef: 'test' },
  modelConfig: {
    modelId: 'test-model',
    maxContext: 128000,
    maxOutput: 8192,
    capabilities: [],
    tags: [],
  },
  apiKey: 'dummy',
})

type ResponseInputItemLike = {
  type?: string
  role?: string
  content?: unknown
  call_id?: string
  output?: string
  name?: string
  arguments?: string
  id?: string
}

type ChatGptBodyLike = {
  instructions?: string
  reasoning?: unknown
  max_output_tokens?: number
  stream?: boolean
  model?: string
}

type ResponseUsageLike = {
  input_tokens?: number
  input_tokens_details?: {
    cached_tokens?: number
    cached_tokens_details?: {
      cache_creation_input_tokens?: number
    }
  }
  output_tokens?: number
  output_tokens_details?: {
    reasoning_tokens?: number
  }
}

interface OpenAIResponsesAdapterTestHarness {
  buildInput(req: CompletionRequest): OpenAI.Responses.ResponseInputItem[]
  convertTools(tools: CompletionRequest['tools']): OpenAI.Responses.Tool[] | undefined
  buildChatGptBody(req: CompletionRequest): ChatGptBodyLike
  parseResponse(response: OpenAI.Responses.Response): CompletionResponse
  parseUsage(usage?: ResponseUsageLike): TokenUsage
  parseChatGptCompletion(events: ChatGptSseEventLike[]): CompletionResponse
}

type ChatGptSseEventLike = {
  type?: string
  item?: Record<string, unknown>
  response?: Record<string, unknown>
  item_id?: string
  summary_index?: number
  delta?: string
}

function getResponsesHarness(instance: OpenAIResponsesAdapter): OpenAIResponsesAdapterTestHarness {
  return instance as unknown as OpenAIResponsesAdapterTestHarness
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

function makeJwt(payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

function makeChatGptSessionJson(accountId: string, expMs: number, accessTokenLabel?: string) {
  const expSeconds = Math.floor(expMs / 1000)
  return JSON.stringify({
    accessToken:
      accessTokenLabel ??
      makeJwt({
        exp: expSeconds,
        'https://api.openai.com/auth': {
          chatgpt_account_id: accountId,
        },
      }),
    refreshToken: 'refresh-token',
    expiresAt: expMs,
    tokenType: 'Bearer',
    accountId,
  })
}

describe('OpenAI Responses API Adapter (Pure Logic)', () => {
  test('buildInput: system prompt becomes system role message', () => {
    const req: CompletionRequest = {
      messages: [makeMessage('user', 'Hello')],
      system: 'You are a helpful assistant.',
      stream: false,
    }

    const input = getResponsesHarness(adapter).buildInput(req) as ResponseInputItemLike[]

    expect(input[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' })
    expect(input[1]).toEqual({ role: 'user', content: 'Hello' })
  })

  test('buildInput: user messages correctly mapped', () => {
    const req: CompletionRequest = {
      messages: [
        makeMessage('user', 'First message'),
        makeMessage('assistant', 'Response'),
        makeMessage('user', 'Second message'),
      ],
      stream: false,
    }

    const input = getResponsesHarness(adapter).buildInput(req) as ResponseInputItemLike[]

    expect(input[0]).toEqual({ role: 'user', content: 'First message' })
    expect(input[1]).toEqual({ role: 'assistant', content: 'Response' })
    expect(input[2]).toEqual({ role: 'user', content: 'Second message' })
  })

  test('buildInput: tool_result blocks become function_call_output', () => {
    const toolCallId = `call_${generateId()}`
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

    const input = getResponsesHarness(adapter).buildInput({
      messages,
      stream: false,
    } as CompletionRequest) as ResponseInputItemLike[]

    // user text, function_call (from assistant), function_call_output (from tool_result)
    expect(input[0]).toEqual({ role: 'user', content: 'What is 2 + 2?' })
    expect(input[1]).toMatchObject({
      type: 'function_call',
      call_id: toolCallId,
      name: 'calculator',
      arguments: JSON.stringify({ expression: '2 + 2' }),
    })
    expect(input[2]).toEqual({
      type: 'function_call_output',
      call_id: toolCallId,
      output: '4',
    })
  })

  test('buildInput: empty tool_result output falls back to outputSummary', () => {
    const toolCallId = `call_${generateId()}`
    const messages: Message[] = [
      makeMessage('user', 'Run command'),
      {
        id: generateId(),
        sessionId: 'test',
        role: 'assistant',
        messageType: 'message',
        content: [
          {
            type: 'tool_use',
            id: toolCallId,
            name: 'bash',
            input: { command: 'find . -name AGENTS.md' },
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
            content: '',
            outputSummary: 'Executed: find . -name AGENTS.md',
          },
        ],
        createdAt: now(),
      },
    ]

    const input = getResponsesHarness(adapter).buildInput({
      messages,
      stream: false,
    } as CompletionRequest) as ResponseInputItemLike[]

    expect(input[2]).toEqual({
      type: 'function_call_output',
      call_id: toolCallId,
      output: 'Executed: find . -name AGENTS.md',
    })
  })

  test('buildInput: only paired tool_use and tool_result are serialized', () => {
    const pairedId = `call_${generateId()}`
    const danglingToolUseId = `call_${generateId()}`
    const orphanToolResultId = `call_${generateId()}`

    const messages: Message[] = [
      makeMessage('user', 'Start'),
      {
        id: generateId(),
        sessionId: 'test',
        role: 'assistant',
        messageType: 'message',
        content: [
          {
            type: 'tool_use',
            id: pairedId,
            name: 'read',
            input: { path: '/tmp/a.txt' },
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
            toolUseId: pairedId,
            content: 'ok',
          },
        ],
        createdAt: now(),
      },
      {
        id: generateId(),
        sessionId: 'test',
        role: 'assistant',
        messageType: 'message',
        content: [
          {
            type: 'tool_use',
            id: danglingToolUseId,
            name: 'bash',
            input: { command: 'echo hi' },
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
            toolUseId: orphanToolResultId,
            content: 'orphan-result',
          },
        ],
        createdAt: now(),
      },
      makeMessage('user', 'Continue'),
    ]

    const input = getResponsesHarness(adapter).buildInput({
      messages,
      stream: false,
    } as CompletionRequest) as ResponseInputItemLike[]
    const functionCalls = input.filter((i) => i.type === 'function_call')
    const functionCallOutputs = input.filter((i) => i.type === 'function_call_output')

    expect(functionCalls.length).toBe(1)
    expect(functionCalls[0].call_id).toBe(pairedId)

    expect(functionCallOutputs.length).toBe(1)
    expect(functionCallOutputs[0].call_id).toBe(pairedId)
    expect(functionCallOutputs[0].output).toBe('ok')
  })

  test('convertTools: maps to function type with parameters', () => {
    const tools = [
      {
        name: 'search',
        description: 'Search the web.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
    ]

    const converted = getResponsesHarness(adapter).convertTools(tools)

    expect(converted).toEqual([
      {
        type: 'function',
        name: 'search',
        description: 'Search the web.',
        strict: null,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
    ])
  })

  test('buildChatGptBody falls back to default instructions for ChatGPT', () => {
    const chatgptAdapter = new OpenAIResponsesAdapter({
      providerName: 'chatgpt',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      auth: { type: 'oauth2', oauthTokenRef: 'chatgpt_oauth_token' },
      modelConfig: {
        modelId: 'gpt-5.4',
        maxContext: 128000,
        maxOutput: 8192,
        capabilities: [],
        tags: [],
      },
      oauthToken: JSON.stringify({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 180_000,
        tokenType: 'Bearer',
        accountId: 'acct_123',
      }),
    })

    const body = getResponsesHarness(chatgptAdapter).buildChatGptBody({
      messages: [],
      stream: true,
    })

    expect(body.instructions).toBe('You are a helpful assistant.')
    expect(body.reasoning).toEqual({ summary: 'auto' })
  })

  test('buildChatGptBody omits unsupported max_output_tokens', () => {
    const chatgptAdapter = new OpenAIResponsesAdapter({
      providerName: 'chatgpt',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      auth: { type: 'oauth2', oauthTokenRef: 'chatgpt_oauth_token' },
      modelConfig: {
        modelId: 'gpt-5.4',
        maxContext: 128000,
        maxOutput: 8192,
        capabilities: [],
        tags: [],
      },
      oauthToken: JSON.stringify({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 180_000,
        tokenType: 'Bearer',
        accountId: 'acct_123',
      }),
    })

    const body = getResponsesHarness(chatgptAdapter).buildChatGptBody({
      messages: [],
      stream: true,
      maxTokens: 123,
    })

    expect(body.max_output_tokens).toBeUndefined()
    expect(body.stream).toBe(true)
    expect(body.model).toBe('gpt-5.4')
  })

  test('parseResponse: text output parsed correctly', () => {
    const mockResponse = {
      id: 'resp_123',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] },
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'Checked the request before answering.' }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: 'test-model',
      status: 'completed',
    }

    const result = getResponsesHarness(adapter).parseResponse(
      mockResponse as unknown as OpenAI.Responses.Response,
    )

    expect(result.id).toBe('resp_123')
    expect(result.content).toEqual([{ type: 'text', text: 'Hello world' }])
    expect(result.stopReason).toBe('end_turn')
    expect(result.model).toBe('test-model')
    expect(result.usage.input).toBe(10)
    expect(result.usage.output).toBe(5)
    expect(result.reasoningContent).toBe('Checked the request before answering.')
  })

  test('parseUsage: token counts extracted correctly', () => {
    const usage = {
      input_tokens: 100,
      input_tokens_details: {
        cached_tokens: 30,
        cached_tokens_details: {
          cache_creation_input_tokens: 20,
        },
      },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 10 },
    }

    const result = getResponsesHarness(adapter).parseUsage(usage)

    expect(result.input).toBe(50)
    expect(result.output).toBe(50)
    expect(result.cacheWrite).toBe(20)
    expect(result.cacheRead).toBe(30)
    expect(result.reasoning).toBe(10)
  })

  test('parseChatGptCompletion preserves composite call_id|fc_id as tool_use id', () => {
    const result = getResponsesHarness(adapter).parseChatGptCompletion([
      {
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          id: 'fc_item_1',
          call_id: 'call_123',
          name: 'read',
          arguments: '{"path":"a.txt"}',
        },
      },
      {
        type: 'response.completed',
        response: { id: 'resp_1', model: 'test-model', status: 'completed', usage: {} },
      },
    ])

    expect(result.content).toContainEqual({
      type: 'tool_use',
      id: 'call_123|fc_item_1',
      name: 'read',
      input: { path: 'a.txt' },
    })
  })

  test('parseChatGptCompletion extracts reasoning summary text', () => {
    const result = getResponsesHarness(adapter).parseChatGptCompletion([
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        summary_index: 0,
        delta: 'First half. ',
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        summary_index: 0,
        delta: 'Second half.',
      },
      {
        type: 'response.completed',
        response: { id: 'resp_2', model: 'test-model', status: 'completed', usage: {} },
      },
    ])

    expect(result.reasoningContent).toBe('First half. Second half.')
  })

  test('streamFromChatGpt emits call_id on tool deltas', async () => {
    const chatgptAdapter = new OpenAIResponsesAdapter({
      providerName: 'chatgpt',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      auth: { type: 'oauth2', oauthTokenRef: 'chatgpt_oauth_token' },
      modelConfig: {
        modelId: 'gpt-5.4',
        maxContext: 128000,
        maxOutput: 8192,
        capabilities: [],
        tags: [],
      },
      oauthToken: JSON.stringify({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 180_000,
        tokenType: 'Bearer',
        accountId: 'acct_123',
      }),
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        [
          'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_123","name":"read","arguments":""}}',
          '',
          'data: {"type":"response.function_call_arguments.delta","call_id":"call_123","delta":"chunk-1"}',
          '',
          'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","summary_index":0,"delta":"considering"}',
          '',
          'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_123"}}',
          '',
          'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4","status":"completed","usage":{}}}',
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )) as unknown as typeof fetch

    try {
      const events: Array<{ type: string; data: unknown }> = []
      for await (const event of chatgptAdapter.stream({ messages: [], stream: true })) {
        events.push(event)
      }

      expect(events).toContainEqual({
        type: 'tool_use_start',
        data: { id: 'call_123', name: 'read' },
      })
      expect(events).toContainEqual({
        type: 'tool_use_delta',
        data: { id: 'call_123', arguments: 'chunk-1' },
      })
      expect(events).toContainEqual({ type: 'reasoning_delta', data: { text: 'considering' } })
      expect(events).toContainEqual({ type: 'tool_use_end', data: { id: 'call_123' } })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('ChatGPT requests refresh expiring tokens before sending the request', async () => {
    let currentSession = makeChatGptSessionJson(
      'acct_old',
      Date.now() + 5 * 60 * 1000,
      'old-token',
    )
    let refreshCalls = 0
    const headersSeen: string[] = []

    const chatgptAdapter = new OpenAIResponsesAdapter({
      providerName: 'chatgpt',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      auth: { type: 'oauth2', oauthTokenRef: 'chatgpt_oauth_token' },
      modelConfig: {
        modelId: 'gpt-5.4',
        maxContext: 128000,
        maxOutput: 8192,
        capabilities: [],
        tags: [],
      },
      oauthTokenProvider: () => currentSession,
      oauthTokenRefresher: async () => {
        refreshCalls += 1
        currentSession = makeChatGptSessionJson(
          'acct_new',
          Date.now() + 2 * 60 * 60 * 1000,
          'new-token',
        )
      },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headersSeen.push((init?.headers as Record<string, string>).Authorization)
      return new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"ok"}',
          '',
          'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4","status":"completed","usage":{}}}',
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as unknown as typeof fetch

    try {
      const response = await chatgptAdapter.complete({ messages: [], stream: false })
      expect(refreshCalls).toBe(1)
      expect(headersSeen).toEqual(['Bearer new-token'])
      expect(response.content).toEqual([{ type: 'text', text: 'ok' }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('ChatGPT requests retry once after a 401 with refreshed credentials', async () => {
    let currentSession = makeChatGptSessionJson(
      'acct_old',
      Date.now() + 2 * 60 * 60 * 1000,
      'old-token',
    )
    let refreshCalls = 0
    const headersSeen: string[] = []
    let requestCount = 0

    const chatgptAdapter = new OpenAIResponsesAdapter({
      providerName: 'chatgpt',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      auth: { type: 'oauth2', oauthTokenRef: 'chatgpt_oauth_token' },
      modelConfig: {
        modelId: 'gpt-5.4',
        maxContext: 128000,
        maxOutput: 8192,
        capabilities: [],
        tags: [],
      },
      oauthTokenProvider: () => currentSession,
      oauthTokenRefresher: async () => {
        refreshCalls += 1
        currentSession = makeChatGptSessionJson(
          'acct_new',
          Date.now() + 2 * 60 * 60 * 1000,
          'new-token',
        )
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
        [
          'data: {"type":"response.output_text.delta","delta":"retried"}',
          '',
          'data: {"type":"response.completed","response":{"id":"resp_2","model":"gpt-5.4","status":"completed","usage":{}}}',
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as unknown as typeof fetch

    try {
      const response = await chatgptAdapter.complete({ messages: [], stream: false })
      expect(refreshCalls).toBe(1)
      expect(requestCount).toBe(2)
      expect(headersSeen[0]).toBe('Bearer old-token')
      expect(headersSeen[1]).toBe('Bearer new-token')
      expect(response.content).toEqual([{ type: 'text', text: 'retried' }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
