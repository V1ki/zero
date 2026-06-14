import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { apiFetch, apiPost, apiPut } from '../lib/api'
import { useUIStore } from '../stores/ui'
import {
  createDraftId,
  createModelPoolDrafts,
  getOAuthKind,
  serializeModelPoolDrafts,
} from './config-shared'
import type {
  ChannelConfig,
  ChatGptUsageSnapshot,
  ClaudeUsageSnapshot,
  ConfigData,
  ConfigTab,
  ModelPoolDraft,
  ModelPoolView,
} from './config-shared'

export function useConfigPageState() {
  const [config, setConfig] = useState<ConfigData | null>(null)
  const [oauthConnecting, setOauthConnecting] = useState<string | null>(null)
  const [channels, setChannels] = useState<ChannelConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<ConfigTab>('models')
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set())
  const [showAddSecret, setShowAddSecret] = useState(false)
  const [newSecretKey, setNewSecretKey] = useState('')
  const [newSecretValue, setNewSecretValue] = useState('')
  const [secretSaving, setSecretSaving] = useState(false)
  const [lastStableTag, setLastStableTag] = useState<string | null>(null)
  const [rollbackLoading, setRollbackLoading] = useState(false)
  const [rollbackResult, setRollbackResult] = useState<string | null>(null)
  const [deleteSecretKey, setDeleteSecretKey] = useState<string | null>(null)
  const [showRollbackConfirm, setShowRollbackConfirm] = useState(false)
  const { addToast } = useUIStore()
  const oauthUsage = useOAuthUsage(config)
  const modelPools = useModelPoolState({
    modelPools: config?.modelPools,
    setConfig,
    addToast,
  })

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
      // Silently handle; the form stays open so the user can retry.
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
      // Error toast handled by api layer.
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
      // Error toast handled by api layer.
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
      // Error toast handled by api layer.
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
      // Error toast handled by api layer.
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

  function toggleReveal(key: string) {
    setRevealedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function handleCancelAddSecret() {
    setShowAddSecret(false)
    setNewSecretKey('')
    setNewSecretValue('')
  }

  return {
    config,
    providers: config?.providers ?? {},
    ...modelPools,
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
    ...oauthUsage,
    setTab,
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
    handleConnectOAuthProvider,
    toggleReveal,
    handleCancelAddSecret,
  }
}

type OAuthUsageState = 'idle' | 'loading' | 'ready' | 'error'

interface ModelPoolStateOptions {
  modelPools?: Record<string, ModelPoolView>
  setConfig: Dispatch<SetStateAction<ConfigData | null>>
  addToast: (type: 'success' | 'error' | 'info' | 'warning', message: string) => void
}

function useOAuthUsage(config: ConfigData | null) {
  const [chatgptUsageByProvider, setChatgptUsageByProvider] = useState<
    Record<string, ChatGptUsageSnapshot>
  >({})
  const [chatgptUsageStateByProvider, setChatgptUsageStateByProvider] = useState<
    Record<string, OAuthUsageState>
  >({})
  const [claudeUsageByProvider, setClaudeUsageByProvider] = useState<
    Record<string, ClaudeUsageSnapshot | null>
  >({})
  const [claudeUsageStateByProvider, setClaudeUsageStateByProvider] = useState<
    Record<string, OAuthUsageState>
  >({})

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

  return {
    chatgptUsageByProvider,
    chatgptUsageStateByProvider,
    claudeUsageByProvider,
    claudeUsageStateByProvider,
  }
}

function useModelPoolState(options: ModelPoolStateOptions) {
  const [modelPoolDrafts, setModelPoolDrafts] = useState<ModelPoolDraft[]>([])
  const [modelPoolDirty, setModelPoolDirty] = useState(false)
  const [modelPoolSaving, setModelPoolSaving] = useState(false)
  const [newPoolName, setNewPoolName] = useState('')

  useEffect(() => {
    setModelPoolDrafts(createModelPoolDrafts(options.modelPools ?? {}))
    setModelPoolDirty(false)
  }, [options.modelPools])

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
      options.setConfig((prev) =>
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
      options.addToast('success', 'Model pools saved and runtime reloaded')
    } catch {
      // Error toast handled by api layer.
    } finally {
      setModelPoolSaving(false)
    }
  }

  return {
    modelPoolDrafts,
    modelPoolDirty,
    modelPoolSaving,
    newPoolName,
    setNewPoolName,
    handleAddModelPool,
    handleUpdateModelPool,
    handleRemoveModelPool,
    handleAddModelPoolMember,
    handleUpdateModelPoolMember,
    handleRemoveModelPoolMember,
    handleSaveModelPools,
  }
}
