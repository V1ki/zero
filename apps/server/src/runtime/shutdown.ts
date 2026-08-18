import type { Channel, FeishuStreamingSession } from '@zero-os/channel'
import type { SessionManager } from '@zero-os/core'
import type { MetricsDB, SessionDB } from '@zero-os/observe'
import type { CronScheduler } from '@zero-os/scheduler'
import type { HeartbeatWriter } from '@zero-os/supervisor'
import { abortActiveStreamingSessions } from './channel-runtime/runtime'
import { recordRestartSentinel } from './restart'

interface ShutdownRuntimeOptions {
  zeroDir: string
  restartSentinelPath: string
  scheduler: CronScheduler
  sessionManager: SessionManager
  channels: Map<string, Channel>
  stopChannelRecovery?: () => void
  disposeRuntimeEventListeners(): void
  disposePricing(): void
  heartbeat: HeartbeatWriter
  sessionDb: SessionDB
  metrics: MetricsDB
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
  stopChannelRecovery?: () => void
  disposeRuntimeEventListeners(): void
  disposePricing(): void
  heartbeat: HeartbeatWriter
  sessionDb: SessionDB
  metrics: MetricsDB
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
  zeroDir,
  restartSentinelPath,
  scheduler,
  sessionManager,
  channels,
  stopChannelRecovery,
  disposeRuntimeEventListeners,
  disposePricing,
  heartbeat,
  sessionDb,
  metrics,
  skipProcessExit,
}: ShutdownRuntimeOptions): ShutdownRuntime {
  let shuttingDown = false
  const activeStreamingSessionSets: Set<FeishuStreamingSession>[] = []

  return {
    isShuttingDown: () => shuttingDown,
    registerFeishuStreamingSessionSet(sessionSet) {
      activeStreamingSessionSets.push(sessionSet)
    },
    async shutdown() {
      if (shuttingDown) return
      shuttingDown = true
      await runShutdownSequence({
        zeroDir,
        restartSentinelPath,
        scheduler,
        sessionManager,
        channels,
        activeStreamingSessionSets,
        stopChannelRecovery,
        disposeRuntimeEventListeners,
        disposePricing,
        heartbeat,
        sessionDb,
        metrics,
      })
      if (!skipProcessExit) process.exit(0)
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
  disposeRuntimeEventListeners,
  disposePricing,
  heartbeat,
  sessionDb,
  metrics,
}: ShutdownSequenceOptions): Promise<void> {
  console.log('\n[ZeRo OS] Shutting down...')
  publishShuttingDownHeartbeat(heartbeat)
  stopChannelRecovery?.()
  scheduler.stop()
  console.log('[ZeRo OS] Scheduler stopped')

  await recordRestartSentinel({
    zeroDir,
    restartSentinelPath,
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
