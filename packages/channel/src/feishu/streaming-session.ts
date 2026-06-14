import type * as lark from '@larksuiteoapi/node-sdk'
import { describeError } from '@zero-os/shared'
import { renderMarkdownForFeishu } from '../richtext/feishu'
import {
  FEISHU_STREAMING_ELEMENT_ID,
  FEISHU_STREAMING_UPDATE_INTERVAL_MS,
  buildFeishuFinalStreamingCardV2,
  buildFeishuStreamingCardV2,
} from './card'
import type { FeishuImageReference } from './image-resolver'
import { FeishuImageResolver } from './image-resolver'

export interface FeishuStreamingSession {
  /** Push accumulated text (not delta). CardKit diffs automatically. */
  update(fullText: string): Promise<void>
  /** Finalize the card: disable streaming mode, show final content. */
  complete(finalText: string): Promise<void>
  /** Abort the streaming card (e.g. on error). */
  abort(errorMessage?: string): Promise<void>
  /** Delete the attached streaming card message without showing an error state. */
  dismiss(): Promise<void>
  /** The card's message_id in the chat (available after first update). */
  readonly messageId: string | null
}

export interface FeishuImageTarget {
  chatId?: string
  replyToMessageId?: string
}

interface FeishuStreamingSessionOptions {
  client: lark.Client
  attachMessage: (cardId: string) => Promise<string | null>
  fallbackTarget: FeishuImageTarget
  deliverUnresolvedInlineImages: (
    images: FeishuImageReference[],
    target: FeishuImageTarget,
    source: 'streaming',
  ) => Promise<void>
  deleteMessage: (messageId: string) => Promise<void>
}

async function createFeishuStreamingCard(client: lark.Client): Promise<string> {
  try {
    const response = await client.cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: buildFeishuStreamingCardV2(),
      },
    })
    const cardId = response.data?.card_id
    if (!cardId) {
      throw new Error('CardKit create returned no card_id')
    }
    return cardId
  } catch (error) {
    console.warn('[FeishuChannel] streaming card create failed:', describeError(error))
    throw error
  }
}

async function updateFeishuStreamingCardContent(
  client: lark.Client,
  params: {
    cardId: string
    content: string
    sequence: number
  },
): Promise<void> {
  await client.cardkit.v1.cardElement.content({
    data: {
      content: params.content,
      sequence: params.sequence,
    },
    path: {
      card_id: params.cardId,
      element_id: FEISHU_STREAMING_ELEMENT_ID,
    },
  })
}

async function finalizeFeishuStreamingCard(
  client: lark.Client,
  params: {
    cardId: string
    content: string
    sequence: number
  },
): Promise<void> {
  await client.cardkit.v1.card.update({
    data: {
      card: {
        type: 'card_json',
        data: buildFeishuFinalStreamingCardV2(params.content),
      },
      sequence: params.sequence,
    },
    path: { card_id: params.cardId },
  })
}

export async function createFeishuStreamingSession({
  client,
  attachMessage,
  fallbackTarget,
  deliverUnresolvedInlineImages,
  deleteMessage,
}: FeishuStreamingSessionOptions): Promise<FeishuStreamingSession> {
  const cardId = await createFeishuStreamingCard(client)
  let initialMessageId: string | null = null
  try {
    initialMessageId = await attachMessage(cardId)
  } catch (error) {
    console.warn('[FeishuChannel] streaming card attach failed:', describeError(error))
    throw error
  }

  const messageId = initialMessageId
  let sequence = 0
  let closed = false
  let pendingText: string | null = null
  let latestRenderedText: string | null = null
  let lastDeliveredText: string | null = null
  let lastFlushAt = 0
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let flushChain: Promise<void> = Promise.resolve()
  const renderStreamingMarkdown = (text: string) =>
    renderMarkdownForFeishu(text, { preserveExternalImages: true })
  const imageResolver = new FeishuImageResolver({
    client,
    onImageResolved: () => {
      if (closed || latestRenderedText == null) return
      pendingText = latestRenderedText
      scheduleFlush()
    },
  })

  const clearFlushTimer = () => {
    if (!flushTimer) return
    clearTimeout(flushTimer)
    flushTimer = null
  }

  const nextSequence = () => {
    const current = sequence
    sequence += 1
    return current
  }

  const flushPending = async () => {
    clearFlushTimer()
    const text = pendingText
    const resolvedText = text == null ? null : imageResolver.resolveSync(text)
    if (resolvedText == null) {
      return
    }

    if (resolvedText === lastDeliveredText) {
      pendingText = null
      return
    }

    pendingText = null
    try {
      await updateFeishuStreamingCardContent(client, {
        cardId,
        content: resolvedText,
        sequence: nextSequence(),
      })
      lastDeliveredText = resolvedText
      lastFlushAt = Date.now()
    } catch (error) {
      pendingText = text
      console.warn('[FeishuChannel] streaming update failed:', describeError(error))
    }
  }

  const scheduleFlush = () => {
    if (closed) return
    if (flushTimer || pendingText == null) return

    const elapsed = Date.now() - lastFlushAt
    const delay = Math.max(0, FEISHU_STREAMING_UPDATE_INTERVAL_MS - elapsed)

    flushTimer = setTimeout(() => {
      flushTimer = null
      flushChain = flushChain.then(() => flushPending())
    }, delay)
  }

  const finalizeCard = async (
    content: string,
    logLabel: string,
    options?: { alreadyClosed?: boolean },
  ) => {
    if (!options?.alreadyClosed) {
      if (closed) return
      closed = true
      pendingText = null
      clearFlushTimer()
    }

    try {
      await flushChain
      await finalizeFeishuStreamingCard(client, {
        cardId,
        content,
        sequence: nextSequence(),
      })
      lastDeliveredText = content
    } catch (error) {
      console.warn(`[FeishuChannel] ${logLabel}:`, describeError(error))
    }
  }

  const teardown = () => {
    if (closed) return false
    closed = true
    pendingText = null
    clearFlushTimer()
    return true
  }

  return {
    get messageId() {
      return messageId
    },
    update: async (fullText: string) => {
      if (closed) return
      latestRenderedText = renderStreamingMarkdown(fullText)
      pendingText = latestRenderedText
      scheduleFlush()
    },
    complete: async (finalText: string) => {
      const rendered = renderStreamingMarkdown(finalText)
      latestRenderedText = rendered
      let unresolvedImages: FeishuImageReference[] = []
      const finalRendered =
        imageResolver.hasImages(rendered) || imageResolver.pendingCount > 0
          ? await imageResolver.resolveAll(rendered, 30_000)
          : imageResolver.resolveSync(rendered)
      unresolvedImages = imageResolver.collectUnresolved(rendered)
      await finalizeCard(finalRendered, 'streaming completion failed')
      await deliverUnresolvedInlineImages(unresolvedImages, fallbackTarget, 'streaming')
    },
    abort: async (errorMessage?: string) => {
      if (!teardown()) return
      let rendered = renderMarkdownForFeishu(
        errorMessage?.trim() || 'An error occurred while generating the response.',
      )
      rendered = imageResolver.resolveSync(rendered)
      await finalizeCard(rendered, 'streaming abort failed', { alreadyClosed: true })
    },
    dismiss: async () => {
      if (!teardown()) return

      try {
        await flushChain
        if (messageId) {
          await deleteMessage(messageId)
        }
      } catch (error) {
        console.warn('[FeishuChannel] streaming dismiss failed:', describeError(error))
      }
    },
  }
}
