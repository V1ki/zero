import type { SystemConfig } from '@zero-os/shared'
import type { ProviderAdapter } from './adapters/base'
import { ModelRegistry, type ModelRegistryOptions, type ResolvedModel } from './registry'

export interface ModelSwitchResult {
  success: boolean
  model?: ResolvedModel
  message: string
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

  constructor(
    config: SystemConfig,
    secrets: Map<string, string>,
    options: ModelRegistryOptions = {},
  ) {
    this.registry = new ModelRegistry(config, secrets, options)
    this.fallbackChain = config.fallbackChain
    this.defaultModel = config.defaultModel
  }

  reload(
    config: SystemConfig,
    secrets: Map<string, string>,
    options: ModelRegistryOptions = {},
  ): void {
    const currentLabel = this.currentModel ? this.getModelLabel(this.currentModel) : undefined
    this.registry = new ModelRegistry(config, secrets, options)
    this.fallbackChain = config.fallbackChain
    this.defaultModel = config.defaultModel
    this.currentModel =
      this.registry.resolve(currentLabel ?? this.defaultModel) ??
      this.registry.resolve(this.defaultModel)
  }

  /**
   * Initialize router with the default model.
   */
  init(): ModelSwitchResult {
    return this.switchModel(this.defaultModel)
  }

  /**
   * Resolve a model reference without mutating router state.
   */
  resolveModel(target: string): ResolvedModel | undefined {
    return this.registry.resolve(target)
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
    const exact = this.registry.resolve(target)
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
    const available = this.registry
      .listModels()
      .map((m) => `  - ${this.formatModelLabel(m.providerName, m.modelName)}`)
      .join('\n')
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
      const resolved = this.registry.resolve(modelName)
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
}
