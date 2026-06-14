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
  private probeRunner: ProviderHealthProbeRunner

  constructor(options: { recoveryResolver?: ProviderRecoveryResolver } = {}) {
    this.probeRunner = new ProviderHealthProbeRunner(this.records, options.recoveryResolver)
  }

  setRecoveryResolver(recoveryResolver?: ProviderRecoveryResolver): void {
    this.probeRunner.setRecoveryResolver(recoveryResolver)
  }

  list(): ProviderHealthRecord[] {
    return listProviderHealthRecords(this.records.values())
  }

  get(providerName: string, modelName?: string): ProviderHealthRecord | undefined {
    return this.getEffectiveRecord(providerName, modelName)
  }

  async isAvailable(providerName: string, modelName?: string): Promise<boolean> {
    await this.probeRunner.refreshIfReady(this.getEffectiveRecord(providerName, modelName))
    const record = this.getEffectiveRecord(providerName, modelName)
    if (!record) return true
    if (isAvailableProviderHealthState(record.state)) return true
    return Boolean(record.cooldownUntil && record.cooldownUntil <= Date.now())
  }

  markHealthy(providerName: string, modelName?: string, evidence?: Record<string, unknown>): void {
    this.saveRecord(
      createHealthyProviderHealthRecord({
        providerName,
        modelName,
        evidence,
      }),
    )
  }

  async markQuotaLimited(params: {
    providerName: string
    modelName?: string
    reason?: string
    evidence?: Record<string, unknown>
  }): Promise<ProviderHealthRecord> {
    const hint = await this.probeRunner.resolveRecoveryHint(
      params.providerName,
      params.modelName,
      'quota_limited',
    )
    return this.saveRecord(createQuotaLimitedProviderHealthRecord(params, hint))
  }

  markTemporaryUnavailable(params: {
    providerName: string
    modelName?: string
    reason?: string
    cooldownMs?: number
    evidence?: Record<string, unknown>
  }): ProviderHealthRecord {
    return this.saveRecord(createTemporaryUnavailableProviderHealthRecord(params))
  }

  markAuthError(params: {
    providerName: string
    modelName?: string
    reason?: string
    cooldownMs?: number
    evidence?: Record<string, unknown>
  }): ProviderHealthRecord {
    return this.saveRecord(createAuthErrorProviderHealthRecord(params))
  }

  markAuthRecovered(providerName: string, evidence?: Record<string, unknown>): number {
    const providerKey = providerHealthKey(providerName)
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

  private saveRecord(record: ProviderHealthRecord): ProviderHealthRecord {
    this.records.set(providerHealthKey(record.providerName, record.modelName), record)
    return record
  }

  private getEffectiveRecord(
    providerName: string,
    modelName?: string,
  ): ProviderHealthRecord | undefined {
    return getEffectiveProviderHealthRecord(this.records, providerName, modelName)
  }
}

class ProviderHealthProbeRunner {
  private probes = new Map<string, Promise<void>>()

  constructor(
    private readonly records: Map<string, ProviderHealthRecord>,
    private recoveryResolver?: ProviderRecoveryResolver,
  ) {}

  setRecoveryResolver(recoveryResolver?: ProviderRecoveryResolver): void {
    this.recoveryResolver = recoveryResolver
  }

  async refreshIfReady(record: ProviderHealthRecord | undefined): Promise<void> {
    if (!record?.cooldownUntil || record.cooldownUntil > Date.now()) return
    if (record.state === 'healthy' || record.state === 'degraded') return

    const key = providerHealthKey(record.providerName, record.modelName)
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

  async resolveRecoveryHint(
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

  private async probe(record: ProviderHealthRecord): Promise<void> {
    this.saveRecord(createProbingProviderHealthRecord(record))

    const hint = await this.resolveRecoveryHint(record.providerName, record.modelName, record.state)
    if (!hint || shouldRecoverProviderHealthToHealthy(hint)) {
      this.saveRecord(
        createHealthyProviderHealthRecord({
          providerName: record.providerName,
          modelName: record.modelName,
          evidence: hint?.evidence,
        }),
      )
      return
    }

    this.saveRecord(createProbeLimitedProviderHealthRecord(record, hint))
  }

  private saveRecord(record: ProviderHealthRecord): void {
    this.records.set(providerHealthKey(record.providerName, record.modelName), record)
  }
}

function providerHealthKey(providerName: string, modelName?: string): string {
  return modelName ? `${providerName}/${modelName}` : `${providerName}/*`
}

function createProviderHealthRecord(params: {
  providerName: string
  modelName?: string
  state: ProviderHealthState
  updatedAt: number
  reason?: string
  cooldownUntil?: number
  evidence?: Record<string, unknown>
}): ProviderHealthRecord {
  return {
    providerName: params.providerName,
    modelName: params.modelName,
    state: params.state,
    reason: params.reason,
    cooldownUntil: params.cooldownUntil,
    updatedAt: params.updatedAt,
    evidence: params.evidence,
  }
}

function listProviderHealthRecords(
  records: Iterable<ProviderHealthRecord>,
): ProviderHealthRecord[] {
  return Array.from(records).sort((left, right) =>
    `${left.providerName}/${left.modelName ?? '*'}`.localeCompare(
      `${right.providerName}/${right.modelName ?? '*'}`,
    ),
  )
}

function getEffectiveProviderHealthRecord(
  records: Map<string, ProviderHealthRecord>,
  providerName: string,
  modelName?: string,
): ProviderHealthRecord | undefined {
  const modelRecord = modelName
    ? records.get(providerHealthKey(providerName, modelName))
    : undefined
  const providerRecord = records.get(providerHealthKey(providerName))
  if (!modelRecord) return providerRecord
  if (!providerRecord) return modelRecord

  const modelCooldown = modelRecord.cooldownUntil ?? 0
  const providerCooldown = providerRecord.cooldownUntil ?? 0
  return providerCooldown > modelCooldown ? providerRecord : modelRecord
}

function isAvailableProviderHealthState(state: ProviderHealthState): boolean {
  return state === 'healthy' || state === 'degraded'
}

function createHealthyProviderHealthRecord(params: {
  providerName: string
  modelName?: string
  evidence?: Record<string, unknown>
}): ProviderHealthRecord {
  return createProviderHealthRecord({
    providerName: params.providerName,
    modelName: params.modelName,
    state: 'healthy',
    updatedAt: Date.now(),
    evidence: params.evidence,
  })
}

function createQuotaLimitedProviderHealthRecord(
  params: {
    providerName: string
    modelName?: string
    reason?: string
    evidence?: Record<string, unknown>
  },
  hint?: ProviderRecoveryHint,
): ProviderHealthRecord {
  return createLimitedProviderHealthRecord({
    providerName: params.providerName,
    modelName: params.modelName,
    state: hint?.state === 'healthy' ? 'healthy' : 'quota_limited',
    reason: hint?.reason ?? params.reason,
    cooldownUntil: hint?.cooldownUntil ?? Date.now() + DEFAULT_QUOTA_COOLDOWN_MS,
    evidence: hint?.evidence ?? params.evidence,
  })
}

function createTemporaryUnavailableProviderHealthRecord(params: {
  providerName: string
  modelName?: string
  reason?: string
  cooldownMs?: number
  evidence?: Record<string, unknown>
}): ProviderHealthRecord {
  return createLimitedProviderHealthRecord({
    providerName: params.providerName,
    modelName: params.modelName,
    state: 'temporary_unavailable',
    reason: params.reason,
    cooldownUntil: Date.now() + (params.cooldownMs ?? DEFAULT_TEMPORARY_COOLDOWN_MS),
    evidence: params.evidence,
  })
}

function createAuthErrorProviderHealthRecord(params: {
  providerName: string
  modelName?: string
  reason?: string
  cooldownMs?: number
  evidence?: Record<string, unknown>
}): ProviderHealthRecord {
  return createLimitedProviderHealthRecord({
    providerName: params.providerName,
    modelName: params.modelName,
    state: 'auth_error',
    reason: params.reason,
    cooldownUntil: Date.now() + (params.cooldownMs ?? DEFAULT_AUTH_RECHECK_MS),
    evidence: params.evidence,
  })
}

function createProbingProviderHealthRecord(record: ProviderHealthRecord): ProviderHealthRecord {
  return {
    ...record,
    state: 'probing',
    updatedAt: Date.now(),
  }
}

function shouldRecoverProviderHealthToHealthy(hint: ProviderRecoveryHint): boolean {
  return hint.state === 'healthy' || !hint.cooldownUntil || hint.cooldownUntil <= Date.now()
}

function createProbeLimitedProviderHealthRecord(
  record: ProviderHealthRecord,
  hint: ProviderRecoveryHint,
): ProviderHealthRecord {
  return createLimitedProviderHealthRecord({
    providerName: record.providerName,
    modelName: record.modelName,
    state: hint.state ?? record.state,
    reason: hint.reason ?? record.reason,
    cooldownUntil: hint.cooldownUntil,
    evidence: hint.evidence ?? record.evidence,
  })
}

function createLimitedProviderHealthRecord(params: {
  providerName: string
  modelName?: string
  state: ProviderHealthState
  reason?: string
  cooldownUntil?: number
  evidence?: Record<string, unknown>
}): ProviderHealthRecord {
  return createProviderHealthRecord({
    providerName: params.providerName,
    modelName: params.modelName,
    state: params.state,
    reason: params.reason,
    cooldownUntil: params.cooldownUntil,
    updatedAt: Date.now(),
    evidence: params.evidence,
  })
}
