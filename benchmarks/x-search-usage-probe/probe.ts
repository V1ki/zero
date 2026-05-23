export interface ProbeOptions {
  model: string
  query: string
  maxOutputTokens: number
  enableImageUnderstanding: boolean
  enableVideoUnderstanding: boolean
}

export interface ProbeRecord {
  index: number
  startedAt: string
  finishedAt: string
  elapsedMs: number
  ok: boolean
  status: number
  responseId?: string
  headers: Record<string, string>
  usage?: ProbeUsage
  outputTextLength: number
  citationCount: number
  rateLimit?: RateLimitObservation
  error?: ProbeError
  limit?: LimitSignal
}

export interface ProbeUsage {
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  xSearchCalls?: number
  serverSideToolsUsed?: number
  sourcesUsed?: number
  costUsdTicks?: number
  raw?: Record<string, unknown>
}

export interface ProbeError {
  code?: string
  message: string
  raw?: unknown
}

export interface LimitSignal {
  isLimit: boolean
  reason?: string
  retryAfterSeconds?: number
  resetAt?: string
}

export interface RateLimitObservation {
  limit?: number
  remaining?: number
  resetAt?: string
  retryAfterSeconds?: number
}

export interface ProbeSummary {
  startedAt: string
  finishedAt: string
  totalRequests: number
  successes: number
  failures: number
  firstLimitAt?: string
  firstLimitStatus?: number
  inferredResetAt?: string
  totalUsage: {
    inputTokens: number
    cachedInputTokens: number
    outputTokens: number
    reasoningTokens: number
    totalTokens: number
    xSearchCalls: number
    serverSideToolsUsed: number
    sourcesUsed: number
    costUsdTicks: number
  }
  xSearch: {
    requestsWithXSearch: number
    requestsWithoutXSearch: number
  }
  rateLimit: {
    observations: number
    minRemaining?: number
    lastRemaining?: number
    lastLimit?: number
    nextResetAt?: string
    retryAfterSeconds?: number
  }
}

const HEADER_ALLOWLIST = [
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-request-id',
  'x-ai-request-id',
  'cf-ray',
]

const LIMIT_PATTERNS = [
  /rate.?limit/i,
  /\blimit\b/i,
  /\bquota\b/i,
  /\busage\b/i,
  /fair.?use/i,
  /available resources/i,
  /subscription/i,
  /too many requests/i,
  /retry.?after/i,
]

export function buildXSearchProbePayload(options: ProbeOptions, index: number, now = new Date()) {
  const tool: Record<string, unknown> = { type: 'x_search' }
  if (options.enableImageUnderstanding) tool.enable_image_understanding = true
  if (options.enableVideoUnderstanding) tool.enable_video_understanding = true

  return {
    model: options.model,
    input: [
      {
        role: 'user',
        content: [
          `Quota probe request #${index} at ${now.toISOString()}.`,
          `Search X for: ${options.query}`,
          'Use x_search once if possible and answer in one short sentence.',
        ].join('\n'),
      },
    ],
    tools: [tool],
    max_output_tokens: options.maxOutputTokens,
    store: false,
  }
}

export async function parseProbeResponse(
  index: number,
  startedAt: string,
  response: Response,
  now = new Date(),
): Promise<ProbeRecord> {
  const finishedAt = now.toISOString()
  const elapsedMs = Math.max(now.getTime() - Date.parse(startedAt), 0)
  const bodyText = await response.text()
  const json = parseJson(bodyText)
  const bodyRecord = isRecord(json) ? json : undefined
  const usage = extractUsage(bodyRecord)
  const error = response.ok ? undefined : extractError(bodyText, json)
  const rateLimit = extractRateLimitObservation(response.headers, now)
  const limit = detectLimitSignal(
    response.status,
    response.headers,
    rateLimit,
    error,
    bodyText,
    now,
  )

  return {
    index,
    startedAt,
    finishedAt,
    elapsedMs,
    ok: response.ok,
    status: response.status,
    responseId: typeof bodyRecord?.id === 'string' ? bodyRecord.id : undefined,
    headers: extractObservedHeaders(response.headers),
    usage,
    outputTextLength: extractOutputText(bodyRecord).length,
    citationCount: countCitations(bodyRecord),
    rateLimit,
    error,
    limit: limit.isLimit ? limit : undefined,
  }
}

export function shouldStopAfterRecord(record: ProbeRecord, stopOnLimit: boolean): boolean {
  return stopOnLimit && Boolean(record.limit?.isLimit)
}

export function summarizeProbeRecords(
  records: ProbeRecord[],
  startedAt: string,
  finishedAt = new Date().toISOString(),
): ProbeSummary {
  const totalUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    xSearchCalls: 0,
    serverSideToolsUsed: 0,
    sourcesUsed: 0,
    costUsdTicks: 0,
  }

  for (const record of records) {
    totalUsage.inputTokens += record.usage?.inputTokens ?? 0
    totalUsage.cachedInputTokens += record.usage?.cachedInputTokens ?? 0
    totalUsage.outputTokens += record.usage?.outputTokens ?? 0
    totalUsage.reasoningTokens += record.usage?.reasoningTokens ?? 0
    totalUsage.totalTokens += record.usage?.totalTokens ?? 0
    totalUsage.xSearchCalls += record.usage?.xSearchCalls ?? 0
    totalUsage.serverSideToolsUsed += record.usage?.serverSideToolsUsed ?? 0
    totalUsage.sourcesUsed += record.usage?.sourcesUsed ?? 0
    totalUsage.costUsdTicks += record.usage?.costUsdTicks ?? 0
  }

  const firstLimit = records.find((record) => record.limit?.isLimit)
  const rateLimit = summarizeRateLimitObservations(records)

  return {
    startedAt,
    finishedAt,
    totalRequests: records.length,
    successes: records.filter((record) => record.ok).length,
    failures: records.filter((record) => !record.ok).length,
    firstLimitAt: firstLimit?.finishedAt,
    firstLimitStatus: firstLimit?.status,
    inferredResetAt: firstLimit?.limit?.resetAt,
    totalUsage,
    xSearch: {
      requestsWithXSearch: records.filter((record) => (record.usage?.xSearchCalls ?? 0) > 0).length,
      requestsWithoutXSearch: records.filter((record) => (record.usage?.xSearchCalls ?? 0) === 0)
        .length,
    },
    rateLimit,
  }
}

function extractObservedHeaders(headers: Headers): Record<string, string> {
  const observed: Record<string, string> = {}
  for (const name of HEADER_ALLOWLIST) {
    const value = headers.get(name)
    if (value) observed[name] = value
  }
  return observed
}

function extractUsage(payload: Record<string, unknown> | undefined): ProbeUsage | undefined {
  const usage = isRecord(payload?.usage) ? payload.usage : undefined
  if (!usage) return undefined

  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined
  const outputDetails = isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : undefined
  const serverSideTools = isRecord(usage.server_side_tool_usage_details)
    ? usage.server_side_tool_usage_details
    : undefined

  return {
    inputTokens: readNumber(usage.input_tokens),
    cachedInputTokens: readNumber(inputDetails?.cached_tokens),
    outputTokens: readNumber(usage.output_tokens),
    reasoningTokens: readNumber(outputDetails?.reasoning_tokens),
    totalTokens: readNumber(usage.total_tokens),
    xSearchCalls: readNumber(serverSideTools?.x_search_calls),
    serverSideToolsUsed: readNumber(usage.num_server_side_tools_used),
    sourcesUsed: readNumber(usage.num_sources_used),
    costUsdTicks: readNumber(usage.cost_in_usd_ticks),
    raw: usage,
  }
}

function extractError(bodyText: string, payload: unknown): ProbeError {
  if (isRecord(payload)) {
    const nested = isRecord(payload.error) ? payload.error : undefined
    const code = readString(payload.code) ?? readString(nested?.code)
    const message =
      readString(payload.message) ??
      readString(payload.error) ??
      readString(nested?.message) ??
      readString(nested?.type) ??
      bodyText.slice(0, 500)
    return { code, message, raw: payload }
  }

  return { message: bodyText.slice(0, 500) || 'Request failed' }
}

function detectLimitSignal(
  status: number,
  headers: Headers,
  rateLimit: RateLimitObservation | undefined,
  error: ProbeError | undefined,
  bodyText: string,
  now: Date,
): LimitSignal {
  const retryAfter = parseRetryAfter(headers.get('retry-after'), now)
  const resetAt = rateLimit?.resetAt ?? retryAfter?.resetAt
  const text = [error?.code, error?.message, bodyText].filter(Boolean).join('\n')
  const headerSuggestsLimit =
    Boolean(retryAfter) || (typeof rateLimit?.remaining === 'number' && rateLimit.remaining <= 0)
  const textSuggestsLimit = LIMIT_PATTERNS.some((pattern) => pattern.test(text))
  const statusSuggestsLimit = status === 429 || (status === 403 && textSuggestsLimit)

  return {
    isLimit: statusSuggestsLimit || ((status === 403 || status === 429) && headerSuggestsLimit),
    reason: error?.code ?? error?.message,
    retryAfterSeconds: retryAfter?.seconds,
    resetAt: resetAt ?? parseResetFromText(text, now),
  }
}

function extractRateLimitObservation(
  headers: Headers,
  now = new Date(),
): RateLimitObservation | undefined {
  const limit = parseHeaderNumber(headers.get('x-ratelimit-limit'))
  const remaining = parseHeaderNumber(headers.get('x-ratelimit-remaining'))
  const resetAt = parseResetHeader(headers.get('x-ratelimit-reset'), now)
  const retryAfter = parseRetryAfter(headers.get('retry-after'), now)

  if (typeof limit !== 'number' && typeof remaining !== 'number' && !resetAt && !retryAfter) {
    return undefined
  }

  const observation: RateLimitObservation = {}
  if (typeof limit === 'number') observation.limit = limit
  if (typeof remaining === 'number') observation.remaining = remaining
  if (resetAt ?? retryAfter?.resetAt) observation.resetAt = resetAt ?? retryAfter?.resetAt
  if (typeof retryAfter?.seconds === 'number') observation.retryAfterSeconds = retryAfter.seconds
  return observation
}

function summarizeRateLimitObservations(records: ProbeRecord[]): ProbeSummary['rateLimit'] {
  const observations = records
    .map((record) => record.rateLimit)
    .filter((value): value is RateLimitObservation => Boolean(value))
  const remainingValues = observations
    .map((observation) => observation.remaining)
    .filter((value): value is number => typeof value === 'number')
  const lastObservation = observations.at(-1)
  const resetTimes = observations
    .map((observation) => observation.resetAt)
    .filter((value): value is string => Boolean(value))
  const retryAfter = observations.findLast(
    (observation) => typeof observation.retryAfterSeconds === 'number',
  )?.retryAfterSeconds

  const summary: ProbeSummary['rateLimit'] = { observations: observations.length }
  if (remainingValues.length > 0) {
    summary.minRemaining = Math.min(...remainingValues)
    summary.lastRemaining = remainingValues.at(-1)
  }
  if (typeof lastObservation?.limit === 'number') summary.lastLimit = lastObservation.limit
  if (resetTimes.length > 0) summary.nextResetAt = resetTimes.at(-1)
  if (typeof retryAfter === 'number') summary.retryAfterSeconds = retryAfter
  return summary
}

export function parseRetryAfter(
  value: string | null,
  now = new Date(),
): { seconds: number; resetAt: string } | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  const seconds = Number.parseInt(trimmed, 10)
  if (Number.isFinite(seconds)) {
    return {
      seconds: Math.max(seconds, 0),
      resetAt: new Date(now.getTime() + Math.max(seconds, 0) * 1000).toISOString(),
    }
  }

  const dateMs = Date.parse(trimmed)
  if (!Number.isNaN(dateMs)) {
    return {
      seconds: Math.max(Math.ceil((dateMs - now.getTime()) / 1000), 0),
      resetAt: new Date(dateMs).toISOString(),
    }
  }

  return undefined
}

function parseResetHeader(value: string | null, now: Date): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  const asNumber = Number(trimmed)
  if (Number.isFinite(asNumber)) {
    const millis = asNumber > 10_000_000_000 ? asNumber : asNumber * 1000
    return new Date(millis).toISOString()
  }

  return parseRetryAfter(trimmed, now)?.resetAt
}

function parseHeaderNumber(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseResetFromText(text: string, now: Date): string | undefined {
  const match = text.match(
    /(?:try again|retry|reset|available)[^0-9]{0,40}(\d+)\s*(second|seconds|minute|minutes|hour|hours|day|days)/i,
  )
  if (!match) return undefined

  const amount = Number.parseInt(match[1] ?? '', 10)
  if (!Number.isFinite(amount)) return undefined
  const unit = (match[2] ?? '').toLowerCase()
  const multiplier = unit.startsWith('second')
    ? 1000
    : unit.startsWith('minute')
      ? 60_000
      : unit.startsWith('hour')
        ? 3_600_000
        : 86_400_000
  return new Date(now.getTime() + amount * multiplier).toISOString()
}

function extractOutputText(payload: Record<string, unknown> | undefined): string {
  const direct = readString(payload?.output_text)
  if (direct) return direct

  const output = Array.isArray(payload?.output) ? payload.output : []
  const parts: string[] = []
  for (const item of output) {
    if (!isRecord(item)) continue
    const content = Array.isArray(item.content) ? item.content : []
    for (const part of content) {
      if (!isRecord(part)) continue
      const text = readString(part.text)
      if (text) parts.push(text)
    }
  }
  return parts.join('\n')
}

function countCitations(payload: Record<string, unknown> | undefined): number {
  const output = Array.isArray(payload?.output) ? payload.output : []
  let count = Array.isArray(payload?.citations) ? payload.citations.length : 0
  for (const item of output) {
    if (!isRecord(item)) continue
    const content = Array.isArray(item.content) ? item.content : []
    for (const part of content) {
      if (!isRecord(part)) continue
      const annotations = Array.isArray(part.annotations) ? part.annotations : []
      count += annotations.filter(
        (annotation) => isRecord(annotation) && annotation.type === 'url_citation',
      ).length
    }
  }
  return count
}

function parseJson(text: string): unknown {
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
