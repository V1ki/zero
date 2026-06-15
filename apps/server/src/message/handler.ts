import type { IncomingMessage } from '@zero-os/channel'
import type { SessionManager } from '@zero-os/core'
import { type SessionSource, describeError, toErrorMessage } from '@zero-os/shared'
import type { ChannelAdapter, StreamAdapter, TypingHandle } from '../channels/adapter'
import { createCommandContext, createIncomingMessageContext } from './context'
import type { IncomingMessageContext, MessageHandlerDeps } from './context'
import { canDeliverToCurrentSession } from './session-delivery'
import { dismissStreaming } from './streaming'
import { createMessageTurnState, runMessageTurn } from './turn'

export type { MessageHandlerDeps } from './context'

export async function handleChannelMessage(
  msg: IncomingMessage,
  deps: MessageHandlerDeps,
): Promise<void> {
  const incoming = createIncomingMessageContext(msg, deps)
  const { chatId, participantId, messageId } = incoming
  const turnState = createMessageTurnState()

  try {
    if (deps.isShuttingDown()) {
      console.log(`[ZeRo OS] Ignoring ${deps.channelName} message during shutdown`)
      return
    }

    if (isMessageRecalledEvent(msg)) {
      handleMessageRecalled(msg, deps, incoming)
      return
    }

    if (await handleMessageCommand(msg, deps, incoming)) return

    await runMessageTurn(msg, deps, incoming, turnState)
  } catch (err) {
    await recoverMessageHandlerError({
      error: err,
      channelName: deps.channelName,
      channelType: deps.channelType,
      chatId,
      participantId,
      messageId,
      activeSessionId: turnState.activeSessionId,
      sessionManager: deps.sessionManager,
      channelAdapter: deps.channelAdapter,
      typingHandle: turnState.typingHandle,
      streaming: turnState.progressDelivery?.streaming ?? turnState.streaming,
      streamText: turnState.progressDelivery?.streamText ?? '',
    })
  }
}

function isMessageRecalledEvent(msg: IncomingMessage): boolean {
  return msg.eventType === 'message_recalled' || msg.metadata?.eventType === 'message_recalled'
}

function handleMessageRecalled(
  msg: IncomingMessage,
  deps: MessageHandlerDeps,
  incoming: IncomingMessageContext,
): void {
  const source = incoming.source
  if (!source) {
    console.warn(`[ZeRo OS] ${deps.channelName} recall event missing source message id`)
    return
  }

  const recalledAt =
    typeof msg.metadata?.recallTime === 'string' ? msg.metadata.recallTime : msg.timestamp
  const recallType =
    typeof msg.metadata?.recallType === 'string' ? msg.metadata.recallType : undefined
  const result = deps.sessionManager.markExternalMessageRecalled({
    source,
    recalledAt,
    recallType,
  })

  if (!result.matched) {
    console.log(
      `[ZeRo OS] ${deps.channelName} recalled message not found: ${String(source.messageId)}`,
    )
    return
  }

  console.log(
    `[ZeRo OS] ${deps.channelName} marked message recalled: session=${result.sessionId} message=${String(
      source.messageId,
    )} status=${result.status}`,
  )
}

async function handleMessageCommand(
  msg: IncomingMessage,
  deps: MessageHandlerDeps,
  incoming: IncomingMessageContext,
): Promise<boolean> {
  if (deps.onPreCommand) {
    const handled = await deps.onPreCommand(msg.content, incoming.reply)
    if (handled) return true
  }

  const commandResult = await deps.commandRouter.handle(
    msg.content,
    createCommandContext(msg, deps, incoming),
  )
  if (!commandResult?.handled) return false

  if (commandResult.reply) {
    await incoming.reply(commandResult.reply)
  }
  return true
}

async function recoverMessageHandlerError(options: {
  error: unknown
  channelName: string
  channelType: SessionSource
  chatId: string
  participantId?: string
  messageId?: string | number
  activeSessionId: string | null
  sessionManager: SessionManager
  channelAdapter: ChannelAdapter
  typingHandle: TypingHandle | null
  streaming: StreamAdapter | null
  streamText: string
}): Promise<void> {
  console.error(
    `[ZeRo OS] ${options.channelName} message handler error:`,
    describeError(options.error),
  )

  const errorMessage = toErrorMessage(options.error)
  const sessionWasArchived = archivePoisonedSessionIfNeeded({
    errorMessage,
    activeSessionId: options.activeSessionId,
    channelName: options.channelName,
    sessionManager: options.sessionManager,
  })
  const rolledBack = (options.error as { rolledBack?: boolean })?.rolledBack !== false
  const userReply = buildUserErrorReply({
    errorMessage,
    sessionWasArchived,
    rolledBack,
  })

  try {
    const canDeliver = canDeliverToCurrentSession(options)

    if (options.streaming) {
      await settleErrorStreaming({
        streaming: options.streaming,
        streamText: options.streamText,
        rolledBack,
        userReply,
        canDeliverToCurrentSession: canDeliver,
        channelAdapter: options.channelAdapter,
        chatId: options.chatId,
        messageId: options.messageId,
      })
    }

    await options.typingHandle?.clear().catch(() => {})
    if (canDeliver) {
      await options.channelAdapter.markError?.(options.chatId, options.messageId).catch(() => {})
    }

    if (!options.streaming && canDeliver) {
      await options.channelAdapter.reply(options.chatId, userReply, options.messageId)
    }
  } catch {}
}

function buildUserErrorReply(options: {
  errorMessage: string
  sessionWasArchived: boolean
  rolledBack: boolean
}): string {
  if (options.sessionWasArchived) {
    return 'Session corrupted and has been reset. Please resend your message.'
  }

  if (isTransientErrorMessage(options.errorMessage)) {
    return options.rolledBack
      ? '⚠️ AI 服务暂时过载（已重试 3 次仍未恢复），消息已回滚。请稍后重新发送。'
      : '⚠️ AI 服务暂时过载，已完成的工作已保留。请发送新消息继续。'
  }

  return options.rolledBack
    ? 'An error occurred processing your message.'
    : '处理中断，已完成的工作已保留。请发送新消息继续。'
}

function isTransientErrorMessage(errorMessage: string): boolean {
  return (
    errorMessage.includes('overloaded_error') ||
    errorMessage.includes('Overloaded') ||
    /\b(429|503|529)\b/.test(errorMessage)
  )
}

function archivePoisonedSessionIfNeeded(options: {
  errorMessage: string
  activeSessionId: string | null
  channelName: string
  sessionManager: SessionManager
}): boolean {
  if (
    !options.activeSessionId ||
    !options.errorMessage.includes('No tool output found for function call')
  ) {
    return false
  }

  options.sessionManager.remove(options.activeSessionId)
  console.warn(
    `[ZeRo OS] Archived poisoned ${options.channelName} session after tool output mismatch:`,
    options.activeSessionId,
  )
  return true
}

async function settleErrorStreaming(options: {
  streaming: StreamAdapter
  streamText: string
  rolledBack: boolean
  userReply: string
  canDeliverToCurrentSession: boolean
  channelAdapter: ChannelAdapter
  chatId: string
  messageId?: string | number
}): Promise<void> {
  if (!options.canDeliverToCurrentSession) {
    await dismissStreaming(options.streaming).catch(() => {})
    return
  }

  if (!options.rolledBack && options.streamText) {
    await options.streaming.complete(options.streamText).catch(() => {})
    await options.channelAdapter.reply(options.chatId, options.userReply, options.messageId)
    return
  }

  await options.streaming.abort(options.userReply).catch(() => {})
}
