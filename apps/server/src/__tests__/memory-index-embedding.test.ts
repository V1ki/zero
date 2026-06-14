import { describe, expect, test } from 'bun:test'
import type { EmbeddingModelConfig, SystemConfig } from '@zero-os/shared'
import { resolveMemoryIndexEmbeddingRuntime } from '../runtime/memory-index'

function createConfig(embedding?: Partial<EmbeddingModelConfig>): SystemConfig {
  return {
    providers: {},
    defaultModel: 'chatgpt/gpt-5.4',
    fallbackChain: [],
    schedules: [],
    fuseList: [],
    ...(embedding ? { embedding: embedding as EmbeddingModelConfig } : {}),
  }
}

function createVault(secrets: Record<string, string> = {}) {
  return {
    get: (key: string) => secrets[key],
  }
}

describe('resolveMemoryIndexEmbeddingRuntime', () => {
  test('disables memory vector indexing when embedding config is incomplete', () => {
    expect(resolveMemoryIndexEmbeddingRuntime(createConfig(), createVault())).toEqual({
      state: 'disabled',
    })
    expect(
      resolveMemoryIndexEmbeddingRuntime(
        createConfig({ baseUrl: 'https://emb.example' }),
        createVault(),
      ),
    ).toEqual({
      state: 'disabled',
    })
  })

  test('reports missing embedding secrets without exposing values', () => {
    expect(
      resolveMemoryIndexEmbeddingRuntime(
        createConfig({
          baseUrl: 'https://emb.example',
          apiKeyRef: 'embedding_api_key',
          model: 'text-embedding-test',
        }),
        createVault(),
      ),
    ).toEqual({
      state: 'missing-secret',
      apiKeyRef: 'embedding_api_key',
    })
  })

  test('returns ready runtime with config and secret value', () => {
    expect(
      resolveMemoryIndexEmbeddingRuntime(
        createConfig({
          baseUrl: 'https://emb.example',
          apiKeyRef: 'embedding_api_key',
          model: 'text-embedding-test',
          dimensions: 256,
        }),
        createVault({ embedding_api_key: 'secret-value' }),
      ),
    ).toEqual({
      state: 'ready',
      apiKey: 'secret-value',
      config: {
        baseUrl: 'https://emb.example',
        apiKeyRef: 'embedding_api_key',
        model: 'text-embedding-test',
        dimensions: 256,
      },
    })
  })
})
