import type { HandleMessageOptions, SessionDeps, SessionManager } from '@zero-os/core'
import { type SessionSource, describeError } from '@zero-os/shared'
import type { ChannelAdapter } from '../channels/adapter'
import { createMessageTurnState, runMessageWithDelivery } from './turn'

export function createBackgroundToolCompletionDeliveryHandler(options: {
  channelAdapters: Map<string, ChannelAdapter>
  sessionManager: Pick<SessionManager, 'isCurrentSessionForChannel'>
}): NonNullable<SessionDeps['backgroundToolCompletionHandler']> {
  return async (event, run) => {
    const binding = event.channelBinding
    if (!binding || binding.source === 'web') return false

    const channelAdapter = options.channelAdapters.get(binding.channelName)
    if (!channelAdapter) return false

    const chatId = binding.deliveryChannelId ?? binding.channelId
    const state = createMessageTurnState()
    const canDeliverToCurrentSession = () =>
      options.sessionManager.isCurrentSessionForChannel(
        binding.source as SessionSource,
        binding.channelId,
        binding.channelName,
        event.task.sessionId,
        binding.participantId,
      )

    try {
      await runMessageWithDelivery({
        channelAdapter,
        channelName: binding.channelName,
        chatId,
        messageId: undefined,
        state,
        canDeliverToCurrentSession,
        runMessage: (deliveryOptions) =>
          run({
            ...deliveryOptions,
          } satisfies HandleMessageOptions),
      })
      return true
    } catch (error) {
      console.error(
        `[ZeRo OS] ${binding.channelName} background completion delivery error:`,
        describeError(error),
      )
      await state.typingHandle?.clear().catch(() => {})
      const streaming = state.progressDelivery?.streaming ?? state.streaming
      if (streaming) {
        await streaming.abort('Background task completion processing failed.').catch(() => {})
      } else if (canDeliverToCurrentSession()) {
        await channelAdapter
          .reply(chatId, 'Background task completion processing failed.')
          .catch(() => {})
      }
      throw error
    }
  }
}
