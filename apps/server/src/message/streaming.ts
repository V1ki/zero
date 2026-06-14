import { describeError } from '@zero-os/shared'
import type { ChannelAdapter } from '../channels/adapter'
import type { StreamAdapter } from '../channels/adapter'

export async function createStreamingBestEffort(options: {
  channelAdapter: ChannelAdapter
  channelName: string
  chatId: string
  messageId?: string | number
}): Promise<StreamAdapter | null> {
  if (!options.channelAdapter.createStreaming) return null

  try {
    return await options.channelAdapter.createStreaming(options.chatId, options.messageId)
  } catch (err) {
    console.warn(
      `[ZeRo OS] ${options.channelName} streaming init failed, falling back to static:`,
      describeError(err),
    )
    return null
  }
}

export async function dismissStreaming(streaming: StreamAdapter): Promise<void> {
  const maybeDismiss = streaming as StreamAdapter & { dismiss?: () => Promise<void> }
  if (maybeDismiss.dismiss) {
    await maybeDismiss.dismiss()
    return
  }
  await streaming.abort().catch(() => {})
}
