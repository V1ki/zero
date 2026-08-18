import { describe, expect, test } from 'bun:test'
import type { Session } from '@zero-os/core'
import type { Message } from '@zero-os/shared'
import type { ZeroOS } from '../../../../server/src/main'
import { createSessionRoutes } from '../session-routes'

interface FakeSessionOptions {
  id: string
  idleForMs: number
  inProgress?: boolean
  reply: string
}

function createFakeSession(options: FakeSessionOptions) {
  const handledMessages: string[] = []
  const timestamp = new Date().toISOString()
  const session = {
    data: {
      id: options.id,
      currentModel: 'test/model',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    getTurnHealth: () => ({
      inProgress: options.inProgress ?? true,
      startedAt: 1,
      lastProgressAt: 2,
      idleForMs: options.idleForMs,
      queueDepth: 0,
      interruptRequested: false,
    }),
    isAgentInitialized: () => true,
    getMessages: (): Message[] => [],
    handleMessage: async (message: string): Promise<Message[]> => {
      handledMessages.push(message)
      return [
        {
          id: `msg_${options.id}`,
          sessionId: options.id,
          role: 'assistant',
          messageType: 'message',
          content: [{ type: 'text', text: options.reply }],
          createdAt: new Date().toISOString(),
        },
      ]
    },
  } as unknown as Session

  return { session, handledMessages }
}

function createChatApp(options: {
  selectedSession: Session
  currentSession?: Session
  recoveryResult?: {
    session: Session
    previousSessionId: string
    idleForMs: number
    queueDepth: number
  } | null
  stallTimeoutMs?: number
}) {
  const recoveryCalls: unknown[][] = []
  let currentSessionLookups = 0
  const sessionManager = {
    getOrCreateForChannel: () => ({ session: options.selectedSession, isNew: false }),
    switchCurrentSessionForChannel: () => ({
      session: options.selectedSession,
      isRestored: false,
    }),
    recoverStalledCurrentSessionForChannel: (...args: unknown[]) => {
      recoveryCalls.push(args)
      return options.recoveryResult ?? null
    },
    getCurrentSessionForChannel: () => {
      currentSessionLookups++
      return options.currentSession
    },
  }
  const zero = {
    config: {
      recovery: {
        sessionStallTimeoutMs: options.stallTimeoutMs,
      },
    },
    sessionManager,
    isShuttingDown: () => false,
  } as unknown as ZeroOS

  return {
    app: createSessionRoutes(zero),
    recoveryCalls,
    getCurrentSessionLookups: () => currentSessionLookups,
  }
}

async function postChat(
  app: ReturnType<typeof createSessionRoutes>,
  body: { message: string; sessionId?: string },
) {
  return app.request('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('web chat stalled-session recovery', () => {
  test('rotates the exact stalled web binding using the configured timeout', async () => {
    const oldSession = createFakeSession({
      id: 'sess_web_stalled',
      idleForMs: 60_000,
      reply: 'old reply',
    })
    const recoveredSession = createFakeSession({
      id: 'sess_web_recovered',
      idleForMs: 0,
      inProgress: false,
      reply: 'recovered reply',
    })
    const route = createChatApp({
      selectedSession: oldSession.session,
      stallTimeoutMs: 30_000,
      recoveryResult: {
        session: recoveredSession.session,
        previousSessionId: oldSession.session.data.id,
        idleForMs: 60_000,
        queueDepth: 2,
      },
    })

    const response = await postChat(route.app, { message: 'continue' })

    expect(response.status).toBe(200)
    const responseBody = await response.json()
    expect(responseBody).toMatchObject({
      sessionId: recoveredSession.session.data.id,
      reply: expect.stringMatching(/检测到上一会话长时间无进展.*2 条排队消息.*recovered reply/s),
      recovery: {
        reason: 'stalled_session',
        previousSessionId: oldSession.session.data.id,
        newSessionId: recoveredSession.session.data.id,
        queueDepth: 2,
        queuedMessagesReplayed: false,
        warning: expect.stringMatching(/2 条排队消息.*未自动重放.*请按需重发/),
      },
    })
    expect(route.recoveryCalls).toEqual([
      [
        'web',
        'default',
        {
          channelName: 'web',
          expectedSessionId: oldSession.session.data.id,
          stallTimeoutMs: 30_000,
        },
      ],
    ])
    expect(oldSession.handledMessages).toEqual([])
    expect(recoveredSession.handledMessages).toEqual(['continue'])
    expect(route.getCurrentSessionLookups()).toBe(0)
  })

  test('uses the concurrent winner when exact-binding recovery loses the race', async () => {
    const selectedSession = createFakeSession({
      id: 'sess_web_lost_race',
      idleForMs: 60_000,
      reply: 'stale reply',
    })
    const currentSession = createFakeSession({
      id: 'sess_web_race_winner',
      idleForMs: 0,
      inProgress: false,
      reply: 'winner reply',
    })
    const route = createChatApp({
      selectedSession: selectedSession.session,
      currentSession: currentSession.session,
      recoveryResult: null,
      stallTimeoutMs: 30_000,
    })

    const response = await postChat(route.app, {
      message: 'follow current',
      sessionId: selectedSession.session.data.id,
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      sessionId: currentSession.session.data.id,
      reply: 'winner reply',
    })
    expect(route.getCurrentSessionLookups()).toBe(1)
    expect(selectedSession.handledMessages).toEqual([])
    expect(currentSession.handledMessages).toEqual(['follow current'])
  })

  test('keeps a healthy active web session without attempting recovery', async () => {
    const healthySession = createFakeSession({
      id: 'sess_web_healthy',
      idleForMs: 29_999,
      reply: 'healthy reply',
    })
    const route = createChatApp({
      selectedSession: healthySession.session,
      stallTimeoutMs: 30_000,
    })

    const response = await postChat(route.app, { message: 'hello' })

    expect(response.status).toBe(200)
    const responseBody = await response.json()
    expect(responseBody).toMatchObject({
      sessionId: healthySession.session.data.id,
      reply: 'healthy reply',
    })
    expect(responseBody).not.toHaveProperty('recovery')
    expect(route.recoveryCalls).toEqual([])
    expect(route.getCurrentSessionLookups()).toBe(0)
    expect(healthySession.handledMessages).toEqual(['hello'])
  })

  test('does not rotate a stalled session for the read-only /session command', async () => {
    const stalledSession = createFakeSession({
      id: 'sess_web_read_only',
      idleForMs: 60_000,
      reply: 'unused reply',
    })
    const route = createChatApp({
      selectedSession: stalledSession.session,
      stallTimeoutMs: 30_000,
    })

    const response = await postChat(route.app, { message: '/session' })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      sessionId: stalledSession.session.data.id,
      reply: expect.stringContaining('Session Info'),
      messages: [],
    })
    expect(route.recoveryCalls).toEqual([])
    expect(route.getCurrentSessionLookups()).toBe(0)
    expect(stalledSession.handledMessages).toEqual([])
  })
})
