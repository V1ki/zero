export const SOURCE_CARD_STATES = ['draft', 'active', 'retired'] as const

export type SourceCardState = (typeof SOURCE_CARD_STATES)[number]

export const SOURCE_CARD_STATE_TRANSITIONS = {
  draft: ['active', 'retired'],
  active: ['retired'],
  retired: [],
} satisfies Record<SourceCardState, readonly SourceCardState[]>

export interface SourceCardDocument {
  format: 'markdown'
  body: string
}

export interface SourceCardSourceRef {
  sessionId?: string
  traceRefs?: string[]
  artifactRefs?: string[]
  summary?: string
}

export interface SourceCard {
  schemaVersion: 1
  id: string
  title: string
  state: SourceCardState
  sensitivity: 'public' | 'internal' | 'private' | 'restricted'
  tags?: string[]
  sourceDoc: SourceCardDocument
  source?: SourceCardSourceRef
  createdAt?: string
  updatedAt?: string
}

export interface SourceCardValidationResult {
  ok: boolean
  errors: string[]
}

interface SecretFilterLike {
  filter(text: string): string
}

const SOURCE_CARD_ID_RE = /^[a-z0-9][a-z0-9_-]*$/
const SENSITIVE_KEY_RE =
  /(authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|oauth|auth[_-]?code|credentialRef|credentialLeaseId)/i

export function validateSourceCard(value: unknown): SourceCardValidationResult {
  const errors: string[] = []
  const card = asRecord(value)

  if (!card) {
    return { ok: false, errors: ['SourceCard must be an object'] }
  }

  if (card.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  requireSourceCardId(card.id, 'id', errors)
  requireNonEmptyString(card.title, 'title', errors)
  requireEnum(card.state, SOURCE_CARD_STATES, 'state', errors)
  requireEnum(
    card.sensitivity,
    ['public', 'internal', 'private', 'restricted'] as const,
    'sensitivity',
    errors,
  )
  validateTags(card.tags, 'tags', errors)
  validateSourceDoc(card.sourceDoc, 'sourceDoc', errors)
  validateSourceRef(card.source, 'source', errors)

  return { ok: errors.length === 0, errors }
}

export function assertValidSourceCard(value: unknown): asserts value is SourceCard {
  const result = validateSourceCard(value)
  if (!result.ok) {
    throw new Error(`Invalid SourceCard: ${result.errors.join('; ')}`)
  }
}

export function isSafeSourceEntityId(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_CARD_ID_RE.test(value)
}

export function assertSafeSourceEntityId(value: unknown, path = 'id'): asserts value is string {
  if (!isSafeSourceEntityId(value)) {
    throw new Error(`${path} must be a lowercase id using letters, numbers, "_" or "-"`)
  }
}

export function canTransitionSourceCardState(from: SourceCardState, to: SourceCardState): boolean {
  const allowed = SOURCE_CARD_STATE_TRANSITIONS[from] as readonly SourceCardState[]
  return from === to || allowed.includes(to)
}

export function sanitizeSourceCardTraceEvidence<T>(value: T, secretFilter?: SecretFilterLike): T {
  return sanitizeTraceValue(value, undefined, secretFilter) as T
}

function validateSourceDoc(value: unknown, path: string, errors: string[]): void {
  const doc = asRecord(value)
  if (!doc) {
    errors.push(`${path} must be an object`)
    return
  }
  if (doc.format !== 'markdown') {
    errors.push(`${path}.format must be markdown`)
  }
  requireNonEmptyString(doc.body, `${path}.body`, errors)
  if (typeof doc.body === 'string' && containsSensitiveSourceDocMaterial(doc.body)) {
    errors.push(`${path}.body must not contain credential references or secret material`)
  }
}

function validateTags(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`)
    return
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push(`${path}[${index}] must be a non-empty string`)
    }
  }
}

function validateSourceRef(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return
  const source = asRecord(value)
  if (!source) {
    errors.push(`${path} must be an object`)
    return
  }
  if (source.sessionId !== undefined) {
    if (typeof source.sessionId !== 'string') {
      errors.push(`${path}.sessionId must be a string`)
    } else if (containsSensitiveSourceDocMaterial(source.sessionId)) {
      errors.push(`${path}.sessionId must not contain credential references or secret material`)
    }
  }
  validateOptionalStringArray(source.traceRefs, `${path}.traceRefs`, errors)
  validateOptionalStringArray(source.artifactRefs, `${path}.artifactRefs`, errors)
  if (source.summary !== undefined) {
    if (typeof source.summary !== 'string') {
      errors.push(`${path}.summary must be a string`)
    } else if (containsSensitiveSourceDocMaterial(source.summary)) {
      errors.push(`${path}.summary must not contain credential references or secret material`)
    }
  }
}

function validateOptionalStringArray(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`)
    return
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push(`${path}[${index}] must be a non-empty string`)
    } else if (containsSensitiveSourceDocMaterial(item)) {
      errors.push(`${path}[${index}] must not contain credential references or secret material`)
    }
  }
}

function containsSensitiveSourceDocMaterial(value: string): boolean {
  return (
    /Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]+/i.test(value) ||
    /\b(?:vault:\/\/|external:)[^\s`"')]+/i.test(value) ||
    /\b(?:authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]/i.test(
      value,
    )
  )
}

function requireSourceCardId(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== 'string' || !SOURCE_CARD_ID_RE.test(value)) {
    errors.push(`${path} must be a lowercase id using letters, numbers, "_" or "-"`)
  }
}

function requireNonEmptyString(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${path} must be a non-empty string`)
  }
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  candidates: T,
  path: string,
  errors: string[],
): void {
  if (!candidates.includes(value as T[number])) {
    errors.push(`${path} must be one of: ${candidates.join(', ')}`)
  }
}

function sanitizeTraceValue(
  value: unknown,
  key: string | undefined,
  secretFilter?: SecretFilterLike,
): unknown {
  if (typeof value === 'string') {
    if (key && SENSITIVE_KEY_RE.test(key)) return '[REDACTED]'
    const filtered = secretFilter ? secretFilter.filter(value) : value
    return redactInlineSensitiveText(filtered)
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTraceValue(item, key, secretFilter))
  }

  const record = asRecord(value)
  if (!record) return value

  return Object.fromEntries(
    Object.entries(record).map(([nestedKey, nestedValue]) => [
      nestedKey,
      sanitizeTraceValue(nestedValue, nestedKey, secretFilter),
    ]),
  )
}

function redactInlineSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /(authorization|cookie|password|token|secret|api[_-]?key)=([^&\s]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(
      /(authorization|cookie|password|token|secret|api[_-]?key):\s*([^\n]+)/gi,
      '$1: [REDACTED]',
    )
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
