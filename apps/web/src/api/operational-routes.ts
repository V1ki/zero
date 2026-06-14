import { Hono } from 'hono'
import type { ZeroOS } from '../../../server/src/main'

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

function parseLogLimit(value: string | undefined, fallback: number, max: number) {
  const parsed = Number(value ?? fallback)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), max)
}

function matchesRunLogQuery(entry: Record<string, unknown>, query: string) {
  if (!query) return true
  return JSON.stringify(entry).toLowerCase().includes(query.toLowerCase())
}

export function createOperationalRoutes(zero: ZeroOS) {
  return new Hono()
    .get('/logs/sessions', (c) => {
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

    .get('/logs/sessions/:sessionId/run', (c) => {
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

    .get('/logs', (c) => {
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

      entries.reverse()
      entries = entries.slice(0, limit)

      return c.json({ entries, limit })
    })

    .get('/notifications', (c) => {
      if (zero.notifications.length > 0) {
        const active = zero.notifications
          .filter((n) => !n.dismissedAt)
          .slice(-50)
          .reverse()
        return c.json({ notifications: active })
      }

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
          ts: e.ts as string,
          level: e.level as string,
        }))
      return c.json({ notifications })
    })

    .post('/notifications/:id/dismiss', (c) => {
      const id = c.req.param('id')
      const notification = zero.notifications.find((n) => n.id === id)
      if (!notification) {
        return c.json({ error: 'Notification not found' }, 404)
      }
      notification.dismissedAt = new Date().toISOString()
      return c.json({ ok: true })
    })

    .get('/channels/status', (c) => {
      const channels = Array.from(zero.channels.entries()).map(([name, ch]) => ({
        name,
        type: ch.type,
        status: ch.isConnected() ? 'online' : 'offline',
      }))
      return c.json({ channels })
    })

    .get('/channels/config', (c) => {
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

    .get('/tools', (c) => {
      const tools = zero.toolRegistry.list().map((t) => t.toDefinition())
      return c.json({ tools })
    })
}
