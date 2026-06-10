import { buildSessionInfoReply, loadConfig, parseSessionArgs } from '@zero-os/core'
import { getMemoryClusters, invalidateClusterCache } from '@zero-os/memory'
import {
  ALL_MEMORY_TYPES,
  type MemoryEdge,
  type MemoryStatus,
  type MemoryType,
  type ModelPoolConfig,
  type ModelPricing,
  clampConfidence,
  isMemoryStatus,
  toErrorMessage,
} from '@zero-os/shared'
import { readYaml, writeYaml } from '@zero-os/shared/utils'
import { GitOps } from '@zero-os/supervisor'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getConfigPath } from '../../../server/src/chatgpt-provider'
import { ChatGptUsageService } from '../../../server/src/chatgpt-usage'
import { ClaudeUsageService } from '../../../server/src/claude-usage'
import type { ZeroOS } from '../../../server/src/main'
import {
  createManagedOAuthCoordinator,
  getManagedOAuthKindForProvider,
  isManagedOAuthProvider,
  isManagedOAuthTokenRef,
  prepareManagedOAuthProvider,
  syncManagedOAuthCoordinator,
} from '../../../server/src/provider-oauth'
import type { SessionJudgeHistoryResponse, StoredSessionJudgeEntry } from '../eval/types'
import { runSessionJudge } from './session-judge'

export function createRoutes(zero: ZeroOS) {
  const managedOAuth = createManagedOAuthCoordinator(zero.vault, loadConfig(getConfigPath()))

  const MODEL_POOL_STRATEGIES = new Set([
    'sticky_quota_aware_failover',
    'sticky_priority_failover',
    'priority_failover',
  ])

  interface TraceLogEntry {
    spanId: string
    ts: string
    sessionId: string
    kind: string
    name: string
    status: string
    durationMs?: number
    childCount: number
  }

  function readCurrentConfig() {
    return loadConfig(getConfigPath())
  }

  function omitConfigKey(config: Record<string, unknown>, key: string): Record<string, unknown> {
    const { [key]: _omitted, ...rest } = config
    return rest
  }

  function normalizeModelPoolsForWrite(value: unknown): Record<string, ModelPoolConfig> {
    if (value === null || value === undefined || value === '') return {}
    if (!isRecord(value)) {
      throw new Error('modelPools must be an object')
    }

    const pools: Record<string, ModelPoolConfig> = {}
    for (const [rawName, rawPool] of Object.entries(value)) {
      const name = rawName.trim()
      if (!name) continue
      if (!isRecord(rawPool)) {
        throw new Error(`Model pool ${name} must be an object`)
      }

      const rawStrategy = rawPool.strategy
      const strategy: ModelPoolConfig['strategy'] =
        typeof rawStrategy === 'string' && MODEL_POOL_STRATEGIES.has(rawStrategy)
          ? (rawStrategy as ModelPoolConfig['strategy'])
          : 'sticky_quota_aware_failover'
      const rawMembers = Array.isArray(rawPool.members) ? rawPool.members : []
      const members: ModelPoolConfig['members'] = []
      for (const [index, member] of rawMembers.entries()) {
        if (typeof member === 'string') {
          const model = member.trim()
          if (model) members.push({ model, priority: index })
          continue
        }
        if (!isRecord(member) || typeof member.model !== 'string') continue
        const model = member.model.trim()
        if (!model) continue
        members.push({
          model,
          priority: typeof member.priority === 'number' ? member.priority : index,
        })
      }

      if (members.length === 0) {
        throw new Error(`Model pool ${name} must include at least one member`)
      }
      pools[name] = { strategy, members }
    }

    return pools
  }

  function normalizeRecoveredProviders(value: unknown): string[] {
    const values = Array.isArray(value) ? value : [value]
    return Array.from(
      new Set(
        values
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter((item) => item.length > 0),
      ),
    )
  }

  function formatModelLabel(providerName: string, modelName: string) {
    return `${providerName}/${modelName}`
  }

  function markProviderAuthRecovered(providerName: string, source: string) {
    if (providerName in zero.config.providers) {
      zero.providerHealth.markAuthRecovered(providerName, { source })
    }
  }

  async function getManagedOAuthStatus(provider: string, refresh?: string) {
    if (refresh === 'soft') {
      return await managedOAuth.getStatusWithRefresh(provider)
    }
    if (refresh === 'hard') {
      return await managedOAuth.getStatusWithRefresh(provider, { strict: true, force: true })
    }
    return managedOAuth.getStatus(provider)
  }

  function parseLogLimit(value: string | undefined, fallback: number, max: number) {
    const parsed = Number(value ?? fallback)
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback
    return Math.min(Math.floor(parsed), max)
  }

  function matchesRunLogQuery(entry: Record<string, unknown>, query: string) {
    if (!query) return true
    return JSON.stringify(entry).toLowerCase().includes(query.toLowerCase())
  }

  async function buildProvidersForConfig() {
    const config = readCurrentConfig()
    syncManagedOAuthCoordinator(managedOAuth, config)
    return Object.fromEntries(
      await Promise.all(
        Object.entries(config.providers).map(async ([name, provider]) => {
          const secretRef = provider.auth.apiKeyRef ?? provider.auth.oauthTokenRef
          const configured = secretRef ? !!zero.vault.get(secretRef) : false
          const oauthStatus = managedOAuth.supportsProvider(name)
            ? managedOAuth.getStatus(name)
            : undefined

          return [
            name,
            {
              apiType: provider.apiType,
              baseUrl: provider.baseUrl,
              authType: provider.auth.type,
              managedOAuthProvider: provider.auth.managedOAuthProvider,
              secretRef,
              configured,
              authorized: oauthStatus ? oauthStatus.authorized : configured,
              oauthState: oauthStatus?.state,
              requiresRestart: oauthStatus?.requiresRestart ?? false,
              models: provider.models,
            },
          ]
        }),
      ),
    )
  }

  async function fetchManagedOAuthUsage(providerName: string) {
    const config = readCurrentConfig()
    const provider = config.providers[providerName]
    const kind = provider
      ? getManagedOAuthKindForProvider(providerName, provider.auth.managedOAuthProvider)
      : undefined
    const tokenRef = provider?.auth.oauthTokenRef
    if (kind && provider && tokenRef) {
      switch (kind) {
        case 'chatgpt': {
          const usage = await new ChatGptUsageService(zero.vault, {
            providerName,
            tokenRef,
            baseUrl: provider.baseUrl,
          }).fetchUsage()
          return { provider: providerName, usage }
        }
        case 'anthropic': {
          const usage = await new ClaudeUsageService(zero.vault, {
            providerName,
            tokenRef,
          }).fetchUsage()
          return { provider: providerName, usage }
        }
        case 'x-premium':
          return { provider: providerName, usage: null }
      }
    }

    if (!isManagedOAuthProvider(providerName)) {
      throw new Error('Unsupported OAuth provider')
    }

    switch (providerName) {
      case 'chatgpt': {
        const usage = await new ChatGptUsageService(zero.vault).fetchUsage()
        return { provider: providerName, usage }
      }
      case 'anthropic': {
        const usage = await new ClaudeUsageService(zero.vault).fetchUsage()
        return { provider: providerName, usage }
      }
      case 'x-premium':
        return { provider: providerName, usage: null }
    }
  }

  function resolvePricing(providerName: string, modelName: string): ModelPricing | undefined {
    const candidates = [modelName]
    if (!modelName.startsWith(`${providerName}/`)) {
      candidates.push(formatModelLabel(providerName, modelName))
    }

    for (const candidate of candidates) {
      const resolved = zero.modelRouter.resolveModel(candidate)
      if (resolved && resolved.providerName === providerName) {
        return resolved.modelConfig.pricing
      }
    }

    return undefined
  }

  function computeCacheEconomics(
    cacheReadTokens: number,
    cacheWriteTokens: number,
    pricing?: ModelPricing,
  ) {
    const perMillion = 1_000_000
    const cacheReadCost =
      pricing?.cacheRead !== undefined ? (cacheReadTokens * pricing.cacheRead) / perMillion : 0
    const cacheWriteCost =
      pricing?.cacheWrite !== undefined ? (cacheWriteTokens * pricing.cacheWrite) / perMillion : 0
    const grossAvoidedInputCost =
      pricing?.input !== undefined ? (cacheReadTokens * pricing.input) / perMillion : 0
    const uncachedBaselineCost =
      pricing?.input !== undefined
        ? ((cacheReadTokens + cacheWriteTokens) * pricing.input) / perMillion
        : 0

    return {
      cacheReadCost,
      cacheWriteCost,
      grossAvoidedInputCost,
      netSavings: uncachedBaselineCost - cacheReadCost - cacheWriteCost,
    }
  }

  function summarizeSessionCacheEconomics(sessionId: string) {
    const requests = zero.observability.readSessionRequests(sessionId)
    let cacheReadCost = 0
    let cacheWriteCost = 0
    let grossAvoidedInputCost = 0
    let netSavings = 0

    for (const request of requests) {
      const pricing = resolvePricing(request.provider, request.model)
      const economics = computeCacheEconomics(
        request.tokens.cacheRead ?? 0,
        request.tokens.cacheWrite ?? 0,
        pricing,
      )
      cacheReadCost += economics.cacheReadCost
      cacheWriteCost += economics.cacheWriteCost
      grossAvoidedInputCost += economics.grossAvoidedInputCost
      netSavings += economics.netSavings
    }

    return {
      cacheReadCost,
      cacheWriteCost,
      grossAvoidedInputCost,
      netSavings,
    }
  }

  function getSessionRow(id: string) {
    const activeSession = zero.sessionManager.get(id)
    if (activeSession) {
      return {
        id: activeSession.data.id,
        source: activeSession.data.source,
      }
    }

    return zero.sessionManager.getFromDB(id)
  }

  function getCurrentSessionIds() {
    return new Set(zero.sessionManager.listCurrentBindings().map((binding) => binding.sessionId))
  }

  function getCurrentWebSession() {
    return zero.sessionManager.getCurrentSessionForChannel('web', 'default', 'web')
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  function sanitizeClassifierRequestForClient(value: unknown) {
    if (!isRecord(value)) return value

    const { system: _system, ...rest } = value
    return rest
  }

  function sanitizeTracePayloadForClient(
    payload: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!payload) return payload

    const next = { ...payload }

    if ('classifierRequest' in next) {
      next.classifierRequest = sanitizeClassifierRequestForClient(next.classifierRequest)
    }

    if (isRecord(next.closure)) {
      next.closure = {
        ...next.closure,
        classifierRequest: sanitizeClassifierRequestForClient(next.closure.classifierRequest),
      }
    }

    return next
  }

  function sanitizeTraceSpanForClient<
    T extends { data?: Record<string, unknown>; metadata?: Record<string, unknown>; children: T[] },
  >(span: T): T {
    return {
      ...span,
      data: sanitizeTracePayloadForClient(span.data),
      metadata: sanitizeTracePayloadForClient(span.metadata),
      children: span.children.map((child) => sanitizeTraceSpanForClient(child)),
    }
  }

  function sanitizeClosureEntryForClient<T extends { classifierRequest?: unknown }>(entry: T): T {
    return {
      ...entry,
      classifierRequest: sanitizeClassifierRequestForClient(entry.classifierRequest),
    }
  }

  const app = new Hono()
    .use('*', cors())

    // System status
    .get('/api/status', (c) => {
      const currentSessions = zero.sessionManager.listCurrent()
      const heartbeat = zero.heartbeat.getLastHeartbeat()
      const heartbeatAge = heartbeat
        ? Math.max(0, Math.floor((Date.now() - new Date(heartbeat.timestamp).getTime()) / 1000))
        : 0
      const status = heartbeat && heartbeat.health.status !== 'healthy' ? 'degraded' : 'running'
      const currentWebSession = getCurrentWebSession()

      return c.json({
        status,
        uptime: process.uptime(),
        currentModel:
          currentWebSession?.data.currentModel ?? zero.sessionManager.getPreferredModel('web'),
        version: '0.1.0',
        heartbeatAge,
        currentSessions: currentSessions.length,
      })
    })

    .get('/api/models', (c) => {
      const models = zero.modelRouter
        .getRegistry()
        .listModels()
        .map((model) => ({
          name: formatModelLabel(model.providerName, model.modelName),
          provider: model.providerName,
          modelId: model.modelId,
          tags: model.tags,
        }))
      return c.json({ models })
    })

    .post('/api/chat/model', async (c) => {
      const body = await c.req.json<{ model: string; sessionId?: string }>()
      if (!body.model) {
        return c.json({ error: 'model is required' }, 400)
      }

      if (body.sessionId) {
        const session = zero.sessionManager.get(body.sessionId)
        if (!session) {
          return c.json({ error: 'Session not found' }, 404)
        }

        const result = await session.switchModel(body.model)
        if (!result.success) {
          return c.json({ error: result.message }, 400)
        }

        return c.json({
          ok: true,
          currentModel: session.data.currentModel,
          message: result.message,
        })
      }

      const result = zero.modelRouter.selectModel(body.model)
      if (!result.success || !result.model) {
        return c.json({ error: result.message }, 400)
      }

      const currentModel = zero.sessionManager.setPreferredModel(
        'web',
        'default',
        body.model,
        'web',
      )
      return c.json({ ok: true, currentModel, message: result.message })
    })

    // Sessions
    .get('/api/sessions', (c) => {
      const rawFilter = c.req.query('filter') ?? 'all'
      // Keep accepting the old status-shaped filter values while callers finish migrating to the
      // new current/background vocabulary.
      const filter =
        rawFilter === 'active'
          ? 'current'
          : rawFilter === 'completed' || rawFilter === 'archived'
            ? 'background'
            : rawFilter
      const q = c.req.query('q')?.toLowerCase() ?? ''
      const currentIds = getCurrentSessionIds()

      let sessions =
        filter === 'current' ? zero.sessionManager.listCurrent() : zero.sessionManager.listAll()

      if (filter === 'background') {
        sessions = sessions.filter((session) => !currentIds.has(session.data.id))
      }

      const sessionIds = sessions.map((s) => s.data.id)
      const statsBatch = zero.metrics.sessionStatsBatch(sessionIds)

      const result: Array<Record<string, unknown>> = sessions.map((s) => {
        const msgs = s.getMessages()
        const toolCallCount = msgs
          .flatMap((m) => m.content)
          .filter((b) => b.type === 'tool_use').length
        const userMessageCount = msgs.filter(
          (m) => m.role === 'user' && !m.content.every((b) => b.type === 'tool_result'),
        ).length
        const assistantMessageCount = msgs.filter(
          (m) => m.role === 'assistant' && m.content.some((b) => b.type === 'text'),
        ).length
        const stats = statsBatch.get(s.data.id)
        const isCurrent = currentIds.has(s.data.id)

        return {
          id: s.data.id,
          source: s.data.source,
          channelName: s.data.channelName,
          isCurrent,
          placement: isCurrent ? 'current' : 'background',
          currentModel: s.data.currentModel,
          createdAt: s.data.createdAt,
          updatedAt: s.data.updatedAt,
          messageCount: msgs.length,
          tags: s.data.tags,
          summary: s.data.summary,
          channelId: s.data.channelId,
          modelHistory: s.data.modelHistory,
          toolCallCount,
          userMessageCount,
          assistantMessageCount,
          totalTokens: stats?.totalTokens ?? 0,
          totalCost: stats?.totalCost ?? 0,
        }
      })

      if (filter !== 'current') {
        const inMemoryIds = new Set(sessionIds)
        const dbRows = zero.sessionManager.listAllFromDB()
        const dbOnlyIds = dbRows.filter((r) => !inMemoryIds.has(r.id)).map((r) => r.id)
        const dbStatsBatch =
          dbOnlyIds.length > 0 ? zero.metrics.sessionStatsBatch(dbOnlyIds) : new Map()

        for (const row of dbRows) {
          if (inMemoryIds.has(row.id)) continue
          const isCurrent = currentIds.has(row.id)
          if (filter === 'background' && isCurrent) continue
          const stats = dbStatsBatch.get(row.id)
          result.push({
            id: row.id,
            source: row.source,
            channelName: row.channelName,
            isCurrent,
            placement: isCurrent ? 'current' : 'background',
            currentModel: row.currentModel,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            messageCount: 0,
            tags: row.tags,
            summary: row.summary,
            channelId: row.channelId,
            modelHistory: row.modelHistory,
            toolCallCount: 0,
            userMessageCount: 0,
            assistantMessageCount: 0,
            totalTokens: stats?.totalTokens ?? 0,
            totalCost: stats?.totalCost ?? 0,
          })
        }
      }

      const filtered = (
        q
          ? result.filter(
              (s) =>
                (s.id as string).toLowerCase().includes(q) ||
                (s.source as string).toLowerCase().includes(q) ||
                ((s.channelName as string)?.toLowerCase().includes(q) ?? false) ||
                (s.currentModel as string).toLowerCase().includes(q) ||
                ((s.summary as string)?.toLowerCase().includes(q) ?? false) ||
                ((s.channelId as string)?.toLowerCase().includes(q) ?? false),
            )
          : result
      ).sort((left, right) => (right.updatedAt as string).localeCompare(left.updatedAt as string))

      return c.json({ sessions: filtered })
    })

    .get('/api/sessions/channel/:channel/current', (c) => {
      const channel = c.req.param('channel')

      const sessions = zero.sessionManager
        .listCurrentBindings()
        .filter((binding) => binding.channelId === channel)
        .map((binding) => {
          const session = zero.sessionManager.get(binding.sessionId)
          const row = session ? null : zero.sessionManager.getFromDB(binding.sessionId)
          return {
            id: binding.sessionId,
            source: binding.source,
            channelName: binding.channelName,
            channelId: binding.channelId,
            isCurrent: true,
            placement: 'current' as const,
            updatedAt: session?.data.updatedAt ?? row?.updatedAt ?? binding.updatedAt,
            summary: session?.data.summary ?? row?.summary,
          }
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

      return c.json({ sessions })
    })

    .get('/api/sessions/sources/current', (c) => {
      const sources = new Map<
        string,
        { source: string; channelCount: number; updatedAt: string | null }
      >()

      for (const binding of zero.sessionManager.listCurrentBindings()) {
        const session = zero.sessionManager.get(binding.sessionId)
        const row = session ? null : zero.sessionManager.getFromDB(binding.sessionId)
        const updatedAt = session?.data.updatedAt ?? row?.updatedAt ?? binding.updatedAt
        const existing = sources.get(binding.source)

        if (!existing) {
          sources.set(binding.source, {
            source: binding.source,
            channelCount: 1,
            updatedAt,
          })
          continue
        }

        existing.channelCount += 1
        if (!existing.updatedAt || updatedAt.localeCompare(existing.updatedAt) > 0) {
          existing.updatedAt = updatedAt
        }
      }

      return c.json({
        sources: Array.from(sources.values()).sort((left, right) =>
          (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''),
        ),
      })
    })

    .get('/api/sessions/source/:source/current', (c) => {
      const source = c.req.param('source')

      const sessions = zero.sessionManager
        .listCurrentBindings()
        .filter((binding) => binding.source === source)
        .map((binding) => {
          const session = zero.sessionManager.get(binding.sessionId)
          const row = session ? null : zero.sessionManager.getFromDB(binding.sessionId)
          return {
            id: binding.sessionId,
            source: binding.source,
            channelName: binding.channelName,
            channelId: binding.channelId,
            isCurrent: true,
            placement: 'current' as const,
            updatedAt: session?.data.updatedAt ?? row?.updatedAt ?? binding.updatedAt,
            summary: session?.data.summary ?? row?.summary,
          }
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

      return c.json({ sessions })
    })

    .get('/api/sessions/:id', (c) => {
      const id = c.req.param('id')
      const session = zero.sessionManager.get(id)
      if (session) {
        const stats = zero.metrics.sessionStats(id)
        const auxiliaryCost = zero.metrics.sessionAuxiliaryCost(id)
        const purposeBreakdown = zero.metrics.sessionUsageByPurpose(id)
        const cacheEconomics = summarizeSessionCacheEconomics(id)
        const isCurrent = zero.sessionManager.isCurrentSessionId(id)
        return c.json({
          id: session.data.id,
          source: session.data.source,
          channelName: session.data.channelName,
          channelId: session.data.channelId,
          isCurrent,
          placement: isCurrent ? 'current' : 'background',
          currentModel: session.data.currentModel,
          createdAt: session.data.createdAt,
          updatedAt: session.data.updatedAt,
          messages: session.getMessages(),
          timelineCompactionBlocks: session.getTimelineCompactionBlocks(),
          tags: session.data.tags,
          summary: session.data.summary,
          modelHistory: session.data.modelHistory,
          systemPrompt: session.getSystemPrompt() || undefined,
          totalTokens: stats.totalTokens,
          inputTokens: stats.inputTokens,
          outputTokens: stats.outputTokens,
          cacheWriteTokens: stats.cacheWriteTokens,
          cacheReadTokens: stats.cacheReadTokens,
          reasoningTokens: stats.reasoningTokens,
          effectiveInputTokens: stats.effectiveInputTokens,
          cacheHitRate: stats.cacheHitRate,
          cacheReadCost: cacheEconomics.cacheReadCost,
          cacheWriteCost: cacheEconomics.cacheWriteCost,
          grossAvoidedInputCost: cacheEconomics.grossAvoidedInputCost,
          netSavings: cacheEconomics.netSavings,
          totalCost: stats.totalCost,
          auxiliaryCost,
          purposeBreakdown,
          requestCount: stats.requestCount,
        })
      }

      // Fallback to DB for historical sessions
      const row = zero.sessionManager.getFromDB(id)
      if (!row) {
        return c.json({ error: 'Session not found' }, 404)
      }
      const messages = zero.sessionManager.getMessagesFromDB(id)
      const timelineCompactionBlocks = zero.sessionManager.getCompactionBlocksFromDB(id)
      const stats = zero.metrics.sessionStats(id)
      const auxiliaryCost = zero.metrics.sessionAuxiliaryCost(id)
      const purposeBreakdown = zero.metrics.sessionUsageByPurpose(id)
      const cacheEconomics = summarizeSessionCacheEconomics(id)
      const isCurrent = zero.sessionManager.isCurrentSessionId(id)
      return c.json({
        id: row.id,
        source: row.source,
        channelName: row.channelName,
        channelId: row.channelId,
        isCurrent,
        placement: isCurrent ? 'current' : 'background',
        currentModel: row.currentModel,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        messages,
        timelineCompactionBlocks,
        tags: row.tags,
        summary: row.summary,
        modelHistory: row.modelHistory,
        systemPrompt: row.systemPrompt,
        totalTokens: stats.totalTokens,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        cacheWriteTokens: stats.cacheWriteTokens,
        cacheReadTokens: stats.cacheReadTokens,
        reasoningTokens: stats.reasoningTokens,
        effectiveInputTokens: stats.effectiveInputTokens,
        cacheHitRate: stats.cacheHitRate,
        cacheReadCost: cacheEconomics.cacheReadCost,
        cacheWriteCost: cacheEconomics.cacheWriteCost,
        grossAvoidedInputCost: cacheEconomics.grossAvoidedInputCost,
        netSavings: cacheEconomics.netSavings,
        totalCost: stats.totalCost,
        auxiliaryCost,
        purposeBreakdown,
        requestCount: stats.requestCount,
      })
    })

    .get('/api/sessions/:id/requests', (c) => {
      const id = c.req.param('id')
      const session = getSessionRow(id)
      if (!session) {
        return c.json({ error: 'Session not found' }, 404)
      }

      const requests = zero.observability.readSessionRequests(id)
      return c.json({
        sessionId: id,
        requests,
      })
    })

    .get('/api/sessions/:id/decisions', (c) => {
      const id = c.req.param('id')
      const session = getSessionRow(id)
      if (!session) {
        return c.json({ error: 'Session not found' }, 404)
      }

      const decisions = zero.observability.readSessionDecisions(id)
      return c.json({
        sessionId: id,
        decisions,
      })
    })

    .get('/api/sessions/:id/traces', (c) => {
      const id = c.req.param('id')
      const traces = zero.tracer.exportSession(id).map((span) => sanitizeTraceSpanForClient(span))
      return c.json({ traces })
    })

    .get('/api/sessions/:id/task-closure-events', (c) => {
      const id = c.req.param('id')
      const session = getSessionRow(id)
      if (!session) {
        return c.json({ error: 'Session not found' }, 404)
      }

      const entries = zero.observability
        .readSessionClosures(id)
        .map((entry) => sanitizeClosureEntryForClient(entry))

      return c.json({ events: entries })
    })

    .get('/api/sessions/:id/llm-judge', (c) => {
      const id = c.req.param('id')
      const history = zero.observability.readSessionJudges<StoredSessionJudgeEntry>(id)
      const session = getSessionRow(id)
      if (!session && history.length === 0) {
        return c.json({ error: 'Session not found' }, 404)
      }

      return c.json({
        sessionId: id,
        history,
      } satisfies SessionJudgeHistoryResponse)
    })

    .post('/api/sessions/:id/llm-judge', async (c) => {
      const id = c.req.param('id')
      const session = getSessionRow(id)
      if (!session) {
        return c.json({ error: 'Session not found' }, 404)
      }

      const body: {
        model?: string
      } = await c.req
        .json<{
          model?: string
        }>()
        .catch(() => ({}))

      try {
        const result = await runSessionJudge(zero, id, { model: body.model })
        const entry = {
          version: 1,
          savedAt: result.run.generatedAt,
          sessionId: id,
          run: result.run,
          artifacts: result.artifacts,
        } satisfies StoredSessionJudgeEntry

        zero.observability.appendSessionJudge(id, entry)
        zero.metrics.recordEvaluation({
          sessionId: id,
          model: result.run.model,
          overallScore: result.run.result.overallScore,
          verdict: result.run.result.verdict,
          confidence: result.run.result.confidence,
          summary: result.run.result.summary,
          dimensions: result.run.result.dimensions,
          findings: result.run.result.findings,
          signals: result.run.result.signals as unknown as Record<string, unknown>,
          generatedAt: result.run.generatedAt,
          createdAt: result.run.generatedAt,
        })

        return c.json(result.run)
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500)
      }
    })

    .post('/api/sessions/:id/tool-calls/:toolUseId/abort', (c) => {
      const id = c.req.param('id')
      const toolUseId = c.req.param('toolUseId')
      const session = zero.sessionManager.get(id)
      if (!session) {
        return c.json({ error: 'Session not found' }, 404)
      }

      const status = session.abortRunningTool(toolUseId)
      if (status === 'not_abortable') {
        return c.json({ ok: false, error: 'Tool call is not an abortable bash run' }, 409)
      }

      return c.json({ ok: true, status })
    })

    .delete('/api/sessions/:id', async (c) => {
      const id = c.req.param('id')
      const deleted = await zero.sessionManager.deleteSession(id, zero.memoryStore, zero.metrics)
      if (!deleted) {
        return c.json({ error: 'Session not found' }, 404)
      }
      return c.json({ ok: true })
    })

    .post('/api/chat/new', async (c) => {
      const body = await c.req.json<{ model?: string }>().catch(() => ({}) as { model?: string })
      const { session, previousSessionId } = zero.sessionManager.startNewForChannel(
        'web',
        'default',
        'web',
      )

      if (!session.isAgentInitialized()) {
        session.initAgent({
          name: 'zero-web',
          agentInstruction:
            'You are ZeRo OS, an AI agent system running on macOS. Be helpful, concise, and accurate.',
        })
      }

      if (body.model) {
        const result = await session.switchModel(body.model)
        if (!result.success) {
          return c.json({ error: result.message }, 400)
        }
      }

      return c.json({
        sessionId: session.data.id,
        currentModel: session.data.currentModel,
        previousSessionId,
      })
    })

    // Chat — create session + send message to AI
    .post('/api/chat', async (c) => {
      if (zero.isShuttingDown()) {
        return c.json({ error: 'ZeRo OS is restarting. Please retry shortly.' }, 503)
      }

      const body = await c.req.json<{ message: string; sessionId?: string }>()
      const isSessionCommand = parseSessionArgs(body.message) !== null
      const selected = body.sessionId
        ? zero.sessionManager.switchCurrentSessionForChannel(
            'web',
            'default',
            body.sessionId,
            'web',
          )
        : zero.sessionManager.getOrCreateForChannel('web', 'default', 'web')
      const session = selected?.session

      if (!session) {
        return c.json({ error: 'Session not found' }, 404)
      }

      if (!session.isAgentInitialized()) {
        session.initAgent({
          name: 'zero-web',
          agentInstruction:
            'You are ZeRo OS, an AI agent system running on macOS. Be helpful, concise, and accurate.',
        })
      }

      if (isSessionCommand) {
        return c.json({
          sessionId: session.data.id,
          reply: buildSessionInfoReply(session, zero.metrics),
          messages: [],
        })
      }

      const newMessages = await session.handleMessage(body.message)

      // Extract the assistant reply text
      const assistantMessages = newMessages.filter((m) => m.role === 'assistant')
      const replyText = assistantMessages
        .flatMap((m) => m.content)
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('\n')

      return c.json({
        sessionId: session.data.id,
        reply: replyText,
        messages: newMessages,
      })
    })

    // Memory
    .get('/api/memory', (c) => {
      const type = c.req.query('type') as MemoryType | undefined
      if (type && type !== ('all' as unknown)) {
        const memories = zero.memoryStore.list(type)
        return c.json({ memories, type })
      }
      const memories = ALL_MEMORY_TYPES.flatMap((memoryType) => zero.memoryStore.list(memoryType))
      memories.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      return c.json({ memories, type: 'all' })
    })

    .get('/api/memory/search', async (c) => {
      const q = c.req.query('q') ?? ''
      if (!q) return c.json({ results: [], query: q })
      const results = await zero.memoryRetriever.retrieve(q, { topN: 20, confidenceThreshold: 0 })
      return c.json({ results, query: q })
    })

    .post('/api/memory', async (c) => {
      const body = await c.req.json<{
        type: MemoryType
        title: string
        content: string
        tags?: string[]
        status?: MemoryStatus
        confidence?: number
      }>()
      if (!body.type || !body.title || !body.content) {
        return c.json({ error: 'type, title, and content are required' }, 400)
      }
      // status 枚举校验 + confidence 钳制，与 PUT/工具写路径一致（对抗实测：create 端点曾是唯一缺口）。
      const memory = await zero.memoryStore.create(body.type, body.title, body.content, {
        tags: Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === 'string') : [],
        status: isMemoryStatus(body.status) ? body.status : 'draft',
        confidence: clampConfidence(body.confidence) ?? 0.5,
      })
      invalidateClusterCache()
      return c.json({ memory })
    })

    .get('/api/memory/:type/:id', (c) => {
      const type = c.req.param('type') as MemoryType
      const id = c.req.param('id')
      const memory = zero.memoryStore.get(type, id)
      if (!memory) return c.json({ error: 'Memory not found' }, 404)
      return c.json({ memory })
    })

    .put('/api/memory/:type/:id', async (c) => {
      const type = c.req.param('type') as MemoryType
      const id = c.req.param('id')
      // PUT 仅允许编辑安全字段；status 走 verify/archive、谱系走 supersede、edges 走 relations，
      // 不从这条通用写路径写入——否则可绕过 supersede/verify 的全部谱系校验（对抗实测确认）。
      const body = await c.req
        .json<Record<string, unknown>>()
        .catch(() => ({}) as Record<string, unknown>)
      const safe: Record<string, unknown> = {}
      if (typeof body.title === 'string') safe.title = body.title
      if (typeof body.content === 'string') safe.content = body.content
      if (Array.isArray(body.tags) && body.tags.every((t: unknown) => typeof t === 'string')) {
        safe.tags = body.tags
      }
      const clampedConfidence = clampConfidence(body.confidence)
      if (clampedConfidence !== undefined) safe.confidence = clampedConfidence
      const updated = await zero.memoryStore.update(type, id, safe)
      if (!updated) return c.json({ error: 'Memory not found' }, 404)
      invalidateClusterCache()
      return c.json({ memory: updated })
    })

    // P0: 可逆归档 = 改 status，不物理删除；检索的 status 过滤会自动隐藏归档项。
    // 注意(P1): 经 store.update 可能触发 re-embedding，后续应改走 metadata-only 更新路径。
    .post('/api/memory/:type/:id/archive', async (c) => {
      const type = c.req.param('type') as MemoryType
      const id = c.req.param('id')
      const updated = await zero.memoryStore.update(type, id, {
        status: 'archived' as MemoryStatus,
      })
      if (!updated) return c.json({ error: 'Memory not found' }, 404)
      invalidateClusterCache()
      return c.json({ memory: updated })
    })

    // P1(发展): 验证 = 提升到 verified + 默认置信 0.9（对齐 lifecycle.verify）。
    // 同时清除谱系指针：verified 与 supersededBy/mergedInto 并存是非法僵尸态——
    // 检索会把复活的权威条重定向回废弃条（对抗实测交付错误内容或丢失结果）。
    .post('/api/memory/:type/:id/verify', async (c) => {
      const type = c.req.param('type') as MemoryType
      const id = c.req.param('id')
      const updated = await zero.memoryStore.update(type, id, {
        status: 'verified' as MemoryStatus,
        confidence: 0.9,
        supersededBy: undefined,
        mergedInto: undefined,
      })
      if (!updated) return c.json({ error: 'Memory not found' }, 404)
      invalidateClusterCache()
      return c.json({ memory: updated })
    })

    // P1(发展): 取代 = 被取代方标记 supersededBy + 可逆归档。
    // 反向 supersedes 边（如需）由用户经 relations 端点手动建立——系统不自动建边。
    .post('/api/memory/:type/:id/supersede', async (c) => {
      const type = c.req.param('type') as MemoryType
      const id = c.req.param('id')
      const body = await c.req
        .json<{ bySupersededId?: string }>()
        .catch(() => ({}) as { bySupersededId?: string })
      if (!body.bySupersededId) {
        return c.json({ error: 'bySupersededId is required' }, 400)
      }
      // 谱系完整性校验：自指/幽灵目标/成环都会污染权威解析（对抗实测可经端点落盘），写入前拒绝。
      const targetId = body.bySupersededId
      if (targetId === id) {
        return c.json({ error: 'cannot supersede a memory by itself' }, 400)
      }
      const findById = (memId: string) => {
        for (const t of ALL_MEMORY_TYPES) {
          const m = zero.memoryStore.get(t, memId)
          if (m) return m
        }
        return undefined
      }
      const target = findById(targetId)
      if (!target) {
        return c.json({ error: `supersede target not found: ${targetId}` }, 404)
      }
      // 沿目标谱系链走到底（visited 保证终止、无数值熔断——否则深链可绕过环检测）：
      // 途中回指本条 → 成环拒绝(409)；压缩到链尾【最后一个活节点】，让链深恒 ≤1
      // 且不把 supersededBy 静默指向 archived 节点（整链全归档则回退到直接 target）。
      let cursor: typeof target | undefined = target
      let lastLive: typeof target | undefined = target.status !== 'archived' ? target : undefined
      const visited = new Set<string>([targetId])
      while (cursor) {
        const nextId: string | undefined = cursor.supersededBy ?? cursor.mergedInto
        if (!nextId || visited.has(nextId)) break
        if (nextId === id) {
          return c.json({ error: 'supersede would create a lineage cycle' }, 409)
        }
        visited.add(nextId)
        const next = findById(nextId)
        if (!next) break
        cursor = next
        if (cursor.status !== 'archived') lastLive = cursor
      }
      const authorityId = lastLive?.id ?? targetId
      const updated = await zero.memoryStore.update(type, id, {
        status: 'archived' as MemoryStatus,
        supersededBy: authorityId,
      })
      if (!updated) return c.json({ error: 'Memory not found' }, 404)
      invalidateClusterCache()
      return c.json({ memory: updated })
    })

    // P1(关联): 维护带类型的边（独立 edges 字段，不污染 related）。
    .patch('/api/memory/:type/:id/relations', async (c) => {
      const type = c.req.param('type') as MemoryType
      const id = c.req.param('id')
      type RemoveSpec = string | { toId: string; kind: string }
      const body = await c.req
        .json<{ add?: MemoryEdge[]; remove?: RemoveSpec[] }>()
        .catch(() => ({}) as { add?: MemoryEdge[]; remove?: RemoveSpec[] })
      const memory = zero.memoryStore.get(type, id)
      if (!memory) return c.json({ error: 'Memory not found' }, 404)
      // 去重：既排除与已有边重复，也排除本批 add 内部重复（按 kind:toId）。
      const seen = new Set((memory.edges ?? []).map((e) => `${e.kind}:${e.toId}`))
      const additions: MemoryEdge[] = []
      for (const a of body.add ?? []) {
        const key = `${a.kind}:${a.toId}`
        if (seen.has(key)) continue
        seen.add(key)
        additions.push(a)
      }
      // 删除粒度与 add 对称：传 {toId,kind} 精确删一条 typed 边；传裸 toId 字符串删该目标全部边。
      // remove 在 add 之后生效（同请求 add∩remove 时删除意图胜出，不被静默吞掉）。
      const removeAll = new Set<string>()
      const removeExact = new Set<string>()
      for (const r of body.remove ?? []) {
        if (typeof r === 'string') removeAll.add(r)
        else removeExact.add(`${r.kind}:${r.toId}`)
      }
      const edges = [...(memory.edges ?? []), ...additions].filter(
        (e) => !removeAll.has(e.toId) && !removeExact.has(`${e.kind}:${e.toId}`),
      )
      const updated = await zero.memoryStore.update(type, id, { edges })
      if (!updated) return c.json({ error: 'Memory not found' }, 404)
      invalidateClusterCache()
      return c.json({ memory: updated })
    })

    // P1(关联): 某条记忆的语义近邻，供人工建边/选取代来源。向量索引不可用时返回空。
    .get('/api/memory/:type/:id/neighbors', async (c) => {
      const id = c.req.param('id')
      const topK = Math.min(20, Math.max(1, Number(c.req.query('topK') ?? 8)))
      const index = zero.vectorIndex
      if (!index?.getVector) {
        return c.json({ neighbors: [], reason: 'vector index unavailable' })
      }
      const vector = await index.getVector(id)
      if (!vector) {
        return c.json({ neighbors: [], reason: 'no vector for this memory' })
      }
      const hits = await index.query(vector, topK + 1)
      // 携带 status/谱系信号，与 clusters 成员一致——让治理者看见"已归档/已被取代"的死节点，
      // 不至于把死节点误当顶级"选取代来源"候选（对抗实测：neighbors 缺 status 跨面不一致）。
      const neighbors: Array<{
        memoryId: string
        type?: string
        title?: string
        score: number
        status?: string
        supersededBy?: string
        mergedInto?: string
      }> = []
      for (const hit of hits) {
        if (hit.memoryId === id) continue
        const meta = await index.getMetadata?.(hit.memoryId)
        // 以 store 实时数据覆盖索引 meta（降级线路下 meta 可能陈旧）；store 里已不存在的幽灵向量直接跳过。
        const live = meta?.type
          ? zero.memoryStore.get(meta.type as MemoryType, hit.memoryId)
          : undefined
        if (!live) continue
        neighbors.push({
          memoryId: hit.memoryId,
          type: live.type,
          title: live.title,
          score: hit.score,
          status: live.status,
          ...(live.supersededBy ? { supersededBy: live.supersededBy } : {}),
          ...(live.mergedInto ? { mergedInto: live.mergedInto } : {}),
        })
        if (neighbors.length >= topK) break
      }
      return c.json({ neighbors })
    })

    // P2/P3c(读/关联): 全库 cos≥阈值 连通聚类，返回近重复簇供治理。
    // 聚类逻辑抽到 @zero-os/memory 的 computeMemoryClusters，端点与后台检测任务共用。
    // 注意：O(n²) 同步计算，P3c 将由定时任务计算并缓存。
    .get('/api/memory/clusters', async (c) => {
      const threshold = Number(c.req.query('threshold') ?? 0.9)
      const force = c.req.query('fresh') === '1'
      const result = await getMemoryClusters(zero.vectorIndex, zero.memoryStore, {
        threshold,
        force,
      })
      return c.json(result)
    })

    .delete('/api/memory/:type/:id', async (c) => {
      const type = c.req.param('type') as MemoryType
      const id = c.req.param('id')
      const deleted = await zero.memoryStore.delete(type, id)
      if (!deleted) return c.json({ error: 'Memory not found' }, 404)
      // 兜底删除向量：降级线路下 memoryStore 可能是 raw store（不触索引），
      // 否则已删记忆会以幽灵成员/幽灵近邻形态残留。IndexedMemoryStore 路径下此调用为幂等 no-op。
      try {
        await zero.vectorIndex?.delete(id)
      } catch {
        // 索引删除失败不影响主删除结果
      }
      invalidateClusterCache()
      return c.json({ ok: true })
    })

    // Memo
    .get('/api/memo', (c) => {
      const content = zero.memoManager.read()
      return c.json({ content })
    })

    .put('/api/memo', async (c) => {
      const body = await c.req.json<{ content: string }>()
      await zero.memoManager.write(body.content)
      return c.json({ ok: true, length: body.content.length })
    })

    // Metrics
    .get('/api/metrics/cost', (c) => {
      const range = c.req.query('range') ?? '7d'
      const byModel = zero.metrics.costByModel(range)
      const totalCost = byModel.reduce((sum, m) => sum + m.totalCost, 0)
      const totalTokens = byModel.reduce((sum, m) => sum + m.totalInput + m.totalOutput, 0)
      return c.json({ range, totalCost, totalTokens, byModel })
    })

    .get('/api/metrics/summary', (c) => {
      const today = zero.metrics.summary('1d')
      const week = zero.metrics.summary('7d')
      const month = zero.metrics.summary('30d')
      return c.json({
        today: { cost: today.totalCost, tokens: today.totalTokens },
        week: { cost: week.totalCost, tokens: week.totalTokens },
        month: { cost: month.totalCost, tokens: month.totalTokens },
      })
    })

    .get('/api/metrics/usage-summary', (c) => {
      const range = c.req.query('range') ?? '7d'
      const data = zero.metrics.usageSummaryByPurpose(range)
      return c.json({ range, data })
    })

    .get('/api/metrics/system-costs', (c) => {
      const range = c.req.query('range') ?? '30d'
      return c.json({
        range,
        ...zero.metrics.systemCosts(range),
      })
    })

    .get('/api/metrics/cost-by-channel', (c) => {
      const range = c.req.query('range') ?? '7d'
      return c.json({ range, data: zero.metrics.costByChannel(range) })
    })

    .get('/api/metrics/cost-by-source', (c) => {
      const range = c.req.query('range') ?? '7d'
      return c.json({ range, data: zero.metrics.costBySource(range) })
    })

    .get('/api/metrics/channel/:name/cost-by-day', (c) => {
      const range = c.req.query('range') ?? '30d'
      const source = c.req.query('source') ?? undefined
      const name = decodeURIComponent(c.req.param('name'))
      return c.json({
        range,
        channelName: name,
        source: source ?? null,
        data: zero.metrics.channelCostByDay(name, range, source),
      })
    })

    .get('/api/metrics/channel/:name/purpose-breakdown', (c) => {
      const range = c.req.query('range') ?? '30d'
      const source = c.req.query('source') ?? undefined
      const name = decodeURIComponent(c.req.param('name'))
      return c.json({
        range,
        channelName: name,
        source: source ?? null,
        data: zero.metrics.channelPurposeBreakdown(name, range, source),
      })
    })

    .get('/api/metrics/evaluations/trend', (c) => {
      const range = c.req.query('range') ?? '30d'
      return c.json({ range, data: zero.metrics.evaluationTrend(range) })
    })

    .get('/api/metrics/evaluations/dimensions', (c) => {
      const range = c.req.query('range') ?? '30d'
      return c.json({ range, data: zero.metrics.evaluationDimensionAvg(range) })
    })

    .get('/api/metrics/evaluations/top-findings', (c) => {
      const range = c.req.query('range') ?? '30d'
      return c.json({ range, data: zero.metrics.topFindings(range) })
    })

    .get('/api/metrics/cost-by-day', (c) => {
      const range = c.req.query('range') ?? '30d'
      const data = zero.metrics.costByDay(range)
      return c.json({ data })
    })

    .get('/api/metrics/tool-stats', (c) => {
      const range = c.req.query('range') ?? '7d'
      const data = zero.metrics.toolStats(range)
      return c.json({ data })
    })

    .get('/api/metrics/cache-hit-rate', (c) => {
      const range = c.req.query('range') ?? '30d'
      const data = zero.metrics.cacheHitRate(range)
      return c.json({ data })
    })

    .get('/api/metrics/cache-by-model', (c) => {
      const range = c.req.query('range') ?? '30d'
      const data = zero.metrics.cacheByModel(range).map((row) => {
        const pricing = resolvePricing(row.provider, row.model)
        return {
          ...row,
          ...computeCacheEconomics(row.cacheRead, row.cacheWrite, pricing),
        }
      })
      return c.json({ data })
    })

    .get('/api/metrics/task-success-rate', (c) => {
      const range = c.req.query('range') ?? '30d'
      const data = zero.metrics.taskSuccessRate(range)
      return c.json({ data })
    })

    .get('/api/metrics/health', (c) => {
      const range = c.req.query('range') ?? '30d'
      const repairs = zero.metrics.repairStats(range)
      const repairTrend = zero.metrics.repairByDay(range)
      return c.json({ repairs, repairTrend })
    })

    .get('/api/metrics/cost-by-day-model', (c) => {
      const range = c.req.query('range') ?? '30d'
      const data = zero.metrics.costByDayModel(range)
      return c.json({ data })
    })

    .get('/api/metrics/avg-duration', (c) => {
      const range = c.req.query('range') ?? '30d'
      const data = zero.metrics.avgDurationByDay(range)
      return c.json({ data })
    })

    .get('/api/metrics/cost-detail', (c) => {
      const range = c.req.query('range') ?? '30d'
      const data = zero.metrics.costDetailRecords(range).map((row) => {
        const pricing = resolvePricing(row.provider, row.model)
        return {
          ...row,
          ...computeCacheEconomics(row.cacheRead, row.cacheWrite, pricing),
        }
      })
      return c.json({ data })
    })

    .get('/api/metrics/tool-error-by-day', (c) => {
      const range = c.req.query('range') ?? '30d'
      const data = zero.metrics.toolErrorByDay(range)
      return c.json({ data })
    })

    // Config
    .get('/api/config', async (c) => {
      const config = readCurrentConfig()
      return c.json({
        providers: await buildProvidersForConfig(),
        modelPools: config.modelPools ?? {},
        defaultModel: config.defaultModel,
        fallbackChain: config.fallbackChain,
        schedules: config.schedules,
        fuseList: config.fuseList,
        taskClosureModel: config.taskClosureModel ?? null,
        contextCompactionModel: config.contextCompactionModel ?? null,
        secrets: zero.vault.keys().map((key) => ({
          key,
          masked: isManagedOAuthTokenRef(key, config) ? 'oauth:configured' : 'configured',
          configured: true,
        })),
      })
    })

    .put('/api/config', async (c) => {
      const body = await c.req.json<Record<string, unknown>>()
      const configPath = getConfigPath()
      let raw = readYaml<Record<string, unknown>>(configPath)

      const keyMap: Record<string, string> = {
        defaultModel: 'default_model',
        fallbackChain: 'fallback_chain',
        taskClosureModel: 'task_closure_model',
        contextCompactionModel: 'context_compaction_model',
      }

      try {
        for (const [key, value] of Object.entries(body)) {
          if (key === 'modelPools') {
            const modelPools = normalizeModelPoolsForWrite(value)
            if (Object.keys(modelPools).length === 0) {
              raw = omitConfigKey(raw, 'model_pools')
            } else {
              raw.model_pools = modelPools
            }
            continue
          }

          const yamlKey = keyMap[key] ?? key
          if (value === null || value === '') {
            delete raw[yamlKey]
          } else {
            raw[yamlKey] = value
          }
        }
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 400)
      }

      writeYaml(configPath, raw)
      await zero.reloadModelProviders()
      const updated = readCurrentConfig()
      return c.json({
        ok: true,
        defaultModel: updated.defaultModel,
        fallbackChain: updated.fallbackChain,
        modelPools: updated.modelPools ?? {},
        taskClosureModel: updated.taskClosureModel ?? null,
        contextCompactionModel: updated.contextCompactionModel ?? null,
      })
    })

    .post('/api/providers/:provider/oauth/start', async (c) => {
      const provider = c.req.param('provider')

      try {
        let currentConfig = readCurrentConfig()
        syncManagedOAuthCoordinator(managedOAuth, currentConfig)
        if (isManagedOAuthProvider(provider) && !currentConfig.providers[provider]) {
          prepareManagedOAuthProvider(provider)
          await zero.reloadModelProviders()
          currentConfig = readCurrentConfig()
        }
        if (!managedOAuth.supportsProvider(provider)) {
          if (!isManagedOAuthProvider(provider)) {
            return c.json({ error: 'Unsupported OAuth provider' }, 404)
          }
          prepareManagedOAuthProvider(provider)
          await zero.reloadModelProviders()
          currentConfig = readCurrentConfig()
        }
        syncManagedOAuthCoordinator(managedOAuth, currentConfig)
        const result = await managedOAuth.start(provider)
        return c.json({ ...result, status: managedOAuth.getStatus(provider) })
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500)
      }
    })

    .get('/api/providers/:provider/oauth/status', async (c) => {
      const provider = c.req.param('provider')
      syncManagedOAuthCoordinator(managedOAuth, readCurrentConfig())
      if (!managedOAuth.supportsProvider(provider)) {
        return c.json({ error: 'Unsupported OAuth provider' }, 404)
      }

      const refresh = c.req.query('refresh')
      const status = await getManagedOAuthStatus(provider, refresh)
      if (refresh === 'hard' && status.state === 'connected') {
        markProviderAuthRecovered(provider, 'oauth_status_hard_refresh')
      }
      return c.json(status)
    })

    .get('/api/providers/:provider/oauth/usage', async (c) => {
      const provider = c.req.param('provider')
      try {
        return c.json(await fetchManagedOAuthUsage(provider))
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500)
      }
    })

    .get('/api/providers/health', (c) => {
      return c.json({ providers: zero.providerHealth.list() })
    })

    .post('/api/runtime/model-providers/reload', async (c) => {
      try {
        let body: Record<string, unknown> = {}
        if (c.req.header('content-type')?.includes('application/json')) {
          try {
            body = await c.req.json<Record<string, unknown>>()
          } catch {}
        }
        const recoveredProviders = normalizeRecoveredProviders(
          body.recoveredProviders ?? body.recoveredProvider,
        )
        await zero.reloadModelProviders({ recoveredProviders })
        syncManagedOAuthCoordinator(managedOAuth, readCurrentConfig())
        return c.json({ ok: true, recoveredProviders })
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500)
      }
    })

    .post('/api/providers/chatgpt/oauth/start', async (c) => {
      try {
        prepareManagedOAuthProvider('chatgpt')
        await zero.reloadModelProviders()
        syncManagedOAuthCoordinator(managedOAuth, readCurrentConfig())
        const result = await managedOAuth.start('chatgpt')
        return c.json({ ...result, status: managedOAuth.getStatus('chatgpt') })
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500)
      }
    })

    .get('/api/providers/chatgpt/oauth/status', async (c) => {
      const refresh = c.req.query('refresh')
      const status = await getManagedOAuthStatus('chatgpt', refresh)
      if (refresh === 'hard' && status.state === 'connected') {
        markProviderAuthRecovered('chatgpt', 'oauth_status_hard_refresh')
      }
      return c.json(status)
    })

    .get('/api/providers/anthropic/oauth/usage', async (c) => {
      try {
        return c.json(await fetchManagedOAuthUsage('anthropic'))
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500)
      }
    })

    // Logs
    .get('/api/logs/sessions', (c) => {
      const limit = parseLogLimit(c.req.query('limit'), 200, 1000)
      const q = c.req.query('q') ?? ''
      const sessions = zero.observability
        .listSessionRunLogs()
        .filter((session) => {
          if (!q) return true
          return JSON.stringify(session).toLowerCase().includes(q.toLowerCase())
        })
        .slice(0, limit)

      return c.json({ sessions, limit })
    })
    .get('/api/logs/sessions/:sessionId/run', (c) => {
      const sessionId = c.req.param('sessionId')
      const limit = parseLogLimit(c.req.query('limit'), 500, 5000)
      const level = c.req.query('level')
      const event = c.req.query('event')
      const q = c.req.query('q') ?? ''
      const since = c.req.query('since')
      const until = c.req.query('until')
      const order = c.req.query('order') === 'desc' ? 'desc' : 'asc'

      const allEntries = zero.observability.readSessionRunLog(sessionId)
      let entries = allEntries.filter((entry) => {
        if (level && level !== 'all' && entry.level !== level) return false
        if (event && event !== 'all' && entry.event !== event) return false
        if (since && entry.ts < since) return false
        if (until && entry.ts > until) return false
        return matchesRunLogQuery(entry as unknown as Record<string, unknown>, q)
      })

      const matched = entries.length
      entries = entries.slice(Math.max(0, entries.length - limit))
      if (order === 'desc') {
        entries = [...entries].reverse()
      }

      return c.json({
        sessionId,
        entries,
        total: allEntries.length,
        matched,
        limit,
        order,
      })
    })
    .get('/api/logs', (c) => {
      const limit = parseLogLimit(c.req.query('limit'), 100, 1000)
      const level = c.req.query('level')
      const type = c.req.query('type') ?? 'events'
      const since = c.req.query('since')

      if (type === 'trace') {
        const persistedEntries = zero.observability.readAllTraceEntries()
        const childCounts = new Map<string, number>()

        for (const entry of persistedEntries) {
          if (!entry.parentSpanId) continue
          childCounts.set(entry.parentSpanId, (childCounts.get(entry.parentSpanId) ?? 0) + 1)
        }

        const traceEntries: TraceLogEntry[] = persistedEntries.map((entry) => ({
          spanId: entry.spanId,
          ts: entry.startTime,
          sessionId: entry.sessionId,
          kind: entry.kind,
          name: entry.name,
          status: entry.status,
          durationMs: entry.durationMs,
          childCount: childCounts.get(entry.spanId) ?? 0,
        }))
        traceEntries.sort((a, b) => b.ts.localeCompare(a.ts))
        return c.json({ entries: traceEntries.slice(0, limit), limit })
      }

      let entries =
        type === 'requests'
          ? zero.observability.readAllRequests().map((entry) => ({ ...entry }))
          : type === 'snapshots'
            ? zero.observability.readAllSnapshots().map((entry) => ({ ...entry }))
            : zero.observability.readEntries<Record<string, unknown>>('events.jsonl')

      if (level && level !== 'all') {
        entries = entries.filter((e) => e.level === level)
      }

      if (since) {
        entries = entries.filter((e) => typeof e.ts === 'string' && e.ts >= since)
      }

      // Most recent first, limit
      entries.reverse()
      entries = entries.slice(0, limit)

      return c.json({ entries, limit })
    })

    // Notifications — return from notification store, fallback to log-based
    .get('/api/notifications', (c) => {
      if (zero.notifications.length > 0) {
        const active = zero.notifications
          .filter((n) => !n.dismissedAt)
          .slice(-50)
          .reverse()
        return c.json({ notifications: active })
      }

      // Fallback: derive from log entries
      const entries = zero.observability.readEntries<Record<string, unknown>>('events.jsonl')
      const notifications = entries
        .filter((e) => e.level === 'warn' || e.level === 'error')
        .slice(-50)
        .reverse()
        .map((e) => ({
          id: crypto.randomUUID(),
          type: 'system' as const,
          severity: (e.level as string) === 'error' ? ('error' as const) : ('warn' as const),
          title: (e.event as string) ?? 'System Event',
          description: (e.event as string) ?? (e.outputSummary as string) ?? 'Unknown event',
          source: (e.tool as string) ?? (e.event as string) ?? 'system',
          sessionId: (e.sessionId as string) ?? (e.session_id as string) ?? undefined,
          actionable: false,
          createdAt: e.ts as string,
          // Legacy compat fields
          ts: e.ts as string,
          level: e.level as string,
        }))
      return c.json({ notifications })
    })

    .post('/api/notifications/:id/dismiss', (c) => {
      const id = c.req.param('id')
      const notification = zero.notifications.find((n) => n.id === id)
      if (!notification) {
        return c.json({ error: 'Notification not found' }, 404)
      }
      notification.dismissedAt = new Date().toISOString()
      return c.json({ ok: true })
    })

    // Channel status — real data from channel registry
    .get('/api/channels/status', (c) => {
      const channels = Array.from(zero.channels.entries()).map(([name, ch]) => ({
        name,
        type: ch.type,
        status: ch.isConnected() ? 'online' : 'offline',
      }))
      return c.json({ channels })
    })

    // Channel config — detailed configuration info
    .get('/api/channels/config', (c) => {
      const channelConfigs = Array.from(zero.channels.entries()).map(([name, ch]) => {
        const keys = zero.channelDefinitions.get(name)?.secretRefs ?? []
        const secrets = keys.map((k) => ({
          key: k,
          configured: !!zero.vault.get(k),
        }))

        return {
          name,
          type: ch.type,
          status: ch.isConnected() ? 'online' : 'offline',
          secrets,
          codePath: `packages/channel/src/${ch.type}/`,
        }
      })
      return c.json({ channels: channelConfigs })
    })

    // Tools
    .get('/api/tools', (c) => {
      const tools = zero.toolRegistry.list().map((t) => t.toDefinition())
      return c.json({ tools })
    })

    // Secrets management
    .post('/api/config/secrets', async (c) => {
      const body = await c.req.json<{ key: string; value: string }>()
      if (!body.key || !body.value) {
        return c.json({ error: 'key and value are required' }, 400)
      }
      zero.vault.set(body.key, body.value)
      return c.json({ ok: true, key: body.key })
    })

    .post('/api/config/secrets/delete', async (c) => {
      const body = await c.req.json<{ key: string }>()
      if (!body.key) {
        return c.json({ error: 'key is required' }, 400)
      }
      zero.vault.delete(body.key)
      return c.json({ ok: true, key: body.key })
    })

    // Git rollback
    .post('/api/config/rollback', async (c) => {
      const gitOps = new GitOps(process.cwd())
      const lastTag = await gitOps.getLastStableTag()
      if (!lastTag) {
        return c.json({ error: 'No stable tag found to rollback to' }, 404)
      }
      await gitOps.rollbackToTag(lastTag)
      return c.json({ ok: true, rolledBackTo: lastTag })
    })

    // Git last stable tag
    .get('/api/config/last-stable-tag', async (c) => {
      const gitOps = new GitOps(process.cwd())
      const tag = await gitOps.getLastStableTag()
      return c.json({ tag })
    })

  return app
}

export type AppType = ReturnType<typeof createRoutes>
