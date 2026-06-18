import type { IncomingMessage } from '@zero-os/channel'
import type { CommandContext, CommandRouter, SessionManager } from '@zero-os/core'
import type { MetricsDB } from '@zero-os/observe'
import type { ChannelCapabilities, MessageChannelSource, SessionSource } from '@zero-os/shared'
import type { ChannelAdapter } from '../channels/adapter'

export interface MessageHandlerDeps {
  channelType: SessionSource
  channelName: string
  agentName: string
  agentInstruction: string
  sessionManager: SessionManager
  commandRouter: CommandRouter
  channelAdapter: ChannelAdapter
  metrics?: MetricsDB
  channelCapabilities?: ChannelCapabilities
  isShuttingDown: () => boolean
  /** Server-level pre-command hook (for /restart etc). Return true if handled. */
  onPreCommand?: (content: string, reply: (text: string) => Promise<void>) => Promise<boolean>
}

export interface IncomingMessageContext {
  chatId: string
  participantId?: string
  messageId?: string | number
  source?: MessageChannelSource
  reply(text: string): Promise<void>
}

export function createIncomingMessageContext(
  msg: IncomingMessage,
  deps: MessageHandlerDeps,
): IncomingMessageContext {
  const chatId = normalizeChatId(msg)
  const participantId = normalizeParticipantId(msg, deps.channelType)
  const messageId = normalizeMessageId(msg)

  return {
    chatId,
    participantId,
    messageId,
    source: createIncomingMessageSource(deps, chatId, participantId, messageId),
    reply: (text) => deps.channelAdapter.reply(chatId, text, messageId),
  }
}

export function createCommandContext(
  msg: IncomingMessage,
  deps: MessageHandlerDeps,
  incoming: IncomingMessageContext,
): CommandContext {
  return {
    source: deps.channelType,
    channelName: deps.channelName,
    chatId: incoming.chatId,
    participantId: incoming.participantId,
    deliveryChatId: incoming.chatId,
    senderId: msg.senderId,
    messageId: incoming.messageId,
    metadata: msg.metadata,
    sessionManager: deps.sessionManager,
    metrics: deps.metrics,
    channelCapabilities: deps.channelCapabilities,
    agentConfig: {
      name: deps.agentName,
      agentInstruction: deps.agentInstruction,
    },
    reply: incoming.reply,
  }
}

function normalizeChatId(msg: IncomingMessage): string {
  if (msg.channelType === 'web') {
    return 'default'
  }
  const chatId = msg.metadata?.chatId
  if (typeof chatId === 'string' && chatId.trim()) {
    return chatId
  }
  if (typeof chatId === 'number') {
    return String(chatId)
  }
  return msg.senderId
}

function normalizeParticipantId(msg: IncomingMessage, source: SessionSource): string | undefined {
  if (source !== 'feishu' && source !== 'dingtalk') return undefined
  const senderId = msg.senderId.trim()
  if (senderId && senderId !== 'unknown') return senderId

  console.warn(
    `[ZeRo OS] ${source} message missing senderId; falling back to chat-level session scope`,
  )
  return undefined
}

function normalizeMessageId(msg: IncomingMessage): string | number | undefined {
  const messageId = msg.metadata?.messageId
  if (typeof messageId === 'string' || typeof messageId === 'number') {
    return messageId
  }
  return undefined
}

function createIncomingMessageSource(
  deps: MessageHandlerDeps,
  channelId: string,
  participantId: string | undefined,
  messageId: string | number | undefined,
): MessageChannelSource | undefined {
  if (messageId === undefined) return undefined

  const source: MessageChannelSource = {
    channelType: deps.channelType,
    channelName: deps.channelName,
    channelId,
    messageId,
  }
  if (participantId) {
    source.participantId = participantId
  }
  return source
}
