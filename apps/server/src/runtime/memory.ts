import { join } from 'node:path'
import { CONTEXT_PARAMS } from '@zero-os/core'
import {
  MemoManager,
  MemoryLifecycle,
  type MemoryRepository,
  MemoryRetriever,
  MemoryStore,
  MemoryUsageTracker,
  type VectorIndex,
} from '@zero-os/memory'
import type { MetricsDB } from '@zero-os/observe'
import type { Vault } from '@zero-os/secrets'
import type { ForkEffect, SystemConfig } from '@zero-os/shared'
import type { HeartbeatWriter } from '@zero-os/supervisor'
import { createMemoryIndexRuntime } from './memory-index'

export interface MemoryRuntime {
  memoryStore: MemoryRepository
  memoryRetriever: MemoryRetriever
  memoryLifecycle: MemoryLifecycle
  vectorIndex?: VectorIndex
  memoManager: MemoManager
  /** 使用反馈统计:检索评分消费 score(),session 埋点消费 record(),shutdown 消费 flush() */
  memoryUsage: MemoryUsageTracker
  identityReader(agentName: string): { global: string; agent: string }
}

export interface MemoryRuntimeOptions {
  zeroDir: string
  config: SystemConfig
  vault: Vault
  metrics: MetricsDB
  heartbeat: Pick<HeartbeatWriter, 'setReady'>
  forkEffect?: ForkEffect
}

export async function createMemoryRuntime({
  zeroDir,
  config,
  vault,
  metrics,
  heartbeat,
  forkEffect,
}: MemoryRuntimeOptions): Promise<MemoryRuntime> {
  const memoryDir = join(zeroDir, 'memory')
  const baseMemoryStore = new MemoryStore(memoryDir)
  const memoManager = new MemoManager(join(memoryDir, 'memo.md'))
  // 使用反馈统计:sidecar 存储,与记忆正文/向量索引完全解耦;加载失败从空开始。
  const memoryUsage = new MemoryUsageTracker({
    statsPath: join(memoryDir, 'usage-stats.json'),
    halfLifeDays: CONTEXT_PARAMS.retrieval.recencyHalfLifeDays,
    forkEffect,
  })
  memoryUsage.load()
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
    usageWeight: CONTEXT_PARAMS.retrieval.usageWeight,
    recencyHalfLifeDays: CONTEXT_PARAMS.retrieval.recencyHalfLifeDays,
    usageScore: (memoryId) => memoryUsage.score(memoryId),
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
    memoryUsage,
    identityReader,
  }
}
