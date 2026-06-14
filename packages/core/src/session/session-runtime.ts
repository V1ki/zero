import type { ObservabilityStore, RequestLogEntry, SessionDB, Tracer } from '@zero-os/observe'
import type { Message, SecretFilter, SessionSource, ToolLogger } from '@zero-os/shared'
import { generateSessionId } from '@zero-os/shared'
import { isTopLevelUserTurn } from './session-messages'

interface AllocateUniqueSessionIdOptions {
  sessionDb?: SessionDB
  isReserved?: (id: string) => boolean
}

export function createSessionLogger(options: {
  sessionId: string
  tracer?: Tracer
  secretFilter?: SecretFilter
}): ToolLogger {
  const log = (level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) => {
    const safeData = filterLogData(data, options.secretFilter)
    const message = `[${options.sessionId}] ${event}`
    if (level === 'info') {
      console.log(message, safeData ?? '')
    } else if (level === 'warn') {
      console.warn(message, safeData ?? '')
    } else {
      console.error(message, safeData ?? '')
    }

    options.tracer?.logSession(options.sessionId, level, `logger.${level}`, {
      logEvent: event,
      ...(safeData ?? {}),
    })
  }

  return {
    info: (event, data) => log('info', event, data),
    warn: (event, data) => log('warn', event, data),
    error: (event, data) => log('error', event, data),
  }
}

export function allocateUniqueSessionId(
  source: SessionSource,
  options: AllocateUniqueSessionIdOptions = {},
): string {
  for (let attempt = 0; attempt < 16; attempt++) {
    const id = generateSessionId(source)
    if (!options.isReserved?.(id) && !options.sessionDb?.getSession(id)) {
      return id
    }
  }

  throw new Error(`Unable to allocate unique session ID for source "${source}" after 16 attempts.`)
}

export function deriveNextTurnIndex(options: {
  sessionId: string
  messages: Message[]
  observability?: ObservabilityStore
}): number {
  const maxLoggedTurnIndex = findMaxLoggedTurnIndex(
    options.observability?.readSessionRequests(options.sessionId) ?? [],
  )
  if (maxLoggedTurnIndex > 0) {
    return maxLoggedTurnIndex + 1
  }

  return countRecoverableUserTurns(options.messages) + 1
}

function filterLogData(
  data: Record<string, unknown> | undefined,
  secretFilter?: SecretFilter,
): Record<string, unknown> | undefined {
  if (!data) return undefined
  const filtered = filterLogValue(data, secretFilter)
  return filtered && typeof filtered === 'object' && !Array.isArray(filtered)
    ? (filtered as Record<string, unknown>)
    : undefined
}

function filterLogValue(value: unknown, secretFilter?: SecretFilter): unknown {
  if (typeof value === 'string') {
    return secretFilter ? secretFilter.filter(value) : value
  }

  if (Array.isArray(value)) {
    return value.map((item) => filterLogValue(item, secretFilter))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nestedValue]) => [
        key,
        filterLogValue(nestedValue, secretFilter),
      ]),
    )
  }

  return value
}

function findMaxLoggedTurnIndex(entries: RequestLogEntry[]): number {
  return entries.reduce((max, entry) => {
    return Number.isFinite(entry.turnIndex) ? Math.max(max, entry.turnIndex) : max
  }, 0)
}

function countRecoverableUserTurns(messages: Message[]): number {
  return messages.filter((message) => isTopLevelUserTurn(message)).length
}
