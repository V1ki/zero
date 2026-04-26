export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const

export function normalizeReasoningEffort(value?: string | null): ReasoningEffort | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'max') return 'xhigh'
  return REASONING_EFFORTS.find((effort) => effort === normalized)
}
