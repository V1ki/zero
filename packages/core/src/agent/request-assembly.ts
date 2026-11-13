import { createHash } from 'node:crypto'
import { decodeImageData } from '@zero-os/observe'
import type {
  ContentBlock,
  ContextCheckpoint,
  ImageBlock,
  InjectionContextEventData,
  Message,
  RequestAssemblyInput,
} from '@zero-os/shared'
import { prepareRequestMessages } from './compaction'

/**
 * 一次模型请求的组装,运行时与重放共用,见 docs/session-event-log.md「请求重建」。
 */

export interface AssembledRequest {
  system: string
  toolNames: string[]
  messages: Message[]
}

/** 请求的 system 文本:静态系统提示词,有 identityMemory 时接在后面 */
export function composeSystemPrompt(systemPrompt: string, identityMemory?: string): string {
  return identityMemory ? `${systemPrompt}\n\n${identityMemory}` : systemPrompt
}

/**
 * loop 首条 user 消息的请求内容:注入(dynamic、image_delegation)按顺序作为前缀文本;
 * 有图片委托时去掉消息里的图片。
 */
export function applyUserInjections(
  content: ContentBlock[],
  injections: Array<Pick<InjectionContextEventData, 'kind' | 'content'>>,
): ContentBlock[] {
  if (injections.length === 0) return content
  const prefix: ContentBlock[] = injections.map((injection) => ({
    type: 'text',
    text: injection.content,
  }))
  const rest = injections.some((injection) => injection.kind === 'image_delegation')
    ? content.filter((block) => block.type !== 'image')
    : content
  return [...prefix, ...rest]
}

/**
 * 按日志顺序重演 loop 对请求消息的每一次改动:
 * - 第一条消息到来前,请求历史 = prepareRequestMessages(history, 当时的检查点);
 * - message:追加到请求末尾(canonical 消息或只在请求里的 request/message);
 * - injection dynamic / image_delegation:按 applyUserInjections 改写 messageId 那条消息;
 * - injection queued_merge:把 blocks 接到 messageId 那条消息末尾;
 * - checkpoint:之后的请求用新检查点;已有消息时(turn 内压缩)从 history + 已追加的消息重新投影,
 *   并补回注入与排队拼接(同一条消息拼接多次时只补回最后一次,与运行时一致)。
 */
export function assembleRequest(input: RequestAssemblyInput): AssembledRequest {
  const options = { requireThinkingForToolUse: input.requireThinkingForToolUse }
  let checkpoint: ContextCheckpoint | undefined = input.checkpoint
  const loopMessages: Message[] = []
  const userInjections = new Map<string, InjectionContextEventData[]>()
  const queuedBlocks = new Map<string, ContentBlock[]>()
  let messages: Message[] | undefined

  const overlay = (message: Message): Message => {
    const injections = userInjections.get(message.id)
    const request = injections
      ? { ...message, content: applyUserInjections(message.content, injections) }
      : message
    const queued = queuedBlocks.get(message.id)
    return queued ? { ...request, content: [...request.content, ...queued] } : request
  }
  const replace = (messageId: string, next: (message: Message) => Message) => {
    if (!messages) throw new Error(`request injection before any message: ${messageId}`)
    const index = messages.findLastIndex((message) => message.id === messageId)
    if (index < 0) throw new Error(`request injection targets a missing message: ${messageId}`)
    messages[index] = next(messages[index])
  }

  for (const entry of input.entries) {
    if (entry.kind === 'checkpoint') {
      checkpoint = entry.checkpoint ?? undefined
      if (messages) {
        messages = prepareRequestMessages(
          [...input.history, ...loopMessages],
          checkpoint,
          options,
        ).map(overlay)
      }
    } else if (entry.kind === 'message') {
      messages ??= prepareRequestMessages(input.history, checkpoint, options)
      loopMessages.push(entry.message)
      messages.push(entry.message)
    } else {
      const { injection } = entry
      const { messageId, blocks } = injection
      if (injection.kind === 'queued_merge') {
        if (!blocks) throw new Error(`queued_merge without blocks: ${messageId}`)
        queuedBlocks.set(messageId, blocks)
        replace(messageId, (message) => ({ ...message, content: [...message.content, ...blocks] }))
      } else {
        userInjections.set(messageId, [...(userInjections.get(messageId) ?? []), injection])
        const original = loopMessages.findLast((message) => message.id === messageId)
        if (!original) throw new Error(`request injection targets a missing message: ${messageId}`)
        replace(messageId, () => overlay(original))
      }
    }
  }

  return {
    system: composeSystemPrompt(input.systemPrompt, input.identityMemory),
    toolNames: input.toolNames,
    messages: messages ?? prepareRequestMessages(input.history, checkpoint, options),
  }
}

/**
 * 请求指纹:system、工具名与消息的 sha256(键排序的 JSON)。图片换成 mediaType + 内容 hash:
 * 运行时图片带 base64 data,日志与恢复后的消息只有 imageRef,两边按同一规则归一。
 */
export function hashRequest(request: AssembledRequest): string {
  const normalized = {
    system: request.system,
    toolNames: request.toolNames,
    messages: request.messages.map((message) => ({
      ...message,
      content: message.content.map(normalizeBlock),
    })),
  }
  return `sha256:${createHash('sha256').update(stableStringify(normalized)).digest('hex')}`
}

function normalizeBlock(block: ContentBlock): unknown {
  if (block.type === 'image') return normalizeImage(block)
  if (block.type === 'tool_result' && block.contentItems) {
    return {
      ...block,
      contentItems: block.contentItems.map((item) =>
        item.type === 'image' ? normalizeImage(item) : item,
      ),
    }
  }
  return block
}

function normalizeImage(block: ImageBlock): { type: 'image'; mediaType: string; sha256: string } {
  const sha256 = block.data ? decodeImageData(block.data).sha256 : block.imageRef?.sha256
  if (!sha256) throw new Error('image block has neither data nor imageRef')
  return { type: 'image', mediaType: block.mediaType, sha256 }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(',')}}`
}
