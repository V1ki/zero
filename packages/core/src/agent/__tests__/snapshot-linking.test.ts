import { describe, expect, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import { type SnapshotEntry, Tracer } from '@zero-os/observe'
import type {
  CompletionRequest,
  CompletionResponse,
  Message,
  StreamEvent,
  ToolContext,
  ToolResult,
} from '@zero-os/shared'
import { generateId, now } from '@zero-os/shared'
import { BaseTool } from '../../tool/base'
import { ToolRegistry } from '../../tool/registry'
import { Agent, type AgentContext } from '../agent'

async function* failStream(error: Error): AsyncIterable<StreamEvent> {
  yield* []
  throw error
}

class NoopTool extends BaseTool {
  name = 'noop'
  description = 'Returns a short success payload'
  parameters = { type: 'object', properties: {} }

  protected async execute(_ctx: ToolContext, _input: unknown): Promise<ToolResult> {
    return { success: true, output: 'ok', outputSummary: 'ok' }
  }
}

class CompressionAdapter implements ProviderAdapter {
  readonly apiType = 'fake'
  private normalCallCount = 0

  async complete(_request: CompletionRequest): Promise<CompletionResponse> {
    if (_request.messages[0]?.sessionId === 'compression') {
      return {
        id: 'resp_summary',
        content: [{ type: 'text', text: 'compressed summary' }],
        stopReason: 'end_turn',
        usage: { input: 8, output: 8 },
        model: 'fake-model',
      }
    }

    this.normalCallCount++

    if (this.normalCallCount === 1) {
      return {
        id: 'resp_tool_use',
        content: [{ type: 'tool_use', id: 'call_1', name: 'noop', input: {} }],
        stopReason: 'tool_use',
        usage: { input: 10, output: 5 },
        model: 'fake-model',
      }
    }

    if (this.normalCallCount === 2) {
      return {
        id: 'resp_final',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { input: 5, output: 3 },
        model: 'fake-model',
      }
    }
    return {
      id: 'resp_final_repeat',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { input: 5, output: 3 },
      model: 'fake-model',
    }
  }

  async *stream(_request: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* failStream(new Error('stream not supported in test'))
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

function createMessage(index: number): Message {
  const role = index % 2 === 0 ? 'user' : 'assistant'
  return {
    id: generateId(),
    sessionId: 'test-session',
    role,
    messageType: 'message',
    content: [{ type: 'text', text: `history-${index} ${'x'.repeat(200)}` }],
    createdAt: now(),
  }
}

describe('Agent snapshot linking', () => {
  test('request logs switch to the new snapshot id after compression', async () => {
    const registry = new ToolRegistry()
    registry.register(new NoopTool())

    const compressionEvents: Array<{
      summary: string
      stats: { compressedRange?: string }
      decisionContext: NonNullable<SnapshotEntry['decisionContext']>
    }> = []
    let currentSnapshotId = 'snap_initial'
    const tracer = new Tracer()

    const toolContext: ToolContext = {
      sessionId: 'test-session',
      workDir: process.cwd(),
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      tracer,
    }

    const agent = new Agent(
      { name: 'test-agent', agentInstruction: 'Test prompt' },
      new CompressionAdapter(),
      registry,
      toolContext,
      {
        tracer,
        getCurrentSnapshotId: () => currentSnapshotId,
        onContextCompressed: (event) => {
          compressionEvents.push(event)
          currentSnapshotId = 'snap_compressed'
        },
      },
    )

    const context: AgentContext = {
      systemPrompt: 'Test prompt',
      conversationHistory: Array.from({ length: 12 }, (_, index) => createMessage(index)),
      tools: registry.getDefinitions(),
      maxContext: 16050,
      maxOutput: 1,
    }

    await agent.run(context, 'trigger compression')

    const requests = flattenTraceSpans(tracer.exportSession('test-session'))
      .map((span) => span.data?.request as Record<string, unknown> | undefined)
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))

    expect(requests).toHaveLength(2)
    expect(requests[0]?.snapshotId).toBe('snap_initial')
    expect(requests[1]?.snapshotId).toBe('snap_compressed')
    expect(compressionEvents).toHaveLength(1)
    expect(compressionEvents[0]?.summary).toBe('compressed summary')
    expect(compressionEvents[0]?.stats.compressedRange).toBeTruthy()
    expect(compressionEvents[0]?.decisionContext.currentTokens).toBeGreaterThan(
      compressionEvents[0]?.decisionContext.conversationBudget ?? 0,
    )
  })
})

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
