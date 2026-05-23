import type { IncomingMessage } from '@zero-os/channel'
import type {
  CommandContext,
  CommandRouter,
  HandleMessageOptions,
  Session,
  SessionManager,
} from '@zero-os/core'
import type { MetricsDB } from '@zero-os/observe'
import {
  type ChannelCapabilities,
  type ImageBlock,
  type Message,
  type SessionSource,
  collectAssistantReply,
  describeError,
  extractAssistantText,
  toErrorMessage,
} from '@zero-os/shared'
import type { ChannelAdapter, StreamAdapter, TypingHandle } from './channel-adapter'

const TYPING_INDICATOR_TIMEOUT_MS = 3000

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

export async function handleChannelMessage(
  msg: IncomingMessage,
  deps: MessageHandlerDeps,
): Promise<void> {
  const chatId = normalizeChatId(msg)
  const participantId = normalizeParticipantId(msg, deps.channelType)
  const messageId = normalizeMessageId(msg)

  const reply = (text: string) => deps.channelAdapter.reply(chatId, text, messageId)

  let activeSessionId: string | null = null
  let typingHandle: TypingHandle | null = null
  let streaming: StreamAdapter | null = null
  let streamText = ''

  try {
    if (deps.isShuttingDown()) {
      console.log(`[ZeRo OS] Ignoring ${deps.channelName} message during shutdown`)
      return
    }

    if (deps.onPreCommand) {
      const handled = await deps.onPreCommand(msg.content, reply)
      if (handled) return
    }

    const commandCtx: CommandContext = {
      source: deps.channelType,
      channelName: deps.channelName,
      chatId,
      participantId,
      deliveryChatId: chatId,
      senderId: msg.senderId,
      messageId,
      metadata: msg.metadata,
      sessionManager: deps.sessionManager,
      metrics: deps.metrics,
      channelCapabilities: deps.channelCapabilities,
      agentConfig: {
        name: deps.agentName,
        agentInstruction: deps.agentInstruction,
      },
      reply,
    }

    const commandResult = await deps.commandRouter.handle(msg.content, commandCtx)
    if (commandResult?.handled) {
      if (commandResult.reply) {
        await reply(commandResult.reply)
      }
      return
    }

    const { session, isNew } = deps.sessionManager.getOrCreateForChannel(
      deps.channelType,
      chatId,
      deps.channelName,
      participantId,
    )
    activeSessionId = session.data.id
    const canDeliverToCurrentSession = () =>
      activeSessionId
        ? deps.sessionManager.isCurrentSessionForChannel(
            deps.channelType,
            deps.channelType === 'web' ? 'default' : chatId,
            deps.channelType === 'web' ? 'web' : deps.channelName,
            activeSessionId,
            deps.channelType === 'web' ? undefined : participantId,
          )
        : false
    ensureSessionReady(session, isNew, deps)

    const shouldQueueWithoutChannelFeedback = isSessionTurnInProgress(session)

    let firstReply = true
    let lastSentMsgId: string | null = null
    let lastProgressText: string | null = null
    streamText = ''
    let seenDelta = false
    let lastTurnId: string | null = null
    let turnRotateChain: Promise<void> = Promise.resolve()

    let messageContent = msg.content
    if (msg.files?.length) {
      const fileInfo = msg.files
        .map(
          (file) =>
            `📎 文件「${file.fileName}」已下载到: ${file.localPath} (${(file.size / 1024).toFixed(
              1,
            )} KB)`,
        )
        .join('\n')
      messageContent = messageContent ? `${messageContent}\n\n${fileInfo}` : fileInfo
    }

    if (shouldQueueWithoutChannelFeedback) {
      const queuedMessageId = messageId
      await session.handleMessage(messageContent, {
        images: msg.images,
        onQueuedMessageApplied:
          queuedMessageId !== undefined
            ? () => {
                if (!canDeliverToCurrentSession()) return
                const done = deps.channelAdapter.markDone?.(chatId, queuedMessageId)
                done?.catch((err) =>
                  console.error(
                    `[ZeRo OS] ${deps.channelName} queued mark done error:`,
                    describeError(err),
                  ),
                )
              }
            : undefined,
      } satisfies HandleMessageOptions)
      return
    }

    typingHandle = await showTypingBestEffort(deps, chatId, messageId)

    if (deps.channelAdapter.createStreaming) {
      try {
        streaming = await deps.channelAdapter.createStreaming(chatId, messageId)
      } catch (err) {
        console.warn(
          `[ZeRo OS] ${deps.channelName} streaming init failed, falling back to static:`,
          describeError(err),
        )
      }
    }

    const replies = await session.handleMessage(messageContent, {
      images: msg.images,
      onTextDelta: streaming
        ? (delta, meta) => {
            if (!delta) return
            if (!canDeliverToCurrentSession()) return
            seenDelta = true

            if (lastTurnId && lastTurnId !== meta.turnId && streamText) {
              const prevText = streamText
              const previousStreaming = streaming
              streamText = ''
              turnRotateChain = turnRotateChain.then(async () => {
                if (!previousStreaming) return
                try {
                  await previousStreaming.complete(prevText)
                  if (deps.channelAdapter.createStreaming) {
                    streaming = await deps.channelAdapter.createStreaming(chatId, messageId)
                  } else {
                    streaming = null
                  }
                } catch (err) {
                  console.error(
                    `[ZeRo OS] ${deps.channelName} streaming turn rotate error:`,
                    describeError(err),
                  )
                  streaming = null
                }
              })
            }

            lastTurnId = meta.turnId
            streamText += delta
            const textSnapshot = streamText
            turnRotateChain = turnRotateChain.then(() => {
              if (!streaming) return
              return streaming.update(textSnapshot).catch((err) => {
                console.error(
                  `[ZeRo OS] ${deps.channelName} streaming update error:`,
                  describeError(err),
                )
              })
            })
          }
        : undefined,
      onProgress: (newMsg) => {
        if (!canDeliverToCurrentSession()) return
        const text = extractAssistantTextFromMessage(newMsg)
        if (!text) return

        if (streaming) {
          lastSentMsgId = newMsg.id
          if (!seenDelta && text !== lastProgressText) {
            lastProgressText = text
            streamText = streamText ? `${streamText}\n\n${text}` : text
            const textSnapshot = streamText
            turnRotateChain = turnRotateChain.then(() => {
              if (!streaming) return
              return streaming.update(textSnapshot).catch((err) => {
                console.error(
                  `[ZeRo OS] ${deps.channelName} streaming update error:`,
                  describeError(err),
                )
              })
            })
          }
          return
        }

        if (text === lastProgressText) return
        lastProgressText = text
        lastSentMsgId = newMsg.id

        if (firstReply && messageId !== undefined) {
          firstReply = false
          deps.channelAdapter
            .reply(chatId, text, messageId)
            .catch((err) =>
              console.error(
                `[ZeRo OS] ${deps.channelName} progressive send error:`,
                describeError(err),
              ),
            )
          return
        }

        deps.channelAdapter
          .reply(chatId, text)
          .catch((err) =>
            console.error(
              `[ZeRo OS] ${deps.channelName} progressive send error:`,
              describeError(err),
            ),
          )
      },
    } satisfies HandleMessageOptions)

    await turnRotateChain

    const imageBlocks = replies
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content)
      .filter((block): block is ImageBlock => block.type === 'image')

    let imageMarkdownSuffix = ''
    const shouldEmbedImageBlocks = Boolean(streaming) || !lastSentMsgId
    let failedImageBlocks: ImageBlock[] = []
    if (imageBlocks.length > 0 && shouldEmbedImageBlocks) {
      if (deps.channelAdapter.uploadImage) {
        const uploadResults = await Promise.all(
          imageBlocks.map(async (img, index) => {
            try {
              const imageBuffer = Buffer.from(img.data, 'base64')
              const uploaded = await deps.channelAdapter.uploadImage?.(imageBuffer)
              return { uploaded, block: img }
            } catch (imgErr) {
              console.warn(
                `[ZeRo OS] ${deps.channelName} failed to upload image block ${index}:`,
                describeError(imgErr),
              )
              return { uploaded: null, block: img }
            }
          }),
        )

        const uploadedRefs = uploadResults
          .map((result) => result.uploaded?.markdownRef)
          .filter((ref): ref is string => Boolean(ref))
        failedImageBlocks = uploadResults
          .filter((result) => !result.uploaded)
          .map((result) => result.block)

        if (uploadedRefs.length > 0) {
          imageMarkdownSuffix = `\n\n${uploadedRefs.map((ref, index) => `![image-${index + 1}](${ref})`).join('\n\n')}`
        }
      } else {
        failedImageBlocks = imageBlocks
      }
    }

    if (streaming) {
      if (!canDeliverToCurrentSession()) {
        await dismissStreaming(streaming)
        streaming = null
      } else {
        const finalText = (streamText || collectAssistantReply(replies)) + imageMarkdownSuffix
        try {
          await streaming.complete(finalText)
        } catch (err) {
          console.error(
            `[ZeRo OS] ${deps.channelName} streaming finalization error:`,
            describeError(err),
          )
          if (finalText && canDeliverToCurrentSession()) {
            await deps.channelAdapter.reply(chatId, finalText, messageId)
          }
        }
        streaming = null
      }
    } else if (!lastSentMsgId) {
      const replyText = collectAssistantReply(replies) + imageMarkdownSuffix
      if (replyText && canDeliverToCurrentSession()) {
        await deps.channelAdapter.reply(chatId, replyText, messageId)
      }
    }

    const fallbackImageBlocks = shouldEmbedImageBlocks ? failedImageBlocks : imageBlocks
    if (
      fallbackImageBlocks.length > 0 &&
      deps.channelAdapter.sendImage &&
      canDeliverToCurrentSession()
    ) {
      for (const img of fallbackImageBlocks) {
        try {
          const imageBuffer = Buffer.from(img.data, 'base64')
          await deps.channelAdapter.sendImage(chatId, imageBuffer)
        } catch (imgErr) {
          console.warn(
            `[ZeRo OS] ${deps.channelName} failed to send image block:`,
            describeError(imgErr),
          )
        }
      }
    }

    await typingHandle?.clear().catch(() => {})
    if (canDeliverToCurrentSession()) {
      await deps.channelAdapter.markDone?.(chatId, messageId).catch(() => {})
    }
  } catch (err) {
    console.error(`[ZeRo OS] ${deps.channelName} message handler error:`, describeError(err))

    const errorMessage = toErrorMessage(err)
    let sessionWasArchived = false

    if (activeSessionId && errorMessage.includes('No tool output found for function call')) {
      deps.sessionManager.remove(activeSessionId)
      sessionWasArchived = true
      console.warn(
        `[ZeRo OS] Archived poisoned ${deps.channelName} session after tool output mismatch:`,
        activeSessionId,
      )
    }

    const isTransient =
      errorMessage.includes('overloaded_error') ||
      errorMessage.includes('Overloaded') ||
      /\b(429|503|529)\b/.test(errorMessage)

    const rolledBack = (err as { rolledBack?: boolean })?.rolledBack !== false

    const userReply = sessionWasArchived
      ? 'Session corrupted and has been reset. Please resend your message.'
      : isTransient
        ? rolledBack
          ? '⚠️ AI 服务暂时过载（已重试 3 次仍未恢复），消息已回滚。请稍后重新发送。'
          : '⚠️ AI 服务暂时过载，已完成的工作已保留。请发送新消息继续。'
        : rolledBack
          ? 'An error occurred processing your message.'
          : '处理中断，已完成的工作已保留。请发送新消息继续。'

    try {
      const activeStreaming = streaming
      const canDeliverToCurrentSession =
        activeSessionId !== null
          ? deps.sessionManager.isCurrentSessionForChannel(
              deps.channelType,
              deps.channelType === 'web' ? 'default' : chatId,
              deps.channelType === 'web' ? 'web' : deps.channelName,
              activeSessionId,
              deps.channelType === 'web' ? undefined : participantId,
            )
          : false
      if (activeStreaming) {
        streaming = null
        if (!canDeliverToCurrentSession) {
          await dismissStreaming(activeStreaming).catch(() => {})
        } else if (!rolledBack && streamText) {
          await activeStreaming.complete(streamText).catch(() => {})
          await deps.channelAdapter.reply(chatId, userReply, messageId)
        } else {
          await activeStreaming.abort(userReply).catch(() => {})
        }
      }

      await typingHandle?.clear().catch(() => {})
      if (canDeliverToCurrentSession) {
        await deps.channelAdapter.markError?.(chatId, messageId).catch(() => {})
      }

      if (!activeStreaming && canDeliverToCurrentSession) {
        await deps.channelAdapter.reply(chatId, userReply, messageId)
      }
    } catch {}
  }
}

function ensureSessionReady(session: Session, isNew: boolean, deps: MessageHandlerDeps): void {
  if (isNew || !session.isAgentInitialized()) {
    if (deps.channelCapabilities) {
      session.setChannelCapabilities(deps.channelCapabilities)
    }
    session.initAgent({
      name: deps.agentName,
      agentInstruction: deps.agentInstruction,
    })
  }
}

function isSessionTurnInProgress(session: Session): boolean {
  const maybeSession = session as Session & { isTurnInProgress?: () => boolean }
  return typeof maybeSession.isTurnInProgress === 'function' ? maybeSession.isTurnInProgress() : false
}

async function showTypingBestEffort(
  deps: MessageHandlerDeps,
  chatId: string,
  messageId: string | number | undefined,
): Promise<TypingHandle | null> {
  let settled = false
  let timeout: ReturnType<typeof setTimeout> | undefined

  const typing = deps.channelAdapter.showTyping(chatId, messageId).catch((err) => {
    if (!settled) {
      console.warn(
        `[ZeRo OS] ${deps.channelName} typing indicator failed; continuing message handling:`,
        describeError(err),
      )
    }
    return null
  })

  const timeoutGuard = new Promise<TypingHandle | null>((resolve) => {
    timeout = setTimeout(() => {
      if (!settled) {
        console.warn(
          `[ZeRo OS] ${deps.channelName} typing indicator timed out after ${TYPING_INDICATOR_TIMEOUT_MS}ms; continuing message handling`,
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
  if (source !== 'feishu') return undefined
  const senderId = msg.senderId.trim()
  if (senderId && senderId !== 'unknown') return senderId

  console.warn(
    '[ZeRo OS] Feishu message missing senderId; falling back to chat-level session scope',
  )
  return undefined
}

async function dismissStreaming(streaming: StreamAdapter): Promise<void> {
  const maybeDismiss = streaming as StreamAdapter & { dismiss?: () => Promise<void> }
  if (maybeDismiss.dismiss) {
    await maybeDismiss.dismiss()
    return
  }
  await streaming.abort().catch(() => {})
}

function normalizeMessageId(msg: IncomingMessage): string | number | undefined {
  const messageId = msg.metadata?.messageId
  if (typeof messageId === 'string' || typeof messageId === 'number') {
    return messageId
  }
  return undefined
}

function extractAssistantTextFromMessage(msg: Message): string {
  if (msg.role !== 'assistant') return ''
  return extractAssistantText(msg.content).trim()
}
