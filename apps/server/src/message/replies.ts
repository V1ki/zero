import {
  type ImageBlock,
  type Message,
  collectAssistantReply,
  describeError,
} from '@zero-os/shared'
import type { ChannelAdapter, StreamAdapter } from '../channels/adapter'
import { dismissStreaming } from './streaming'

export async function deliverAssistantReplies(options: {
  replies: Message[]
  streaming: StreamAdapter | null
  streamText: string
  lastSentMsgId: string | null
  channelAdapter: ChannelAdapter
  channelName: string
  chatId: string
  messageId?: string | number
  canDeliverToCurrentSession(): boolean
}): Promise<StreamAdapter | null> {
  const shouldEmbedImageBlocks = Boolean(options.streaming) || !options.lastSentMsgId
  const imageBlocks = collectAssistantImageBlocks(options.replies)
  const { imageMarkdownSuffix, failedImageBlocks } = await prepareImageBlockDelivery({
    imageBlocks,
    shouldEmbedImageBlocks,
    channelAdapter: options.channelAdapter,
    channelName: options.channelName,
  })

  let streaming = options.streaming
  if (streaming) {
    if (!options.canDeliverToCurrentSession()) {
      await dismissStreaming(streaming)
      streaming = null
    } else {
      const finalText =
        (options.streamText || collectAssistantReply(options.replies)) + imageMarkdownSuffix
      try {
        await streaming.complete(finalText)
      } catch (err) {
        console.error(
          `[ZeRo OS] ${options.channelName} streaming finalization error:`,
          describeError(err),
        )
        if (finalText && options.canDeliverToCurrentSession()) {
          await options.channelAdapter.reply(options.chatId, finalText, options.messageId)
        }
      }
      streaming = null
    }
  } else if (!options.lastSentMsgId) {
    const replyText = collectAssistantReply(options.replies) + imageMarkdownSuffix
    if (replyText && options.canDeliverToCurrentSession()) {
      await options.channelAdapter.reply(options.chatId, replyText, options.messageId)
    }
  }

  await sendFallbackImageBlocks({
    imageBlocks: shouldEmbedImageBlocks ? failedImageBlocks : imageBlocks,
    channelAdapter: options.channelAdapter,
    chatId: options.chatId,
    channelName: options.channelName,
    canDeliver: options.canDeliverToCurrentSession(),
  })

  return streaming
}

export function collectAssistantImageBlocks(replies: Message[]): ImageBlock[] {
  return replies
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.content)
    .filter((block): block is ImageBlock => block.type === 'image')
}

export async function prepareImageBlockDelivery(options: {
  imageBlocks: ImageBlock[]
  shouldEmbedImageBlocks: boolean
  channelAdapter: ChannelAdapter
  channelName: string
}): Promise<{ imageMarkdownSuffix: string; failedImageBlocks: ImageBlock[] }> {
  if (options.imageBlocks.length === 0 || !options.shouldEmbedImageBlocks) {
    return { imageMarkdownSuffix: '', failedImageBlocks: [] }
  }

  if (!options.channelAdapter.uploadImage) {
    return { imageMarkdownSuffix: '', failedImageBlocks: options.imageBlocks }
  }

  const uploadResults = await Promise.all(
    options.imageBlocks.map(async (img, index) => {
      try {
        const imageBuffer = Buffer.from(img.data, 'base64')
        const uploaded = await options.channelAdapter.uploadImage?.(imageBuffer)
        return { uploaded, block: img }
      } catch (imgErr) {
        console.warn(
          `[ZeRo OS] ${options.channelName} failed to upload image block ${index}:`,
          describeError(imgErr),
        )
        return { uploaded: null, block: img }
      }
    }),
  )

  const uploadedRefs = uploadResults
    .map((result) => result.uploaded?.markdownRef)
    .filter((ref): ref is string => Boolean(ref))
  const failedImageBlocks = uploadResults
    .filter((result) => !result.uploaded)
    .map((result) => result.block)

  return {
    imageMarkdownSuffix:
      uploadedRefs.length > 0
        ? `\n\n${uploadedRefs.map((ref, index) => `![image-${index + 1}](${ref})`).join('\n\n')}`
        : '',
    failedImageBlocks,
  }
}

export async function sendFallbackImageBlocks(options: {
  imageBlocks: ImageBlock[]
  channelAdapter: ChannelAdapter
  chatId: string
  channelName: string
  canDeliver: boolean
}): Promise<void> {
  if (
    options.imageBlocks.length === 0 ||
    !options.channelAdapter.sendImage ||
    !options.canDeliver
  ) {
    return
  }

  for (const img of options.imageBlocks) {
    try {
      const imageBuffer = Buffer.from(img.data, 'base64')
      await options.channelAdapter.sendImage(options.chatId, imageBuffer)
    } catch (imgErr) {
      console.warn(
        `[ZeRo OS] ${options.channelName} failed to send image block:`,
        describeError(imgErr),
      )
    }
  }
}
