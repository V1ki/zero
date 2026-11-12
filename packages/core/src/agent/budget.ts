import { estimateTokens, truncateToTokens } from '@zero-os/shared'

export function enforceFixedBudget(content: string, limit: number, label: string): string {
  const tokens = estimateTokens(content)
  if (tokens <= limit) return content

  const truncated = truncateToTokens(content, limit - 50)
  return `${truncated}\n\n[${label} 内容过长，已截断。原始长度 ${tokens} tokens，限制 ${limit} tokens。]`
}
