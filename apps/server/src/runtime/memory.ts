import { join } from 'node:path'
import { CONTEXT_PARAMS } from '@zero-os/core'
import {
  MemoManager,
  MemoryLifecycle,
  type MemoryRepository,
  MemoryRetriever,
  MemoryStore,
  type VectorIndex,
} from '@zero-os/memory'
import type { MetricsDB } from '@zero-os/observe'
import type { Vault } from '@zero-os/secrets'
import type { SystemConfig } from '@zero-os/shared'
import type { HeartbeatWriter } from '@zero-os/supervisor'
import { createMemoryIndexRuntime } from './memory-index'

export interface MemoryRuntime {
  memoryStore: MemoryRepository
  memoryRetriever: MemoryRetriever
  memoryLifecycle: MemoryLifecycle
  vectorIndex?: VectorIndex
  memoManager: MemoManager
  identityReader(agentName: string): { global: string; agent: string }
}

export interface MemoryRuntimeOptions {
  zeroDir: string
  config: SystemConfig
  vault: Vault
  metrics: MetricsDB
  heartbeat: Pick<HeartbeatWriter, 'setReady'>
}

export async function createMemoryRuntime({
  zeroDir,
  config,
  vault,
  metrics,
  heartbeat,
}: MemoryRuntimeOptions): Promise<MemoryRuntime> {
  const memoryDir = join(zeroDir, 'memory')
  const baseMemoryStore = new MemoryStore(memoryDir)
  const memoManager = new MemoManager(join(memoryDir, 'memo.md'))
  const { memoryStore, embeddingClient, vectorIndex } = await createMemoryIndexRuntime({
    memoryDir,
    baseMemoryStore,
    config,
    vault,
    metrics,
    heartbeat,
  })

  const memoryRetriever = new MemoryRetriever(memoryStore, embeddingClient, vectorIndex, {
    vectorWeight: CONTEXT_PARAMS.retrieval.vectorWeight,
    recencyWeight: CONTEXT_PARAMS.retrieval.recencyWeight,
    recencyHalfLifeDays: CONTEXT_PARAMS.retrieval.recencyHalfLifeDays,
  })
  const memoryLifecycle = new MemoryLifecycle(memoryStore)

  const identityReader = (agentName: string) => {
    const globalPref = memoryStore.list('preference').find((memory) => memory.id === 'pref_global')
    return {
      global: globalPref?.content ?? '',
      agent: memoryStore.getAgentPreference(agentName),
    }
  }

  return {
    memoryStore,
    memoryRetriever,
    memoryLifecycle,
    vectorIndex,
    memoManager,
    identityReader,
  }
}
