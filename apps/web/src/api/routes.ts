import { MemoryGovernanceService } from '@zero-os/memory'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { ZeroOS } from '../../../server/src/main'
import { createMemoryRoutes } from './memory-routes'
import { createMetricsRoutes } from './metrics-routes'
import { createOperationalRoutes } from './operational-routes'
import { createProviderConfigRoutes } from './provider-config-routes'
import { ProviderControlService } from './provider-control'
import { createSessionRoutes } from './session-routes'

export function createRoutes(zero: ZeroOS) {
  const memoryGovernance = new MemoryGovernanceService({
    store: zero.memoryStore,
    lifecycle: zero.memoryLifecycle,
    vectorIndex: zero.vectorIndex,
  })
  const providerControl = new ProviderControlService(zero)

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
      const currentWebSession = zero.sessionManager.getCurrentSessionForChannel(
        'web',
        'default',
        'web',
      )

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

    .route('/api', createSessionRoutes(zero))

    .route(
      '/api/memory',
      createMemoryRoutes({
        memoryStore: zero.memoryStore,
        memoryRetriever: zero.memoryRetriever,
        governance: memoryGovernance,
      }),
    )

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

    .route('/api/metrics', createMetricsRoutes(zero))

    .route('/api', createProviderConfigRoutes(providerControl))
    .route('/api', createOperationalRoutes(zero))

  return app
}

export type AppType = ReturnType<typeof createRoutes>
