import type { ContextCheckpoint, Message } from '@zero-os/shared'
import { extractRetainedHandles } from './context'
import { CONTEXT_PARAMS } from './params'

/**
 * 检查点投影，见 docs/context-compaction.md。只依赖 @zero-os/shared，经 `@zero-os/core/browser`
 * 供 Web 端计算「prompt 里有什么」，与运行时共用同一份实现。
 */

const P = CONTEXT_PARAMS.compaction

const CHECKPOINT_PREAMBLE =
  '本会话较早的部分已从上下文中移除，下面是那部分的摘要。之后的消息接着摘要里的工作继续。'

export function clip(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars) return text
  const omitted = text.length - headChars - tailChars
  return `${text.slice(0, headChars)}\n…[省略 ${omitted} 字符]…\n${text.slice(-tailChars)}`
}

/** 检查点水位在 messages 中的下标（没有该水位为 -1）；水位指向的消息不存在时返回 undefined。 */
export function locateCheckpoint(
  messages: Message[],
  checkpoint: ContextCheckpoint,
): { summarized: number; pruned: number } | undefined {
  const { summarizedThroughMessageId, prunedThroughMessageId } = checkpoint
  const summarized = messages.findIndex((message) => message.id === summarizedThroughMessageId)
  const pruned = messages.findIndex((message) => message.id === prunedThroughMessageId)
  if (summarizedThroughMessageId !== undefined && summarized < 0) return undefined
  if (prunedThroughMessageId !== undefined && pruned < 0) return undefined
  return { summarized, pruned }
}

export function isCheckpointValid(messages: Message[], checkpoint: ContextCheckpoint): boolean {
  return locateCheckpoint(messages, checkpoint) !== undefined
}

function pruneToolResults(message: Message): Message {
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type !== 'tool_result' || block.content.length <= P.prunedToolResultMaxChars) {
        return block
      }
      const kept = clip(block.content, P.prunedToolResultHeadChars, P.prunedToolResultTailChars)
      const handles: string[] = []
      let handleChars = 0
      for (const handle of extractRetainedHandles(block.content)) {
        if (kept.includes(handle)) continue
        if (
          handles.length >= P.retainedHandlesMaxCount ||
          handleChars + handle.length > P.retainedHandlesMaxChars
        ) {
          break
        }
        handles.push(handle)
        handleChars += handle.length + 2
      }
      const content = handles.length > 0 ? `${kept}\nretained_handles: ${handles.join(', ')}` : kept
      return { ...block, content }
    }),
  }
}

/**
 * 发给模型的消息：summary 取代被覆盖的前缀，裁剪水位之前的超大 tool_result 只留头尾，其余原样。
 * 纯函数；无效检查点按没有检查点处理。摘要消息的 id 是检查点 id。
 */
export function projectMessages(
  messages: Message[],
  checkpoint: ContextCheckpoint | undefined,
): Message[] {
  const at = checkpoint && locateCheckpoint(messages, checkpoint)
  if (!checkpoint || !at) return [...messages]

  const rest = messages
    .slice(at.summarized + 1)
    .map((message, offset) =>
      at.summarized + 1 + offset <= at.pruned ? pruneToolResults(message) : message,
    )
  if (at.summarized < 0) return rest

  const summaryMessage: Message = {
    id: checkpoint.id,
    sessionId: checkpoint.sessionId,
    role: 'user',
    messageType: 'message',
    content: [
      {
        type: 'text',
        text: `${CHECKPOINT_PREAMBLE}\n\n<context_checkpoint>\n${checkpoint.summary ?? ''}\n</context_checkpoint>`,
      },
    ],
    createdAt: checkpoint.createdAt,
  }
  return [summaryMessage, ...rest]
}
