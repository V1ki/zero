import type { SessionSource } from '../types/session'

export const SESSION_SOURCE_ABBREVIATIONS = {
  web: 'web',
  feishu: 'fei',
  telegram: 'tel',
  scheduler: 'sch',
  weixin: 'wxi',
} as const

export type SessionSourceAbbreviation =
  | (typeof SESSION_SOURCE_ABBREVIATIONS)[SessionSource]
  | 'brw'
  | 'leg'

const DATED_SESSION_ID_RE = /^sess_(\d{8})_(\d{4})_([a-z]{3})_([0-9a-f]{4})$/

export interface SessionIdParts {
  layout: 'dated'
  dateStamp: string
  timeStamp: string
  sourceCode: SessionSourceAbbreviation
  random: string
}

/**
 * Generate a UUIDv7 (time-ordered) using Bun's built-in generator.
 */
export function generateId(): string {
  return Bun.randomUUIDv7()
}

/**
 * Generate a prefixed ID for specific entity types.
 */
export function generatePrefixedId(prefix: string): string {
  const uuid = generateId()
  return `${prefix}_${uuid}`
}

/**
 * Format a Date into the local-time pieces used by session IDs and log folders.
 */
export function formatLocalSessionDateParts(date = new Date()): {
  dateStamp: string
  timeStamp: string
  dateDirectory: string
} {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')

  return {
    dateStamp: `${year}${month}${day}`,
    timeStamp: `${hours}${minutes}`,
    dateDirectory: `${year}-${month}-${day}`,
  }
}

export function sessionSourceToAbbreviation(
  source: SessionSource | 'browser',
): SessionSourceAbbreviation {
  if (source === 'browser') {
    return 'brw'
  }
  return SESSION_SOURCE_ABBREVIATIONS[source]
}

export function buildSessionId(
  sourceCode: SessionSourceAbbreviation,
  date = new Date(),
  randomSegment = randomHex(4),
): string {
  const { dateStamp, timeStamp } = formatLocalSessionDateParts(date)
  return `sess_${dateStamp}_${timeStamp}_${sourceCode}_${randomSegment.toLowerCase()}`
}

/**
 * Generate a session ID with local date, time, and source prefix.
 */
export function generateSessionId(source: SessionSource): string {
  return buildSessionId(sessionSourceToAbbreviation(source))
}

export function parseSessionId(sessionId: string): SessionIdParts | null {
  const datedMatch = sessionId.match(DATED_SESSION_ID_RE)
  if (datedMatch) {
    return {
      layout: 'dated',
      dateStamp: datedMatch[1],
      timeStamp: datedMatch[2],
      sourceCode: datedMatch[3] as SessionSourceAbbreviation,
      random: datedMatch[4],
    }
  }

  return null
}

export function getSessionDateDirectory(sessionId: string): string | null {
  const parsed = parseSessionId(sessionId)
  if (!parsed) return null

  return `${parsed.dateStamp.slice(0, 4)}-${parsed.dateStamp.slice(4, 6)}-${parsed.dateStamp.slice(6, 8)}`
}

export function getSessionLogRelativeDir(sessionId: string): string {
  const dateDirectory = getSessionDateDirectory(sessionId)
  if (!dateDirectory) {
    return `sessions/${sessionId}`
  }

  return `sessions/${dateDirectory}/${sessionId}`
}

function randomHex(length: number): string {
  const uuid = Bun.randomUUIDv7().replace(/-/g, '')
  return uuid.slice(-length)
}
