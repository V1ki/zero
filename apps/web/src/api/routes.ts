import {
  type SourceCardDraftCreateRequest,
  buildSessionInfoReply,
  loadConfig,
  parseSessionArgs,
} from '@zero-os/core'
import {
  ALL_MEMORY_TYPES,
  type MemoryStatus,
  type MemoryType,
  type ModelPricing,
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
  isManagedOAuthProvider,
  isManagedOAuthTokenRef,
  prepareManagedOAuthProvider,
} from '../../../server/src/provider-oauth'
import type { SessionJudgeHistoryResponse, StoredSessionJudgeEntry } from '../eval/types'
import { runSessionJudge } from './session-judge'

export function createRoutes(zero: ZeroOS) {
  const managedOAuth = createManagedOAuthCoordinator(zero.vault)
  const chatgptUsage = new ChatGptUsageService(zero.vault)
  const claudeUsage = new ClaudeUsageService(zero.vault)

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

  function formatModelLabel(providerName: string, modelName: string) {
    return `${providerName}/${modelName}`
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
    return Object.fromEntries(
      await Promise.all(
        Object.entries(config.providers).map(async ([name, provider]) => {
          const secretRef = provider.auth.apiKeyRef ?? provider.auth.oauthTokenRef
          const configured = secretRef ? !!zero.vault.get(secretRef) : false
          const oauthStatus = managedOAuth.supportsProvider(name)
            ? await managedOAuth.getStatusWithRefresh(name)
            : undefined

          return [
            name,
            {
              apiType: provider.apiType,
              baseUrl: provider.baseUrl,
              authType: provider.auth.type,
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
      const memory = await zero.memoryStore.create(body.type, body.title, body.content, {
        tags: body.tags ?? [],
        status: body.status ?? 'draft',
        confidence: body.confidence ?? 0.5,
      })
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
      const body = await c.req.json<Record<string, unknown>>()
      const updated = await zero.memoryStore.update(type, id, body)
      if (!updated) return c.json({ error: 'Memory not found' }, 404)
      return c.json({ memory: updated })
    })

    .delete('/api/memory/:type/:id', async (c) => {
      const type = c.req.param('type') as MemoryType
      const id = c.req.param('id')
      const deleted = await zero.memoryStore.delete(type, id)
      if (!deleted) return c.json({ error: 'Memory not found' }, 404)
      return c.json({ ok: true })
    })

    // Source Card Drafts
    .post('/api/source-card-drafts', async (c) => {
      const body = (await c.req
        .json<{ sessionId?: unknown; current?: unknown }>()
        .catch(() => ({}))) as { sessionId?: unknown; current?: unknown }
      const useCurrentSession = body.current === true
      const sessionId =
        typeof body.sessionId === 'string' && body.sessionId.trim()
          ? body.sessionId
          : useCurrentSession
            ? getCurrentWebSession()?.data.id
            : undefined

      if (!sessionId) {
        return c.json(
          { error: 'sessionId is required unless current=true resolves a session' },
          400,
        )
      }

      try {
        const draft = zero.sourceCardMiner.generateDraft(sessionId, {
          currentSession: useCurrentSession && !body.sessionId,
        })
        return c.json({ draft })
      } catch (error) {
        const message = toErrorMessage(error)
        return c.json({ error: message }, message.includes('not found') ? 404 : 400)
      }
    })

    .post('/api/source-card-drafts/validate', async (c) => {
      const body = (await c.req.json<{ draft?: unknown }>().catch(() => ({}))) as {
        draft?: unknown
      }
      return c.json({ validation: zero.sourceCardService.validateDraft(body.draft) })
    })

    .post('/api/source-card-drafts/cards', async (c) => {
      const body = await c.req.json<SourceCardDraftCreateRequest>().catch(() => null)
      if (!body) return c.json({ error: 'Source Card draft create request is required' }, 400)

      try {
        const sourceCard = zero.sourceCardService.createFromDraft(body)
        return c.json({ sourceCard })
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 400)
      }
    })

    // Source Cards
    .get('/api/source-cards', (c) => {
      return c.json({ sourceCards: zero.sourceCardService.list() })
    })

    .get('/api/source-cards/:id', (c) => {
      const id = c.req.param('id')
      const sourceCard = zero.sourceCardService.get(id)
      if (!sourceCard) return c.json({ error: 'Source Card not found' }, 404)
      return c.json({ sourceCard })
    })

    .post('/api/source-cards/:id/activate', async (c) => {
      const id = c.req.param('id')
      const existing = zero.sourceCardService.get(id)
      if (!existing) return c.json({ error: 'Source Card not found' }, 404)

      const body = await c.req.json<{ reason?: unknown }>().catch(() => null)
      if (!body) return c.json({ error: 'Activation payload is required' }, 400)
      const reason = typeof body.reason === 'string' ? body.reason : ''

      try {
        const sourceCard = zero.sourceCardService.activate(id, { reason })
        return c.json({ sourceCard })
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 400)
      }
    })

    .post('/api/source-cards/:id/retire', async (c) => {
      const id = c.req.param('id')
      const existing = zero.sourceCardService.get(id)
      if (!existing) return c.json({ error: 'Source Card not found' }, 404)

      const body = await c.req.json<{ reason?: unknown }>().catch(() => null)
      const reason = typeof body?.reason === 'string' ? body.reason : ''

      try {
        const sourceCard = zero.sourceCardService.retire(id, reason)
        return c.json({ sourceCard })
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 400)
      }
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
        defaultModel: config.defaultModel,
        fallbackChain: config.fallbackChain,
        schedules: config.schedules,
        fuseList: config.fuseList,
        taskClosureModel: config.taskClosureModel ?? null,
        secrets: zero.vault.keys().map((key) => ({
          key,
          masked: isManagedOAuthTokenRef(key) ? 'oauth:configured' : 'configured',
          configured: true,
        })),
      })
    })

    .put('/api/config', async (c) => {
      const body = await c.req.json<Record<string, unknown>>()
      const configPath = getConfigPath()
      const raw = readYaml<Record<string, unknown>>(configPath)

      const keyMap: Record<string, string> = {
        taskClosureModel: 'task_closure_model',
      }

      for (const [key, value] of Object.entries(body)) {
        const yamlKey = keyMap[key] ?? key
        if (value === null || value === '') {
          delete raw[yamlKey]
        } else {
          raw[yamlKey] = value
        }
      }

      writeYaml(configPath, raw)
      const updated = readCurrentConfig()
      zero.sessionManager.setTaskClosureModel(updated.taskClosureModel)
      return c.json({ ok: true, taskClosureModel: updated.taskClosureModel ?? null })
    })

    .post('/api/providers/:provider/oauth/start', async (c) => {
      const provider = c.req.param('provider')
      if (!isManagedOAuthProvider(provider)) {
        return c.json({ error: 'Unsupported OAuth provider' }, 404)
      }

      try {
        prepareManagedOAuthProvider(provider)
        const result = await managedOAuth.start(provider)
        return c.json({ ...result, status: managedOAuth.getStatus(provider) })
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500)
      }
    })

    .get('/api/providers/:provider/oauth/status', async (c) => {
      const provider = c.req.param('provider')
      if (!isManagedOAuthProvider(provider)) {
        return c.json({ error: 'Unsupported OAuth provider' }, 404)
      }

      const refresh = c.req.query('refresh')
      const status =
        refresh === 'soft'
          ? await managedOAuth.getStatusWithRefresh(provider)
          : managedOAuth.getStatus(provider)
      return c.json(status)
    })

    .get('/api/providers/:provider/oauth/usage', async (c) => {
      const provider = c.req.param('provider')
      if (!isManagedOAuthProvider(provider)) {
        return c.json({ error: 'Unsupported OAuth provider' }, 404)
      }

      try {
        switch (provider) {
          case 'chatgpt': {
            const usage = await chatgptUsage.fetchUsage()
            return c.json({ provider: 'chatgpt', usage })
          }
          case 'anthropic': {
            const usage = await claudeUsage.fetchUsage()
            return c.json({ provider: 'anthropic', usage })
          }
          case 'x-premium': {
            return c.json({ provider: 'x-premium', usage: null })
          }
        }
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500)
      }
    })

    .post('/api/providers/chatgpt/oauth/start', async (c) => {
      try {
        prepareManagedOAuthProvider('chatgpt')
        const result = await managedOAuth.start('chatgpt')
        return c.json({ ...result, status: managedOAuth.getStatus('chatgpt') })
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500)
      }
    })

    .get('/api/providers/chatgpt/oauth/status', async (c) => {
      const refresh = c.req.query('refresh')
      const status =
        refresh === 'soft'
          ? await managedOAuth.getStatusWithRefresh('chatgpt')
          : managedOAuth.getStatus('chatgpt')
      return c.json(status)
    })

    .get('/api/providers/anthropic/oauth/usage', async (c) => {
      try {
        const usage = await claudeUsage.fetchUsage()
        return c.json({ provider: 'anthropic', usage })
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
