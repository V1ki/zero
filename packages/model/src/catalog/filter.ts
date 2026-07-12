export function matchesModelFilters(
  value: string,
  filters: { allow?: string[]; deny?: string[] },
): boolean {
  if (filters.deny?.some((pattern) => matchesPattern(value, pattern))) return false
  if (!filters.allow?.length) return true
  return filters.allow.some((pattern) => matchesPattern(value, pattern))
}

function matchesPattern(value: string, pattern: string): boolean {
  const source = pattern
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${source}$`, 'i').test(value)
}
