import type { ReasoningEffort } from './reasoning'
import type { SessionSource } from './session'

export type ApiType =
  | 'anthropic_messages'
  | 'anthropic-deepseek'
  | 'openai_chat_completions'
  | 'openai_responses'
  | 'x_responses'

export type AuthType = 'api_key' | 'oauth2'
export type ManagedOAuthProviderKind = 'chatgpt' | 'anthropic' | 'x-premium'

export interface AuthConfig {
  type: AuthType
  apiKeyRef?: string
  oauthTokenRef?: string
  managedOAuthProvider?: ManagedOAuthProviderKind
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
  reasoningEffort?: ReasoningEffort
  thinkingTokens?: number
  extraBody?: Record<string, unknown>
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

export type ModelPoolStrategy =
  | 'sticky_quota_aware_failover'
  | 'sticky_priority_failover'
  | 'priority_failover'

export interface ModelPoolMemberConfig {
  model: string
  priority?: number
}

export interface ModelPoolConfig {
  strategy: ModelPoolStrategy
  members: ModelPoolMemberConfig[]
}

export interface ScheduleOverlapPolicy {
  type: 'skip' | 'queue' | 'replace'
}

export interface ScheduleChannelBinding {
  source: SessionSource
  channelName: string
  channelId: string
  participantId?: string
  deliveryChannelId?: string
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
  type: 'dingtalk' | 'feishu' | 'telegram' | 'web' | 'weixin'
  enabled?: boolean
  receiveNotifications?: boolean
}

export interface DingtalkChannelInstanceConfig extends BaseChannelInstanceConfig {
  type: 'dingtalk'
  clientIdRef: string
  clientSecretRef: string
  robotCodeRef?: string
  debug?: boolean
  keepAlive?: boolean
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
  streaming?: boolean
}

export interface WebChannelInstanceConfig extends BaseChannelInstanceConfig {
  type: 'web'
}

export interface WeixinChannelInstanceConfig extends BaseChannelInstanceConfig {
  type: 'weixin'
  accountIdRef: string
  tokenRef: string
  baseUrlRef?: string
  cdnBaseUrlRef?: string
  botAgent?: string
  dmPolicy?: 'open' | 'allowlist' | 'disabled'
  groupPolicy?: 'open' | 'allowlist' | 'disabled'
  allowFrom?: string[]
  groupAllowFrom?: string[]
}

export type ChannelInstanceConfig =
  | DingtalkChannelInstanceConfig
  | FeishuChannelInstanceConfig
  | TelegramChannelInstanceConfig
  | WebChannelInstanceConfig
  | WeixinChannelInstanceConfig

export interface EmbeddingModelConfig {
  baseUrl: string
  apiKeyRef: string
  model: string
  dimensions?: number
}

export interface SystemConfig {
  providers: Record<string, ProviderConfig>
  modelPools?: Record<string, ModelPoolConfig>
  defaultModel: string
  fallbackChain: string[]
  schedules: ScheduleConfig[]
  fuseList: FuseRule[]
  channels?: ChannelInstanceConfig[]
  taskClosureModel?: string
  contextCompactionModel?: string
  embedding?: EmbeddingModelConfig
}

export interface SecretFilter {
  filter(text: string): string
  addSecret(key: string, value: string): void
  removeSecret(key: string): void
}
