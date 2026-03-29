import { describe, expect, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import { Tracer } from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  ToolContext,
  ToolResult,
} from '@zero-os/shared'
import { BaseTool } from '../../tool/base'
import { ToolRegistry } from '../../tool/registry'
import { Agent, type AgentContext } from '../agent'

async function* failStream(error: Error): AsyncIterable<StreamEvent> {
  yield* []
  throw error
}

class StreamingOnlyAdapter implements ProviderAdapter {
  readonly apiType = 'fake-streaming'

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    return {
      id: 'resp-fallback',
      content: [{ type: 'text', text: 'fallback' }],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
      model: 'fake',
    }
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield { type: 'text_delta', data: { text: 'hello' } }
    yield { type: 'text_delta', data: { text: ' world' } }
    yield {
      type: 'done',
      data: { finishReason: 'end_turn', usage: { input: 3, output: 2 }, model: 'fake' },
    }
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

class ReasoningStreamingAdapter implements ProviderAdapter {
  readonly apiType = 'fake-reasoning'

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    return {
      id: 'resp-reasoning',
      content: [{ type: 'text', text: 'fallback' }],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1, reasoning: 2 },
      model: 'fake-reasoning',
      reasoningContent: 'fallback reasoning',
    }
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield { type: 'reasoning_delta', data: { text: 'step 1. ' } }
    yield { type: 'reasoning_delta', data: { text: 'step 2.' } }
    yield { type: 'text_delta', data: { text: 'visible answer' } }
    yield {
      type: 'done',
      data: {
        finishReason: 'end_turn',
        usage: { input: 3, output: 2, reasoning: 7 },
        model: 'fake-reasoning',
      },
    }
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

class FallbackAdapter implements ProviderAdapter {
  readonly apiType = 'fake-fallback'
  completeCalls = 0

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    this.completeCalls += 1
    return {
      id: 'resp-fallback',
      content: [{ type: 'text', text: 'fallback worked' }],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
      model: 'fake-fallback',
    }
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* failStream(new Error('stream failed'))
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

class NoopTool extends BaseTool {
  name = 'noop'
  description = 'Returns ok'
  parameters = { type: 'object', properties: {} }

  protected async execute(_ctx: ToolContext, _input: unknown): Promise<ToolResult> {
    return { success: true, output: 'ok', outputSummary: 'ok' }
  }
}

class ToolLoopAdapter implements ProviderAdapter {
  readonly apiType = 'fake-tool-loop'
  completeCalls = 0

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    this.completeCalls += 1

    if (this.completeCalls === 1) {
      return {
        id: 'resp_tool_1',
        content: [{ type: 'tool_use', id: 'call_1', name: 'noop', input: {} }],
        stopReason: 'tool_use',
        usage: { input: 5, output: 2 },
        model: 'fake-tool-loop',
      }
    }

    if (this.completeCalls === 2) {
      return {
        id: 'resp_tool_2',
        content: [{ type: 'tool_use', id: 'call_2', name: 'noop', input: {} }],
        stopReason: 'tool_use',
        usage: { input: 6, output: 2 },
        model: 'fake-tool-loop',
      }
    }

    return {
      id: 'resp_final',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { input: 7, output: 3 },
      model: 'fake-tool-loop',
    }
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* failStream(new Error('stream failed'))
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

class QueuedInjectionAdapter implements ProviderAdapter {
  readonly apiType = 'fake-queued-injection'
  completeCalls = 0

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    this.completeCalls += 1

    if (this.completeCalls === 1) {
      return {
        id: 'resp_queue_1',
        content: [{ type: 'tool_use', id: 'call_queue_1', name: 'noop', input: {} }],
        stopReason: 'tool_use',
        usage: { input: 4, output: 2 },
        model: 'fake-queued-injection',
      }
    }

    return {
      id: 'resp_queue_2',
      content: [{ type: 'text', text: 'handled queued message，已完成' }],
      stopReason: 'end_turn',
      usage: { input: 6, output: 3 },
      model: 'fake-queued-injection',
    }
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* failStream(new Error('stream failed'))
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

class AnthropicFailingAdapter implements ProviderAdapter {
  readonly apiType = 'anthropic_messages'
  completeCalls = 0

  constructor(private streamError: Error & { status?: number; request_id?: string }) {}

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    this.completeCalls += 1
    return {
      id: 'resp-should-not-run',
      content: [{ type: 'text', text: 'unexpected fallback' }],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
      model: 'claude-test',
    }
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* failStream(this.streamError)
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

class TestAgent extends Agent {
  protected transientRetryDelayMs(_attempt: number): number {
    return 0 // no wait in tests
  }
}

function createAgent(adapter: ProviderAdapter, logger?: ToolContext['logger']): Agent {
  return new TestAgent(
    {
      name: 'stream-agent',
      agentInstruction: 'test',
    },
    adapter,
    new ToolRegistry(),
    {
      sessionId: 'sess-stream',
      workDir: process.cwd(),
      logger: logger ?? { info: () => {}, warn: () => {}, error: () => {} },
    },
    {},
  )
}

function createContext(): AgentContext {
  return {
    systemPrompt: 'test',
    conversationHistory: [],
    tools: [],
  }
}

function expectDefined<T>(value: T | null | undefined): NonNullable<T> {
  expect(value).toBeDefined()
  if (value == null) {
    throw new Error('Expected value to be defined')
  }
  return value
}

describe('Agent streaming callback', () => {
  test('run emits text deltas and returns assistant text', async () => {
    const adapter = new StreamingOnlyAdapter()
    const agent = createAgent(adapter)

    const deltas: string[] = []
    const messages = await agent.run(createContext(), 'say hi', undefined, undefined, (delta) =>
      deltas.push(delta),
    )

    expect(deltas).toEqual(['hello', ' world'])

    const assistant = messages.find((m) => m.role === 'assistant')
    const text = expectDefined(assistant)
      .content.filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('')
    expect(text).toBe('hello world')
  })

  test('non-Anthropic stream errors still fallback to complete', async () => {
    const adapter = new FallbackAdapter()
    const warnings: Array<Record<string, unknown>> = []
    const agent = createAgent(adapter, {
      info: () => {},
      warn: (_event, data) => warnings.push(data ?? {}),
      error: () => {},
    })

    const messages = await agent.run(createContext(), 'say hi')
    const assistant = messages.find((m) => m.role === 'assistant')

    expect(adapter.completeCalls).toBeGreaterThanOrEqual(1)
    expect(assistant?.content).toEqual([{ type: 'text', text: 'fallback worked' }])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      apiType: 'fake-fallback',
      fallbackSkipped: false,
    })
  })

  test('Anthropic 429 errors retry with backoff then throw', async () => {
    const streamError = Object.assign(new Error('429 rate limited'), {
      status: 429,
      request_id: 'req_123',
    })
    const adapter = new AnthropicFailingAdapter(streamError)
    const warnings: Array<{ event: string; data?: Record<string, unknown> }> = []
    const agent = createAgent(adapter, {
      info: () => {},
      warn: (event, data) => warnings.push({ event, data }),
      error: () => {},
    })

    await expect(agent.run(createContext(), 'say hi')).rejects.toThrow('429 rate limited')

    expect(adapter.completeCalls).toBe(0)
    const retryWarnings = warnings.filter((w) => w.event === 'llm_stream_transient_retry')
    expect(retryWarnings).toHaveLength(3)
    expect(retryWarnings[0].data).toMatchObject({ status: 429, attempt: 1 })
    expect(
      warnings.some(
        (w) => w.event === 'llm_stream_fallback_to_complete' && w.data?.fallbackSkipped === true,
      ),
    ).toBe(true)
  })

  test('Anthropic overloaded errors retry 3 times then throw', async () => {
    const streamError = new Error(
      JSON.stringify({
        type: 'error',
        error: {
          details: null,
          type: 'overloaded_error',
          message: 'Overloaded',
        },
        request_id: 'req_456',
      }),
    )
    const adapter = new AnthropicFailingAdapter(streamError)
    const warnings: Array<{ event: string; data?: Record<string, unknown> }> = []
    const agent = createAgent(adapter, {
      info: () => {},
      warn: (event, data) => warnings.push({ event, data }),
      error: () => {},
    })

    await expect(agent.run(createContext(), 'say hi')).rejects.toThrow('Overloaded')

    expect(adapter.completeCalls).toBe(0)
    // 3 transient retries then 1 fallback warning
    const retryWarnings = warnings.filter((w) => w.event === 'llm_stream_transient_retry')
    expect(retryWarnings).toHaveLength(3)
    expect(retryWarnings[0].data).toMatchObject({ attempt: 1, maxRetries: 3 })
    expect(retryWarnings[1].data).toMatchObject({ attempt: 2, maxRetries: 3 })
    expect(retryWarnings[2].data).toMatchObject({ attempt: 3, maxRetries: 3 })
    expect(
      warnings.some(
        (w) => w.event === 'llm_stream_fallback_to_complete' && w.data?.fallbackSkipped === true,
      ),
    ).toBe(true)
  })

  test('Anthropic overloaded error recovers on retry', async () => {
    let streamCalls = 0
    const overloadedError = new Error(
      JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
        request_id: 'req_789',
      }),
    )
    const adapter: ProviderAdapter = {
      apiType: 'anthropic_messages' as const,
      async complete() {
        return {
          id: 'resp-should-not-run',
          content: [{ type: 'text' as const, text: 'unexpected' }],
          stopReason: 'end_turn' as const,
          usage: { input: 1, output: 1 },
          model: 'claude-test',
        }
      },
      async *stream() {
        streamCalls++
        if (streamCalls <= 2) {
          // First two attempts: overloaded
          yield* failStream(overloadedError)
        }
        // Third attempt: success
        yield { type: 'text_delta' as const, data: { text: 'recovered after overload' } }
        yield {
          type: 'done' as const,
          data: { finishReason: 'end_turn', usage: { input: 1, output: 3 }, model: 'claude-test' },
        }
      },
      async healthCheck() {
        return true
      },
    }

    const warnings: Array<{ event: string; data?: Record<string, unknown> }> = []
    const agent = createAgent(adapter, {
      info: () => {},
      warn: (event, data) => warnings.push({ event, data }),
      error: () => {},
    })

    const messages = await agent.run(createContext(), 'say hi')
    const assistant = messages.find((m) => m.role === 'assistant')
    const text = assistant?.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')

    expect(streamCalls).toBe(3)
    expect(text).toBe('recovered after overload')
    const retryWarnings = warnings.filter((w) => w.event === 'llm_stream_transient_retry')
    expect(retryWarnings).toHaveLength(2)
    // No fallback warning — recovered before exhausting retries
    expect(warnings.some((w) => w.event === 'llm_stream_fallback_to_complete')).toBe(false)
  })

  test('empty stream retry remains available after a transient retry', async () => {
    let streamCalls = 0
    const adapter: ProviderAdapter = {
      apiType: 'anthropic_messages' as const,
      async complete() {
        return {
          id: 'resp-should-not-run',
          content: [{ type: 'text' as const, text: 'unexpected' }],
          stopReason: 'end_turn' as const,
          usage: { input: 1, output: 1 },
          model: 'claude-test',
        }
      },
      async *stream() {
        streamCalls++

        if (streamCalls === 1) {
          yield* failStream(
            Object.assign(new Error('429 rate limited'), {
              status: 429,
              request_id: 'req_mix_1',
            }),
          )
          return
        }

        if (streamCalls === 2) {
          // This yields done without text, causing "stream returned empty content".
          yield {
            type: 'done' as const,
            data: { finishReason: 'end_turn', usage: { input: 1, output: 1 }, model: 'claude-test' },
          }
          return
        }

        yield { type: 'text_delta' as const, data: { text: 'recovered after empty retry' } }
        yield {
          type: 'done' as const,
          data: { finishReason: 'end_turn', usage: { input: 1, output: 2 }, model: 'claude-test' },
        }
      },
      async healthCheck() {
        return true
      },
    }

    const warnings: Array<{ event: string; data?: Record<string, unknown> }> = []
    const agent = createAgent(adapter, {
      info: () => {},
      warn: (event, data) => warnings.push({ event, data }),
      error: () => {},
    })

    const messages = await agent.run(createContext(), 'say hi')
    const assistant = messages.find((m) => m.role === 'assistant')
    const text = assistant?.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')

    expect(streamCalls).toBe(3)
    expect(text).toBe('recovered after empty retry')
    expect(warnings.some((w) => w.event === 'llm_stream_empty_retry')).toBe(true)
    expect(warnings.some((w) => w.event === 'llm_stream_fallback_to_complete')).toBe(false)
  })

  test('Anthropic SDK streaming guidance errors do not fallback to complete', async () => {
    const streamError = new Error(
      'Streaming is strongly recommended for operations that may take longer than 10 minutes.',
    )
    const adapter = new AnthropicFailingAdapter(streamError)
    const warnings: Array<Record<string, unknown>> = []
    const agent = createAgent(adapter, {
      info: () => {},
      warn: (_event, data) => warnings.push(data ?? {}),
      error: () => {},
    })

    await expect(agent.run(createContext(), 'say hi')).rejects.toThrow(
      'Streaming is strongly recommended',
    )

    expect(adapter.completeCalls).toBe(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      apiType: 'anthropic_messages',
      fallbackSkipped: true,
    })
  })

  test('empty stream content retries streaming before giving up', async () => {
    let streamCalls = 0
    const adapter: ProviderAdapter = {
      apiType: 'anthropic_messages',
      async complete() {
        return {
          id: 'resp-should-not-run',
          content: [{ type: 'text', text: 'unexpected' }],
          stopReason: 'end_turn',
          usage: { input: 1, output: 1 },
          model: 'claude-test',
        }
      },
      async *stream() {
        streamCalls++
        if (streamCalls === 1) {
          // First attempt: empty content (no text_delta, just done)
          yield {
            type: 'done' as const,
            data: {
              finishReason: 'end_turn',
              usage: { input: 1, output: 0 },
              model: 'claude-test',
            },
          }
          return
        }
        // Second attempt: success
        yield { type: 'text_delta' as const, data: { text: 'recovered' } }
        yield {
          type: 'done' as const,
          data: { finishReason: 'end_turn', usage: { input: 1, output: 1 }, model: 'claude-test' },
        }
      },
      async healthCheck() {
        return true
      },
    }

    const warnings: Array<{ event: string; data?: Record<string, unknown> }> = []
    const agent = createAgent(adapter, {
      info: () => {},
      warn: (event, data) => warnings.push({ event, data }),
      error: () => {},
    })

    const messages = await agent.run(createContext(), 'say hi')
    const assistant = messages.find((m) => m.role === 'assistant')
    const text = assistant?.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')

    expect(streamCalls).toBe(2)
    expect(text).toBe('recovered')
    // Should log the retry warning, not the fallback warning
    expect(warnings.some((w) => w.event === 'llm_stream_empty_retry')).toBe(true)
    expect(warnings.some((w) => w.event === 'llm_stream_fallback_to_complete')).toBe(false)
  })

  test('Anthropic empty stream exhausts retries then throws', async () => {
    const adapter: ProviderAdapter = {
      apiType: 'anthropic_messages',
      async complete() {
        return {
          id: 'resp-should-not-run',
          content: [{ type: 'text', text: 'unexpected' }],
          stopReason: 'end_turn',
          usage: { input: 1, output: 1 },
          model: 'claude-test',
        }
      },
      async *stream() {
        // Always return empty
        yield {
          type: 'done' as const,
          data: { finishReason: 'end_turn', usage: { input: 1, output: 0 }, model: 'claude-test' },
        }
      },
      async healthCheck() {
        return true
      },
    }

    const warnings: Array<{ event: string; data?: Record<string, unknown> }> = []
    const agent = createAgent(adapter, {
      info: () => {},
      warn: (event, data) => warnings.push({ event, data }),
      error: () => {},
    })

    await expect(agent.run(createContext(), 'say hi')).rejects.toThrow(
      'stream returned empty content',
    )
    // Retry warning logged, then fallback warning with fallbackSkipped=true
    expect(warnings.some((w) => w.event === 'llm_stream_empty_retry')).toBe(true)
    expect(
      warnings.some(
        (w) => w.event === 'llm_stream_fallback_to_complete' && w.data?.fallbackSkipped === true,
      ),
    ).toBe(true)
  })

  test('reasoning deltas are aggregated and logged to session requests', async () => {
    const tracer = new Tracer()
    const adapter = new ReasoningStreamingAdapter()
    const agent = new Agent(
      {
        name: 'stream-agent',
        agentInstruction: 'test',
      },
      adapter,
      new ToolRegistry(),
      {
        sessionId: 'sess-stream',
        workDir: process.cwd(),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        tracer,
      },
      {
        tracer,
      },
    )

    const messages = await agent.run(createContext(), 'reason please')
    const assistant = messages.find((m) => m.role === 'assistant')
    const visibleText = assistant?.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
    const entries = getRequestEntries(tracer, 'sess-stream')

    expect(visibleText).toBe('visible answer')
    expect(entries).toHaveLength(1)
    expect(entries[0].agentName).toBe('stream-agent')
    expect(entries[0].reasoningContent).toBe('step 1. step 2.')
    expect(entries[0].toolCalls).toEqual([])
    expect(entries[0].toolNames).toEqual([])
    expect(entries[0].toolDefinitionsHash).toBeUndefined()
    expect(entries[0].systemHash).toBeDefined()
    expect(entries[0].staticPrefixHash).toBeDefined()
    expect(entries[0].toolResults).toEqual([])
    expect(entries[0].messageCount).toBe(1)
    expect((entries[0].tokens as Record<string, unknown>).reasoning).toBe(7)
  })

  test('tool_use retries share turnIndex and chain parentId to the prior response id', async () => {
    const tracer = new Tracer()
    const adapter = new ToolLoopAdapter()
    const registry = new ToolRegistry()
    registry.register(new NoopTool())
    const agent = new Agent(
      {
        name: 'stream-agent',
        agentInstruction: 'test',
        promptMode: 'minimal',
      },
      adapter,
      registry,
      {
        sessionId: 'sess-stream',
        workDir: process.cwd(),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        tracer,
      },
      {
        tracer,
      },
    )

    const messages = await agent.run(
      createContext(),
      'use tools',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        turnIndex: 4,
      },
    )

    expect(messages.at(-1)?.role).toBe('assistant')
    const entries = getRequestEntries(tracer, 'sess-stream')
    expect(entries).toHaveLength(3)
    expect(entries.map((entry) => entry.agentName)).toEqual([
      'stream-agent',
      'stream-agent',
      'stream-agent',
    ])
    expect(entries.map((entry) => entry.turnIndex)).toEqual([4, 4, 4])
    expect(entries.map((entry) => entry.parentId ?? null)).toEqual([
      null,
      'resp_tool_1',
      'resp_tool_2',
    ])
    expect(entries.map((entry) => entry.id)).toEqual(['resp_tool_1', 'resp_tool_2', 'resp_final'])
    expect(entries.map((entry) => entry.toolCalls)).toEqual([
      [{ id: 'call_1', name: 'noop', input: {} }],
      [{ id: 'call_2', name: 'noop', input: {} }],
      [],
    ])
    expect(entries.map((entry) => entry.toolResults)).toEqual([
      [],
      [
        {
          type: 'tool_result',
          toolUseId: 'call_1',
          content: 'ok',
          isError: false,
          outputSummary: 'ok',
        },
      ],
      [
        {
          type: 'tool_result',
          toolUseId: 'call_2',
          content: 'ok',
          isError: false,
          outputSummary: 'ok',
        },
      ],
    ])
  })

  test('queued message injections are logged on the matching llm_request span', async () => {
    const tracer = new Tracer()
    const adapter = new QueuedInjectionAdapter()
    const registry = new ToolRegistry()
    registry.register(new NoopTool())
    const secretFilter = {
      filter(text: string) {
        return text.replace(/SECRET/gi, '[redacted]')
      },
      addSecret() {},
      removeSecret() {},
    }
    const agent = new Agent(
      {
        name: 'stream-agent',
        agentInstruction: 'test',
        promptMode: 'minimal',
      },
      adapter,
      registry,
      {
        sessionId: 'sess-stream',
        workDir: process.cwd(),
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        tracer,
      },
      {
        tracer,
        secretFilter,
      },
    )

    await agent.run(
      createContext(),
      'use tools',
      undefined,
      undefined,
      undefined,
      undefined,
      () => [
        {
          content: 'queued SECRET update',
          timestamp: '2026-03-17T09:43:00.000Z',
          images: [{ mediaType: 'image/png', data: 'SECRET_IMAGE_DATA' }],
        },
      ],
    )

    const entries = getRequestEntries(tracer, 'sess-stream')
    expect(entries).toHaveLength(2)
    expect(entries[0].queuedInjection).toBeUndefined()
    expect(entries[1].queuedInjection).toEqual({
      count: 1,
      formattedText: `<queued_message>
以下是你执行任务期间用户发来的消息。
如果这是状态查询，用 1-2 句简短回应后继续当前任务。
如果这是补充约束，将其纳入后续执行并继续当前任务。
如果这是停止、暂停、审计或明确禁止继续的请求，在当前工具结束后的下一个安全检查点停止新增工具调用，并汇报当前进度与恢复点。
不要因为这条消息向用户请求“继续”或额外许可。
---
queued [redacted] update
</queued_message>`,
      messages: [
        {
          timestamp: '2026-03-17T09:43:00.000Z',
          content: 'queued [redacted] update',
          imageCount: 1,
          mediaTypes: ['image/png'],
        },
      ],
    })
    expect(JSON.stringify(entries[1].queuedInjection)).not.toContain('SECRET_IMAGE_DATA')
  })
})

function getRequestEntries(tracer: Tracer, sessionId: string): Array<Record<string, unknown>> {
  return flattenTraceSpans(tracer.exportSession(sessionId))
    .map((span) => span.data?.request as Record<string, unknown> | undefined)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
}

function flattenTraceSpans(
  spans: Array<{ data?: Record<string, unknown>; children?: unknown[] }>,
): Array<{ data?: Record<string, unknown>; children?: unknown[] }> {
  return spans.flatMap((span) => [
    span,
    ...flattenTraceSpans(
      (span.children as
        | Array<{ data?: Record<string, unknown>; children?: unknown[] }>
        | undefined) ?? [],
    ),
  ])
}
