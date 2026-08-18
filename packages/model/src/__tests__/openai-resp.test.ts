import { describe, expect, test } from 'bun:test'
import type { CompletionRequest, Message } from '@zero-os/shared'
import { generateId, now } from '@zero-os/shared'
import type OpenAI from 'openai'
import { OpenAIResponsesAdapter } from '../adapters/openai-resp'
import { parseChatGptCompletionEvents } from '../adapters/openai-resp-chatgpt-events'
import {
  buildOpenAIResponsesInput,
  convertOpenAIResponsesTools,
} from '../adapters/openai-resp-input'
import { parseOpenAIResponse } from '../adapters/openai-resp-parse'
import { parseOpenAIResponseUsage } from '../adapters/openai-resp-parse'

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

interface OpenAIResponsesAdapterTestHarness {
  buildChatGptBody(req: CompletionRequest): ChatGptBodyLike
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

function makeChatGptSessionJson(
  accountId: string,
  expMs: number,
  accessTokenLabel?: string,
  tokenType = 'Bearer',
) {
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
    tokenType,
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

    const input = buildOpenAIResponsesInput(req) as ResponseInputItemLike[]

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

    const input = buildOpenAIResponsesInput(req) as ResponseInputItemLike[]

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

    const input = buildOpenAIResponsesInput({
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

  test('buildInput: omits internal evidence metadata from provider payload', () => {
    const toolCallId = `call_${generateId()}`
    const messages: Message[] = [
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
            evidence: {
              kind: 'tool_use_input',
              sessionId: 'test',
              toolUseId: toolCallId,
              toolName: 'calculator',
              path: '/repo/.artifacts/test/tool-evidence/input.json',
              chars: 20,
              bytes: 20,
              sha256: 'input-sha',
              createdAt: now(),
            },
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
            evidence: {
              kind: 'tool_result_output',
              sessionId: 'test',
              toolUseId: toolCallId,
              toolName: 'calculator',
              path: '/repo/.artifacts/test/tool-evidence/output.txt',
              chars: 1,
              bytes: 1,
              sha256: 'output-sha',
              createdAt: now(),
            },
          },
        ],
        createdAt: now(),
      },
    ]

    const input = buildOpenAIResponsesInput({
      messages,
      stream: false,
    } as CompletionRequest)
    const payload = JSON.stringify(input)

    expect(payload).not.toContain('evidence')
    expect(payload).not.toContain('.artifacts')
    expect(payload).not.toContain('output-sha')
    expect(payload).toContain('expression')
    expect(payload).toContain('4')
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

    const input = buildOpenAIResponsesInput({
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

    const input = buildOpenAIResponsesInput({
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

    const converted = convertOpenAIResponsesTools(tools)

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

  test('buildChatGptBody includes request reasoning effort when set', () => {
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
      reasoningEffort: 'xhigh',
    })

    expect(body.reasoning).toEqual({ summary: 'auto', effort: 'xhigh' })
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

    const result = parseOpenAIResponse(
      mockResponse as unknown as OpenAI.Responses.Response,
      'test-model',
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

    const result = parseOpenAIResponseUsage(usage)

    expect(result.input).toBe(50)
    expect(result.output).toBe(50)
    expect(result.cacheWrite).toBe(20)
    expect(result.cacheRead).toBe(30)
    expect(result.reasoning).toBe(10)
  })

  test('parseChatGptCompletion preserves composite call_id|fc_id as tool_use id', () => {
    const result = parseChatGptCompletionEvents(
      [
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
      ],
      'test-model',
    )

    expect(result.content).toContainEqual({
      type: 'tool_use',
      id: 'call_123|fc_item_1',
      name: 'read',
      input: { path: 'a.txt' },
    })
  })

  test('parseChatGptCompletion extracts reasoning summary text', () => {
    const result = parseChatGptCompletionEvents(
      [
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
      ],
      'test-model',
    )

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
      'bearer',
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
      'bearer',
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

  test('ChatGPT retries transient 5xx responses with backoff and eventually succeeds', async () => {
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
      oauthToken: makeChatGptSessionJson(
        'acct_123',
        Date.now() + 2 * 60 * 60 * 1000,
        'access-token',
      ),
      chatGptRetry: { maxAttempts: 4, baseDelayMs: 1 },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      requestCount += 1
      if (requestCount <= 2) {
        return new Response('Our servers are currently overloaded.', { status: 503 })
      }
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
      expect(requestCount).toBe(3)
      expect(response.content).toEqual([{ type: 'text', text: 'ok' }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('ChatGPT gives up after exhausting 5xx retry attempts', async () => {
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
      oauthToken: makeChatGptSessionJson(
        'acct_123',
        Date.now() + 2 * 60 * 60 * 1000,
        'access-token',
      ),
      chatGptRetry: { maxAttempts: 3, baseDelayMs: 1 },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      requestCount += 1
      return new Response('Our servers are currently overloaded.', { status: 503 })
    }) as unknown as typeof fetch

    try {
      let caught: unknown
      try {
        await chatgptAdapter.complete({ messages: [], stream: false })
      } catch (error) {
        caught = error
      }

      expect(requestCount).toBe(3)
      expect(caught).toMatchObject({
        status: 503,
        retryable: true,
        error_type: 'http_error',
        failure_scope: 'provider',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('ChatGPT does not retry 429 responses so the pool can fail over', async () => {
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
      oauthToken: makeChatGptSessionJson(
        'acct_123',
        Date.now() + 2 * 60 * 60 * 1000,
        'access-token',
      ),
      chatGptRetry: { maxAttempts: 4, baseDelayMs: 1 },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      requestCount += 1
      return new Response('rate limit', { status: 429 })
    }) as unknown as typeof fetch

    try {
      let caught: unknown
      try {
        await chatgptAdapter.complete({ messages: [], stream: false })
      } catch (error) {
        caught = error
      }

      expect(requestCount).toBe(1)
      expect(caught).toMatchObject({ status: 429 })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('ChatGPT retries SSE response.failed server_is_overloaded failures', async () => {
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
      oauthToken: makeChatGptSessionJson(
        'acct_123',
        Date.now() + 2 * 60 * 60 * 1000,
        'access-token',
      ),
      chatGptRetry: { maxAttempts: 4, baseDelayMs: 1 },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      requestCount += 1
      if (requestCount <= 2) {
        return new Response(
          'data: {"type":"response.failed","response":{"id":"resp_busy","error":{"code":"server_is_overloaded","message":"Our servers are currently overloaded. Please try again later."}}}\n\n',
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        )
      }
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
      expect(requestCount).toBe(3)
      expect(response.content).toEqual([{ type: 'text', text: 'ok' }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('ChatGPT requests idle-time out and abort when fetch never settles', async () => {
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
      oauthToken: makeChatGptSessionJson(
        'acct_123',
        Date.now() + 2 * 60 * 60 * 1000,
        'access-token',
      ),
      chatGptStreamIdleTimeoutMs: 20,
      chatGptRetry: { maxAttempts: 1 },
    })

    const originalFetch = globalThis.fetch
    const requestState: { signal?: AbortSignal } = {}
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestState.signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('request aborted')))
      })
    }) as unknown as typeof fetch

    try {
      let caught: unknown
      try {
        await chatgptAdapter.complete({ messages: [], stream: false })
      } catch (error) {
        caught = error
      }

      expect(caught).toMatchObject({
        message: 'ChatGPT request idle timed out after 20ms',
        retryable: true,
        error_type: 'stream_idle_timeout',
        failure_scope: 'transport',
      })
      expect(requestState.signal?.aborted).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('ChatGPT normalizes raw request aborts before response headers', async () => {
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
      oauthToken: makeChatGptSessionJson(
        'acct_123',
        Date.now() + 2 * 60 * 60 * 1000,
        'access-token',
      ),
      chatGptRetry: { maxAttempts: 1 },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw Object.assign(new Error('The operation was aborted.'), { code: 'ABORT_ERR' })
    }) as unknown as typeof fetch

    try {
      let caught: unknown
      try {
        await chatgptAdapter.complete({ messages: [], stream: false })
      } catch (error) {
        caught = error
      }

      expect(caught).toMatchObject({
        message: 'ChatGPT request transport failed: The operation was aborted.',
        retryable: true,
        error_type: 'request_transport_error',
        failure_scope: 'transport',
        code: 'ABORT_ERR',
      })
      expect((caught as Error).cause).toBeInstanceOf(Error)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('ChatGPT normalizes raw response body aborts as retryable transport errors', async () => {
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
      oauthToken: makeChatGptSessionJson(
        'acct_123',
        Date.now() + 2 * 60 * 60 * 1000,
        'access-token',
      ),
      chatGptRetry: { maxAttempts: 1 },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(
              Object.assign(new Error('The operation was aborted.'), { code: 'ABORT_ERR' }),
            )
          },
        }),
        { status: 503 },
      )) as unknown as typeof fetch

    try {
      let caught: unknown
      try {
        await chatgptAdapter.complete({ messages: [], stream: false })
      } catch (error) {
        caught = error
      }

      expect(caught).toMatchObject({
        message: 'ChatGPT response body transport failed: The operation was aborted.',
        retryable: true,
        error_type: 'response_body_transport_error',
        failure_scope: 'transport',
        code: 'ABORT_ERR',
      })
      expect((caught as Error).cause).toBeInstanceOf(Error)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('ChatGPT requests idle-time out when the SSE response body never settles', async () => {
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
      oauthToken: makeChatGptSessionJson(
        'acct_123',
        Date.now() + 2 * 60 * 60 * 1000,
        'access-token',
      ),
      chatGptStreamIdleTimeoutMs: 20,
      chatGptRetry: { baseDelayMs: 1 },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          pull: () => new Promise<void>(() => {}),
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )) as unknown as typeof fetch

    try {
      let caught: unknown
      try {
        await chatgptAdapter.complete({ messages: [], stream: false })
      } catch (error) {
        caught = error
      }

      expect(caught).toMatchObject({
        message: 'ChatGPT response stream idle timed out after 20ms',
        retryable: true,
        error_type: 'stream_idle_timeout',
        failure_scope: 'transport',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('ChatGPT normalizes raw SSE reader aborts as retryable transport errors', async () => {
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
      oauthToken: makeChatGptSessionJson(
        'acct_123',
        Date.now() + 2 * 60 * 60 * 1000,
        'access-token',
      ),
      chatGptRetry: { baseDelayMs: 1 },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(
              Object.assign(new Error('The operation was aborted.'), { code: 'ABORT_ERR' }),
            )
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )) as unknown as typeof fetch

    try {
      let caught: unknown
      try {
        await chatgptAdapter.complete({ messages: [], stream: false })
      } catch (error) {
        caught = error
      }

      expect(caught).toMatchObject({
        message: 'ChatGPT response stream transport failed: The operation was aborted.',
        retryable: true,
        error_type: 'response_stream_transport_error',
        failure_scope: 'transport',
        code: 'ABORT_ERR',
      })
      expect((caught as Error).cause).toBeInstanceOf(Error)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('ChatGPT completes when response.completed arrives before the SSE body closes', async () => {
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
      oauthToken: makeChatGptSessionJson(
        'acct_123',
        Date.now() + 2 * 60 * 60 * 1000,
        'access-token',
      ),
      chatGptStreamIdleTimeoutMs: 100,
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  'data: {"type":"response.output_text.delta","delta":"done"}',
                  '',
                  'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4","status":"completed","usage":{}}}',
                  '',
                  '',
                ].join('\n'),
              ),
            )
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as unknown as typeof fetch

    try {
      const response = await chatgptAdapter.complete({ messages: [], stream: false })
      expect(response.content).toEqual([{ type: 'text', text: 'done' }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('ChatGPT resets the idle timeout after each SSE event', async () => {
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
      oauthToken: makeChatGptSessionJson(
        'acct_123',
        Date.now() + 2 * 60 * 60 * 1000,
        'access-token',
      ),
      chatGptStreamIdleTimeoutMs: 100,
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"type":"response.created"}\n\n'))
            setTimeout(() => {
              controller.enqueue(
                encoder.encode(
                  'data: {"type":"response.output_text.delta","delta":"still working"}\n\n',
                ),
              )
            }, 60)
            setTimeout(() => {
              controller.enqueue(
                encoder.encode(
                  'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4","status":"completed","usage":{}}}\n\n',
                ),
              )
            }, 120)
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )
    }) as unknown as typeof fetch

    try {
      const response = await chatgptAdapter.complete({ messages: [], stream: false })
      expect(response.content).toEqual([{ type: 'text', text: 'still working' }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('ChatGPT rejects an SSE stream that closes before response.completed', async () => {
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
      oauthToken: makeChatGptSessionJson(
        'acct_123',
        Date.now() + 2 * 60 * 60 * 1000,
        'access-token',
      ),
      chatGptRetry: { baseDelayMs: 1 },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })) as unknown as typeof fetch

    try {
      await expect(chatgptAdapter.complete({ messages: [], stream: false })).rejects.toThrow(
        'ChatGPT response stream closed before response.completed',
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('ChatGPT surfaces response.incomplete instead of treating it as an empty completion', async () => {
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
      oauthToken: makeChatGptSessionJson(
        'acct_123',
        Date.now() + 2 * 60 * 60 * 1000,
        'access-token',
      ),
      chatGptRetry: { baseDelayMs: 1 },
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )) as unknown as typeof fetch

    try {
      let caught: unknown
      try {
        await chatgptAdapter.complete({ messages: [], stream: false })
      } catch (error) {
        caught = error
      }

      expect(caught).toMatchObject({
        message: 'ChatGPT response incomplete: max_output_tokens',
        retryable: true,
        error_type: 'response_incomplete',
        failure_scope: 'request',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('ChatGPT surfaces response.failed with its retry classification', async () => {
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
      oauthToken: makeChatGptSessionJson(
        'acct_123',
        Date.now() + 2 * 60 * 60 * 1000,
        'access-token',
      ),
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        'data: {"type":"response.failed","response":{"id":"resp_failed","error":{"code":"invalid_prompt","message":"request rejected"}}}\n\n',
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )) as unknown as typeof fetch

    try {
      let caught: unknown
      try {
        await chatgptAdapter.complete({ messages: [], stream: false })
      } catch (error) {
        caught = error
      }

      expect(caught).toMatchObject({
        message: 'ChatGPT response failed: request rejected',
        retryable: false,
        request_id: 'resp_failed',
        error_type: 'invalid_prompt',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('ChatGPT accepts response.completed with no assistant content', async () => {
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
      oauthToken: makeChatGptSessionJson(
        'acct_123',
        Date.now() + 2 * 60 * 60 * 1000,
        'access-token',
      ),
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        'data: {"type":"response.completed","response":{"id":"resp_empty","model":"gpt-5.4","status":"completed","usage":{}}}\n\n',
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )) as unknown as typeof fetch

    try {
      const response = await chatgptAdapter.complete({ messages: [], stream: false })
      expect(response.content).toEqual([])
      expect(response.stopReason).toBe('end_turn')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
