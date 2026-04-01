import { describe, expect, test } from 'bun:test'
import type { CompletionRequest, CompletionResponse, StreamEvent } from '@zero-os/shared'
import { TrackedAdapter, type UsageRecorder } from '../adapters/tracked'
import type { ProviderAdapter } from '../adapters/base'

class FakeAdapter implements ProviderAdapter {
  readonly apiType = 'fake-tracked'
  seenRequests: CompletionRequest[] = []
  private readonly streamError?: Error

  constructor(
    private readonly response: CompletionResponse,
    private readonly streamEvents: StreamEvent[] = [],
    options: {
      streamError?: Error
    } = {},
  ) {
    this.streamError = options.streamError
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.seenRequests.push(request)
    return this.response
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    this.seenRequests.push(request)
    for (const event of this.streamEvents) {
      yield event
    }
    if (this.streamError) {
      throw this.streamError
    }
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

describe('TrackedAdapter', () => {
  test('records completion usage when request meta is present', async () => {
    const recorded: Parameters<UsageRecorder['record']>[0][] = []
    const adapter = new TrackedAdapter(
      new FakeAdapter({
        id: 'resp_complete_001',
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input: 10, output: 4, reasoning: 2 },
        model: 'raw-model-id',
      }),
      { record: (entry) => recorded.push(entry) },
      {
        providerName: 'openai',
        modelLabel: 'openai/gpt-test',
        pricing: { input: 1_000_000, output: 2_000_000 },
      },
    )

    await adapter.complete({
      messages: [],
      stream: false,
      meta: {
        sessionId: 'sess_tracked_001',
        purpose: 'agent_loop',
        parentSessionId: 'parent_tracked_001',
      },
    })

    expect(recorded).toEqual([
      expect.objectContaining({
        sessionId: 'sess_tracked_001',
        purpose: 'agent_loop',
        parentSessionId: 'parent_tracked_001',
        model: 'openai/gpt-test',
        provider: 'openai',
        usage: expect.objectContaining({ input: 10, output: 4, reasoning: 2 }),
        durationMs: expect.any(Number),
      }),
    ])
  })

  test('does not record usage when request meta is absent', async () => {
    const recorded: Parameters<UsageRecorder['record']>[0][] = []
    const adapter = new TrackedAdapter(
      new FakeAdapter({
        id: 'resp_complete_002',
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input: 5, output: 2 },
        model: 'raw-model-id',
      }),
      { record: (entry) => recorded.push(entry) },
      {
        providerName: 'openai',
        modelLabel: 'openai/gpt-test',
      },
    )

    await adapter.complete({
      messages: [],
      stream: false,
    })

    expect(recorded).toEqual([])
  })

  test('records streaming usage from the final done event', async () => {
    const recorded: Parameters<UsageRecorder['record']>[0][] = []
    const adapter = new TrackedAdapter(
      new FakeAdapter(
        {
          id: 'unused',
          content: [],
          stopReason: 'end_turn',
          usage: { input: 0, output: 0 },
          model: 'unused',
        },
        [
          { type: 'text_delta', data: { text: 'hello' } },
          {
            type: 'done',
            data: {
              finishReason: 'end_turn',
              model: 'openai/gpt-stream',
              usage: { input: 7, output: 3, cacheRead: 2 },
            },
          },
        ],
      ),
      { record: (entry) => recorded.push(entry) },
      {
        providerName: 'openai',
        modelLabel: 'openai/gpt-test',
      },
    )

    const events: StreamEvent[] = []
    for await (const event of adapter.stream({
      messages: [],
      stream: true,
      meta: {
        sessionId: 'sess_stream_001',
        purpose: 'memory_retrieval',
      },
    })) {
      events.push(event)
    }

    expect(events).toHaveLength(2)
    expect(recorded).toEqual([
      expect.objectContaining({
        sessionId: 'sess_stream_001',
        purpose: 'memory_retrieval',
        model: 'openai/gpt-stream',
        usage: expect.objectContaining({ input: 7, output: 3, cacheRead: 2 }),
      }),
    ])
  })

  test('does not record partial streaming usage when the stream aborts before done', async () => {
    const recorded: Parameters<UsageRecorder['record']>[0][] = []
    const streamError = new Error('stream aborted')
    const adapter = new TrackedAdapter(
      new FakeAdapter(
        {
          id: 'unused',
          content: [],
          stopReason: 'end_turn',
          usage: { input: 0, output: 0 },
          model: 'unused',
        },
        [{ type: 'text_delta', data: { text: 'partial' } }],
        { streamError },
      ),
      { record: (entry) => recorded.push(entry) },
      {
        providerName: 'openai',
        modelLabel: 'openai/gpt-test',
      },
    )

    const iterator = adapter.stream({
      messages: [],
      stream: true,
      meta: {
        sessionId: 'sess_stream_002',
        purpose: 'agent_loop',
      },
    })

    await expect((async () => {
      for await (const _event of iterator) {
      }
    })()).rejects.toThrow('stream aborted')
    expect(recorded).toEqual([])
  })
})
