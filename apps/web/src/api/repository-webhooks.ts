import { Hono } from 'hono'
import type { ListenerRuntime } from '../../../server/src/triggers/runtime'

export function createRepositoryWebhookRoutes(listeners: Pick<ListenerRuntime, 'receiveWebhook'>) {
  const app = new Hono()
  for (const provider of ['github', 'ci'] as const) {
    app.post(`/${provider}/:owner/:repo`, (c) =>
      listeners.receiveWebhook(
        provider,
        `${c.req.param('owner')}/${c.req.param('repo')}`,
        c.req.raw,
      ),
    )
  }
  return app
}
