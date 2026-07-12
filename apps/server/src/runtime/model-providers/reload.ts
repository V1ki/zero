import { type SessionManager, loadConfig } from '@zero-os/core'
import type { ModelRouter, ProviderHealthRegistry, UsageRecorder } from '@zero-os/model'
import type { Vault } from '@zero-os/secrets'
import type { SystemConfig } from '@zero-os/shared'
import type { EventBus } from '../bus'
import type { ReloadModelProvidersOptions } from '../types'
import { createOAuthRefreshers, createProviderRecoveryResolver } from './recovery'

export interface ReloadModelProvidersRuntimeOptions {
  configPath: string
  vault: Vault
  providerHealth: ProviderHealthRegistry
  modelRouter: ModelRouter
  usageRecorder: UsageRecorder
  sessionManager: SessionManager
  bus: EventBus
  setConfig(config: SystemConfig): void
}

export function createReloadModelProviders({
  configPath,
  vault,
  providerHealth,
  modelRouter,
  usageRecorder,
  sessionManager,
  bus,
  setConfig,
}: ReloadModelProvidersRuntimeOptions) {
  return async (reloadOptions: ReloadModelProvidersOptions = {}) => {
    vault.load()
    const config = loadConfig(configPath)
    const recoveredProviders = Array.from(
      new Set(
        (reloadOptions.recoveredProviders ?? []).filter(
          (providerName) => typeof providerName === 'string' && providerName in config.providers,
        ),
      ),
    )
    providerHealth.setRecoveryResolver(createProviderRecoveryResolver(() => config, vault))
    for (const providerName of recoveredProviders) {
      providerHealth.markAuthRecovered(providerName, { source: 'oauth_login_reload' })
    }
    modelRouter.reload(config, new Map(vault.entries()), {
      secretGetter: (ref) => vault.get(ref) ?? undefined,
      usageRecorder,
      oauthRefreshers: createOAuthRefreshers(config, vault),
      providerHealth,
    })
    const catalogRefresh = await modelRouter.refreshCatalog({
      reason: recoveredProviders.length > 0 ? 'oauth_connected' : 'config_reload',
      ...(recoveredProviders.length > 0 ? { providerNames: recoveredProviders } : {}),
      force: true,
    })
    sessionManager.setTaskClosureModel(config.taskClosureModel)
    sessionManager.setContextCompactionModels({
      contextCompactionModel: config.contextCompactionModel,
    })
    setConfig(config)
    bus.emit('config:update', {
      event: 'model_providers_reloaded',
      providers: Object.keys(config.providers),
      recoveredProviders,
      catalogGeneration: catalogRefresh.generation,
      catalogVerified: catalogRefresh.verified,
      catalogUnavailable: catalogRefresh.unavailable,
      catalogErrors: catalogRefresh.errors.length,
    })
  }
}
