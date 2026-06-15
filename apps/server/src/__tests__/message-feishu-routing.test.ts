import { describe, expect, test } from 'bun:test'
import { CommandRouter } from '@zero-os/core'
import type { ChannelAdapter } from '../channels/adapter'
import { type MessageHandlerDeps, handleChannelMessage } from '../message/handler'
import { createAssistantTextMessage, createIncomingMessage } from './message-handler-harness'

describe('handleChannelMessage Feishu routing', () => {
  test('scopes Feishu sessions by sender while replying to the real chat id', async () => {
    const managerCalls: Array<{
      source: string
      channelId: string
      channelName?: string
      participantId?: string
    }> = []
    const currentChecks: Array<{
      channelId: string
      channelName?: string
      sessionId: string
      participantId?: string
    }> = []
    const replies: Array<{ chatId: string; text: string; replyTo?: string | number }> = []
    const session = {
      data: { id: 'sess_alice' },
      isAgentInitialized: () => true,
      setChannelCapabilities: () => {},
      initAgent: () => {},
      handleMessage: async () => [createAssistantTextMessage('hello alice', 'sess_alice')],
    }

    const sessionManager = {
      getOrCreateForChannel: (
        source: string,
        channelId: string,
        channelName?: string,
        participantId?: string,
      ) => {
        managerCalls.push({ source, channelId, channelName, participantId })
        return { session, isNew: false }
      },
      isCurrentSessionForChannel: (
        _source: string,
        channelId: string,
        channelName: string | undefined,
        sessionId: string,
        participantId?: string,
      ) => {
        currentChecks.push({ channelId, channelName, sessionId, participantId })
        return sessionId === session.data.id && participantId === 'ou_alice'
      },
    }

    const channelAdapter: ChannelAdapter = {
      reply: async (chatId, text, replyTo) => {
        replies.push({ chatId, text, replyTo })
      },
      showTyping: async () => ({
        clear: async () => {},
      }),
    }

    await handleChannelMessage(
      createIncomingMessage({
        senderId: 'ou_alice',
        content: 'hello',
        metadata: {
          chatId: 'oc_group',
          messageId: 'msg_1',
          chatType: 'group',
        },
      }),
      {
        channelType: 'feishu',
        channelName: 'feishu',
        agentName: 'ZeRo OS',
        agentInstruction: 'test instruction',
        sessionManager: sessionManager as unknown as MessageHandlerDeps['sessionManager'],
        commandRouter: new CommandRouter() as MessageHandlerDeps['commandRouter'],
        channelAdapter,
        isShuttingDown: () => false,
      },
    )

    expect(managerCalls).toEqual([
      {
        source: 'feishu',
        channelId: 'oc_group',
        channelName: 'feishu',
        participantId: 'ou_alice',
      },
    ])
    expect(currentChecks.every((check) => check.participantId === 'ou_alice')).toBe(true)
    expect(replies).toContainEqual({
      chatId: 'oc_group',
      text: 'hello alice',
      replyTo: 'msg_1',
    })
  })

  test('routes Feishu recall events to session recall handling without starting a turn', async () => {
    const recallCalls: unknown[] = []
    const replies: unknown[] = []
    const channelAdapter: ChannelAdapter = {
      reply: async (...args) => {
        replies.push(args)
      },
      showTyping: async () => {
        throw new Error('should not show typing for recall events')
      },
    }
    const sessionManager = {
      getOrCreateForChannel: () => {
        throw new Error('should not create a session for recall events')
      },
      markExternalMessageRecalled: (options: unknown) => {
        recallCalls.push(options)
        return {
          matched: true,
          changed: true,
          status: 'recalled',
          sessionId: 'sess_alice',
        }
      },
    }

    await handleChannelMessage(
      createIncomingMessage({
        eventType: 'message_recalled',
        senderId: 'unknown',
        content: '',
        timestamp: '2026-03-23T00:00:01.000Z',
        metadata: {
          eventType: 'message_recalled',
          chatId: 'oc_group',
          messageId: 'msg_1',
          recallTime: '2026-03-23T00:00:01.000Z',
          recallType: 'message_owner',
        },
      }),
      {
        channelType: 'feishu',
        channelName: 'feishu',
        agentName: 'ZeRo OS',
        agentInstruction: 'test instruction',
        sessionManager: sessionManager as unknown as MessageHandlerDeps['sessionManager'],
        commandRouter: new CommandRouter() as MessageHandlerDeps['commandRouter'],
        channelAdapter,
        isShuttingDown: () => false,
      },
    )

    expect(recallCalls).toEqual([
      {
        source: {
          channelType: 'feishu',
          channelName: 'feishu',
          channelId: 'oc_group',
          messageId: 'msg_1',
        },
        recalledAt: '2026-03-23T00:00:01.000Z',
        recallType: 'message_owner',
      },
    ])
    expect(replies).toEqual([])
  })
})
