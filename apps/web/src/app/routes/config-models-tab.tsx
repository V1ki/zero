import { FloppyDisk, Plus, Trash } from '@phosphor-icons/react'
import {
  type ChatGptUsageSnapshot,
  type ClaudeUsageSnapshot,
  type ConfigData,
  MODEL_POOL_STRATEGIES,
  type ModelPoolDraft,
  type ModelPoolStrategy,
  type ProviderView,
  getOAuthKind,
} from './config-shared'

type UsageState = 'idle' | 'loading' | 'ready' | 'error'

interface ConfiguredModel {
  provName: string
  mName: string
  modelId: string
  maxContext: number
  maxOutput: number
  capabilities: string[]
  tags: string[]
  source?: 'manual' | 'provider'
  status?: 'configured' | 'verified' | 'stale'
  displayName?: string
  lane?: string
  supportedReasoningEfforts?: string[]
}

interface ConfigModelsTabProps {
  config: ConfigData | null
  providers: Record<string, ProviderView>
  modelPoolDrafts: ModelPoolDraft[]
  modelPoolDirty: boolean
  modelPoolSaving: boolean
  newPoolName: string
  oauthConnecting: string | null
  catalogRefreshing: string | null
  chatgptUsageByProvider: Record<string, ChatGptUsageSnapshot>
  chatgptUsageStateByProvider: Record<string, UsageState>
  claudeUsageByProvider: Record<string, ClaudeUsageSnapshot | null>
  claudeUsageStateByProvider: Record<string, UsageState>
  onNewPoolNameChange: (value: string) => void
  onConnectOAuthProvider: (provider: string, label: string) => void
  onRefreshModelCatalog: (provider: string) => void
  onSetDefaultModel: (model: string) => void
  onAddModelPool: (physicalModels: string[]) => void
  onUpdateModelPool: (id: string, patch: Partial<Omit<ModelPoolDraft, 'id'>>) => void
  onRemoveModelPool: (id: string) => void
  onAddModelPoolMember: (poolId: string, physicalModels: string[]) => void
  onUpdateModelPoolMember: (poolId: string, memberId: string, model: string) => void
  onRemoveModelPoolMember: (poolId: string, memberId: string) => void
  onSaveModelPools: () => void
  onSetTaskClosureModel: (model: string | null) => void
  onSetContextCompactionModel: (model: string | null) => void
}

function withCurrentModelOption(options: string[], current?: string | null) {
  return current && !options.includes(current) ? [current, ...options] : options
}

function getConfiguredModels(providers: Record<string, ProviderView>): ConfiguredModel[] {
  return Object.entries(providers).flatMap(([provName, prov]) =>
    Object.entries(prov.models).map(([mName, model]) => ({ provName, mName, ...model })),
  )
}

export function ConfigModelsTab({
  config,
  providers,
  modelPoolDrafts,
  modelPoolDirty,
  modelPoolSaving,
  newPoolName,
  oauthConnecting,
  catalogRefreshing,
  chatgptUsageByProvider,
  chatgptUsageStateByProvider,
  claudeUsageByProvider,
  claudeUsageStateByProvider,
  onNewPoolNameChange,
  onConnectOAuthProvider,
  onRefreshModelCatalog,
  onSetDefaultModel,
  onAddModelPool,
  onUpdateModelPool,
  onRemoveModelPool,
  onAddModelPoolMember,
  onUpdateModelPoolMember,
  onRemoveModelPoolMember,
  onSaveModelPools,
  onSetTaskClosureModel,
  onSetContextCompactionModel,
}: ConfigModelsTabProps) {
  const models = getConfiguredModels(providers)
  const physicalModelOptions = models.map((model) => `${model.provName}/${model.mName}`)
  const poolModelOptions = Object.keys(config?.runtimeModelPools ?? config?.modelPools ?? {})
  const routeModelOptions = Object.keys(config?.modelRoutes ?? {}).map((name) => `route/${name}`)
  const allModelOptions = [...routeModelOptions, ...poolModelOptions, ...physicalModelOptions]
  const defaultModelOptions = withCurrentModelOption(allModelOptions, config?.defaultModel)
  const taskClosureModelOptions = withCurrentModelOption(allModelOptions, config?.taskClosureModel)
  const contextCompactionModelOptions = withCurrentModelOption(
    allModelOptions,
    config?.contextCompactionModel,
  )
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <ProvidersCard
        providers={providers}
        oauthConnecting={oauthConnecting}
        catalogRefreshing={catalogRefreshing}
        chatgptUsageByProvider={chatgptUsageByProvider}
        chatgptUsageStateByProvider={chatgptUsageStateByProvider}
        claudeUsageByProvider={claudeUsageByProvider}
        claudeUsageStateByProvider={claudeUsageStateByProvider}
        onConnectOAuthProvider={onConnectOAuthProvider}
        onRefreshModelCatalog={onRefreshModelCatalog}
      />

      <div className="card p-5 animate-fade-up" style={{ animationDelay: '40ms' }}>
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
                <p className="text-[13px] text-[var(--color-text-primary)]">
                  {m.displayName ?? `${m.provName}/${m.mName}`}
                </p>
                {m.displayName && (
                  <p className="text-[11px] font-mono text-[var(--color-text-muted)]">{`${m.provName}/${m.mName}`}</p>
                )}
                <p className="text-[11px] font-mono text-[var(--color-text-muted)]">
                  {(m.maxContext / 1000).toFixed(0)}K context / {(m.maxOutput / 1000).toFixed(0)}K
                  output
                </p>
                <p className="text-[10px] text-[var(--color-text-disabled)] mt-1">
                  {m.source ?? 'manual'} · {m.status ?? 'configured'}
                  {m.lane ? ` · ${m.lane}` : ''}
                  {m.supportedReasoningEfforts?.length
                    ? ` · reasoning ${m.supportedReasoningEfforts.join('/')}`
                    : ''}
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
            <p className="text-[13px] text-[var(--color-text-muted)]">No models configured</p>
          )}
        </div>
      </div>

      <ModelCatalogCard config={config} />

      <div className="card p-5 animate-fade-up lg:col-span-2" style={{ animationDelay: '80ms' }}>
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
                onChange={(e) => onSetDefaultModel(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[13px] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
              >
                {defaultModelOptions.map((model) => (
                  <option key={`default-${model}`} value={model}>
                    {model}
                    {routeModelOptions.includes(model)
                      ? ' · route'
                      : poolModelOptions.includes(model)
                        ? ' · pool'
                        : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <ModelPoolsEditor
            modelPoolDrafts={modelPoolDrafts}
            modelPoolDirty={modelPoolDirty}
            modelPoolSaving={modelPoolSaving}
            newPoolName={newPoolName}
            physicalModelOptions={physicalModelOptions}
            onNewPoolNameChange={onNewPoolNameChange}
            onAddModelPool={onAddModelPool}
            onUpdateModelPool={onUpdateModelPool}
            onRemoveModelPool={onRemoveModelPool}
            onAddModelPoolMember={onAddModelPoolMember}
            onUpdateModelPoolMember={onUpdateModelPoolMember}
            onRemoveModelPoolMember={onRemoveModelPoolMember}
            onSaveModelPools={onSaveModelPools}
          />
        </div>
      </div>

      <div className="card p-5 animate-fade-up lg:col-span-2" style={{ animationDelay: '120ms' }}>
        <h3 className="text-[14px] font-semibold mb-1 text-[var(--color-text-secondary)]">
          Task Closure Model
        </h3>
        <p className="text-[11px] text-[var(--color-text-muted)] mb-3">
          可选的轻量模型，用于任务收尾判定。未设置时使用主 agent 模型。
        </p>
        <select
          aria-label="Task Closure Model"
          value={config?.taskClosureModel ?? ''}
          onChange={(e) => onSetTaskClosureModel(e.target.value || null)}
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

      <div className="card p-5 animate-fade-up lg:col-span-2" style={{ animationDelay: '160ms' }}>
        <h3 className="text-[14px] font-semibold mb-1 text-[var(--color-text-secondary)]">
          Context Compaction Model
        </h3>
        <p className="text-[11px] text-[var(--color-text-muted)] mb-3">
          用于 working-state compaction 的专用模型。未设置时沿用任务收尾模型或主 agent 模型。
        </p>
        <div>
          <select
            aria-label="Context Compaction Model"
            value={config?.contextCompactionModel ?? ''}
            onChange={(e) => onSetContextCompactionModel(e.target.value || null)}
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
  )
}

function ModelCatalogCard({ config }: { config: ConfigData | null }) {
  const catalog = config?.modelCatalog
  const automaticPools = Object.entries(config?.runtimeModelPools ?? {}).filter(
    ([, pool]) => pool.source === 'catalog',
  )
  if ((!catalog || catalog.entries.length === 0) && automaticPools.length === 0) return null

  return (
    <div className="card p-5 animate-fade-up lg:col-span-2" style={{ animationDelay: '60ms' }}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h3 className="text-[14px] font-semibold text-[var(--color-text-secondary)]">
            Runtime Model Catalog
          </h3>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            Generation {catalog?.generation ?? 0} · verified models are activated automatically
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {(catalog?.entries ?? []).map((entry) => (
          <div
            key={`${entry.providerName}/${entry.modelId}`}
            className="rounded-lg border border-[var(--color-border)] px-3 py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-mono text-[var(--color-text-primary)]">
                {entry.providerName}/{entry.modelName}
              </span>
              <span className={`text-[10px] ${catalogStatusClass(entry.status)}`}>
                {entry.status}
              </span>
            </div>
            <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
              {(entry.maxContext / 1000).toFixed(0)}K context
              {entry.lane ? ` · ${entry.lane}` : ''}
              {entry.defaultReasoningEffort ? ` · default ${entry.defaultReasoningEffort}` : ''}
            </p>
            {entry.lastError && <p className="text-[10px] text-red-400 mt-1">{entry.lastError}</p>}
          </div>
        ))}
      </div>
      {automaticPools.length > 0 && (
        <div className="mt-4 border-t border-[var(--color-border)] pt-3">
          <p className="text-[11px] font-semibold text-[var(--color-text-secondary)] mb-2">
            Automatic Pools
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {automaticPools.map(([name, pool]) => (
              <div key={name} className="rounded-lg border border-[var(--color-border)] px-3 py-2">
                <p className="text-[12px] font-mono text-[var(--color-text-primary)]">{name}</p>
                <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
                  {pool.members.map((member) => member.model).join(' · ')}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function catalogStatusClass(status: string): string {
  if (status === 'verified') return 'text-emerald-400'
  if (status === 'unavailable' || status === 'deprecated') return 'text-red-400'
  return 'text-amber-400'
}

function ProvidersCard({
  providers,
  oauthConnecting,
  catalogRefreshing,
  chatgptUsageByProvider,
  chatgptUsageStateByProvider,
  claudeUsageByProvider,
  claudeUsageStateByProvider,
  onConnectOAuthProvider,
  onRefreshModelCatalog,
}: {
  providers: Record<string, ProviderView>
  oauthConnecting: string | null
  catalogRefreshing: string | null
  chatgptUsageByProvider: Record<string, ChatGptUsageSnapshot>
  chatgptUsageStateByProvider: Record<string, UsageState>
  claudeUsageByProvider: Record<string, ClaudeUsageSnapshot | null>
  claudeUsageStateByProvider: Record<string, UsageState>
  onConnectOAuthProvider: (provider: string, label: string) => void
  onRefreshModelCatalog: (provider: string) => void
}) {
  const chatgptProvider = providers.chatgpt
  const xPremiumProvider = providers['x-premium']

  return (
    <div className="card p-5 animate-fade-up">
      <h3 className="text-[14px] font-semibold mb-3 text-[var(--color-text-secondary)]">
        Providers
      </h3>
      <div className="space-y-3">
        {Object.entries(providers).map(([name, provider]) => (
          <ProviderRow
            key={name}
            name={name}
            provider={provider}
            oauthConnecting={oauthConnecting}
            catalogRefreshing={catalogRefreshing}
            chatgptUsage={chatgptUsageByProvider[name]}
            chatgptUsageState={chatgptUsageStateByProvider[name] ?? 'idle'}
            claudeUsage={claudeUsageByProvider[name]}
            claudeUsageState={claudeUsageStateByProvider[name] ?? 'idle'}
            onConnectOAuthProvider={onConnectOAuthProvider}
            onRefreshModelCatalog={onRefreshModelCatalog}
          />
        ))}
        {!chatgptProvider && (
          <MissingOAuthProviderRow
            name="chatgpt"
            apiType="openai_responses"
            label="ChatGPT"
            description="Connect ChatGPT OAuth to add ChatGPT/Codex models."
            oauthConnecting={oauthConnecting}
            onConnectOAuthProvider={onConnectOAuthProvider}
          />
        )}
        {!xPremiumProvider && (
          <MissingOAuthProviderRow
            name="x-premium"
            apiType="x_responses"
            label="X Premium"
            description="Connect X Premium OAuth to add Grok models."
            oauthConnecting={oauthConnecting}
            onConnectOAuthProvider={onConnectOAuthProvider}
          />
        )}
        {Object.keys(providers).length === 0 && !chatgptProvider && !xPremiumProvider && (
          <p className="text-[13px] text-[var(--color-text-muted)]">No providers configured</p>
        )}
      </div>
    </div>
  )
}

function ProviderRow({
  name,
  provider,
  oauthConnecting,
  catalogRefreshing,
  chatgptUsage,
  chatgptUsageState,
  claudeUsage,
  claudeUsageState,
  onConnectOAuthProvider,
  onRefreshModelCatalog,
}: {
  name: string
  provider: ProviderView
  oauthConnecting: string | null
  catalogRefreshing: string | null
  chatgptUsage?: ChatGptUsageSnapshot
  chatgptUsageState: UsageState
  claudeUsage?: ClaudeUsageSnapshot | null
  claudeUsageState: UsageState
  onConnectOAuthProvider: (provider: string, label: string) => void
  onRefreshModelCatalog: (provider: string) => void
}) {
  const badge = getProviderBadge(provider)
  const oauthKind = getOAuthKind(name, provider)
  const isChatgpt = oauthKind === 'chatgpt'
  const isXPremium = oauthKind === 'x-premium'
  const isClaude = oauthKind === 'anthropic'
  const oauthLabel = isXPremium ? 'X Premium' : isClaude ? 'Claude' : 'ChatGPT'
  const canConnectOAuth = Boolean(oauthKind)

  return (
    <div className="flex items-center justify-between py-2 border-b border-[var(--color-border)] gap-3">
      <div>
        <p className="text-[13px] text-[var(--color-text-primary)]">{name}</p>
        <p className="text-[11px] font-mono text-[var(--color-text-muted)]">
          {provider.apiType} · {provider.authType ?? 'unknown'}
        </p>
        {canConnectOAuth && provider.requiresRestart && (
          <p className="text-[11px] text-amber-400 mt-1">
            Authorized. Runtime reload may still be in progress.
          </p>
        )}
        {isChatgpt && provider.authorized && (
          <ChatGptUsageBlock usage={chatgptUsage} usageState={chatgptUsageState} />
        )}
        {isClaude && provider.authorized && (
          <ClaudeUsageBlock usage={claudeUsage} usageState={claudeUsageState} />
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className={`text-[11px] px-2 py-0.5 rounded-md ${badge.className}`}>
          {badge.label}
        </span>
        {canConnectOAuth && (
          <button
            type="button"
            onClick={() => onConnectOAuthProvider(name, oauthLabel)}
            disabled={oauthConnecting === name}
            className="text-[11px] px-2 py-1 rounded-md bg-[var(--color-accent-glow)] text-[var(--color-accent)] hover:opacity-90 disabled:opacity-50"
          >
            {oauthConnecting === name
              ? 'Connecting...'
              : provider.authorized
                ? 'Reconnect'
                : 'Connect'}
          </button>
        )}
        {isChatgpt && provider.authorized && (
          <button
            type="button"
            onClick={() => onRefreshModelCatalog(name)}
            disabled={catalogRefreshing === name}
            className="text-[11px] px-2 py-1 rounded-md bg-white/[0.05] text-[var(--color-text-secondary)] hover:bg-white/[0.08] disabled:opacity-50"
          >
            {catalogRefreshing === name ? 'Refreshing...' : 'Refresh models'}
          </button>
        )}
      </div>
    </div>
  )
}

function ChatGptUsageBlock({
  usage,
  usageState,
}: {
  usage?: ChatGptUsageSnapshot
  usageState: UsageState
}) {
  if (usageState === 'loading') {
    return <p className="text-[11px] text-[var(--color-text-muted)] mt-1">Loading usage...</p>
  }
  if (usageState === 'error') {
    return <p className="text-[11px] text-red-400 mt-1">Usage unavailable right now.</p>
  }
  if (usageState !== 'ready' || !usage) {
    return null
  }

  return (
    <div className="mt-1 space-y-1">
      {usage.rateLimits.primary && (
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Primary ({formatUsageWindowDuration(usage.rateLimits.primary.windowDurationMins)}) :{' '}
          {formatUsagePercent(usage.rateLimits.primary.usedPercent)} · resets{' '}
          {formatUsageResetTimestamp(usage.rateLimits.primary.resetsAt)}
        </p>
      )}
      {usage.rateLimits.secondary && (
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Secondary ({formatUsageWindowDuration(usage.rateLimits.secondary.windowDurationMins)}) :{' '}
          {formatUsagePercent(usage.rateLimits.secondary.usedPercent)} · resets{' '}
          {formatUsageResetTimestamp(usage.rateLimits.secondary.resetsAt)}
        </p>
      )}
      {(usage.rateLimits.planType || usage.rateLimits.credits?.hasCredits) && (
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Plan: {usage.rateLimits.planType ?? 'n/a'}
          {usage.rateLimits.credits?.hasCredits && (
            <>
              {' · '}
              Credits{' '}
              {usage.rateLimits.credits.unlimited
                ? 'unlimited'
                : (usage.rateLimits.credits.balance ?? 'available')}
            </>
          )}
        </p>
      )}
    </div>
  )
}

function ClaudeUsageBlock({
  usage,
  usageState,
}: {
  usage?: ClaudeUsageSnapshot | null
  usageState: UsageState
}) {
  if (usageState === 'loading') {
    return <p className="text-[11px] text-[var(--color-text-muted)] mt-1">Loading usage...</p>
  }
  if (usageState === 'error') {
    return <p className="text-[11px] text-red-400 mt-1">Usage unavailable right now.</p>
  }
  if (usageState !== 'ready' || !usage) {
    return null
  }

  return (
    <div className="mt-1 space-y-1">
      <p className="text-[11px] text-[var(--color-text-muted)]">
        5h: {formatUsagePercent(usage.five_hour?.utilization)} · resets{' '}
        {formatUsageResetAt(usage.five_hour?.resets_at)}
      </p>
      <p className="text-[11px] text-[var(--color-text-muted)]">
        7d: {formatUsagePercent(usage.seven_day?.utilization)}
        {' · '}resets {formatUsageResetAt(usage.seven_day?.resets_at)}
      </p>
      {usage.seven_day_oauth_apps && (
        <p className="text-[11px] text-[var(--color-text-muted)]">
          7d OAuth apps: {formatUsagePercent(usage.seven_day_oauth_apps.utilization)}
          {' · '}resets {formatUsageResetAt(usage.seven_day_oauth_apps.resets_at)}
        </p>
      )}
      {usage.extra_usage && (
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Extra usage: {usage.extra_usage.used_credits ?? 0}/
          {usage.extra_usage.monthly_limit ?? 'n/a'} ·{' '}
          {formatUsagePercent(usage.extra_usage.utilization)}
        </p>
      )}
    </div>
  )
}

function MissingOAuthProviderRow({
  name,
  apiType,
  label,
  description,
  oauthConnecting,
  onConnectOAuthProvider,
}: {
  name: string
  apiType: string
  label: string
  description: string
  oauthConnecting: string | null
  onConnectOAuthProvider: (provider: string, label: string) => void
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[var(--color-border)] gap-3">
      <div>
        <p className="text-[13px] text-[var(--color-text-primary)]">{name}</p>
        <p className="text-[11px] font-mono text-[var(--color-text-muted)]">{apiType} · oauth2</p>
        <p className="text-[11px] text-[var(--color-text-disabled)] mt-1">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => onConnectOAuthProvider(name, label)}
        disabled={oauthConnecting === name}
        className="text-[11px] px-2 py-1 rounded-md bg-[var(--color-accent-glow)] text-[var(--color-accent)] hover:opacity-90 disabled:opacity-50"
      >
        {oauthConnecting === name ? 'Connecting...' : `Connect ${label}`}
      </button>
    </div>
  )
}

function getProviderBadge(provider?: ProviderView) {
  if (!provider)
    return {
      label: 'Not connected',
      className: 'bg-white/[0.05] text-[var(--color-text-disabled)]',
    }
  if (provider.oauthState === 'error')
    return { label: 'Error', className: 'bg-red-400/10 text-red-400' }
  if (provider.oauthState === 'expired')
    return { label: 'Expired', className: 'bg-amber-400/10 text-amber-400' }
  if (provider.authorized)
    return { label: 'Connected', className: 'bg-emerald-400/10 text-emerald-400' }
  if (provider.configured) return { label: 'Configured', className: 'bg-sky-400/10 text-sky-400' }
  return {
    label: 'Not connected',
    className: 'bg-white/[0.05] text-[var(--color-text-disabled)]',
  }
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

function ModelPoolsEditor({
  modelPoolDrafts,
  modelPoolDirty,
  modelPoolSaving,
  newPoolName,
  physicalModelOptions,
  onNewPoolNameChange,
  onAddModelPool,
  onUpdateModelPool,
  onRemoveModelPool,
  onAddModelPoolMember,
  onUpdateModelPoolMember,
  onRemoveModelPoolMember,
  onSaveModelPools,
}: {
  modelPoolDrafts: ModelPoolDraft[]
  modelPoolDirty: boolean
  modelPoolSaving: boolean
  newPoolName: string
  physicalModelOptions: string[]
  onNewPoolNameChange: (value: string) => void
  onAddModelPool: (physicalModels: string[]) => void
  onUpdateModelPool: (id: string, patch: Partial<Omit<ModelPoolDraft, 'id'>>) => void
  onRemoveModelPool: (id: string) => void
  onAddModelPoolMember: (poolId: string, physicalModels: string[]) => void
  onUpdateModelPoolMember: (poolId: string, memberId: string, model: string) => void
  onRemoveModelPoolMember: (poolId: string, memberId: string) => void
  onSaveModelPools: () => void
}) {
  const validationErrors = getModelPoolValidationErrors(modelPoolDrafts, physicalModelOptions)
  const canSaveModelPools = modelPoolDirty && !modelPoolSaving && validationErrors.length === 0

  return (
    <div className="border-t border-[var(--color-border)] pt-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="grid gap-1">
          <h4 className="text-[13px] font-semibold text-[var(--color-text-secondary)]">
            Model Pools
          </h4>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            Sticky pools keep a session on one provider until quota or availability requires
            failover.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            aria-label="New model pool name"
            type="text"
            value={newPoolName}
            onChange={(e) => onNewPoolNameChange(e.target.value)}
            placeholder="pool/gpt-5.5"
            className="w-full sm:w-[240px] px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[13px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-disabled)] focus:outline-none focus:border-[var(--color-accent)]"
          />
          <button
            aria-label="Add model pool"
            type="button"
            onClick={() => onAddModelPool(physicalModelOptions)}
            disabled={!newPoolName.trim() || physicalModelOptions.length === 0}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:border-[var(--color-border-hover)] transition-colors disabled:opacity-40"
          >
            <Plus size={14} />
            Add Pool
          </button>
          <button
            aria-label="Save model pools"
            type="button"
            onClick={onSaveModelPools}
            disabled={!canSaveModelPools}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            <FloppyDisk size={14} />
            {modelPoolSaving ? 'Saving...' : 'Save Pools'}
          </button>
        </div>
      </div>

      {validationErrors.length > 0 && modelPoolDirty && (
        <div className="mt-3 space-y-1">
          {validationErrors.map((error) => (
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
                  onChange={(e) => onUpdateModelPool(pool.id, { name: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[13px] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
                />
              </label>
              <label className="grid gap-1 text-[11px] text-[var(--color-text-muted)]">
                Strategy
                <select
                  aria-label={`Model pool strategy ${poolIndex + 1}`}
                  value={pool.strategy}
                  onChange={(e) =>
                    onUpdateModelPool(pool.id, {
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
                onClick={() => onRemoveModelPool(pool.id)}
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
                      onChange={(e) => onUpdateModelPoolMember(pool.id, member.id, e.target.value)}
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
                      onClick={() => onRemoveModelPoolMember(pool.id, member.id)}
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
                onClick={() => onAddModelPoolMember(pool.id, physicalModelOptions)}
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
  )
}

function getModelPoolValidationErrors(modelPoolDrafts: ModelPoolDraft[], physicalModels: string[]) {
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
