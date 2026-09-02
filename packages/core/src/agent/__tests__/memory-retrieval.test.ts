import { describe, expect, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import type {
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  ToolLogger,
} from '@zero-os/shared'
import { createLoopRunner, retrieveMemoriesWithDecision } from '../memory-retrieval'

class LoopRunnerAdapter implements ProviderAdapter {
  readonly apiType = 'fake-loop-runner'
  private completeCalls = 0
  seenToolResultSummary: string | undefined

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.completeCalls++

    if (this.completeCalls === 1) {
      return {
        id: 'resp_tool',
        content: [
          {
            type: 'tool_use',
            id: 'call_memory_search_1',
            name: 'memory_search',
            input: { query: 'x.com browser' },
          },
        ],
        stopReason: 'tool_use',
        usage: { input: 3, output: 1 },
        model: 'fake-model',
      }
    }

    const toolResultBlock = request.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool_result')
    if (toolResultBlock?.type === 'tool_result') {
      this.seenToolResultSummary = toolResultBlock.outputSummary
    }

    return {
      id: 'resp_final',
      content: [
        {
          type: 'text',
          text: '{"result":[{"id":"mem_x","reason":"needed"}]}',
        },
      ],
      stopReason: 'end_turn',
      usage: { input: 4, output: 2 },
      model: 'fake-model',
    }
  }

  async *stream(_request: CompletionRequest): AsyncIterable<StreamEvent> {
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

describe('createLoopRunner', () => {
  test('captures final text, tool calls, usage, and duration from AgentLoop', async () => {
    const adapter = new LoopRunnerAdapter()
    const runLoop = createLoopRunner(adapter, 'sess-memory-loop', logger)
    const longOutput = JSON.stringify({
      query: 'x.com browser',
      result: [
        {
          id: 'mem_x',
          title: 'Twitter requires browser',
          content: 'x'.repeat(400),
        },
      ],
    })

    const result = await runLoop({
      system: 'test system',
      userMessage: 'analyze x.com',
      tools: [
        {
          name: 'memory_search',
          description: 'search memories',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
            },
            required: ['query'],
          },
        },
      ],
      toolHandler: async (_toolName, input) => ({
        output:
          typeof input.query === 'string' && input.query === 'x.com browser' ? longOutput : '',
      }),
    })

    expect(result.finalText).toBe('{"result":[{"id":"mem_x","reason":"needed"}]}')
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: 'memory_search',
        input: { query: 'x.com browser' },
        output: longOutput,
      }),
    ])
    expect(adapter.seenToolResultSummary).toBeDefined()
    expect(adapter.seenToolResultSummary?.length).toBeLessThan(longOutput.length)
    expect(adapter.seenToolResultSummary).toContain('"query":"x.com browser"')
    expect(result.usage).toEqual({ input: 7, output: 3 })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })
})

describe('retrieveMemoriesWithDecision', () => {
  test('records side-loop tool calls on the trace span data', async () => {
    const adapter = new LoopRunnerAdapter()
    const updated: Array<Record<string, unknown> | undefined> = []
    const tracer = {
      startSpan: () => ({
        id: 'span-trace-1',
        sessionId: 'sess-memory-trace',
        kind: 'llm_request' as const,
        name: 'memory_retrieval_decision',
        startTime: new Date().toISOString(),
        status: 'running' as const,
        children: [],
      }),
      updateSpan: (_id: string, patch: Record<string, unknown>) => {
        updated.push(patch)
      },
      endSpan: () => {},
      getSpan: () => undefined,
    }

    const memories = await retrieveMemoriesWithDecision({
      adapter,
      sessionId: 'sess-memory-trace',
      memoryRetriever: {
        retrieve: async () => [],
        retrieveScored: async () => [
          {
            memory: {
              id: 'mem_x',
              type: 'note',
              title: 'Twitter requires browser',
              content: 'x'.repeat(400),
              createdAt: '2026-09-02T00:00:00.000Z',
              updatedAt: '2026-09-02T00:00:00.000Z',
              status: 'verified',
              confidence: 0.8,
              tags: [],
              related: [],
            },
            score: 0.9,
            scoreBreakdown: { keyword: 0, recency: 0, vector: 0.9 },
          },
        ],
      },
      userMessage: 'analyze x.com site',
      logger,
      failureEvent: 'memory_retrieval_failed',
      trace: {
        tracer,
        spanName: 'memory_retrieval_decision',
        metadata: { layer: 'layer1' },
      },
    })

    expect(memories?.map((memory) => memory.id)).toEqual(['mem_x'])
    const decision = (updated[0]?.data as { memoryRetrievalDecision?: Record<string, unknown> })
      ?.memoryRetrievalDecision
    expect(decision?.toolCalls).toEqual([
      {
        name: 'memory_search',
        input: { query: 'x.com browser' },
        output: expect.stringContaining('Twitter requires browser'),
      },
    ])
  })
})
