import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '@zero-os/memory'
import { LiteLLMPricing } from '@zero-os/model'
import { startZeroOS } from '../main'
import type { ZeroOS } from '../main'
import {
  createEmbeddingApiServer,
  setIntegrationMasterKey,
  writeIntegrationConfig,
  writeIntegrationSecrets,
} from './main-integration-harness'

describe('memory index integration', () => {
  test('preserves existing vector search when reindex fails for persisted memory text', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zero-embedding-fallback-'))
    const embeddingApi = await createEmbeddingApiServer()

    setIntegrationMasterKey()
    writeIntegrationConfig(dataDir, { embeddingBaseUrl: embeddingApi.baseUrl })
    writeIntegrationSecrets(dataDir, {
      openai_codex_api_key: 'sk-test-placeholder',
      embedding_api_key: 'emb-test-placeholder',
    })

    let initialZero: ZeroOS | undefined
    let restartedZero: ZeroOS | undefined

    try {
      initialZero = await startZeroOS({ dataDir, skipProcessExit: true })
      await initialZero.memoryStore.create(
        'note',
        'Persisted deploy memory',
        'deploy gateway rollback plan',
        {
          status: 'verified',
          confidence: 0.95,
          tags: ['deploy'],
        },
      )

      const initialResults = await initialZero.memoryRetriever.retrieveScored('deploy gateway', {
        topN: 5,
        confidenceThreshold: 0,
      })
      expect(initialResults.map((entry) => entry.memory.title)).toContain('Persisted deploy memory')

      await initialZero.shutdown()
      initialZero = undefined

      const baseStore = new MemoryStore(join(dataDir, 'memory'))
      const persistedMemory = baseStore
        .list('note')
        .find((memory) => memory.title === 'Persisted deploy memory')
      if (!persistedMemory) {
        throw new Error('Expected persisted memory to exist before restart')
      }
      await baseStore.update('note', persistedMemory.id, {
        tags: ['deploy', 'stale'],
      })

      embeddingApi.state.failOnText = 'Persisted deploy memory'

      restartedZero = await startZeroOS({ dataDir, skipProcessExit: true })
      const restartedResults = await restartedZero.memoryRetriever.retrieveScored(
        'deploy gateway',
        {
          topN: 5,
          confidenceThreshold: 0,
        },
      )

      expect(restartedResults.map((entry) => entry.memory.title)).toContain(
        'Persisted deploy memory',
      )
    } finally {
      await initialZero?.shutdown()
      await restartedZero?.shutdown()
      await embeddingApi.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  test('records non-zero embedding cost when LiteLLM pricing is available', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zero-embedding-cost-'))
    const embeddingApi = await createEmbeddingApiServer({
      usage: {
        promptTokens: 50,
        totalTokens: 50,
      },
    })
    let embeddingZero: ZeroOS | undefined

    try {
      setIntegrationMasterKey()
      writeIntegrationConfig(dataDir, { embeddingBaseUrl: embeddingApi.baseUrl })
      writeIntegrationSecrets(dataDir, {
        openai_codex_api_key: 'sk-test-placeholder',
        embedding_api_key: 'emb-test-placeholder',
      })

      const litellmPricing = LiteLLMPricing.init(join(dataDir, 'cache')) as unknown as {
        data: Record<string, unknown> | null
      }

      litellmPricing.data = {
        'text-embedding-test': {
          input_cost_per_token: 0.000001,
          output_cost_per_token: 0,
        },
      }

      embeddingZero = await startZeroOS({ dataDir, skipProcessExit: true })

      const results = await embeddingZero.memoryRetriever.retrieveScored('deploy gateway', {
        topN: 5,
        confidenceThreshold: 0,
        sessionId: 'sess_embedding_cost_001',
      })

      expect(results).toEqual([])

      const embeddingSummary = embeddingZero.metrics
        .usageSummaryByPurpose('1d')
        .find((row) => row.purpose === 'embedding')
      expect(embeddingSummary?.totalCost).toBeCloseTo(0.00005, 8)
      expect(embeddingZero.metrics.sessionFullCost('sess_embedding_cost_001')).toBeCloseTo(
        0.00005,
        8,
      )
    } finally {
      await embeddingZero?.shutdown()
      await embeddingApi.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
