import type { SessionSource } from './session'

export type ApiType = 'anthropic_messages' | 'openai_chat_completions' | 'openai_responses'

export type AuthType = 'api_key' | 'oauth2'

export interface AuthConfig {
  type: AuthType
  apiKeyRef?: string
  oauthTokenRef?: string
  oauth?: OAuthConfig
}

export interface OAuthConfig {
  authorizationUrl: string
  tokenUrl: string
  clientId: string
  clientSecretRef?: string
  scopes: string[]
  redirectUri: string
}

export interface ModelPricing {
  input: number
  output: number
  cacheWrite?: number
  cacheRead?: number
}

export interface ModelCapability {
  name: string
}

export interface ModelConfig {
  modelId: string
  maxContext: number
  maxOutput: number
  thinkingTokens?: number
  capabilities: string[]
  tags: string[]
  pricing?: ModelPricing
}

export interface ProviderConfig {
  apiType: ApiType
  baseUrl: string
  auth: AuthConfig
  models: Record<string, ModelConfig>
}

export interface ScheduleOverlapPolicy {
  type: 'skip' | 'queue' | 'replace'
}

export interface ScheduleChannelBinding {
  source: SessionSource
  channelName: string
  channelId: string
}

export interface ScheduleConfig {
  name: string
  cron: string
  instruction: string
  model?: string
  overlapPolicy?: ScheduleOverlapPolicy
  misfirePolicy?: 'skip' | 'run_once'
  channel?: ScheduleChannelBinding
  oneShot?: boolean
  createdBy?: 'config' | 'runtime'
}

export interface FuseRule {
  pattern: string
  description: string
}

export interface BaseChannelInstanceConfig {
  name: string
  type: 'feishu' | 'telegram' | 'web'
  enabled?: boolean
  receiveNotifications?: boolean
}

export interface FeishuChannelInstanceConfig extends BaseChannelInstanceConfig {
  type: 'feishu'
  appIdRef: string
  appSecretRef: string
  encryptKeyRef?: string
  verificationTokenRef?: string
}

export interface TelegramChannelInstanceConfig extends BaseChannelInstanceConfig {
  type: 'telegram'
  botTokenRef: string
}

export interface WebChannelInstanceConfig extends BaseChannelInstanceConfig {
  type: 'web'
}

export type ChannelInstanceConfig =
  | FeishuChannelInstanceConfig
  | TelegramChannelInstanceConfig
  | WebChannelInstanceConfig

export interface EmbeddingModelConfig {
  baseUrl: string
  apiKeyRef: string
  model: string
  dimensions?: number
}

export interface SystemConfig {
  providers: Record<string, ProviderConfig>
  defaultModel: string
  fallbackChain: string[]
  schedules: ScheduleConfig[]
  fuseList: FuseRule[]
  channels?: ChannelInstanceConfig[]
  taskClosureModel?: string
  embedding?: EmbeddingModelConfig
}

export interface SecretFilter {
  filter(text: string): string
  addSecret(key: string, value: string): void
  removeSecret(key: string): void
}
