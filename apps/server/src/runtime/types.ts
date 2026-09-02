import type { Channel } from '@zero-os/channel'
import type { SessionManager, ToolRegistry, loadConfig } from '@zero-os/core'
import type {
  MemoManager,
  MemoryLifecycle,
  MemoryRepository,
  MemoryRetriever,
  MemoryUsageTracker,
  VectorIndex,
} from '@zero-os/memory'
import type { ModelRouter, ProviderHealthRegistry } from '@zero-os/model'
import type { MetricsDB, ObservabilityStore, SessionDB, Tracer } from '@zero-os/observe'
import type { CronScheduler } from '@zero-os/scheduler'
import type { OutputSecretFilter, Vault } from '@zero-os/secrets'
import type { Notification } from '@zero-os/shared'
import type { HeartbeatWriter } from '@zero-os/supervisor'
import type { RepairEngine } from '@zero-os/supervisor'
import type { ChannelAdapter } from '../channels/adapter'
import type { EventBus } from './bus'
import type { ChannelRecoveryController } from './channel-recovery'
import type { ChannelRuntimeDefinition } from './channel-runtime/types'

export interface StartOptions {
  dataDir?: string
  projectRoot?: string
  skipProcessExit?: boolean
  onCoreReady?: (zero: ZeroOS) => Promise<void> | void
}

export interface ZeroOS {
  config: ReturnType<typeof loadConfig>
  vault: Vault
  secretFilter: OutputSecretFilter
  observability: ObservabilityStore
  metrics: MetricsDB
  sessionDb: SessionDB
  modelRouter: ModelRouter
  providerHealth: ProviderHealthRegistry
  toolRegistry: ToolRegistry
  sessionManager: SessionManager
  memoryStore: MemoryRepository
  memoryRetriever: MemoryRetriever
  memoryLifecycle: MemoryLifecycle
  memoryUsage: MemoryUsageTracker
  vectorIndex?: VectorIndex
  memoManager: MemoManager
  tracer: Tracer
  repairEngine: RepairEngine
  heartbeat: HeartbeatWriter
  scheduler: CronScheduler
  bus: EventBus
  channels: Map<string, Channel>
  channelAdapters: Map<string, ChannelAdapter>
  channelDefinitions: Map<string, ChannelRuntimeDefinition>
  channelRecovery: ChannelRecoveryController
  notifications: Notification[]
  addNotification(n: Omit<Notification, 'id' | 'createdAt'>): Notification
  reloadModelProviders(options?: ReloadModelProvidersOptions): Promise<void>
  isShuttingDown(): boolean
  shutdown(): Promise<void>
}

export interface ReloadModelProvidersOptions {
  recoveredProviders?: string[]
}
