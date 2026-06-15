import { afterAll, describe, expect, test } from 'bun:test'
import type { Message } from '@zero-os/shared'
import { ToolRegistry } from '../../tool/registry'
import { Session } from '../session'
import { SessionConversationState } from '../session-conversation-state'
import { createTestModelRouter, createTestProjectRoot } from './test-helpers'

const testProject = createTestProjectRoot('zero-message-recall-')

afterAll(() => {
  testProject.cleanup()
})

function userMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg_user_1',
    sessionId: 'sess_1',
    role: 'user',
    messageType: 'message',
    source: {
      channelType: 'feishu',
      channelName: 'feishu',
      channelId: 'oc_group',
      participantId: 'ou_alice',
      messageId: 'om_1',
    },
    content: [{ type: 'text', text: 'original text' }],
    createdAt: '2026-03-23T00:00:00.000Z',
    ...overrides,
  }
}

function pushSessionMessages(session: Session, ...messages: Message[]): void {
  ;(
    session as unknown as {
      conversation: { messages: Message[] }
    }
  ).conversation.messages.push(...messages)
}

function getTurnLeakState(session: Session): { queueLength: number; interruptFlag: boolean } {
  return (
    session as unknown as {
      turnRuntime: { getLeakState(): { queueLength: number; interruptFlag: boolean } }
    }
  ).turnRuntime.getLeakState()
}

describe('SessionConversationState message recall', () => {
  test('marks a matching external user message as recalled notification', () => {
    const state = new SessionConversationState({
      messages: [userMessage()],
    })

    const result = state.markExternalMessageRecalled({
      source: {
        channelType: 'feishu',
        channelName: 'feishu',
        channelId: 'oc_group',
        messageId: 'om_1',
      },
      recalledAt: '2026-03-23T00:00:05.000Z',
      recallType: 'message_owner',
    })

    expect(result).toEqual({
      matched: true,
      changed: true,
      status: 'recalled',
      messageId: 'msg_user_1',
      previousMessageType: 'message',
    })
    expect(state.messages[0]).toMatchObject({
      messageType: 'notification',
      recalled: {
        externalMessageId: 'om_1',
        recalledAt: '2026-03-23T00:00:05.000Z',
        recallType: 'message_owner',
      },
      content: [{ type: 'text', text: '用户已撤回这条消息。' }],
    })
  })

  test('does not match messages from another chat', () => {
    const state = new SessionConversationState({
      messages: [userMessage()],
    })

    const result = state.markExternalMessageRecalled({
      source: {
        channelType: 'feishu',
        channelName: 'feishu',
        channelId: 'oc_other',
        messageId: 'om_1',
      },
      recalledAt: '2026-03-23T00:00:05.000Z',
    })

    expect(result.status).toBe('not_found')
    expect(state.messages[0]?.messageType).toBe('message')
  })
})

describe('Session message recall', () => {
  test('does not interrupt the current turn when the active user message is recalled', () => {
    const session = new Session('feishu', createTestModelRouter(), new ToolRegistry(), {
      projectRoot: testProject.projectRoot,
    })
    pushSessionMessages(session, userMessage({ sessionId: session.data.id }))
    ;(session as unknown as { isTurnInProgress: () => boolean }).isTurnInProgress = () => true

    const result = session.markExternalMessageRecalled({
      source: {
        channelType: 'feishu',
        channelName: 'feishu',
        channelId: 'oc_group',
        messageId: 'om_1',
      },
      recalledAt: '2026-03-23T00:00:05.000Z',
      recallType: 'message_owner',
    })

    expect(result.status).toBe('recalled')
    expect(getTurnLeakState(session)).toEqual({
      queueLength: 0,
      interruptFlag: false,
    })
  })
})
