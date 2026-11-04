import type { Channel, FeishuStreamingSession } from '@zero-os/channel'
import type { SessionManager } from '@zero-os/core'
import type { MetricsDB, SessionDB } from '@zero-os/observe'
import type { CronScheduler } from '@zero-os/scheduler'
import type { HeartbeatWriter } from '@zero-os/supervisor'
import { abortActiveStreamingSessions } from './channel-runtime/runtime'
import { recordRestartSentinel } from './restart'

interface ShutdownRuntimeOptions
  extends Omit<ShutdownSequenceOptions, 'activeStreamingSessionSets'> {
  skipProcessExit?: boolean
}

export interface ShutdownRuntime {
  shutdown(): Promise<void>
  isShuttingDown(): boolean
  registerFeishuStreamingSessionSet(sessionSet: Set<FeishuStreamingSession>): void
}

export interface ShutdownSequenceOptions {
  zeroDir: string
  restartSentinelPath: string
  scheduler: CronScheduler
  sessionManager: SessionManager
  channels: Map<string, Channel>
  activeStreamingSessionSets: Set<FeishuStreamingSession>[]
  closeListeners?: () => Promise<void>
  stopChannelRecovery?: () => void
  closeWorker(): Promise<void>
  disposeRuntimeEventListeners(): void
  disposePricing(): void
  heartbeat: HeartbeatWriter
  sessionDb: SessionDB
  metrics: MetricsDB
  flushMemoryUsage?: () => Promise<void>
  closeFiberRoot?: () => Promise<void>
}

interface CloseShutdownResourcesOptions {
  channels: Map<string, Channel>
  disposeRuntimeEventListeners(): void
  disposePricing(): void
  heartbeat: HeartbeatWriter
  heartbeatStoppedAtEntry?: boolean
  sessionManager: SessionManager
  sessionDb: SessionDB
  metrics: MetricsDB
}

export function createShutdownRuntime({
  skipProcessExit,
  ...options
}: ShutdownRuntimeOptions): ShutdownRuntime {
  let shutdownPromise: Promise<void> | undefined
  const activeStreamingSessionSets: Set<FeishuStreamingSession>[] = []

  return {
    isShuttingDown: () => shutdownPromise !== undefined,
    registerFeishuStreamingSessionSet(sessionSet) {
      activeStreamingSessionSets.push(sessionSet)
    },
    shutdown() {
      shutdownPromise ??= Promise.resolve().then(async () => {
        await runShutdownSequence({ ...options, activeStreamingSessionSets })
        if (!skipProcessExit) process.exit(0)
      })
      return shutdownPromise
    },
  }
}

export async function runShutdownSequence({
  zeroDir,
  restartSentinelPath,
  scheduler,
  sessionManager,
  channels,
  activeStreamingSessionSets,
  stopChannelRecovery,
  closeListeners,
  closeWorker,
  disposeRuntimeEventListeners,
  disposePricing,
  heartbeat,
  sessionDb,
  metrics,
  flushMemoryUsage,
  closeFiberRoot,
}: ShutdownSequenceOptions): Promise<void> {
  console.log('\n[ZeRo OS] Shutting down...')
  publishShuttingDownHeartbeat(heartbeat)
  stopChannelRecovery?.()
  await closeListeners?.()
  scheduler.stop()
  console.log('[ZeRo OS] Scheduler stopped')

  // Start persisting usage while turns drain, without delaying process cleanup.
  const memoryFlushed = Promise.resolve()
    .then(flushMemoryUsage)
    .catch((error) => console.warn('[ZeRo OS] Memory usage stats flush failed:', error))

  // Drain has a bounded deadline. Reap the shared process before any network shutdown work.
  const interruptedSessions = await sessionManager
    .drainAndCollectInterrupted(30_000)
    .finally(async () => {
      try {
        await closeWorker()
      } catch (error) {
        console.warn('[ZeRo OS] Codex app-server shutdown failed:', error)
      }
    })

  await memoryFlushed
  await recordRestartSentinel({
    zeroDir,
    restartSentinelPath,
    interruptedSessions,
    sessionManager,
    channels,
  })
  await abortActiveStreamingSessions(activeStreamingSessionSets)

  await closeShutdownResources({
    channels,
    disposeRuntimeEventListeners,
    disposePricing,
    heartbeat,
    heartbeatStoppedAtEntry: true,
    sessionManager,
    sessionDb,
    metrics,
  })

  // 兜底:各模块 stop()/dispose() 之后,统一 root scope 一把打断所有仍存活的
  // 长生命周期 fiber(含中途才启动的),失败只告警不阻断退出。
  if (closeFiberRoot) {
    try {
      await closeFiberRoot()
    } catch (error) {
      console.warn('[ZeRo OS] Fiber root shutdown failed:', error)
    }
    console.log('[ZeRo OS] Fiber root closed')
  }
  console.log('[ZeRo OS] Shutdown complete.')
}

export async function closeShutdownResources({
  channels,
  disposeRuntimeEventListeners,
  disposePricing,
  heartbeat,
  heartbeatStoppedAtEntry,
  sessionManager,
  sessionDb,
  metrics,
}: CloseShutdownResourcesOptions): Promise<void> {
  disposeRuntimeEventListeners()
  disposePricing()
  console.log('[ZeRo OS] LiteLLM pricing disposed')

  await closeChannels(channels)

  if (!heartbeatStoppedAtEntry) {
    heartbeat.stop()
    console.log('[ZeRo OS] Heartbeat stopped')
  }
  sessionManager.flushAll()
  console.log('[ZeRo OS] Sessions flushed to DB')
  sessionDb.close()
  console.log('[ZeRo OS] Session DB closed')
  metrics.close()
  console.log('[ZeRo OS] Metrics DB closed')
}

async function closeChannels(channels: Map<string, Channel>): Promise<void> {
  for (const [, channel] of channels) {
    try {
      await channel.stop()
    } catch {}
  }
  console.log('[ZeRo OS] Channels closed')
}

function publishShuttingDownHeartbeat(heartbeat: HeartbeatWriter): void {
  heartbeat.setReady(false, 'shutting_down')
  try {
    heartbeat.write()
  } catch (error) {
    console.warn('[ZeRo OS] Failed to publish shutting-down heartbeat:', error)
  } finally {
    heartbeat.stop()
  }
  console.log('[ZeRo OS] Heartbeat marked shutting down and stopped')
}
