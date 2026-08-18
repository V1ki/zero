import { describe, expect, test } from 'bun:test'
import type * as lark from '@larksuiteoapi/node-sdk'
import { createFeishuStreamingSession } from '../feishu/streaming-session'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

interface CardElementUpdate {
  data: {
    content: string
    sequence: number
  }
}

interface CardUpdate {
  data: {
    card: {
      data: string
    }
    sequence: number
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function settleWithin<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`test timed out after ${timeoutMs}ms`)), timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function createClient(options?: {
  updateElement?: (payload: CardElementUpdate) => Promise<void>
  finalizeCard?: (payload: CardUpdate) => Promise<void>
}): lark.Client {
  return {
    cardkit: {
      v1: {
        card: {
          create: async () => ({ data: { card_id: 'card-stream' } }),
          update: options?.finalizeCard ?? (async () => undefined),
        },
        cardElement: {
          content: options?.updateElement ?? (async () => undefined),
        },
      },
    },
  } as unknown as lark.Client
}

function createSession(
  client: lark.Client,
  options?: {
    deleteMessage?: (messageId: string) => Promise<void>
    deliverUnresolvedInlineImages?: () => Promise<void>
    operationTimeoutMs?: number
    finalizationTimeoutMs?: number
  },
) {
  return createFeishuStreamingSession({
    client,
    attachMessage: async () => 'om-stream',
    fallbackTarget: { chatId: 'chat-1' },
    deliverUnresolvedInlineImages:
      options?.deliverUnresolvedInlineImages ?? (async () => undefined),
    deleteMessage: options?.deleteMessage ?? (async () => undefined),
    operationTimeoutMs: options?.operationTimeoutMs,
    finalizationTimeoutMs: options?.finalizationTimeoutMs,
  })
}

describe('Feishu streaming session cleanup', () => {
  test('preserves ordered update and completion on the happy path', async () => {
    const elementUpdates: CardElementUpdate[] = []
    const finalUpdates: CardUpdate[] = []
    const flushStarted = createDeferred<void>()
    const client = createClient({
      updateElement: async (payload) => {
        elementUpdates.push(payload)
        flushStarted.resolve()
      },
      finalizeCard: async (payload) => {
        finalUpdates.push(payload)
      },
    })
    const session = await createSession(client)

    await session.update('draft')
    await settleWithin(flushStarted.promise)
    await session.complete('final')

    expect(elementUpdates).toHaveLength(1)
    expect(elementUpdates[0].data).toEqual({ content: 'draft', sequence: 0 })
    expect(finalUpdates).toHaveLength(1)
    expect(finalUpdates[0].data.sequence).toBe(1)
    expect(JSON.parse(finalUpdates[0].data.card.data).body.elements[0].content).toBe('final')
  })

  test('completion bypasses a hung flush and fences its late update behind the terminal card', async () => {
    const flushStarted = createDeferred<void>()
    const releaseFlush = createDeferred<void>()
    const flushSettled = createDeferred<void>()
    const elementSequences: number[] = []
    const finalSequences: number[] = []
    let appliedSequence = -1
    let visibleContent = ''
    const client = createClient({
      updateElement: async (payload) => {
        elementSequences.push(payload.data.sequence)
        flushStarted.resolve()
        await releaseFlush.promise
        if (payload.data.sequence >= appliedSequence) {
          appliedSequence = payload.data.sequence
          visibleContent = payload.data.content
        }
        flushSettled.resolve()
      },
      finalizeCard: async (payload) => {
        finalSequences.push(payload.data.sequence)
        if (payload.data.sequence >= appliedSequence) {
          appliedSequence = payload.data.sequence
          visibleContent = JSON.parse(payload.data.card.data).body.elements[0].content
        }
      },
    })
    const session = await createSession(client, {
      operationTimeoutMs: 250,
      finalizationTimeoutMs: 20,
    })

    await session.update('stale draft')
    await settleWithin(flushStarted.promise)
    await settleWithin(session.complete('terminal answer'))

    expect(elementSequences).toEqual([0])
    expect(finalSequences).toEqual([1])
    expect(visibleContent).toBe('terminal answer')

    releaseFlush.resolve()
    await settleWithin(flushSettled.promise)
    expect(visibleContent).toBe('terminal answer')
  })

  test('abort settles while a prior card update is hung', async () => {
    const flushStarted = createDeferred<void>()
    const releaseFlush = createDeferred<void>()
    const terminalUpdates: CardUpdate[] = []
    const client = createClient({
      updateElement: async () => {
        flushStarted.resolve()
        await releaseFlush.promise
      },
      finalizeCard: async (payload) => {
        terminalUpdates.push(payload)
      },
    })
    const session = await createSession(client, {
      operationTimeoutMs: 250,
      finalizationTimeoutMs: 20,
    })

    await session.update('draft')
    await settleWithin(flushStarted.promise)
    await settleWithin(session.abort('stopped'))

    expect(terminalUpdates).toHaveLength(1)
    expect(terminalUpdates[0].data.sequence).toBe(1)
    expect(JSON.parse(terminalUpdates[0].data.card.data).body.elements[0].content).toBe('stopped')

    releaseFlush.resolve()
  })

  test('dismiss settles and deletes the message while a prior card update is hung', async () => {
    const flushStarted = createDeferred<void>()
    const releaseFlush = createDeferred<void>()
    const deletedMessageIds: string[] = []
    const client = createClient({
      updateElement: async () => {
        flushStarted.resolve()
        await releaseFlush.promise
      },
    })
    const session = await createSession(client, {
      deleteMessage: async (messageId) => {
        deletedMessageIds.push(messageId)
      },
      operationTimeoutMs: 250,
      finalizationTimeoutMs: 20,
    })

    await session.update('draft')
    await settleWithin(flushStarted.promise)
    await settleWithin(session.dismiss())

    expect(deletedMessageIds).toEqual(['om-stream'])
    releaseFlush.resolve()
  })

  test('settles finalization after its own operation timeout and observes a late rejection', async () => {
    const finalUpdate = createDeferred<void>()
    const client = createClient({
      finalizeCard: async () => finalUpdate.promise,
    })
    const session = await createSession(client, {
      operationTimeoutMs: 20,
      finalizationTimeoutMs: 20,
    })

    await settleWithin(session.complete('final'))

    finalUpdate.reject(new Error('late CardKit failure'))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  test('completion is not blocked by hung unresolved image delivery', async () => {
    const session = await createSession(createClient(), {
      deliverUnresolvedInlineImages: () => new Promise<void>(() => {}),
      operationTimeoutMs: 20,
      finalizationTimeoutMs: 20,
    })

    await settleWithin(session.complete('final'))
  })
})
