import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { ENTITY_VERSION } from './entity-resolution'
import { ENDPOINT, MODEL, PROMPT_VERSION, resolveAssetId } from './extraction'
import type { ProjectStore } from './store'
import type { ProjectView } from './types'

export function createIPVideoRoutes(store: ProjectStore) {
  const app = new Hono()
  app.use('*', bodyLimit({ maxSize: 22 * 1024 * 1024 }))
  app.use('*', async (c, next) => {
    const origin = c.req.header('Origin')
    if (
      origin &&
      ![
        'http://localhost:14432',
        'http://127.0.0.1:14432',
        'http://localhost:14433',
        'http://127.0.0.1:14433',
      ].includes(origin)
    )
      return c.json({ error: '不允许的来源' }, 403)
    await next()
  })
  app.onError((error, c) => c.json({ error: error.message }, 400))
  app.get('/health', (c) =>
    c.json({
      service: 'ip-video',
      entityResolutionVersion: ENTITY_VERSION,
      dataRoot: store.root,
      pid: process.pid,
      model: MODEL,
      endpoint: ENDPOINT,
      promptVersion: PROMPT_VERSION,
    }),
  )
  app.get('/projects', (c) => c.json(store.list()))
  app.post('/projects', async (c) => {
    const body: unknown = await c.req.json()
    if (
      !body ||
      typeof body !== 'object' ||
      !('title' in body) ||
      typeof body.title !== 'string' ||
      !('source' in body) ||
      typeof body.source !== 'string'
    )
      return c.json({ error: '需要title和source文本' }, 400)
    return c.json(store.import(body.title, body.source), 201)
  })
  app.get('/projects/:id', (c) => c.json(store.view(c.req.param('id'))))
  app.get('/projects/:id/assets/:assetId', (c) => {
    const project = store.read(c.req.param('id'))
    const id = c.req.param('assetId')
    const key = c.req.query('evidenceKey')
    const asset = resolveAssetId(project, id, key)
    if (!asset && !key) {
      const destinations = [
        ...new Set(
          Object.entries(project.identityResolution?.mentionRedirects ?? {})
            .filter(([address]) => JSON.parse(address)[0] === id)
            .map(([, target]) => target),
        ),
      ]
      if (destinations.length > 1)
        return c.json({ error: '旧ID包含不同实体，请指定evidenceKey', destinations }, 409)
    }
    return asset ? c.json(asset) : c.json({ error: '资产不存在' }, 404)
  })
  app.get('/projects/:id/source', (c) => c.text(store.source(c.req.param('id'))))
  app.get('/projects/:id/chapters/:chapterId', (c) => {
    const project = store.read(c.req.param('id'))
    const chapter = project.chapters.find((item) => item.id === c.req.param('chapterId'))
    if (!chapter) return c.json({ error: '章节不存在' }, 404)
    return c.text(store.source(project.id).slice(chapter.start, chapter.end))
  })
  app.post('/projects/:id/analyze', async (c) => {
    const body: unknown = await c.req.json()
    if (!body || typeof body !== 'object') return c.json({ error: '需要JSON对象' }, 400)
    const options = body as { retryFailed?: unknown; concurrency?: unknown }
    if (options.retryFailed !== undefined && typeof options.retryFailed !== 'boolean')
      return c.json({ error: 'retryFailed必须为布尔值' }, 400)
    if (
      options.concurrency !== undefined &&
      (typeof options.concurrency !== 'number' ||
        !Number.isInteger(options.concurrency) ||
        options.concurrency < 4 ||
        options.concurrency > 8)
    )
      return c.json({ error: '并发必须为4到8的整数' }, 400)
    const id = c.req.param('id')
    store.read(id)
    const task = store.start(id, {
      retryFailed: options.retryFailed as boolean | undefined,
      concurrency: options.concurrency as number | undefined,
    })
    // run() persists failures. Logging makes infrastructure failures visible too.
    void task.catch((error: unknown) => console.error('IP video analysis failed', id, error))
    return c.json({ accepted: true, id }, 202)
  })
  app.get('/projects/:id/events', (c) => {
    const id = c.req.param('id')
    const initial = store.view(id)
    const encoder = new TextEncoder()
    let cleanup = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (project: ProjectView) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(project)}\n\n`))
          } catch {
            cleanup()
          }
        }
        const close = () => {
          cleanup()
          controller.close()
        }
        cleanup = () => {
          store.events.off(id, send)
          c.req.raw.signal.removeEventListener('abort', close)
        }
        store.events.on(id, send)
        c.req.raw.signal.addEventListener('abort', close, { once: true })
        send(initial)
      },
      cancel() {
        cleanup()
      },
    })
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    })
  })
  return app
}
