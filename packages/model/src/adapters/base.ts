import type {
  AuthConfig,
  CompletionRequest,
  CompletionResponse,
  ModelConfig,
  StreamEvent,
} from '@zero-os/shared'

export type { CompletionRequest, CompletionResponse, StreamEvent }

export type OAuthRefreshReason = 'expiring' | 'unauthorized'
export type OAuthTokenProvider = () => string | undefined
export type OAuthTokenRefresher = (reason: OAuthRefreshReason) => Promise<void>

/**
 * Unified provider adapter interface.
 * All provider adapters must implement this interface.
 */
export interface ProviderAdapter {
  readonly apiType: string

  /**
   * Whether `complete()` uses a transport distinct from `stream()` and can therefore act as a
   * meaningful fallback after a stream failure. Defaults to true when omitted; wrappers must
   * preserve or conservatively aggregate the inner adapters' value.
   */
  readonly supportsNonStreamingFallback?: boolean

  /**
   * Send a completion request and return the full response.
   */
  complete(req: CompletionRequest): Promise<CompletionResponse>

  /**
   * Send a streaming completion request.
   */
  stream(req: CompletionRequest): AsyncIterable<StreamEvent>

  /**
   * Check if the API endpoint is reachable.
   */
  healthCheck(): Promise<boolean>
}

/**
 * Configuration needed to create an adapter.
 */
export interface AdapterConfig {
  providerName?: string
  managedOAuthProvider?: string
  baseUrl: string
  auth: AuthConfig
  modelConfig: ModelConfig
  apiKey?: string
  oauthToken?: string
  oauthTokenProvider?: OAuthTokenProvider
  oauthTokenRefresher?: OAuthTokenRefresher
}
