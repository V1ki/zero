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

export class ModelPoolAdapter implements ProviderAdapter {
  readonly apiType = 'model_pool'
  private readonly selector: ModelPoolMemberSelector

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

    while (excluded.size < this.members.length) {
      const member = await this.selector.select(req, excluded)
      if (!member) break

      try {
        const response = await member.adapter.complete(this.forMember(req))
        this.health.markHealthy(member.providerName, member.modelName)
        return response
      } catch (error) {
        lastError = error
        const failure = classifyPoolFailure(error)
        if (!failure) throw error
        await this.markMemberFailure(member, failure, error)
        excluded.add(member.label)
      }
    }

    throw (
      lastError ??
      createNoAvailableModelPoolProvidersError(this.logicalLabel, this.members, this.health)
    )
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const excluded = new Set<string>()
    let lastError: unknown

    while (excluded.size < this.members.length) {
      const member = await this.selector.select(req, excluded)
      if (!member) break
      let yielded = false

      try {
        for await (const event of member.adapter.stream(this.forMember(req))) {
          yielded = true
          yield event
        }
        this.health.markHealthy(member.providerName, member.modelName)
        return
      } catch (error) {
        lastError = error
        const failure = classifyPoolFailure(error)
        if (!failure || yielded) throw error
        await this.markMemberFailure(member, failure, error)
        excluded.add(member.label)
      }
    }

    throw (
      lastError ??
      createNoAvailableModelPoolProvidersError(this.logicalLabel, this.members, this.health)
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
      if (this.options.sticky) {
        this.stickyMembers.set(stickyKey, member.label)
      }
      this.options.onMemberSelected?.({ logicalLabel: this.logicalLabel, sessionId, member })
      return member
    }

    return undefined
  }

  sortedMembers(): ModelPoolAdapterMember[] {
    return sortModelPoolMembers(this.members)
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

function classifyPoolFailure(error: unknown): RetryablePoolFailure | undefined {
  const status = errorStatus(error)
  const message = getPoolFailureMessage(error).toLowerCase()

  if (
    status === 429 ||
    message.includes('rate limit') ||
    message.includes('usage limit') ||
    message.includes('quota') ||
    message.includes('exhausted') ||
    message.includes('too many requests')
  ) {
    return 'quota_limited'
  }

  if (status === 401 || status === 403 || isAuthFailureMessage(message)) {
    return 'auth_error'
  }

  if ((status && status >= 500) || message.includes('temporarily unavailable')) {
    return 'temporary_unavailable'
  }

  return undefined
}

function getPoolFailureMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

function getPoolFailureEvidence(error: unknown): Record<string, unknown> {
  return {
    status: errorStatus(error),
    message: getPoolFailureMessage(error).slice(0, 500),
  }
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
