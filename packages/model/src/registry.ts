import type {
  ApiType,
  ModelConfig,
  ModelPoolConfig,
  ProviderConfig,
  SystemConfig,
} from '@zero-os/shared'
import { AnthropicAdapter, AnthropicDeepSeekAdapter } from './adapters/anthropic'
import type { AdapterConfig, OAuthTokenRefresher, ProviderAdapter } from './adapters/base'
import { ModelPolicyAdapter, type RuntimeModelErrorHandler } from './adapters/model-policy'
import { ModelPoolAdapter, type ModelPoolAdapterMember } from './adapters/model-pool'
import { OpenAIChatAdapter } from './adapters/openai-chat'
import { OpenAIResponsesAdapter } from './adapters/openai-resp'
import { TrackedAdapter, type UsageRecorder } from './adapters/tracked'
import { XResponsesAdapter } from './adapters/x-resp'
import { mergeCatalogIntoConfig } from './catalog/merge'
import type { ModelCatalogEntry } from './catalog/types'
import { LiteLLMPricing } from './pricing'
import { ProviderHealthRegistry, type ProviderRecoveryResolver } from './provider-health'

export interface ResolvedModel {
  providerName: string
  modelName: string
  modelConfig: ModelConfig
  providerConfig: ProviderConfig
  adapter: ProviderAdapter
}

export interface ListedModel {
  providerName: string
  modelName: string
  modelId: string
  tags: string[]
  capabilities: string[]
  maxContext: number
  maxOutput: number
  source: 'manual' | 'provider' | 'pool'
  status: 'configured' | 'verified' | 'stale'
  displayName?: string
  family?: string
  version?: string
  lane?: string
}

export interface ListedModelPool {
  providerName: string
  modelName: string
  name: string
  source: ModelPoolSource
  strategy: ModelPoolConfig['strategy']
  members: Array<{
    model: string
    priority: number
  }>
}

export type ModelPoolSource = 'configured' | 'catalog'

export type SecretGetter = (ref: string) => string | undefined

export interface ModelRegistryOptions {
  secretGetter?: SecretGetter
  oauthRefreshers?: Record<string, OAuthTokenRefresher | undefined>
  usageRecorder?: UsageRecorder
  providerHealth?: ProviderHealthRegistry
  providerRecoveryResolver?: ProviderRecoveryResolver
  catalogEntries?: ModelCatalogEntry[]
  onRuntimeModelError?: RuntimeModelErrorHandler
}

type ResolvedPoolMember = ResolvedModel & { label: string; priority: number }

/**
 * Model Registry - parses config and creates adapters on demand.
 */
export class ModelRegistry {
  private providers: Map<string, ProviderConfig> = new Map()
  private modelPools: Map<string, ModelPoolConfig> = new Map()
  private modelPoolSources: Map<string, ModelPoolSource> = new Map()
  private modelPoolAliases: Map<string, string> = new Map()
  private adapterFactory: ModelAdapterFactory
  private poolResolver: ModelPoolResolver
  private providerHealth: ProviderHealthRegistry
  private manualModels = new Set<string>()
  private catalogEntries = new Map<string, ModelCatalogEntry>()

  constructor(
    config: SystemConfig,
    secrets: Map<string, string>,
    options: ModelRegistryOptions = {},
  ) {
    this.providerHealth =
      options.providerHealth ??
      new ProviderHealthRegistry({ recoveryResolver: options.providerRecoveryResolver })
    const secretGetter: SecretGetter = options.secretGetter ?? ((ref) => secrets.get(ref))
    this.adapterFactory = new ModelAdapterFactory({
      secretGetter,
      oauthRefreshers: options.oauthRefreshers ?? {},
      usageRecorder: options.usageRecorder,
      onRuntimeModelError: options.onRuntimeModelError,
    })
    for (const [providerName, provider] of Object.entries(config.providers)) {
      for (const [modelName, model] of Object.entries(provider.models)) {
        this.manualModels.add(modelKey(providerName, modelName))
        this.manualModels.add(modelIdKey(providerName, model.modelId))
      }
    }
    for (const entry of options.catalogEntries ?? []) {
      this.catalogEntries.set(modelKey(entry.providerName, entry.modelName), entry)
      this.catalogEntries.set(modelIdKey(entry.providerName, entry.modelId), entry)
    }
    const effectiveConfig = mergeCatalogIntoConfig(config, options.catalogEntries ?? [])
    for (const [name, provider] of Object.entries(effectiveConfig.providers)) {
      this.providers.set(name, provider)
    }
    const configuredPools = normalizeConfiguredModelPools(effectiveConfig)
    for (const [name, pool] of configuredPools.pools) {
      this.modelPools.set(name, pool)
      this.modelPoolSources.set(name, 'configured')
    }
    this.modelPoolAliases = configuredPools.aliases
    for (const [name, pool] of buildCatalogModelPools(
      effectiveConfig,
      options.catalogEntries ?? [],
    )) {
      if (this.modelPools.has(name)) continue
      this.modelPools.set(name, pool)
      this.modelPoolSources.set(name, 'catalog')
    }
    this.poolResolver = new ModelPoolResolver({
      modelPools: this.modelPools,
      modelPoolSources: this.modelPoolSources,
      modelPoolAliases: this.modelPoolAliases,
      providerHealth: this.providerHealth,
      resolvePhysicalModel: (modelRef) => this.resolvePhysicalModel(modelRef),
      resolvePhysicalModelLabel: (modelRef) => this.resolvePhysicalModelLabel(modelRef),
    })
  }

  /**
   * Resolve a model name to its full configuration and adapter.
   * Searches across all providers.
   */
  resolve(modelName: string): ResolvedModel | undefined {
    const pool = this.poolResolver.resolve(modelName)
    if (pool) return pool
    return this.resolvePhysicalModel(modelName)
  }

  resolvePhysicalModel(modelName: string): ResolvedModel | undefined {
    for (const [providerName, provider] of this.providers) {
      for (const [name, model] of Object.entries(provider.models)) {
        const qualifiedName = `${providerName}/${name}`
        const qualifiedModelId = `${providerName}/${model.modelId}`
        if (
          name === modelName ||
          model.modelId === modelName ||
          qualifiedName === modelName ||
          qualifiedModelId === modelName
        ) {
          const adapter = this.adapterFactory.getOrCreate(providerName, name, provider, model)
          return {
            providerName,
            modelName: name,
            modelConfig: this.adapterFactory.enrichPricing(model),
            providerConfig: provider,
            adapter,
          }
        }
      }
    }
    return undefined
  }

  /**
   * Fuzzy search for models by keyword.
   * Matches against model name, model_id, and tags.
   */
  fuzzySearch(keyword: string): ResolvedModel[] {
    const results: ResolvedModel[] = []
    const lower = keyword.toLowerCase()

    for (const [providerName, provider] of this.providers) {
      for (const [name, model] of Object.entries(provider.models)) {
        const matches =
          name.toLowerCase().includes(lower) ||
          model.modelId.toLowerCase().includes(lower) ||
          model.tags.some((t) => t.toLowerCase().includes(lower))

        if (matches) {
          const adapter = this.adapterFactory.getOrCreate(providerName, name, provider, model)
          results.push({
            providerName,
            modelName: name,
            modelConfig: this.adapterFactory.enrichPricing(model),
            providerConfig: provider,
            adapter,
          })
        }
      }
    }

    return results
  }

  /**
   * List all registered models.
   */
  listModels(): ListedModel[] {
    const models: ListedModel[] = []
    for (const [poolName] of this.modelPools) {
      const [providerName, ...modelParts] = poolName.split('/')
      const modelName = modelParts.join('/')
      if (!providerName || !modelName) continue
      const resolved = this.poolResolver.resolve(poolName)
      const source = this.modelPoolSources.get(poolName) ?? 'configured'
      models.push({
        providerName,
        modelName,
        modelId: modelName,
        tags: ['pool'],
        capabilities: resolved?.modelConfig.capabilities ?? [],
        maxContext: resolved?.modelConfig.maxContext ?? 0,
        maxOutput: resolved?.modelConfig.maxOutput ?? 0,
        source: 'pool',
        status: source === 'catalog' ? 'verified' : 'configured',
      })
    }
    for (const [providerName, provider] of this.providers) {
      for (const [name, model] of Object.entries(provider.models)) {
        const catalogEntry =
          this.catalogEntries.get(modelKey(providerName, name)) ??
          this.catalogEntries.get(modelIdKey(providerName, model.modelId))
        const manual =
          this.manualModels.has(modelKey(providerName, name)) ||
          this.manualModels.has(modelIdKey(providerName, model.modelId))
        models.push({
          providerName,
          modelName: name,
          modelId: model.modelId,
          tags: model.tags,
          capabilities: model.capabilities,
          maxContext: model.maxContext,
          maxOutput: model.maxOutput,
          source: manual ? 'manual' : 'provider',
          status: manual ? 'configured' : catalogEntry?.status === 'stale' ? 'stale' : 'verified',
          displayName: catalogEntry?.displayName,
          family: catalogEntry?.family,
          version: catalogEntry?.version,
          lane: catalogEntry?.lane,
        })
      }
    }
    return models
  }

  listModelPools(): ListedModelPool[] {
    return this.poolResolver.list()
  }

  private resolvePhysicalModelLabel(modelRef: string): string | undefined {
    for (const [providerName, provider] of this.providers) {
      for (const [name, model] of Object.entries(provider.models)) {
        const qualifiedName = `${providerName}/${name}`
        const qualifiedModelId = `${providerName}/${model.modelId}`
        if (
          name === modelRef ||
          model.modelId === modelRef ||
          qualifiedName === modelRef ||
          qualifiedModelId === modelRef
        ) {
          return qualifiedName
        }
      }
    }
    return undefined
  }

  getProviderHealth(): ProviderHealthRegistry {
    return this.providerHealth
  }
}

interface ModelAdapterFactoryOptions {
  secretGetter: SecretGetter
  oauthRefreshers: Record<string, OAuthTokenRefresher | undefined>
  usageRecorder?: UsageRecorder
  onRuntimeModelError?: RuntimeModelErrorHandler
}

class ModelAdapterFactory {
  private adapters: Map<string, ProviderAdapter> = new Map()
  private secretGetter: SecretGetter
  private oauthRefreshers: Record<string, OAuthTokenRefresher | undefined>
  private usageRecorder?: UsageRecorder
  private onRuntimeModelError?: RuntimeModelErrorHandler

  constructor(options: ModelAdapterFactoryOptions) {
    this.secretGetter = options.secretGetter
    this.oauthRefreshers = options.oauthRefreshers
    this.usageRecorder = options.usageRecorder
    this.onRuntimeModelError = options.onRuntimeModelError
  }

  getOrCreate(
    providerName: string,
    modelName: string,
    provider: ProviderConfig,
    model: ModelConfig,
  ): ProviderAdapter {
    const key = `${providerName}:${modelName}:${model.modelId}`
    let adapter = this.adapters.get(key)
    if (adapter) return adapter

    const apiKey = provider.auth.apiKeyRef ? this.secretGetter(provider.auth.apiKeyRef) : undefined
    const oauthToken = provider.auth.oauthTokenRef
      ? this.resolveOauthToken(providerName, this.secretGetter(provider.auth.oauthTokenRef))
      : undefined

    const modelConfig = this.enrichPricing(model)
    const config: AdapterConfig = {
      providerName,
      managedOAuthProvider: provider.auth.managedOAuthProvider,
      baseUrl: provider.baseUrl,
      auth: provider.auth,
      modelConfig,
      apiKey,
      oauthToken,
      oauthTokenProvider: provider.auth.oauthTokenRef
        ? () =>
            this.resolveOauthToken(
              providerName,
              this.secretGetter(provider.auth.oauthTokenRef as string),
            )
        : undefined,
      oauthTokenRefresher: this.oauthRefreshers[providerName],
    }

    adapter = this.createAdapter(provider.apiType, config)
    if (modelConfig.supportedReasoningEfforts?.length || this.onRuntimeModelError) {
      adapter = new ModelPolicyAdapter(
        adapter,
        providerName,
        modelName,
        modelConfig,
        this.onRuntimeModelError,
      )
    }
    if (this.usageRecorder) {
      adapter = new TrackedAdapter(adapter, this.usageRecorder, {
        providerName,
        modelLabel: `${providerName}/${modelName}`,
        pricing: modelConfig.pricing,
      })
    }
    this.adapters.set(key, adapter)
    return adapter
  }

  enrichPricing(model: ModelConfig): ModelConfig {
    if (model.pricing) return model
    const fallback = LiteLLMPricing.getInstance()?.lookup(model.modelId)
    if (!fallback) return model
    return { ...model, pricing: fallback }
  }

  private resolveOauthToken(_providerName: string, rawValue: string | undefined) {
    return rawValue
  }

  private createAdapter(apiType: ApiType, config: AdapterConfig): ProviderAdapter {
    switch (apiType) {
      case 'openai_chat_completions':
        return new OpenAIChatAdapter(config)
      case 'anthropic_messages':
        return new AnthropicAdapter(config)
      case 'anthropic-deepseek':
        return new AnthropicDeepSeekAdapter(config)
      case 'openai_responses':
        return new OpenAIResponsesAdapter(config)
      case 'x_responses':
        return new XResponsesAdapter(config)
      default:
        throw new Error(`Unsupported API type: ${apiType}`)
    }
  }
}

interface ModelPoolResolverOptions {
  modelPools: Map<string, ModelPoolConfig>
  modelPoolSources: Map<string, ModelPoolSource>
  modelPoolAliases: Map<string, string>
  providerHealth: ProviderHealthRegistry
  resolvePhysicalModel: (modelRef: string) => ResolvedModel | undefined
  resolvePhysicalModelLabel: (modelRef: string) => string | undefined
}

class ModelPoolResolver {
  private modelPools: Map<string, ModelPoolConfig>
  private modelPoolSources: Map<string, ModelPoolSource>
  private modelPoolAliases: Map<string, string>
  private poolAdapters: Map<string, ProviderAdapter> = new Map()
  private providerHealth: ProviderHealthRegistry
  private resolvePhysicalModel: (modelRef: string) => ResolvedModel | undefined
  private resolvePhysicalModelLabel: (modelRef: string) => string | undefined

  constructor(options: ModelPoolResolverOptions) {
    this.modelPools = options.modelPools
    this.modelPoolSources = options.modelPoolSources
    this.modelPoolAliases = options.modelPoolAliases
    this.providerHealth = options.providerHealth
    this.resolvePhysicalModel = options.resolvePhysicalModel
    this.resolvePhysicalModelLabel = options.resolvePhysicalModelLabel
  }

  resolve(modelName: string): ResolvedModel | undefined {
    const canonicalName = this.modelPoolAliases.get(modelName) ?? modelName
    const exactPool = this.modelPools.get(canonicalName)
    if (exactPool) {
      return this.buildResolvedPool(canonicalName, exactPool)
    }

    if (modelName.includes('/')) {
      return undefined
    }

    const matches = Array.from(this.modelPools.entries()).filter(([poolName]) => {
      return poolName.split('/').at(-1) === modelName
    })
    if (matches.length !== 1) return undefined
    return this.buildResolvedPool(matches[0][0], matches[0][1])
  }

  list(): ListedModelPool[] {
    return Array.from(this.modelPools.entries())
      .map(([poolName, pool]): ListedModelPool | null => {
        const [providerName, ...modelParts] = poolName.split('/')
        const modelName = modelParts.join('/')
        if (!providerName || !modelName) return null
        return {
          providerName,
          modelName,
          name: poolName,
          source: this.modelPoolSources.get(poolName) ?? 'configured',
          strategy: pool.strategy,
          members: pool.members
            .map((member, index) => ({
              model: this.resolvePhysicalModelLabel(member.model) ?? member.model,
              priority: member.priority ?? index,
            }))
            .sort((left, right) => left.priority - right.priority),
        }
      })
      .filter((pool): pool is ListedModelPool => pool !== null)
  }

  private buildResolvedPool(poolName: string, pool: ModelPoolConfig): ResolvedModel | undefined {
    const members = this.resolvePoolMembers(pool)
    const first = members[0]
    if (!first) return undefined

    const [providerName, ...modelParts] = poolName.split('/')
    const modelName = modelParts.join('/')
    if (!providerName || !modelName) return undefined

    return {
      providerName,
      modelName,
      modelConfig: buildSafePoolModelConfig(poolName, members),
      providerConfig: first.providerConfig,
      adapter: this.getOrCreatePoolAdapter(poolName, pool, members),
    }
  }

  private resolvePoolMembers(pool: ModelPoolConfig): ResolvedPoolMember[] {
    return pool.members
      .map((member, index) => {
        const resolved = this.resolvePhysicalModel(member.model)
        if (!resolved) return null
        return {
          ...resolved,
          label: formatModelLabel(resolved.providerName, resolved.modelName),
          priority: member.priority ?? index,
        }
      })
      .filter((member): member is ResolvedPoolMember => member !== null)
  }

  private getOrCreatePoolAdapter(
    poolName: string,
    pool: ModelPoolConfig,
    members: ResolvedPoolMember[],
  ): ProviderAdapter {
    const adapter = this.poolAdapters.get(poolName)
    if (adapter) return adapter

    const poolMembers: ModelPoolAdapterMember[] = members.map((member) => ({
      label: member.label,
      providerName: member.providerName,
      modelName: member.modelName,
      adapter: member.adapter,
      priority: member.priority,
    }))
    const next = new ModelPoolAdapter(poolName, poolMembers, this.providerHealth, {
      sticky: pool.strategy !== 'priority_failover',
      quotaAware: pool.strategy === 'sticky_quota_aware_failover',
    })
    this.poolAdapters.set(poolName, next)
    return next
  }
}

function formatModelLabel(providerName: string, modelName: string): string {
  return `${providerName}/${modelName}`
}

function buildSafePoolModelConfig(poolName: string, members: ResolvedPoolMember[]): ModelConfig {
  const [first, ...rest] = members
  const capabilities = first.modelConfig.capabilities.filter((capability) =>
    rest.every((member) => member.modelConfig.capabilities.includes(capability)),
  )
  const supportedReasoningEfforts = first.modelConfig.supportedReasoningEfforts?.filter((effort) =>
    rest.every((member) => member.modelConfig.supportedReasoningEfforts?.includes(effort)),
  )
  const reasoningEffort = rest.every(
    (member) => member.modelConfig.reasoningEffort === first.modelConfig.reasoningEffort,
  )
    ? first.modelConfig.reasoningEffort
    : undefined
  const pricing = rest.every(
    (member) =>
      JSON.stringify(member.modelConfig.pricing) === JSON.stringify(first.modelConfig.pricing),
  )
    ? first.modelConfig.pricing
    : undefined

  return {
    modelId: poolName,
    maxContext: Math.min(...members.map((member) => member.modelConfig.maxContext)),
    maxOutput: Math.min(...members.map((member) => member.modelConfig.maxOutput)),
    reasoningEffort,
    ...(supportedReasoningEfforts?.length ? { supportedReasoningEfforts } : {}),
    capabilities,
    tags: Array.from(new Set(members.flatMap((member) => member.modelConfig.tags))),
    pricing,
  }
}

function modelKey(providerName: string, modelName: string): string {
  return `${providerName}/name/${modelName}`
}

function modelIdKey(providerName: string, modelId: string): string {
  return `${providerName}/id/${modelId}`
}

interface NormalizedModelPools {
  pools: Map<string, ModelPoolConfig>
  aliases: Map<string, string>
}

/**
 * Older configs commonly used a physical-looking provider/model label for a multi-account pool.
 * Keep that reference as an alias while exposing one canonical pool/model-id runtime identity.
 */
function normalizeConfiguredModelPools(config: SystemConfig): NormalizedModelPools {
  const configured = config.modelPools ?? {}
  const configuredNames = new Set(Object.keys(configured))
  const pools = new Map<string, ModelPoolConfig>()
  const aliases = new Map<string, string>()

  for (const [name, pool] of Object.entries(configured)) {
    const modelIds = pool.members.map((member) => resolvePhysicalModelId(config, member.model))
    const sharedModelId = modelIds[0]
    const canonicalName = sharedModelId ? `pool/${sharedModelId}` : undefined
    const canCanonicalize =
      pool.members.length > 1 &&
      modelIds.every((modelId) => modelId === sharedModelId) &&
      canonicalName !== undefined &&
      (canonicalName === name || (!configuredNames.has(canonicalName) && !pools.has(canonicalName)))
    const runtimeName = canCanonicalize ? canonicalName : name

    pools.set(runtimeName, pool)
    if (runtimeName !== name) aliases.set(name, runtimeName)
  }

  return { pools, aliases }
}

/** Build ephemeral logical pools from active per-subscription Catalog entries. */
function buildCatalogModelPools(
  config: SystemConfig,
  catalogEntries: ModelCatalogEntry[],
): Map<string, ModelPoolConfig> {
  const providerOrder = new Map(
    Object.keys(config.providers).map((providerName, index) => [providerName, index]),
  )
  const grouped = new Map<
    string,
    Map<string, { model: string; providerName: string; providerOrder: number }>
  >()

  for (const entry of catalogEntries) {
    if (entry.status !== 'verified' && entry.status !== 'stale') continue
    const provider = config.providers[entry.providerName]
    if (!provider) continue
    const modelName = resolveCatalogModelName(provider, entry)
    if (!modelName) continue

    const label = formatModelLabel(entry.providerName, modelName)
    const members = grouped.get(entry.modelId) ?? new Map()
    members.set(label, {
      model: label,
      providerName: entry.providerName,
      providerOrder: providerOrder.get(entry.providerName) ?? Number.POSITIVE_INFINITY,
    })
    grouped.set(entry.modelId, members)
  }

  return new Map(
    Array.from(grouped.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([modelId, candidates]) => {
        const members = Array.from(candidates.values())
          .sort((left, right) => {
            return (
              left.providerOrder - right.providerOrder ||
              left.providerName.localeCompare(right.providerName) ||
              left.model.localeCompare(right.model)
            )
          })
          .map((member, priority) => ({ model: member.model, priority }))
        return [
          `pool/${modelId}`,
          { strategy: 'sticky_quota_aware_failover', members } satisfies ModelPoolConfig,
        ]
      }),
  )
}

function resolvePhysicalModelId(config: SystemConfig, modelRef: string): string | undefined {
  for (const [providerName, provider] of Object.entries(config.providers)) {
    for (const [modelName, model] of Object.entries(provider.models)) {
      if (
        modelRef === modelName ||
        modelRef === model.modelId ||
        modelRef === formatModelLabel(providerName, modelName) ||
        modelRef === formatModelLabel(providerName, model.modelId)
      ) {
        return model.modelId
      }
    }
  }
  return undefined
}

function resolveCatalogModelName(
  provider: ProviderConfig,
  entry: ModelCatalogEntry,
): string | undefined {
  if (provider.models[entry.modelName]?.modelId === entry.modelId) return entry.modelName
  return Object.entries(provider.models).find(([, model]) => model.modelId === entry.modelId)?.[0]
}
