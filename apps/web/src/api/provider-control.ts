import { loadConfig } from '@zero-os/core'
import type { ModelPoolConfig } from '@zero-os/shared'
import { readYaml, writeYaml } from '@zero-os/shared/utils'
import { GitOps } from '@zero-os/supervisor'
import type { ZeroOS } from '../../../server/src/main'
import { getProviderConfigPath } from '../../../server/src/oauth/provider/provider-config'
import { ChatGptUsageService } from '../../../server/src/providers/chatgpt/usage'
import { ClaudeUsageService } from '../../../server/src/providers/claude/usage'
import {
  createManagedOAuthCoordinator,
  getManagedOAuthKindForProvider,
  isManagedOAuthProvider,
  isManagedOAuthTokenRef,
  prepareManagedOAuthProvider,
  syncManagedOAuthCoordinator,
} from '../../../server/src/providers/managed-oauth'

const MODEL_POOL_STRATEGIES = new Set([
  'sticky_quota_aware_failover',
  'sticky_priority_failover',
  'priority_failover',
])

const CONFIG_KEY_MAP: Record<string, string> = {
  defaultModel: 'default_model',
  fallbackChain: 'fallback_chain',
  modelRoutes: 'model_routes',
  taskClosureModel: 'task_closure_model',
  contextCompactionModel: 'context_compaction_model',
}

export class ProviderControlService {
  private managedOAuth: ReturnType<typeof createManagedOAuthCoordinator> | undefined
  private catalogOAuthReady = new Set<string>()

  constructor(private readonly zero: ZeroOS) {}

  readCurrentConfig() {
    return loadConfig(getProviderConfigPath())
  }

  private getManagedOAuth(config?: ReturnType<typeof loadConfig>) {
    if (!this.managedOAuth) {
      this.managedOAuth = createManagedOAuthCoordinator(this.zero.vault, config)
      return this.managedOAuth
    }
    if (config) {
      syncManagedOAuthCoordinator(this.managedOAuth, config)
    }
    return this.managedOAuth
  }

  async getConfig() {
    const config = this.readCurrentConfig()
    return {
      providers: await this.buildProvidersForConfig(),
      modelPools: config.modelPools ?? {},
      runtimeModelPools: this.buildRuntimeModelPools(),
      modelRoutes: config.modelRoutes ?? {},
      modelCatalog: this.buildModelCatalogView(),
      defaultModel: this.normalizeRuntimeModelReference(config.defaultModel),
      fallbackChain: config.fallbackChain.map((model) =>
        this.normalizeRuntimeModelReference(model),
      ),
      schedules: config.schedules,
      fuseList: config.fuseList,
      taskClosureModel: config.taskClosureModel
        ? this.normalizeRuntimeModelReference(config.taskClosureModel)
        : null,
      contextCompactionModel: config.contextCompactionModel
        ? this.normalizeRuntimeModelReference(config.contextCompactionModel)
        : null,
      secrets: this.zero.vault.keys().map((key) => ({
        key,
        masked: isManagedOAuthTokenRef(key, config) ? 'oauth:configured' : 'configured',
        configured: true,
      })),
    }
  }

  async updateConfig(body: Record<string, unknown>) {
    const configPath = getProviderConfigPath()
    updateProviderConfigFile(configPath, body)
    await this.zero.reloadModelProviders()
    const updated = this.readCurrentConfig()
    return {
      ok: true,
      defaultModel: this.normalizeRuntimeModelReference(updated.defaultModel),
      fallbackChain: updated.fallbackChain.map((model) =>
        this.normalizeRuntimeModelReference(model),
      ),
      modelPools: updated.modelPools ?? {},
      runtimeModelPools: this.buildRuntimeModelPools(),
      modelRoutes: updated.modelRoutes ?? {},
      taskClosureModel: updated.taskClosureModel
        ? this.normalizeRuntimeModelReference(updated.taskClosureModel)
        : null,
      contextCompactionModel: updated.contextCompactionModel
        ? this.normalizeRuntimeModelReference(updated.contextCompactionModel)
        : null,
    }
  }

  async startOAuth(provider: string) {
    this.catalogOAuthReady.delete(provider)
    let currentConfig = this.readCurrentConfig()
    let oauth = this.getManagedOAuth(currentConfig)
    if (isManagedOAuthProvider(provider) && !currentConfig.providers[provider]) {
      prepareManagedOAuthProvider(provider)
      await this.zero.reloadModelProviders()
      currentConfig = this.readCurrentConfig()
      oauth = this.getManagedOAuth(currentConfig)
    }
    if (!oauth.supportsProvider(provider)) {
      if (!isManagedOAuthProvider(provider)) {
        return undefined
      }
      prepareManagedOAuthProvider(provider)
      await this.zero.reloadModelProviders()
      currentConfig = this.readCurrentConfig()
      oauth = this.getManagedOAuth(currentConfig)
    }
    const result = await oauth.start(provider)
    return { ...result, status: oauth.getStatus(provider) }
  }

  async startChatGptOAuth() {
    this.catalogOAuthReady.delete('chatgpt')
    prepareManagedOAuthProvider('chatgpt')
    await this.zero.reloadModelProviders()
    const oauth = this.getManagedOAuth(this.readCurrentConfig())
    const result = await oauth.start('chatgpt')
    return { ...result, status: oauth.getStatus('chatgpt') }
  }

  async getOAuthStatus(provider: string, refresh?: string) {
    const oauth = this.getManagedOAuth(this.readCurrentConfig())
    if (!oauth.supportsProvider(provider)) return undefined

    const status =
      refresh === 'soft'
        ? await oauth.getStatusWithRefresh(provider)
        : refresh === 'hard'
          ? await oauth.getStatusWithRefresh(provider, { strict: true, force: true })
          : oauth.getStatus(provider)
    if (refresh === 'hard' && status.state === 'connected') {
      this.markProviderAuthRecovered(provider, 'oauth_status_hard_refresh')
    }
    if (
      status.state === 'connected' &&
      status.authorized &&
      !this.catalogOAuthReady.has(provider)
    ) {
      this.catalogOAuthReady.add(provider)
      void this.zero.modelRouter
        .refreshCatalog({
          reason: 'oauth_connected',
          providerNames: [provider],
          force: true,
        })
        .then((result) => {
          if (result.errors.length > 0) this.catalogOAuthReady.delete(provider)
        })
        .catch(() => this.catalogOAuthReady.delete(provider))
    }
    return status
  }

  async fetchManagedOAuthUsage(providerName: string) {
    const config = this.readCurrentConfig()
    const provider = config.providers[providerName]
    const kind = provider
      ? getManagedOAuthKindForProvider(providerName, provider.auth.managedOAuthProvider)
      : undefined
    const tokenRef = provider?.auth.oauthTokenRef
    if (kind && provider && tokenRef) {
      switch (kind) {
        case 'chatgpt': {
          const usage = await new ChatGptUsageService(this.zero.vault, {
            providerName,
            tokenRef,
            baseUrl: provider.baseUrl,
          }).fetchUsage()
          return { provider: providerName, usage }
        }
        case 'anthropic': {
          const usage = await new ClaudeUsageService(this.zero.vault, {
            providerName,
            tokenRef,
          }).fetchUsage()
          return { provider: providerName, usage }
        }
        case 'x-premium':
          return { provider: providerName, usage: null }
      }
    }

    if (!isManagedOAuthProvider(providerName)) {
      throw new Error('Unsupported OAuth provider')
    }

    switch (providerName) {
      case 'chatgpt': {
        const usage = await new ChatGptUsageService(this.zero.vault).fetchUsage()
        return { provider: providerName, usage }
      }
      case 'anthropic': {
        const usage = await new ClaudeUsageService(this.zero.vault).fetchUsage()
        return { provider: providerName, usage }
      }
      case 'x-premium':
        return { provider: providerName, usage: null }
    }
  }

  listProviderHealth() {
    return { providers: this.zero.providerHealth.list() }
  }

  getModelCatalog() {
    return this.buildModelCatalogView()
  }

  async refreshModelCatalog(providerName: string) {
    const result = await this.zero.modelRouter.refreshCatalog({
      reason: 'manual',
      providerNames: [providerName],
      force: true,
    })
    if (!result.providerNames.includes(providerName)) return undefined
    return { ...result, catalog: this.buildModelCatalogView() }
  }

  async reloadModelProviders(body: Record<string, unknown>) {
    const recoveredProviders = normalizeRecoveredProviders(
      body.recoveredProviders ?? body.recoveredProvider,
    )
    await this.zero.reloadModelProviders({ recoveredProviders })
    this.getManagedOAuth(this.readCurrentConfig())
    return { ok: true, recoveredProviders }
  }

  saveSecret(key: string, value: string) {
    this.zero.vault.set(key, value)
    this.refreshCatalogForSecretRef(key)
    return { ok: true, key }
  }

  deleteSecret(key: string) {
    this.zero.vault.delete(key)
    this.refreshCatalogForSecretRef(key)
    return { ok: true, key }
  }

  async rollbackConfig(cwd: string) {
    const gitOps = new GitOps(cwd)
    const lastTag = await gitOps.getLastStableTag()
    if (!lastTag) return undefined
    await gitOps.rollbackToTag(lastTag)
    return { ok: true, rolledBackTo: lastTag }
  }

  async getLastStableTag(cwd: string) {
    const gitOps = new GitOps(cwd)
    const tag = await gitOps.getLastStableTag()
    return { tag }
  }

  private async buildProvidersForConfig() {
    const config = this.readCurrentConfig()
    const managedOAuth = this.getManagedOAuth(config)
    const listedModels = this.zero.modelRouter
      .getRegistry()
      .listModels()
      .filter((model) => model.source !== 'pool')
    return Object.fromEntries(
      await Promise.all(
        Object.entries(config.providers).map(async ([name, provider]) => {
          const secretRef = provider.auth.apiKeyRef ?? provider.auth.oauthTokenRef
          const configured = secretRef ? !!this.zero.vault.get(secretRef) : false
          const oauthStatus = managedOAuth.supportsProvider(name)
            ? managedOAuth.getStatus(name)
            : undefined
          const models = Object.fromEntries(
            listedModels
              .filter((model) => model.providerName === name)
              .flatMap((model) => {
                const resolved = this.zero.modelRouter.resolveModel(`${name}/${model.modelName}`)
                if (!resolved) return []
                return [
                  [
                    model.modelName,
                    {
                      ...resolved.modelConfig,
                      source: model.source,
                      status: model.status,
                      displayName: model.displayName,
                      family: model.family,
                      version: model.version,
                      lane: model.lane,
                    },
                  ],
                ]
              }),
          )

          return [
            name,
            {
              apiType: provider.apiType,
              baseUrl: provider.baseUrl,
              authType: provider.auth.type,
              managedOAuthProvider: provider.auth.managedOAuthProvider,
              secretRef,
              configured,
              authorized: oauthStatus ? oauthStatus.authorized : configured,
              oauthState: oauthStatus?.state,
              requiresRestart: oauthStatus?.requiresRestart ?? false,
              models,
            },
          ]
        }),
      ),
    )
  }

  private markProviderAuthRecovered(providerName: string, source: string) {
    if (providerName in this.zero.config.providers) {
      this.zero.providerHealth.markAuthRecovered(providerName, { source })
    }
  }

  private refreshCatalogForSecretRef(secretRef: string) {
    const providerNames = Object.entries(this.readCurrentConfig().providers)
      .filter(([, provider]) => {
        return provider.auth.oauthTokenRef === secretRef || provider.auth.apiKeyRef === secretRef
      })
      .map(([providerName]) => providerName)
    if (providerNames.length === 0) return
    for (const providerName of providerNames) this.catalogOAuthReady.delete(providerName)
    void this.zero.modelRouter.refreshCatalog({
      reason: 'oauth_connected',
      providerNames,
      force: true,
    })
  }

  private buildModelCatalogView() {
    const snapshot = this.zero.modelRouter.getCatalogSnapshot()
    return {
      generation: snapshot?.generation ?? 0,
      updatedAt: snapshot?.updatedAt ?? null,
      entries: this.zero.modelRouter.getCatalogEntries().map((entry) => ({
        providerName: entry.providerName,
        modelName: entry.modelName,
        modelId: entry.modelId,
        displayName: entry.displayName,
        family: entry.family,
        version: entry.version,
        lane: entry.lane,
        status: entry.status,
        source: entry.source,
        maxContext: entry.modelConfig.maxContext,
        maxOutput: entry.modelConfig.maxOutput,
        capabilities: entry.modelConfig.capabilities,
        defaultReasoningEffort: entry.modelConfig.reasoningEffort,
        supportedReasoningEfforts: entry.modelConfig.supportedReasoningEfforts ?? [],
        discoveredAt: entry.discoveredAt,
        verifiedAt: entry.verifiedAt ?? null,
        lastSeenAt: entry.lastSeenAt,
        lastError: entry.lastError ?? null,
      })),
    }
  }

  private buildRuntimeModelPools() {
    return Object.fromEntries(
      this.zero.modelRouter
        .getRegistry()
        .listModelPools()
        .map((pool) => [
          pool.name,
          {
            source: pool.source,
            strategy: pool.strategy,
            members: pool.members,
          },
        ]),
    )
  }

  private normalizeRuntimeModelReference(model: string): string {
    if (model.startsWith('route/')) return model
    return this.zero.modelRouter.normalizeModelReference(model) ?? model
  }
}

export function normalizeModelPoolsForWrite(value: unknown): Record<string, ModelPoolConfig> {
  if (value === null || value === undefined || value === '') return {}
  if (!isRecord(value)) {
    throw new Error('modelPools must be an object')
  }

  const pools: Record<string, ModelPoolConfig> = {}
  for (const [rawName, rawPool] of Object.entries(value)) {
    const name = rawName.trim()
    if (!name) continue
    if (!isRecord(rawPool)) {
      throw new Error(`Model pool ${name} must be an object`)
    }

    const rawStrategy = rawPool.strategy
    const strategy: ModelPoolConfig['strategy'] =
      typeof rawStrategy === 'string' && MODEL_POOL_STRATEGIES.has(rawStrategy)
        ? (rawStrategy as ModelPoolConfig['strategy'])
        : 'sticky_quota_aware_failover'
    const rawMembers = Array.isArray(rawPool.members) ? rawPool.members : []
    const members: ModelPoolConfig['members'] = []
    for (const [index, member] of rawMembers.entries()) {
      if (typeof member === 'string') {
        const model = member.trim()
        if (model) members.push({ model, priority: index })
        continue
      }
      if (!isRecord(member) || typeof member.model !== 'string') continue
      const model = member.model.trim()
      if (!model) continue
      members.push({
        model,
        priority: typeof member.priority === 'number' ? member.priority : index,
      })
    }

    if (members.length === 0) {
      throw new Error(`Model pool ${name} must include at least one member`)
    }
    pools[name] = { strategy, members }
  }

  return pools
}

export function normalizeRecoveredProviders(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value]
  return Array.from(
    new Set(
      values
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item.length > 0),
    ),
  )
}

export function applyProviderConfigUpdate(
  rawConfig: Record<string, unknown>,
  body: Record<string, unknown>,
): Record<string, unknown> {
  let nextConfig = rawConfig

  for (const [key, value] of Object.entries(body)) {
    if (key === 'runtimeModelPools') continue
    if (key === 'modelPools') {
      const modelPools = normalizeModelPoolsForWrite(value)
      if (Object.keys(modelPools).length === 0) {
        nextConfig = omitConfigKey(nextConfig, 'model_pools')
      } else {
        nextConfig.model_pools = modelPools
      }
      continue
    }

    const yamlKey = CONFIG_KEY_MAP[key] ?? key
    if (value === null || value === '') {
      delete nextConfig[yamlKey]
    } else {
      nextConfig[yamlKey] = value
    }
  }

  return nextConfig
}

function updateProviderConfigFile(configPath: string, body: Record<string, unknown>): void {
  const raw = readYaml<Record<string, unknown>>(configPath)
  writeYaml(configPath, applyProviderConfigUpdate(raw, body))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function omitConfigKey(config: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _omitted, ...rest } = config
  return rest
}
