import type { Channel } from '@zero-os/channel'
import { describeError } from '@zero-os/shared'
import type { ChannelRuntimeDefinition } from './channel-runtime/types'

export const DEFAULT_CHANNEL_RECOVERY_OPTIONS = {
  checkIntervalMs: 15_000,
  disconnectedGraceMs: 180_000,
  baseBackoffMs: 30_000,
  maxBackoffMs: 10 * 60_000,
  recoveryTimeoutMs: 30_000,
  maxConcurrentRecoveries: 1,
} as const

export type ChannelRecoveryState =
  | 'connected'
  | 'disconnected_grace'
  | 'recovering'
  | 'timed_out'
  | 'backoff'
  | 'waiting_capacity'
  | 'missing'
  | 'stopped'

export interface ChannelRecoverySnapshot {
  name: string
  type: string
  connected: boolean
  state: ChannelRecoveryState
  disconnectedSince: number | null
  attemptCount: number
  consecutiveFailures: number
  inFlight: boolean
  nextAttemptAt: number | null
  lastAttemptAt: number | null
  lastRecoveredAt: number | null
  lastError: string | null
}

export interface ChannelRecoveryLogger {
  info(message: string): void
  warn(message: string): void
}

export type ChannelRecoveryTimerHandle = ReturnType<typeof setTimeout>

export interface ChannelRecoveryTimers {
  setInterval(callback: () => void, intervalMs: number): ChannelRecoveryTimerHandle
  clearInterval(handle: ChannelRecoveryTimerHandle): void
  setTimeout(callback: () => void, timeoutMs: number): ChannelRecoveryTimerHandle
  clearTimeout(handle: ChannelRecoveryTimerHandle): void
}

export interface ChannelRecoveryControllerOptions {
  channels: ReadonlyMap<string, Channel>
  channelDefinitions: ReadonlyMap<string, ChannelRuntimeDefinition>
  checkIntervalMs?: number
  disconnectedGraceMs?: number
  baseBackoffMs?: number
  maxBackoffMs?: number
  recoveryTimeoutMs?: number
  maxConcurrentRecoveries?: number
  clock?: () => number
  timers?: ChannelRecoveryTimers
  logger?: ChannelRecoveryLogger
}

interface RecoverableChannel extends Channel {
  recover?(): Promise<void>
}

interface MutableChannelRecoveryState extends ChannelRecoverySnapshot {
  attemptToken: number
  attemptLifecycle: number | null
  inFlightPromise: Promise<void> | null
  timeoutHandle: ChannelRecoveryTimerHandle | null
  timeoutObserved: boolean
  cleanupAfterControllerStop: boolean
  lastConnectionError: string | null
  retired: boolean
}

const systemTimers: ChannelRecoveryTimers = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle),
  setTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clearTimeout: (handle) => clearTimeout(handle),
}

export class ChannelRecoveryController {
  private readonly channels: ReadonlyMap<string, Channel>
  private readonly channelDefinitions: ReadonlyMap<string, ChannelRuntimeDefinition>
  private readonly checkIntervalMs: number
  private readonly disconnectedGraceMs: number
  private readonly baseBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly recoveryTimeoutMs: number
  private readonly maxConcurrentRecoveries: number
  private readonly clock: () => number
  private readonly timers: ChannelRecoveryTimers
  private readonly logger: ChannelRecoveryLogger
  private readonly states = new Map<string, MutableChannelRecoveryState>()
  private intervalHandle: ChannelRecoveryTimerHandle | null = null
  private running = false
  private lifecycle = 0

  constructor(options: ChannelRecoveryControllerOptions) {
    this.channels = options.channels
    this.channelDefinitions = options.channelDefinitions
    this.checkIntervalMs = readPositiveDuration(
      'checkIntervalMs',
      options.checkIntervalMs,
      DEFAULT_CHANNEL_RECOVERY_OPTIONS.checkIntervalMs,
    )
    this.disconnectedGraceMs = readNonNegativeDuration(
      'disconnectedGraceMs',
      options.disconnectedGraceMs,
      DEFAULT_CHANNEL_RECOVERY_OPTIONS.disconnectedGraceMs,
    )
    this.baseBackoffMs = readNonNegativeDuration(
      'baseBackoffMs',
      options.baseBackoffMs,
      DEFAULT_CHANNEL_RECOVERY_OPTIONS.baseBackoffMs,
    )
    this.maxBackoffMs = readNonNegativeDuration(
      'maxBackoffMs',
      options.maxBackoffMs,
      DEFAULT_CHANNEL_RECOVERY_OPTIONS.maxBackoffMs,
    )
    this.recoveryTimeoutMs = readPositiveDuration(
      'recoveryTimeoutMs',
      options.recoveryTimeoutMs,
      DEFAULT_CHANNEL_RECOVERY_OPTIONS.recoveryTimeoutMs,
    )
    this.maxConcurrentRecoveries = readPositiveDuration(
      'maxConcurrentRecoveries',
      options.maxConcurrentRecoveries,
      DEFAULT_CHANNEL_RECOVERY_OPTIONS.maxConcurrentRecoveries,
    )
    if (this.maxBackoffMs < this.baseBackoffMs) {
      throw new Error('maxBackoffMs must be greater than or equal to baseBackoffMs')
    }

    this.clock = options.clock ?? Date.now
    this.timers = options.timers ?? systemTimers
    this.logger = options.logger ?? console
  }

  start(): void {
    if (this.running) return

    this.running = true
    this.lifecycle += 1
    this.intervalHandle = this.timers.setInterval(() => {
      this.tick()
    }, this.checkIntervalMs)
    this.logger.info(
      `[ZeRo OS] Channel recovery controller started: interval_ms=${this.checkIntervalMs}`,
    )
    this.tick()
  }

  stop(): void {
    if (!this.running && this.intervalHandle === null) return

    this.running = false
    this.lifecycle += 1
    if (this.intervalHandle !== null) {
      this.timers.clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }

    for (const state of this.states.values()) {
      this.clearAttemptTimeout(state)
      this.transition(state, 'stopped', 'controller_stopped')
    }
    this.logger.info('[ZeRo OS] Channel recovery controller stopped')
  }

  isRunning(): boolean {
    return this.running
  }

  /**
   * Run one deterministic health pass. Recovery work is started asynchronously
   * and remains single-flight per channel even after its timeout is observed.
   */
  tick(now = this.clock()): void {
    if (!this.running) return

    const monitoredNames = new Set<string>()
    for (const definition of this.channelDefinitions.values()) {
      if (!isMonitoredDefinition(definition)) continue

      monitoredNames.add(definition.name)
      const state = this.getOrCreateState(definition)
      state.retired = false
      this.observeChannel(state, definition, now)
    }

    for (const [name, state] of this.states) {
      if (monitoredNames.has(name)) continue

      state.retired = true
      this.clearAttemptTimeout(state)
      this.transition(state, 'stopped', 'channel_no_longer_configured')
      if (!state.inFlightPromise) this.states.delete(name)
    }
  }

  getSnapshot(): ChannelRecoverySnapshot[] {
    return Array.from(this.states.values())
      .filter((state) => !state.retired)
      .map((state) => ({
        name: state.name,
        type: state.type,
        connected: state.connected,
        state: state.state,
        disconnectedSince: state.disconnectedSince,
        attemptCount: state.attemptCount,
        consecutiveFailures: state.consecutiveFailures,
        inFlight: state.inFlightPromise !== null,
        nextAttemptAt: state.nextAttemptAt,
        lastAttemptAt: state.lastAttemptAt,
        lastRecoveredAt: state.lastRecoveredAt,
        lastError: state.lastError,
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  private getOrCreateState(definition: ChannelRuntimeDefinition): MutableChannelRecoveryState {
    const existing = this.states.get(definition.name)
    if (existing) return existing

    const state: MutableChannelRecoveryState = {
      name: definition.name,
      type: definition.type,
      connected: false,
      state: 'stopped',
      disconnectedSince: null,
      attemptCount: 0,
      consecutiveFailures: 0,
      inFlight: false,
      nextAttemptAt: null,
      lastAttemptAt: null,
      lastRecoveredAt: null,
      lastError: null,
      attemptToken: 0,
      attemptLifecycle: null,
      inFlightPromise: null,
      timeoutHandle: null,
      timeoutObserved: false,
      cleanupAfterControllerStop: false,
      lastConnectionError: null,
      retired: false,
    }
    this.states.set(definition.name, state)
    return state
  }

  private observeChannel(
    state: MutableChannelRecoveryState,
    definition: ChannelRuntimeDefinition,
    now: number,
  ): void {
    const channel = this.channels.get(definition.name)
    if (!channel) {
      state.connected = false
      state.disconnectedSince ??= now
      if (!state.inFlightPromise) this.transition(state, 'missing', 'channel_instance_missing')
      return
    }

    state.type = channel.type
    state.connected = this.readConnected(state, channel)
    if (state.inFlightPromise) return

    if (state.connected) {
      this.markConnected(state, now)
      return
    }

    if (state.disconnectedSince === null) {
      state.disconnectedSince = now
      state.nextAttemptAt = null
      this.transition(state, 'disconnected_grace', `grace_ms=${this.disconnectedGraceMs}`)
    }

    const disconnectedForMs = Math.max(0, now - state.disconnectedSince)
    if (disconnectedForMs < this.disconnectedGraceMs) {
      this.transition(
        state,
        'disconnected_grace',
        `disconnected_for_ms=${disconnectedForMs} grace_ms=${this.disconnectedGraceMs}`,
      )
      return
    }

    if (state.nextAttemptAt !== null && now < state.nextAttemptAt) {
      this.transition(
        state,
        'backoff',
        `next_attempt_at=${state.nextAttemptAt} wait_ms=${state.nextAttemptAt - now}`,
      )
      return
    }

    const activeRecoveries = this.countActiveRecoveries()
    if (activeRecoveries >= this.maxConcurrentRecoveries) {
      this.transition(
        state,
        'waiting_capacity',
        `active_recoveries=${activeRecoveries} max_concurrent=${this.maxConcurrentRecoveries}`,
      )
      return
    }

    this.beginRecovery(state, channel, now)
  }

  private beginRecovery(state: MutableChannelRecoveryState, channel: Channel, now: number): void {
    if (!this.running || state.inFlightPromise) return

    const attemptToken = state.attemptToken + 1
    const attemptLifecycle = this.lifecycle
    state.attemptToken = attemptToken
    state.attemptLifecycle = attemptLifecycle
    state.attemptCount += 1
    state.lastAttemptAt = now
    state.nextAttemptAt = null
    state.timeoutObserved = false
    state.cleanupAfterControllerStop = false
    state.lastError = null
    this.transition(state, 'recovering', `attempt=${state.attemptCount}`)

    const attempt = this.performRecovery(state, channel as RecoverableChannel, attemptLifecycle)
    state.inFlightPromise = attempt
    state.timeoutHandle = this.timers.setTimeout(() => {
      this.observeAttemptTimeout(state, attemptToken)
    }, this.recoveryTimeoutMs)

    void attempt.then(
      () => {
        this.finishAttempt(state, attemptToken)
      },
      (error: unknown) => {
        this.finishAttempt(state, attemptToken, error)
      },
    )
  }

  private async performRecovery(
    state: MutableChannelRecoveryState,
    channel: RecoverableChannel,
    attemptLifecycle: number,
  ): Promise<void> {
    if (typeof channel.recover === 'function') {
      state.cleanupAfterControllerStop = true
      await channel.recover()
      return
    }

    await channel.stop()
    if (
      !this.running ||
      this.lifecycle !== attemptLifecycle ||
      !this.isStillMonitored(state.name) ||
      this.channels.get(state.name) !== channel
    ) {
      return
    }
    state.cleanupAfterControllerStop = true
    await channel.start()
  }

  private observeAttemptTimeout(state: MutableChannelRecoveryState, attemptToken: number): void {
    if (
      !this.running ||
      state.attemptToken !== attemptToken ||
      !state.inFlightPromise ||
      state.timeoutObserved
    ) {
      return
    }

    state.timeoutHandle = null
    state.timeoutObserved = true
    state.lastError = `recovery attempt timed out after ${this.recoveryTimeoutMs}ms`
    this.transition(
      state,
      'timed_out',
      `attempt=${state.attemptCount} timeout_ms=${this.recoveryTimeoutMs}`,
    )
  }

  private finishAttempt(
    state: MutableChannelRecoveryState,
    attemptToken: number,
    error?: unknown,
  ): void {
    if (state.attemptToken !== attemptToken) return

    const attemptLifecycle = state.attemptLifecycle
    this.clearAttemptTimeout(state)
    state.inFlightPromise = null
    state.attemptLifecycle = null

    if (state.retired) {
      this.states.delete(state.name)
      return
    }
    if (!this.running) {
      if (state.cleanupAfterControllerStop) {
        const channel = this.channels.get(state.name)
        if (channel) {
          void channel.stop().catch((stopError: unknown) => {
            this.logger.warn(
              `[ZeRo OS] Failed to stop channel after late recovery: ${formatChannel(state)} ${formatErrorDetail(describeError(stopError))}`,
            )
          })
        }
      }
      state.cleanupAfterControllerStop = false
      this.transition(state, 'stopped', 'controller_stopped_during_recovery')
      return
    }
    state.cleanupAfterControllerStop = false

    const channel = this.channels.get(state.name)
    if (attemptLifecycle !== this.lifecycle) {
      if (channel) {
        state.connected = this.readConnected(state, channel)
        if (state.connected) {
          this.markConnected(state, this.clock())
          return
        }
      }
      state.disconnectedSince ??= this.clock()
      state.nextAttemptAt = null
      this.transition(state, 'disconnected_grace', 'previous_lifecycle_attempt_finished')
      return
    }

    if (!channel) {
      state.connected = false
      state.lastError = error ? describeError(error) : 'channel instance missing after recovery'
      this.transition(state, 'missing', formatErrorDetail(state.lastError))
      return
    }

    state.connected = this.readConnected(state, channel)
    if (state.connected) {
      this.markConnected(state, this.clock())
      return
    }

    state.consecutiveFailures += 1
    const failureMessage = error
      ? describeError(error)
      : state.timeoutObserved
        ? (state.lastError ?? `recovery attempt timed out after ${this.recoveryTimeoutMs}ms`)
        : 'recovery completed but channel is still disconnected'
    state.lastError = failureMessage
    const backoffMs = this.calculateBackoff(state.consecutiveFailures)
    state.nextAttemptAt = this.clock() + backoffMs
    this.transition(
      state,
      'backoff',
      [
        `attempt=${state.attemptCount}`,
        `backoff_ms=${backoffMs}`,
        formatErrorDetail(failureMessage),
      ].join(' '),
    )
  }

  private markConnected(state: MutableChannelRecoveryState, now: number): void {
    const recovered = state.disconnectedSince !== null
    state.connected = true
    state.disconnectedSince = null
    state.consecutiveFailures = 0
    state.nextAttemptAt = null
    state.lastError = null
    state.timeoutObserved = false
    if (recovered) state.lastRecoveredAt = now
    this.transition(state, 'connected', recovered ? `recovered_at=${now}` : 'healthy')
  }

  private readConnected(state: MutableChannelRecoveryState, channel: Channel): boolean {
    try {
      const connected = channel.isConnected()
      state.lastConnectionError = null
      return connected
    } catch (error) {
      const description = describeError(error)
      state.lastError = `isConnected failed: ${description}`
      if (state.lastConnectionError !== description) {
        state.lastConnectionError = description
        this.logger.warn(
          `[ZeRo OS] Channel recovery health check failed: ${formatChannel(state)} error=${JSON.stringify(description)}`,
        )
      }
      return false
    }
  }

  private calculateBackoff(consecutiveFailures: number): number {
    if (this.baseBackoffMs === 0) return 0
    const exponent = Math.min(30, Math.max(0, consecutiveFailures - 1))
    return Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** exponent)
  }

  private isStillMonitored(name: string): boolean {
    const definition = this.channelDefinitions.get(name)
    return definition !== undefined && isMonitoredDefinition(definition)
  }

  private clearAttemptTimeout(state: MutableChannelRecoveryState): void {
    if (state.timeoutHandle === null) return
    this.timers.clearTimeout(state.timeoutHandle)
    state.timeoutHandle = null
  }

  private transition(
    state: MutableChannelRecoveryState,
    nextState: ChannelRecoveryState,
    detail: string,
  ): void {
    if (state.state === nextState) return

    const previousState = state.state
    state.state = nextState
    const message =
      `[ZeRo OS] Channel recovery state changed: ${formatChannel(state)} ` +
      `from=${previousState} to=${nextState} ${detail}`
    if (
      nextState === 'disconnected_grace' ||
      nextState === 'timed_out' ||
      nextState === 'backoff' ||
      nextState === 'waiting_capacity' ||
      nextState === 'missing'
    ) {
      this.logger.warn(message)
      return
    }
    this.logger.info(message)
  }

  private countActiveRecoveries(): number {
    let activeRecoveries = 0
    for (const state of this.states.values()) {
      // A timed-out attempt remains single-flight for its own channel, but it
      // must not consume the global recovery slot forever.
      if (state.inFlightPromise && !state.timeoutObserved) activeRecoveries += 1
    }
    return activeRecoveries
  }
}

export function createChannelRecoveryController(
  options: ChannelRecoveryControllerOptions,
): ChannelRecoveryController {
  return new ChannelRecoveryController(options)
}

function isMonitoredDefinition(definition: ChannelRuntimeDefinition): boolean {
  return definition.configured && definition.type !== 'web'
}

function formatChannel(state: Pick<ChannelRecoverySnapshot, 'name' | 'type'>): string {
  return `name=${JSON.stringify(state.name)} type=${JSON.stringify(state.type)}`
}

function formatErrorDetail(error: string): string {
  return `error=${JSON.stringify(error)}`
}

function readPositiveDuration(name: string, value: number | undefined, fallback: number): number {
  const duration = value ?? fallback
  if (!Number.isFinite(duration) || !Number.isInteger(duration) || duration <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return duration
}

function readNonNegativeDuration(
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  const duration = value ?? fallback
  if (!Number.isFinite(duration) || !Number.isInteger(duration) || duration < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return duration
}
