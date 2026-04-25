import type { ApiType, ModelConfig, ProviderConfig, SystemConfig } from '@zero-os/shared'
import { AnthropicAdapter } from './adapters/anthropic'
import { AnthropicDeepSeekAdapter } from './adapters/anthropic-deepseek'
import type { AdapterConfig, OAuthTokenRefresher, ProviderAdapter } from './adapters/base'
import { OpenAIChatAdapter } from './adapters/openai-chat'
import { OpenAIResponsesAdapter } from './adapters/openai-resp'
import { TrackedAdapter, type UsageRecorder } from './adapters/tracked'
import { LiteLLMPricing } from './pricing'

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
}

/**
 * Model Registry - parses config and creates adapters on demand.
 */
export class ModelRegistry {
  private providers: Map<string, ProviderConfig> = new Map()
  private adapters: Map<string, ProviderAdapter> = new Map()
  private secrets: Map<string, string>
  private secretGetter: SecretGetter
  private oauthRefreshers: Record<string, OAuthTokenRefresher | undefined>
  private usageRecorder?: UsageRecorder

  constructor(
    config: SystemConfig,
    secrets: Map<string, string>,
    options: ModelRegistryOptions = {},
  ) {
    this.secrets = secrets
    this.secretGetter = options.secretGetter ?? ((ref) => this.secrets.get(ref))
    this.oauthRefreshers = options.oauthRefreshers ?? {}
    this.usageRecorder = options.usageRecorder
    for (const [name, provider] of Object.entries(config.providers)) {
      this.providers.set(name, provider)
    }
  }

  /**
   * Resolve a model name to its full configuration and adapter.
   * Searches across all providers.
   */
  resolve(modelName: string): ResolvedModel | undefined {
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
      default:
        throw new Error(`Unsupported API type: ${apiType}`)
    }
  }
}
