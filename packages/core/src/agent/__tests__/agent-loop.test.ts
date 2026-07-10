import { describe, expect, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  StreamEvent,
  ToolLogger,
} from '@zero-os/shared'
import { AgentLoop, type ToolExecutor } from '../agent-loop'

class ScriptedAdapter implements ProviderAdapter {
  private cursor = 0
  requests: CompletionRequest[] = []

  constructor(
    private readonly responses: CompletionResponse[],
    readonly apiType = 'fake-agent-loop',
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request)
    const response = this.responses[this.cursor]
    this.cursor++
    if (!response) {
      throw new Error('No scripted response available')
    }
    return response
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request)
    yield {
      type: 'done',
      data: { finishReason: 'end_turn' },
    }
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

class DeepSeekStreamAdapter implements ProviderAdapter {
  readonly apiType = 'anthropic-deepseek'
  completeCalls = 0
  streamCalls = 0
  requests: CompletionRequest[] = []

  constructor(
    private readonly streamScripts: StreamEvent[][],
    private readonly completeResponse: CompletionResponse | Error = new Error(
      'complete should not be called for signed DeepSeek streams',
    ),
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.completeCalls++
    this.requests.push(request)
    if (this.completeResponse instanceof Error) throw this.completeResponse
    return this.completeResponse
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    this.streamCalls++
    this.requests.push(request)
    for (const event of this.streamScripts[this.streamCalls - 1] ?? []) {
      yield event
    }
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

const logger: ToolLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

function createLoop(
  responses: CompletionResponse[],
  toolExecutor: ToolExecutor,
  overrides: Partial<ConstructorParameters<typeof AgentLoop>[0]> = {},
) {
  const adapter = new ScriptedAdapter(responses)
  return new AgentLoop(
    {
      adapter,
      sessionId: 'sess-agent-loop',
      toolExecutor,
      system: 'test system',
      tools: [
        {
          name: 'noop',
          description: 'Noop tool',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      ],
      stream: false,
      logger,
      ...overrides,
    },
    {
      onEndTurn: () => ({ action: 'break' }),
    },
  )
}

function createNoopExecutor(onExecute?: () => void): ToolExecutor {
  return {
    has: (toolName) => toolName === 'noop',
    execute: async () => {
      onExecute?.()
      return {
        success: true,
        output: 'tool output',
        outputSummary: 'tool output',
      }
    },
  }
}

function createDeepSeekStreamLoop(
  adapter: ProviderAdapter,
  toolExecutor: ToolExecutor = createNoopExecutor(),
  overrides: Partial<ConstructorParameters<typeof AgentLoop>[0]> = {},
): AgentLoop {
  return createLoop([], toolExecutor, {
    adapter,
    stream: true,
    ...overrides,
  })
}

describe('AgentLoop', () => {
  test('returns user and assistant messages for a direct end_turn response', async () => {
    const loop = createLoop(
      [
        {
          id: 'resp_final',
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'end_turn',
          usage: { input: 2, output: 2 },
          model: 'fake-model',
        },
      ],
      {
        has: () => true,
        execute: async () => ({ success: true, output: 'ok', outputSummary: 'ok' }),
      },
    )

    const messages = await loop.run('hello', [])

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(messages[1]?.content).toEqual([{ type: 'text', text: 'done' }])
  })

  test('uses a prebuilt user message when one is provided', async () => {
    const loop = createLoop(
      [
        {
          id: 'resp_final',
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'end_turn',
          usage: { input: 2, output: 2 },
          model: 'fake-model',
        },
      ],
      {
        has: () => true,
        execute: async () => ({ success: true, output: 'ok', outputSummary: 'ok' }),
      },
    )

    const userMessage = {
      id: 'msg_prebuilt',
      sessionId: 'sess-agent-loop',
      role: 'user' as const,
      messageType: 'message' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
      createdAt: '2026-03-29T06:16:58.894Z',
    }

    const messages = await loop.run('hello', [], undefined, userMessage)

    expect(messages[0]).toEqual(userMessage)
    expect(messages[1]?.content).toEqual([{ type: 'text', text: 'done' }])
  })

  test('builds image-only user messages without empty text blocks', async () => {
    const adapter = new ScriptedAdapter([
      {
        id: 'resp_final',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { input: 2, output: 2 },
        model: 'fake-model',
      },
    ])
    const loop = new AgentLoop(
      {
        adapter,
        sessionId: 'sess-agent-loop',
        toolExecutor: createNoopExecutor(),
        system: 'test system',
        tools: [],
        stream: false,
        logger,
      },
      {
        onEndTurn: () => ({ action: 'break' }),
      },
    )

    const messages = await loop.run('', [], [{ mediaType: 'image/png', data: 'aW1n' }])

    expect(messages[0]?.content).toEqual([{ type: 'image', mediaType: 'image/png', data: 'aW1n' }])
    expect(adapter.requests[0]?.messages[0]?.content).toEqual([
      { type: 'image', mediaType: 'image/png', data: 'aW1n' },
    ])
  })

  test('can prefix image-only delegated requests without retaining empty text blocks', async () => {
    const adapter = new ScriptedAdapter([
      {
        id: 'resp_final',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { input: 2, output: 2 },
        model: 'fake-model',
      },
    ])
    const loop = new AgentLoop(
      {
        adapter,
        sessionId: 'sess-agent-loop',
        toolExecutor: createNoopExecutor(),
        system: 'test system',
        tools: [],
        stream: false,
        logger,
      },
      {
        buildRequestUserContent: (content: ContentBlock[]) => [
          { type: 'text', text: '<image_delegation>paths</image_delegation>' },
          ...content.filter((block) => block.type !== 'image'),
        ],
        onEndTurn: () => ({ action: 'break' }),
      },
    )

    const messages = await loop.run('', [], [{ mediaType: 'image/png', data: 'aW1n' }])

    expect(messages[0]?.content).toEqual([{ type: 'image', mediaType: 'image/png', data: 'aW1n' }])
    expect(adapter.requests[0]?.messages[0]?.content).toEqual([
      { type: 'text', text: '<image_delegation>paths</image_delegation>' },
    ])
  })

  test('loops through tool_use, tool_result, then final assistant reply', async () => {
    const toolCalls: string[] = []
    const loop = createLoop(
      [
        {
          id: 'resp_tool',
          content: [{ type: 'tool_use', id: 'call_1', name: 'noop', input: {} }],
          stopReason: 'tool_use',
          usage: { input: 3, output: 1 },
          model: 'fake-model',
        },
        {
          id: 'resp_final',
          content: [{ type: 'text', text: 'finished' }],
          stopReason: 'end_turn',
          usage: { input: 4, output: 2 },
          model: 'fake-model',
        },
      ],
      {
        has: (toolName) => toolName === 'noop',
        execute: async (toolName) => {
          toolCalls.push(toolName)
          return {
            success: true,
            output: 'tool output',
            outputSummary: 'tool output',
          }
        },
      },
    )

    const messages = await loop.run('run tool', [])

    expect(toolCalls).toEqual(['noop'])
    expect(
      messages.some((message) => message.content.some((block) => block.type === 'tool_result')),
    ).toBe(true)
    expect(messages.at(-1)?.content).toEqual([{ type: 'text', text: 'finished' }])
  })

  test('preserves DeepSeek thinking content for the next tool-call request', async () => {
    const adapter = new ScriptedAdapter(
      [
        {
          id: 'resp_tool',
          content: [
            { type: 'thinking', thinking: 'Need to call the noop tool.', signature: 'sig_1' },
            { type: 'tool_use', id: 'call_1', name: 'noop', input: {} },
          ],
          stopReason: 'tool_use',
          usage: { input: 3, output: 1 },
          model: 'deepseek-v4-pro',
          reasoningContent: 'Need to call the noop tool.',
        },
        {
          id: 'resp_final',
          content: [{ type: 'text', text: 'finished' }],
          stopReason: 'end_turn',
          usage: { input: 4, output: 2 },
          model: 'deepseek-v4-pro',
        },
      ],
      'anthropic-deepseek',
    )
    const loop = new AgentLoop(
      {
        adapter,
        sessionId: 'sess-agent-loop',
        toolExecutor: {
          has: (toolName) => toolName === 'noop',
          execute: async () => ({
            success: true,
            output: 'tool output',
            outputSummary: 'tool output',
          }),
        },
        system: 'test system',
        tools: [
          {
            name: 'noop',
            description: 'Noop tool',
            parameters: { type: 'object', properties: {} },
          },
        ],
        stream: false,
        reasoningEffort: 'high',
        logger,
      },
      {
        onEndTurn: () => ({ action: 'break' }),
      },
    )

    const messages = await loop.run('run tool', [])
    const assistantWithTool = messages.find((message) =>
      message.content.some((block) => block.type === 'tool_use'),
    )
    const secondRequestAssistant = adapter.requests[1].messages.find((message) =>
      message.content.some((block) => block.type === 'tool_use'),
    )

    expect(adapter.requests[0].reasoningEffort).toBe('high')
    expect(assistantWithTool?.content[0]).toEqual({
      type: 'thinking',
      thinking: 'Need to call the noop tool.',
      signature: 'sig_1',
    })
    expect(secondRequestAssistant?.content[0]).toEqual({
      type: 'thinking',
      thinking: 'Need to call the noop tool.',
      signature: 'sig_1',
    })
    expect(secondRequestAssistant?.content[1]).toEqual({
      type: 'tool_use',
      id: 'call_1',
      name: 'noop',
      input: {},
    })
  })

  test('rejects DeepSeek streaming tool_use responses without signed thinking', async () => {
    const adapter = new DeepSeekStreamAdapter([
      [
        { type: 'text_delta', data: { text: 'I will call the tool.' } },
        { type: 'tool_use_start', data: { id: 'call_1', name: 'noop' } },
        { type: 'tool_use_delta', data: { arguments: '{}' } },
        { type: 'tool_use_end', data: { id: 'call_1' } },
        {
          type: 'done',
          data: {
            finishReason: 'tool_use',
            usage: { input: 3, output: 2 },
            model: 'deepseek-v4-pro',
          },
        },
      ],
    ])
    let executed = false
    const loop = createDeepSeekStreamLoop(
      adapter,
      createNoopExecutor(() => {
        executed = true
      }),
    )

    await expect(loop.run('run tool', [])).rejects.toThrow('missing signed thinking content')
    expect(adapter.completeCalls).toBe(0)
    expect(executed).toBe(false)
  })

  test('keeps signed DeepSeek streaming tool_use responses without non-streaming fallback', async () => {
    const adapter = new DeepSeekStreamAdapter([
      [
        { type: 'reasoning_delta', data: { text: 'Need to call the noop tool.' } },
        { type: 'reasoning_signature', data: { signature: 'sig_stream' } },
        { type: 'tool_use_start', data: { id: 'call_1', name: 'noop' } },
        { type: 'tool_use_delta', data: { arguments: '{}' } },
        { type: 'tool_use_end', data: { id: 'call_1' } },
        {
          type: 'done',
          data: {
            finishReason: 'tool_use',
            usage: { input: 3, output: 2 },
            model: 'deepseek-v4-pro',
          },
        },
      ],
      [
        { type: 'text_delta', data: { text: 'finished' } },
        {
          type: 'done',
          data: {
            finishReason: 'end_turn',
            usage: { input: 5, output: 1 },
            model: 'deepseek-v4-pro',
          },
        },
      ],
    ])
    const warnings: Array<{ event: string; data?: Record<string, unknown> }> = []
    const loop = createDeepSeekStreamLoop(adapter, createNoopExecutor(), {
      logger: {
        info: () => {},
        warn: (event, data) => warnings.push({ event, data }),
        error: () => {},
      },
    })

    const messages = await loop.run('run tool', [])
    const assistantWithTool = messages.find((message) =>
      message.content.some((block) => block.type === 'tool_use'),
    )

    expect(adapter.streamCalls).toBe(2)
    expect(adapter.completeCalls).toBe(0)
    expect(
      warnings.some(
        (warning) => warning.event === 'llm_stream_missing_thinking_fallback_to_complete',
      ),
    ).toBe(false)
    expect(assistantWithTool?.content[0]).toEqual({
      type: 'thinking',
      thinking: 'Need to call the noop tool.',
      signature: 'sig_stream',
    })
  })

  test('keeps signed DeepSeek streaming final responses instead of synthesizing unsigned thinking', async () => {
    const adapter = new DeepSeekStreamAdapter([
      [
        { type: 'reasoning_delta', data: { text: 'Ready to answer.' } },
        { type: 'reasoning_signature', data: { signature: 'sig_final_stream' } },
        { type: 'text_delta', data: { text: 'finished' } },
        {
          type: 'done',
          data: {
            finishReason: 'end_turn',
            usage: { input: 3, output: 2 },
            model: 'deepseek-v4-pro',
          },
        },
      ],
    ])
    const loop = createDeepSeekStreamLoop(
      adapter,
      {
        has: () => false,
        execute: async () => ({
          success: true,
          output: 'tool output',
          outputSummary: 'tool output',
        }),
      },
      { tools: [] },
    )

    const messages = await loop.run('answer directly', [])
    const assistant = messages.find((message) => message.role === 'assistant')

    expect(adapter.completeCalls).toBe(0)
    expect(assistant?.content).toEqual([
      { type: 'thinking', thinking: 'Ready to answer.', signature: 'sig_final_stream' },
      { type: 'text', text: 'finished' },
    ])
  })

  test('rejects DeepSeek tool_use responses that still lack thinking after completion', async () => {
    const adapter = new ScriptedAdapter(
      [
        {
          id: 'resp_tool',
          content: [{ type: 'tool_use', id: 'call_1', name: 'noop', input: {} }],
          stopReason: 'tool_use',
          usage: { input: 3, output: 1 },
          model: 'deepseek-v4-pro',
        },
      ],
      'anthropic-deepseek',
    )
    let executed = false
    const loop = createLoop(
      [],
      createNoopExecutor(() => {
        executed = true
      }),
      { adapter },
    )

    await expect(loop.run('run tool', [])).rejects.toThrow('missing signed thinking content')
    expect(executed).toBe(false)
  })

  test('rejects DeepSeek tool_use responses with unsigned thinking after completion', async () => {
    const adapter = new ScriptedAdapter(
      [
        {
          id: 'resp_tool',
          content: [
            { type: 'thinking', thinking: 'Need to call a tool.' },
            { type: 'tool_use', id: 'call_1', name: 'noop', input: {} },
          ],
          stopReason: 'tool_use',
          usage: { input: 3, output: 1 },
          model: 'deepseek-v4-pro',
        },
      ],
      'anthropic-deepseek',
    )
    let executed = false
    const loop = createLoop(
      [],
      createNoopExecutor(() => {
        executed = true
      }),
      { adapter },
    )

    await expect(loop.run('run tool', [])).rejects.toThrow('missing signed thinking content')
    expect(executed).toBe(false)
  })

  test('preserves structured tool result content items in the loop history', async () => {
    const loop = createLoop(
      [
        {
          id: 'resp_tool',
          content: [{ type: 'tool_use', id: 'call_image', name: 'noop', input: {} }],
          stopReason: 'tool_use',
          usage: { input: 3, output: 1 },
          model: 'fake-model',
        },
        {
          id: 'resp_final',
          content: [{ type: 'text', text: 'finished' }],
          stopReason: 'end_turn',
          usage: { input: 4, output: 2 },
          model: 'fake-model',
        },
      ],
      {
        has: (toolName) => toolName === 'noop',
        execute: async () => ({
          success: true,
          output: 'Read image /tmp/example.png (image/png, 3 bytes)',
          outputSummary: 'Read image /tmp/example.png (image/png, 3 bytes)',
          contentItems: [{ type: 'image', mediaType: 'image/png', data: 'aW1n' }],
        }),
      },
    )

    const messages = await loop.run('run image tool', [])
    const toolResultMessage = messages.find((message) =>
      message.content.some((block) => block.type === 'tool_result'),
    )

    expect(toolResultMessage?.content).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        toolUseId: 'call_image',
        contentItems: [{ type: 'image', mediaType: 'image/png', data: 'aW1n' }],
      }),
    ])
  })

  test('stops when maxIterations is reached', async () => {
    const loop = createLoop(
      [
        {
          id: 'resp_tool',
          content: [{ type: 'tool_use', id: 'call_1', name: 'noop', input: {} }],
          stopReason: 'tool_use',
          usage: { input: 3, output: 1 },
          model: 'fake-model',
        },
      ],
      {
        has: () => true,
        execute: async () => ({
          success: true,
          output: 'tool output',
          outputSummary: 'tool output',
        }),
      },
      { maxIterations: 1 },
    )

    const messages = await loop.run('run tool', [])

    expect(messages).toHaveLength(3)
    expect(messages.at(-1)?.content[0]).toMatchObject({
      type: 'tool_result',
      content: 'tool output',
    })
  })

  test('retries once on empty responses before succeeding', async () => {
    const loop = createLoop(
      [
        {
          id: 'resp_empty',
          content: [],
          stopReason: 'end_turn',
          usage: { input: 0, output: 0 },
          model: 'fake-model',
        },
        {
          id: 'resp_final',
          content: [{ type: 'text', text: 'recovered' }],
          stopReason: 'end_turn',
          usage: { input: 3, output: 1 },
          model: 'fake-model',
        },
      ],
      {
        has: () => true,
        execute: async () => ({ success: true, output: 'ok', outputSummary: 'ok' }),
      },
    )

    const messages = await loop.run('hello', [])

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(messages.some((message) => message.controlKind === 'empty_retry')).toBe(false)
    expect(messages.at(-1)?.content).toEqual([{ type: 'text', text: 'recovered' }])
  })

  test('ends normally after repeated completed responses with no assistant content', async () => {
    const emptyResponse: CompletionResponse = {
      id: 'resp_empty',
      content: [],
      stopReason: 'end_turn',
      usage: { input: 0, output: 0 },
      model: 'fake-model',
    }
    const loop = createLoop(
      [emptyResponse, { ...emptyResponse, id: 'resp_empty_again' }],
      createNoopExecutor(),
    )

    const messages = await loop.run('hello', [])

    expect(messages.map((message) => message.role)).toEqual(['user'])
    expect(messages.some((message) => message.controlKind === 'empty_retry')).toBe(false)
  })

  test('rejects empty responses that did not complete the turn', async () => {
    const loop = createLoop(
      [
        {
          id: 'resp_truncated',
          content: [],
          stopReason: 'max_tokens',
          usage: { input: 1, output: 0 },
          model: 'fake-model',
        },
      ],
      createNoopExecutor(),
    )

    await expect(loop.run('hello', [])).rejects.toThrow(
      'LLM returned empty response (stopReason=max_tokens)',
    )
  })

  test("supports onEmptyResponse returning 'break' to end normally", async () => {
    const loop = new AgentLoop(
      {
        adapter: new ScriptedAdapter([
          {
            id: 'resp_empty',
            content: [],
            stopReason: 'end_turn',
            usage: { input: 0, output: 0 },
            model: 'fake-model',
          },
        ]),
        sessionId: 'sess-agent-loop',
        toolExecutor: {
          has: () => true,
          execute: async () => ({ success: true, output: 'ok', outputSummary: 'ok' }),
        },
        system: 'test system',
        tools: [],
        stream: false,
        logger,
      },
      {
        onEndTurn: () => ({ action: 'break' }),
        onEmptyResponse: () => 'break',
      },
    )

    const messages = await loop.run('hello', [])

    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe('user')
  })

  test('continues with a control message when onEmptyResponse returns a continuation', async () => {
    const loop = new AgentLoop(
      {
        adapter: new ScriptedAdapter([
          {
            id: 'resp_empty',
            content: [],
            stopReason: 'end_turn',
            usage: { input: 0, output: 0 },
            model: 'fake-model',
          },
          {
            id: 'resp_after_continue',
            content: [{ type: 'text', text: 'continued after queue' }],
            stopReason: 'end_turn',
            usage: { input: 1, output: 1 },
            model: 'fake-model',
          },
        ]),
        sessionId: 'sess-agent-loop',
        toolExecutor: {
          has: () => true,
          execute: async () => ({ success: true, output: 'ok', outputSummary: 'ok' }),
        },
        system: 'test system',
        tools: [],
        stream: false,
        logger,
      },
      {
        onEndTurn: () => ({ action: 'break' }),
        onEmptyResponse: () => ({
          action: 'continue',
          continuationMessage: {
            id: 'msg_queue_continue',
            sessionId: 'sess-agent-loop',
            role: 'user',
            messageType: 'control',
            controlKind: 'queued_injection',
            content: [{ type: 'text', text: '<queued_message>queued follow-up</queued_message>' }],
            createdAt: '2026-03-30T08:00:00.000Z',
          },
        }),
      },
    )

    const messages = await loop.run('hello', [])

    expect(messages.map((message) => message.role)).toEqual(['user', 'user', 'assistant'])
    expect(messages[1]?.controlKind).toBe('queued_injection')
    expect(messages.at(-1)?.content).toEqual([{ type: 'text', text: 'continued after queue' }])
  })

  test('converts malformed tool input into a tool_result error without executing the tool', async () => {
    let executeCount = 0
    const loop = createLoop(
      [
        {
          id: 'resp_tool',
          content: [
            {
              type: 'tool_use',
              id: 'call_bad',
              name: 'noop',
              input: { __parse_error: 'Malformed JSON' },
            },
          ],
          stopReason: 'tool_use',
          usage: { input: 3, output: 1 },
          model: 'fake-model',
        },
        {
          id: 'resp_final',
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'end_turn',
          usage: { input: 3, output: 1 },
          model: 'fake-model',
        },
      ],
      {
        has: () => true,
        execute: async () => {
          executeCount++
          return { success: true, output: 'ok', outputSummary: 'ok' }
        },
      },
    )

    const messages = await loop.run('hello', [])
    const toolResultMessage = messages.find((message) =>
      message.content.some((block) => block.type === 'tool_result'),
    )

    expect(executeCount).toBe(0)
    expect(toolResultMessage?.content).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        isError: true,
        content: expect.stringContaining('Tool input JSON was malformed'),
      }),
    ])
  })

  test('converts unknown tools into tool_result errors', async () => {
    const loop = createLoop(
      [
        {
          id: 'resp_tool',
          content: [{ type: 'tool_use', id: 'call_unknown', name: 'missing', input: {} }],
          stopReason: 'tool_use',
          usage: { input: 3, output: 1 },
          model: 'fake-model',
        },
        {
          id: 'resp_final',
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'end_turn',
          usage: { input: 3, output: 1 },
          model: 'fake-model',
        },
      ],
      {
        has: () => false,
        execute: async () => ({ success: true, output: 'ok', outputSummary: 'ok' }),
      },
    )

    const messages = await loop.run('hello', [])
    const toolResultMessage = messages.find((message) =>
      message.content.some((block) => block.type === 'tool_result'),
    )

    expect(toolResultMessage?.content).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        isError: true,
        content: 'Unknown tool: missing',
      }),
    ])
  })

  test('forwards request meta from getMeta into completion requests', async () => {
    const adapter = new ScriptedAdapter([
      {
        id: 'resp_meta_001',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { input: 2, output: 1 },
        model: 'fake-model',
      },
    ])
    const loop = new AgentLoop(
      {
        adapter,
        sessionId: 'sess-agent-loop',
        toolExecutor: {
          has: () => false,
          execute: async () => ({ success: false, output: 'unused', outputSummary: 'unused' }),
        },
        system: 'test system',
        tools: [],
        stream: false,
        logger,
        getMeta: () => ({
          sessionId: 'sess-agent-loop',
          purpose: 'memory_nudge',
          parentSessionId: 'parent-agent-loop',
        }),
      },
      {
        onEndTurn: () => ({ action: 'break' }),
      },
    )

    await loop.run('hello', [])

    expect(adapter.requests[0]?.meta).toEqual({
      sessionId: 'sess-agent-loop',
      purpose: 'memory_nudge',
      parentSessionId: 'parent-agent-loop',
    })
  })
})
