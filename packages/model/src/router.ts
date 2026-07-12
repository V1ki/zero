import type { ModelRouteConfig, ModelRoutePreference, SystemConfig } from '@zero-os/shared'
import type { ProviderAdapter } from './adapters/base'
import type { RuntimeModelError } from './adapters/model-policy'
import type { ModelCatalogCoordinator, RefreshModelCatalogOptions } from './catalog/coordinator'
import type {
  ModelCatalogEntry,
  ModelCatalogRefreshResult,
  ModelCatalogSnapshot,
} from './catalog/types'
import {
  type ListedModel,
  ModelRegistry,
  type ModelRegistryOptions,
  type ResolvedModel,
} from './registry'

export interface ModelSwitchResult {
  success: boolean
  model?: ResolvedModel
  message: string
}

export interface ModelRouterOptions extends ModelRegistryOptions {
  catalog?: ModelCatalogCoordinator
}

/**
 * Model Router — decides which model handles each request.
 * Supports exact match, fuzzy match, and fallback chain.
 */
export class ModelRouter {
  private registry: ModelRegistry
  private currentModel: ResolvedModel | undefined
  private fallbackChain: string[]
  private defaultModel: string
  private config: SystemConfig
  private secrets: Map<string, string>
  private options: ModelRouterOptions
  private catalog?: ModelCatalogCoordinator
  private unsubscribeCatalog?: () => void

  constructor(
    config: SystemConfig,
    secrets: Map<string, string>,
    options: ModelRouterOptions = {},
  ) {
    this.config = config
    this.secrets = secrets
    this.options = options
    this.catalog = options.catalog
    this.registry = this.createRegistry()
    if (!this.options.providerHealth) {
      this.options = { ...this.options, providerHealth: this.registry.getProviderHealth() }
    }
    this.fallbackChain = config.fallbackChain
    this.defaultModel = config.defaultModel
    this.subscribeToCatalog()
  }

  reload(
    config: SystemConfig,
    secrets: Map<string, string>,
    options: ModelRouterOptions = {},
  ): void {
    const currentLabel = this.currentModel ? this.getModelLabel(this.currentModel) : undefined
    this.config = config
    this.secrets = secrets
    this.options = { ...this.options, ...options, catalog: options.catalog ?? this.catalog }
    if (options.catalog && options.catalog !== this.catalog) {
      this.unsubscribeCatalog?.()
      this.catalog = options.catalog
      this.subscribeToCatalog()
    }
    this.catalog?.reconfigure(config)
    this.registry = this.createRegistry()
    this.fallbackChain = config.fallbackChain
    this.defaultModel = config.defaultModel
    this.currentModel =
      this.resolveModel(currentLabel ?? this.defaultModel) ?? this.resolveModel(this.defaultModel)
  }

  /**
   * Initialize router with the default model.
   */
  init(): ModelSwitchResult {
    const selected = this.switchModel(this.defaultModel)
    if (selected.success) return selected

    for (const fallback of this.fallbackChain) {
      const resolved = this.resolveModel(fallback)
      if (!resolved) continue
      this.currentModel = resolved
      return {
        success: true,
        model: resolved,
        message: `Default model unavailable; started with ${this.getModelLabel(resolved)}`,
      }
    }
    return selected
  }

  /**
   * Resolve a model reference without mutating router state.
   */
  resolveModel(target: string): ResolvedModel | undefined {
    return this.resolveRoute(target) ?? this.registry.resolve(target)
  }

  /**
   * Resolve a model reference to its canonical provider-qualified label.
   */
  normalizeModelReference(target: string): string | undefined {
    const resolved = this.resolveModel(target)
    return resolved ? this.getModelLabel(resolved) : undefined
  }

  /**
   * Get the configured default model as a resolved model.
   */
  getDefaultModel(): ResolvedModel | undefined {
    return this.resolveModel(this.defaultModel)
  }

  /**
   * Get the canonical label for the configured default model.
   */
  getDefaultModelLabel(): string {
    return this.normalizeModelReference(this.defaultModel) ?? this.defaultModel
  }

  /**
   * Get the current active model's adapter.
   */
  getAdapter(): ProviderAdapter {
    if (!this.currentModel) {
      throw new Error('No active model. Call init() or switchModel() first.')
    }
    return this.currentModel.adapter
  }

  /**
   * Get current model info.
   */
  getCurrentModel(): ResolvedModel | undefined {
    return this.currentModel
  }

  /**
   * Switch to a different model.
   * Tries exact match first, then fuzzy match.
   */
  switchModel(target: string): ModelSwitchResult {
    const selection = this.selectModel(target)
    if (selection.success && selection.model) {
      this.currentModel = selection.model
    }
    return selection
  }

  /**
   * Resolve a model target without mutating the router.
   */
  selectModel(target: string): ModelSwitchResult {
    // 1. Exact match
    const exact = this.resolveModel(target)
    if (exact) {
      return {
        success: true,
        model: exact,
        message: `Switched to ${this.getModelLabel(exact)}`,
      }
    }

    // 2. Fuzzy match
    const fuzzy = this.registry.fuzzySearch(target)
    if (fuzzy.length === 1) {
      return {
        success: true,
        model: fuzzy[0],
        message: `Switched to ${this.getModelLabel(fuzzy[0])}`,
      }
    }

    if (fuzzy.length > 1) {
      const candidates = fuzzy.map((m) => `  - ${this.getModelLabel(m)}`).join('\n')
      return {
        success: false,
        message: `Multiple matches found:\n${candidates}\nPlease be more specific.`,
      }
    }

    // 3. No match
    const availableModels = this.registry
      .listModels()
      .map((m) => `  - ${this.formatModelLabel(m.providerName, m.modelName)}`)
    const availableRoutes = Object.keys(this.config.modelRoutes ?? {}).map(
      (name) => `  - route/${name}`,
    )
    const available = [...availableRoutes, ...availableModels].join('\n')
    return {
      success: false,
      message: `Model "${target}" not found. Available models:\n${available}`,
    }
  }

  /**
   * Try fallback chain when current model is unavailable.
   */
  async fallback(): Promise<ModelSwitchResult> {
    for (const modelName of this.fallbackChain) {
      const resolved = this.resolveModel(modelName)
      if (!resolved) continue

      const healthy = await resolved.adapter.healthCheck()
      if (healthy) {
        this.currentModel = resolved
        return {
          success: true,
          model: resolved,
          message: `Fell back to ${this.getModelLabel(resolved)}`,
        }
      }
    }

    return {
      success: false,
      message: 'All models in fallback chain are unavailable.',
    }
  }

  formatModelLabel(providerName: string, modelName: string): string {
    return `${providerName}/${modelName}`
  }

  getModelLabel(model: ResolvedModel): string {
    return this.formatModelLabel(model.providerName, model.modelName)
  }

  /**
   * Get the registry for direct model access.
   */
  getRegistry(): ModelRegistry {
    return this.registry
  }

  listModelRoutes(): string[] {
    return Object.keys(this.config.modelRoutes ?? {}).map((name) => `route/${name}`)
  }

  getCatalogSnapshot(): ModelCatalogSnapshot | undefined {
    return this.catalog?.getSnapshot()
  }

  getCatalogEntries(): ModelCatalogEntry[] {
    return this.catalog?.getScopedEntries() ?? []
  }

  async refreshCatalog(options: RefreshModelCatalogOptions): Promise<ModelCatalogRefreshResult> {
    if (!this.catalog) {
      return {
        reason: options.reason,
        providerNames: [],
        changed: false,
        discovered: 0,
        verified: 0,
        unavailable: 0,
        errors: [],
        generation: 0,
      }
    }
    const result = await this.catalog.refresh(options)
    for (const entry of this.catalog.getActiveEntries()) {
      if (result.providerNames.includes(entry.providerName) && entry.status === 'verified') {
        this.registry.getProviderHealth().markHealthy(entry.providerName, entry.modelName, {
          source: 'model_catalog_verification',
          generation: result.generation,
        })
      }
    }
    this.rebuildRegistry()
    return result
  }

  startCatalogAutoRefresh(): void {
    this.catalog?.startAutoRefresh()
  }

  dispose(): void {
    this.unsubscribeCatalog?.()
    this.unsubscribeCatalog = undefined
    this.catalog?.dispose()
  }

  private createRegistry(): ModelRegistry {
    const configuredHandler = this.options.onRuntimeModelError
    const onRuntimeModelError =
      configuredHandler || this.catalog
        ? async (event: RuntimeModelError) => {
            await configuredHandler?.(event)
            await this.handleRuntimeModelError(event)
          }
        : undefined
    return new ModelRegistry(this.config, this.secrets, {
      ...this.options,
      catalogEntries: this.catalog?.getActiveEntries() ?? this.options.catalogEntries,
      onRuntimeModelError,
    })
  }

  private rebuildRegistry(): void {
    const currentLabel = this.currentModel ? this.getModelLabel(this.currentModel) : undefined
    this.registry = this.createRegistry()
    this.currentModel =
      this.resolveModel(currentLabel ?? this.defaultModel) ?? this.resolveModel(this.defaultModel)
  }

  private subscribeToCatalog(): void {
    if (!this.catalog) return
    this.unsubscribeCatalog = this.catalog.subscribe(() => this.rebuildRegistry())
  }

  private async handleRuntimeModelError(event: RuntimeModelError): Promise<void> {
    this.registry.getProviderHealth().markTemporaryUnavailable({
      providerName: event.providerName,
      modelName: event.modelName,
      reason: event.reason,
    })
    if (!this.catalog) return
    await this.catalog.markModelUnavailable(event.providerName, event.modelName, event.reason)
    await this.refreshCatalog({
      reason: 'runtime_model_error',
      providerNames: [event.providerName],
      force: true,
    })
  }

  private resolveRoute(target: string): ResolvedModel | undefined {
    const routeName = target.startsWith('route/') ? target.slice('route/'.length) : undefined
    if (!routeName) return undefined
    const route = this.config.modelRoutes?.[routeName]
    if (!route) return undefined

    const candidates = this.routeCandidates(route)
    const selected = selectRouteCandidate(candidates, route.prefer ?? 'priority')
    if (!selected) return undefined
    const resolved = this.registry.resolve(`${selected.providerName}/${selected.modelName}`)
    if (!resolved || route.reasoningEffort === undefined || route.reasoningEffort === 'auto') {
      return resolved
    }
    return {
      ...resolved,
      modelConfig: { ...resolved.modelConfig, reasoningEffort: route.reasoningEffort },
    }
  }

  private routeCandidates(route: ModelRouteConfig): ListedModel[] {
    const listed = this.registry.listModels().filter((model) => model.source !== 'pool')
    const explicitOrder = new Map(
      (route.models ?? []).map((model, index) => {
        const normalized = normalizeListedModelRef(model)
        const resolved = this.registry.resolvePhysicalModel(normalized)
        return [resolved ? this.getModelLabel(resolved) : normalized, index]
      }),
    )

    return listed
      .filter((model) => {
        const label = `${model.providerName}/${model.modelName}`
        const health = this.registry.getProviderHealth().get(model.providerName, model.modelName)
        if (explicitOrder.size > 0 && !explicitOrder.has(label)) return false
        if (
          health &&
          health.state !== 'healthy' &&
          health.state !== 'degraded' &&
          (!health.cooldownUntil || health.cooldownUntil > Date.now())
        ) {
          return false
        }
        if (route.providers?.length && !route.providers.includes(model.providerName)) return false
        if (route.family && inferFamily(model) !== route.family.toLowerCase()) return false
        if (route.lanes?.length && !route.lanes.includes(inferLane(model) ?? '')) return false
        if (route.requires?.some((capability) => !model.capabilities.includes(capability))) {
          return false
        }
        if (route.tags?.some((tag) => !model.tags.includes(tag))) return false
        if (route.minContext && model.maxContext < route.minContext) return false
        if (route.minOutput && model.maxOutput < route.minOutput) return false
        return true
      })
      .sort((left, right) => {
        if (explicitOrder.size === 0) return 0
        const leftOrder =
          explicitOrder.get(`${left.providerName}/${left.modelName}`) ?? Number.POSITIVE_INFINITY
        const rightOrder =
          explicitOrder.get(`${right.providerName}/${right.modelName}`) ?? Number.POSITIVE_INFINITY
        return leftOrder - rightOrder
      })
  }
}

function selectRouteCandidate(
  candidates: ListedModel[],
  preference: ModelRoutePreference,
): ListedModel | undefined {
  if (preference === 'priority') return candidates[0]
  return [...candidates].sort((left, right) => {
    const scoreDifference = scoreModel(right, preference) - scoreModel(left, preference)
    return scoreDifference || compareVersions(right.version, left.version)
  })[0]
}

function scoreModel(model: ListedModel, preference: Exclude<ModelRoutePreference, 'priority'>) {
  const lane = inferLane(model)
  const availabilityScore = model.status === 'stale' ? 0 : 1_000_000
  if (preference === 'newest') return availabilityScore + versionScore(model.version)
  if (preference === 'fast') {
    return (
      availabilityScore +
      tagScore(model, ['fast', 'mini']) +
      laneScore(lane, ['luna', 'mini', 'instant'])
    )
  }
  if (preference === 'balanced') {
    return (
      availabilityScore + tagScore(model, ['balanced']) + laneScore(lane, ['terra', 'balanced'])
    )
  }
  return (
    availabilityScore +
    tagScore(model, ['powerful', 'frontier', 'pro']) +
    laneScore(lane, ['pro', 'sol', 'frontier'])
  )
}

function tagScore(model: ListedModel, tags: string[]): number {
  return tags.reduce((score, tag, index) => {
    return score + (model.tags.includes(tag) ? tags.length - index : 0)
  }, 0)
}

function laneScore(lane: string | undefined, lanes: string[]): number {
  const index = lane ? lanes.indexOf(lane) : -1
  return index < 0 ? 0 : lanes.length - index
}

function inferFamily(model: ListedModel): string | undefined {
  return (
    model.family?.toLowerCase() ?? model.modelId.match(/^([a-z][a-z0-9]*)-/i)?.[1]?.toLowerCase()
  )
}

function inferLane(model: ListedModel): string | undefined {
  if (model.lane) return model.lane.toLowerCase()
  return model.modelId.match(/^[a-z][a-z0-9]*-\d+(?:\.\d+)*-(.+)$/i)?.[1]?.toLowerCase()
}

function versionScore(version?: string): number {
  if (!version) return 0
  return version.split('.').reduce((score, part) => score * 1000 + Number(part || 0), 0)
}

function compareVersions(left?: string, right?: string): number {
  return versionScore(left) - versionScore(right)
}

function normalizeListedModelRef(value: string): string {
  return value.replace(/^model\//, '')
}
