import { buildSessionInfoReply, parseSessionArgs } from '@zero-os/core'
import { toErrorMessage } from '@zero-os/shared'
import { Hono } from 'hono'
import type { ZeroOS } from '../../../server/src/main'
import type { SessionJudgeHistoryResponse, StoredSessionJudgeEntry } from '../session-judge-types'
import { createSessionCacheEconomicsSummarizer, formatModelLabel } from './metrics-routes'
import { runSessionJudge } from './session-judge'

export function createSessionRoutes(zero: ZeroOS) {
  const summarizeSessionCacheEconomics = createSessionCacheEconomicsSummarizer(zero)

  function getCurrentSessionIds() {
    return new Set(zero.sessionManager.listCurrentBindings().map((binding) => binding.sessionId))
  }

  return new Hono()
    .get('/models', (c) => {
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

    .post('/chat/model', async (c) => {
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

    .post('/chat/new', async (c) => {
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

    .post('/chat', async (c) => {
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

      const assistantMessages = newMessages.filter((message) => message.role === 'assistant')
      const replyText = assistantMessages
        .flatMap((message) => message.content)
        .filter((block) => block.type === 'text')
        .map((block) => (block as { type: 'text'; text: string }).text)
        .join('\n')

      return c.json({
        sessionId: session.data.id,
        reply: replyText,
        messages: newMessages,
      })
    })

    .get('/sessions/channel/:channel/current', (c) => {
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

    .get('/sessions/sources/current', (c) => {
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

    .get('/sessions/source/:source/current', (c) => {
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

    .get('/sessions', (c) => {
      const rawFilter = c.req.query('filter') ?? 'all'
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

      const sessionIds = sessions.map((session) => session.data.id)
      const statsBatch = zero.metrics.sessionStatsBatch(sessionIds)

      const result: Array<Record<string, unknown>> = sessions.map((session) => {
        const messages = session.getMessages()
        const toolCallCount = messages
          .flatMap((message) => message.content)
          .filter((block) => block.type === 'tool_use').length
        const userMessageCount = messages.filter(
          (message) =>
            message.role === 'user' &&
            !message.content.every((block) => block.type === 'tool_result'),
        ).length
        const assistantMessageCount = messages.filter(
          (message) =>
            message.role === 'assistant' && message.content.some((block) => block.type === 'text'),
        ).length
        const stats = statsBatch.get(session.data.id)
        const isCurrent = currentIds.has(session.data.id)

        return {
          id: session.data.id,
          source: session.data.source,
          channelName: session.data.channelName,
          isCurrent,
          placement: isCurrent ? 'current' : 'background',
          currentModel: session.data.currentModel,
          createdAt: session.data.createdAt,
          updatedAt: session.data.updatedAt,
          messageCount: messages.length,
          tags: session.data.tags,
          summary: session.data.summary,
          channelId: session.data.channelId,
          modelHistory: session.data.modelHistory,
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
        const dbOnlyIds = dbRows.filter((row) => !inMemoryIds.has(row.id)).map((row) => row.id)
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
              (session) =>
                (session.id as string).toLowerCase().includes(q) ||
                (session.source as string).toLowerCase().includes(q) ||
                ((session.channelName as string)?.toLowerCase().includes(q) ?? false) ||
                (session.currentModel as string).toLowerCase().includes(q) ||
                ((session.summary as string)?.toLowerCase().includes(q) ?? false) ||
                ((session.channelId as string)?.toLowerCase().includes(q) ?? false),
            )
          : result
      ).sort((left, right) => (right.updatedAt as string).localeCompare(left.updatedAt as string))

      return c.json({ sessions: filtered })
    })

    .get('/sessions/:id', (c) => {
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

    .route('/', createSessionObservabilityRoutes(zero))

    .post('/sessions/:id/tool-calls/:toolUseId/abort', (c) => {
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

    .post('/sessions/:id/repair/rollback-tail', async (c) => {
      const id = c.req.param('id')
      const session = zero.sessionManager.get(id)
      if (!session) {
        return c.json({ error: 'Session not found' }, 404)
      }

      const body = await c.req
        .json<{ count?: unknown; dryRun?: unknown; reason?: unknown }>()
        .catch(() => ({}) as { count?: unknown; dryRun?: unknown; reason?: unknown })
      const rawCount = body.count ?? 1
      const count = typeof rawCount === 'number' ? rawCount : Number(rawCount)
      const dryRun = body.dryRun === undefined ? true : body.dryRun !== false
      const reason = typeof body.reason === 'string' ? body.reason : undefined
      const result = session.rollbackTailMessages(count, { dryRun, reason })

      if (!result.ok && result.status === 'invalid_count') {
        return c.json(result, 400)
      }
      if (!result.ok && result.status === 'turn_in_progress') {
        return c.json(result, 409)
      }

      return c.json(result)
    })

    .delete('/sessions/:id', async (c) => {
      const id = c.req.param('id')
      const deleted = await zero.sessionManager.deleteSession(id, zero.memoryStore, zero.metrics)
      if (!deleted) {
        return c.json({ error: 'Session not found' }, 404)
      }
      return c.json({ ok: true })
    })
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

function createSessionObservabilityRoutes(zero: ZeroOS) {
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

  return new Hono()
    .get('/sessions/:id/requests', (c) => {
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

    .get('/sessions/:id/decisions', (c) => {
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

    .get('/sessions/:id/traces', (c) => {
      const id = c.req.param('id')
      const traces = zero.tracer.exportSession(id).map((span) => sanitizeTraceSpanForClient(span))
      return c.json({ traces })
    })

    .get('/sessions/:id/task-closure-events', (c) => {
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

    .get('/sessions/:id/llm-judge', (c) => {
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

    .post('/sessions/:id/llm-judge', async (c) => {
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
}
