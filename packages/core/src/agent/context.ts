import type { ContentBlock, Message } from '@zero-os/shared'
import { estimateMessageTokens, hasSignedThinkingBlock } from '@zero-os/shared'

/**
 * Estimate total tokens in a conversation history.
 */
export function estimateConversationTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    total += estimateMessageTokens(msg.content)
    total += 4 // overhead per message (role, metadata)
  }
  return total
}

const RETAINED_HANDLE_URL_PATTERN = /https?:\/\/[^\s"'<>）)、,；;]+/g
// Paths are boundary-anchored so a segment like /tmp inside /repo/tmp/... is
// never captured as a truncated path starting mid-token.
const RETAINED_HANDLE_ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s"'(<（【=])(\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)+)/g
const RETAINED_HANDLE_RELATIVE_PATH_PATTERN =
  /(?:^|[\s"'(<（【=])((?:\.zero|~|\.)\/[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*)/g
const RETAINED_HANDLE_FILE_PATTERN = /[A-Za-z0-9_][A-Za-z0-9_.-]{2,}\.[A-Za-z][A-Za-z0-9]{0,7}/g
const RETAINED_HANDLE_FLAG_PATTERN = /(?:^|[\s"'=(])-{1,2}[A-Za-z][A-Za-z0-9_-]{2,}/g

/**
 * Exact handles (URLs, paths, filenames, command flags) that later turns
 * frequently reuse as tool arguments. Truncated tool results keep a bounded
 * list of them so heavy compaction does not sever the link to previously
 * produced artifacts.
 */
export function extractRetainedHandles(text: string): string[] {
  const categories = extractRetainedHandlesByCategory(text)
  return [...categories.urls, ...categories.paths, ...categories.files, ...categories.flags]
}

interface RetainedHandleCategories {
  urls: string[]
  paths: string[]
  files: string[]
  flags: string[]
}

function extractRetainedHandlesByCategory(text: string): RetainedHandleCategories {
  const push = (list: string[], seen: Set<string>, value: string) => {
    const handle = value.replace(/[.,;:)\]}>'"]+$/, '')
    if (handle.length < 4 || seen.has(handle)) return
    seen.add(handle)
    list.push(handle)
  }
  const urls: string[] = []
  const paths: string[] = []
  const files: string[] = []
  const flags: string[] = []
  const urlSeen = new Set<string>()
  const pathSeen = new Set<string>()
  const fileSeen = new Set<string>()
  const flagSeen = new Set<string>()
  for (const match of text.matchAll(RETAINED_HANDLE_URL_PATTERN)) push(urls, urlSeen, match[0])
  for (const match of text.matchAll(RETAINED_HANDLE_ABSOLUTE_PATH_PATTERN))
    push(paths, pathSeen, match[1])
  for (const match of text.matchAll(RETAINED_HANDLE_RELATIVE_PATH_PATTERN))
    push(paths, pathSeen, match[1])
  for (const match of text.matchAll(RETAINED_HANDLE_FILE_PATTERN)) {
    // Skip bare filenames already contained in a longer path or URL handle.
    const contained =
      paths.some((path) => path.includes(match[0])) || urls.some((url) => url.includes(match[0]))
    if (!contained) push(files, fileSeen, match[0])
  }
  for (const match of text.matchAll(RETAINED_HANDLE_FLAG_PATTERN)) push(flags, flagSeen, match[0])
  return { urls, paths, files, flags }
}

export function sanitizeConversationHistoryForSignedThinkingToolUse(
  messages: Message[],
): Message[] {
  const invalidToolUseIds = new Set<string>()
  const sanitized: Message[] = []

  for (const message of messages) {
    if (
      message.role === 'assistant' &&
      message.content.some((block) => block.type === 'tool_use')
    ) {
      const hasThinking = hasSignedThinkingBlock(message.content)

      if (!hasThinking) {
        const content = message.content.filter((block) => {
          if (block.type === 'thinking') return false
          if (block.type !== 'tool_use') return true
          invalidToolUseIds.add(block.id)
          return false
        })

        if (content.length > 0) {
          sanitized.push({ ...message, content })
        }
        continue
      }
    }

    if (
      invalidToolUseIds.size > 0 &&
      message.role === 'user' &&
      message.content.some(
        (block) => block.type === 'tool_result' && invalidToolUseIds.has(block.toolUseId),
      )
    ) {
      const content = message.content.filter(
        (block) => block.type !== 'tool_result' || !invalidToolUseIds.has(block.toolUseId),
      )
      if (content.length > 0) {
        sanitized.push({ ...message, content })
      }
      continue
    }

    if (
      message.role === 'assistant' &&
      message.content.some((block) => block.type === 'thinking') &&
      !message.content.some((block) => block.type === 'tool_use')
    ) {
      const content = message.content.filter((block) => block.type !== 'thinking')
      if (content.length > 0) {
        sanitized.push({ ...message, content })
      }
      continue
    }

    sanitized.push(message)
  }

  return sanitized.length === messages.length &&
    sanitized.every((message, index) => message === messages[index])
    ? messages
    : sanitized
}

function isMergeableInterleavedToolMessage(message: Message): boolean {
  return (
    message.messageType === 'queued' ||
    (message.messageType === 'control' && message.controlKind === 'background_tool_completed')
  )
}

function toolUseIds(message: Message): string[] {
  if (message.role !== 'assistant') return []
  return message.content.flatMap((block) =>
    block.type === 'tool_use' && block.id ? [block.id] : [],
  )
}

function toolResultIds(message: Message): Set<string> {
  if (message.role !== 'user') return new Set()
  return new Set(
    message.content.flatMap((block) =>
      block.type === 'tool_result' && block.toolUseId ? [block.toolUseId] : [],
    ),
  )
}

/**
 * Reorder persisted history so tool_result carrier messages sit immediately
 * after their assistant tool_use message. Unlike mergeInterleavedQueuedMessages,
 * this preserves queued/control messages as standalone timeline records.
 */
export function repairInterleavedToolResultOrder(messages: Message[]): Message[] {
  if (messages.length < 3) return messages

  let repaired: Message[] | undefined
  const current = () => repaired ?? messages

  for (let i = 0; i < current().length - 1; i++) {
    const assistant = current()[i]
    const ids = toolUseIds(assistant)
    if (ids.length === 0) continue

    const nextIds = toolResultIds(current()[i + 1])
    const missing = ids.filter((id) => !nextIds.has(id))
    if (missing.length === 0) continue

    let matchIndex: number | undefined
    for (let j = i + 1; j < current().length; j++) {
      const candidateIds = toolResultIds(current()[j])
      if (missing.every((id) => candidateIds.has(id))) {
        matchIndex = j
        break
      }
      if (!isMergeableInterleavedToolMessage(current()[j])) {
        break
      }
    }

    if (matchIndex === undefined) continue

    if (!repaired) repaired = [...messages]
    const [toolResult] = repaired.splice(matchIndex, 1)
    if (toolResult) repaired.splice(i + 1, 0, toolResult)
    i++
  }

  return repaired ?? messages
}

/**
 * Merge queued/control messages that sit between an assistant tool_use message
 * and its corresponding user tool_result message. The Anthropic API requires
 * that every assistant message containing tool_use blocks is immediately
 * followed by a user message with the matching tool_result blocks.
 *
 * When a user message or background control event arrives while the agent is
 * executing tools, the session stores it as a standalone message in the
 * history. This can break the tool_use → tool_result pairing. This function
 * detects that pattern and merges the interleaved content into the tool_result
 * message used for the model prompt.
 */
export function mergeInterleavedQueuedMessages(messages: Message[]): Message[] {
  if (messages.length < 3) return messages

  // Phase 1: identify mergeable messages sandwiched between tool_use and tool_result
  const indicesToSkip = new Set<number>()
  const mergeInto = new Map<number, number[]>() // tool_result idx -> interleaved indices

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const ids = toolUseIds(msg)
    if (ids.length === 0) continue

    // Scan forward past messages that are safe to fold into the next tool_result.
    const interleavedIndices: number[] = []
    let j = i + 1
    while (j < messages.length && isMergeableInterleavedToolMessage(messages[j])) {
      interleavedIndices.push(j)
      j++
    }

    if (interleavedIndices.length === 0) continue

    // Check if the next non-queued message is a user message with tool_result
    if (
      j < messages.length &&
      messages[j].role === 'user' &&
      ids.every((id) => toolResultIds(messages[j]).has(id))
    ) {
      for (const qi of interleavedIndices) indicesToSkip.add(qi)
      mergeInto.set(j, interleavedIndices)
    }
  }

  if (indicesToSkip.size === 0) return messages

  // Phase 2: build output — skip standalone queued, merge into tool_result
  const result: Message[] = []
  for (let i = 0; i < messages.length; i++) {
    if (indicesToSkip.has(i)) continue

    if (mergeInto.has(i)) {
      const extraContent: ContentBlock[] = []
      const queuedIndices = mergeInto.get(i) ?? []
      for (const qi of queuedIndices) {
        extraContent.push(...messages[qi].content)
      }
      result.push({ ...messages[i], content: [...messages[i].content, ...extraContent] })
    } else {
      result.push(messages[i])
    }
  }

  return result
}
