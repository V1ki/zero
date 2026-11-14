import type { SessionEventStore } from '@zero-os/observe'
import type { ToolLogger } from '@zero-os/shared'
import { toErrorMessage } from '@zero-os/shared'
import type { AgentLoopModule } from '../agent-loop'
import { CONTEXT_PARAMS } from '../params'
import {
  CONTINUATION_PROMPT,
  type QueuedMessage,
  buildLoopUserMessage,
  buildQueuedInjectionText,
  buildQueuedInjectionTrace,
  injectQueuedMessagesWithTrace,
  isTaskComplete,
} from '../queue'

/**
 * Messages the user sends while the turn runs. The base asks for them at fixed points: as a
 * continuation message when the turn would end, appended to the last user message after tool
 * results. Once they were taken, a turn that the answer leaves unfinished continues with a prompt.
 */
export function queueModule(options: {
  sessionId: string
  logger: ToolLogger
  events?: Pick<SessionEventStore, 'append'>
  shouldInterrupt?: () => boolean
  getQueuedMessages?: () => QueuedMessage[]
}): AgentLoopModule {
  const { sessionId } = options
  let hadQueuedMessages = false
  let continuationCount = 0
  let appliedCallbacks: Array<() => void> = []
  const track = (queued: QueuedMessage[]) => {
    for (const message of queued) if (message.onApplied) appliedCallbacks.push(message.onApplied)
  }

  return {
    shouldInterrupt: () => !!options.shouldInterrupt?.() && !hadQueuedMessages,
    takeQueued: () => {
      if (!options.shouldInterrupt?.()) return undefined
      const queued = options.getQueuedMessages?.() ?? []
      if (queued.length === 0) return undefined
      hadQueuedMessages = true
      track(queued)
      return {
        queued,
        injection: buildQueuedInjectionTrace(queued),
        continuationMessage: buildLoopUserMessage({
          sessionId,
          text: buildQueuedInjectionText(queued),
          controlKind: 'queued_injection',
        }),
      }
    },
    mergeQueued: (last) => {
      const queued = options.getQueuedMessages?.() ?? []
      hadQueuedMessages = false
      if (queued.length === 0) return undefined
      options.events?.append(sessionId, [
        { type: 'agent/inbox/drained', data: { count: queued.length } },
      ])
      if (last.role !== 'user') return undefined
      const injected = injectQueuedMessagesWithTrace(last, queued)
      options.events?.append(sessionId, [
        {
          type: 'agent/inbox/spliced',
          data: { strategy: 'inject_into_last_user', count: queued.length },
        },
      ])
      hadQueuedMessages = injected.trace !== undefined
      track(queued)
      return {
        queued,
        blocks: injected.message.content.slice(last.content.length),
        injection: injected.trace,
      }
    },
    onCompletionEnd: () => {
      const callbacks = appliedCallbacks
      appliedCallbacks = []
      for (const callback of callbacks) {
        try {
          callback()
        } catch (error) {
          options.logger.warn('queued_message_applied_callback_failed', {
            sessionId,
            error: toErrorMessage(error),
          })
        }
      }
    },
    decideEndTurn: (response) => {
      if (
        !hadQueuedMessages ||
        isTaskComplete(response.content) ||
        continuationCount >= CONTEXT_PARAMS.queue.maxContinuationRetries
      )
        return undefined
      continuationCount++
      hadQueuedMessages = false
      return {
        action: 'continue',
        continuationMessage: buildLoopUserMessage({
          sessionId,
          text: CONTINUATION_PROMPT,
          controlKind: 'continuation',
        }),
      }
    },
  }
}
