export { ModelRegistry } from './registry'
export type { ListedModel, ListedModelPool, ModelPoolSource, ResolvedModel } from './registry'
export { ModelRouter } from './router'
export type { ModelRouterOptions, ModelSwitchResult } from './router'
export { OpenAIChatAdapter } from './adapters/openai-chat'
export { AnthropicAdapter, AnthropicDeepSeekAdapter } from './adapters/anthropic'
export { OpenAIResponsesAdapter } from './adapters/openai-resp'
export { XResponsesAdapter } from './adapters/x-resp'
export { ModelPoolAdapter } from './adapters/model-pool'
export type { ProviderAdapter, AdapterConfig } from './adapters/base'
export { TrackedAdapter } from './adapters/tracked'
export type { UsageRecorder } from './adapters/tracked'
export { collectStream, consumeStream } from './stream'
export { OAuth2Client } from './auth/oauth'
export type { OAuthTokens, OAuthConfig } from './auth/oauth'
export {
  parseChatGptOAuthSession,
  serializeChatGptOAuthSession,
  decodeChatGptAccountId,
  decodeChatGptTokenExpiry,
  getChatGptAuthorizationScheme,
} from './auth/chatgpt'
export type { ChatGptOAuthSession } from './auth/chatgpt'
export {
  parseClaudeOAuthSession,
  resolveClaudeOAuthAccessToken,
  serializeClaudeOAuthSession,
} from './auth/claude'
export type { ClaudeOAuthAccount, ClaudeOAuthSession } from './auth/claude'
export {
  decodeXPremiumAccount,
  decodeXPremiumTokenExpiry,
  getXPremiumAuthorizationScheme,
  parseXPremiumOAuthSession,
  serializeXPremiumOAuthSession,
} from './auth/x-premium'
export type { XPremiumOAuthAccount, XPremiumOAuthSession } from './auth/x-premium'
export { computeCost } from './cost'
export { LiteLLMPricing } from './pricing'
export { ProviderHealthRegistry } from './provider-health'
export type {
  ProviderHealthRecord,
  ProviderHealthState,
  ProviderRecoveryHint,
  ProviderRecoveryResolver,
} from './provider-health'
export { ModelCatalogCoordinator } from './catalog/coordinator'
export type {
  ModelCatalogCoordinatorOptions,
  RefreshModelCatalogOptions,
} from './catalog/coordinator'
export { ModelCatalogStore } from './catalog/store'
export { ChatGptCodexDiscoveryDriver, parseChatGptCodexModels } from './catalog/chatgpt-codex'
export { mergeCatalogIntoConfig } from './catalog/merge'
export type {
  DiscoveredModel,
  ModelCatalogEntry,
  ModelCatalogFieldSource,
  ModelCatalogRefreshReason,
  ModelCatalogRefreshResult,
  ModelCatalogSnapshot,
  ModelCatalogSource,
  ModelCatalogStatus,
  ModelDiscoveryContext,
  ModelDiscoveryDriver,
  ModelDiscoveryResult,
  ModelDiscoveryScope,
  ModelVerificationResult,
} from './catalog/types'
export {
  classifyRuntimeModelError,
  ModelPolicyAdapter,
  negotiateReasoningEffort,
} from './adapters/model-policy'
export type { RuntimeModelError, RuntimeModelErrorHandler } from './adapters/model-policy'

/**
 * Simple API key authentication strategy.
 * Retrieves the API key from the secrets vault.
 */
export interface ApiKeyAuth {
  type: 'api_key'
  getKey(): string | undefined
}

export function createApiKeyAuth(
  secretsGet: (ref: string) => string | undefined,
  keyRef: string,
): ApiKeyAuth {
  return {
    type: 'api_key',
    getKey() {
      return secretsGet(keyRef)
    },
  }
}
