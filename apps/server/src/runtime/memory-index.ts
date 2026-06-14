import { join } from 'node:path'
import {
  EmbeddingClient,
  IndexedMemoryStore,
  type EmbeddingClient as MemoryEmbeddingClient,
  type MemoryRepository,
  type MemoryStore,
  VectorIndex,
} from '@zero-os/memory'
import type { MetricsDB } from '@zero-os/observe'
import type { Vault } from '@zero-os/secrets'
import { type EmbeddingModelConfig, type SystemConfig, toErrorMessage } from '@zero-os/shared'
import type { HeartbeatWriter } from '@zero-os/supervisor'
import { createEmbeddingUsageRecorder } from './observability'

export type MemoryIndexEmbeddingRuntime =
  | { state: 'disabled' }
  | { state: 'missing-secret'; apiKeyRef: string }
  | { state: 'ready'; config: EmbeddingModelConfig; apiKey: string }

type ReadyMemoryIndexEmbeddingRuntime = Extract<MemoryIndexEmbeddingRuntime, { state: 'ready' }>

export interface MemoryIndexRuntime {
  memoryStore: MemoryRepository
  embeddingClient?: MemoryEmbeddingClient
  vectorIndex?: VectorIndex
}

interface CreateMemoryIndexRuntimeOptions {
  memoryDir: string
  baseMemoryStore: MemoryStore
  config: SystemConfig
  vault: Vault
  metrics: MetricsDB
  heartbeat: Pick<HeartbeatWriter, 'setReady'>
}

interface StartReadyMemoryIndexRuntimeOptions {
  memoryDir: string
  baseMemoryStore: MemoryStore
  embeddingRuntime: ReadyMemoryIndexEmbeddingRuntime
  metrics: MetricsDB
  heartbeat: Pick<HeartbeatWriter, 'setReady'>
}

interface CreatedMemoryVectorIndex {
  memoryStore: IndexedMemoryStore
  embeddingClient: MemoryEmbeddingClient
  vectorIndex: VectorIndex
}

export async function createMemoryIndexRuntime({
  memoryDir,
  baseMemoryStore,
  config,
  vault,
  metrics,
  heartbeat,
}: CreateMemoryIndexRuntimeOptions): Promise<MemoryIndexRuntime> {
  const embeddingRuntime = resolveMemoryIndexEmbeddingRuntime(config, vault)
  if (embeddingRuntime.state === 'disabled') {
    return { memoryStore: baseMemoryStore }
  }

  if (embeddingRuntime.state === 'missing-secret') {
    console.warn(
      `[ZeRo OS] Embedding secret "${embeddingRuntime.apiKeyRef}" not found, memory search disabled`,
    )
    return { memoryStore: baseMemoryStore }
  }

  return await startReadyMemoryIndexRuntime({
    memoryDir,
    baseMemoryStore,
    embeddingRuntime,
    metrics,
    heartbeat,
  })
}

export function resolveMemoryIndexEmbeddingRuntime(
  config: SystemConfig,
  vault: Pick<Vault, 'get'>,
): MemoryIndexEmbeddingRuntime {
  const embeddingConfig = config.embedding
  if (!embeddingConfig?.baseUrl || !embeddingConfig.apiKeyRef || !embeddingConfig.model) {
    return { state: 'disabled' }
  }

  const apiKey = vault.get(embeddingConfig.apiKeyRef)
  if (!apiKey) {
    return {
      state: 'missing-secret',
      apiKeyRef: embeddingConfig.apiKeyRef,
    }
  }

  return {
    state: 'ready',
    config: embeddingConfig,
    apiKey,
  }
}

async function startReadyMemoryIndexRuntime({
  memoryDir,
  baseMemoryStore,
  embeddingRuntime,
  metrics,
  heartbeat,
}: StartReadyMemoryIndexRuntimeOptions): Promise<MemoryIndexRuntime> {
  let memoryStore: MemoryRepository = baseMemoryStore
  let embeddingClient: MemoryEmbeddingClient | undefined
  let vectorIndex: VectorIndex | undefined

  try {
    heartbeat.setReady(false, 'memory_indexing')
    const startedIndex = createMemoryVectorIndex({
      memoryDir,
      baseMemoryStore,
      embeddingRuntime,
      metrics,
    })
    memoryStore = startedIndex.memoryStore
    embeddingClient = startedIndex.embeddingClient
    vectorIndex = startedIndex.vectorIndex
    const reindexed = await startedIndex.memoryStore.reindexAll()
    console.log(`[ZeRo OS] Memory vector index ready (${reindexed} items)`)
  } catch (error) {
    memoryStore = baseMemoryStore

    const canReuseVectorIndex = vectorIndex
      ? await canReuseExistingMemoryVectorIndex(vectorIndex, error)
      : false
    if (!canReuseVectorIndex) {
      embeddingClient = undefined
      vectorIndex = undefined
      warnMemoryVectorIndexUnavailable(error)
    }
  }

  return {
    memoryStore,
    embeddingClient,
    vectorIndex,
  }
}

function createMemoryVectorIndex({
  memoryDir,
  baseMemoryStore,
  embeddingRuntime,
  metrics,
}: {
  memoryDir: string
  baseMemoryStore: MemoryRepository
  embeddingRuntime: ReadyMemoryIndexEmbeddingRuntime
  metrics: MetricsDB
}): CreatedMemoryVectorIndex {
  const embeddingClient = createMemoryIndexEmbeddingClient(embeddingRuntime, metrics)
  const vectorIndex = new VectorIndex(join(memoryDir, 'vectors'))
  const memoryStore = new IndexedMemoryStore(baseMemoryStore, embeddingClient, vectorIndex)

  return {
    memoryStore,
    embeddingClient,
    vectorIndex,
  }
}

function createMemoryIndexEmbeddingClient(
  runtime: ReadyMemoryIndexEmbeddingRuntime,
  metrics: MetricsDB,
): MemoryEmbeddingClient {
  return new EmbeddingClient({
    baseUrl: runtime.config.baseUrl,
    apiKey: runtime.apiKey,
    model: runtime.config.model,
    dimensions: runtime.config.dimensions,
    onUsage: createEmbeddingUsageRecorder({
      model: runtime.config.model,
      metrics,
    }),
  })
}

async function canReuseExistingMemoryVectorIndex(
  vectorIndex: VectorIndex,
  error: unknown,
): Promise<boolean> {
  try {
    await vectorIndex.ensureIndex()
    const stats = await vectorIndex.getStats()
    if (stats.itemCount <= 0) {
      return false
    }

    console.warn('[ZeRo OS] Using existing memory vector index; reindex skipped', {
      itemCount: stats.itemCount,
      message: toErrorMessage(error),
    })
    return true
  } catch {
    return false
  }
}

function warnMemoryVectorIndexUnavailable(error: unknown): void {
  console.warn('[ZeRo OS] Memory vector index unavailable, memory search disabled', {
    message: toErrorMessage(error),
  })
}
