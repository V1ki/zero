import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderAdapter } from '@zero-os/model'
import { SessionEventStore } from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  ToolLogger,
} from '@zero-os/shared'
import { createLoopRunner, retrieveMemoriesWithDecision } from '../memory-retrieval'
import { assembleRequest, hashRequest } from '../request-assembly'

class LoopRunnerAdapter implements ProviderAdapter {
  readonly apiType = 'fake-loop-runner'
  private completeCalls = 0
  seenToolResultSummary: string | undefined

  readonly received: string[] = []

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.completeCalls++
    this.received.push(
      hashRequest({
        system: request.system ?? '',
        toolNames: (request.tools ?? []).map((tool) => tool.name),
        messages: request.messages,
      }),
    )

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

const scoredMemory = {
  memory: {
    id: 'mem_x',
    type: 'note' as const,
    title: 'Twitter requires browser',
    content: 'x'.repeat(400),
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    status: 'verified' as const,
    confidence: 0.8,
    tags: [],
    related: [],
  },
  score: 0.9,
  scoreBreakdown: { keyword: 0, recency: 0, vector: 0.9 },
}

describe('retrieveMemoriesWithDecision', () => {
  test('writes the retrieval loop to its own file, and every request can be rebuilt from it', async () => {
    const logs = mkdtempSync(join(tmpdir(), 'zero-memory-retrieval-journal-'))
    try {
      const sessionId = 'sess-memory-journal'
      const store = new SessionEventStore({ basePath: logs })
      store.ensureSession({ v: 1, sessionId, schemaVersion: 1, source: 'web' })
      const adapter = new LoopRunnerAdapter()

      const memories = await retrieveMemoriesWithDecision({
        adapter,
        sessionId,
        memoryRetriever: { retrieve: async () => [], retrieveScored: async () => [scoredMemory] },
        userMessage: 'analyze x.com site',
        logger,
        failureEvent: 'memory_retrieval_failed',
        sessionEvents: store,
        layer: 'layer1',
        turnIndex: 2,
        trace: { spanName: 'memory_retrieval_decision', modelLabel: 'provider/model' },
      })
      expect(memories?.map((memory) => memory.id)).toEqual(['mem_x'])

      const parent = store.readEvents(sessionId)
      expect(parent.map((event) => event.type)).toEqual([
        'session',
        'memory/retrieval/start',
        'subagent/spawn',
        'memory/retrieval/end',
      ])
      const spawn = parent[2]
      if (spawn.type !== 'subagent/spawn') throw new Error('expected subagent/spawn')
      expect(spawn.data).toMatchObject({ name: 'memory_retrieval', role: 'layer1' })
      expect(spawn.data.logFile).toBe(
        `sessions/${sessionId}/sub-${spawn.data.childSessionId}.jsonl`,
      )

      const childId = spawn.data.childSessionId
      const child = store.readEvents(childId)
      expect(child[0]).toMatchObject({
        type: 'session',
        data: { origin: 'subagent', parentSessionId: sessionId, name: 'memory_retrieval' },
      })
      expect(child.map((event) => event.type).slice(1)).toEqual([
        'system/prompt',
        'tools/set',
        'loop/start',
        'user/message',
        'step/start',
        'step/end',
        'assistant/message',
        'tool/call',
        'tool/result',
        'user/message',
        'step/start',
        'step/end',
        'assistant/message',
      ])
      const steps = child.filter((event) => event.type === 'step/start')
      expect(steps.map((event) => event.data.model)).toEqual(['provider/model', 'provider/model'])
      const rebuilt = steps.map((event) => {
        const input = store.getRequestAssemblyInput(childId, event.seq)
        if (!input) throw new Error(`step ${event.seq} cannot be rebuilt`)
        return hashRequest(assembleRequest(input))
      })
      expect(steps.map((event) => event.data.requestHash)).toEqual(adapter.received)
      expect(rebuilt).toEqual(adapter.received)
    } finally {
      rmSync(logs, { recursive: true, force: true })
    }
  })

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
