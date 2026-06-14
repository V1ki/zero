import type { SessionManager } from '@zero-os/core'
import type { SessionSource } from '@zero-os/shared'

export interface MessageSessionDeliveryOptions {
  activeSessionId: string | null
  channelType: SessionSource
  channelName: string
  chatId: string
  participantId?: string
  sessionManager: Pick<SessionManager, 'isCurrentSessionForChannel'>
}

interface MessageDeliveryTarget {
  channelId: string
  channelName: string
  participantId?: string
}

function resolveMessageDeliveryTarget(options: {
  channelType: SessionSource
  channelName: string
  chatId: string
  participantId?: string
}): MessageDeliveryTarget {
  if (options.channelType === 'web') {
    return {
      channelId: 'default',
      channelName: 'web',
    }
  }

  return {
    channelId: options.chatId,
    channelName: options.channelName,
    participantId: options.participantId,
  }
}

export function canDeliverToCurrentSession(options: MessageSessionDeliveryOptions): boolean {
  if (options.activeSessionId === null) return false

  const target = resolveMessageDeliveryTarget(options)
  return options.sessionManager.isCurrentSessionForChannel(
    options.channelType,
    target.channelId,
    target.channelName,
    options.activeSessionId,
    target.participantId,
  )
}

export function createCurrentSessionDeliveryGuard(options: {
  sessionManager: Pick<SessionManager, 'isCurrentSessionForChannel'>
  channelType: SessionSource
  channelName: string
  chatId: string
  participantId?: string
  getActiveSessionId(): string | null
}): () => boolean {
  return () =>
    canDeliverToCurrentSession({
      activeSessionId: options.getActiveSessionId(),
      channelType: options.channelType,
      channelName: options.channelName,
      chatId: options.chatId,
      participantId: options.participantId,
      sessionManager: options.sessionManager,
    })
}
