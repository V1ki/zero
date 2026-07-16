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

function createPool(
  first: FakeAdapter,
  second: FakeAdapter,
  health: ProviderHealthRegistry = new ProviderHealthRegistry(),
) {
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
    health,
    { sticky: true, quotaAware: true },
  )
}

describe('ModelPoolAdapter', () => {
  test('disables stream fallback when any member lacks a distinct complete transport', () => {
    const first = new FakeAdapter('personal')
    const second = new FakeAdapter('work')
    Object.assign(first, { supportsNonStreamingFallback: false })

    expect(createPool(first, second).supportsNonStreamingFallback).toBe(false)
  })

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

  test('tries the next member after a transport failure without changing member health', async () => {
    const first = new FakeAdapter('personal', {
      async *stream() {
        const noEventsBeforeFailure: StreamEvent[] = []
        for (const event of noEventsBeforeFailure) yield event
        throw Object.assign(new Error('ChatGPT response stream transport failed'), {
          retryable: true,
          error_type: 'response_stream_transport_error',
          failure_scope: 'transport',
        })
      },
    })
    const second = new FakeAdapter('work')
    const health = new ProviderHealthRegistry()
    const pool = createPool(first, second, health)

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
    expect(health.get('chatgpt-personal', 'gpt-5.5')).toBeUndefined()

    const nextEvents: StreamEvent[] = []
    for await (const event of pool.stream({ ...request, stream: true })) {
      nextEvents.push(event)
    }

    expect(nextEvents.at(0)).toEqual({ type: 'text_delta', data: { text: 'work' } })
    expect(first.streamCalls).toBe(1)
    expect(second.streamCalls).toBe(2)
  })

  test('does not switch or change member health after stream output has started', async () => {
    const first = new FakeAdapter('personal', {
      async *stream() {
        yield { type: 'text_delta', data: { text: 'partial' } }
        throw Object.assign(new Error('ChatGPT response stream transport failed'), {
          retryable: true,
          error_type: 'response_stream_transport_error',
          failure_scope: 'transport',
        })
      },
    })
    const second = new FakeAdapter('work')
    const health = new ProviderHealthRegistry()
    const pool = createPool(first, second, health)

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
    expect(health.get('chatgpt-personal', 'gpt-5.5')).toBeUndefined()
  })

  test('prevents an outer replay after every pool member has a transport failure', async () => {
    const createFailingAdapter = (label: string) =>
      new FakeAdapter(label, {
        async *stream() {
          const noEventsBeforeFailure: StreamEvent[] = []
          for (const event of noEventsBeforeFailure) yield event
          throw Object.assign(new Error(`${label} transport failed`), {
            retryable: true,
            error_type: 'response_stream_transport_error',
            failure_scope: 'transport',
          })
        },
      })
    const first = createFailingAdapter('personal')
    const second = createFailingAdapter('work')
    const health = new ProviderHealthRegistry()
    const pool = createPool(first, second, health)

    let caught: unknown
    try {
      for await (const _event of pool.stream({ ...request, stream: true })) {
        // No events are expected before both connections fail.
      }
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      message: 'work transport failed',
      retryable: true,
      failure_scope: 'transport',
      outer_retryable: false,
      pool_exhausted: true,
    })
    expect(first.streamCalls).toBe(1)
    expect(second.streamCalls).toBe(1)
    expect(health.get('chatgpt-personal', 'gpt-5.5')).toBeUndefined()
    expect(health.get('chatgpt-work', 'gpt-5.5')).toBeUndefined()
  })

  test('keeps one outer retry when only one pool member was actually attempted', async () => {
    const transportError = Object.assign(new Error('personal transport failed'), {
      retryable: true,
      error_type: 'response_stream_transport_error',
      failure_scope: 'transport',
    })
    const first = new FakeAdapter('personal', {
      async *stream() {
        const noEventsBeforeFailure: StreamEvent[] = []
        for (const event of noEventsBeforeFailure) yield event
        throw transportError
      },
    })
    const second = new FakeAdapter('work')
    const health = new ProviderHealthRegistry()
    health.markAuthError({
      providerName: 'chatgpt-work',
      modelName: 'gpt-5.5',
      reason: 'not available for this request',
    })
    const pool = createPool(first, second, health)

    await expect(
      (async () => {
        for await (const _event of pool.stream({ ...request, stream: true })) {
          // No events are expected before the connection fails.
        }
      })(),
    ).rejects.toBe(transportError)

    expect(transportError).not.toHaveProperty('outer_retryable')
    expect(first.streamCalls).toBe(1)
    expect(second.streamCalls).toBe(0)
    expect(health.get('chatgpt-personal', 'gpt-5.5')).toBeUndefined()
  })

  test('does not fail over or mark health for retryable request-scoped errors', async () => {
    const requestError = Object.assign(
      new Error('ChatGPT response incomplete: max_output_tokens'),
      {
        retryable: true,
        error_type: 'response_incomplete',
        failure_scope: 'request',
      },
    )
    const first = new FakeAdapter('personal', {
      async *stream() {
        const noEventsBeforeFailure: StreamEvent[] = []
        for (const event of noEventsBeforeFailure) yield event
        throw requestError
      },
    })
    const second = new FakeAdapter('work')
    const health = new ProviderHealthRegistry()
    const pool = createPool(first, second, health)

    await expect(
      (async () => {
        for await (const _event of pool.stream({ ...request, stream: true })) {
          // No events are expected before the request-scoped error.
        }
      })(),
    ).rejects.toBe(requestError)

    expect(first.streamCalls).toBe(1)
    expect(second.streamCalls).toBe(0)
    expect(health.get('chatgpt-personal', 'gpt-5.5')).toBeUndefined()
  })

  test('does not let legacy message heuristics override an explicit request scope', async () => {
    const requestError = Object.assign(new Error('Invalid prompt field named quota'), {
      retryable: false,
      error_type: 'invalid_prompt',
      failure_scope: 'request',
    })
    const first = new FakeAdapter('personal', {
      complete() {
        throw requestError
      },
    })
    const second = new FakeAdapter('work')
    const health = new ProviderHealthRegistry()
    const pool = createPool(first, second, health)

    await expect(pool.complete(request)).rejects.toBe(requestError)

    expect(first.completeCalls).toBe(1)
    expect(second.completeCalls).toBe(0)
    expect(health.get('chatgpt-personal', 'gpt-5.5')).toBeUndefined()
  })

  test('fails over on a structured rate-limit code without an HTTP status', async () => {
    const first = new FakeAdapter('personal', {
      complete() {
        throw Object.assign(new Error('request rejected'), {
          retryable: true,
          error_type: 'rate_limit_exceeded',
          failure_scope: 'provider',
        })
      },
    })
    const second = new FakeAdapter('work')
    const health = new ProviderHealthRegistry()
    const pool = createPool(first, second, health)

    const response = await pool.complete(request)

    expect(response.model).toBe('work')
    expect(first.completeCalls).toBe(1)
    expect(second.completeCalls).toBe(1)
    expect(health.get('chatgpt-personal', 'gpt-5.5')).toMatchObject({
      state: 'quota_limited',
      evidence: {
        errorType: 'rate_limit_exceeded',
        failureScope: 'provider',
      },
    })
  })

  test('explains why all pool members are unavailable', async () => {
    const health = new ProviderHealthRegistry()
    health.markAuthError({
      providerName: 'chatgpt-personal',
      modelName: 'gpt-5.5',
      reason: 'refresh token expired',
    })
    await health.markQuotaLimited({
      providerName: 'chatgpt-work',
      modelName: 'gpt-5.5',
      reason: 'usage limit reached',
    })
    const pool = createPool(new FakeAdapter('personal'), new FakeAdapter('work'), health)

    await expect(pool.complete(request)).rejects.toThrow(
      /chatgpt-personal\/gpt-5\.5: auth_error.*chatgpt-work\/gpt-5\.5: quota_limited/,
    )
  })
})
