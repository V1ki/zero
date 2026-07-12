import { join } from 'node:path'
import {
  ChatGptCodexDiscoveryDriver,
  LiteLLMPricing,
  ModelCatalogCoordinator,
  ModelCatalogStore,
  ModelRouter,
  ProviderHealthRegistry,
} from '@zero-os/model'
import type { MetricsDB } from '@zero-os/observe'
import type { Vault } from '@zero-os/secrets'
import type { SystemConfig } from '@zero-os/shared'
import { createUsageRecorder } from '../observability'
import { createOAuthRefreshers, createProviderRecoveryResolver } from './recovery'

export interface ModelRouterRuntime {
  litellmPricing: LiteLLMPricing
  usageRecorder: ReturnType<typeof createUsageRecorder>
  providerHealth: ProviderHealthRegistry
  modelRouter: ModelRouter
}

export async function createModelRouterRuntime(options: {
  zeroDir: string
  config: SystemConfig
  vault: Vault
  metrics: MetricsDB
}): Promise<ModelRouterRuntime> {
  const { zeroDir, config, vault, metrics } = options
  const litellmPricing = LiteLLMPricing.init(`${zeroDir}/cache`)
  await litellmPricing.ensureLoaded()
  litellmPricing.startRefresh()
  console.log('[ZeRo OS] LiteLLM pricing fallback initialized')

  const usageRecorder = createUsageRecorder(metrics)
  const providerHealth = new ProviderHealthRegistry({
    recoveryResolver: createProviderRecoveryResolver(() => config, vault),
  })
  const catalog = new ModelCatalogCoordinator({
    config,
    secretGetter: (ref) => vault.get(ref) ?? undefined,
    store: new ModelCatalogStore(join(zeroDir, 'cache', 'model-catalog', 'catalog.json')),
    drivers: [new ChatGptCodexDiscoveryDriver()],
  })
  await catalog.initialize()
  const modelRouter = new ModelRouter(config, new Map(vault.entries()), {
    secretGetter: (ref) => vault.get(ref) ?? undefined,
    usageRecorder,
    oauthRefreshers: createOAuthRefreshers(config, vault),
    providerHealth,
    catalog,
  })
  const initResult = modelRouter.init()
  console.log(`[ZeRo OS] Model Router: ${initResult.message}`)
  modelRouter.startCatalogAutoRefresh()
  void modelRouter.refreshCatalog({ reason: 'startup' }).then((result) => {
    if (result.changed || result.errors.length > 0) {
      console.log(
        `[ZeRo OS] Model Catalog: ${result.verified} verified, ${result.unavailable} unavailable, ${result.errors.length} errors`,
      )
    }
  })

  return {
    litellmPricing,
    usageRecorder,
    providerHealth,
    modelRouter,
  }
}
