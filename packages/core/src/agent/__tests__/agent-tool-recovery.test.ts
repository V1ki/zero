import { describe, expect, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import { Tracer, flattenTraceSpans } from '@zero-os/observe'
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

class ThrowingTool extends BaseTool {
  name = 'explode'
  description = 'Always throws'
  parameters = {
    type: 'object',
    properties: {},
  }

  // This method is unused because run is overridden to simulate catastrophic tool failures.
  protected async execute(): Promise<ToolResult> {
    return { success: true, output: 'ok', outputSummary: 'ok' }
  }

  async run(_ctx: ToolContext, _input: unknown): Promise<ToolResult> {
    throw new Error('tool crashed unexpectedly')
  }
}

class FakeAdapter implements ProviderAdapter {
  readonly apiType = 'fake'
  private callCount = 0

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    this.callCount++
    if (this.callCount === 1) {
      return {
        id: 'resp_tool_use',
        content: [{ type: 'tool_use', id: 'call_1', name: 'explode', input: {} }],
        stopReason: 'tool_use',
        usage: { input: 10, output: 5 },
        model: 'fake-model',
      }
    }

    return {
      id: 'resp_final',
      content: [{ type: 'text', text: 'recovered' }],
      stopReason: 'end_turn',
      usage: { input: 5, output: 3 },
      model: 'fake-model',
    }
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield {
      type: 'done',
      data: { finishReason: 'end_turn' },
    }
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

class EmptyResponseRecoveryAdapter implements ProviderAdapter {
  readonly apiType = 'fake-empty'
  completeCalls = 0

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    this.completeCalls++

    if (this.completeCalls > 1) {
      return {
        id: 'resp_recovered',
        content: [{ type: 'text', text: 'recovered after empty response' }],
        stopReason: 'end_turn',
        usage: { input: 4, output: 4 },
        model: 'fake-model',
      }
    }

    return {
      id: 'resp_empty',
      content: [],
      stopReason: 'end_turn',
      usage: { input: 0, output: 0 },
      model: 'fake-model',
    }
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield {
      type: 'done',
      data: { finishReason: 'end_turn' },
    }
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

class FailingFetchTool extends BaseTool {
  name = 'fetch'
  description = 'Fails with an x.com access error'
  parameters = {
    type: 'object',
    properties: {
      url: { type: 'string' },
    },
    required: ['url'],
  }

  protected async execute(): Promise<ToolResult> {
    return {
      success: false,
      output: 'Fetch failed: login required for x.com',
      outputSummary: 'Fetch error: login required',
    }
  }
}

class MemoryHintAdapter implements ProviderAdapter {
  readonly apiType = 'fake-memory-hint'
  private completeCalls = 0
  retrievalUserMessages: string[] = []
  retrievalSystems: string[] = []

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const userText =
      req.messages[0]?.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { type: 'text'; text: string }).text)
        .join('\n') ?? ''
    this.completeCalls++

    if (this.completeCalls === 2) {
      this.retrievalUserMessages.push(userText)
      if (req.system) {
        this.retrievalSystems.push(req.system)
      }
      return {
        id: 'resp_retrieval_tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'call_memory_search_1',
            name: 'memory_search',
            input: { query: 'x.com browser login' },
          },
        ],
        stopReason: 'tool_use',
        usage: { input: 6, output: 5 },
        model: 'fake-model',
      }
    }

    if (this.completeCalls === 1) {
      return {
        id: 'resp_tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'call_fetch_1',
            name: 'fetch',
            input: { url: 'https://x.com/openai/status/1' },
          },
        ],
        stopReason: 'tool_use',
        usage: { input: 10, output: 5 },
        model: 'fake-model',
      }
    }

    if (this.completeCalls === 3) {
      return {
        id: 'resp_retrieval_final',
        content: [
          {
            type: 'text',
            text: '{"result":[{"id":"mem_x","reason":"x.com 访问需要 browser 经验"}]}',
          },
        ],
        stopReason: 'end_turn',
        usage: { input: 5, output: 4 },
        model: 'fake-model',
      }
    }

    return {
      id: 'resp_final',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { input: 5, output: 3 },
      model: 'fake-model',
    }
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield {
      type: 'done',
      data: { finishReason: 'end_turn' },
    }
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

class SimpleReplyAdapter implements ProviderAdapter {
  readonly apiType = 'fake-simple'

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    return {
      id: 'resp_simple',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { input: 4, output: 2 },
      model: 'fake-model',
    }
  }

  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield {
      type: 'done',
      data: { finishReason: 'end_turn' },
    }
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

function expectDefined<T>(value: T | null | undefined): NonNullable<T> {
  expect(value).toBeDefined()
  if (value == null) {
    throw new Error('Expected value to be defined')
  }
  return value
}

describe('Agent tool recovery', () => {
  test('run: layer1 memory injections are recorded on the request trace', async () => {
    const adapter = new SimpleReplyAdapter()
    const registry = new ToolRegistry()
    const tracer = new Tracer()

    const toolContext: ToolContext = {
      sessionId: 'test-session',
      workDir: process.cwd(),
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    }

    const agent = new Agent(
      {
        name: 'test-agent',
        agentInstruction: 'Test prompt',
        promptMode: 'minimal',
      },
      adapter,
      registry,
      toolContext,
      { tracer },
    )

    const context: AgentContext = {
      systemPrompt: 'Test prompt',
      conversationHistory: [],
      tools: registry.getDefinitions(),
      requestMemoryInjections: [
        {
          layer: 'layer1',
          source: 'retrieved_memories',
          formattedText:
            '<memory_inject layer="layer1"><retrieved_memories>demo</retrieved_memories></memory_inject>',
        },
      ],
    }

    await agent.run(context, 'Analyze this link')

    const requestSpan = flattenTraceSpans(tracer.exportSession('test-session')).find(
      (span) => span.kind === 'llm_request',
    )
    expect(requestSpan?.data?.request).toEqual(
      expect.objectContaining({
        memoryInjections: [
          {
            layer: 'layer1',
            source: 'retrieved_memories',
            formattedText:
              '<memory_inject layer="layer1"><retrieved_memories>demo</retrieved_memories></memory_inject>',
          },
        ],
      }),
    )
  })

  test('run: tool exceptions are converted into tool_result errors', async () => {
    const adapter = new FakeAdapter()
    const registry = new ToolRegistry()
    registry.register(new ThrowingTool())

    const toolContext: ToolContext = {
      sessionId: 'test-session',
      workDir: process.cwd(),
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    }

    const agent = new Agent(
      {
        name: 'test-agent',
        agentInstruction: 'Test prompt',
        promptMode: 'minimal',
      },
      adapter,
      registry,
      toolContext,
    )

    const context: AgentContext = {
      systemPrompt: 'Test prompt',
      conversationHistory: [],
      tools: registry.getDefinitions(),
    }

    const messages = await agent.run(context, 'Trigger explode tool')
    const toolResultMsg = expectDefined(
      messages.find((m) => m.content.some((b) => b.type === 'tool_result')),
    )

    const toolResult = toolResultMsg.content.find((b) => b.type === 'tool_result')
    expect(toolResult).toBeDefined()
    if (toolResult && toolResult.type === 'tool_result') {
      expect(toolResult.isError).toBe(true)
      expect(toolResult.content).toContain('tool crashed unexpectedly')
    }

    const finalAssistant = messages[messages.length - 1]
    expect(finalAssistant.role).toBe('assistant')
    expect(finalAssistant.content.some((b) => b.type === 'text')).toBe(true)
  })

  test('run: empty completion is retried instead of storing an empty assistant message', async () => {
    const adapter = new EmptyResponseRecoveryAdapter()
    const registry = new ToolRegistry()

    const toolContext: ToolContext = {
      sessionId: 'test-session',
      workDir: process.cwd(),
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    }

    const agent = new Agent(
      {
        name: 'test-agent',
        agentInstruction: 'Test prompt',
        promptMode: 'minimal',
      },
      adapter,
      registry,
      toolContext,
    )

    const context: AgentContext = {
      systemPrompt: 'Test prompt',
      conversationHistory: [],
      tools: registry.getDefinitions(),
    }

    const messages = await agent.run(context, 'Trigger empty response')
    const assistantMessages = messages.filter((m) => m.role === 'assistant')

    expect(assistantMessages).toHaveLength(1)
    expect(assistantMessages[0].content).toEqual([
      { type: 'text', text: 'recovered after empty response' },
    ])
    expect(messages.some((m) => m.role === 'assistant' && m.content.length === 0)).toBe(false)
    expect(messages.some((m) => m.controlKind === 'empty_retry')).toBe(false)
    expect(adapter.completeCalls).toBeGreaterThanOrEqual(2)
  })

  test('run: failed tool retrieval adds a notification memory hint', async () => {
    const adapter = new MemoryHintAdapter()
    const registry = new ToolRegistry()
    registry.register(new FailingFetchTool())
    const tracer = new Tracer()

    const toolContext: ToolContext = {
      sessionId: 'test-session',
      workDir: process.cwd(),
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      memoryRetriever: {
        async retrieve() {
          return []
        },
        async retrieveScored() {
          return [
            {
              memory: {
                id: 'mem_x',
                type: 'decision',
                title: 'Twitter requires browser',
                content: 'x.com 需要登录，优先使用 browser skill。',
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
                status: 'verified',
                confidence: 0.95,
                tags: ['twitter'],
                related: [],
              },
              score: 0.92,
              scoreBreakdown: {
                keyword: 0,
                recency: 1,
                vector: 0.92,
              },
            },
          ]
        },
      },
    }

    const agent = new Agent(
      {
        name: 'test-agent',
        agentInstruction: 'Test prompt',
        promptMode: 'minimal',
      },
      adapter,
      registry,
      toolContext,
      { tracer },
    )

    const context: AgentContext = {
      systemPrompt: 'Test prompt',
      conversationHistory: [],
      tools: registry.getDefinitions(),
    }

    const messages = await agent.run(context, 'Analyze this x.com link')
    const notification = messages.find((message) => message.messageType === 'notification')

    expect(notification).toBeDefined()
    expect(notification?.role).toBe('user')
    expect(notification?.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('<memory_inject layer="layer2">'),
      }),
    ])

    const requestSpans = flattenTraceSpans(tracer.exportSession('test-session')).filter(
      (span) => span.kind === 'llm_request' && span.data?.request,
    )
    expect(requestSpans).toHaveLength(2)
    expect(requestSpans[1]?.data?.request).toEqual(
      expect.objectContaining({
        memoryInjections: [
          {
            layer: 'layer2',
            source: 'memory_hint',
            formattedText: expect.stringContaining('<memory_inject layer="layer2">'),
          },
        ],
      }),
    )
    const decisionSpan = flattenTraceSpans(tracer.exportSession('test-session')).find(
      (span) => span.name === 'memory_retrieval_decision',
    )
    expect(decisionSpan?.data?.memoryRetrievalDecision).toEqual(
      expect.objectContaining({
        need: true,
        queries: ['x.com browser login'],
        searches: [
          expect.objectContaining({
            query: 'x.com browser login',
            mode: 'scored',
            options: expect.objectContaining({
              minScore: 0.5,
            }),
            resultCount: 1,
            results: [
              expect.objectContaining({
                id: 'mem_x',
                title: 'Twitter requires browser',
                score: 0.92,
                scoreBreakdown: expect.objectContaining({
                  keyword: 0,
                  recency: 1,
                  vector: 0.92,
                }),
              }),
            ],
          }),
        ],
        selectedMemoryIds: ['mem_x'],
        selectedMemories: [
          expect.objectContaining({
            id: 'mem_x',
            title: 'Twitter requires browser',
            score: 0.92,
          }),
        ],
      }),
    )
    expect(decisionSpan?.metadata).toEqual(
      expect.objectContaining({
        source: 'memory_hint',
        need: true,
        queryCount: 1,
        searchCount: 1,
        selectedCount: 1,
      }),
    )
    expect(adapter.retrievalUserMessages).toHaveLength(1)
    expect(adapter.retrievalSystems).toHaveLength(1)
    expect(adapter.retrievalSystems[0]).toContain('<already_injected_memories>')
    expect(adapter.retrievalSystems[0]).toContain('（无）')
    expect(adapter.retrievalUserMessages[0]).toContain('用户当前请求：Analyze this x.com link')
    expect(adapter.retrievalUserMessages[0]).toContain('tool: fetch')
    expect(adapter.retrievalUserMessages[0]).toContain('error_summary: Fetch error: login required')
  })

  test('run: layer2 memory hints reuse injected memory ids to avoid duplicate injection', async () => {
    const adapter = new MemoryHintAdapter()
    const registry = new ToolRegistry()
    registry.register(new FailingFetchTool())

    const toolContext: ToolContext = {
      sessionId: 'test-session',
      workDir: process.cwd(),
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      memoryRetriever: {
        async retrieve() {
          return []
        },
        async retrieveScored() {
          return [
            {
              memory: {
                id: 'mem_x',
                type: 'decision',
                title: 'Twitter requires browser',
                content: 'x.com 需要登录，优先使用 browser skill。',
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
                status: 'verified',
                confidence: 0.95,
                tags: ['twitter'],
                related: [],
              },
              score: 0.92,
              scoreBreakdown: {
                keyword: 0,
                recency: 1,
                vector: 0.92,
              },
            },
          ]
        },
      },
    }

    const agent = new Agent(
      {
        name: 'test-agent',
        agentInstruction: 'Test prompt',
      },
      adapter,
      registry,
      toolContext,
    )

    const context: AgentContext = {
      systemPrompt: 'Test prompt',
      conversationHistory: [],
      tools: registry.getDefinitions(),
      injectedMemoryIds: new Map([['mem_x', 'Twitter requires browser']]),
    }

    const messages = await agent.run(context, 'Analyze this x.com link')

    expect(messages.find((message) => message.messageType === 'notification')).toBeUndefined()
    expect(adapter.retrievalSystems).toHaveLength(1)
    expect(adapter.retrievalSystems[0]).toContain('- mem_x: Twitter requires browser')
  })
})
