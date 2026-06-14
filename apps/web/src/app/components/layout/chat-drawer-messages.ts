export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'notification'
  content: string
  title?: string
  severity?: string
}

interface SessionContentBlock {
  type: string
  text?: string
  content?: string
}

export interface SessionMessage {
  id: string
  role: string
  content: SessionContentBlock[]
}

export function shouldRenderAssistantAsPlainText(content: string): boolean {
  if (!content.includes('\n')) return false

  return !/(^|\n)\s*(#{1,6}\s|\d+\.\s|[-*+]\s|>\s|```|\|.+\|)/m.test(content)
}

export function createChatMessage(message: Omit<ChatMessage, 'id'>): ChatMessage {
  return { id: crypto.randomUUID(), ...message }
}

export function isKnownModelName(modelName: string | null | undefined): modelName is string {
  return Boolean(modelName && modelName !== 'unknown')
}

function extractSessionMessageText(message: SessionMessage): string {
  return message.content
    .flatMap((block) => {
      if (block.type === 'text') {
        return typeof block.text === 'string' ? [block.text] : []
      }
      if (block.type === 'tool_result') {
        return typeof block.content === 'string' ? [block.content] : []
      }
      return []
    })
    .join('\n')
    .trim()
}

export function toChatMessages(messages: SessionMessage[]): ChatMessage[] {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => {
      const content = extractSessionMessageText(message)
      if (!content) return null
      return createChatMessage({
        role: message.role as 'user' | 'assistant',
        content,
      })
    })
    .filter((message): message is ChatMessage => Boolean(message))
}
