export function isPureImagePlaceholder(content: string): boolean {
  const normalized = removeImagePlaceholders(content).replace(/\s+/g, '')
  return normalized.length === 0 && content.replace(/\s+/g, '').length > 0
}

export function removeImagePlaceholders(content: string): string {
  return content
    .replace(/^\s*\[(?:图片|Image(?:\s*#?\d+)?)\]\s*$/gim, '')
    .replace(/(?:\r?\n){3,}/g, '\n\n')
    .trim()
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`
}

export function extractTextFromJson(obj: unknown): string {
  if (typeof obj === 'string') return obj
  if (!obj || typeof obj !== 'object') return ''

  const texts: string[] = []
  for (const val of Object.values(obj)) {
    if (typeof val === 'string' && val.trim()) {
      texts.push(val)
    } else if (typeof val === 'object' && val !== null) {
      const nested = extractTextFromJson(val)
      if (nested) texts.push(nested)
    }
  }
  return texts.join(' ')
}
