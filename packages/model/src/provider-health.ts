export type ProviderHealthState =
  | 'healthy'
  | 'degraded'
  | 'quota_limited'
  | 'auth_error'
  | 'temporary_unavailable'
  | 'probing'

export interface ProviderHealthRecord {
  providerName: string
  modelName?: string
  state: ProviderHealthState
  reason?: string
  cooldownUntil?: number
  updatedAt: number
  evidence?: Record<string, unknown>
}

export interface ProviderRecoveryHint {
  state?: ProviderHealthState
  cooldownUntil?: number
  reason?: string
  evidence?: Record<string, unknown>
}

export type ProviderRecoveryResolver = (params: {
  providerName: string
  modelName?: string
  reason: ProviderHealthState
}) => Promise<ProviderRecoveryHint | undefined>

const DEFAULT_QUOTA_COOLDOWN_MS = 5 * 60_000
const DEFAULT_TEMPORARY_COOLDOWN_MS = 60_000
const DEFAULT_AUTH_RECHECK_MS = 60_000

export class ProviderHealthRegistry {
  private records = new Map<string, ProviderHealthRecord>()
  private probes = new Map<string, Promise<void>>()
  private recoveryResolver?: ProviderRecoveryResolver

  constructor(options: { recoveryResolver?: ProviderRecoveryResolver } = {}) {
    this.recoveryResolver = options.recoveryResolver
  }

  setRecoveryResolver(recoveryResolver?: ProviderRecoveryResolver): void {
    this.recoveryResolver = recoveryResolver
  }

  list(): ProviderHealthRecord[] {
    return Array.from(this.records.values()).sort((left, right) =>
      `${left.providerName}/${left.modelName ?? '*'}`.localeCompare(
        `${right.providerName}/${right.modelName ?? '*'}`,
      ),
    )
  }

  get(providerName: string, modelName?: string): ProviderHealthRecord | undefined {
    return this.getEffectiveRecord(providerName, modelName)
  }

  async isAvailable(providerName: string, modelName?: string): Promise<boolean> {
    await this.refreshIfReady(providerName, modelName)
    const record = this.getEffectiveRecord(providerName, modelName)
    if (!record) return true
    if (record.state === 'healthy' || record.state === 'degraded') return true
    return Boolean(record.cooldownUntil && record.cooldownUntil <= Date.now())
  }

  markHealthy(providerName: string, modelName?: string, evidence?: Record<string, unknown>): void {
    this.records.set(this.key(providerName, modelName), {
      providerName,
      modelName,
      state: 'healthy',
      updatedAt: Date.now(),
      evidence,
    })
  }

  async markQuotaLimited(params: {
    providerName: string
    modelName?: string
    reason?: string
    evidence?: Record<string, unknown>
  }): Promise<ProviderHealthRecord> {
    const hint = await this.resolveRecoveryHint(
      params.providerName,
      params.modelName,
      'quota_limited',
    )
    return this.markLimited({
      providerName: params.providerName,
      modelName: params.modelName,
      state: hint?.state === 'healthy' ? 'healthy' : 'quota_limited',
      reason: hint?.reason ?? params.reason,
      cooldownUntil: hint?.cooldownUntil ?? Date.now() + DEFAULT_QUOTA_COOLDOWN_MS,
      evidence: hint?.evidence ?? params.evidence,
    })
  }

  markTemporaryUnavailable(params: {
    providerName: string
    modelName?: string
    reason?: string
    cooldownMs?: number
    evidence?: Record<string, unknown>
  }): ProviderHealthRecord {
    return this.markLimited({
      providerName: params.providerName,
      modelName: params.modelName,
      state: 'temporary_unavailable',
      reason: params.reason,
      cooldownUntil: Date.now() + (params.cooldownMs ?? DEFAULT_TEMPORARY_COOLDOWN_MS),
      evidence: params.evidence,
    })
  }

  markAuthError(params: {
    providerName: string
    modelName?: string
    reason?: string
    cooldownMs?: number
    evidence?: Record<string, unknown>
  }): ProviderHealthRecord {
    return this.markLimited({
      providerName: params.providerName,
      modelName: params.modelName,
      state: 'auth_error',
      reason: params.reason,
      cooldownUntil: Date.now() + (params.cooldownMs ?? DEFAULT_AUTH_RECHECK_MS),
      evidence: params.evidence,
    })
  }

  markAuthRecovered(providerName: string, evidence?: Record<string, unknown>): number {
    const providerKey = this.key(providerName)
    const providerRecord = this.records.get(providerKey)
    let cleared = 0

    for (const [key, record] of this.records) {
      if (record.providerName === providerName && record.state === 'auth_error') {
        this.records.delete(key)
        cleared++
      }
    }

    if (!providerRecord || providerRecord.state === 'auth_error') {
      this.markHealthy(providerName, undefined, evidence)
    }

    return cleared
  }

  private markLimited(params: {
    providerName: string
    modelName?: string
    state: ProviderHealthState
    reason?: string
    cooldownUntil?: number
    evidence?: Record<string, unknown>
  }): ProviderHealthRecord {
    const record: ProviderHealthRecord = {
      providerName: params.providerName,
      modelName: params.modelName,
      state: params.state,
      reason: params.reason,
      cooldownUntil: params.cooldownUntil,
      updatedAt: Date.now(),
      evidence: params.evidence,
    }
    this.records.set(this.key(params.providerName, params.modelName), record)
    return record
  }

  private async refreshIfReady(providerName: string, modelName?: string): Promise<void> {
    const record = this.getEffectiveRecord(providerName, modelName)
    if (!record?.cooldownUntil || record.cooldownUntil > Date.now()) return
    if (record.state === 'healthy' || record.state === 'degraded') return

    const key = this.key(record.providerName, record.modelName)
    const existing = this.probes.get(key)
    if (existing) return existing

    const probe = this.probe(record).finally(() => {
      if (this.probes.get(key) === probe) {
        this.probes.delete(key)
      }
    })
    this.probes.set(key, probe)
    return probe
  }

  private async probe(record: ProviderHealthRecord): Promise<void> {
    this.records.set(this.key(record.providerName, record.modelName), {
      ...record,
      state: 'probing',
      updatedAt: Date.now(),
    })

    const hint = await this.resolveRecoveryHint(record.providerName, record.modelName, record.state)
    if (
      !hint ||
      hint.state === 'healthy' ||
      !hint.cooldownUntil ||
      hint.cooldownUntil <= Date.now()
    ) {
      this.markHealthy(record.providerName, record.modelName, hint?.evidence)
      return
    }

    this.markLimited({
      providerName: record.providerName,
      modelName: record.modelName,
      state: hint.state ?? record.state,
      reason: hint.reason ?? record.reason,
      cooldownUntil: hint.cooldownUntil,
      evidence: hint.evidence ?? record.evidence,
    })
  }

  private async resolveRecoveryHint(
    providerName: string,
    modelName: string | undefined,
    reason: ProviderHealthState,
  ): Promise<ProviderRecoveryHint | undefined> {
    try {
      return await this.recoveryResolver?.({ providerName, modelName, reason })
    } catch {
      return undefined
    }
  }

  private getEffectiveRecord(
    providerName: string,
    modelName?: string,
  ): ProviderHealthRecord | undefined {
    const modelRecord = modelName ? this.records.get(this.key(providerName, modelName)) : undefined
    const providerRecord = this.records.get(this.key(providerName))
    if (!modelRecord) return providerRecord
    if (!providerRecord) return modelRecord

    const modelCooldown = modelRecord.cooldownUntil ?? 0
    const providerCooldown = providerRecord.cooldownUntil ?? 0
    return providerCooldown > modelCooldown ? providerRecord : modelRecord
  }

  private key(providerName: string, modelName?: string): string {
    return modelName ? `${providerName}/${modelName}` : `${providerName}/*`
  }
}
