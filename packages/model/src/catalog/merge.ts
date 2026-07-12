import type { ProviderConfig, SystemConfig } from '@zero-os/shared'
import type { ModelCatalogEntry } from './types'

export function mergeCatalogIntoConfig(
  config: SystemConfig,
  catalogEntries: ModelCatalogEntry[],
): SystemConfig {
  if (catalogEntries.length === 0) return config

  const providers = Object.fromEntries(
    Object.entries(config.providers).map(([providerName, provider]) => [
      providerName,
      cloneProvider(provider),
    ]),
  )

  for (const entry of catalogEntries) {
    if (entry.status !== 'verified' && entry.status !== 'stale') continue
    const provider = providers[entry.providerName]
    if (!provider) continue
    if (
      Object.entries(provider.models).some(
        ([name, model]) => name === entry.modelName || model.modelId === entry.modelId,
      )
    ) {
      continue
    }

    const name = resolveAvailableModelName(provider, entry)
    if (!name) continue
    provider.models[name] = structuredClone(entry.modelConfig)
  }

  return { ...config, providers }
}

function cloneProvider(provider: ProviderConfig): ProviderConfig {
  return {
    ...provider,
    auth: { ...provider.auth },
    models: Object.fromEntries(
      Object.entries(provider.models).map(([name, model]) => [name, structuredClone(model)]),
    ),
    ...(provider.discovery ? { discovery: structuredClone(provider.discovery) } : {}),
  }
}

function resolveAvailableModelName(
  provider: ProviderConfig,
  entry: ModelCatalogEntry,
): string | undefined {
  if (!provider.models[entry.modelName]) return entry.modelName
  if (!provider.models[entry.modelId]) return entry.modelId
  return undefined
}
