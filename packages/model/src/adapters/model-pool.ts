import type { CompletionRequest, CompletionResponse, StreamEvent } from '@zero-os/shared'
import type { ProviderHealthRegistry } from '../provider-health'
import type { ProviderHealthRecord } from '../provider-health'
import type { ProviderAdapter } from './base'

export interface ModelPoolAdapterMember {
  label: string
  providerName: string
  modelName: string
  adapter: ProviderAdapter
  priority: number
}

export interface ModelPoolAdapterOptions {
  sticky: boolean
  quotaAware: boolean
  onMemberSelected?: (event: {
    logicalLabel: string
    sessionId?: string
    member: ModelPoolAdapterMember
  }) => void
  onMemberFailed?: (event: {
    logicalLabel: string
    member: ModelPoolAdapterMember
    failure: RetryablePoolFailure
    record?: ProviderHealthRecord
    error: unknown
  }) => void
}

type RetryablePoolFailure = 'quota_limited' | 'auth_error' | 'temporary_unavailable'
type PoolFailure = RetryablePoolFailure | 'transport_retryable'

export class ModelPoolAdapter implements ProviderAdapter {
  readonly apiType = 'model_pool'
  private readonly selector: ModelPoolMemberSelector

  get supportsNonStreamingFallback(): boolean {
    return this.members.every((member) => member.adapter.supportsNonStreamingFallback !== false)
  }

  constructor(
    private readonly logicalLabel: string,
    private readonly members: ModelPoolAdapterMember[],
    private readonly health: ProviderHealthRegistry,
    private readonly options: ModelPoolAdapterOptions,
  ) {
    this.selector = new ModelPoolMemberSelector(logicalLabel, members, health, options)
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const excluded = new Set<string>()
    let lastError: unknown
    let attemptedMembers = 0

    while (excluded.size < this.members.length) {
      const member = await this.selector.select(req, excluded)
      if (!member) break
      attemptedMembers++

      try {
        const response = await member.adapter.complete(this.forMember(req))
        this.health.markHealthy(member.providerName, member.modelName)
        this.selector.markSuccessful(req, member)
        return response
      } catch (error) {
        lastError = error
        const failure = classifyPoolFailure(error)
        if (!failure) throw error
        if (failure !== 'transport_retryable') {
          await this.markMemberFailure(member, failure, error)
        }
        excluded.add(member.label)
      }
    }

    throw resolveExhaustedModelPoolError(
      lastError,
      this.logicalLabel,
      this.members,
      this.health,
      attemptedMembers,
    )
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const excluded = new Set<string>()
    let lastError: unknown
    let attemptedMembers = 0

    while (excluded.size < this.members.length) {
      const member = await this.selector.select(req, excluded)
      if (!member) break
      attemptedMembers++
      let yielded = false

      try {
        for await (const event of member.adapter.stream(this.forMember(req))) {
          yielded = true
          yield event
        }
        this.health.markHealthy(member.providerName, member.modelName)
        this.selector.markSuccessful(req, member)
        return
      } catch (error) {
        lastError = error
        const failure = classifyPoolFailure(error)
        if (!failure) throw error
        if (failure !== 'transport_retryable') {
          await this.markMemberFailure(member, failure, error)
        }
        if (yielded) throw error
        excluded.add(member.label)
      }
    }

    throw resolveExhaustedModelPoolError(
      lastError,
      this.logicalLabel,
      this.members,
      this.health,
      attemptedMembers,
    )
  }

  async healthCheck(): Promise<boolean> {
    for (const member of this.selector.sortedMembers()) {
      if (!(await this.health.isAvailable(member.providerName, member.modelName))) continue
      try {
        if (await member.adapter.healthCheck()) return true
      } catch {}
    }
    return false
  }

  private forMember(req: CompletionRequest): CompletionRequest {
    return { ...req, model: undefined }
  }

  private async markMemberFailure(
    member: ModelPoolAdapterMember,
    failure: RetryablePoolFailure,
    error: unknown,
  ) {
    const record = await markModelPoolMemberFailure(this.health, member, failure, error)

    this.options.onMemberFailed?.({
      logicalLabel: this.logicalLabel,
      member,
      failure,
      record,
      error,
    })
  }
}

class ModelPoolMemberSelector {
  private stickyMembers = new Map<string, string>()

  constructor(
    private readonly logicalLabel: string,
    private readonly members: ModelPoolAdapterMember[],
    private readonly health: ProviderHealthRegistry,
    private readonly options: Pick<
      ModelPoolAdapterOptions,
      'sticky' | 'quotaAware' | 'onMemberSelected'
    >,
  ) {}

  async select(
    req: CompletionRequest,
    excluded: Set<string>,
  ): Promise<ModelPoolAdapterMember | undefined> {
    const sessionId = req.meta?.sessionId
    const stickyKey = sessionId ?? '__global__'

    if (this.options.sticky) {
      const stickyLabel = this.stickyMembers.get(stickyKey)
      const stickyMember = stickyLabel
        ? this.members.find((member) => member.label === stickyLabel)
        : undefined
      if (
        stickyMember &&
        !excluded.has(stickyMember.label) &&
        (await this.isAvailable(stickyMember))
      ) {
        return stickyMember
      }
    }

    for (const member of this.sortedMembers()) {
      if (excluded.has(member.label)) continue
      if (!(await this.isAvailable(member))) continue
      this.options.onMemberSelected?.({ logicalLabel: this.logicalLabel, sessionId, member })
      return member
    }

    return undefined
  }

  sortedMembers(): ModelPoolAdapterMember[] {
    return sortModelPoolMembers(this.members)
  }

  markSuccessful(req: CompletionRequest, member: ModelPoolAdapterMember): void {
    if (!this.options.sticky) return
    this.stickyMembers.set(req.meta?.sessionId ?? '__global__', member.label)
  }

  private async isAvailable(member: ModelPoolAdapterMember): Promise<boolean> {
    if (!this.options.quotaAware) return true
    return await this.health.isAvailable(member.providerName, member.modelName)
  }
}

function createNoAvailableModelPoolProvidersError(
  logicalLabel: string,
  members: readonly ModelPoolAdapterMember[],
  health: ProviderHealthRegistry,
): Error {
  const details = sortModelPoolMembers(members)
    .map((member) => {
      const record = health.get(member.providerName, member.modelName)
      if (!record) return `${member.label}: unavailable`
      const reason = record.reason ? `: ${truncate(record.reason, 220)}` : ''
      const cooldown = record.cooldownUntil
        ? ` until ${new Date(record.cooldownUntil).toISOString()}`
        : ''
      return `${member.label}: ${record.state}${cooldown}${reason}`
    })
    .join('; ')
  return new Error(
    `No available providers for model pool ${logicalLabel}${details ? ` (${details})` : ''}`,
  )
}

function resolveExhaustedModelPoolError(
  lastError: unknown,
  logicalLabel: string,
  members: readonly ModelPoolAdapterMember[],
  health: ProviderHealthRegistry,
  attemptedMembers: number,
): unknown {
  if (lastError === undefined) {
    return createNoAvailableModelPoolProvidersError(logicalLabel, members, health)
  }
  if (attemptedMembers <= 1) return lastError
  return markPoolAttemptExhausted(lastError)
}

function markPoolAttemptExhausted(error: unknown): unknown {
  const metadata = { outer_retryable: false, pool_exhausted: true }
  if (error && typeof error === 'object') {
    try {
      return Object.assign(error, metadata)
    } catch {
      // Fall through to a wrapper when an adapter exposes a frozen error object.
    }
  }
  return Object.assign(new Error(getPoolFailureMessage(error), { cause: error }), metadata)
}

async function markModelPoolMemberFailure(
  health: ProviderHealthRegistry,
  member: ModelPoolAdapterMember,
  failure: RetryablePoolFailure,
  error: unknown,
): Promise<ProviderHealthRecord> {
  if (failure === 'quota_limited') {
    return await health.markQuotaLimited({
      providerName: member.providerName,
      modelName: member.modelName,
      reason: getPoolFailureMessage(error),
      evidence: getPoolFailureEvidence(error),
    })
  }

  if (failure === 'auth_error') {
    return health.markAuthError({
      providerName: member.providerName,
      modelName: member.modelName,
      reason: getPoolFailureMessage(error),
      evidence: getPoolFailureEvidence(error),
    })
  }

  return health.markTemporaryUnavailable({
    providerName: member.providerName,
    modelName: member.modelName,
    reason: getPoolFailureMessage(error),
    evidence: getPoolFailureEvidence(error),
  })
}

function sortModelPoolMembers(
  members: readonly ModelPoolAdapterMember[],
): ModelPoolAdapterMember[] {
  return [...members].sort((left, right) => left.priority - right.priority)
}

function classifyPoolFailure(error: unknown): PoolFailure | undefined {
  const status = errorStatus(error)
  const message = getPoolFailureMessage(error).toLowerCase()
  const errorType = getErrorStringProperty(error, 'error_type')?.toLowerCase()
  const failureScope = getErrorStringProperty(error, 'failure_scope')

  if (status === 429 || isQuotaFailureType(errorType)) {
    return 'quota_limited'
  }

  if (status === 401 || status === 403 || isAuthFailureType(errorType)) {
    return 'auth_error'
  }

  if (failureScope === 'request') return undefined
  if (isStructuredFailureScope(error, 'transport')) return 'transport_retryable'
  if (isStructuredFailureScope(error, 'provider') || status === 408 || (status && status >= 500)) {
    return 'temporary_unavailable'
  }

  if (isQuotaFailureMessage(message)) return 'quota_limited'
  if (isAuthFailureMessage(message)) return 'auth_error'
  if (message.includes('temporarily unavailable')) return 'temporary_unavailable'

  return undefined
}

function getPoolFailureMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

function getPoolFailureEvidence(error: unknown): Record<string, unknown> {
  return {
    status: errorStatus(error),
    retryable: isStructuredRetryableError(error),
    errorType: getErrorStringProperty(error, 'error_type'),
    failureScope: getErrorStringProperty(error, 'failure_scope'),
    code: getErrorStringProperty(error, 'code'),
    requestId:
      getErrorStringProperty(error, 'request_id') ?? getErrorStringProperty(error, 'requestId'),
    message: getPoolFailureMessage(error).slice(0, 500),
  }
}

function isStructuredRetryableError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as { retryable?: unknown }).retryable === true,
  )
}

function isStructuredFailureScope(error: unknown, scope: 'provider' | 'transport'): boolean {
  if (!isStructuredRetryableError(error)) return false
  return getErrorStringProperty(error, 'failure_scope') === scope
}

function isQuotaFailureType(errorType?: string): boolean {
  return Boolean(
    errorType &&
      [
        'insufficient_quota',
        'quota_exceeded',
        'rate_limit_exceeded',
        'too_many_requests',
        'usage_limit_reached',
      ].includes(errorType),
  )
}

function isAuthFailureType(errorType?: string): boolean {
  return Boolean(
    errorType &&
      [
        'authentication_error',
        'invalid_api_key',
        'invalid_authentication',
        'permission_denied',
      ].includes(errorType),
  )
}

function isQuotaFailureMessage(message: string): boolean {
  return (
    message.includes('rate limit') ||
    message.includes('usage limit') ||
    message.includes('quota') ||
    message.includes('exhausted') ||
    message.includes('too many requests')
  )
}

function getErrorStringProperty(error: unknown, key: string): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = (error as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function isAuthFailureMessage(message: string): boolean {
  return (
    message.includes('reauthenticate') ||
    message.includes('re-authenticate') ||
    message.includes('reauthentication') ||
    message.includes('re-authentication') ||
    message.includes('can no longer be refreshed') ||
    message.includes('invalid_grant') ||
    message.includes('refresh token') ||
    message.includes('oauth credentials not found') ||
    message.includes('credentials not found')
  )
}

function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const typed = error as { status?: unknown; response?: { status?: unknown } }
    const status = typed.status ?? typed.response?.status
    if (typeof status === 'number') return status
  }

  const match = getPoolFailureMessage(error).match(/\b([45]\d{2})\b/)
  return match ? Number(match[1]) : undefined
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}
