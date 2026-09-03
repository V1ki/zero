import { afterEach, describe, expect, mock, test } from 'bun:test'
import { EmbeddingClient, EmbeddingPayloadError, EmbeddingRequestError } from '../embedding'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('EmbeddingClient', () => {
  test('embed returns a single vector', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2, 0.3] }],
          }),
        ),
    ) as unknown as typeof fetch

    const client = new EmbeddingClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      model: 'text-embedding-v4',
      dimensions: 1024,
    })

    await expect(client.embed('hello')).resolves.toEqual([0.1, 0.2, 0.3])
  })

  test('embedBatch returns all vectors', async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ embedding: [1, 0] }, { embedding: [0, 1] }],
          }),
        ),
    ) as unknown as typeof fetch

    const client = new EmbeddingClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      model: 'text-embedding-v4',
    })

    await expect(client.embedBatch(['a', 'b'])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ])
  })

  test('reports usage with per-call session attribution', async () => {
    const onUsage = mock(() => {})
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ embedding: [1, 0] }, { embedding: [0, 1] }],
            usage: {
              prompt_tokens: 42,
              total_tokens: 42,
            },
          }),
        ),
    ) as unknown as typeof fetch

    const client = new EmbeddingClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      model: 'text-embedding-v4',
      onUsage,
    })

    await client.embedBatch(['a', 'b'], 'sess_embed_001')

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTokens: 42,
        totalTokens: 42,
        batchSize: 2,
        sessionId: 'sess_embed_001',
        durationMs: expect.any(Number),
      }),
    )
  })

  test('throws on non-ok response', async () => {
    globalThis.fetch = mock(
      async () => new Response('bad gateway', { status: 502 }),
    ) as unknown as typeof fetch

    const client = new EmbeddingClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      model: 'text-embedding-v4',
    })

    await expect(client.embed('hello')).rejects.toThrow('Embedding request failed with status 502')
  })

  test('throws on malformed response payload', async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ data: [] })),
    ) as unknown as typeof fetch

    const client = new EmbeddingClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      model: 'text-embedding-v4',
    })

    await expect(client.embed('hello')).rejects.toThrow(
      'Embedding service returned an unexpected payload',
    )
  })

  test('memoryToText includes title tags and trimmed content', () => {
    const client = new EmbeddingClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      model: 'text-embedding-v4',
    })

    const text = client.memoryToText({
      id: 'mem_1',
      type: 'note',
      title: 'Deploy Runbook',
      createdAt: '2026-03-11T00:00:00.000Z',
      updatedAt: '2026-03-11T00:00:00.000Z',
      status: 'verified',
      confidence: 0.9,
      tags: ['deploy', 'ops'],
      related: [],
      content: 'Step 1\n\nStep 2',
    })

    expect(text).toContain('Deploy Runbook')
    expect(text).toContain('deploy ops')
    expect(text).toContain('Step 1 Step 2')
  })

  test('failures are typed TaggedError classes carrying diagnostic fields', async () => {
    globalThis.fetch = mock(
      async () => new Response('bad gateway', { status: 502 }),
    ) as unknown as typeof fetch

    const client = new EmbeddingClient({
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      model: 'text-embedding-v4',
    })

    const requestError = await client.embed('hello').catch((error) => error)
    expect(requestError).toBeInstanceOf(EmbeddingRequestError)
    expect(requestError).toBeInstanceOf(Error)
    expect(requestError.status).toBe(502)
    expect(requestError._tag).toBe('EmbeddingRequest')

    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ data: [] })),
    ) as unknown as typeof fetch

    const payloadError = await client.embed('hello').catch((error) => error)
    expect(payloadError).toBeInstanceOf(EmbeddingPayloadError)
    expect(payloadError._tag).toBe('EmbeddingPayload')
  })
})
