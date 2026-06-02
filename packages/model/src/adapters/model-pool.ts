import type { CompletionRequest, CompletionResponse, StreamEvent } from '@zero-os/shared'
import type {
  ProviderHealthRecord,
  ProviderHealthRegistry,
  ProviderHealthState,
} from '../provider-health'
import type { ProviderAdapter } from './base'

export interface ModelPoolAdapterMember {
  label: string
  providerName: string
  modelName: string
  adapter: ProviderAdapter
  priority: number
}

type RetryablePoolFailure = 'quota_limited' | 'auth_error' | 'temporary_unavailable'

export class ModelPoolAdapter implements ProviderAdapter {
  readonly apiType = 'model_pool'
  private stickyMembers = new Map<string, string>()

  constructor(
    private readonly logicalLabel: string,
    private readonly members: ModelPoolAdapterMember[],
    private readonly health: ProviderHealthRegistry,
    private readonly options: {
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
    },
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const excluded = new Set<string>()
    let lastError: unknown

    while (excluded.size < this.members.length) {
      const member = await this.selectMember(req, excluded)
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

    throw lastError ?? new Error(`No available providers for model pool ${this.logicalLabel}`)
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const excluded = new Set<string>()
    let lastError: unknown

    while (excluded.size < this.members.length) {
      const member = await this.selectMember(req, excluded)
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

    throw lastError ?? new Error(`No available providers for model pool ${this.logicalLabel}`)
  }

  async healthCheck(): Promise<boolean> {
    for (const member of this.sortedMembers()) {
      if (!(await this.health.isAvailable(member.providerName, member.modelName))) continue
      try {
        if (await member.adapter.healthCheck()) return true
      } catch {}
    }
    return false
  }

  private async selectMember(
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
        (await this.isMemberAvailable(stickyMember))
      ) {
        return stickyMember
      }
    }

    for (const member of this.sortedMembers()) {
      if (excluded.has(member.label)) continue
      if (!(await this.isMemberAvailable(member))) continue
      if (this.options.sticky) {
        this.stickyMembers.set(stickyKey, member.label)
      }
      this.options.onMemberSelected?.({ logicalLabel: this.logicalLabel, sessionId, member })
      return member
    }

    return undefined
  }

  private async isMemberAvailable(member: ModelPoolAdapterMember): Promise<boolean> {
    if (!this.options.quotaAware) return true
    return await this.health.isAvailable(member.providerName, member.modelName)
  }

  private sortedMembers(): ModelPoolAdapterMember[] {
    return [...this.members].sort((left, right) => left.priority - right.priority)
  }

  private forMember(req: CompletionRequest): CompletionRequest {
    return { ...req, model: undefined }
  }

  private async markMemberFailure(
    member: ModelPoolAdapterMember,
    failure: RetryablePoolFailure,
    error: unknown,
  ) {
    let record: ProviderHealthRecord | undefined
    if (failure === 'quota_limited') {
      record = await this.health.markQuotaLimited({
        providerName: member.providerName,
        modelName: member.modelName,
        reason: errorMessage(error),
        evidence: errorEvidence(error),
      })
    } else if (failure === 'auth_error') {
      record = this.health.markAuthError({
        providerName: member.providerName,
        modelName: member.modelName,
        reason: errorMessage(error),
        evidence: errorEvidence(error),
      })
    } else {
      record = this.health.markTemporaryUnavailable({
        providerName: member.providerName,
        modelName: member.modelName,
        reason: errorMessage(error),
        evidence: errorEvidence(error),
      })
    }

    this.options.onMemberFailed?.({
      logicalLabel: this.logicalLabel,
      member,
      failure,
      record,
      error,
    })
  }
}

export function classifyProviderFailureState(error: unknown): ProviderHealthState | undefined {
  const failure = classifyPoolFailure(error)
  return failure
}

function classifyPoolFailure(error: unknown): RetryablePoolFailure | undefined {
  const status = errorStatus(error)
  const message = errorMessage(error).toLowerCase()

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

  const match = errorMessage(error).match(/\b([45]\d{2})\b/)
  return match ? Number(match[1]) : undefined
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

function errorEvidence(error: unknown): Record<string, unknown> {
  return {
    status: errorStatus(error),
    message: errorMessage(error).slice(0, 500),
  }
}
