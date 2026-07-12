import type { ApiType, ModelConfig, ProviderConfig, ReasoningEffort } from '@zero-os/shared'

export type ModelCatalogStatus =
  | 'discovered'
  | 'verifying'
  | 'verified'
  | 'unavailable'
  | 'stale'
  | 'deprecated'

export type ModelCatalogSource = 'provider' | 'trusted_catalog' | 'system_default'

export type ModelCatalogFieldSource = ModelCatalogSource | 'manual_override' | 'runtime_probe'

export interface ModelCatalogEntry {
  providerName: string
  providerKind: string
  accountFingerprint: string
  transport: string
  apiType: ApiType
  modelName: string
  modelId: string
  displayName?: string
  description?: string
  family?: string
  version?: string
  lane?: string
  modelConfig: ModelConfig
  status: ModelCatalogStatus
  source: ModelCatalogSource
  provenance: Record<string, ModelCatalogFieldSource>
  metadataHash: string
  discoveredAt: string
  verifiedAt?: string
  lastSeenAt: string
  lastError?: string
}

export interface ModelCatalogSnapshot {
  version: 1
  generation: number
  updatedAt: string
  entries: ModelCatalogEntry[]
}

export interface ModelDiscoveryScope {
  providerName: string
  providerKind: string
  accountFingerprint: string
  transport: string
  apiType: ApiType
}

export interface DiscoveredModel {
  modelName: string
  modelId: string
  displayName?: string
  description?: string
  family?: string
  version?: string
  lane?: string
  maxContext?: number
  maxOutput?: number
  capabilities?: string[]
  tags?: string[]
  defaultReasoningEffort?: ReasoningEffort
  supportedReasoningEfforts?: ReasoningEffort[]
  provenance?: Record<string, ModelCatalogFieldSource>
}

export interface ModelDiscoveryResult {
  scope: ModelDiscoveryScope
  models: DiscoveredModel[]
}

export interface ModelVerificationResult {
  ok: boolean
  reason?: string
}

export interface ModelDiscoveryContext {
  providerName: string
  provider: ProviderConfig
  secretGetter(ref: string): string | undefined
  signal: AbortSignal
}

export interface ModelDiscoveryDriver {
  readonly kind: string
  readonly defaultEnabled: boolean
  supports(providerName: string, provider: ProviderConfig): boolean
  resolveScope(context: Omit<ModelDiscoveryContext, 'signal'>): ModelDiscoveryScope | undefined
  discover(context: ModelDiscoveryContext): Promise<ModelDiscoveryResult>
  verify(
    context: ModelDiscoveryContext,
    scope: ModelDiscoveryScope,
    model: DiscoveredModel,
  ): Promise<ModelVerificationResult>
}

export type ModelCatalogRefreshReason =
  | 'startup'
  | 'oauth_connected'
  | 'ttl'
  | 'runtime_model_error'
  | 'manual'
  | 'config_reload'

export interface ModelCatalogRefreshResult {
  reason: ModelCatalogRefreshReason
  providerNames: string[]
  changed: boolean
  discovered: number
  verified: number
  unavailable: number
  errors: Array<{ providerName: string; message: string }>
  generation: number
}
