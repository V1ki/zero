import { createHash } from 'node:crypto'

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

export function stableDigest(value: unknown, length = 64): string {
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, length)
}

export function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => [key, sortValue(item)]),
  )
}
