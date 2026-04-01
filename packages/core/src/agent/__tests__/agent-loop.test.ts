import { describe, expect, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import type {
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  ToolLogger,
} from '@zero-os/shared'
import { EMPTY_RESPONSE_RETRY_PROMPT } from '../../constants'
import { AgentLoop, type ToolExecutor } from '../agent-loop'

class ScriptedAdapter implements ProviderAdapter {
  readonly apiType = 'fake-agent-loop'
  private cursor = 0
  requests: CompletionRequest[] = []

  constructor(private readonly responses: CompletionResponse[]) {}

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

    expect(messages.map((message) => message.role)).toEqual(['user', 'user', 'assistant'])
    expect(messages[1]?.messageType).toBe('control')
    expect(messages[1]?.controlKind).toBe('empty_retry')
    expect(messages[1]?.content).toEqual([{ type: 'text', text: EMPTY_RESPONSE_RETRY_PROMPT }])
    expect(messages.at(-1)?.content).toEqual([{ type: 'text', text: 'recovered' }])
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
