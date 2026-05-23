import { Eye, EyeSlash, Plus, Trash } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import { ConfirmDialog } from '../components/shared/ConfirmDialog'
import { SkeletonCard } from '../components/shared/Skeleton'
import { apiFetch, apiPost, apiPut } from '../lib/api'
import { useUIStore } from '../stores/ui'

interface ProviderView {
  apiType: string
  baseUrl: string
  authType?: string
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

interface ConfigData {
  providers: Record<string, ProviderView>
  defaultModel: string
  fallbackChain: string[]
  schedules: { name: string; cron: string; task: string }[]
  fuseList: { pattern: string; description: string }[]
  taskClosureModel: string | null
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

const TABS: { key: Tab; label: string }[] = [
  { key: 'models', label: 'Models' },
  { key: 'scheduler', label: 'Scheduler' },
  { key: 'fuse', label: 'Fuse List' },
  { key: 'secrets', label: 'Secrets' },
  { key: 'channels', label: 'Channels' },
  { key: 'version', label: 'Version' },
]

export function ConfigPage() {
  const [config, setConfig] = useState<ConfigData | null>(null)
  const [oauthConnecting, setOauthConnecting] = useState<string | null>(null)
  const [chatgptUsage, setChatgptUsage] = useState<ChatGptUsageSnapshot | null>(null)
  const [chatgptUsageState, setChatgptUsageState] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle')
  const [claudeUsage, setClaudeUsage] = useState<ClaudeUsageSnapshot | null>(null)
  const [claudeUsageState, setClaudeUsageState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  )
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

  useEffect(() => {
    loadConfig().finally(() => setLoading(false))
    apiFetch<{ tag: string | null }>('/api/config/last-stable-tag')
      .then((res) => setLastStableTag(res.tag))
      .catch(() => {})
  }, [loadConfig])

  useEffect(() => {
    const provider = config?.providers?.chatgpt
    if (!provider?.authorized) {
      setChatgptUsage(null)
      setChatgptUsageState('idle')
      return
    }

    let cancelled = false
    setChatgptUsageState('loading')

    apiFetch<{ provider: string; usage: ChatGptUsageSnapshot }>(
      '/api/providers/chatgpt/oauth/usage',
    )
      .then((res) => {
        if (cancelled) return
        setChatgptUsage(res.usage)
        setChatgptUsageState('ready')
      })
      .catch(() => {
        if (cancelled) return
        setChatgptUsage(null)
        setChatgptUsageState('error')
      })

    return () => {
      cancelled = true
    }
  }, [config])

  useEffect(() => {
    const claudeProvider = config?.providers?.anthropic
    if (!claudeProvider?.authorized) {
      setClaudeUsage(null)
      setClaudeUsageState('idle')
      return
    }

    let cancelled = false
    setClaudeUsageState('loading')

    apiFetch<{ provider: string; usage: ClaudeUsageSnapshot | null }>(
      '/api/providers/anthropic/oauth/usage',
    )
      .then((res) => {
        if (cancelled) return
        setClaudeUsage(res.usage)
        setClaudeUsageState('ready')
      })
      .catch(() => {
        if (cancelled) return
        setClaudeUsage(null)
        setClaudeUsageState('error')
      })

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

  async function handleConnectOAuthProvider(provider: 'chatgpt' | 'x-premium', label: string) {
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
            status.requiresRestart ? `${label} 已授权，重启 ZeRo 后可使用。` : `${label} 已授权。`,
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

  const providers = config?.providers ?? {}
  const chatgptProvider = providers.chatgpt
  const xPremiumProvider = providers['x-premium']
  const models = Object.entries(providers).flatMap(([provName, prov]) =>
    Object.entries(prov.models).map(([mName, model]) => ({ provName, mName, ...model })),
  )

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <h1 className="text-[20px] font-bold tracking-tight mb-4">Config</h1>

      {/* Tab bar */}
      <div className="flex gap-1.5 mb-4">
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
                    const isChatgpt = name === 'chatgpt'
                    const isXPremium = name === 'x-premium'
                    const isClaude = name === 'anthropic'
                    const oauthLabel = isXPremium ? 'X Premium' : 'ChatGPT'
                    const canConnectOAuth = isChatgpt || isXPremium
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
                              Authorized. Restart ZeRo to use new models.
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
                              onClick={() =>
                                handleConnectOAuthProvider(
                                  isXPremium ? 'x-premium' : 'chatgpt',
                                  oauthLabel,
                                )
                              }
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
                  {models.map((m) => (
                    <option key={`${m.provName}/${m.mName}`} value={`${m.provName}/${m.mName}`}>
                      {m.provName}/{m.mName}
                    </option>
                  ))}
                </select>
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
