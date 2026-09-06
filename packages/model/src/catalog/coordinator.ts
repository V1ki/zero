import { createHash } from 'node:crypto'
import type { ForkEffect, ModelConfig, ProviderConfig, SystemConfig } from '@zero-os/shared'
import { Cause, Effect, Exit, Fiber } from 'effect'
import { matchesModelFilters } from './filter'
import type { ModelCatalogStore } from './store'
import type {
  DiscoveredModel,
  ModelCatalogEntry,
  ModelCatalogRefreshReason,
  ModelCatalogRefreshResult,
  ModelCatalogSnapshot,
  ModelDiscoveryDriver,
  ModelDiscoveryScope,
} from './types'

const DEFAULT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 30_000
const AUTO_REFRESH_TICK_MS = 60_000
const STALE_GRACE_MS = 24 * 60 * 60 * 1000

export interface ModelCatalogCoordinatorOptions {
  config: SystemConfig
  secretGetter(ref: string): string | undefined
  store: ModelCatalogStore
  drivers: ModelDiscoveryDriver[]
  onRefreshError?: (error: {
    providerName: string
    message: string
    reason: ModelCatalogRefreshReason
  }) => void
  now?: () => Date
  /**
   * 自动刷新 tick fiber fork 到宿主生命周期(组合根 fiber root)。默认独立
   * Effect.runFork。
   */
  forkEffect?: ForkEffect
}

export interface RefreshModelCatalogOptions {
  reason: ModelCatalogRefreshReason
  providerNames?: string[]
  force?: boolean
}

type CatalogListener = (snapshot: ModelCatalogSnapshot) => void

interface ProviderRefreshResult {
  providerName: string
  changed: boolean
  discovered: number
  verified: number
  unavailable: number
}

interface ProviderRefreshPlan {
  key: string
  configRevision: number
  providerName: string
  provider?: ProviderConfig
  driver?: ModelDiscoveryDriver
  scope?: ModelDiscoveryScope
}

export class ModelCatalogCoordinator {
  private config: SystemConfig
  private readonly secretGetter: (ref: string) => string | undefined
  private readonly store: ModelCatalogStore
  private readonly drivers: ModelDiscoveryDriver[]
  private readonly onRefreshError: ModelCatalogCoordinatorOptions['onRefreshError']
  private readonly now: () => Date
  private readonly forkEffect: ForkEffect
  private snapshot: ModelCatalogSnapshot = emptySnapshot()
  private listeners = new Set<CatalogListener>()
  private providerRefreshes = new Map<string, Promise<ProviderRefreshResult>>()
  private updateChain: Promise<void> = Promise.resolve()
  private refreshFiber: Fiber.RuntimeFiber<void> | undefined
  private configRevision = 0

  constructor(options: ModelCatalogCoordinatorOptions) {
    this.config = options.config
    this.secretGetter = options.secretGetter
    this.store = options.store
    this.drivers = options.drivers
    this.onRefreshError = options.onRefreshError
    this.now = options.now ?? (() => new Date())
    this.forkEffect = options.forkEffect ?? ((effect) => Effect.runFork(effect))
  }

  async initialize(): Promise<void> {
    this.snapshot = await this.store.load()
  }

  reconfigure(config: SystemConfig): void {
    this.config = config
    this.configRevision++
  }

  subscribe(listener: CatalogListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): ModelCatalogSnapshot {
    return structuredClone(this.snapshot)
  }

  getActiveEntries(): ModelCatalogEntry[] {
    const scopes = this.resolveCurrentScopes()
    return this.snapshot.entries.filter((entry) => {
      const scope = scopes.get(entry.providerName)
      if (!scope || !sameScope(entry, scope)) return false
      if (entry.status === 'verified') return true
      return (
        entry.status === 'stale' &&
        this.now().getTime() - Date.parse(entry.lastSeenAt) < STALE_GRACE_MS
      )
    })
  }

  getScopedEntries(): ModelCatalogEntry[] {
    const scopes = this.resolveCurrentScopes()
    return this.snapshot.entries.filter((entry) => {
      const scope = scopes.get(entry.providerName)
      return scope ? sameScope(entry, scope) : false
    })
  }

  async refresh(options: RefreshModelCatalogOptions): Promise<ModelCatalogRefreshResult> {
    const providerNames = this.resolveRefreshProviderNames(options.providerNames)
    const errors: ModelCatalogRefreshResult['errors'] = []
    const results = await Promise.all(
      providerNames.map(async (providerName) => {
        try {
          return await this.refreshProvider(providerName, options)
        } catch (error) {
          const message = safeErrorMessage(error)
          errors.push({ providerName, message })
          this.onRefreshError?.({ providerName, message, reason: options.reason })
          return undefined
        }
      }),
    )
    const completed = results.filter(
      (result): result is ProviderRefreshResult => result !== undefined,
    )

    return {
      reason: options.reason,
      providerNames,
      changed: completed.some((result) => result.changed),
      discovered: completed.reduce((sum, result) => sum + result.discovered, 0),
      verified: completed.reduce((sum, result) => sum + result.verified, 0),
      unavailable: completed.reduce((sum, result) => sum + result.unavailable, 0),
      errors,
      generation: this.snapshot.generation,
    }
  }

  async markModelUnavailable(
    providerName: string,
    modelName: string,
    reason: string,
  ): Promise<boolean> {
    let changed = false
    await this.enqueueUpdate(async () => {
      const scopes = this.resolveCurrentScopes()
      const scope = scopes.get(providerName)
      if (!scope) return

      const entries = this.snapshot.entries.map((entry) => {
        if (
          !sameScope(entry, scope) ||
          (entry.modelName !== modelName && entry.modelId !== modelName) ||
          entry.status === 'unavailable'
        ) {
          return entry
        }
        changed = true
        return {
          ...entry,
          status: 'unavailable' as const,
          lastError: sanitizeReason(reason),
        }
      })
      if (changed) await this.commit(entries, true)
    })
    return changed
  }

  startAutoRefresh(): void {
    if (this.refreshFiber) return
    this.refreshFiber = this.forkEffect(this.autoRefreshLoop())
    this.refreshFiber.addObserver((exit) => {
      // Fail fast exactly like the previous setInterval callback: refresh()
      // swallows per-provider failures internally, so a rejection here is a
      // defect. dispose() interruption is the normal shutdown path and stays
      // silent.
      if (Exit.isFailure(exit) && !Cause.isInterrupted(exit.cause)) {
        throw Cause.squash(exit.cause)
      }
    })
  }

  dispose(): void {
    if (this.refreshFiber) {
      const fiber = this.refreshFiber
      this.refreshFiber = undefined
      void Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {})
    }
    this.listeners.clear()
  }

  private autoRefreshLoop(): Effect.Effect<void> {
    const refreshTtl = () => this.refresh({ reason: 'ttl' })
    return Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(AUTO_REFRESH_TICK_MS)
        yield* Effect.promise(refreshTtl)
      }
    })
  }

  private refreshProvider(
    providerName: string,
    options: RefreshModelCatalogOptions,
  ): Promise<ProviderRefreshResult> {
    const plan = this.createRefreshPlan(providerName)
    const existing = this.providerRefreshes.get(plan.key)
    if (existing) return existing

    const refresh = this.performProviderRefresh(plan, options).finally(() => {
      if (this.providerRefreshes.get(plan.key) === refresh) {
        this.providerRefreshes.delete(plan.key)
      }
    })
    this.providerRefreshes.set(plan.key, refresh)
    return refresh
  }

  private async performProviderRefresh(
    plan: ProviderRefreshPlan,
    options: RefreshModelCatalogOptions,
  ): Promise<ProviderRefreshResult> {
    const { providerName, provider, driver, scope } = plan
    if (!provider || !driver || !scope || !isEnabled(provider, driver)) {
      return { providerName, changed: false, discovered: 0, verified: 0, unavailable: 0 }
    }
    if (!options.force && !this.isRefreshDue(provider, scope)) {
      return { providerName, changed: false, discovered: 0, verified: 0, unavailable: 0 }
    }

    const signal = AbortSignal.timeout(provider.discovery?.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const context = {
      providerName,
      provider,
      secretGetter: this.secretGetter,
      signal,
    }
    const discovery = await driver.discover(context)
    if (!sameScope(discovery.scope, scope)) {
      throw new Error('Model discovery returned a mismatched account or transport scope')
    }

    if (discovery.models.length === 0) {
      throw new Error('Model discovery returned no models; keeping last-known-good catalog')
    }
    const models = discovery.models.filter((model) =>
      matchesModelFilters(model.modelId, provider.discovery ?? {}),
    )

    const now = this.now().toISOString()
    const existingEntries = new Map(
      this.snapshot.entries
        .filter((entry) => sameScope(entry, scope))
        .map((entry) => [entry.modelId, entry]),
    )
    const nextEntries: ModelCatalogEntry[] = []
    for (const model of models) {
      const existing = existingEntries.get(model.modelId)
      const candidate = buildCatalogEntry(scope, model, existing, now)
      if (existing?.status === 'verified' && existing.metadataHash === candidate.metadataHash) {
        nextEntries.push({
          ...candidate,
          status: 'verified',
          verifiedAt: existing.verifiedAt,
          lastError: undefined,
        })
        continue
      }

      const verification = await driver.verify(context, scope, model)
      nextEntries.push({
        ...candidate,
        status: verification.ok ? 'verified' : 'unavailable',
        verifiedAt: verification.ok ? now : undefined,
        lastError: verification.ok ? undefined : sanitizeReason(verification.reason),
        provenance: {
          ...candidate.provenance,
          availability: 'runtime_probe',
        },
      })
    }

    const discoveredIds = new Set(models.map((model) => model.modelId))
    const returnedIds = new Set(discovery.models.map((model) => model.modelId))
    for (const existing of existingEntries.values()) {
      if (discoveredIds.has(existing.modelId)) continue
      if (returnedIds.has(existing.modelId)) {
        nextEntries.push({
          ...existing,
          status: 'deprecated',
          lastError: 'filtered_by_config',
        })
        continue
      }
      const beyondGrace = this.now().getTime() - Date.parse(existing.lastSeenAt) >= STALE_GRACE_MS
      nextEntries.push({
        ...existing,
        status: beyondGrace ? 'deprecated' : 'stale',
        lastError: 'not_returned_by_discovery',
      })
    }

    let changed = false
    let committed = false
    await this.enqueueUpdate(async () => {
      if (!this.isPlanCurrent(plan)) return
      const retained = this.snapshot.entries.filter((entry) => !sameScope(entry, scope))
      const entries = [...retained, ...nextEntries].sort(compareEntries)
      changed = materialSnapshot(entries) !== materialSnapshot(this.snapshot.entries)
      await this.commit(entries, changed)
      committed = true
    })

    if (!committed) {
      return { providerName, changed: false, discovered: 0, verified: 0, unavailable: 0 }
    }

    return {
      providerName,
      changed,
      discovered: models.length,
      verified: nextEntries.filter((entry) => entry.status === 'verified').length,
      unavailable: nextEntries.filter((entry) => entry.status === 'unavailable').length,
    }
  }

  private createRefreshPlan(providerName: string): ProviderRefreshPlan {
    const provider = this.config.providers[providerName]
    const driver = provider ? this.resolveDriver(providerName, provider) : undefined
    const scope =
      provider && driver && isEnabled(provider, driver)
        ? driver.resolveScope({
            providerName,
            provider,
            secretGetter: this.secretGetter,
          })
        : undefined
    const configRevision = this.configRevision
    return {
      key: stableSerialize([
        configRevision,
        providerName,
        scope?.accountFingerprint,
        scope?.transport,
        scope?.apiType,
      ]),
      configRevision,
      providerName,
      provider,
      driver,
      scope,
    }
  }

  private isPlanCurrent(plan: ProviderRefreshPlan): boolean {
    if (plan.configRevision !== this.configRevision || !plan.scope) return false
    const provider = this.config.providers[plan.providerName]
    const driver = provider ? this.resolveDriver(plan.providerName, provider) : undefined
    if (!provider || !driver || !isEnabled(provider, driver)) return false
    const scope = driver.resolveScope({
      providerName: plan.providerName,
      provider,
      secretGetter: this.secretGetter,
    })
    return Boolean(scope && sameScope(scope, plan.scope))
  }

  private resolveRefreshProviderNames(requested?: string[]): string[] {
    const names = requested?.length ? requested : Object.keys(this.config.providers)
    return Array.from(new Set(names)).filter((providerName) => {
      const provider = this.config.providers[providerName]
      const driver = provider ? this.resolveDriver(providerName, provider) : undefined
      return Boolean(provider && driver && isEnabled(provider, driver))
    })
  }

  private resolveCurrentScopes(): Map<string, ModelDiscoveryScope> {
    const scopes = new Map<string, ModelDiscoveryScope>()
    for (const [providerName, provider] of Object.entries(this.config.providers)) {
      const driver = this.resolveDriver(providerName, provider)
      if (!driver || !isEnabled(provider, driver)) continue
      const scope = driver.resolveScope({
        providerName,
        provider,
        secretGetter: this.secretGetter,
      })
      if (scope) scopes.set(providerName, scope)
    }
    return scopes
  }

  private resolveDriver(
    providerName: string,
    provider: ProviderConfig,
  ): ModelDiscoveryDriver | undefined {
    return this.drivers.find((driver) => driver.supports(providerName, provider))
  }

  private isRefreshDue(provider: ProviderConfig, scope: ModelDiscoveryScope): boolean {
    const interval = provider.discovery?.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
    const lastSeen = this.snapshot.entries
      .filter((entry) => sameScope(entry, scope))
      .map((entry) => Date.parse(entry.lastSeenAt))
      .filter(Number.isFinite)
      .sort((left, right) => right - left)[0]
    return lastSeen === undefined || this.now().getTime() - lastSeen >= interval
  }

  private enqueueUpdate(update: () => Promise<void>): Promise<void> {
    const queued = this.updateChain.then(update, update)
    this.updateChain = queued.catch(() => {})
    return queued
  }

  private async commit(entries: ModelCatalogEntry[], notify: boolean): Promise<void> {
    const nextSnapshot: ModelCatalogSnapshot = {
      version: 1,
      generation: this.snapshot.generation + (notify ? 1 : 0),
      updatedAt: this.now().toISOString(),
      entries,
    }
    await this.store.save(nextSnapshot)
    this.snapshot = nextSnapshot
    if (!notify) return
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}

function buildCatalogEntry(
  scope: ModelDiscoveryScope,
  model: DiscoveredModel,
  existing: ModelCatalogEntry | undefined,
  now: string,
): ModelCatalogEntry {
  const modelConfig: ModelConfig = {
    modelId: model.modelId,
    maxContext: model.maxContext ?? 128000,
    maxOutput: model.maxOutput ?? 8192,
    reasoningEffort: model.defaultReasoningEffort,
    ...(model.supportedReasoningEfforts?.length
      ? { supportedReasoningEfforts: model.supportedReasoningEfforts }
      : {}),
    capabilities: model.capabilities ?? [],
    tags: model.tags ?? [],
  }
  const metadataHash = hashMetadata({
    modelName: model.modelName,
    modelId: model.modelId,
    displayName: model.displayName,
    description: model.description,
    family: model.family,
    version: model.version,
    lane: model.lane,
    modelConfig,
  })

  return {
    ...scope,
    modelName: model.modelName,
    modelId: model.modelId,
    displayName: model.displayName,
    description: model.description,
    family: model.family,
    version: model.version,
    lane: model.lane,
    modelConfig,
    status: 'discovered',
    source: 'provider',
    provenance: model.provenance ?? {},
    metadataHash,
    discoveredAt: existing?.discoveredAt ?? now,
    lastSeenAt: now,
  }
}

function isEnabled(provider: ProviderConfig, driver: ModelDiscoveryDriver): boolean {
  return provider.discovery?.enabled ?? driver.defaultEnabled
}

function sameScope(
  left: Pick<ModelDiscoveryScope, 'providerName' | 'accountFingerprint' | 'transport' | 'apiType'>,
  right: Pick<ModelDiscoveryScope, 'providerName' | 'accountFingerprint' | 'transport' | 'apiType'>,
): boolean {
  return (
    left.providerName === right.providerName &&
    left.accountFingerprint === right.accountFingerprint &&
    left.transport === right.transport &&
    left.apiType === right.apiType
  )
}

function compareEntries(left: ModelCatalogEntry, right: ModelCatalogEntry): number {
  return `${left.providerName}/${left.accountFingerprint}/${left.modelName}`.localeCompare(
    `${right.providerName}/${right.accountFingerprint}/${right.modelName}`,
  )
}

function hashMetadata(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex')
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function materialSnapshot(entries: ModelCatalogEntry[]): string {
  return stableSerialize(entries.map(({ lastSeenAt: _lastSeenAt, ...entry }) => entry))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, field]) => [key, sortValue(field)]),
  )
}

function sanitizeReason(value?: string): string | undefined {
  if (!value) return undefined
  return value.replace(/[\r\n]+/g, ' ').slice(0, 160)
}

function safeErrorMessage(error: unknown): string {
  return sanitizeReason(error instanceof Error ? error.message : String(error)) ?? 'unknown error'
}

function emptySnapshot(): ModelCatalogSnapshot {
  return {
    version: 1,
    generation: 0,
    updatedAt: new Date(0).toISOString(),
    entries: [],
  }
}
