import { describe, expect, test } from 'bun:test'
import type { CompletionRequest, CompletionResponse, StreamEvent } from '@zero-os/shared'
import type { ProviderAdapter } from '../adapters/base'
import { ModelPoolAdapter } from '../adapters/model-pool'
import { ProviderHealthRegistry } from '../provider-health'

const request: CompletionRequest = {
  messages: [],
  stream: false,
  meta: {
    sessionId: 'sess_pool',
    purpose: 'primary',
  },
}

class FakeAdapter implements ProviderAdapter {
  readonly apiType = 'fake'
  completeCalls = 0
  streamCalls = 0

  constructor(
    private readonly label: string,
    private readonly behavior: {
      complete?: () => CompletionResponse
      stream?: () => AsyncIterable<StreamEvent>
    } = {},
  ) {}

  async complete(): Promise<CompletionResponse> {
    this.completeCalls++
    if (this.behavior.complete) return this.behavior.complete()
    return {
      id: `resp_${this.label}`,
      content: [{ type: 'text', text: this.label }],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
      model: this.label,
    }
  }

  async *stream(): AsyncIterable<StreamEvent> {
    this.streamCalls++
    if (this.behavior.stream) {
      yield* this.behavior.stream()
      return
    }
    yield { type: 'text_delta', data: { text: this.label } }
    yield { type: 'done', data: { model: this.label, usage: { input: 1, output: 1 } } }
  }

  async healthCheck(): Promise<boolean> {
    return true
  }
}

function createPool(first: FakeAdapter, second: FakeAdapter) {
  return new ModelPoolAdapter(
    'chatgpt/gpt-5.5',
    [
      {
        label: 'chatgpt-personal/gpt-5.5',
        providerName: 'chatgpt-personal',
        modelName: 'gpt-5.5',
        adapter: first,
        priority: 0,
      },
      {
        label: 'chatgpt-work/gpt-5.5',
        providerName: 'chatgpt-work',
        modelName: 'gpt-5.5',
        adapter: second,
        priority: 1,
      },
    ],
    new ProviderHealthRegistry(),
    { sticky: true, quotaAware: true },
  )
}

describe('ModelPoolAdapter', () => {
  test('sticks to the selected member for the same session', async () => {
    const first = new FakeAdapter('personal')
    const second = new FakeAdapter('work')
    const pool = createPool(first, second)

    await pool.complete(request)
    await pool.complete(request)

    expect(first.completeCalls).toBe(2)
    expect(second.completeCalls).toBe(0)
  })

  test('fails over on quota errors before output starts', async () => {
    const first = new FakeAdapter('personal', {
      complete() {
        throw new Error('ChatGPT request failed: 429 usage limit reached')
      },
    })
    const second = new FakeAdapter('work')
    const pool = createPool(first, second)

    const response = await pool.complete(request)

    expect(response.model).toBe('work')
    expect(first.completeCalls).toBe(1)
    expect(second.completeCalls).toBe(1)
  })

  test('fails over when an OAuth session can no longer refresh', async () => {
    const first = new FakeAdapter('personal', {
      complete() {
        throw new Error(
          'ChatGPT OAuth session can no longer be refreshed. Please re-authenticate with `bun zero provider login chatgpt`.',
        )
      },
    })
    const second = new FakeAdapter('work')
    const pool = createPool(first, second)

    const response = await pool.complete(request)

    expect(response.model).toBe('work')
    expect(first.completeCalls).toBe(1)
    expect(second.completeCalls).toBe(1)
  })

  test('streams from the next member when OAuth refresh fails before output starts', async () => {
    const first = new FakeAdapter('personal', {
      async *stream() {
        const noEventsBeforeFailure: StreamEvent[] = []
        for (const event of noEventsBeforeFailure) yield event
        throw new Error(
          'ChatGPT OAuth session can no longer be refreshed. Please re-authenticate with `bun zero provider login chatgpt`.',
        )
      },
    })
    const second = new FakeAdapter('work')
    const pool = createPool(first, second)

    const events: StreamEvent[] = []
    for await (const event of pool.stream({ ...request, stream: true })) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: 'text_delta', data: { text: 'work' } },
      { type: 'done', data: { model: 'work', usage: { input: 1, output: 1 } } },
    ])
    expect(first.streamCalls).toBe(1)
    expect(second.streamCalls).toBe(1)
  })

  test('does not retry streaming after visible output has started', async () => {
    const first = new FakeAdapter('personal', {
      async *stream() {
        yield { type: 'text_delta', data: { text: 'partial' } }
        throw new Error('ChatGPT request failed: 429 usage limit reached')
      },
    })
    const second = new FakeAdapter('work')
    const pool = createPool(first, second)

    const events: StreamEvent[] = []
    await expect(
      (async () => {
        for await (const event of pool.stream({ ...request, stream: true })) {
          events.push(event)
        }
      })(),
    ).rejects.toThrow()

    expect(events).toEqual([{ type: 'text_delta', data: { text: 'partial' } }])
    expect(first.streamCalls).toBe(1)
    expect(second.streamCalls).toBe(0)
  })
})
