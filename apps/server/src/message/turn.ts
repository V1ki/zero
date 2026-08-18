import type { IncomingMessage } from '@zero-os/channel'
import type { HandleMessageOptions, Session } from '@zero-os/core'
import { type ChannelCapabilities, type Message, describeError } from '@zero-os/shared'
import type { ChannelAdapter, StreamAdapter, TypingHandle } from '../channels/adapter'
import type { IncomingMessageContext, MessageHandlerDeps } from './context'
import { MessageProgressDelivery } from './progress'
import { deliverAssistantReplies } from './replies'
import { createCurrentSessionDeliveryGuard } from './session-delivery'
import { createStreamingBestEffort } from './streaming'

const TYPING_INDICATOR_TIMEOUT_MS = 3000
const STALLED_SESSION_NOTICE_TIMEOUT_MS = 3000
export const DEFAULT_SESSION_STALL_TIMEOUT_MS = 30 * 60_000

export interface MessageTurnState {
  activeSessionId: string | null
  typingHandle: TypingHandle | null
  streaming: StreamAdapter | null
  progressDelivery: MessageProgressDelivery | null
}

export function createMessageTurnState(): MessageTurnState {
  return {
    activeSessionId: null,
    typingHandle: null,
    streaming: null,
    progressDelivery: null,
  }
}

function appendIncomingFileInfo(content: string, files: IncomingMessage['files']): string {
  if (!files?.length) return content

  const fileInfo = files
    .map(
      (file) =>
        `📎 文件「${file.fileName}」已下载到: ${file.localPath} (${(file.size / 1024).toFixed(
          1,
        )} KB)`,
    )
    .join('\n')

  return content ? `${content}\n\n${fileInfo}` : fileInfo
}

function ensureChannelSessionReady(
  session: Session,
  isNew: boolean,
  options: {
    channelCapabilities?: ChannelCapabilities
    agentName: string
    agentInstruction: string
  },
): void {
  if (isNew || !session.isAgentInitialized()) {
    if (options.channelCapabilities) {
      session.setChannelCapabilities(options.channelCapabilities)
    }
    session.initAgent({
      name: options.agentName,
      agentInstruction: options.agentInstruction,
    })
  }
}

function isSessionTurnInProgress(session: Session): boolean {
  const maybeSession = session as Session & { isTurnInProgress?: () => boolean }
  return typeof maybeSession.isTurnInProgress === 'function'
    ? maybeSession.isTurnInProgress()
    : false
}

export async function runMessageTurn(
  msg: IncomingMessage,
  deps: MessageHandlerDeps,
  incoming: IncomingMessageContext,
  state: MessageTurnState,
): Promise<void> {
  const { chatId, participantId } = incoming
  let { session, isNew } = deps.sessionManager.getOrCreateForChannel(
    deps.channelType,
    chatId,
    deps.channelName,
    participantId,
  )
  const stalledRecovery = recoverStalledSessionForIncomingMessage({
    session,
    deps,
    chatId,
    participantId,
  })
  if (stalledRecovery) {
    console.warn(
      `[ZeRo OS] Quarantined stalled ${deps.channelName} session: ` +
        `old=${stalledRecovery.previousSessionId} new=${stalledRecovery.session.data.id} ` +
        `idle_ms=${stalledRecovery.idleForMs} queue_depth=${stalledRecovery.queueDepth}`,
    )
    session = stalledRecovery.session
    isNew = true
    // Do not let a broken channel delay initialization/acquisition of the fresh
    // session. The notice is best-effort and bounded independently.
    void notifyStalledSessionRecovery(incoming, stalledRecovery.queueDepth)
  }
  state.activeSessionId = session.data.id

  const canDeliverToCurrentSession = createCurrentSessionDeliveryGuard({
    sessionManager: deps.sessionManager,
    channelType: deps.channelType,
    channelName: deps.channelName,
    chatId,
    participantId,
    getActiveSessionId: () => state.activeSessionId,
  })

  ensureChannelSessionReady(session, isNew, {
    channelCapabilities: deps.channelCapabilities,
    agentName: deps.agentName,
    agentInstruction: deps.agentInstruction,
  })

  const messageContent = appendIncomingFileInfo(msg.content, msg.files)

  if (isSessionTurnInProgress(session)) {
    await runQueuedMessageTurn({
      session,
      msg,
      deps,
      incoming,
      messageContent,
      canDeliverToCurrentSession,
    })
    return
  }

  await runActiveMessageTurn({
    session,
    msg,
    deps,
    incoming,
    state,
    messageContent,
    canDeliverToCurrentSession,
  })
}

function recoverStalledSessionForIncomingMessage(options: {
  session: Session
  deps: MessageHandlerDeps
  chatId: string
  participantId?: string
}) {
  const sessionWithHealth = options.session as Session & {
    getTurnHealth?: Session['getTurnHealth']
  }
  if (typeof sessionWithHealth.getTurnHealth !== 'function') return null

  const health = sessionWithHealth.getTurnHealth()
  const stallTimeoutMs = options.deps.sessionStallTimeoutMs ?? DEFAULT_SESSION_STALL_TIMEOUT_MS
  if (!health.inProgress || health.idleForMs < stallTimeoutMs) return null

  const manager = options.deps.sessionManager as typeof options.deps.sessionManager & {
    recoverStalledCurrentSessionForChannel?: SessionManagerStallRecovery
  }
  if (typeof manager.recoverStalledCurrentSessionForChannel !== 'function') return null

  return manager.recoverStalledCurrentSessionForChannel(options.deps.channelType, options.chatId, {
    channelName: options.deps.channelName,
    participantId: options.participantId,
    expectedSessionId: options.session.data.id,
    stallTimeoutMs,
  })
}

type SessionManagerStallRecovery =
  MessageHandlerDeps['sessionManager']['recoverStalledCurrentSessionForChannel']

async function notifyStalledSessionRecovery(
  incoming: IncomingMessageContext,
  quarantinedQueueDepth: number,
): Promise<void> {
  const queuedNotice =
    quarantinedQueueDepth > 0
      ? ` 旧会话中还有 ${quarantinedQueueDepth} 条排队消息，为避免重复执行未自动重放，请按需重发。`
      : ''
  try {
    await withBestEffortTimeout(
      incoming.reply(
        `⚠️ 检测到上一会话长时间无进展，已隔离并创建新会话；本条消息会继续处理。${queuedNotice}`,
      ),
      STALLED_SESSION_NOTICE_TIMEOUT_MS,
    )
  } catch (error) {
    console.warn('[ZeRo OS] Failed to send stalled-session recovery notice:', describeError(error))
  }
}

function withBestEffortTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`operation timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref?.()
  })

  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

interface RunActiveMessageTurnOptions {
  session: Session
  msg: IncomingMessage
  deps: MessageHandlerDeps
  incoming: IncomingMessageContext
  state: MessageTurnState
  messageContent: string
  canDeliverToCurrentSession(): boolean
}

type DeliveryHandleMessageOptions = Pick<HandleMessageOptions, 'onProgress' | 'onTextDelta'>

export async function runMessageWithDelivery(options: {
  channelAdapter: ChannelAdapter
  channelName: string
  chatId: string
  messageId?: string | number
  state: MessageTurnState
  canDeliverToCurrentSession(): boolean
  runMessage(deliveryOptions: DeliveryHandleMessageOptions): Promise<Message[]>
}): Promise<void> {
  options.state.typingHandle = await showTypingBestEffort({
    channelAdapter: options.channelAdapter,
    channelName: options.channelName,
    chatId: options.chatId,
    messageId: options.messageId,
  })

  options.state.streaming = await createStreamingBestEffort({
    channelAdapter: options.channelAdapter,
    channelName: options.channelName,
    chatId: options.chatId,
    messageId: options.messageId,
  })

  options.state.progressDelivery = new MessageProgressDelivery({
    streaming: options.state.streaming,
    channelAdapter: options.channelAdapter,
    channelName: options.channelName,
    chatId: options.chatId,
    messageId: options.messageId,
    canDeliverToCurrentSession: options.canDeliverToCurrentSession,
  })

  const replies = await options.runMessage({
    onTextDelta: options.state.progressDelivery.onTextDelta,
    onProgress: options.state.progressDelivery.onProgress,
  })

  await options.state.progressDelivery.flush()

  options.state.streaming = await deliverAssistantReplies({
    replies,
    streaming: options.state.progressDelivery.streaming,
    streamText: options.state.progressDelivery.streamText,
    lastSentMsgId: options.state.progressDelivery.lastSentMsgId,
    channelAdapter: options.channelAdapter,
    channelName: options.channelName,
    chatId: options.chatId,
    messageId: options.messageId,
    canDeliverToCurrentSession: options.canDeliverToCurrentSession,
  })

  await options.state.typingHandle?.clear().catch(() => {})
  if (options.canDeliverToCurrentSession()) {
    await options.channelAdapter.markDone?.(options.chatId, options.messageId).catch(() => {})
  }
}

async function runActiveMessageTurn({
  session,
  msg,
  deps,
  incoming,
  state,
  messageContent,
  canDeliverToCurrentSession,
}: RunActiveMessageTurnOptions): Promise<void> {
  const { chatId, messageId } = incoming

  await runMessageWithDelivery({
    channelAdapter: deps.channelAdapter,
    channelName: deps.channelName,
    chatId,
    messageId,
    state,
    canDeliverToCurrentSession,
    runMessage: (deliveryOptions) =>
      session.handleMessage(messageContent, {
        images: msg.images,
        source: incoming.source,
        ...deliveryOptions,
      } satisfies HandleMessageOptions),
  })
}

async function showTypingBestEffort(options: {
  channelAdapter: ChannelAdapter
  channelName: string
  chatId: string
  messageId: string | number | undefined
}): Promise<TypingHandle | null> {
  let settled = false
  let timeout: ReturnType<typeof setTimeout> | undefined

  const typing = options.channelAdapter
    .showTyping(options.chatId, options.messageId)
    .catch((err) => {
      if (!settled) {
        console.warn(
          `[ZeRo OS] ${options.channelName} typing indicator failed; continuing message handling:`,
          describeError(err),
        )
      }
      return null
    })

  const timeoutGuard = new Promise<TypingHandle | null>((resolve) => {
    timeout = setTimeout(() => {
      if (!settled) {
        console.warn(
          `[ZeRo OS] ${options.channelName} typing indicator timed out after ${TYPING_INDICATOR_TIMEOUT_MS}ms; continuing message handling`,
        )
      }
      resolve(null)
    }, TYPING_INDICATOR_TIMEOUT_MS)
  })

  const handle = await Promise.race([typing, timeoutGuard])
  settled = true
  if (timeout) clearTimeout(timeout)
  return handle
}

interface RunQueuedMessageTurnOptions {
  session: Session
  msg: IncomingMessage
  deps: MessageHandlerDeps
  incoming: IncomingMessageContext
  messageContent: string
  canDeliverToCurrentSession(): boolean
}

async function runQueuedMessageTurn({
  session,
  msg,
  deps,
  incoming,
  messageContent,
  canDeliverToCurrentSession,
}: RunQueuedMessageTurnOptions): Promise<void> {
  await session.handleMessage(messageContent, {
    images: msg.images,
    source: incoming.source,
    onQueuedMessageApplied: createQueuedMessageAppliedHandler({
      deps,
      chatId: incoming.chatId,
      messageId: incoming.messageId,
      canDeliverToCurrentSession,
    }),
  } satisfies HandleMessageOptions)
}

function createQueuedMessageAppliedHandler(options: {
  deps: MessageHandlerDeps
  chatId: string
  messageId?: string | number
  canDeliverToCurrentSession(): boolean
}): (() => void) | undefined {
  if (options.messageId === undefined) return undefined

  return () => {
    if (!options.canDeliverToCurrentSession()) return
    const done = options.deps.channelAdapter.markDone?.(options.chatId, options.messageId)
    done?.catch((err) =>
      console.error(
        `[ZeRo OS] ${options.deps.channelName} queued mark done error:`,
        describeError(err),
      ),
    )
  }
}
