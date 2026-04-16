import { describe, expect, test } from 'bun:test'
import type { CompletionRequest, Message, SystemConfig } from '@zero-os/shared'
import { generateId, now } from '@zero-os/shared'
import { AnthropicAdapter } from '../adapters/anthropic'
import { OpenAIChatAdapter } from '../adapters/openai-chat'
import { OpenAIResponsesAdapter } from '../adapters/openai-resp'
import { ModelRouter } from '../router'
import { collectStream } from '../stream'

type AnthropicMessageLike = {
  role: string
  content: Array<Record<string, unknown>>
}

type ChatMessageLike = {
  role: string
  content?: string | null | Array<Record<string, unknown>>
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

interface AnthropicHarness {
  client: {
    messages: {
      create: (params: Record<string, unknown>) => Promise<unknown>
    }
  }
  convertMessages(req: CompletionRequest): AnthropicMessageLike[]
  buildSystem(system?: string): Array<{ type: string; text: string }> | undefined
}

interface OpenAIChatHarness {
  convertMessages(req: CompletionRequest): ChatMessageLike[]
}

interface OpenAIResponsesHarness {
  client: {
    responses: {
      create: (params: Record<string, unknown>) => Promise<unknown>
    }
  } | null
  buildInput(req: CompletionRequest): ResponsesInputItemLike[]
  buildChatGptBody(req: CompletionRequest): {
    instructions?: string
    input: ResponsesInputItemLike[]
  }
}

function getAnthropicHarness(instance: AnthropicAdapter): AnthropicHarness {
  return instance as unknown as AnthropicHarness
}

function getOpenAIChatHarness(instance: OpenAIChatAdapter): OpenAIChatHarness {
  return instance as unknown as OpenAIChatHarness
}

function getResponsesHarness(instance: OpenAIResponsesAdapter): OpenAIResponsesHarness {
  return instance as unknown as OpenAIResponsesHarness
}

function makeMessage(role: 'user' | 'assistant', content: Message['content']): Message {
  return {
    id: generateId(),
    sessionId: 'cross-provider-coverage',
    role,
    messageType: 'message',
    content,
    createdAt: now(),
  }
}

function makeTextMessage(role: 'user' | 'assistant', text: string): Message {
  return makeMessage(role, [{ type: 'text', text }])
}

function createAnthropicAdapter(oauthToken?: string): AnthropicAdapter {
  return new AnthropicAdapter({
    providerName: oauthToken ? 'anthropic-oauth' : 'anthropic',
    baseUrl: 'https://api.anthropic.test',
    auth: oauthToken
      ? { type: 'oauth2', oauthTokenRef: 'anthropic_oauth' }
      : { type: 'api_key', apiKeyRef: 'anthropic_key' },
    modelConfig: {
      modelId: 'claude-sonnet-test',
      maxContext: 200000,
      maxOutput: 8192,
      capabilities: ['tools', 'vision'],
      tags: ['test'],
    },
    apiKey: oauthToken ? undefined : 'anthropic-test-key',
    oauthToken,
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
      capabilities: ['tools', 'vision', 'reasoning'],
      tags: ['test'],
    },
    apiKey: 'openai-test-key',
  })
}

function createOpenAIResponsesAdapter(providerName?: string): OpenAIResponsesAdapter {
  return new OpenAIResponsesAdapter({
    providerName,
    baseUrl:
      providerName === 'chatgpt' ? 'https://chatgpt.com/backend-api/codex' : 'https://api.openai.test',
    auth:
      providerName === 'chatgpt'
        ? { type: 'oauth2', oauthTokenRef: 'chatgpt_oauth_token' }
        : { type: 'api_key', apiKeyRef: 'responses_key' },
    modelConfig: {
      modelId: 'gpt-responses-test',
      maxContext: 200000,
      maxOutput: 8192,
      capabilities: ['tools', 'vision', 'reasoning'],
      tags: ['test'],
    },
    apiKey: providerName === 'chatgpt' ? undefined : 'responses-test-key',
    oauthToken:
      providerName === 'chatgpt'
        ? JSON.stringify({
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            expiresAt: Date.now() + 180_000,
            tokenType: 'Bearer',
            accountId: 'acct_123',
          })
        : undefined,
  })
}

function makeRequest(messages: Message[], system?: string): CompletionRequest {
  return {
    messages,
    system,
    stream: false,
  }
}

describe('Cross-provider system prompt and instructions fidelity', () => {
  test('Anthropic OAuth prepends provider instructions before user system prompt', () => {
    const adapter = createAnthropicAdapter(
      JSON.stringify({
        accessToken: 'oauth-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 180_000,
        tokenType: 'Bearer',
        accountId: 'acct_123',
      }),
    )

    const system = getAnthropicHarness(adapter).buildSystem('Follow the repo checklist exactly.')

    expect(system).toEqual([
      {
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
      {
        type: 'text',
        text: 'Follow the repo checklist exactly.',
      },
    ])
  })

  test('OpenAI Chat injects the system prompt as a leading system message', () => {
    const adapter = createOpenAIChatAdapter()

    const converted = getOpenAIChatHarness(adapter).convertMessages(
      makeRequest([makeTextMessage('user', 'Inspect the repository.')], 'Stay concise.'),
    )

    expect(converted[0]).toEqual({ role: 'system', content: 'Stay concise.' })
    expect(converted[1]).toEqual({ role: 'user', content: 'Inspect the repository.' })
  })

  test('ChatGPT Responses maps the system prompt to instructions instead of a system message', () => {
    const adapter = createOpenAIResponsesAdapter('chatgpt')

    const body = getResponsesHarness(adapter).buildChatGptBody(
      makeRequest([makeTextMessage('user', 'Inspect the repository.')], 'Stay concise.'),
    )

    expect(body.instructions).toBe('Stay concise.')
    expect(body.input).toEqual([{ role: 'user', content: 'Inspect the repository.' }])
  })
})

describe('Cross-provider dangling tool state and tool_result normalization', () => {
  test('Anthropic drops dangling tool_use while preserving assistant text', () => {
    const adapter = createAnthropicAdapter()
    const danglingId = `toolu_${generateId()}`
    const messages = [
      makeTextMessage('user', 'Start'),
      makeMessage('assistant', [
        { type: 'text', text: 'I started a tool call but it was interrupted.' },
        { type: 'tool_use', id: danglingId, name: 'read_file', input: { path: 'AGENTS.md' } },
      ]),
      makeTextMessage('user', 'Continue without reusing the interrupted call.'),
    ]

    const converted = getAnthropicHarness(adapter).convertMessages(makeRequest(messages))

    expect(converted).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Start' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I started a tool call but it was interrupted.' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Continue without reusing the interrupted call.' }],
      },
    ])
  })

  test('OpenAI Chat drops dangling tool_use while preserving assistant text', () => {
    const adapter = createOpenAIChatAdapter()
    const danglingId = `call_${generateId()}`
    const messages = [
      makeTextMessage('user', 'Start'),
      makeMessage('assistant', [
        { type: 'text', text: 'I started a tool call but it was interrupted.' },
        { type: 'tool_use', id: danglingId, name: 'read_file', input: { path: 'AGENTS.md' } },
      ]),
      makeTextMessage('user', 'Continue without reusing the interrupted call.'),
    ]

    const converted = getOpenAIChatHarness(adapter).convertMessages(makeRequest(messages))

    expect(converted).toEqual([
      { role: 'user', content: 'Start' },
      { role: 'assistant', content: 'I started a tool call but it was interrupted.' },
      { role: 'user', content: 'Continue without reusing the interrupted call.' },
    ])
  })

  test('OpenAI Responses drops dangling tool_use while preserving assistant text', () => {
    const adapter = createOpenAIResponsesAdapter()
    const danglingId = `call_${generateId()}`
    const messages = [
      makeTextMessage('user', 'Start'),
      makeMessage('assistant', [
        { type: 'text', text: 'I started a tool call but it was interrupted.' },
        { type: 'tool_use', id: danglingId, name: 'read_file', input: { path: 'AGENTS.md' } },
      ]),
      makeTextMessage('user', 'Continue without reusing the interrupted call.'),
    ]

    const input = getResponsesHarness(adapter).buildInput(makeRequest(messages))

    expect(input).toEqual([
      { role: 'user', content: 'Start' },
      { role: 'assistant', content: 'I started a tool call but it was interrupted.' },
      { role: 'user', content: 'Continue without reusing the interrupted call.' },
    ])
  })

  test('Anthropic preserves empty tool_result fallback text and is_error flag', () => {
    const adapter = createAnthropicAdapter()
    const toolId = `toolu_${generateId()}`
    const messages = [
      makeTextMessage('user', 'Run the task'),
      makeMessage('assistant', [{ type: 'tool_use', id: toolId, name: 'bash', input: { cmd: 'exit 1' } }]),
      makeMessage('user', [
        {
          type: 'tool_result',
          toolUseId: toolId,
          content: '',
          outputSummary: 'Command exited with status 1',
          isError: true,
        },
      ]),
    ]

    const converted = getAnthropicHarness(adapter).convertMessages(makeRequest(messages))

    expect(converted[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolId,
          content: '',
          is_error: true,
        },
      ],
    })
  })

  test('OpenAI-family adapters normalize empty tool_result to outputSummary and preserve pairing', () => {
    const toolId = `call_${generateId()}`
    const messages = [
      makeTextMessage('user', 'Run the task'),
      makeMessage('assistant', [{ type: 'tool_use', id: toolId, name: 'bash', input: { cmd: 'exit 1' } }]),
      makeMessage('user', [
        {
          type: 'tool_result',
          toolUseId: toolId,
          content: '',
          outputSummary: 'Command exited with status 1',
          isError: true,
        },
      ]),
    ]

    const chatConverted = getOpenAIChatHarness(createOpenAIChatAdapter()).convertMessages(
      makeRequest(messages),
    )
    const responsesConverted = getResponsesHarness(createOpenAIResponsesAdapter()).buildInput(
      makeRequest(messages),
    )

    expect(chatConverted[2]).toEqual({
      role: 'tool',
      tool_call_id: toolId,
      content: 'Command exited with status 1',
    })
    expect(responsesConverted[2]).toEqual({
      type: 'function_call_output',
      call_id: toolId,
      output: 'Command exited with status 1',
    })
  })
})

describe('Cross-provider multimodal preservation', () => {
  test('user image blocks survive conversion across all provider formats', () => {
    const messages = [
      makeMessage('user', [
        { type: 'text', text: 'Inspect this screenshot.' },
        { type: 'image', mediaType: 'image/png', data: 'ZmFrZS1pbWFnZQ==' },
      ]),
    ]

    const anthropic = getAnthropicHarness(createAnthropicAdapter()).convertMessages(makeRequest(messages))
    const chat = getOpenAIChatHarness(createOpenAIChatAdapter()).convertMessages(makeRequest(messages))
    const responses = getResponsesHarness(createOpenAIResponsesAdapter()).buildInput(makeRequest(messages))

    expect(anthropic[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Inspect this screenshot.' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'ZmFrZS1pbWFnZQ==',
          },
        },
      ],
    })
    expect(chat[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Inspect this screenshot.' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,ZmFrZS1pbWFnZQ==' },
        },
      ],
    })
    expect(responses[0]).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'Inspect this screenshot.' },
        {
          type: 'input_image',
          detail: 'auto',
          image_url: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
        },
      ],
    })
  })
})

describe('Cross-provider streaming and fallback behavior', () => {
  test('standard OpenAI Responses streaming emits unified tool events that collectStream can aggregate', async () => {
    const adapter = createOpenAIResponsesAdapter()
    const harness = getResponsesHarness(adapter)

    harness.client = {
      responses: {
        create: async () =>
          (async function* (): AsyncIterable<Record<string, unknown>> {
            yield {
              type: 'response.output_text.delta',
              delta: 'Inspecting files. ',
            }
            yield {
              type: 'response.output_item.added',
              item: {
                type: 'function_call',
                id: 'fc_stream_1',
                call_id: 'call_stream_1',
                name: 'read_file',
                arguments: '',
              },
            }
            yield {
              type: 'response.function_call_arguments.delta',
              call_id: 'call_stream_1',
              delta: '{"path":"AG',
            }
            yield {
              type: 'response.function_call_arguments.delta',
              call_id: 'call_stream_1',
              delta: 'ENTS.md"}',
            }
            yield {
              type: 'response.output_item.done',
              item: {
                type: 'function_call',
                id: 'fc_stream_1',
                call_id: 'call_stream_1',
                name: 'read_file',
                arguments: '{"path":"AGENTS.md"}',
              },
            }
            yield {
              type: 'response.completed',
              response: {
                id: 'resp_stream_1',
                model: 'gpt-responses-test',
                status: 'completed',
                usage: { input_tokens: 12, output_tokens: 5 },
              },
            }
          })(),
      },
    }

    const result = await collectStream(
      adapter.stream({
        messages: [makeTextMessage('user', 'Read AGENTS.md')],
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
  })

  test('router fallback skips unavailable providers and lands on the first healthy provider', async () => {
    const config: SystemConfig = {
      providers: {
        'openai-chat': {
          apiType: 'openai_chat_completions',
          baseUrl: 'https://api.openai.test',
          auth: { type: 'api_key', apiKeyRef: 'openai_key' },
          models: {
            primary: {
              modelId: 'gpt-chat-primary',
              maxContext: 200000,
              maxOutput: 8192,
              capabilities: ['tools'],
              tags: ['primary'],
            },
          },
        },
        anthropic: {
          apiType: 'anthropic_messages',
          baseUrl: 'https://api.anthropic.test',
          auth: { type: 'api_key', apiKeyRef: 'anthropic_key' },
          models: {
            backup: {
              modelId: 'claude-backup',
              maxContext: 200000,
              maxOutput: 8192,
              capabilities: ['tools'],
              tags: ['backup'],
            },
          },
        },
        chatgpt: {
          apiType: 'openai_responses',
          baseUrl: 'https://chatgpt.com/backend-api/codex',
          auth: { type: 'oauth2', oauthTokenRef: 'chatgpt_oauth_token' },
          models: {
            final: {
              modelId: 'gpt-5.4',
              maxContext: 200000,
              maxOutput: 8192,
              capabilities: ['tools'],
              tags: ['fallback'],
            },
          },
        },
      },
      defaultModel: 'openai-chat/primary',
      fallbackChain: ['openai-chat/primary', 'anthropic/backup', 'chatgpt/final'],
      schedules: [],
      fuseList: [],
    }

    const router = new ModelRouter(
      config,
      new Map([
        ['openai_key', 'sk-openai'],
        ['anthropic_key', 'sk-anthropic'],
        [
          'chatgpt_oauth_token',
          JSON.stringify({
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            expiresAt: Date.now() + 180_000,
            tokenType: 'Bearer',
            accountId: 'acct_123',
          }),
        ],
      ]),
    )

    router.init()
    const primary = router.getRegistry().resolve('openai-chat/primary')
    const backup = router.getRegistry().resolve('anthropic/backup')
    const final = router.getRegistry().resolve('chatgpt/final')

    if (!primary || !backup || !final) {
      throw new Error('Failed to resolve fallback test models')
    }

    primary.adapter.healthCheck = async () => false
    backup.adapter.healthCheck = async () => false
    final.adapter.healthCheck = async () => true

    const result = await router.fallback()

    expect(result.success).toBe(true)
    expect(result.model?.providerName).toBe('chatgpt')
    expect(result.model?.modelName).toBe('final')
    expect(router.getCurrentModel()?.providerName).toBe('chatgpt')
  })
})

describe('Cross-provider stop reason mapping', () => {
  test('Anthropic mapStopReason maps provider reasons to unified semantics', () => {
    const adapter = createAnthropicAdapter() as unknown as {
      mapStopReason(reason: string | null): string
    }

    expect(adapter.mapStopReason('end_turn')).toBe('end_turn')
    expect(adapter.mapStopReason('tool_use')).toBe('tool_use')
    expect(adapter.mapStopReason('max_tokens')).toBe('max_tokens')
    expect(adapter.mapStopReason('something_else')).toBe('end_turn')
  })

  test('OpenAI Chat mapStopReason maps provider reasons to unified semantics', () => {
    const adapter = createOpenAIChatAdapter() as unknown as {
      mapStopReason(reason: string | null): string
    }

    expect(adapter.mapStopReason('stop')).toBe('end_turn')
    expect(adapter.mapStopReason('tool_calls')).toBe('tool_use')
    expect(adapter.mapStopReason('length')).toBe('max_tokens')
    expect(adapter.mapStopReason('something_else')).toBe('end_turn')
  })

  test('OpenAI Chat complete overrides stop reason to tool_use when tool_calls are present', async () => {
    const adapter = createOpenAIChatAdapter()
    ;(
      adapter as unknown as {
        client: {
          chat: {
            completions: {
              create(params: Record<string, unknown>): Promise<unknown>
            }
          }
        }
      }
    ).client = {
      chat: {
        completions: {
          create: async () => ({
            id: 'chatcmpl_tool_stop',
            model: 'gpt-chat-test',
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_override_1',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"AGENTS.md"}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 5 },
          }),
        },
      },
    }

    const result = await adapter.complete(makeRequest([makeTextMessage('user', 'Read AGENTS.md')]))

    expect(result.stopReason).toBe('tool_use')
  })

  test('OpenAI Responses parseResponse maps function_call output to tool_use and normal output to end_turn', () => {
    const adapter = createOpenAIResponsesAdapter() as unknown as {
      parseResponse(response: Record<string, unknown>): {
        stopReason: string
      }
    }

    const withToolCall = adapter.parseResponse({
      id: 'resp_fc',
      model: 'gpt-responses-test',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"AGENTS.md"}',
        },
      ],
      usage: { input_tokens: 10, output_tokens: 3 },
    })
    const withoutToolCall = adapter.parseResponse({
      id: 'resp_text',
      model: 'gpt-responses-test',
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Done.' }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 3 },
    })

    expect(withToolCall.stopReason).toBe('tool_use')
    expect(withoutToolCall.stopReason).toBe('end_turn')
  })

  test('tool call scenarios map to tool_use consistently across providers', async () => {
    const anthropic = createAnthropicAdapter() as unknown as {
      mapStopReason(reason: string | null): string
    }
    const chat = createOpenAIChatAdapter()
    ;(
      chat as unknown as {
        client: {
          chat: {
            completions: {
              create(params: Record<string, unknown>): Promise<unknown>
            }
          }
        }
      }
    ).client = {
      chat: {
        completions: {
          create: async () => ({
            id: 'chatcmpl_tool_consistent',
            model: 'gpt-chat-test',
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: 'Calling tool',
                  tool_calls: [
                    {
                      id: 'call_consistent_1',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{"path":"AGENTS.md"}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 4 },
          }),
        },
      },
    }
    const responses = createOpenAIResponsesAdapter() as unknown as {
      parseResponse(response: Record<string, unknown>): {
        stopReason: string
      }
    }

    const chatResult = await chat.complete(makeRequest([makeTextMessage('user', 'Read AGENTS.md')]))
    const responsesResult = responses.parseResponse({
      id: 'resp_consistent',
      model: 'gpt-responses-test',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          id: 'fc_consistent_1',
          call_id: 'call_consistent_1',
          name: 'read_file',
          arguments: '{"path":"AGENTS.md"}',
        },
      ],
      usage: { input_tokens: 7, output_tokens: 2 },
    })

    expect(anthropic.mapStopReason('tool_use')).toBe('tool_use')
    expect(chatResult.stopReason).toBe('tool_use')
    expect(responsesResult.stopReason).toBe('tool_use')
  })
})

describe('Cross-provider reasoning / thinking behavior', () => {
  test('Anthropic extractReasoningContent returns joined thinking text', () => {
    const adapter = createAnthropicAdapter() as unknown as {
      extractReasoningContent(content: Array<Record<string, unknown>>): string | undefined
    }

    const reasoning = adapter.extractReasoningContent([
      { type: 'text', text: 'Visible answer' },
      { type: 'thinking', thinking: 'First internal step. ' },
      { type: 'thinking', thinking: ' Second internal step.' },
    ])

    expect(reasoning).toBe('First internal step.\nSecond internal step.')
  })

  test('Anthropic extractReasoningContent returns undefined when no thinking block exists', () => {
    const adapter = createAnthropicAdapter() as unknown as {
      extractReasoningContent(content: Array<Record<string, unknown>>): string | undefined
    }

    expect(
      adapter.extractReasoningContent([
        { type: 'text', text: 'Visible answer' },
        { type: 'tool_use', id: 'tool_1', name: 'read_file', input: {} },
      ]),
    ).toBeUndefined()
  })

  test('OpenAI Responses parseChatGptCompletion extracts reasoning summary text from SSE events', () => {
    const adapter = createOpenAIResponsesAdapter('chatgpt') as unknown as {
      parseChatGptCompletion(events: Array<Record<string, unknown>>): {
        reasoningContent?: string
      }
    }

    const result = adapter.parseChatGptCompletion([
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        summary_index: 0,
        delta: 'First summary sentence. ',
      },
      {
        type: 'response.reasoning_summary_text.done',
        item_id: 'rs_1',
        summary_index: 0,
        text: 'First summary sentence. Second summary sentence.',
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_reasoning',
          model: 'gpt-responses-test',
          usage: { input_tokens: 11, output_tokens: 5 },
        },
      },
    ])

    expect(result.reasoningContent).toBe('First summary sentence.')
  })

  test('unified message content blocks do not include a reasoning type', () => {
    const adapter = createOpenAIResponsesAdapter() as unknown as {
      parseResponse(response: Record<string, unknown>): {
        content: Array<{ type: string }>
        reasoningContent?: string
      }
    }

    const result = adapter.parseResponse({
      id: 'resp_reasoning_blocks',
      model: 'gpt-responses-test',
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ text: 'Internal summary.' }],
        },
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Visible answer.' }],
        },
        {
          type: 'function_call',
          id: 'fc_2',
          call_id: 'call_2',
          name: 'read_file',
          arguments: '{"path":"AGENTS.md"}',
        },
      ],
      usage: { input_tokens: 8, output_tokens: 4 },
    })

    expect(result.reasoningContent).toBe('Internal summary.')
    expect(result.content.map((block) => block.type)).toEqual(['text', 'tool_use'])
    expect(result.content.some((block) => block.type === 'reasoning')).toBe(false)
  })

  test('collectStream returns content and usage only, without reasoningContent', async () => {
    const result = await collectStream(
      (async function* () {
        yield { type: 'reasoning_delta', data: { text: 'step 1' } }
        yield { type: 'text_delta', data: { text: 'Visible answer' } }
        yield { type: 'done', data: { usage: { input: 3, output: 1 } } }
      })(),
    )

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Visible answer' }],
      usage: { input: 3, output: 1 },
    })
    expect('reasoningContent' in result).toBe(false)
  })
})

describe('Cross-provider token usage normalization', () => {
  test('Anthropic usage normalizes input_tokens and output_tokens', async () => {
    const adapter = createAnthropicAdapter()
    ;(
      adapter as unknown as {
        client: {
          messages: {
            create(params: Record<string, unknown>): Promise<unknown>
          }
        }
      }
    ).client = {
      messages: {
        create: async () => ({
          id: 'msg_usage_basic',
          model: 'claude-sonnet-test',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Done.' }],
          usage: {
            input_tokens: 21,
            output_tokens: 7,
          },
        }),
      },
    }

    const result = await adapter.complete(makeRequest([makeTextMessage('user', 'Ping')]))

    expect(result.usage).toEqual({
      input: 21,
      output: 7,
      cacheWrite: undefined,
      cacheRead: undefined,
    })
  })

  test('Anthropic usage includes cache write and cache read details', async () => {
    const adapter = createAnthropicAdapter()
    ;(
      adapter as unknown as {
        client: {
          messages: {
            create(params: Record<string, unknown>): Promise<unknown>
          }
        }
      }
    ).client = {
      messages: {
        create: async () => ({
          id: 'msg_usage_cache',
          model: 'claude-sonnet-test',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Done.' }],
          usage: {
            input_tokens: 21,
            output_tokens: 7,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 9,
          },
        }),
      },
    }

    const result = await adapter.complete(makeRequest([makeTextMessage('user', 'Ping')]))

    expect(result.usage).toEqual({
      input: 21,
      output: 7,
      cacheWrite: 5,
      cacheRead: 9,
    })
  })

  test('OpenAI Chat parseUsage normalizes prompt and completion tokens plus cached prompt tokens', () => {
    const adapter = createOpenAIChatAdapter() as unknown as {
      parseUsage(usage: Record<string, unknown>): Record<string, unknown>
    }

    expect(
      adapter.parseUsage({
        prompt_tokens: 100,
        completion_tokens: 25,
        prompt_tokens_details: {
          cached_tokens: 40,
        },
      }),
    ).toEqual({
      input: 60,
      output: 25,
      cacheWrite: undefined,
      cacheRead: 40,
      reasoning: undefined,
    })
  })

  test('OpenAI Chat parseUsage extracts reasoning tokens when present', () => {
    const adapter = createOpenAIChatAdapter() as unknown as {
      parseUsage(usage: Record<string, unknown>): Record<string, unknown>
    }

    expect(
      adapter.parseUsage({
        prompt_tokens: 100,
        completion_tokens: 25,
        prompt_tokens_details: {
          cache_creation_input_tokens: 10,
          cached_tokens: 40,
        },
        completion_tokens_details: {
          reasoning_tokens: 12,
        },
      }),
    ).toEqual({
      input: 50,
      output: 25,
      cacheWrite: 10,
      cacheRead: 40,
      reasoning: 12,
    })
  })

  test('OpenAI Responses parseUsage normalizes input and output tokens plus cached prompt tokens', () => {
    const adapter = createOpenAIResponsesAdapter() as unknown as {
      parseUsage(usage: Record<string, unknown>): Record<string, unknown>
    }

    expect(
      adapter.parseUsage({
        input_tokens: 100,
        output_tokens: 25,
        input_tokens_details: {
          cached_tokens: 40,
        },
      }),
    ).toEqual({
      input: 60,
      output: 25,
      cacheWrite: undefined,
      cacheRead: 40,
      reasoning: undefined,
    })
  })

  test('all adapters expose a consistent normalized usage shape', async () => {
    const anthropic = createAnthropicAdapter()
    ;(
      anthropic as unknown as {
        client: {
          messages: {
            create(params: Record<string, unknown>): Promise<unknown>
          }
        }
      }
    ).client = {
      messages: {
        create: async () => ({
          id: 'msg_usage_shape',
          model: 'claude-sonnet-test',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Done.' }],
          usage: {
            input_tokens: 9,
            output_tokens: 4,
          },
        }),
      },
    }
    const chat = createOpenAIChatAdapter() as unknown as {
      parseUsage(usage: Record<string, unknown>): Record<string, unknown>
    }
    const responses = createOpenAIResponsesAdapter() as unknown as {
      parseUsage(usage: Record<string, unknown>): Record<string, unknown>
    }

    const usageResults = [
      (await anthropic.complete(makeRequest([makeTextMessage('user', 'Ping')]))).usage,
      chat.parseUsage({ prompt_tokens: 9, completion_tokens: 4 }),
      responses.parseUsage({ input_tokens: 9, output_tokens: 4 }),
    ]

    for (const usage of usageResults) {
      expect(usage).toEqual({
        input: expect.any(Number),
        output: expect.any(Number),
        cacheWrite: undefined,
        cacheRead: undefined,
        reasoning: undefined,
      })
    }
  })
})

describe('Cross-provider multimodal and tool mixed scenarios', () => {
  test('user message with text, image, and tool_result is handled across all adapters', () => {
    const toolId = `call_${generateId()}`
    const messages = [
      makeMessage('assistant', [{ type: 'tool_use', id: toolId, name: 'vision_tool', input: { id: 1 } }]),
      makeMessage('user', [
        { type: 'text', text: 'Use the screenshot and prior tool output.' },
        { type: 'image', mediaType: 'image/png', data: 'aW1hZ2Ux' },
        {
          type: 'tool_result',
          toolUseId: toolId,
          content: 'Tool saw a button',
        },
      ]),
    ]

    const anthropic = getAnthropicHarness(createAnthropicAdapter()).convertMessages(makeRequest(messages))
    const chat = getOpenAIChatHarness(createOpenAIChatAdapter()).convertMessages(makeRequest(messages))
    const responses = getResponsesHarness(createOpenAIResponsesAdapter()).buildInput(makeRequest(messages))

    expect(anthropic[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Use the screenshot and prior tool output.' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'aW1hZ2Ux',
          },
        },
        {
          type: 'tool_result',
          tool_use_id: toolId,
          content: 'Tool saw a button',
          is_error: undefined,
        },
      ],
    })
    expect(chat).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: toolId,
            type: 'function',
            function: { name: 'vision_tool', arguments: '{"id":1}' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Use the screenshot and prior tool output.' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,aW1hZ2Ux' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: toolId,
        content: 'Tool saw a button',
      },
    ])
    expect(responses).toEqual([
      {
        type: 'function_call',
        id: `fc_${toolId}`,
        call_id: toolId,
        name: 'vision_tool',
        arguments: '{"id":1}',
      },
      {
        type: 'function_call_output',
        call_id: toolId,
        output: 'Tool saw a button',
      },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Use the screenshot and prior tool output.' },
          {
            type: 'input_image',
            detail: 'auto',
            image_url: 'data:image/png;base64,aW1hZ2Ux',
          },
        ],
      },
    ])
  })

  test('image input plus tool_use and tool_result in the same dialogue round stays convertible across providers', () => {
    const toolId = `call_${generateId()}`
    const messages = [
      makeMessage('user', [
        { type: 'text', text: 'Inspect this image and use a tool if needed.' },
        { type: 'image', mediaType: 'image/jpeg', data: 'aW1hZ2Uy' },
      ]),
      makeMessage('assistant', [
        { type: 'text', text: 'I will inspect it with a tool.' },
        { type: 'tool_use', id: toolId, name: 'classify_image', input: { mode: 'fast' } },
      ]),
      makeMessage('user', [
        {
          type: 'tool_result',
          toolUseId: toolId,
          content: 'Detected login form',
        },
      ]),
    ]

    const anthropic = getAnthropicHarness(createAnthropicAdapter()).convertMessages(makeRequest(messages))
    const chat = getOpenAIChatHarness(createOpenAIChatAdapter()).convertMessages(makeRequest(messages))
    const responses = getResponsesHarness(createOpenAIResponsesAdapter()).buildInput(makeRequest(messages))

    expect(anthropic).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this image and use a tool if needed.' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: 'aW1hZ2Uy',
            },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect it with a tool.' },
          {
            type: 'tool_use',
            id: toolId,
            name: 'classify_image',
            input: { mode: 'fast' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolId,
            content: 'Detected login form',
            is_error: undefined,
          },
        ],
      },
    ])
    expect(chat[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Inspect this image and use a tool if needed.' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/jpeg;base64,aW1hZ2Uy' },
        },
      ],
    })
    expect(chat[1]).toEqual({
      role: 'assistant',
      content: 'I will inspect it with a tool.',
      tool_calls: [
        {
          id: toolId,
          type: 'function',
          function: { name: 'classify_image', arguments: '{"mode":"fast"}' },
        },
      ],
    })
    expect(chat[2]).toEqual({
      role: 'tool',
      tool_call_id: toolId,
      content: 'Detected login form',
    })
    expect(responses[0]).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'Inspect this image and use a tool if needed.' },
        {
          type: 'input_image',
          detail: 'auto',
          image_url: 'data:image/jpeg;base64,aW1hZ2Uy',
        },
      ],
    })
    expect(responses[1]).toEqual({
      role: 'assistant',
      content: 'I will inspect it with a tool.',
    })
    expect(responses[2]).toEqual({
      type: 'function_call',
      id: `fc_${toolId}`,
      call_id: toolId,
      name: 'classify_image',
      arguments: '{"mode":"fast"}',
    })
    expect(responses[3]).toEqual({
      type: 'function_call_output',
      call_id: toolId,
      output: 'Detected login form',
    })
  })

  test('multiple image blocks are preserved across all adapters', () => {
    const messages = [
      makeMessage('user', [
        { type: 'text', text: 'Compare these images.' },
        { type: 'image', mediaType: 'image/png', data: 'aW1nMQ==' },
        { type: 'image', mediaType: 'image/png', data: 'aW1nMg==' },
      ]),
    ]

    const anthropic = getAnthropicHarness(createAnthropicAdapter()).convertMessages(makeRequest(messages))
    const chat = getOpenAIChatHarness(createOpenAIChatAdapter()).convertMessages(makeRequest(messages))
    const responses = getResponsesHarness(createOpenAIResponsesAdapter()).buildInput(makeRequest(messages))

    expect((anthropic[0].content as Array<Record<string, unknown>>).filter((b) => b.type === 'image')).toHaveLength(2)
    expect((chat[0].content as Array<Record<string, unknown>>).filter((b) => b.type === 'image_url')).toHaveLength(2)
    expect((responses[0].content as Array<Record<string, unknown>>).filter((b) => b.type === 'input_image')).toHaveLength(2)
  })
})

describe('Cross-provider half-completed turn resilience', () => {
  test('OpenAI-family adapters ignore orphan tool_result blocks that have no matching tool_use', () => {
    const messages = [
      makeTextMessage('user', 'Start'),
      makeMessage('assistant', [{ type: 'text', text: 'No tool call was made.' }]),
      makeMessage('user', [
        {
          type: 'tool_result',
          toolUseId: 'call_orphan',
          content: 'orphan output',
        },
      ]),
    ]

    const chat = getOpenAIChatHarness(createOpenAIChatAdapter()).convertMessages(makeRequest(messages))
    const responses = getResponsesHarness(createOpenAIResponsesAdapter()).buildInput(makeRequest(messages))

    expect(chat).toEqual([
      { role: 'user', content: 'Start' },
      { role: 'assistant', content: 'No tool call was made.' },
    ])
    expect(responses).toEqual([
      { role: 'user', content: 'Start' },
      { role: 'assistant', content: 'No tool call was made.' },
    ])
  })

  test('OpenAI-family adapters serialize only tool calls that have matching tool results', () => {
    const pairedId = 'call_paired'
    const danglingId = 'call_dangling'
    const messages = [
      makeTextMessage('user', 'Start'),
      makeMessage('assistant', [
        { type: 'tool_use', id: pairedId, name: 'read_file', input: { path: 'AGENTS.md' } },
        { type: 'tool_use', id: danglingId, name: 'list_dir', input: { path: '.' } },
      ]),
      makeMessage('user', [
        { type: 'tool_result', toolUseId: pairedId, content: 'paired result' },
      ]),
    ]

    const chat = getOpenAIChatHarness(createOpenAIChatAdapter()).convertMessages(makeRequest(messages))
    const responses = getResponsesHarness(createOpenAIResponsesAdapter()).buildInput(makeRequest(messages))

    expect(chat).toEqual([
      { role: 'user', content: 'Start' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: pairedId,
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"path":"AGENTS.md"}',
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: pairedId, content: 'paired result' },
    ])
    expect(responses).toEqual([
      { role: 'user', content: 'Start' },
      {
        type: 'function_call',
        id: `fc_${pairedId}`,
        call_id: pairedId,
        name: 'read_file',
        arguments: '{"path":"AGENTS.md"}',
      },
      { type: 'function_call_output', call_id: pairedId, output: 'paired result' },
    ])
  })

  test('all adapters tolerate consecutive assistant turns without crashing', () => {
    const messages = [
      makeTextMessage('user', 'Start'),
      makeTextMessage('assistant', 'First assistant turn'),
      makeTextMessage('assistant', 'Second assistant turn'),
    ]

    expect(() =>
      getAnthropicHarness(createAnthropicAdapter()).convertMessages(makeRequest(messages)),
    ).not.toThrow()
    expect(() =>
      getOpenAIChatHarness(createOpenAIChatAdapter()).convertMessages(makeRequest(messages)),
    ).not.toThrow()
    expect(() =>
      getResponsesHarness(createOpenAIResponsesAdapter()).buildInput(makeRequest(messages)),
    ).not.toThrow()
  })

  test('all adapters tolerate assistant messages with empty content', () => {
    const messages = [makeTextMessage('user', 'Start'), makeMessage('assistant', [])]

    expect(getAnthropicHarness(createAnthropicAdapter()).convertMessages(makeRequest(messages))).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Start' }] },
      { role: 'assistant', content: [] },
    ])
    expect(getOpenAIChatHarness(createOpenAIChatAdapter()).convertMessages(makeRequest(messages))).toEqual([
      { role: 'user', content: 'Start' },
      { role: 'assistant', content: '' },
    ])
    expect(getResponsesHarness(createOpenAIResponsesAdapter()).buildInput(makeRequest(messages))).toEqual([
      { role: 'user', content: 'Start' },
    ])
  })
})

describe('Cross-provider fallback and history continuity', () => {
  test('fallback returns an adapter instance for the target provider', async () => {
    const config: SystemConfig = {
      providers: {
        anthropic: {
          apiType: 'anthropic_messages',
          baseUrl: 'https://api.anthropic.test',
          auth: { type: 'api_key', apiKeyRef: 'anthropic_key' },
          models: {
            primary: {
              modelId: 'claude-primary',
              maxContext: 200000,
              maxOutput: 8192,
              capabilities: ['tools'],
              tags: ['primary'],
            },
          },
        },
        'openai-chat': {
          apiType: 'openai_chat_completions',
          baseUrl: 'https://api.openai.test',
          auth: { type: 'api_key', apiKeyRef: 'openai_key' },
          models: {
            backup: {
              modelId: 'gpt-chat-backup',
              maxContext: 200000,
              maxOutput: 8192,
              capabilities: ['tools'],
              tags: ['backup'],
            },
          },
        },
      },
      defaultModel: 'anthropic/primary',
      fallbackChain: ['anthropic/primary', 'openai-chat/backup'],
      schedules: [],
      fuseList: [],
    }

    const router = new ModelRouter(
      config,
      new Map([
        ['anthropic_key', 'sk-anthropic'],
        ['openai_key', 'sk-openai'],
      ]),
    )

    router.init()
    const primary = router.getRegistry().resolve('anthropic/primary')
    const backup = router.getRegistry().resolve('openai-chat/backup')

    if (!primary || !backup) {
      throw new Error('Failed to resolve fallback continuity models')
    }

    primary.adapter.healthCheck = async () => false
    backup.adapter.healthCheck = async () => true

    const result = await router.fallback()
    const activeAdapter = router.getAdapter()

    expect(result.success).toBe(true)
    expect(result.model?.providerName).toBe('openai-chat')
    expect(activeAdapter).toBeInstanceOf(OpenAIChatAdapter)
  })

  test('the same message history remains convertible after fallback to a new adapter', () => {
    const toolId = `call_${generateId()}`
    const messages = [
      makeTextMessage('user', 'Start'),
      makeMessage('assistant', [
        { type: 'text', text: 'Calling tool.' },
        { type: 'tool_use', id: toolId, name: 'read_file', input: { path: 'AGENTS.md' } },
      ]),
      makeMessage('user', [
        {
          type: 'tool_result',
          toolUseId: toolId,
          content: 'file content',
        },
      ]),
      makeTextMessage('assistant', 'Here is the result.'),
    ]

    const anthropic = getAnthropicHarness(createAnthropicAdapter()).convertMessages(makeRequest(messages))
    const chat = getOpenAIChatHarness(createOpenAIChatAdapter()).convertMessages(makeRequest(messages))

    expect(anthropic).toHaveLength(4)
    expect(chat).toEqual([
      { role: 'user', content: 'Start' },
      {
        role: 'assistant',
        content: 'Calling tool.',
        tool_calls: [
          {
            id: toolId,
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"AGENTS.md"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: toolId, content: 'file content' },
      { role: 'assistant', content: 'Here is the result.' },
    ])
  })
})
