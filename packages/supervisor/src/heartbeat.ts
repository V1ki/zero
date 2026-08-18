import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const HEARTBEAT_INTERVAL = 3_000 // 3 seconds
const STALE_THRESHOLD = 30_000 // 10 missed 3-second heartbeats
const ERROR_THRESHOLD_UNHEALTHY = 10
const ERROR_THRESHOLD_DEGRADED = 3
const READY_WAIT_TIMEOUT_MS = 300_000
const READY_POLL_INTERVAL_MS = 1_000
const PROCESS_BOOT_ID = randomUUID()

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy'

export interface ChannelHealthMetrics {
  name: string
  type: string
  connected: boolean
  configured: boolean
  recoveryState?: string
  recoveryAttempts?: number
  disconnectedSince?: number | null
  nextRecoveryAt?: number | null
  lastRecoveredAt?: number | null
  lastRecoveryError?: string | null
}

export interface HealthMetrics {
  errorCount: number
  channels: ChannelHealthMetrics[]
}

export interface HeartbeatData {
  timestamp: string
  pid: number
  /** Absent only in heartbeat files written by pre-identity releases. */
  bootId?: string
  /** Absent only in heartbeat files written by pre-identity releases. */
  sequence?: number
  uptime: number
  ready: boolean
  stage: string
  health: {
    memoryUsageMB: number
    errorCount: number
    status: HealthStatus
    channels: {
      total: number
      configured: number
      connected: number
      disconnected: number
      offline: string[]
    }
  }
  channels: ChannelHealthMetrics[]
}

export interface HeartbeatWriterOptions {
  bootId?: string
}

/**
 * Heartbeat writer — called by the main process.
 */
export class HeartbeatWriter {
  private filePath: string
  private tempFilePath: string
  private bootId: string
  private sequence = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private healthMetrics: HealthMetrics = { errorCount: 0, channels: [] }
  private metricsProvider: (() => Partial<HealthMetrics>) | null = null
  private onWrite: ((data: HeartbeatData) => void) | null = null
  private lastHeartbeat: HeartbeatData | null = null
  private ready = false
  private stage = 'booting'

  constructor(filePath: string, options: HeartbeatWriterOptions = {}) {
    this.filePath = filePath
    this.tempFilePath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    this.bootId = options.bootId ?? PROCESS_BOOT_ID
    const dir = dirname(filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  /**
   * Update health metrics from the main process.
   */
  setHealthMetrics(metrics: Partial<HealthMetrics>): void {
    this.healthMetrics = {
      ...this.healthMetrics,
      ...metrics,
      channels: metrics.channels ?? this.healthMetrics.channels,
    }
  }

  /**
   * Register a callback that can provide live metrics right before each write.
   */
  setHealthMetricsProvider(provider: (() => Partial<HealthMetrics>) | null): void {
    this.metricsProvider = provider
  }

  /**
   * Register a callback fired after each heartbeat write.
   */
  setOnWrite(callback: ((data: HeartbeatData) => void) | null): void {
    this.onWrite = callback
  }

  /**
   * Return the latest heartbeat snapshot written by this process.
   */
  getLastHeartbeat(): HeartbeatData | null {
    return this.lastHeartbeat
  }

  /**
   * Update runtime readiness state.
   */
  setReady(ready: boolean, stage = ready ? 'ready' : this.stage): void {
    this.ready = ready
    this.stage = stage
  }

  /**
   * Start writing heartbeats at the configured interval.
   */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.write(), HEARTBEAT_INTERVAL)
    try {
      this.write()
    } catch (error) {
      this.stop()
      throw error
    }
  }

  /**
   * Stop writing heartbeats.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Write a single heartbeat.
   */
  write(): void {
    const liveMetrics = this.metricsProvider?.() ?? {}
    const channels = liveMetrics.channels ?? this.healthMetrics.channels
    const errorCount = liveMetrics.errorCount ?? this.healthMetrics.errorCount
    const configuredChannels = channels.filter((channel) => channel.configured)
    const offlineChannels = configuredChannels
      .filter((channel) => !channel.connected)
      .map((channel) => channel.name)
    let status: HealthStatus = 'healthy'
    if (errorCount >= ERROR_THRESHOLD_UNHEALTHY) {
      status = 'unhealthy'
    } else if (errorCount >= ERROR_THRESHOLD_DEGRADED || offlineChannels.length > 0) {
      status = 'degraded'
    }

    const sequence = this.sequence + 1
    const data: HeartbeatData = {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      bootId: this.bootId,
      sequence,
      uptime: process.uptime(),
      ready: this.ready,
      stage: this.stage,
      health: {
        memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        errorCount,
        status,
        channels: {
          total: channels.length,
          configured: configuredChannels.length,
          connected: configuredChannels.filter((channel) => channel.connected).length,
          disconnected: offlineChannels.length,
          offline: offlineChannels,
        },
      },
      channels,
    }

    try {
      writeFileSync(this.tempFilePath, JSON.stringify(data), 'utf-8')
      renameSync(this.tempFilePath, this.filePath)
    } catch (error) {
      if (existsSync(this.tempFilePath)) {
        try {
          unlinkSync(this.tempFilePath)
        } catch {}
      }
      throw error
    }

    this.sequence = sequence
    this.lastHeartbeat = data
    this.onWrite?.(data)
  }
}

export interface HeartbeatCheckResult {
  alive: boolean
  lastBeat?: Date
  elapsedMs?: number
  pid?: number
  bootId?: string
  sequence?: number
  uptime?: number
  ready?: boolean
  stage?: string
  health?: HeartbeatData['health']
}

/**
 * Heartbeat checker — called by the supervisor process.
 */
export class HeartbeatChecker {
  private filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  /**
   * Check if the main process is alive.
   */
  check(): HeartbeatCheckResult {
    if (!existsSync(this.filePath)) {
      return { alive: false }
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      const data = JSON.parse(raw) as HeartbeatData
      const lastBeat = new Date(data.timestamp)
      const elapsedMs = Date.now() - lastBeat.getTime()

      return {
        alive: elapsedMs < STALE_THRESHOLD,
        lastBeat,
        elapsedMs,
        pid: data.pid,
        bootId: data.bootId,
        sequence: data.sequence,
        uptime: data.uptime,
        ready: data.ready,
        stage: data.stage,
        health: data.health,
      }
    } catch {
      return { alive: false }
    }
  }
}

export async function waitForHeartbeatReady(
  checker: HeartbeatChecker,
  options: {
    timeoutMs?: number
    pollIntervalMs?: number
    expectedPid?: number
    expectedBootId?: string
    notBefore?: Date | number
    signal?: AbortSignal
  } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? READY_WAIT_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? READY_POLL_INTERVAL_MS
  const notBeforeMs =
    options.notBefore instanceof Date ? options.notBefore.getTime() : options.notBefore
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    if (options.signal?.aborted) return false
    const result = checker.check()
    const matchesPid = options.expectedPid === undefined || result.pid === options.expectedPid
    const matchesBootId =
      options.expectedBootId === undefined || result.bootId === options.expectedBootId
    const isRecentEnough =
      notBeforeMs === undefined ||
      (result.lastBeat !== undefined && result.lastBeat.getTime() >= notBeforeMs)

    if (result.alive && result.ready && matchesPid && matchesBootId && isRecentEnough) {
      return true
    }

    await waitForNextReadyPoll(pollIntervalMs, options.signal)
  }

  return false
}

function waitForNextReadyPoll(pollIntervalMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  if (signal.aborted) return Promise.resolve()

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, pollIntervalMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
