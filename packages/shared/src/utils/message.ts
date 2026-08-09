import type { ContentBlock, Message, TextBlock, ThinkingBlock } from '../types'

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text'
}

export function isSignedThinkingBlock(block: ContentBlock): block is ThinkingBlock {
  // The signature is what makes a thinking block replayable; DeepSeek may return
  // signature-only thinking blocks (empty thinking text) before tool_use, and its
  // API accepts them echoed back verbatim.
  return (
    block.type === 'thinking' && typeof block.signature === 'string' && block.signature.length > 0
  )
}

export function hasSignedThinkingBlock(content: ContentBlock[]): boolean {
  return content.some(isSignedThinkingBlock)
}

export function extractAssistantText(content: ContentBlock[]): string {
  return content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('')
}

export function collectAssistantReply(messages: Message[]): string {
  return messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.content)
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\n')
    .trim()
}
