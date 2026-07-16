import type { IncomingMessage } from '@zero-os/channel'
import { CommandRouter } from '@zero-os/core'
import type { Message, MessageChannelSource } from '@zero-os/shared'
import type { ChannelAdapter } from '../channels/adapter'
import type { MessageHandlerDeps } from '../message/handler'

const DEFAULT_TIMESTAMP = new Date('2026-03-23T00:00:00.000Z').toISOString()

export type SessionHandleMessageOptions = {
  images?: IncomingMessage['images']
  source?: MessageChannelSource
  onTextDelta?: (delta: string, meta: { role: 'assistant'; turnId: string }) => void
  onQueuedMessageApplied?: () => void
}

export interface TestMessageSession {
  data: { id: string }
  isAgentInitialized: () => boolean
  isTurnInProgress?: () => boolean
  setChannelCapabilities: () => void
  initAgent: () => void
  handleMessage: (content: string, options?: SessionHandleMessageOptions) => Promise<unknown>
}

export function createDefaultMessageHandlerDeps(
  session: TestMessageSession,
  channelAdapter: ChannelAdapter,
  overrides: Partial<MessageHandlerDeps> = {},
): MessageHandlerDeps {
  const sessionManager = {
    getOrCreateForChannel: () => ({ session, isNew: false }),
    isCurrentSessionForChannel: (
      _source: unknown,
      _channelId: unknown,
      _channelName: unknown,
      sessionId: string,
    ) => sessionId === session.data.id,
  } as unknown as MessageHandlerDeps['sessionManager']

  return {
    channelType: 'feishu',
    channelName: 'feishu',
    agentName: 'ZeRo OS',
    agentInstruction: 'test instruction',
    sessionManager,
    commandRouter: new CommandRouter(),
    channelAdapter,
    isShuttingDown: () => false,
    ...overrides,
  }
}

export function createIncomingMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  const defaults: IncomingMessage = {
    channelType: 'feishu',
    senderId: 'user_test',
    content: 'hello',
    timestamp: DEFAULT_TIMESTAMP,
    metadata: {
      chatId: 'chat_test',
      messageId: 'msg_test',
    },
  }

  return {
    ...defaults,
    ...overrides,
    metadata: {
      ...defaults.metadata,
      ...(overrides.metadata ?? {}),
    },
  }
}

export function createAssistantTextMessage(
  text: string,
  sessionId = 'sess_test',
  createdAt = DEFAULT_TIMESTAMP,
): Message {
  return {
    id: `msg_${sessionId}`,
    sessionId,
    role: 'assistant',
    messageType: 'message',
    content: [{ type: 'text', text }],
    createdAt,
  }
}
