export interface ProviderView {
  apiType: string
  baseUrl: string
  authType?: string
  managedOAuthProvider?: 'chatgpt' | 'anthropic' | 'x-premium'
  secretRef?: string
  configured?: boolean
  authorized?: boolean
  oauthState?: string
  requiresRestart?: boolean
  models: Record<
    string,
    {
      modelId: string
      maxContext: number
      maxOutput: number
      capabilities: string[]
      tags: string[]
    }
  >
}

interface ClaudeRateLimitWindow {
  utilization: number | null
  resets_at: string | null
}

interface ClaudeExtraUsageWindow {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
}

export interface ClaudeUsageSnapshot {
  five_hour?: ClaudeRateLimitWindow | null
  seven_day?: ClaudeRateLimitWindow | null
  seven_day_oauth_apps?: ClaudeRateLimitWindow | null
  seven_day_opus?: ClaudeRateLimitWindow | null
  seven_day_sonnet?: ClaudeRateLimitWindow | null
  extra_usage?: ClaudeExtraUsageWindow | null
}

interface ChatGptUsageWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

interface ChatGptCreditsSnapshot {
  hasCredits: boolean
  unlimited: boolean
  balance: string | null
}

interface ChatGptRateLimitSnapshot {
  limitId: string | null
  limitName: string | null
  primary: ChatGptUsageWindow | null
  secondary: ChatGptUsageWindow | null
  credits: ChatGptCreditsSnapshot | null
  planType: string | null
}

export interface ChatGptUsageSnapshot {
  rateLimits: ChatGptRateLimitSnapshot
  rateLimitsByLimitId: Record<string, ChatGptRateLimitSnapshot> | null
}

export type ModelPoolStrategy =
  | 'sticky_quota_aware_failover'
  | 'sticky_priority_failover'
  | 'priority_failover'

interface ModelPoolMemberView {
  model: string
  priority?: number
}

export interface ModelPoolView {
  strategy: ModelPoolStrategy
  members: ModelPoolMemberView[]
}

export interface ModelPoolDraftMember {
  id: string
  model: string
}

export interface ModelPoolDraft {
  id: string
  name: string
  strategy: ModelPoolStrategy
  members: ModelPoolDraftMember[]
}

export interface ConfigData {
  providers: Record<string, ProviderView>
  modelPools: Record<string, ModelPoolView>
  defaultModel: string
  fallbackChain: string[]
  schedules: { name: string; cron: string; task: string }[]
  fuseList: { pattern: string; description: string }[]
  taskClosureModel: string | null
  contextCompactionModel: string | null
  secrets?: { key: string; masked: string; configured: boolean }[]
}

export interface ChannelConfig {
  name: string
  type: string
  status: string
  secrets: { key: string; configured: boolean }[]
  codePath: string
}

export type ConfigTab = 'models' | 'scheduler' | 'fuse' | 'secrets' | 'channels' | 'version'

export const MODEL_POOL_STRATEGIES: { value: ModelPoolStrategy; label: string }[] = [
  { value: 'sticky_quota_aware_failover', label: 'Sticky quota-aware' },
  { value: 'sticky_priority_failover', label: 'Sticky priority' },
  { value: 'priority_failover', label: 'Priority failover' },
]

export const CONFIG_TABS: { key: ConfigTab; label: string }[] = [
  { key: 'models', label: 'Models' },
  { key: 'scheduler', label: 'Scheduler' },
  { key: 'fuse', label: 'Fuse List' },
  { key: 'secrets', label: 'Secrets' },
  { key: 'channels', label: 'Channels' },
  { key: 'version', label: 'Version' },
]

export function getOAuthKind(name: string, provider: ProviderView) {
  if (provider.managedOAuthProvider) return provider.managedOAuthProvider
  if (name === 'chatgpt' || name.startsWith('chatgpt-')) return 'chatgpt'
  if (name === 'anthropic' || name.startsWith('anthropic-')) return 'anthropic'
  if (name === 'x-premium' || name.startsWith('x-premium-')) return 'x-premium'
  return undefined
}

export function createDraftId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function createModelPoolDrafts(
  modelPools: Record<string, ModelPoolView> = {},
): ModelPoolDraft[] {
  return Object.entries(modelPools).map(([name, pool], poolIndex) => ({
    id: `pool-${poolIndex}-${name}`,
    name,
    strategy: pool.strategy,
    members: [...pool.members]
      .sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0))
      .map((member, memberIndex) => ({
        id: `member-${poolIndex}-${memberIndex}-${member.model}`,
        model: member.model,
      })),
  }))
}

export function serializeModelPoolDrafts(drafts: ModelPoolDraft[]): Record<string, ModelPoolView> {
  const pools: Record<string, ModelPoolView> = {}
  for (const draft of drafts) {
    const name = draft.name.trim()
    if (!name) continue
    pools[name] = {
      strategy: draft.strategy,
      members: draft.members
        .map((member, index) => ({
          model: member.model.trim(),
          priority: index,
        }))
        .filter((member) => member.model),
    }
  }
  return pools
}
