import type {
  MemoryGovernanceService,
  MemoryRelationRemoveSpec,
  MemoryRepository,
  MemoryRetriever,
  MemoryUsageTracker,
} from '@zero-os/memory'
import { ALL_MEMORY_TYPES, type MemoryType } from '@zero-os/shared'
import { Hono } from 'hono'

interface MemoryRoutesDeps {
  memoryStore: MemoryRepository
  memoryRetriever: MemoryRetriever
  governance: MemoryGovernanceService
  /** 可选:测试 stub 与降级模式(无统计文件)下缺席,端点返回空数组而非报错。 */
  usageTracker?: MemoryUsageTracker
}

export function createMemoryRoutes({
  memoryStore,
  memoryRetriever,
  governance,
  usageTracker,
}: MemoryRoutesDeps) {
  return new Hono()
    .get('/', (c) => {
      const type = c.req.query('type') as MemoryType | undefined
      if (type && type !== ('all' as unknown)) {
        const memories = memoryStore.list(type)
        return c.json({ memories, type })
      }
      const memories = ALL_MEMORY_TYPES.flatMap((memoryType) => memoryStore.list(memoryType))
      memories.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      return c.json({ memories, type: 'all' })
    })

    .get('/usage', (c) => {
      return c.json({ usage: usageTracker?.snapshot() ?? [] })
    })

    .get('/search', async (c) => {
      const q = c.req.query('q') ?? ''
      if (!q) return c.json({ results: [], query: q })
      const results = await memoryRetriever.retrieve(q, { topN: 20, confidenceThreshold: 0 })
      return c.json({ results, query: q })
    })

    .post('/', async (c) => {
      const body = await c.req.json<{
        type: MemoryType
        title: string
        content: string
        tags?: unknown
        status?: unknown
        confidence?: unknown
      }>()
      if (!body.type || !body.title || !body.content) {
        return c.json({ error: 'type, title, and content are required' }, 400)
      }
      const memory = await governance.createMemory(body)
      return c.json({ memory })
    })

    .get('/:type/:id', (c) => {
      const type = c.req.param('type') as MemoryType
      const id = c.req.param('id')
      const memory = memoryStore.get(type, id)
      if (!memory) return c.json({ error: 'Memory not found' }, 404)
      return c.json({ memory })
    })

    .put('/:type/:id', async (c) => {
      const type = c.req.param('type') as MemoryType
      const id = c.req.param('id')
      const body = await c.req
        .json<Record<string, unknown>>()
        .catch(() => ({}) as Record<string, unknown>)
      const updated = await governance.updateMemoryFields(type, id, body)
      if (!updated) return c.json({ error: 'Memory not found' }, 404)
      return c.json({ memory: updated })
    })

    .post('/:type/:id/archive', async (c) => {
      const type = c.req.param('type') as MemoryType
      const id = c.req.param('id')
      const updated = await governance.archive(type, id)
      if (!updated) return c.json({ error: 'Memory not found' }, 404)
      return c.json({ memory: updated })
    })

    .post('/:type/:id/verify', async (c) => {
      const type = c.req.param('type') as MemoryType
      const id = c.req.param('id')
      const updated = await governance.verify(type, id)
      if (!updated) return c.json({ error: 'Memory not found' }, 404)
      return c.json({ memory: updated })
    })

    .post('/:type/:id/supersede', async (c) => {
      const type = c.req.param('type') as MemoryType
      const id = c.req.param('id')
      const body = await c.req
        .json<{ bySupersededId?: string }>()
        .catch(() => ({}) as { bySupersededId?: string })
      if (!body.bySupersededId) {
        return c.json({ error: 'bySupersededId is required' }, 400)
      }
      const result = await governance.supersede(type, id, body.bySupersededId)
      if (!result.ok) return c.json({ error: result.error }, result.status)
      return c.json({ memory: result.value })
    })

    .post('/:type/:id/resolve-conflict', async (c) => {
      const type = c.req.param('type') as MemoryType
      const id = c.req.param('id')
      const body = await c.req
        .json<{ otherId?: string }>()
        .catch(() => ({}) as { otherId?: string })
      const otherId = typeof body.otherId === 'string' ? body.otherId : ''
      const result = await governance.resolveConflict(type, id, otherId)
      if (!result.ok) {
        return c.json(
          { error: result.error, ...(result.detail ? { detail: result.detail } : {}) },
          result.status,
        )
      }
      return c.json({ winner: result.value })
    })

    .post('/maintenance/archive-old', async (c) => {
      const body = await c.req
        .json<{ type?: MemoryType; olderThanDays?: number }>()
        .catch(() => ({}) as { type?: MemoryType; olderThanDays?: number })
      const result = await governance.archiveOld(body)
      if (!result.ok) {
        return c.json(
          { error: result.error, ...(result.detail ? { detail: result.detail } : {}) },
          result.status,
        )
      }
      return c.json(result.value)
    })

    .patch('/:type/:id/relations', async (c) => {
      const type = c.req.param('type') as MemoryType
      const id = c.req.param('id')
      const body = await c.req
        .json<{ add?: unknown[]; remove?: MemoryRelationRemoveSpec[] }>()
        .catch(() => ({}) as { add?: unknown[]; remove?: MemoryRelationRemoveSpec[] })
      const updated = await governance.updateRelations({
        type,
        id,
        add: body.add,
        remove: body.remove,
      })
      if (!updated) return c.json({ error: 'Memory not found' }, 404)
      return c.json({ memory: updated })
    })

    .get('/:type/:id/neighbors', async (c) => {
      const type = c.req.param('type') as MemoryType
      const id = c.req.param('id')
      const topK = Math.min(20, Math.max(1, Number(c.req.query('topK') ?? 8)))
      return c.json(await governance.getNeighbors(type, id, topK))
    })

    .get('/:type/:id/related', async (c) => {
      const type = c.req.param('type') as MemoryType
      const id = c.req.param('id')
      const result = await governance.getRelated(type, id)
      if (!result) return c.json({ error: 'Memory not found' }, 404)
      return c.json(result)
    })

    .get('/clusters', async (c) => {
      const threshold = Number(c.req.query('threshold') ?? 0.9)
      const force = c.req.query('fresh') === '1'
      return c.json(await governance.getClusters({ threshold, force }))
    })

    .delete('/:type/:id', async (c) => {
      const type = c.req.param('type') as MemoryType
      const id = c.req.param('id')
      const deleted = await governance.deleteMemory(type, id)
      if (!deleted) return c.json({ error: 'Memory not found' }, 404)
      return c.json({ ok: true })
    })
}
