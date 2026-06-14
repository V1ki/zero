import { describe, expect, test } from 'bun:test'
import type { CompletionRequest, Message, SystemConfig } from '@zero-os/shared'
import { generateId, now } from '@zero-os/shared'
import { AnthropicAdapter } from '../adapters/anthropic'
import { convertAnthropicMessages } from '../adapters/anthropic'
import { OpenAIChatAdapter } from '../adapters/openai-chat'
import { convertOpenAIChatMessages } from '../adapters/openai-chat'
import { OpenAIResponsesAdapter } from '../adapters/openai-resp'
import { buildOpenAIResponsesInput } from '../adapters/openai-resp-input'
import { ModelRouter } from '../router'
import { collectStream } from '../stream'

type AnthropicMessageLike = {
  role: string
  content: Array<Record<string, unknown>>
}

type ChatMessageLike = {
  role: string
  content?: string | null
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: string
    function: {
      name: string
      arguments: string
    }
  }>
}

type ResponsesInputItemLike = {
  type?: string
  role?: string
  content?: unknown
  call_id?: string
  id?: string
  name?: string
  arguments?: string
  output?: string
}

interface AnthropicAdapterTestHarness {
  client: {
    messages: {
      create: (params: Record<string, unknown>) => Promise<unknown>
    }
  }
}

interface OpenAIChatAdapterTestHarness {
  client: {
    chat: {
      completions: {
        create: (params: Record<string, unknown>) => Promise<unknown>
      }
    }
  }
}

function getAnthropicHarness(instance: AnthropicAdapter): AnthropicAdapterTestHarness {
  return instance as unknown as AnthropicAdapterTestHarness
}

function convertAnthropic(req: CompletionRequest): AnthropicMessageLike[] {
  return convertAnthropicMessages(req) as unknown as AnthropicMessageLike[]
}

function getOpenAIChatHarness(instance: OpenAIChatAdapter): OpenAIChatAdapterTestHarness {
  return instance as unknown as OpenAIChatAdapterTestHarness
}

function convertOpenAIChat(req: CompletionRequest): ChatMessageLike[] {
  return convertOpenAIChatMessages(req) as unknown as ChatMessageLike[]
}

function makeMessage(role: 'user' | 'assistant', text: string): Message {
  return {
    id: generateId(),
    sessionId: 'cross-provider-test',
    role,
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt: now(),
  }
}

function makeRichMessage(
  role: 'user' | 'assistant',
  content: Message['content'],
  model?: string,
): Message {
  return {
    id: generateId(),
    sessionId: 'cross-provider-test',
    role,
    messageType: 'message',
    content,
    model,
    createdAt: now(),
  }
}

function makeToolConversation(toolId: string): Message[] {
  return [
    makeMessage('user', 'Read the workspace instructions.'),
    makeRichMessage(
      'assistant',
      [
        { type: 'text', text: 'I will inspect the repo first.' },
        {
          type: 'tool_use',
          id: toolId,
          name: 'read_file',
          input: { path: '/Users/v1ki/Desktop/test4_zero/AGENTS.md' },
        },
      ],
      'test-model',
    ),
    makeRichMessage('user', [
      {
        type: 'tool_result',
        toolUseId: toolId,
        content: 'AGENTS.md contents',
      },
    ]),
    makeMessage('assistant', 'I found the instructions and can continue.'),
  ]
}

function makeRequest(messages: Message[]): CompletionRequest {
  return {
    messages,
    stream: false,
  }
}

function createAnthropicAdapter(): AnthropicAdapter {
  return new AnthropicAdapter({
    baseUrl: 'https://api.anthropic.test',
    auth: { type: 'api_key', apiKeyRef: 'anthropic_key' },
    modelConfig: {
      modelId: 'claude-sonnet-test',
      maxContext: 200000,
      maxOutput: 8192,
      capabilities: ['tools'],
      tags: ['test'],
    },
    apiKey: 'anthropic-test-key',
  })
}

function createOpenAIChatAdapter(): OpenAIChatAdapter {
  return new OpenAIChatAdapter({
    baseUrl: 'https://api.openai.test',
    auth: { type: 'api_key', apiKeyRef: 'openai_key' },
    modelConfig: {
      modelId: 'gpt-chat-test',
      maxContext: 200000,
      maxOutput: 8192,
      capabilities: ['tools'],
      tags: ['test'],
    },
    apiKey: 'openai-test-key',
  })
}

function createChatGptResponsesAdapter(): OpenAIResponsesAdapter {
  return new OpenAIResponsesAdapter({
    providerName: 'chatgpt',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    auth: { type: 'oauth2', oauthTokenRef: 'chatgpt_oauth_token' },
    modelConfig: {
      modelId: 'gpt-5.4',
      maxContext: 200000,
      maxOutput: 8192,
      capabilities: ['tools'],
      tags: ['test'],
    },
    oauthToken: JSON.stringify({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 180_000,
      tokenType: 'Bearer',
      accountId: 'acct_123',
    }),
  })
}

function createCrossProviderConfig(): SystemConfig {
  return {
    providers: {
      'openai-chat': {
        apiType: 'openai_chat_completions',
        baseUrl: 'https://api.openai.test',
        auth: { type: 'api_key', apiKeyRef: 'openai_key' },
        models: {
          'gpt-chat-test': {
            modelId: 'gpt-chat-test',
            maxContext: 200000,
            maxOutput: 8192,
            capabilities: ['tools'],
            tags: ['chat'],
          },
        },
      },
      anthropic: {
        apiType: 'anthropic_messages',
        baseUrl: 'https://api.anthropic.test',
        auth: { type: 'api_key', apiKeyRef: 'anthropic_key' },
        models: {
          'claude-sonnet-test': {
            modelId: 'claude-sonnet-test',
            maxContext: 200000,
            maxOutput: 8192,
            capabilities: ['tools'],
            tags: ['anthropic'],
          },
        },
      },
      'openai-responses': {
        apiType: 'openai_responses',
        baseUrl: 'https://api.openai.test',
        auth: { type: 'api_key', apiKeyRef: 'responses_key' },
        models: {
          'gpt-responses-test': {
            modelId: 'gpt-responses-test',
            maxContext: 200000,
            maxOutput: 8192,
            capabilities: ['tools'],
            tags: ['responses'],
          },
        },
      },
    },
    defaultModel: 'gpt-chat-test',
    fallbackChain: ['gpt-chat-test', 'claude-sonnet-test', 'gpt-responses-test'],
    schedules: [],
    fuseList: [],
  }
}

function createSecrets(): Map<string, string> {
  return new Map([
    ['openai_key', 'sk-openai'],
    ['anthropic_key', 'sk-anthropic'],
    ['responses_key', 'sk-responses'],
  ])
}

const ANTHROPIC_TOOL_ID_RE = /^[a-zA-Z0-9_-]+$/

describe('Cross-provider tool ID compatibility', () => {
  test('Anthropic toolu_* IDs convert through OpenAI Chat without crashing', () => {
    const toolId = `toolu_${generateId()}`

    const converted = convertOpenAIChat(makeRequest(makeToolConversation(toolId)))

    expect(converted.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(converted[1].tool_calls?.[0].id).toBe(toolId)
    expect(converted[2].tool_call_id).toBe(toolId)
  })

  test('Anthropic toolu_* IDs convert through OpenAI Responses without crashing', () => {
    const toolId = `toolu_${generateId()}`

    const input = buildOpenAIResponsesInput(
      makeRequest(makeToolConversation(toolId)),
    ) as ResponsesInputItemLike[]

    expect(input.map((item) => item.type ?? item.role)).toEqual([
      'user',
      'assistant',
      'function_call',
      'function_call_output',
      'assistant',
    ])
    expect(input[2]).toMatchObject({
      type: 'function_call',
      call_id: toolId,
      id: `fc_${toolId}`,
      name: 'read_file',
    })
    expect(input[3]).toEqual({
      type: 'function_call_output',
      call_id: toolId,
      output: 'AGENTS.md contents',
    })
  })

  test('OpenAI Chat call_* IDs convert through Anthropic without crashing', () => {
    const toolId = `call_${generateId()}`

    const converted = convertAnthropic(makeRequest(makeToolConversation(toolId)))

    expect(converted.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(converted[1].content[1]).toMatchObject({
      type: 'tool_use',
      id: toolId,
      name: 'read_file',
    })
    expect(converted[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: toolId,
      content: 'AGENTS.md contents',
    })
  })

  test('Composite call_*|fc_* IDs are sanitized for Anthropic compatibility', () => {
    const toolId = `call_${generateId()}|fc_${generateId()}`
    const sanitizedToolId = toolId.replace(/[^a-zA-Z0-9_-]/g, '-')

    const converted = convertAnthropic(makeRequest(makeToolConversation(toolId)))

    expect(converted[1].content[1]).toMatchObject({
      type: 'tool_use',
      id: sanitizedToolId,
    })
    expect(converted[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: sanitizedToolId,
    })
    expect(ANTHROPIC_TOOL_ID_RE.test(String(converted[1].content[1].id))).toBe(true)
    expect(ANTHROPIC_TOOL_ID_RE.test(String(converted[2].content[0].tool_use_id))).toBe(true)
  })

  test('Anthropic preserves already valid tool IDs', () => {
    const toolIds = [`toolu_${generateId()}`, `call_${generateId()}`]

    for (const toolId of toolIds) {
      const converted = convertAnthropic(makeRequest(makeToolConversation(toolId)))

      expect(converted[1].content[1]).toMatchObject({
        type: 'tool_use',
        id: toolId,
      })
      expect(converted[2].content[0]).toMatchObject({
        type: 'tool_result',
        tool_use_id: toolId,
      })
    }
  })

  test('Anthropic sanitizes every unsupported character in tool IDs', () => {
    const toolId = `call:${generateId()}/fc.${generateId()}#result`
    const sanitizedToolId = toolId.replace(/[^a-zA-Z0-9_-]/g, '-')

    const converted = convertAnthropic(makeRequest(makeToolConversation(toolId)))

    expect(converted[1].content[1]).toMatchObject({
      type: 'tool_use',
      id: sanitizedToolId,
    })
    expect(converted[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: sanitizedToolId,
    })
    expect(ANTHROPIC_TOOL_ID_RE.test(sanitizedToolId)).toBe(true)
  })

  test('Composite call_*|fc_* IDs convert through OpenAI Chat without crashing', () => {
    const toolId = `call_${generateId()}|fc_${generateId()}`

    const converted = convertOpenAIChat(makeRequest(makeToolConversation(toolId)))

    expect(converted[1].tool_calls?.[0].id).toBe(toolId)
    expect(converted[2].tool_call_id).toBe(toolId)
    expect(converted[2].content).toBe('AGENTS.md contents')
  })

  test('Composite call_*|fc_* IDs convert through OpenAI Responses with split call_id/item id', () => {
    const callId = `call_${generateId()}`
    const itemId = `fc_${generateId()}`
    const compositeId = `${callId}|${itemId}`

    const input = buildOpenAIResponsesInput(
      makeRequest(makeToolConversation(compositeId)),
    ) as ResponsesInputItemLike[]

    expect(input[2]).toEqual({
      type: 'function_call',
      id: itemId,
      call_id: callId,
      name: 'read_file',
      arguments: JSON.stringify({ path: '/Users/v1ki/Desktop/test4_zero/AGENTS.md' }),
    })
    expect(input[3]).toEqual({
      type: 'function_call_output',
      call_id: callId,
      output: 'AGENTS.md contents',
    })
  })
})

describe('Unified session history conversion', () => {
  test('Anthropic converts a complete text + tool_use + tool_result history', () => {
    const messages = makeToolConversation(`toolu_${generateId()}`)

    const converted = convertAnthropic(makeRequest(messages))

    expect(converted).toHaveLength(4)
    expect(converted[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Read the workspace instructions.' }],
    })
    expect(converted[1].content[0]).toEqual({
      type: 'text',
      text: 'I will inspect the repo first.',
    })
    expect(converted[1].content[1]).toMatchObject({
      type: 'tool_use',
      name: 'read_file',
    })
    expect(converted[2].content[0]).toMatchObject({
      type: 'tool_result',
      content: 'AGENTS.md contents',
    })
    expect(converted[3]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'I found the instructions and can continue.' }],
    })
  })

  test('OpenAI Chat converts a complete text + tool_use + tool_result history', () => {
    const messages = makeToolConversation(`call_${generateId()}`)

    const converted = convertOpenAIChat(makeRequest(messages))

    expect(converted).toHaveLength(4)
    expect(converted[0]).toEqual({
      role: 'user',
      content: 'Read the workspace instructions.',
    })
    expect(converted[1]).toMatchObject({
      role: 'assistant',
      content: 'I will inspect the repo first.',
    })
    expect(converted[1].tool_calls?.[0]).toMatchObject({
      type: 'function',
      function: {
        name: 'read_file',
        arguments: JSON.stringify({ path: '/Users/v1ki/Desktop/test4_zero/AGENTS.md' }),
      },
    })
    expect(converted[2]).toMatchObject({
      role: 'tool',
      content: 'AGENTS.md contents',
    })
    expect(converted[3]).toEqual({
      role: 'assistant',
      content: 'I found the instructions and can continue.',
    })
  })

  test('OpenAI Responses converts a complete text + tool_use + tool_result history', () => {
    const messages = makeToolConversation(`call_${generateId()}`)

    const input = buildOpenAIResponsesInput(makeRequest(messages)) as ResponsesInputItemLike[]

    expect(input).toEqual([
      { role: 'user', content: 'Read the workspace instructions.' },
      { role: 'assistant', content: 'I will inspect the repo first.' },
      {
        type: 'function_call',
        id: expect.any(String),
        call_id: expect.any(String),
        name: 'read_file',
        arguments: JSON.stringify({ path: '/Users/v1ki/Desktop/test4_zero/AGENTS.md' }),
      },
      {
        type: 'function_call_output',
        call_id: expect.any(String),
        output: 'AGENTS.md contents',
      },
      { role: 'assistant', content: 'I found the instructions and can continue.' },
    ])
  })
})

describe('ModelRouter cross-provider switching', () => {
  test('init selects the default OpenAI Chat provider', () => {
    const router = new ModelRouter(createCrossProviderConfig(), createSecrets())
    const result = router.init()

    expect(result.success).toBe(true)
    expect(result.model?.providerName).toBe('openai-chat')
    expect(router.getAdapter()).toBeInstanceOf(OpenAIChatAdapter)
  })

  test('switchModel moves from OpenAI Chat to Anthropic', () => {
    const router = new ModelRouter(createCrossProviderConfig(), createSecrets())
    router.init()

    const result = router.switchModel('claude-sonnet-test')

    expect(result.success).toBe(true)
    expect(result.model?.providerName).toBe('anthropic')
    expect(router.getAdapter()).toBeInstanceOf(AnthropicAdapter)
  })

  test('switchModel moves from Anthropic to OpenAI Responses', () => {
    const router = new ModelRouter(createCrossProviderConfig(), createSecrets())
    router.init()
    router.switchModel('claude-sonnet-test')

    const result = router.switchModel('gpt-responses-test')

    expect(result.success).toBe(true)
    expect(result.model?.providerName).toBe('openai-responses')
    expect(router.getAdapter()).toBeInstanceOf(OpenAIResponsesAdapter)
  })

  test('provider-qualified switching returns the correct adapter after multiple hops', () => {
    const router = new ModelRouter(createCrossProviderConfig(), createSecrets())
    router.init()
    router.switchModel('anthropic/claude-sonnet-test')
    router.switchModel('openai-responses/gpt-responses-test')

    const result = router.switchModel('openai-chat/gpt-chat-test')

    expect(result.success).toBe(true)
    expect(result.model?.providerName).toBe('openai-chat')
    expect(result.model?.modelName).toBe('gpt-chat-test')
    expect(router.getAdapter()).toBeInstanceOf(OpenAIChatAdapter)
  })
})

describe('collectStream unified consumption across adapters', () => {
  test('collectStream consumes Anthropic stream events with toolu_* IDs', async () => {
    const adapter = createAnthropicAdapter()
    const harness = getAnthropicHarness(adapter)

    harness.client = {
      messages: {
        create: async () =>
          (async function* (): AsyncIterable<Record<string, unknown>> {
            yield {
              type: 'message_start',
              message: {
                model: 'claude-sonnet-test',
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
              delta: { type: 'text_delta', text: 'Checking instructions. ' },
            }
            yield {
              type: 'content_block_start',
              index: 1,
              content_block: {
                type: 'tool_use',
                id: 'toolu_stream_1',
                name: 'read_file',
                input: {},
              },
            }
            yield {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '{"path":"AGENTS.md"}' },
            }
            yield { type: 'content_block_stop', index: 1 }
            yield {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use' },
              usage: { output_tokens: 7 },
            }
            yield { type: 'message_stop' }
          })(),
      },
    }

    const result = await collectStream(
      adapter.stream({
        messages: [makeMessage('user', 'Read AGENTS.md')],
        stream: true,
      }),
    )

    expect(result.content).toEqual([
      { type: 'text', text: 'Checking instructions. ' },
      { type: 'tool_use', id: 'toolu_stream_1', name: 'read_file', input: { path: 'AGENTS.md' } },
    ])
    expect(result.usage).toEqual({
      input: 11,
      output: 7,
      cacheWrite: undefined,
      cacheRead: undefined,
    })
  })

  test('collectStream consumes OpenAI Chat stream events with call_* IDs', async () => {
    const adapter = createOpenAIChatAdapter()
    const harness = getOpenAIChatHarness(adapter)

    harness.client = {
      chat: {
        completions: {
          create: async () =>
            (async function* (): AsyncIterable<Record<string, unknown>> {
              yield {
                id: 'chatcmpl_1',
                model: 'gpt-chat-test',
                choices: [
                  {
                    delta: { content: 'Inspecting files. ' },
                  },
                ],
              }
              yield {
                id: 'chatcmpl_1',
                model: 'gpt-chat-test',
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          id: 'call_stream_1',
                          function: { name: 'read_file', arguments: '{"path":"AG' },
                        },
                      ],
                    },
                  },
                ],
              }
              yield {
                id: 'chatcmpl_1',
                model: 'gpt-chat-test',
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          function: { arguments: 'ENTS.md"}' },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
                usage: { prompt_tokens: 9, completion_tokens: 4 },
              }
            })(),
        },
      },
    }

    const result = await collectStream(
      adapter.stream({
        messages: [makeMessage('user', 'Read AGENTS.md')],
        stream: true,
      }),
    )

    expect(result.content).toEqual([
      { type: 'text', text: 'Inspecting files. ' },
      { type: 'tool_use', id: 'call_stream_1', name: 'read_file', input: { path: 'AGENTS.md' } },
    ])
    expect(result.usage).toEqual({
      input: 9,
      output: 4,
      cacheWrite: undefined,
      cacheRead: undefined,
      reasoning: undefined,
    })
  })

  test('collectStream consumes OpenAI Responses stream events with composite IDs', async () => {
    const adapter = createChatGptResponsesAdapter()
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async () =>
      new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"Inspecting files. "}',
          '',
          'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_stream_1","call_id":"call_stream_1","name":"read_file","arguments":""}}',
          '',
          'data: {"type":"response.function_call_arguments.delta","call_id":"call_stream_1","delta":"{\\"path\\":\\"AGENTS.md\\"}"}',
          '',
          'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_stream_1","call_id":"call_stream_1","name":"read_file","arguments":"{\\"path\\":\\"AGENTS.md\\"}"}}',
          '',
          'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4","status":"completed","usage":{"input_tokens":12,"output_tokens":5}}}',
          '',
          '',
        ].join('\n'),
        {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        },
      )) as unknown as typeof fetch

    try {
      const result = await collectStream(
        adapter.stream({
          messages: [makeMessage('user', 'Read AGENTS.md')],
          stream: true,
        }),
      )

      expect(result.content).toEqual([
        { type: 'text', text: 'Inspecting files. ' },
        {
          type: 'tool_use',
          id: 'call_stream_1|fc_stream_1',
          name: 'read_file',
          input: { path: 'AGENTS.md' },
        },
      ])
      expect(result.usage).toEqual({
        input: 12,
        output: 5,
        cacheWrite: undefined,
        cacheRead: undefined,
        reasoning: undefined,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
