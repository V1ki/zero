import { Eye, EyeSlash, FloppyDisk, Plus, Trash } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { ConfirmDialog } from '../components/shared/ConfirmDialog'
import { SkeletonCard } from '../components/shared/Skeleton'
import { apiFetch, apiPost, apiPut } from '../lib/api'
import { useUIStore } from '../stores/ui'

interface ProviderView {
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

interface ClaudeUsageSnapshot {
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

interface ChatGptUsageSnapshot {
  rateLimits: ChatGptRateLimitSnapshot
  rateLimitsByLimitId: Record<string, ChatGptRateLimitSnapshot> | null
}

type ModelPoolStrategy =
  | 'sticky_quota_aware_failover'
  | 'sticky_priority_failover'
  | 'priority_failover'

interface ModelPoolMemberView {
  model: string
  priority?: number
}

interface ModelPoolView {
  strategy: ModelPoolStrategy
  members: ModelPoolMemberView[]
}

interface ModelPoolDraftMember {
  id: string
  model: string
}

interface ModelPoolDraft {
  id: string
  name: string
  strategy: ModelPoolStrategy
  members: ModelPoolDraftMember[]
}

interface ConfigData {
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

interface ChannelConfig {
  name: string
  type: string
  status: string
  secrets: { key: string; configured: boolean }[]
  codePath: string
}

type Tab = 'models' | 'scheduler' | 'fuse' | 'secrets' | 'channels' | 'version'

const MODEL_POOL_STRATEGIES: { value: ModelPoolStrategy; label: string }[] = [
  { value: 'sticky_quota_aware_failover', label: 'Sticky quota-aware' },
  { value: 'sticky_priority_failover', label: 'Sticky priority' },
  { value: 'priority_failover', label: 'Priority failover' },
]

const TABS: { key: Tab; label: string }[] = [
  { key: 'models', label: 'Models' },
  { key: 'scheduler', label: 'Scheduler' },
  { key: 'fuse', label: 'Fuse List' },
  { key: 'secrets', label: 'Secrets' },
  { key: 'channels', label: 'Channels' },
  { key: 'version', label: 'Version' },
]

function getOAuthKind(name: string, provider: ProviderView) {
  if (provider.managedOAuthProvider) return provider.managedOAuthProvider
  if (name === 'chatgpt' || name.startsWith('chatgpt-')) return 'chatgpt'
  if (name === 'anthropic' || name.startsWith('anthropic-')) return 'anthropic'
  if (name === 'x-premium' || name.startsWith('x-premium-')) return 'x-premium'
  return undefined
}

function createDraftId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function createModelPoolDrafts(modelPools: Record<string, ModelPoolView> = {}): ModelPoolDraft[] {
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

function serializeModelPoolDrafts(drafts: ModelPoolDraft[]): Record<string, ModelPoolView> {
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

export function ConfigPage() {
  const [config, setConfig] = useState<ConfigData | null>(null)
  const [modelPoolDrafts, setModelPoolDrafts] = useState<ModelPoolDraft[]>([])
  const [modelPoolDirty, setModelPoolDirty] = useState(false)
  const [modelPoolSaving, setModelPoolSaving] = useState(false)
  const [newPoolName, setNewPoolName] = useState('')
  const [oauthConnecting, setOauthConnecting] = useState<string | null>(null)
  const [chatgptUsageByProvider, setChatgptUsageByProvider] = useState<
    Record<string, ChatGptUsageSnapshot>
  >({})
  const [chatgptUsageStateByProvider, setChatgptUsageStateByProvider] = useState<
    Record<string, 'idle' | 'loading' | 'ready' | 'error'>
  >({})
  const [claudeUsageByProvider, setClaudeUsageByProvider] = useState<
    Record<string, ClaudeUsageSnapshot | null>
  >({})
  const [claudeUsageStateByProvider, setClaudeUsageStateByProvider] = useState<
    Record<string, 'idle' | 'loading' | 'ready' | 'error'>
  >({})
  const [channels, setChannels] = useState<ChannelConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('models')
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set())

  // Secrets add form state
  const [showAddSecret, setShowAddSecret] = useState(false)
  const [newSecretKey, setNewSecretKey] = useState('')
  const [newSecretValue, setNewSecretValue] = useState('')
  const [secretSaving, setSecretSaving] = useState(false)

  // Rollback state
  const [lastStableTag, setLastStableTag] = useState<string | null>(null)
  const [rollbackLoading, setRollbackLoading] = useState(false)
  const [rollbackResult, setRollbackResult] = useState<string | null>(null)

  // Confirm dialogs
  const [deleteSecretKey, setDeleteSecretKey] = useState<string | null>(null)
  const [showRollbackConfirm, setShowRollbackConfirm] = useState(false)
  const { addToast } = useUIStore()

  const loadConfig = useCallback(() => {
    const p1 = apiFetch<ConfigData>('/api/config')
      .then(setConfig)
      .catch(() => {})
    const p2 = apiFetch<{ channels: ChannelConfig[] }>('/api/channels/config')
      .then((res) => setChannels(res.channels))
      .catch(() => {})
    return Promise.all([p1, p2])
  }, [])
  const loadedModelPools = config?.modelPools

  useEffect(() => {
    loadConfig().finally(() => setLoading(false))
    apiFetch<{ tag: string | null }>('/api/config/last-stable-tag')
      .then((res) => setLastStableTag(res.tag))
      .catch(() => {})
  }, [loadConfig])

  useEffect(() => {
    setModelPoolDrafts(createModelPoolDrafts(loadedModelPools ?? {}))
    setModelPoolDirty(false)
  }, [loadedModelPools])

  useEffect(() => {
    const chatgptProviders = Object.entries(config?.providers ?? {}).filter(([name, provider]) => {
      return provider.authorized && getOAuthKind(name, provider) === 'chatgpt'
    })
    if (chatgptProviders.length === 0) {
      setChatgptUsageByProvider({})
      setChatgptUsageStateByProvider({})
      return
    }

    let cancelled = false
    setChatgptUsageStateByProvider(
      Object.fromEntries(chatgptProviders.map(([name]) => [name, 'loading'])),
    )

    for (const [name] of chatgptProviders) {
      apiFetch<{ provider: string; usage: ChatGptUsageSnapshot }>(
        `/api/providers/${name}/oauth/usage`,
      )
        .then((res) => {
          if (cancelled) return
          setChatgptUsageByProvider((prev) => ({ ...prev, [name]: res.usage }))
          setChatgptUsageStateByProvider((prev) => ({ ...prev, [name]: 'ready' }))
        })
        .catch(() => {
          if (cancelled) return
          setChatgptUsageStateByProvider((prev) => ({ ...prev, [name]: 'error' }))
        })
    }

    return () => {
      cancelled = true
    }
  }, [config])

  useEffect(() => {
    const claudeProviders = Object.entries(config?.providers ?? {}).filter(([name, provider]) => {
      return provider.authorized && getOAuthKind(name, provider) === 'anthropic'
    })
    if (claudeProviders.length === 0) {
      setClaudeUsageByProvider({})
      setClaudeUsageStateByProvider({})
      return
    }

    let cancelled = false
    setClaudeUsageStateByProvider(
      Object.fromEntries(claudeProviders.map(([name]) => [name, 'loading'])),
    )

    for (const [name] of claudeProviders) {
      apiFetch<{ provider: string; usage: ClaudeUsageSnapshot | null }>(
        `/api/providers/${name}/oauth/usage`,
      )
        .then((res) => {
          if (cancelled) return
          setClaudeUsageByProvider((prev) => ({ ...prev, [name]: res.usage }))
          setClaudeUsageStateByProvider((prev) => ({ ...prev, [name]: 'ready' }))
        })
        .catch(() => {
          if (cancelled) return
          setClaudeUsageStateByProvider((prev) => ({ ...prev, [name]: 'error' }))
        })
    }

    return () => {
      cancelled = true
    }
  }, [config])

  async function handleAddSecret() {
    if (!newSecretKey.trim() || !newSecretValue.trim()) return
    setSecretSaving(true)
    try {
      await apiPost('/api/config/secrets', {
        key: newSecretKey.trim(),
        value: newSecretValue.trim(),
      })
      setNewSecretKey('')
      setNewSecretValue('')
      setShowAddSecret(false)
      await loadConfig()
    } catch {
      // Silently handle — the form stays open so the user can retry
    } finally {
      setSecretSaving(false)
    }
  }

  async function handleDeleteSecret(key: string) {
    try {
      await apiPost('/api/config/secrets/delete', { key })
      setConfig((prev) => {
        if (!prev) return prev
        return { ...prev, secrets: prev.secrets?.filter((s) => s.key !== key) }
      })
      addToast('success', `Secret "${key}" 已删除`)
      setDeleteSecretKey(null)
    } catch {
      // Error toast handled by api layer
    }
  }

  async function handleRollback() {
    if (!lastStableTag) return
    setRollbackLoading(true)
    setRollbackResult(null)
    try {
      const res = await apiPost<{ ok: boolean; rolledBackTo: string }>('/api/config/rollback', {})
      setRollbackResult(`Rolled back to ${res.rolledBackTo}`)
      addToast('success', `已回滚至 ${res.rolledBackTo}`)
    } catch {
      setRollbackResult('Rollback failed')
    } finally {
      setRollbackLoading(false)
      setShowRollbackConfirm(false)
    }
  }

  async function handleSetTaskClosureModel(model: string | null) {
    try {
      await apiPut('/api/config', { taskClosureModel: model })
      setConfig((prev) => (prev ? { ...prev, taskClosureModel: model } : prev))
      addToast(
        'success',
        model ? `Task closure model set to ${model}` : 'Task closure model cleared',
      )
    } catch {
      // Error toast handled by api layer
    }
  }

  async function handleSetContextCompactionModel(model: string | null) {
    try {
      await apiPut('/api/config', { contextCompactionModel: model })
      setConfig((prev) => (prev ? { ...prev, contextCompactionModel: model } : prev))
      addToast(
        'success',
        model ? `Context compaction model set to ${model}` : 'Context compaction model cleared',
      )
    } catch {
      // Error toast handled by api layer
    }
  }

  async function handleSetDefaultModel(model: string) {
    if (!model) return
    try {
      const res = await apiPut<{
        defaultModel: string
        modelPools: Record<string, ModelPoolView>
      }>('/api/config', { defaultModel: model })
      setConfig((prev) =>
        prev
          ? {
              ...prev,
              defaultModel: res.defaultModel,
              modelPools: res.modelPools ?? prev.modelPools,
            }
          : prev,
      )
      addToast('success', `Default model set to ${res.defaultModel}`)
    } catch {
      // Error toast handled by api layer
    }
  }

  function markModelPoolsDirty(next: ModelPoolDraft[]) {
    setModelPoolDrafts(next)
    setModelPoolDirty(true)
  }

  function handleAddModelPool(physicalModels: string[]) {
    const name = newPoolName.trim()
    if (!name) return
    const firstModel = physicalModels[0] ?? ''
    markModelPoolsDirty([
      ...modelPoolDrafts,
      {
        id: createDraftId('pool'),
        name,
        strategy: 'sticky_quota_aware_failover',
        members: firstModel ? [{ id: createDraftId('member'), model: firstModel }] : [],
      },
    ])
    setNewPoolName('')
  }

  function handleUpdateModelPool(id: string, patch: Partial<Omit<ModelPoolDraft, 'id'>>) {
    markModelPoolsDirty(
      modelPoolDrafts.map((pool) => (pool.id === id ? { ...pool, ...patch } : pool)),
    )
  }

  function handleRemoveModelPool(id: string) {
    markModelPoolsDirty(modelPoolDrafts.filter((pool) => pool.id !== id))
  }

  function handleAddModelPoolMember(poolId: string, physicalModels: string[]) {
    const firstModel = physicalModels[0] ?? ''
    if (!firstModel) return
    markModelPoolsDirty(
      modelPoolDrafts.map((pool) =>
        pool.id === poolId
          ? {
              ...pool,
              members: [...pool.members, { id: createDraftId('member'), model: firstModel }],
            }
          : pool,
      ),
    )
  }

  function handleUpdateModelPoolMember(poolId: string, memberId: string, model: string) {
    markModelPoolsDirty(
      modelPoolDrafts.map((pool) =>
        pool.id === poolId
          ? {
              ...pool,
              members: pool.members.map((member) =>
                member.id === memberId ? { ...member, model } : member,
              ),
            }
          : pool,
      ),
    )
  }

  function handleRemoveModelPoolMember(poolId: string, memberId: string) {
    markModelPoolsDirty(
      modelPoolDrafts.map((pool) =>
        pool.id === poolId
          ? { ...pool, members: pool.members.filter((member) => member.id !== memberId) }
          : pool,
      ),
    )
  }

  async function handleSaveModelPools() {
    setModelPoolSaving(true)
    try {
      const modelPools = serializeModelPoolDrafts(modelPoolDrafts)
      const res = await apiPut<{
        defaultModel: string
        fallbackChain: string[]
        modelPools: Record<string, ModelPoolView>
        taskClosureModel: string | null
        contextCompactionModel: string | null
      }>('/api/config', { modelPools })
      setConfig((prev) =>
        prev
          ? {
              ...prev,
              defaultModel: res.defaultModel,
              fallbackChain: res.fallbackChain,
              modelPools: res.modelPools,
              taskClosureModel: res.taskClosureModel,
              contextCompactionModel: res.contextCompactionModel,
            }
          : prev,
      )
      setModelPoolDrafts(createModelPoolDrafts(res.modelPools))
      setModelPoolDirty(false)
      addToast('success', 'Model pools saved and runtime reloaded')
    } catch {
      // Error toast handled by api layer
    } finally {
      setModelPoolSaving(false)
    }
  }

  async function handleConnectOAuthProvider(provider: string, label: string) {
    setOauthConnecting(provider)
    try {
      const start = await apiPost<{ url: string }>(`/api/providers/${provider}/oauth/start`, {})
      window.open(start.url, '_blank', 'noopener,noreferrer')

      for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        const status = await apiFetch<{
          state: string
          error?: string
          authorized: boolean
          requiresRestart: boolean
        }>(`/api/providers/${provider}/oauth/status`)
        if (status.state === 'connected' && status.authorized) {
          await loadConfig()
          addToast(
            'success',
            status.requiresRestart ? `${label} 已授权，正在加载。` : `${label} 已授权。`,
          )
          return
        }
        if (status.state === 'error') {
          throw new Error(status.error ?? `${label} OAuth failed`)
        }
      }

      addToast('error', `等待 ${label} OAuth 回调超时，请重试或使用 CLI。`)
    } catch (error) {
      addToast('error', error instanceof Error ? error.message : `${label} OAuth failed`)
    } finally {
      setOauthConnecting(null)
    }
  }

  function getProviderBadge(prov?: ProviderView) {
    if (!prov)
      return {
        label: 'Not connected',
        className: 'bg-white/[0.05] text-[var(--color-text-disabled)]',
      }
    if (prov.oauthState === 'error')
      return { label: 'Error', className: 'bg-red-400/10 text-red-400' }
    if (prov.oauthState === 'expired')
      return { label: 'Expired', className: 'bg-amber-400/10 text-amber-400' }
    if (prov.authorized)
      return { label: 'Connected', className: 'bg-emerald-400/10 text-emerald-400' }
    if (prov.configured) return { label: 'Configured', className: 'bg-sky-400/10 text-sky-400' }
    return {
      label: 'Not connected',
      className: 'bg-white/[0.05] text-[var(--color-text-disabled)]',
    }
  }

  function toggleReveal(key: string) {
    setRevealedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function formatUsagePercent(value: number | null | undefined) {
    return typeof value === 'number' ? `${value}%` : 'n/a'
  }

  function formatUsageResetAt(value: string | null | undefined) {
    if (!value) return 'n/a'

    try {
      return new Date(value).toLocaleString()
    } catch {
      return value
    }
  }

  function formatUsageResetTimestamp(value: number | null | undefined) {
    if (typeof value !== 'number') return 'n/a'

    try {
      return new Date(value * 1000).toLocaleString()
    } catch {
      return String(value)
    }
  }

  function formatUsageWindowDuration(value: number | null | undefined) {
    if (typeof value !== 'number' || value <= 0) return 'n/a'
    if (value % (60 * 24) === 0) return `${value / (60 * 24)}d`
    if (value % 60 === 0) return `${value / 60}h`
    return `${value}m`
  }

  function getModelPoolValidationErrors(physicalModels: string[]) {
    const errors: string[] = []
    const names = new Map<string, number>()
    for (const pool of modelPoolDrafts) {
      const name = pool.name.trim()
      if (!name) {
        errors.push('Every model pool needs a logical model name.')
        continue
      }
      names.set(name, (names.get(name) ?? 0) + 1)
      if (!name.includes('/')) {
        errors.push(`${name} should use provider/model format.`)
      }
      if (pool.members.length === 0) {
        errors.push(`${name} needs at least one member.`)
      }
      for (const member of pool.members) {
        if (!member.model.trim()) {
          errors.push(`${name} has an empty member.`)
        } else if (!physicalModels.includes(member.model)) {
          errors.push(`${member.model} is not available in configured providers.`)
        }
      }
    }

    for (const [name, count] of names) {
      if (count > 1) {
        errors.push(`${name} is duplicated.`)
      }
    }
    return Array.from(new Set(errors))
  }

  function withCurrentModelOption(options: string[], current?: string | null) {
    return current && !options.includes(current) ? [current, ...options] : options
  }

  const providers = config?.providers ?? {}
  const chatgptProvider = providers.chatgpt
  const xPremiumProvider = providers['x-premium']
  const models = Object.entries(providers).flatMap(([provName, prov]) =>
    Object.entries(prov.models).map(([mName, model]) => ({ provName, mName, ...model })),
  )
  const physicalModelOptions = models.map((model) => `${model.provName}/${model.mName}`)
  const poolModelOptions = Object.keys(config?.modelPools ?? {})
  const allModelOptions = [...poolModelOptions, ...physicalModelOptions]
  const defaultModelOptions = withCurrentModelOption(allModelOptions, config?.defaultModel)
  const taskClosureModelOptions = withCurrentModelOption(allModelOptions, config?.taskClosureModel)
  const contextCompactionModelOptions = withCurrentModelOption(
    allModelOptions,
    config?.contextCompactionModel,
  )
  const modelPoolValidationErrors = getModelPoolValidationErrors(physicalModelOptions)
  const canSaveModelPools =
    modelPoolDirty && !modelPoolSaving && modelPoolValidationErrors.length === 0

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <h1 className="text-[20px] font-bold tracking-tight mb-4">Config</h1>

      {/* Tab bar */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-4 py-1.5 rounded-md text-[13px] transition-colors ${
              tab === t.key
                ? 'bg-[var(--color-accent-glow)] text-[var(--color-accent)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 4 }, (_, index) => `config-skeleton-${index}`).map((key) => (
            <SkeletonCard key={key} />
          ))}
        </div>
      ) : (
        <>
          {/* Models tab */}
          {tab === 'models' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Providers */}
              <div className="card p-5 animate-fade-up">
                <h3 className="text-[14px] font-semibold mb-3 text-[var(--color-text-secondary)]">
                  Providers
                </h3>
                <div className="space-y-3">
                  {Object.entries(providers).map(([name, prov]) => {
                    const badge = getProviderBadge(prov)
                    const oauthKind = getOAuthKind(name, prov)
                    const isChatgpt = oauthKind === 'chatgpt'
                    const isXPremium = oauthKind === 'x-premium'
                    const isClaude = oauthKind === 'anthropic'
                    const oauthLabel = isXPremium ? 'X Premium' : isClaude ? 'Claude' : 'ChatGPT'
                    const canConnectOAuth = Boolean(oauthKind)
                    const chatgptUsageState = chatgptUsageStateByProvider[name] ?? 'idle'
                    const chatgptUsage = chatgptUsageByProvider[name]
                    const claudeUsageState = claudeUsageStateByProvider[name] ?? 'idle'
                    const claudeUsage = claudeUsageByProvider[name]
                    return (
                      <div
                        key={name}
                        className="flex items-center justify-between py-2 border-b border-[var(--color-border)] gap-3"
                      >
                        <div>
                          <p className="text-[13px] text-[var(--color-text-primary)]">{name}</p>
                          <p className="text-[11px] font-mono text-[var(--color-text-muted)]">
                            {prov.apiType} · {prov.authType ?? 'unknown'}
                          </p>
                          {canConnectOAuth && prov.requiresRestart && (
                            <p className="text-[11px] text-amber-400 mt-1">
                              Authorized. Runtime reload may still be in progress.
                            </p>
                          )}
                          {isChatgpt && prov.authorized && chatgptUsageState === 'loading' && (
                            <p className="text-[11px] text-[var(--color-text-muted)] mt-1">
                              Loading usage...
                            </p>
                          )}
                          {isChatgpt && prov.authorized && chatgptUsageState === 'error' && (
                            <p className="text-[11px] text-red-400 mt-1">
                              Usage unavailable right now.
                            </p>
                          )}
                          {isChatgpt &&
                            prov.authorized &&
                            chatgptUsageState === 'ready' &&
                            chatgptUsage && (
                              <div className="mt-1 space-y-1">
                                {chatgptUsage.rateLimits.primary && (
                                  <p className="text-[11px] text-[var(--color-text-muted)]">
                                    Primary (
                                    {formatUsageWindowDuration(
                                      chatgptUsage.rateLimits.primary.windowDurationMins,
                                    )}
                                    ) :{' '}
                                    {formatUsagePercent(
                                      chatgptUsage.rateLimits.primary.usedPercent,
                                    )}{' '}
                                    · resets{' '}
                                    {formatUsageResetTimestamp(
                                      chatgptUsage.rateLimits.primary.resetsAt,
                                    )}
                                  </p>
                                )}
                                {chatgptUsage.rateLimits.secondary && (
                                  <p className="text-[11px] text-[var(--color-text-muted)]">
                                    Secondary (
                                    {formatUsageWindowDuration(
                                      chatgptUsage.rateLimits.secondary.windowDurationMins,
                                    )}
                                    ) :{' '}
                                    {formatUsagePercent(
                                      chatgptUsage.rateLimits.secondary.usedPercent,
                                    )}{' '}
                                    · resets{' '}
                                    {formatUsageResetTimestamp(
                                      chatgptUsage.rateLimits.secondary.resetsAt,
                                    )}
                                  </p>
                                )}
                                {(chatgptUsage.rateLimits.planType ||
                                  chatgptUsage.rateLimits.credits?.hasCredits) && (
                                  <p className="text-[11px] text-[var(--color-text-muted)]">
                                    Plan: {chatgptUsage.rateLimits.planType ?? 'n/a'}
                                    {chatgptUsage.rateLimits.credits?.hasCredits && (
                                      <>
                                        {' · '}
                                        Credits{' '}
                                        {chatgptUsage.rateLimits.credits.unlimited
                                          ? 'unlimited'
                                          : (chatgptUsage.rateLimits.credits.balance ??
                                            'available')}
                                      </>
                                    )}
                                  </p>
                                )}
                              </div>
                            )}
                          {isClaude && prov.authorized && claudeUsageState === 'loading' && (
                            <p className="text-[11px] text-[var(--color-text-muted)] mt-1">
                              Loading usage...
                            </p>
                          )}
                          {isClaude && prov.authorized && claudeUsageState === 'error' && (
                            <p className="text-[11px] text-red-400 mt-1">
                              Usage unavailable right now.
                            </p>
                          )}
                          {isClaude &&
                            prov.authorized &&
                            claudeUsageState === 'ready' &&
                            claudeUsage && (
                              <div className="mt-1 space-y-1">
                                <p className="text-[11px] text-[var(--color-text-muted)]">
                                  5h: {formatUsagePercent(claudeUsage.five_hour?.utilization)} ·
                                  resets {formatUsageResetAt(claudeUsage.five_hour?.resets_at)}
                                </p>
                                <p className="text-[11px] text-[var(--color-text-muted)]">
                                  7d: {formatUsagePercent(claudeUsage.seven_day?.utilization)}
                                  {' · '}resets{' '}
                                  {formatUsageResetAt(claudeUsage.seven_day?.resets_at)}
                                </p>
                                {claudeUsage.seven_day_oauth_apps && (
                                  <p className="text-[11px] text-[var(--color-text-muted)]">
                                    7d OAuth apps:{' '}
                                    {formatUsagePercent(
                                      claudeUsage.seven_day_oauth_apps.utilization,
                                    )}
                                    {' · '}resets{' '}
                                    {formatUsageResetAt(claudeUsage.seven_day_oauth_apps.resets_at)}
                                  </p>
                                )}
                                {claudeUsage.extra_usage && (
                                  <p className="text-[11px] text-[var(--color-text-muted)]">
                                    Extra usage: {claudeUsage.extra_usage.used_credits ?? 0}/
                                    {claudeUsage.extra_usage.monthly_limit ?? 'n/a'} ·{' '}
                                    {formatUsagePercent(claudeUsage.extra_usage.utilization)}
                                  </p>
                                )}
                              </div>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`text-[11px] px-2 py-0.5 rounded-md ${badge.className}`}>
                            {badge.label}
                          </span>
                          {canConnectOAuth && (
                            <button
                              type="button"
                              onClick={() => handleConnectOAuthProvider(name, oauthLabel)}
                              disabled={oauthConnecting === name}
                              className="text-[11px] px-2 py-1 rounded-md bg-[var(--color-accent-glow)] text-[var(--color-accent)] hover:opacity-90 disabled:opacity-50"
                            >
                              {oauthConnecting === name
                                ? 'Connecting...'
                                : prov.authorized
                                  ? 'Reconnect'
                                  : 'Connect'}
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                  {!chatgptProvider && (
                    <div className="flex items-center justify-between py-2 border-b border-[var(--color-border)] gap-3">
                      <div>
                        <p className="text-[13px] text-[var(--color-text-primary)]">chatgpt</p>
                        <p className="text-[11px] font-mono text-[var(--color-text-muted)]">
                          openai_responses · oauth2
                        </p>
                        <p className="text-[11px] text-[var(--color-text-disabled)] mt-1">
                          Connect ChatGPT OAuth to add ChatGPT/Codex models.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleConnectOAuthProvider('chatgpt', 'ChatGPT')}
                        disabled={oauthConnecting === 'chatgpt'}
                        className="text-[11px] px-2 py-1 rounded-md bg-[var(--color-accent-glow)] text-[var(--color-accent)] hover:opacity-90 disabled:opacity-50"
                      >
                        {oauthConnecting === 'chatgpt' ? 'Connecting...' : 'Connect ChatGPT'}
                      </button>
                    </div>
                  )}
                  {!xPremiumProvider && (
                    <div className="flex items-center justify-between py-2 border-b border-[var(--color-border)] gap-3">
                      <div>
                        <p className="text-[13px] text-[var(--color-text-primary)]">x-premium</p>
                        <p className="text-[11px] font-mono text-[var(--color-text-muted)]">
                          x_responses · oauth2
                        </p>
                        <p className="text-[11px] text-[var(--color-text-disabled)] mt-1">
                          Connect X Premium OAuth to add Grok models.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleConnectOAuthProvider('x-premium', 'X Premium')}
                        disabled={oauthConnecting === 'x-premium'}
                        className="text-[11px] px-2 py-1 rounded-md bg-[var(--color-accent-glow)] text-[var(--color-accent)] hover:opacity-90 disabled:opacity-50"
                      >
                        {oauthConnecting === 'x-premium' ? 'Connecting...' : 'Connect X Premium'}
                      </button>
                    </div>
                  )}
                  {Object.keys(providers).length === 0 && !chatgptProvider && !xPremiumProvider && (
                    <p className="text-[13px] text-[var(--color-text-muted)]">
                      No providers configured
                    </p>
                  )}
                </div>
              </div>

              <div
                className="card p-5 animate-fade-up lg:col-span-2"
                style={{ animationDelay: '40ms' }}
              >
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                      <h3 className="text-[14px] font-semibold mb-1 text-[var(--color-text-secondary)]">
                        Model Routing
                      </h3>
                      <p className="text-[11px] text-[var(--color-text-muted)]">
                        Default model and logical pools are applied with a runtime reload on save.
                      </p>
                    </div>
                    <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)] lg:min-w-[360px]">
                      Default Model
                      <select
                        aria-label="Default Model"
                        value={config?.defaultModel ?? ''}
                        onChange={(e) => handleSetDefaultModel(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[13px] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
                      >
                        {defaultModelOptions.map((model) => (
                          <option key={`default-${model}`} value={model}>
                            {model}
                            {poolModelOptions.includes(model) ? ' · pool' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="border-t border-[var(--color-border)] pt-4">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                      <div className="grid gap-1">
                        <h4 className="text-[13px] font-semibold text-[var(--color-text-secondary)]">
                          Model Pools
                        </h4>
                        <p className="text-[11px] text-[var(--color-text-muted)]">
                          Sticky pools keep a session on one provider until quota or availability
                          requires failover.
                        </p>
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <input
                          aria-label="New model pool name"
                          type="text"
                          value={newPoolName}
                          onChange={(e) => setNewPoolName(e.target.value)}
                          placeholder="chatgpt/gpt-5.5"
                          className="w-full sm:w-[240px] px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-disabled)] focus:outline-none focus:border-[var(--color-accent)]"
                        />
                        <button
                          aria-label="Add model pool"
                          type="button"
                          onClick={() => handleAddModelPool(physicalModelOptions)}
                          disabled={!newPoolName.trim() || physicalModelOptions.length === 0}
                          className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:border-[var(--color-border-hover)] transition-colors disabled:opacity-40"
                        >
                          <Plus size={14} />
                          Add Pool
                        </button>
                        <button
                          aria-label="Save model pools"
                          type="button"
                          onClick={handleSaveModelPools}
                          disabled={!canSaveModelPools}
                          className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40"
                        >
                          <FloppyDisk size={14} />
                          {modelPoolSaving ? 'Saving...' : 'Save Pools'}
                        </button>
                      </div>
                    </div>

                    {modelPoolValidationErrors.length > 0 && modelPoolDirty && (
                      <div className="mt-3 space-y-1">
                        {modelPoolValidationErrors.map((error) => (
                          <p key={error} className="text-[11px] text-red-400">
                            {error}
                          </p>
                        ))}
                      </div>
                    )}

                    <div className="mt-4 divide-y divide-[var(--color-border)]">
                      {modelPoolDrafts.map((pool, poolIndex) => (
                        <div key={pool.id} className="py-4 first:pt-0 last:pb-0">
                          <div className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_220px_auto] lg:items-end">
                            <label className="grid gap-1 text-[11px] text-[var(--color-text-muted)]">
                              Logical Model
                              <input
                                aria-label={`Model pool name ${poolIndex + 1}`}
                                type="text"
                                value={pool.name}
                                onChange={(e) =>
                                  handleUpdateModelPool(pool.id, { name: e.target.value })
                                }
                                className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[13px] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
                              />
                            </label>
                            <label className="grid gap-1 text-[11px] text-[var(--color-text-muted)]">
                              Strategy
                              <select
                                aria-label={`Model pool strategy ${poolIndex + 1}`}
                                value={pool.strategy}
                                onChange={(e) =>
                                  handleUpdateModelPool(pool.id, {
                                    strategy: e.target.value as ModelPoolStrategy,
                                  })
                                }
                                className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[13px] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
                              >
                                {MODEL_POOL_STRATEGIES.map((strategy) => (
                                  <option key={strategy.value} value={strategy.value}>
                                    {strategy.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <button
                              aria-label={`Remove model pool ${poolIndex + 1}`}
                              type="button"
                              onClick={() => handleRemoveModelPool(pool.id)}
                              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] text-[var(--color-text-muted)] hover:text-red-400 hover:bg-red-400/10 transition-colors"
                            >
                              <Trash size={14} />
                              Remove
                            </button>
                          </div>

                          <div className="mt-3 space-y-2">
                            {pool.members.map((member, memberIndex) => {
                              const memberOptions = physicalModelOptions.includes(member.model)
                                ? physicalModelOptions
                                : [member.model, ...physicalModelOptions]
                              return (
                                <div
                                  key={member.id}
                                  className="grid gap-2 sm:grid-cols-[32px_minmax(180px,1fr)_auto] sm:items-center"
                                >
                                  <span className="hidden sm:inline-flex h-8 w-8 items-center justify-center rounded-md bg-white/[0.04] text-[11px] font-mono text-[var(--color-text-muted)]">
                                    {memberIndex + 1}
                                  </span>
                                  <select
                                    aria-label={`Model pool member ${poolIndex + 1}-${memberIndex + 1}`}
                                    value={member.model}
                                    onChange={(e) =>
                                      handleUpdateModelPoolMember(
                                        pool.id,
                                        member.id,
                                        e.target.value,
                                      )
                                    }
                                    className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[13px] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
                                  >
                                    {memberOptions.map((model) => (
                                      <option key={`${member.id}-${model}`} value={model}>
                                        {model}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    aria-label={`Remove model pool member ${poolIndex + 1}-${memberIndex + 1}`}
                                    type="button"
                                    onClick={() => handleRemoveModelPoolMember(pool.id, member.id)}
                                    className="inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg text-[12px] text-[var(--color-text-muted)] hover:text-red-400 hover:bg-red-400/10 transition-colors"
                                  >
                                    <Trash size={14} />
                                    Member
                                  </button>
                                </div>
                              )
                            })}
                            <button
                              aria-label={`Add member to model pool ${poolIndex + 1}`}
                              type="button"
                              onClick={() =>
                                handleAddModelPoolMember(pool.id, physicalModelOptions)
                              }
                              disabled={physicalModelOptions.length === 0}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:border-[var(--color-border-hover)] transition-colors disabled:opacity-40"
                            >
                              <Plus size={14} />
                              Add Member
                            </button>
                          </div>
                        </div>
                      ))}
                      {modelPoolDrafts.length === 0 && (
                        <p className="py-3 text-[13px] text-[var(--color-text-muted)]">
                          No model pools configured
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Models */}
              <div className="card p-5 animate-fade-up" style={{ animationDelay: '60ms' }}>
                <h3 className="text-[14px] font-semibold mb-3 text-[var(--color-text-secondary)]">
                  Models
                </h3>
                <div className="space-y-3">
                  {models.map((m) => (
                    <div
                      key={`${m.provName}/${m.mName}`}
                      className="flex items-center justify-between py-2 border-b border-[var(--color-border)]"
                    >
                      <div>
                        <p className="text-[13px] text-[var(--color-text-primary)]">{`${m.provName}/${m.mName}`}</p>
                        <p className="text-[11px] font-mono text-[var(--color-text-muted)]">
                          {(m.maxContext / 1000).toFixed(0)}K context /{' '}
                          {(m.maxOutput / 1000).toFixed(0)}K output
                        </p>
                        {m.tags.length > 0 && (
                          <div className="flex gap-1 mt-1">
                            {m.tags.map((tag) => (
                              <span
                                key={tag}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.05] text-[var(--color-text-disabled)]"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      {config?.defaultModel === `${m.provName}/${m.mName}` && (
                        <span className="text-[11px] px-2 py-0.5 rounded-md bg-[var(--color-accent-glow)] text-[var(--color-accent)]">
                          Default
                        </span>
                      )}
                    </div>
                  ))}
                  {models.length === 0 && (
                    <p className="text-[13px] text-[var(--color-text-muted)]">
                      No models configured
                    </p>
                  )}
                </div>
              </div>

              <div
                className="card p-5 animate-fade-up lg:col-span-2"
                style={{ animationDelay: '120ms' }}
              >
                <h3 className="text-[14px] font-semibold mb-1 text-[var(--color-text-secondary)]">
                  Task Closure Model
                </h3>
                <p className="text-[11px] text-[var(--color-text-muted)] mb-3">
                  可选的轻量模型，用于任务收尾判定。未设置时使用主 agent 模型。
                </p>
                <select
                  aria-label="Task Closure Model"
                  value={config?.taskClosureModel ?? ''}
                  onChange={(e) => handleSetTaskClosureModel(e.target.value || null)}
                  className="w-full max-w-md px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[13px] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
                >
                  <option value="">Default（与 agent 主模型相同）</option>
                  {taskClosureModelOptions.map((model) => (
                    <option key={`task-closure-${model}`} value={model}>
                      {model}
                      {poolModelOptions.includes(model) ? ' · pool' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div
                className="card p-5 animate-fade-up lg:col-span-2"
                style={{ animationDelay: '160ms' }}
              >
                <h3 className="text-[14px] font-semibold mb-1 text-[var(--color-text-secondary)]">
                  Context Compaction Model
                </h3>
                <p className="text-[11px] text-[var(--color-text-muted)] mb-3">
                  用于 working-state compaction 的专用模型。未设置时沿用任务收尾模型或主 agent
                  模型。
                </p>
                <div>
                  <select
                    aria-label="Context Compaction Model"
                    value={config?.contextCompactionModel ?? ''}
                    onChange={(e) => handleSetContextCompactionModel(e.target.value || null)}
                    className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[13px] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
                  >
                    <option value="">Default（与 task closure / agent 主模型相同）</option>
                    {contextCompactionModelOptions.map((model) => (
                      <option key={`context-compaction-${model}`} value={model}>
                        {model}
                        {poolModelOptions.includes(model) ? ' · pool' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Scheduler tab */}
          {tab === 'scheduler' && (
            <div className="card p-5 animate-fade-up">
              <h3 className="text-[14px] font-semibold mb-3 text-[var(--color-text-secondary)]">
                Scheduled Tasks
              </h3>
              {config?.schedules && config.schedules.length > 0 ? (
                <div className="space-y-2">
                  {config.schedules.map((s) => (
                    <div
                      key={`${s.name}-${s.cron}-${s.task}`}
                      className="flex items-center justify-between py-2 border-b border-[var(--color-border)]"
                    >
                      <div>
                        <p className="text-[13px] text-[var(--color-text-primary)]">{s.name}</p>
                        <p className="text-[11px] font-mono text-[var(--color-text-muted)]">
                          {s.cron}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[13px] text-[var(--color-text-muted)]">
                  No scheduled tasks configured
                </p>
              )}
            </div>
          )}

          {/* Fuse List tab */}
          {tab === 'fuse' && (
            <div className="card p-5 animate-fade-up">
              <h3 className="text-[14px] font-semibold mb-3 text-[var(--color-text-secondary)]">
                Fuse List
              </h3>
              <p className="text-[12px] text-[var(--color-text-muted)] mb-2">
                Commands blocked by the fuse list safety mechanism
              </p>
              {config?.fuseList && config.fuseList.length > 0 ? (
                <div className="space-y-1">
                  {config.fuseList.map((rule) => (
                    <div
                      key={`${rule.pattern}-${rule.description ?? ''}`}
                      className="flex items-center gap-2 py-1"
                    >
                      <span className="text-[12px] font-mono text-red-400">{rule.pattern}</span>
                      {rule.description && (
                        <span className="text-[11px] text-[var(--color-text-disabled)]">
                          — {rule.description}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-1">
                  {['rm -rf /', 'mkfs', 'dd if=/dev/zero', 'shutdown', 'reboot'].map((cmd) => (
                    <div key={cmd} className="flex items-center gap-2 py-1">
                      <span className="text-[12px] font-mono text-red-400">{cmd}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Secrets tab */}
          {tab === 'secrets' && (
            <div className="card p-5 animate-fade-up">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-[14px] font-semibold text-[var(--color-text-secondary)]">
                  Secrets
                </h3>
                <button
                  type="button"
                  onClick={() => setShowAddSecret((v) => !v)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:border-[var(--color-border-hover)] transition-colors"
                >
                  <Plus size={14} />
                  Add Secret
                </button>
              </div>
              {showAddSecret && (
                <div className="flex items-center gap-2 mb-3 p-3 rounded-lg border border-[var(--color-border)] bg-white/[0.02]">
                  <input
                    type="text"
                    placeholder="Key"
                    value={newSecretKey}
                    onChange={(e) => setNewSecretKey(e.target.value)}
                    className="flex-1 px-2 py-1.5 rounded-md text-[12px] bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-disabled)] focus:outline-none focus:border-[var(--color-accent)]"
                  />
                  <input
                    type="password"
                    placeholder="Value"
                    value={newSecretValue}
                    onChange={(e) => setNewSecretValue(e.target.value)}
                    className="flex-1 px-2 py-1.5 rounded-md text-[12px] bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-disabled)] focus:outline-none focus:border-[var(--color-accent)]"
                  />
                  <button
                    type="button"
                    onClick={handleAddSecret}
                    disabled={secretSaving || !newSecretKey.trim() || !newSecretValue.trim()}
                    className="px-3 py-1.5 rounded-md text-[12px] bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40"
                  >
                    {secretSaving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddSecret(false)
                      setNewSecretKey('')
                      setNewSecretValue('')
                    }}
                    className="px-2 py-1.5 rounded-md text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                  >
                    Cancel
                  </button>
                </div>
              )}
              {config?.secrets && config.secrets.length > 0 ? (
                <div className="space-y-2">
                  {config.secrets.map((s) => (
                    <div
                      key={s.key}
                      className="flex items-center justify-between py-2 px-3 rounded-lg border border-[var(--color-border)]"
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className={`w-2 h-2 rounded-full ${s.configured ? 'bg-emerald-400' : 'bg-red-400'}`}
                        />
                        <span className="text-[13px] font-mono text-[var(--color-text-primary)]">
                          {s.key}
                        </span>
                        <span className="text-[12px] font-mono text-[var(--color-text-disabled)]">
                          {revealedKeys.has(s.key)
                            ? s.masked
                            : `${s.masked.replace(/[^.]/g, '*').slice(0, 12)}****`}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => toggleReveal(s.key)}
                          className="p-1.5 rounded-md hover:bg-white/[0.05] text-[var(--color-text-muted)]"
                        >
                          {revealedKeys.has(s.key) ? <EyeSlash size={14} /> : <Eye size={14} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteSecretKey(s.key)}
                          className="p-1.5 rounded-md hover:bg-red-400/10 text-[var(--color-text-muted)] hover:text-red-400"
                        >
                          <Trash size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {/* Show channel-derived secrets if no dedicated secrets endpoint */}
                  {channels.flatMap((ch) => ch.secrets).length > 0 ? (
                    channels
                      .flatMap((ch) => ch.secrets)
                      .map((s) => (
                        <div
                          key={s.key}
                          className="flex items-center justify-between py-2 px-3 rounded-lg border border-[var(--color-border)]"
                        >
                          <div className="flex items-center gap-3">
                            <span
                              className={`w-2 h-2 rounded-full ${s.configured ? 'bg-emerald-400' : 'bg-red-400'}`}
                            />
                            <span className="text-[13px] font-mono text-[var(--color-text-primary)]">
                              {s.key}
                            </span>
                            <span className="text-[12px] font-mono text-[var(--color-text-disabled)]">
                              {s.configured ? 'sk-...configured' : 'not configured'}
                            </span>
                          </div>
                          <span
                            className={`text-[11px] px-2 py-0.5 rounded-md ${
                              s.configured
                                ? 'bg-emerald-400/10 text-emerald-400'
                                : 'bg-red-400/10 text-red-400'
                            }`}
                          >
                            {s.configured ? 'Active' : 'Missing'}
                          </span>
                        </div>
                      ))
                  ) : (
                    <p className="text-[13px] text-[var(--color-text-muted)]">
                      No secrets configured
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Channels tab */}
          {tab === 'channels' && (
            <div className="card p-5 animate-fade-up">
              <h3 className="text-[14px] font-semibold mb-3 text-[var(--color-text-secondary)]">
                Channels
              </h3>
              <div className="space-y-3">
                {channels.map((ch) => {
                  const isOnline = ch.status === 'online'
                  return (
                    <div
                      key={ch.name}
                      className={`flex items-center justify-between py-3 px-3 rounded-lg border ${
                        isOnline
                          ? 'border-[var(--color-border)]'
                          : 'border-red-400/30 bg-red-400/[0.05]'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className={`w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-red-400 animate-pulse'}`}
                        />
                        <div>
                          <p className="text-[13px] text-[var(--color-text-primary)] capitalize">
                            {ch.name}
                          </p>
                          <p className="text-[11px] font-mono text-[var(--color-text-muted)]">
                            {ch.codePath}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        {ch.secrets.length > 0 && (
                          <div className="flex items-center gap-2">
                            {ch.secrets.map((s) => (
                              <span
                                key={s.key}
                                className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                                  s.configured
                                    ? 'bg-emerald-400/10 text-emerald-400'
                                    : 'bg-red-400/10 text-red-400'
                                }`}
                              >
                                {s.key}
                              </span>
                            ))}
                          </div>
                        )}
                        <span
                          className={`text-[11px] px-2 py-0.5 rounded-md ${
                            isOnline
                              ? 'bg-emerald-400/10 text-emerald-400'
                              : 'bg-red-400/10 text-red-400'
                          }`}
                        >
                          {ch.status}
                        </span>
                      </div>
                    </div>
                  )
                })}
                {channels.length === 0 && (
                  <p className="text-[13px] text-[var(--color-text-muted)]">
                    No channels configured
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Version tab */}
          {tab === 'version' && (
            <div className="card p-5 animate-fade-up">
              <h3 className="text-[14px] font-semibold mb-3 text-[var(--color-text-secondary)]">
                Version Info
              </h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between py-2 border-b border-[var(--color-border)]">
                  <span className="text-[13px] text-[var(--color-text-muted)]">Version</span>
                  <span className="text-[13px] font-mono text-[var(--color-text-primary)]">
                    v0.1.0
                  </span>
                </div>
                <div className="flex items-center justify-between py-2 border-b border-[var(--color-border)]">
                  <span className="text-[13px] text-[var(--color-text-muted)]">Runtime</span>
                  <span className="text-[13px] font-mono text-[var(--color-text-primary)]">
                    Bun
                  </span>
                </div>
                <div className="flex items-center justify-between py-2 border-b border-[var(--color-border)]">
                  <span className="text-[13px] text-[var(--color-text-muted)]">Platform</span>
                  <span className="text-[13px] font-mono text-[var(--color-text-primary)]">
                    macOS
                  </span>
                </div>
                <div className="flex items-center justify-between py-2">
                  <span className="text-[13px] text-[var(--color-text-muted)]">Rollback</span>
                  <div className="flex items-center gap-2">
                    {lastStableTag ? (
                      <>
                        <span className="text-[11px] font-mono text-[var(--color-text-disabled)]">
                          {lastStableTag}
                        </span>
                        <button
                          type="button"
                          onClick={() => setShowRollbackConfirm(true)}
                          disabled={rollbackLoading}
                          className="text-[11px] px-2 py-0.5 rounded-md bg-red-400/10 text-red-400 hover:bg-red-400/20 transition-colors disabled:opacity-40"
                        >
                          {rollbackLoading ? 'Rolling back...' : 'Rollback'}
                        </button>
                      </>
                    ) : (
                      <span className="text-[11px] px-2 py-0.5 rounded-md bg-white/[0.05] text-[var(--color-text-disabled)]">
                        No stable tag
                      </span>
                    )}
                    {rollbackResult && (
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded-md ${
                          rollbackResult.startsWith('Rolled back')
                            ? 'bg-emerald-400/10 text-emerald-400'
                            : 'bg-red-400/10 text-red-400'
                        }`}
                      >
                        {rollbackResult}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={deleteSecretKey !== null}
        title={`删除 Secret "${deleteSecretKey}"？`}
        description="删除后该密钥将从 Vault 中永久移除，关联的 Channel 可能无法正常工作。"
        confirmText="删除"
        danger
        onConfirm={() => {
          if (deleteSecretKey) handleDeleteSecret(deleteSecretKey)
        }}
        onCancel={() => setDeleteSecretKey(null)}
      />

      <ConfirmDialog
        open={showRollbackConfirm}
        title={`回滚至 ${lastStableTag}？`}
        description="此操作将重置工作目录到上一个稳定标签的状态，当前未提交的更改可能丢失。"
        confirmText="确认回滚"
        danger
        onConfirm={handleRollback}
        onCancel={() => setShowRollbackConfirm(false)}
      />
    </div>
  )
}
