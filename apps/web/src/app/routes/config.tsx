import { Eye, EyeSlash, Plus, Trash } from '@phosphor-icons/react'
import { ConfirmDialog } from '../components/shared/ConfirmDialog'
import { SkeletonCard } from '../components/shared/Skeleton'
import { ConfigModelsTab } from './config-models-tab'
import { useConfigPageState } from './config-page-state'
import { CONFIG_TABS, type ChannelConfig, type ConfigData } from './config-shared'

export function ConfigPage() {
  const {
    config,
    providers,
    modelPoolDrafts,
    modelPoolDirty,
    modelPoolSaving,
    newPoolName,
    oauthConnecting,
    channels,
    loading,
    tab,
    revealedKeys,
    showAddSecret,
    newSecretKey,
    newSecretValue,
    secretSaving,
    lastStableTag,
    rollbackLoading,
    rollbackResult,
    deleteSecretKey,
    showRollbackConfirm,
    chatgptUsageByProvider,
    chatgptUsageStateByProvider,
    claudeUsageByProvider,
    claudeUsageStateByProvider,
    setTab,
    setNewPoolName,
    setShowAddSecret,
    setNewSecretKey,
    setNewSecretValue,
    setDeleteSecretKey,
    setShowRollbackConfirm,
    handleAddSecret,
    handleDeleteSecret,
    handleRollback,
    handleSetTaskClosureModel,
    handleSetContextCompactionModel,
    handleSetDefaultModel,
    handleAddModelPool,
    handleUpdateModelPool,
    handleRemoveModelPool,
    handleAddModelPoolMember,
    handleUpdateModelPoolMember,
    handleRemoveModelPoolMember,
    handleSaveModelPools,
    handleConnectOAuthProvider,
    toggleReveal,
    handleCancelAddSecret,
  } = useConfigPageState()

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <h1 className="text-[20px] font-bold tracking-tight mb-4">Config</h1>

      {/* Tab bar */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {CONFIG_TABS.map((t) => (
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
            <ConfigModelsTab
              config={config}
              providers={providers}
              modelPoolDrafts={modelPoolDrafts}
              modelPoolDirty={modelPoolDirty}
              modelPoolSaving={modelPoolSaving}
              newPoolName={newPoolName}
              oauthConnecting={oauthConnecting}
              chatgptUsageByProvider={chatgptUsageByProvider}
              chatgptUsageStateByProvider={chatgptUsageStateByProvider}
              claudeUsageByProvider={claudeUsageByProvider}
              claudeUsageStateByProvider={claudeUsageStateByProvider}
              onNewPoolNameChange={setNewPoolName}
              onConnectOAuthProvider={handleConnectOAuthProvider}
              onSetDefaultModel={handleSetDefaultModel}
              onAddModelPool={handleAddModelPool}
              onUpdateModelPool={handleUpdateModelPool}
              onRemoveModelPool={handleRemoveModelPool}
              onAddModelPoolMember={handleAddModelPoolMember}
              onUpdateModelPoolMember={handleUpdateModelPoolMember}
              onRemoveModelPoolMember={handleRemoveModelPoolMember}
              onSaveModelPools={handleSaveModelPools}
              onSetTaskClosureModel={handleSetTaskClosureModel}
              onSetContextCompactionModel={handleSetContextCompactionModel}
            />
          )}

          {/* Scheduler tab */}
          {tab === 'scheduler' && <SchedulerTab config={config} />}

          {/* Fuse List tab */}
          {tab === 'fuse' && <FuseListTab config={config} />}

          {/* Secrets tab */}
          {tab === 'secrets' && (
            <ConfigSecretsTab
              config={config}
              channels={channels}
              revealedKeys={revealedKeys}
              showAddSecret={showAddSecret}
              newSecretKey={newSecretKey}
              newSecretValue={newSecretValue}
              secretSaving={secretSaving}
              onToggleAddSecret={() => setShowAddSecret((value) => !value)}
              onNewSecretKeyChange={setNewSecretKey}
              onNewSecretValueChange={setNewSecretValue}
              onAddSecret={handleAddSecret}
              onCancelAddSecret={handleCancelAddSecret}
              onToggleReveal={toggleReveal}
              onDeleteSecretRequest={setDeleteSecretKey}
            />
          )}

          {/* Channels tab */}
          {tab === 'channels' && <ChannelsTab channels={channels} />}

          {/* Version tab */}
          {tab === 'version' && (
            <VersionTab
              lastStableTag={lastStableTag}
              rollbackLoading={rollbackLoading}
              rollbackResult={rollbackResult}
              onRollbackRequest={() => setShowRollbackConfirm(true)}
            />
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

function SchedulerTab({ config }: { config: ConfigData | null }) {
  return (
    <div className="card p-5 animate-fade-up">
      <h3 className="text-[14px] font-semibold mb-3 text-[var(--color-text-secondary)]">
        Scheduled Tasks
      </h3>
      {config?.schedules && config.schedules.length > 0 ? (
        <div className="space-y-2">
          {config.schedules.map((schedule) => (
            <div
              key={`${schedule.name}-${schedule.cron}-${schedule.task}`}
              className="flex items-center justify-between py-2 border-b border-[var(--color-border)]"
            >
              <div>
                <p className="text-[13px] text-[var(--color-text-primary)]">{schedule.name}</p>
                <p className="text-[11px] font-mono text-[var(--color-text-muted)]">
                  {schedule.cron}
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[13px] text-[var(--color-text-muted)]">No scheduled tasks configured</p>
      )}
    </div>
  )
}

function FuseListTab({ config }: { config: ConfigData | null }) {
  return (
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
  )
}

function ConfigSecretsTab({
  config,
  channels,
  revealedKeys,
  showAddSecret,
  newSecretKey,
  newSecretValue,
  secretSaving,
  onToggleAddSecret,
  onNewSecretKeyChange,
  onNewSecretValueChange,
  onAddSecret,
  onCancelAddSecret,
  onToggleReveal,
  onDeleteSecretRequest,
}: {
  config: ConfigData | null
  channels: ChannelConfig[]
  revealedKeys: Set<string>
  showAddSecret: boolean
  newSecretKey: string
  newSecretValue: string
  secretSaving: boolean
  onToggleAddSecret: () => void
  onNewSecretKeyChange: (value: string) => void
  onNewSecretValueChange: (value: string) => void
  onAddSecret: () => void
  onCancelAddSecret: () => void
  onToggleReveal: (key: string) => void
  onDeleteSecretRequest: (key: string) => void
}) {
  const channelSecrets = channels.flatMap((ch) => ch.secrets)

  return (
    <div className="card p-5 animate-fade-up">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[14px] font-semibold text-[var(--color-text-secondary)]">Secrets</h3>
        <button
          type="button"
          onClick={onToggleAddSecret}
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
            onChange={(e) => onNewSecretKeyChange(e.target.value)}
            className="flex-1 px-2 py-1.5 rounded-md text-[12px] bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-disabled)] focus:outline-none focus:border-[var(--color-accent)]"
          />
          <input
            type="password"
            placeholder="Value"
            value={newSecretValue}
            onChange={(e) => onNewSecretValueChange(e.target.value)}
            className="flex-1 px-2 py-1.5 rounded-md text-[12px] bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-disabled)] focus:outline-none focus:border-[var(--color-accent)]"
          />
          <button
            type="button"
            onClick={onAddSecret}
            disabled={secretSaving || !newSecretKey.trim() || !newSecretValue.trim()}
            className="px-3 py-1.5 rounded-md text-[12px] bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {secretSaving ? 'Saving...' : 'Save'}
          </button>
          <button
            type="button"
            onClick={onCancelAddSecret}
            className="px-2 py-1.5 rounded-md text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          >
            Cancel
          </button>
        </div>
      )}
      {config?.secrets && config.secrets.length > 0 ? (
        <div className="space-y-2">
          {config.secrets.map((secret) => (
            <div
              key={secret.key}
              className="flex items-center justify-between py-2 px-3 rounded-lg border border-[var(--color-border)]"
            >
              <div className="flex items-center gap-3">
                <span
                  className={`w-2 h-2 rounded-full ${
                    secret.configured ? 'bg-emerald-400' : 'bg-red-400'
                  }`}
                />
                <span className="text-[13px] font-mono text-[var(--color-text-primary)]">
                  {secret.key}
                </span>
                <span className="text-[12px] font-mono text-[var(--color-text-disabled)]">
                  {revealedKeys.has(secret.key)
                    ? secret.masked
                    : `${secret.masked.replace(/[^.]/g, '*').slice(0, 12)}****`}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onToggleReveal(secret.key)}
                  className="p-1.5 rounded-md hover:bg-white/[0.05] text-[var(--color-text-muted)]"
                >
                  {revealedKeys.has(secret.key) ? <EyeSlash size={14} /> : <Eye size={14} />}
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteSecretRequest(secret.key)}
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
          {channelSecrets.length > 0 ? (
            channelSecrets.map((secret) => (
              <div
                key={secret.key}
                className="flex items-center justify-between py-2 px-3 rounded-lg border border-[var(--color-border)]"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      secret.configured ? 'bg-emerald-400' : 'bg-red-400'
                    }`}
                  />
                  <span className="text-[13px] font-mono text-[var(--color-text-primary)]">
                    {secret.key}
                  </span>
                  <span className="text-[12px] font-mono text-[var(--color-text-disabled)]">
                    {secret.configured ? 'sk-...configured' : 'not configured'}
                  </span>
                </div>
                <span
                  className={`text-[11px] px-2 py-0.5 rounded-md ${
                    secret.configured
                      ? 'bg-emerald-400/10 text-emerald-400'
                      : 'bg-red-400/10 text-red-400'
                  }`}
                >
                  {secret.configured ? 'Active' : 'Missing'}
                </span>
              </div>
            ))
          ) : (
            <p className="text-[13px] text-[var(--color-text-muted)]">No secrets configured</p>
          )}
        </div>
      )}
    </div>
  )
}

function ChannelsTab({ channels }: { channels: ChannelConfig[] }) {
  return (
    <div className="card p-5 animate-fade-up">
      <h3 className="text-[14px] font-semibold mb-3 text-[var(--color-text-secondary)]">
        Channels
      </h3>
      <div className="space-y-3">
        {channels.map((channel) => (
          <ChannelRow key={channel.name} channel={channel} />
        ))}
        {channels.length === 0 && (
          <p className="text-[13px] text-[var(--color-text-muted)]">No channels configured</p>
        )}
      </div>
    </div>
  )
}

function ChannelRow({ channel }: { channel: ChannelConfig }) {
  const isOnline = channel.status === 'online'
  return (
    <div
      className={`flex items-center justify-between py-3 px-3 rounded-lg border ${
        isOnline ? 'border-[var(--color-border)]' : 'border-red-400/30 bg-red-400/[0.05]'
      }`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`w-2 h-2 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-red-400 animate-pulse'}`}
        />
        <div>
          <p className="text-[13px] text-[var(--color-text-primary)] capitalize">{channel.name}</p>
          <p className="text-[11px] font-mono text-[var(--color-text-muted)]">{channel.codePath}</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {channel.secrets.length > 0 && (
          <div className="flex items-center gap-2">
            {channel.secrets.map((secret) => (
              <span
                key={secret.key}
                className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                  secret.configured
                    ? 'bg-emerald-400/10 text-emerald-400'
                    : 'bg-red-400/10 text-red-400'
                }`}
              >
                {secret.key}
              </span>
            ))}
          </div>
        )}
        <span
          className={`text-[11px] px-2 py-0.5 rounded-md ${
            isOnline ? 'bg-emerald-400/10 text-emerald-400' : 'bg-red-400/10 text-red-400'
          }`}
        >
          {channel.status}
        </span>
      </div>
    </div>
  )
}

function VersionTab({
  lastStableTag,
  rollbackLoading,
  rollbackResult,
  onRollbackRequest,
}: {
  lastStableTag: string | null
  rollbackLoading: boolean
  rollbackResult: string | null
  onRollbackRequest(): void
}) {
  return (
    <div className="card p-5 animate-fade-up">
      <h3 className="text-[14px] font-semibold mb-3 text-[var(--color-text-secondary)]">
        Version Info
      </h3>
      <div className="space-y-3">
        <VersionRow label="Version" value="v0.1.0" />
        <VersionRow label="Runtime" value="Bun" />
        <VersionRow label="Platform" value="macOS" />
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
                  onClick={onRollbackRequest}
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
  )
}

function VersionRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[var(--color-border)]">
      <span className="text-[13px] text-[var(--color-text-muted)]">{label}</span>
      <span className="text-[13px] font-mono text-[var(--color-text-primary)]">{value}</span>
    </div>
  )
}
