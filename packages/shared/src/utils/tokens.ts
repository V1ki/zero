import type { ContentBlock } from '../types/message'

const CHARS_PER_TOKEN = 3.5

/**
 * Estimate token count for a string using character-based heuristic.
 * ~3.5 chars per token works well for mixed Chinese/English text.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Truncate text to fit within a token budget.
 * Returns the original text if it fits, otherwise truncates at a character boundary.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return ''
  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN)
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars)
}

/**
 * Estimate token count for an array of ContentBlocks.
 */
export function estimateMessageTokens(contentBlocks: ContentBlock[]): number {
  let total = 0
  for (const block of contentBlocks) {
    switch (block.type) {
      case 'text':
        total += estimateTokens(block.text)
        break
      case 'tool_use':
        total += estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input))
        break
      case 'tool_result':
        total += estimateTokens(block.content)
        for (const item of block.contentItems ?? []) {
          if (item.type === 'text') {
            total += estimateTokens(item.text)
          } else if (item.type === 'image') {
            total += 300
          }
        }
        break
      case 'image':
        total += 300 // fixed estimate for images
        break
      case 'thinking':
        total += estimateTokens(block.thinking)
        break
    }
  }
  return total
}
