import { Hono } from 'hono'
import type { MandateService } from '../../../server/src/triggers/mandate-service'
import {
  type ListenerEnv,
  badInput,
  checked,
  choice,
  fieldText,
  fields,
  pageNumber,
  requestJson,
} from './listener-input'

/** Mounted after the listener control plane's same-origin/loopback guard and payload limit. */
export function createMandateRoutes(service: MandateService | undefined) {
  const app = new Hono<ListenerEnv>()
  if (!service) return app.all('*', (c) => c.json({ error: '委托服务尚未启动。' }, 503))

  function pagination(limit?: string, beforeId?: string): [number, number | undefined] {
    return [pageNumber(limit, 100) ?? 30, pageNumber(beforeId, Number.MAX_SAFE_INTEGER)]
  }
  function recordId(id: string) {
    return pageNumber(id, Number.MAX_SAFE_INTEGER) ?? badInput('记录编号无效。')
  }

  return app
    .get('/config', (c) => c.json(service.getConfig()))
    .put('/config', async (c) => c.json(await service.saveConfig(await requestJson(c))))
    .get('/targets', async (c) => c.json(await service.targets()))
    .post('/documents/verify', async (c) =>
      c.json(await service.verifyDocument(await requestJson(c))),
    )
    .get('/tasks', (c) =>
      c.json({
        items: service.listTasks(...pagination(c.req.query('limit'), c.req.query('beforeId'))),
      }),
    )
    .get('/tasks/:id', (c) => c.json(service.getTask(recordId(c.req.param('id')))))
    .put('/tasks/:id/pause', async (c) => {
      const { paused } = fields(await requestJson(c), ['paused'])
      return c.json(service.setPaused(recordId(c.req.param('id')), checked(paused)))
    })
    .get('/records', (c) =>
      c.json({
        items: service.listRecords(
          ...pagination(c.req.query('limit'), c.req.query('beforeId')),
          pageNumber(c.req.query('inboxId'), Number.MAX_SAFE_INTEGER),
        ),
      }),
    )
    .get('/audit', (c) =>
      c.json({
        items: service.listAudit(...pagination(c.req.query('limit'), c.req.query('beforeId'))),
      }),
    )
    .post('/records/:id/retry', async (c) => {
      const { kind } = fields(await requestJson(c), ['kind'])
      return c.json(
        service.retry(
          recordId(c.req.param('id')),
          choice(kind, ['analysis', 'notify', 'archive'], '重试步骤'),
        ),
        202,
      )
    })
    .post('/preview', async (c) => {
      const { mandateId, at, present, urgent } = fields(await requestJson(c), [
        'mandateId',
        'at',
        'present',
        'urgent',
      ])
      return c.json(
        await service.preview(
          fieldText(mandateId, '委托标识', 64, true),
          fieldText(at, '预演时间', 40, true),
          present === null ? null : checked(present),
          urgent === undefined ? undefined : checked(urgent),
        ),
      )
    })
}
