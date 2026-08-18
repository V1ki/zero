import { describe, expect, test } from 'bun:test'
import type { Message, Session as SessionData } from '@zero-os/shared'
import { SessionTurnRuntime } from '../session-turn-runtime'

function createSessionData(): SessionData {
  const timestamp = new Date(0).toISOString()
  return {
    id: 'sess_turn_runtime_test',
    createdAt: timestamp,
    updatedAt: timestamp,
    source: 'web',
    currentModel: 'test-model',
    modelHistory: [{ model: 'test-model', from: timestamp, to: null }],
    tags: [],
  }
}

function queueMessage(runtime: SessionTurnRuntime, data: SessionData, messages: Message[]): void {
  runtime.queueMessage({
    content: 'queued input',
    messages,
    data,
    persistState: () => {},
    emitSessionUpdate: () => {},
  })
}

describe('SessionTurnRuntime health', () => {
  test('tracks active turn timing and explicit progress', async () => {
    let now = 1_000
    const runtime = new SessionTurnRuntime({ now: () => now })

    expect(runtime.getHealth()).toEqual({
      inProgress: false,
      startedAt: null,
      lastProgressAt: null,
      idleForMs: 0,
      queueDepth: 0,
      interruptRequested: false,
    })

    const lockId = await runtime.acquireTurn('turn-1')
    now = 1_250

    const beforeProgress = runtime.getHealth()
    expect(beforeProgress).toEqual({
      inProgress: true,
      startedAt: 1_000,
      lastProgressAt: 1_000,
      idleForMs: 250,
      queueDepth: 0,
      interruptRequested: false,
    })
    expect(Object.isFrozen(beforeProgress)).toBe(true)
    expect(runtime.isStalled(250)).toBe(true)

    runtime.markProgress()
    expect(runtime.isStalled(1)).toBe(false)

    now = 1_400
    expect(runtime.getHealth().lastProgressAt).toBe(1_250)
    expect(runtime.getHealth().idleForMs).toBe(150)

    runtime.releaseTurn(lockId)
    expect(runtime.getHealth()).toEqual({
      inProgress: false,
      startedAt: null,
      lastProgressAt: null,
      idleForMs: 0,
      queueDepth: 0,
      interruptRequested: false,
    })
  })

  test('queued input requests interruption without refreshing execution progress', async () => {
    let now = 2_000
    const runtime = new SessionTurnRuntime({ now: () => now })
    const data = createSessionData()
    const messages: Message[] = []
    const lockId = await runtime.acquireTurn('turn-with-queue')

    now = 2_500
    queueMessage(runtime, data, messages)

    expect(runtime.getHealth()).toEqual({
      inProgress: true,
      startedAt: 2_000,
      lastProgressAt: 2_000,
      idleForMs: 500,
      queueDepth: 1,
      interruptRequested: true,
    })
    expect(messages).toHaveLength(1)

    runtime.releaseTurn(lockId)
  })

  test('preserves an interrupt request when a leaked queue survives into the next turn', async () => {
    let now = 3_000
    const runtime = new SessionTurnRuntime({ now: () => now })
    const data = createSessionData()
    const messages: Message[] = []

    const firstLockId = await runtime.acquireTurn('turn-1')
    queueMessage(runtime, data, messages)
    runtime.releaseTurn(firstLockId)

    now = 4_000
    const secondLockId = await runtime.acquireTurn('turn-2')
    expect(runtime.getHealth()).toEqual({
      inProgress: true,
      startedAt: 4_000,
      lastProgressAt: 4_000,
      idleForMs: 0,
      queueDepth: 1,
      interruptRequested: true,
    })
    expect(runtime.shouldInterrupt()).toBe(true)

    expect(runtime.drainQueuedMessages()).toHaveLength(1)
    expect(runtime.shouldInterrupt()).toBe(false)
    runtime.releaseTurn(secondLockId)
  })

  test('requests active-turn abort without manufacturing a queued message', async () => {
    const runtime = new SessionTurnRuntime()

    expect(runtime.requestAbort()).toBe(false)
    const lockId = await runtime.acquireTurn('turn-to-quarantine')
    expect(runtime.shouldAbort()).toBe(false)

    expect(runtime.requestAbort()).toBe(true)
    expect(runtime.shouldAbort()).toBe(true)
    expect(runtime.shouldInterrupt()).toBe(false)
    expect(runtime.getHealth().queueDepth).toBe(0)

    runtime.releaseTurn(lockId)
    const nextLockId = await runtime.acquireTurn('next-turn')
    expect(runtime.shouldAbort()).toBe(false)
    runtime.releaseTurn(nextLockId)
  })
})
