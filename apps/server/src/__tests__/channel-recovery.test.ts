import { describe, expect, test } from 'bun:test'
import type { Channel } from '@zero-os/channel'
import {
  ChannelRecoveryController,
  type ChannelRecoveryLogger,
  type ChannelRecoveryTimerHandle,
  type ChannelRecoveryTimers,
} from '../runtime/channel-recovery'
import type { ChannelRuntimeDefinition } from '../runtime/channel-runtime/types'

interface TestChannel extends Channel {
  connected: boolean
  calls: string[]
  recover?: () => Promise<void>
}

class ManualTimers implements ChannelRecoveryTimers {
  private nextHandle = 1
  private readonly intervals = new Map<number, () => void>()
  private readonly timeouts = new Map<number, () => void>()

  setInterval(callback: () => void): ChannelRecoveryTimerHandle {
    const handle = this.nextHandle++
    this.intervals.set(handle, callback)
    return handle as unknown as ChannelRecoveryTimerHandle
  }

  clearInterval(handle: ChannelRecoveryTimerHandle): void {
    this.intervals.delete(handle as unknown as number)
  }

  setTimeout(callback: () => void): ChannelRecoveryTimerHandle {
    const handle = this.nextHandle++
    this.timeouts.set(handle, callback)
    return handle as unknown as ChannelRecoveryTimerHandle
  }

  clearTimeout(handle: ChannelRecoveryTimerHandle): void {
    this.timeouts.delete(handle as unknown as number)
  }

  fireTimeouts(): void {
    const callbacks = Array.from(this.timeouts.values())
    this.timeouts.clear()
    for (const callback of callbacks) callback()
  }

  get intervalCount(): number {
    return this.intervals.size
  }

  get timeoutCount(): number {
    return this.timeouts.size
  }
}

function createChannel(
  name: string,
  options: {
    type?: string
    connected?: boolean
    recover?: () => Promise<void>
    stop?: () => Promise<void>
    start?: () => Promise<void>
  } = {},
): TestChannel {
  const calls: string[] = []
  const channel: TestChannel = {
    name,
    type: options.type ?? 'feishu',
    connected: options.connected ?? false,
    calls,
    async start() {
      calls.push('start')
      if (options.start) {
        await options.start()
      } else {
        channel.connected = true
      }
    },
    async stop() {
      calls.push('stop')
      channel.connected = false
      await options.stop?.()
    },
    async send() {},
    isConnected() {
      return channel.connected
    },
    setMessageHandler() {},
    getCapabilities() {
      return {}
    },
  }

  if (options.recover) {
    channel.recover = async () => {
      calls.push('recover')
      await options.recover?.()
    }
  }
  return channel
}

function createDefinition(
  name: string,
  type: ChannelRuntimeDefinition['type'] = 'feishu',
  configured = true,
): ChannelRuntimeDefinition {
  return {
    name,
    type,
    configured,
    receiveNotifications: false,
    secretRefs: [],
  }
}

function createLogger(): ChannelRecoveryLogger & { messages: string[] } {
  const messages: string[] = []
  return {
    messages,
    info: (message) => messages.push(message),
    warn: (message) => messages.push(message),
  }
}

function createDeferred(): {
  promise: Promise<void>
  resolve(): void
  reject(error: unknown): void
} {
  let resolvePromise: (() => void) | undefined
  let rejectPromise: ((error: unknown) => void) | undefined
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: () => resolvePromise?.(),
    reject: (error) => rejectPromise?.(error),
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function createController(options: {
  channels: Map<string, Channel>
  definitions: Map<string, ChannelRuntimeDefinition>
  now: { value: number }
  timers: ManualTimers
  logger?: ChannelRecoveryLogger
  disconnectedGraceMs?: number
  baseBackoffMs?: number
  maxBackoffMs?: number
  recoveryTimeoutMs?: number
  maxConcurrentRecoveries?: number
}): ChannelRecoveryController {
  return new ChannelRecoveryController({
    channels: options.channels,
    channelDefinitions: options.definitions,
    checkIntervalMs: 10,
    disconnectedGraceMs: options.disconnectedGraceMs ?? 100,
    baseBackoffMs: options.baseBackoffMs ?? 50,
    maxBackoffMs: options.maxBackoffMs ?? 200,
    recoveryTimeoutMs: options.recoveryTimeoutMs ?? 25,
    maxConcurrentRecoveries: options.maxConcurrentRecoveries,
    clock: () => options.now.value,
    timers: options.timers,
    logger: options.logger ?? createLogger(),
  })
}

describe('ChannelRecoveryController', () => {
  test('monitors only configured non-web channels and allows native recovery during grace', () => {
    const now = { value: 1_000 }
    const timers = new ManualTimers()
    const logger = createLogger()
    const feishu = createChannel('feishu-main', {
      recover: async () => {
        feishu.connected = true
      },
    })
    const web = createChannel('web', { type: 'web', connected: true })
    const disabled = createChannel('telegram-disabled', { type: 'telegram' })
    const controller = createController({
      channels: new Map([
        [feishu.name, feishu],
        [web.name, web],
        [disabled.name, disabled],
      ]),
      definitions: new Map([
        [feishu.name, createDefinition(feishu.name)],
        [web.name, createDefinition(web.name, 'web')],
        [disabled.name, createDefinition(disabled.name, 'telegram', false)],
      ]),
      now,
      timers,
      logger,
    })

    controller.start()
    expect(controller.getSnapshot()).toEqual([
      expect.objectContaining({
        name: 'feishu-main',
        state: 'disconnected_grace',
        attemptCount: 0,
      }),
    ])

    now.value = 1_099
    controller.tick()
    expect(feishu.calls).toEqual([])

    feishu.connected = true
    controller.tick()
    expect(feishu.calls).toEqual([])
    expect(controller.getSnapshot()[0]).toEqual(
      expect.objectContaining({
        connected: true,
        state: 'connected',
        lastRecoveredAt: 1_099,
      }),
    )
    expect(
      logger.messages.some(
        (message) =>
          message.includes('name="feishu-main"') &&
          message.includes('type="feishu"') &&
          message.includes('to=connected'),
      ),
    ).toBe(true)

    controller.stop()
  })

  test('uses a channel-specific recover method and otherwise falls back to stop/start', async () => {
    const now = { value: 0 }
    const timers = new ManualTimers()
    const recoverable = createChannel('feishu-main', {
      recover: async () => {
        recoverable.connected = true
      },
    })
    const fallback = createChannel('dingtalk-main', { type: 'dingtalk' })
    const controller = createController({
      channels: new Map([
        [recoverable.name, recoverable],
        [fallback.name, fallback],
      ]),
      definitions: new Map([
        [recoverable.name, createDefinition(recoverable.name)],
        [fallback.name, createDefinition(fallback.name, 'dingtalk')],
      ]),
      now,
      timers,
      disconnectedGraceMs: 0,
      maxConcurrentRecoveries: 2,
    })

    controller.start()
    await flushPromises()

    expect(recoverable.calls).toEqual(['recover'])
    expect(fallback.calls).toEqual(['stop', 'start'])
    expect(controller.getSnapshot()).toEqual([
      expect.objectContaining({ name: 'dingtalk-main', state: 'connected' }),
      expect.objectContaining({ name: 'feishu-main', state: 'connected' }),
    ])

    controller.stop()
  })

  test('applies exponential backoff capped at the configured maximum', async () => {
    const now = { value: 0 }
    const timers = new ManualTimers()
    let failures = 0
    const channel = createChannel('feishu-main', {
      recover: async () => {
        failures += 1
        throw new Error(`failure ${failures}`)
      },
    })
    const controller = createController({
      channels: new Map([[channel.name, channel]]),
      definitions: new Map([[channel.name, createDefinition(channel.name)]]),
      now,
      timers,
      disconnectedGraceMs: 0,
      baseBackoffMs: 50,
      maxBackoffMs: 200,
    })

    controller.start()
    await flushPromises()
    expect(controller.getSnapshot()[0]).toEqual(
      expect.objectContaining({
        state: 'backoff',
        consecutiveFailures: 1,
        nextAttemptAt: 50,
        lastError: 'failure 1',
      }),
    )

    now.value = 49
    controller.tick()
    expect(channel.calls).toHaveLength(1)

    now.value = 50
    controller.tick()
    await flushPromises()
    expect(controller.getSnapshot()[0]).toEqual(
      expect.objectContaining({ consecutiveFailures: 2, nextAttemptAt: 150 }),
    )

    now.value = 150
    controller.tick()
    await flushPromises()
    expect(controller.getSnapshot()[0]).toEqual(
      expect.objectContaining({ consecutiveFailures: 3, nextAttemptAt: 350 }),
    )

    now.value = 350
    controller.tick()
    await flushPromises()
    expect(controller.getSnapshot()[0]).toEqual(
      expect.objectContaining({ consecutiveFailures: 4, nextAttemptAt: 550 }),
    )

    controller.stop()
  })

  test('observes a timeout without starting an overlapping recovery attempt', async () => {
    const now = { value: 0 }
    const timers = new ManualTimers()
    const firstAttempt = createDeferred()
    const secondAttempt = createDeferred()
    let attempts = 0
    const channel = createChannel('feishu-main', {
      recover: () => {
        attempts += 1
        return attempts === 1 ? firstAttempt.promise : secondAttempt.promise
      },
    })
    const controller = createController({
      channels: new Map([[channel.name, channel]]),
      definitions: new Map([[channel.name, createDefinition(channel.name)]]),
      now,
      timers,
      disconnectedGraceMs: 0,
      baseBackoffMs: 50,
    })

    controller.start()
    expect(attempts).toBe(1)
    expect(timers.timeoutCount).toBe(1)

    timers.fireTimeouts()
    expect(controller.getSnapshot()[0]).toEqual(
      expect.objectContaining({
        state: 'timed_out',
        inFlight: true,
        attemptCount: 1,
      }),
    )

    now.value = 500
    controller.tick()
    controller.tick()
    expect(attempts).toBe(1)

    firstAttempt.resolve()
    await flushPromises()
    expect(controller.getSnapshot()[0]).toEqual(
      expect.objectContaining({
        state: 'backoff',
        inFlight: false,
        nextAttemptAt: 550,
      }),
    )

    now.value = 549
    controller.tick()
    expect(attempts).toBe(1)
    now.value = 550
    controller.tick()
    expect(attempts).toBe(2)

    controller.stop()
    secondAttempt.resolve()
    await flushPromises()
  })

  test('limits recovery concurrency and lets the next channel proceed on a later tick', async () => {
    const now = { value: 0 }
    const timers = new ManualTimers()
    const firstAttempt = createDeferred()
    const secondAttempt = createDeferred()
    const first = createChannel('feishu-first', {
      recover: async () => {
        await firstAttempt.promise
        first.connected = true
      },
    })
    const second = createChannel('feishu-second', {
      recover: async () => {
        await secondAttempt.promise
        second.connected = true
      },
    })
    const controller = createController({
      channels: new Map([
        [first.name, first],
        [second.name, second],
      ]),
      definitions: new Map([
        [first.name, createDefinition(first.name)],
        [second.name, createDefinition(second.name)],
      ]),
      now,
      timers,
      disconnectedGraceMs: 0,
    })

    controller.start()
    expect(first.calls).toEqual(['recover'])
    expect(second.calls).toEqual([])
    expect(controller.getSnapshot()).toEqual([
      expect.objectContaining({ name: first.name, state: 'recovering', inFlight: true }),
      expect.objectContaining({
        name: second.name,
        state: 'waiting_capacity',
        inFlight: false,
      }),
    ])

    firstAttempt.resolve()
    await flushPromises()
    expect(second.calls).toEqual([])

    controller.tick()
    expect(second.calls).toEqual(['recover'])
    expect(controller.getSnapshot()[1]).toEqual(
      expect.objectContaining({ name: second.name, state: 'recovering', inFlight: true }),
    )

    secondAttempt.resolve()
    await flushPromises()
    controller.stop()
  })

  test('a timed-out hung channel releases global capacity without overlapping itself', async () => {
    const now = { value: 0 }
    const timers = new ManualTimers()
    const hungAttempt = createDeferred()
    const secondAttempt = createDeferred()
    const first = createChannel('feishu-hung', {
      recover: () => hungAttempt.promise,
    })
    const second = createChannel('feishu-second', {
      recover: () => secondAttempt.promise,
    })
    const controller = createController({
      channels: new Map([
        [first.name, first],
        [second.name, second],
      ]),
      definitions: new Map([
        [first.name, createDefinition(first.name)],
        [second.name, createDefinition(second.name)],
      ]),
      now,
      timers,
      disconnectedGraceMs: 0,
    })

    controller.start()
    expect(first.calls).toEqual(['recover'])
    expect(second.calls).toEqual([])

    timers.fireTimeouts()
    controller.tick()

    expect(first.calls).toEqual(['recover'])
    expect(second.calls).toEqual(['recover'])
    expect(controller.getSnapshot()).toEqual([
      expect.objectContaining({ name: first.name, state: 'timed_out', inFlight: true }),
      expect.objectContaining({ name: second.name, state: 'recovering', inFlight: true }),
    ])

    controller.stop()
    hungAttempt.resolve()
    secondAttempt.resolve()
    await flushPromises()
  })

  test('stopping prevents new attempts and prevents fallback start after an in-flight stop', async () => {
    const now = { value: 0 }
    const timers = new ManualTimers()
    const stopped = createDeferred()
    const channel = createChannel('dingtalk-main', {
      type: 'dingtalk',
      stop: () => stopped.promise,
    })
    const controller = createController({
      channels: new Map([[channel.name, channel]]),
      definitions: new Map([[channel.name, createDefinition(channel.name, 'dingtalk')]]),
      now,
      timers,
      disconnectedGraceMs: 0,
    })

    controller.start()
    expect(channel.calls).toEqual(['stop'])
    expect(timers.intervalCount).toBe(1)
    expect(timers.timeoutCount).toBe(1)

    controller.stop()
    expect(timers.intervalCount).toBe(0)
    expect(timers.timeoutCount).toBe(0)

    stopped.resolve()
    await flushPromises()
    controller.tick(10_000)
    expect(channel.calls).toEqual(['stop'])
    expect(controller.getSnapshot()[0]).toEqual(
      expect.objectContaining({ state: 'stopped', inFlight: false }),
    )
  })

  test('stops a fallback transport that finishes starting after the controller stopped', async () => {
    const now = { value: 0 }
    const timers = new ManualTimers()
    const started = createDeferred()
    const channel = createChannel('dingtalk-main', {
      type: 'dingtalk',
      start: () => started.promise,
    })
    const controller = createController({
      channels: new Map([[channel.name, channel]]),
      definitions: new Map([[channel.name, createDefinition(channel.name, 'dingtalk')]]),
      now,
      timers,
      disconnectedGraceMs: 0,
    })

    controller.start()
    await flushPromises()
    expect(channel.calls).toEqual(['stop', 'start'])

    controller.stop()
    started.resolve()
    await flushPromises()

    expect(channel.calls).toEqual(['stop', 'start', 'stop'])
    expect(controller.getSnapshot()[0]).toEqual(
      expect.objectContaining({ state: 'stopped', inFlight: false }),
    )
  })

  test('validates recovery timing configuration', () => {
    const channels = new Map<string, Channel>()
    const definitions = new Map<string, ChannelRuntimeDefinition>()

    expect(
      () =>
        new ChannelRecoveryController({
          channels,
          channelDefinitions: definitions,
          checkIntervalMs: 0,
        }),
    ).toThrow('checkIntervalMs must be a positive integer')
    expect(
      () =>
        new ChannelRecoveryController({
          channels,
          channelDefinitions: definitions,
          baseBackoffMs: 100,
          maxBackoffMs: 50,
        }),
    ).toThrow('maxBackoffMs must be greater than or equal to baseBackoffMs')
    expect(
      () =>
        new ChannelRecoveryController({
          channels,
          channelDefinitions: definitions,
          maxConcurrentRecoveries: 0,
        }),
    ).toThrow('maxConcurrentRecoveries must be a positive integer')
  })
})
