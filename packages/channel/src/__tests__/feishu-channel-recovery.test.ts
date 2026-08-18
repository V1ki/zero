import { describe, expect, spyOn, test } from 'bun:test'
import type * as lark from '@larksuiteoapi/node-sdk'
import { FeishuChannel, type FeishuChannelFactories } from '../feishu'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

interface CapturedSdkLogger {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  trace: (...args: unknown[]) => void
}

interface FakeWsClient {
  logger: CapturedSdkLogger
  startCalls: number
  closeCalls: Array<{ force?: boolean } | undefined>
}

interface FakeDispatcher {
  handlers: Record<string, (data: unknown) => unknown>
}

function deferred(): Deferred {
  let resolve = () => {}
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createFactories(startResults: Promise<void>[] = []) {
  const wsClients: FakeWsClient[] = []
  const dispatchers: FakeDispatcher[] = []

  const factories: FeishuChannelFactories = {
    createClient: () => ({}) as lark.Client,
    createEventDispatcher: () => {
      const captured: FakeDispatcher = { handlers: {} }
      const dispatcher = {
        register: (handlers: unknown) => {
          Object.assign(captured.handlers, handlers as Record<string, (data: unknown) => unknown>)
          return dispatcher
        },
      }
      dispatchers.push(captured)
      return dispatcher as unknown as lark.EventDispatcher
    },
    createWsClient: (options) => {
      const startResult = startResults.shift() ?? Promise.resolve()
      const captured: FakeWsClient = {
        logger: options.logger as CapturedSdkLogger,
        startCalls: 0,
        closeCalls: [],
      }
      wsClients.push(captured)
      return {
        start: async () => {
          captured.startCalls++
          await startResult
        },
        close: (params) => {
          captured.closeCalls.push(params)
        },
      }
    },
  }

  return { factories, wsClients, dispatchers }
}

function incomingPayload(messageId: string) {
  return {
    sender: { sender_id: { open_id: 'ou_test' } },
    message: {
      message_id: messageId,
      chat_id: 'chat_test',
      chat_type: 'group',
      message_type: 'text',
      create_time: '1000',
      content: JSON.stringify({ text: 'hello' }),
    },
  }
}

describe('FeishuChannel recovery lifecycle', () => {
  test('start is single-flight and stop cannot let a pending generation replace a restart', async () => {
    const pendingStart = deferred()
    const harness = createFactories([pendingStart.promise, Promise.resolve()])
    const channel = new FeishuChannel(
      { appId: 'test-id', appSecret: 'test-secret' },
      harness.factories,
    )

    const firstStart = channel.start()
    const duplicateStart = channel.start()

    expect(duplicateStart).toBe(firstStart)
    expect(harness.wsClients).toHaveLength(1)
    expect(harness.wsClients[0]?.startCalls).toBe(1)

    await channel.stop()
    const restarted = channel.start()

    expect(harness.wsClients).toHaveLength(2)
    expect(harness.wsClients[0]?.closeCalls).toEqual([undefined])

    pendingStart.resolve()
    await firstStart
    await restarted

    expect(harness.wsClients[0]?.closeCalls).toEqual([undefined, { force: true }])
    expect(harness.wsClients[1]?.closeCalls).toEqual([])
  })

  test('recover is single-flight and stop is safe while replacement transport is starting', async () => {
    const pendingRecovery = deferred()
    const harness = createFactories([Promise.resolve(), pendingRecovery.promise, Promise.resolve()])
    const channel = new FeishuChannel(
      { appId: 'test-id', appSecret: 'test-secret' },
      harness.factories,
    )
    await channel.start()

    const firstRecovery = channel.recover()
    const duplicateRecovery = channel.recover()

    expect(duplicateRecovery).toBe(firstRecovery)
    expect(harness.wsClients).toHaveLength(2)
    expect(harness.wsClients[0]?.closeCalls).toEqual([{ force: true }])

    await channel.stop()
    const restarted = channel.start()
    pendingRecovery.resolve()

    await firstRecovery
    await restarted

    expect(harness.wsClients).toHaveLength(3)
    expect(harness.wsClients[1]?.closeCalls).toEqual([undefined, { force: true }])
    expect(harness.wsClients[2]?.closeCalls).toEqual([])
  })

  test('recover preserves incoming dedupe state while full stop clears it', async () => {
    const harness = createFactories()
    const channel = new FeishuChannel(
      { appId: 'test-id', appSecret: 'test-secret' },
      harness.factories,
    )
    let handled = 0
    channel.setMessageHandler(async () => {
      handled++
    })

    await channel.start()
    await harness.dispatchers[0]?.handlers['im.message.receive_v1']?.(incomingPayload('msg_1'))
    expect(handled).toBe(1)

    await channel.recover()
    await harness.dispatchers[1]?.handlers['im.message.receive_v1']?.(incomingPayload('msg_1'))
    expect(handled).toBe(1)

    await channel.stop()
    await channel.start()
    await harness.dispatchers[2]?.handlers['im.message.receive_v1']?.(incomingPayload('msg_1'))
    expect(handled).toBe(2)
  })

  test('ignores late connection logs from retired transports and names sdk logs', async () => {
    const harness = createFactories()
    const channel = new FeishuChannel(
      { name: 'ops-bot', appId: 'test-id', appSecret: 'test-secret' },
      harness.factories,
    )
    await channel.start()

    harness.wsClients[0]?.logger.debug('[ws]', 'ws connect success')
    expect(channel.isConnected()).toBe(true)

    await channel.recover()
    expect(channel.isConnected()).toBe(false)

    harness.wsClients[0]?.logger.debug('[ws]', 'reconnect success')
    expect(channel.isConnected()).toBe(false)

    harness.wsClients[1]?.logger.debug('[ws]', 'ws connect success')
    expect(channel.isConnected()).toBe(true)

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      harness.wsClients[1]?.logger.warn('[ws]', 'network unavailable')
      expect(warnSpy).toHaveBeenCalledWith('[FeishuSDK:ops-bot]', '[ws] | network unavailable')
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('invalidates a failed start before retrying', async () => {
    const harness = createFactories([Promise.reject(new Error('start failed')), Promise.resolve()])
    const channel = new FeishuChannel(
      { appId: 'test-id', appSecret: 'test-secret' },
      harness.factories,
    )

    await expect(channel.start()).rejects.toThrow('start failed')
    harness.wsClients[0]?.logger.debug('[ws]', 'ws connect success')
    expect(channel.isConnected()).toBe(false)

    await channel.start()
    expect(harness.wsClients).toHaveLength(2)
    harness.wsClients[1]?.logger.debug('[ws]', 'ws connect success')
    expect(channel.isConnected()).toBe(true)
  })
})
