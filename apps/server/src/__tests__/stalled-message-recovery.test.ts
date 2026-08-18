import { describe, expect, test } from 'bun:test'
import type { ChannelAdapter } from '../channels/adapter'
import { handleChannelMessage } from '../message/handler'
import {
  type TestMessageSession,
  createDefaultMessageHandlerDeps,
  createIncomingMessage,
} from './message-handler-harness'

function createSession(id: string, options: Partial<TestMessageSession> = {}): TestMessageSession {
  return {
    data: { id },
    isAgentInitialized: () => true,
    isTurnInProgress: () => false,
    setChannelCapabilities: () => {},
    initAgent: () => {},
    handleMessage: async () => [],
    ...options,
  }
}

describe('stalled session message recovery', () => {
  test('quarantines the exact stalled binding and handles the inbound message in a new session', async () => {
    const handled: string[] = []
    const oldSession = createSession('sess_stalled', {
      isTurnInProgress: () => true,
      handleMessage: async () => {
        handled.push('old')
        return []
      },
    }) as TestMessageSession & {
      getTurnHealth(): {
        inProgress: boolean
        startedAt: number
        lastProgressAt: number
        idleForMs: number
        queueDepth: number
        interruptRequested: boolean
      }
    }
    oldSession.getTurnHealth = () => ({
      inProgress: true,
      startedAt: 1_000,
      lastProgressAt: 2_000,
      idleForMs: 31_000,
      queueDepth: 2,
      interruptRequested: true,
    })

    const newSession = createSession('sess_recovered', {
      handleMessage: async (content) => {
        handled.push(`new:${content}`)
        return []
      },
    })
    const recoverCalls: unknown[][] = []
    const sessionManager = {
      getOrCreateForChannel: () => ({ session: oldSession, isNew: false }),
      recoverStalledCurrentSessionForChannel: (...args: unknown[]) => {
        recoverCalls.push(args)
        return {
          session: newSession,
          previousSessionId: oldSession.data.id,
          idleForMs: 31_000,
          queueDepth: 2,
        }
      },
      isCurrentSessionForChannel: (
        _source: unknown,
        _channelId: unknown,
        _channelName: unknown,
        sessionId: string,
      ) => sessionId === newSession.data.id,
    }
    const channelAdapter: ChannelAdapter = {
      reply: async () => {},
      showTyping: async () => null,
      createStreaming: async () => null,
      markDone: async () => {},
    }

    await handleChannelMessage(
      createIncomingMessage({ content: 'continue safely' }),
      createDefaultMessageHandlerDeps(oldSession, channelAdapter, {
        sessionManager: sessionManager as never,
        sessionStallTimeoutMs: 30_000,
      }),
    )

    expect(recoverCalls).toEqual([
      [
        'feishu',
        'chat_test',
        {
          channelName: 'feishu',
          participantId: 'user_test',
          expectedSessionId: 'sess_stalled',
          stallTimeoutMs: 30_000,
        },
      ],
    ])
    expect(handled).toEqual(['new:continue safely'])
  })

  test('does not let a hung recovery notice block the rescued inbound message', async () => {
    const handled: string[] = []
    const oldSession = createSession('sess_stalled', {
      isTurnInProgress: () => true,
    }) as TestMessageSession & {
      getTurnHealth(): {
        inProgress: boolean
        startedAt: number
        lastProgressAt: number
        idleForMs: number
        queueDepth: number
        interruptRequested: boolean
      }
    }
    oldSession.getTurnHealth = () => ({
      inProgress: true,
      startedAt: 1_000,
      lastProgressAt: 2_000,
      idleForMs: 31_000,
      queueDepth: 0,
      interruptRequested: false,
    })

    const newSession = createSession('sess_recovered', {
      handleMessage: async (content) => {
        handled.push(content)
        return []
      },
    })
    const sessionManager = {
      getOrCreateForChannel: () => ({ session: oldSession, isNew: false }),
      recoverStalledCurrentSessionForChannel: () => ({
        session: newSession,
        previousSessionId: oldSession.data.id,
        idleForMs: 31_000,
        queueDepth: 0,
      }),
      isCurrentSessionForChannel: (
        _source: unknown,
        _channelId: unknown,
        _channelName: unknown,
        sessionId: string,
      ) => sessionId === newSession.data.id,
    }
    const channelAdapter: ChannelAdapter = {
      reply: () => new Promise<void>(() => {}),
      showTyping: async () => null,
      createStreaming: async () => null,
      markDone: async () => {},
    }

    await handleChannelMessage(
      createIncomingMessage({ content: 'still process me' }),
      createDefaultMessageHandlerDeps(oldSession, channelAdapter, {
        sessionManager: sessionManager as never,
        sessionStallTimeoutMs: 30_000,
      }),
    )

    expect(handled).toEqual(['still process me'])
  })
})
