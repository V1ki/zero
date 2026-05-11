export const SOURCE_CARD_STATES = [
  'discovered',
  'candidate',
  'verified',
  'active',
  'degraded',
  'broken',
  'retired',
] as const

export type SourceCardState = (typeof SOURCE_CARD_STATES)[number]

export const SOURCE_CARD_STATE_TRANSITIONS = {
  discovered: ['candidate', 'retired'],
  candidate: ['verified', 'broken', 'retired'],
  verified: ['active', 'candidate', 'broken', 'retired'],
  active: ['degraded', 'broken', 'retired'],
  degraded: ['active', 'verified', 'broken', 'retired'],
  broken: ['candidate', 'verified', 'retired'],
  retired: [],
} satisfies Record<SourceCardState, readonly SourceCardState[]>

export const SOURCE_CARD_ADAPTER_MODES = ['cli', 'api', 'browser', 'direct'] as const

export type SourceCardAdapterMode = (typeof SOURCE_CARD_ADAPTER_MODES)[number]

export const SOURCE_CARD_CREDENTIAL_BINDING_TYPES = ['vaultRef', 'externalStore', 'none'] as const

export type SourceCardCredentialBindingType = (typeof SOURCE_CARD_CREDENTIAL_BINDING_TYPES)[number]

export const SOURCE_CARD_FAILURE_CLASSES = [
  'auth',
  'schema',
  'rate_limit',
  'network',
  'stale',
  'privacy_blocked',
  'adapter_unavailable',
  'unknown',
] as const

export type SourceCardFailureClass = (typeof SOURCE_CARD_FAILURE_CLASSES)[number]

export const SOURCE_CARD_ACTIONS = ['notify', 'recordObservation', 'createArtifact'] as const

export type SourceCardAction = (typeof SOURCE_CARD_ACTIONS)[number]

export interface SourceCardOwner {
  scope: 'user' | 'workspace' | 'system'
  userRef?: string
}

export interface SourceCardDiscoveryRef {
  sessionId: string
  traceRefs: string[]
  artifactRefs?: string[]
}

export interface SourceCardDiscovery {
  firstSeenAt: string
  discoveredFrom: SourceCardDiscoveryRef
  learnedMethodSummary: string
}

export interface SourceCardCapability {
  id: string
  operation: 'list' | 'search' | 'read' | 'download' | 'query' | 'health_check'
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  watchable: boolean
  defaultPrivacyScope: string
  allowedActions: SourceCardAction[]
  prohibitedActions: string[]
}

export type SourceCardCredentialBinding =
  | {
      type: 'vaultRef'
      ref: string
    }
  | {
      type: 'externalStore'
      ref: string
    }
  | {
      type: 'none'
    }

export interface SourceCardCredential {
  id: string
  required: boolean
  binding: SourceCardCredentialBinding
  scopes: string[]
  injectAs: 'bearerHeader' | 'env' | 'stdin' | 'profileSession' | 'none'
  leasePolicy: {
    ttlSeconds: number
    renewable: boolean
    reauthRequiredOn: string[]
  }
}

export interface SourceCardAdapterRevision {
  id: string
  status: 'candidate' | 'active' | 'deprecated' | 'rolled_back'
  mode: SourceCardAdapterMode
  entrypoint: string
  commandTemplate?: string
  endpointTemplates?: string[]
  parser: {
    type: 'json' | 'html' | 'text' | 'csv' | 'custom'
    schemaKeys: string[]
  }
  timeoutMs: number
  rateLimit?: {
    minIntervalMs: number
    burst?: number
  }
  validation: {
    sampleQueries: Record<string, unknown>[]
    expectedEvidence: string[]
  }
}

export interface SourceCardAdapter {
  mode: SourceCardAdapterMode
  activeRevision: string
  revisions: SourceCardAdapterRevision[]
}

export interface SourceCardPrivacy {
  dataClasses: string[]
  bodyPolicy: 'metadata_only' | 'explicit_foreground_only' | 'approved_background_scope'
  attachmentPolicy: 'blocked' | 'explicit_foreground_only' | 'approved_background_scope'
  retention: {
    card: string
    observations: string
    artifacts: string
  }
}

export interface SourceCardHealthCheck {
  id: string
  cadence: 'on_use' | 'before_watch_tick' | 'hourly' | 'daily' | 'weekly' | 'manual'
  method: string
  successCriteria: string
}

export interface SourceCardHealthEvidence {
  sourceCardId?: string
  capabilityId?: string
  adapterRevision?: string
  credentialRef?: string
  credentialLeaseId?: string
  commandTemplateHash?: string
  endpointTemplateHash?: string
  statusCode?: number
  exitCode?: number
  durationMs?: number
  rowCount?: number
  schemaKeys?: string[]
  artifactRefs?: string[]
  failureClass?: SourceCardFailureClass
  message?: string
  details?: Record<string, unknown>
}

export interface SourceCardHealthResult {
  checkId: string
  status: 'passed' | 'failed'
  checkedAt: string
  failureClass?: SourceCardFailureClass
  evidence: SourceCardHealthEvidence
}

export interface SourceCardHealth {
  checks: SourceCardHealthCheck[]
  lastStatus?: 'healthy' | 'degraded' | 'broken'
  lastCheckedAt?: string
  failureClass?: SourceCardFailureClass
  lastResult?: SourceCardHealthResult
}

export interface SourceCardObservationContract {
  observationSchemaRef: string
  cursorPolicy: string
  maxSamplePersisted: number
  contentHashPolicy: string
}

export interface SourceCardPromotion {
  requiredEvidence: string[]
  approvedBy?: string
  approvedAt?: string
  reviewedCapabilityIds?: string[]
  privateScopeConfirmation?: {
    metadataOnly: boolean
    bodyAccessApproved: false
    attachmentAccessApproved: false
  }
  lastDecision?: 'accepted' | 'rejected'
  lastDecisionAt?: string
  decisionReason?: string
}

export interface SourceCard {
  schemaVersion: 1
  id: string
  title: string
  state: SourceCardState
  kind:
    | 'private_mailbox'
    | 'public_market_data'
    | 'web_api'
    | 'browser_session'
    | 'direct_protocol'
    | 'local_file'
  owner: SourceCardOwner
  sensitivity: 'public' | 'internal' | 'private' | 'restricted'
  createdAt?: string
  updatedAt?: string
  discovery: SourceCardDiscovery
  capabilities: SourceCardCapability[]
  adapter: SourceCardAdapter
  credentials: SourceCardCredential[]
  privacy: SourceCardPrivacy
  health: SourceCardHealth
  observations: SourceCardObservationContract
  promotion: SourceCardPromotion
}

export interface SourceObservation {
  id?: string
  sourceCardId: string
  capabilityId: string
  observedAt: string
  kind: 'data' | 'health_check' | 'schema_sample' | 'error'
  cursor?: string | Record<string, unknown>
  data?: Record<string, unknown>
  evidence?: SourceCardHealthEvidence
}

export interface SourceWatchBinding {
  id?: string
  sourceCardId: string
  capabilityId: string
  query?: Record<string, unknown>
  cursor?: string | Record<string, unknown>
  cadence: {
    type: 'manual' | 'interval' | 'cron'
    expression?: string
    minIntervalMs?: number
  }
  allowedActions?: SourceCardAction[]
}

export interface SourceCredentialLease {
  id: string
  sourceCardId: string
  credentialId: string
  credentialRef: string
  injectAs: SourceCardCredential['injectAs']
  scopes: string[]
  issuedAt: string
  expiresAt?: string
  renewable: boolean
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
  /(authorization|cookie|password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|oauth|auth[_-]?code)/i
const CREDENTIAL_REF_KEYS = new Set(['credentialRef', 'credentialLeaseId'])
const WATCH_FORBIDDEN_KEY_RE =
  /(credential|credentialRef|credentialLease|secret|token|cookie|password|authorization|apiKey)/i

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

  const capabilities = Array.isArray(card.capabilities) ? card.capabilities : undefined
  if (!capabilities || capabilities.length === 0) {
    errors.push('capabilities must contain at least one capability')
  } else {
    const ids = new Set<string>()
    for (const [index, capability] of capabilities.entries()) {
      const record = asRecord(capability)
      if (!record) {
        errors.push(`capabilities[${index}] must be an object`)
        continue
      }
      requireSourceCardId(record.id, `capabilities[${index}].id`, errors)
      if (typeof record.id === 'string') {
        if (ids.has(record.id)) errors.push(`duplicate capability id: ${record.id}`)
        ids.add(record.id)
      }
      if (typeof record.watchable !== 'boolean') {
        errors.push(`capabilities[${index}].watchable must be boolean`)
      }
      validateAllowedActions(record.allowedActions, `capabilities[${index}].allowedActions`, errors)
    }
  }

  const adapter = asRecord(card.adapter)
  if (!adapter) {
    errors.push('adapter must be an object')
  } else {
    requireEnum(adapter.mode, SOURCE_CARD_ADAPTER_MODES, 'adapter.mode', errors)
    requireNonEmptyString(adapter.activeRevision, 'adapter.activeRevision', errors)
    const revisions = Array.isArray(adapter.revisions) ? adapter.revisions : undefined
    if (!revisions || revisions.length === 0) {
      errors.push('adapter.revisions must contain at least one revision')
    } else {
      const activeRevision = revisions.find(
        (revision) =>
          asRecord(revision)?.id === adapter.activeRevision &&
          asRecord(revision)?.mode === adapter.mode,
      )
      if (!activeRevision) {
        errors.push('adapter.activeRevision must reference a revision with the same adapter mode')
      }
      for (const [index, revision] of revisions.entries()) {
        const record = asRecord(revision)
        if (!record) {
          errors.push(`adapter.revisions[${index}] must be an object`)
          continue
        }
        requireSourceCardId(record.id, `adapter.revisions[${index}].id`, errors)
        requireEnum(
          record.mode,
          SOURCE_CARD_ADAPTER_MODES,
          `adapter.revisions[${index}].mode`,
          errors,
        )
        requireNonEmptyString(record.entrypoint, `adapter.revisions[${index}].entrypoint`, errors)
        if (typeof record.timeoutMs !== 'number' || record.timeoutMs <= 0) {
          errors.push(`adapter.revisions[${index}].timeoutMs must be a positive number`)
        }
      }
    }
  }

  const credentials = Array.isArray(card.credentials) ? card.credentials : undefined
  if (!credentials) {
    errors.push('credentials must be an array')
  } else {
    for (const [index, credential] of credentials.entries()) {
      validateCredential(credential, `credentials[${index}]`, errors)
    }
  }

  const health = asRecord(card.health)
  if (!health) {
    errors.push('health must be an object')
  } else if (!Array.isArray(health.checks)) {
    errors.push('health.checks must be an array')
  }

  const observations = asRecord(card.observations)
  if (!observations) {
    errors.push('observations must be an object')
  } else {
    requireNonEmptyString(
      observations.observationSchemaRef,
      'observations.observationSchemaRef',
      errors,
    )
  }

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

export function validateSourceWatchBinding(
  value: unknown,
  sourceCard?: SourceCard,
): SourceCardValidationResult {
  const errors: string[] = []
  const binding = asRecord(value)
  if (!binding) return { ok: false, errors: ['SourceWatchBinding must be an object'] }

  requireSourceCardId(binding.sourceCardId, 'sourceCardId', errors)
  requireSourceCardId(binding.capabilityId, 'capabilityId', errors)

  if (containsForbiddenWatchKey(binding)) {
    errors.push('SourceWatchBinding must not contain credentials, tokens, cookies, or secrets')
  }

  if (!asRecord(binding.cadence)) {
    errors.push('cadence must be an object')
  }

  if (sourceCard) {
    if (binding.sourceCardId !== sourceCard.id) {
      errors.push('sourceCardId does not match the provided SourceCard')
    }
    if (sourceCard.state !== 'active') {
      errors.push('Watch can only consume an active SourceCard')
    }
    const capability = sourceCard.capabilities.find((item) => item.id === binding.capabilityId)
    if (!capability) {
      errors.push(`capability not found: ${String(binding.capabilityId)}`)
    } else if (!capability.watchable) {
      errors.push(`capability is not watchable: ${capability.id}`)
    }
  }

  return { ok: errors.length === 0, errors }
}

export function assertValidSourceWatchBinding(
  value: unknown,
  sourceCard?: SourceCard,
): asserts value is SourceWatchBinding {
  const result = validateSourceWatchBinding(value, sourceCard)
  if (!result.ok) {
    throw new Error(`Invalid SourceWatchBinding: ${result.errors.join('; ')}`)
  }
}

export function sanitizeSourceCardTraceEvidence<T>(value: T, secretFilter?: SecretFilterLike): T {
  return sanitizeTraceValue(value, undefined, secretFilter) as T
}

function validateCredential(value: unknown, path: string, errors: string[]): void {
  const credential = asRecord(value)
  if (!credential) {
    errors.push(`${path} must be an object`)
    return
  }

  requireSourceCardId(credential.id, `${path}.id`, errors)
  const binding = asRecord(credential.binding)
  if (!binding) {
    errors.push(`${path}.binding must be an object`)
    return
  }

  requireEnum(binding.type, SOURCE_CARD_CREDENTIAL_BINDING_TYPES, `${path}.binding.type`, errors)
  if (binding.type === 'vaultRef') {
    requireRefPrefix(binding.ref, `${path}.binding.ref`, 'vault://', errors)
  }
  if (binding.type === 'externalStore') {
    requireRefPrefix(binding.ref, `${path}.binding.ref`, 'external:', errors)
  }
  if (binding.type === 'none' && 'ref' in binding) {
    errors.push(`${path}.binding.ref must be omitted when type is none`)
  }
}

function validateAllowedActions(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`)
    return
  }
  for (const action of value) {
    if (!SOURCE_CARD_ACTIONS.includes(action as SourceCardAction)) {
      errors.push(`${path} contains unsupported action: ${String(action)}`)
    }
  }
}

function requireRefPrefix(value: unknown, path: string, prefix: string, errors: string[]): void {
  if (typeof value !== 'string' || !value.startsWith(prefix)) {
    errors.push(`${path} must start with ${prefix}`)
  }
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

function containsForbiddenWatchKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsForbiddenWatchKey(item))
  const record = asRecord(value)
  if (!record) return false
  for (const [key, nestedValue] of Object.entries(record)) {
    if (WATCH_FORBIDDEN_KEY_RE.test(key)) return true
    if (containsForbiddenWatchKey(nestedValue)) return true
  }
  return false
}

function sanitizeTraceValue(
  value: unknown,
  key: string | undefined,
  secretFilter?: SecretFilterLike,
): unknown {
  if (typeof value === 'string') {
    if (key && SENSITIVE_KEY_RE.test(key) && !CREDENTIAL_REF_KEYS.has(key)) {
      return '[REDACTED]'
    }
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
