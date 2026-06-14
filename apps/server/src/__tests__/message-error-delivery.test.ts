import { describe, expect, test } from 'bun:test'
import type { SessionManager } from '@zero-os/core'
import { canDeliverToCurrentSession } from '../message/session-delivery'

function createSessionManager() {
  const calls: unknown[][] = []
  return {
    calls,
    sessionManager: {
      isCurrentSessionForChannel: (...args: unknown[]) => {
        calls.push(args)
        return true
      },
    } as unknown as SessionManager,
  }
}

describe('canDeliverToCurrentSession', () => {
  test('does not deliver when there is no active session', () => {
    const { calls, sessionManager } = createSessionManager()

    expect(
      canDeliverToCurrentSession({
        activeSessionId: null,
        channelType: 'telegram',
        channelName: 'telegram',
        chatId: 'chat-1',
        sessionManager,
      }),
    ).toBe(false)
    expect(calls).toEqual([])
  })

  test('uses the web default channel identity', () => {
    const { calls, sessionManager } = createSessionManager()

    expect(
      canDeliverToCurrentSession({
        activeSessionId: 'sess_1',
        channelType: 'web',
        channelName: 'web',
        chatId: 'ignored-chat',
        participantId: 'ignored-user',
        sessionManager,
      }),
    ).toBe(true)

    expect(calls[0]).toEqual(['web', 'default', 'web', 'sess_1', undefined])
  })

  test('uses chat, channel name, and participant for non-web channels', () => {
    const { calls, sessionManager } = createSessionManager()

    expect(
      canDeliverToCurrentSession({
        activeSessionId: 'sess_1',
        channelType: 'telegram',
        channelName: 'telegram-main',
        chatId: 'chat-1',
        participantId: 'user-1',
        sessionManager,
      }),
    ).toBe(true)

    expect(calls[0]).toEqual(['telegram', 'chat-1', 'telegram-main', 'sess_1', 'user-1'])
  })
})
