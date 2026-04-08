export interface DatasetRouteSearch {
  status?: string
  source?: string
  traits?: string
  hasEvaluation?: string
  since?: string
  until?: string
  offset?: number
  limit?: number
}

const ALLOWED_STATUSES = new Set(['active', 'completed', 'failed', 'archived'])
const ALLOWED_SOURCES = new Set(['web', 'feishu', 'telegram', 'scheduler'])

export function parseTraitsSearch(value?: string): string[] {
  if (!value) return []

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function formatTraitsSearch(values: string[]): string | undefined {
  const next = values.map((value) => value.trim()).filter(Boolean)
  return next.length > 0 ? next.join(',') : undefined
}

export function validateDatasetSearch(search: Record<string, unknown>): DatasetRouteSearch {
  const status =
    typeof search.status === 'string' && ALLOWED_STATUSES.has(search.status)
      ? search.status
      : undefined
  const source =
    typeof search.source === 'string' && ALLOWED_SOURCES.has(search.source)
      ? search.source
      : undefined
  const traits =
    typeof search.traits === 'string' && search.traits.trim().length > 0
      ? search.traits
      : undefined
  const hasEvaluation =
    search.hasEvaluation === 'true' || search.hasEvaluation === 'false'
      ? search.hasEvaluation
      : undefined
  const since =
    typeof search.since === 'string' && search.since.trim().length > 0
      ? search.since
      : undefined
  const until =
    typeof search.until === 'string' && search.until.trim().length > 0
      ? search.until
      : undefined
  const offset =
    typeof search.offset === 'number' && Number.isFinite(search.offset) && search.offset >= 0
      ? search.offset
      : typeof search.offset === 'string'
        ? normalizeNonNegativeInt(search.offset)
        : undefined
  const limit =
    typeof search.limit === 'number' && Number.isFinite(search.limit) && search.limit >= 0
      ? search.limit
      : typeof search.limit === 'string'
        ? normalizeNonNegativeInt(search.limit)
        : undefined

  return compactDatasetSearch({
    status,
    source,
    traits,
    hasEvaluation,
    since,
    until,
    offset,
    limit,
  })
}

function normalizeNonNegativeInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

export function compactDatasetSearch(search: DatasetRouteSearch): DatasetRouteSearch {
  return Object.fromEntries(
    Object.entries(search).filter(([, value]) => value !== undefined && value !== ''),
  ) as DatasetRouteSearch
}

export function buildDatasetEpisodesQuery(search: DatasetRouteSearch): string {
  const params = new URLSearchParams()

  if (search.status) params.set('statuses', search.status)
  if (search.source) params.set('sources', search.source)

  const traits = parseTraitsSearch(search.traits)
  if (traits.length > 0) {
    params.set('traits', traits.join(','))
  }

  if (search.hasEvaluation === 'true' || search.hasEvaluation === 'false') {
    params.set('hasEvaluation', search.hasEvaluation)
  }
  if (search.since) params.set('since', search.since)
  if (search.until) params.set('until', search.until)
  if (search.offset !== undefined) params.set('offset', String(search.offset))
  if (search.limit !== undefined) params.set('limit', String(search.limit))

  return params.toString()
}
