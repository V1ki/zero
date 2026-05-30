import type {
  ApiType,
  ModelConfig,
  ModelPoolConfig,
  ProviderConfig,
  SystemConfig,
} from '@zero-os/shared'
import { AnthropicAdapter } from './adapters/anthropic'
import { AnthropicDeepSeekAdapter } from './adapters/anthropic-deepseek'
import type { AdapterConfig, OAuthTokenRefresher, ProviderAdapter } from './adapters/base'
import { ModelPoolAdapter, type ModelPoolAdapterMember } from './adapters/model-pool'
import { OpenAIChatAdapter } from './adapters/openai-chat'
import { OpenAIResponsesAdapter } from './adapters/openai-resp'
import { TrackedAdapter, type UsageRecorder } from './adapters/tracked'
import { XResponsesAdapter } from './adapters/x-resp'
import { LiteLLMPricing } from './pricing'
import { ProviderHealthRegistry, type ProviderRecoveryResolver } from './provider-health'

export interface ResolvedModel {
  providerName: string
  modelName: string
  modelConfig: ModelConfig
  providerConfig: ProviderConfig
  adapter: ProviderAdapter
}

export type SecretGetter = (ref: string) => string | undefined

export interface ModelRegistryOptions {
  secretGetter?: SecretGetter
  oauthRefreshers?: Record<string, OAuthTokenRefresher | undefined>
  usageRecorder?: UsageRecorder
  providerHealth?: ProviderHealthRegistry
  providerRecoveryResolver?: ProviderRecoveryResolver
}

/**
 * Model Registry - parses config and creates adapters on demand.
 */
export class ModelRegistry {
  private providers: Map<string, ProviderConfig> = new Map()
  private modelPools: Map<string, ModelPoolConfig> = new Map()
  private adapters: Map<string, ProviderAdapter> = new Map()
  private poolAdapters: Map<string, ProviderAdapter> = new Map()
  private secrets: Map<string, string>
  private secretGetter: SecretGetter
  private oauthRefreshers: Record<string, OAuthTokenRefresher | undefined>
  private usageRecorder?: UsageRecorder
  private providerHealth: ProviderHealthRegistry

  constructor(
    config: SystemConfig,
    secrets: Map<string, string>,
    options: ModelRegistryOptions = {},
  ) {
    this.secrets = secrets
    this.secretGetter = options.secretGetter ?? ((ref) => this.secrets.get(ref))
    this.oauthRefreshers = options.oauthRefreshers ?? {}
    this.usageRecorder = options.usageRecorder
    this.providerHealth =
      options.providerHealth ??
      new ProviderHealthRegistry({ recoveryResolver: options.providerRecoveryResolver })
    for (const [name, provider] of Object.entries(config.providers)) {
      this.providers.set(name, provider)
    }
    for (const [name, pool] of Object.entries(config.modelPools ?? {})) {
      this.modelPools.set(name, pool)
    }
  }

  /**
   * Resolve a model name to its full configuration and adapter.
   * Searches across all providers.
   */
  resolve(modelName: string): ResolvedModel | undefined {
    const pool = this.resolveModelPool(modelName)
    if (pool) return pool
    return this.resolvePhysicalModel(modelName)
  }

  private resolvePhysicalModel(modelName: string): ResolvedModel | undefined {
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
          const adapter = this.getOrCreateAdapter(providerName, name, provider, model)
          return {
            providerName,
            modelName: name,
            modelConfig: this.enrichPricing(model),
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
          const adapter = this.getOrCreateAdapter(providerName, name, provider, model)
          results.push({
            providerName,
            modelName: name,
            modelConfig: this.enrichPricing(model),
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
  listModels(): { providerName: string; modelName: string; modelId: string; tags: string[] }[] {
    const models: { providerName: string; modelName: string; modelId: string; tags: string[] }[] =
      []
    for (const [poolName] of this.modelPools) {
      const [providerName, ...modelParts] = poolName.split('/')
      const modelName = modelParts.join('/')
      if (!providerName || !modelName) continue
      models.push({
        providerName,
        modelName,
        modelId: modelName,
        tags: ['pool'],
      })
    }
    for (const [providerName, provider] of this.providers) {
      for (const [name, model] of Object.entries(provider.models)) {
        models.push({
          providerName,
          modelName: name,
          modelId: model.modelId,
          tags: model.tags,
        })
      }
    }
    return models
  }

  getProviderHealth(): ProviderHealthRegistry {
    return this.providerHealth
  }

  private resolveModelPool(modelName: string): ResolvedModel | undefined {
    const exactPool = this.modelPools.get(modelName)
    if (exactPool) {
      return this.buildResolvedPool(modelName, exactPool)
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
      modelConfig: first.modelConfig,
      providerConfig: first.providerConfig,
      adapter: this.getOrCreatePoolAdapter(poolName, pool, members),
    }
  }

  private resolvePoolMembers(
    pool: ModelPoolConfig,
  ): Array<ResolvedModel & { label: string; priority: number }> {
    return pool.members
      .map((member, index) => {
        const resolved = this.resolvePhysicalModel(member.model)
        if (!resolved) return null
        return {
          ...resolved,
          label: this.formatModelLabel(resolved.providerName, resolved.modelName),
          priority: member.priority ?? index,
        }
      })
      .filter(
        (member): member is ResolvedModel & { label: string; priority: number } => member !== null,
      )
  }

  private getOrCreatePoolAdapter(
    poolName: string,
    pool: ModelPoolConfig,
    members: Array<ResolvedModel & { label: string; priority: number }>,
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

  private getOrCreateAdapter(
    providerName: string,
    modelName: string,
    provider: ProviderConfig,
    model: ModelConfig,
  ): ProviderAdapter {
    const key = `${providerName}:${model.modelId}`
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

  /**
   * Inject fallback pricing when config has no explicit pricing.
   */
  private enrichPricing(model: ModelConfig): ModelConfig {
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

  private formatModelLabel(providerName: string, modelName: string): string {
    return `${providerName}/${modelName}`
  }
}
