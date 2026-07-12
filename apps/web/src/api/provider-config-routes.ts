import { toErrorMessage } from '@zero-os/shared'
import { Hono } from 'hono'
import type { ProviderControlService } from './provider-control'

export function createProviderConfigRoutes(control: ProviderControlService) {
  return new Hono()
    .get('/config', async (c) => c.json(await control.getConfig()))

    .put('/config', async (c) => {
      const body = await c.req.json<Record<string, unknown>>()
      try {
        return c.json(await control.updateConfig(body))
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 400)
      }
    })

    .post('/providers/:provider/oauth/start', async (c) => {
      try {
        const result = await control.startOAuth(c.req.param('provider'))
        if (!result) return c.json({ error: 'Unsupported OAuth provider' }, 404)
        return c.json(result)
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500)
      }
    })

    .get('/providers/:provider/oauth/status', async (c) => {
      const status = await control.getOAuthStatus(c.req.param('provider'), c.req.query('refresh'))
      if (!status) return c.json({ error: 'Unsupported OAuth provider' }, 404)
      return c.json(status)
    })

    .get('/providers/:provider/oauth/usage', async (c) => {
      try {
        return c.json(await control.fetchManagedOAuthUsage(c.req.param('provider')))
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500)
      }
    })

    .get('/providers/health', (c) => c.json(control.listProviderHealth()))

    .get('/providers/models/catalog', (c) => c.json(control.getModelCatalog()))

    .post('/providers/:provider/models/refresh', async (c) => {
      try {
        const result = await control.refreshModelCatalog(c.req.param('provider'))
        if (!result) return c.json({ error: 'Provider does not support model discovery' }, 404)
        return c.json(result)
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500)
      }
    })

    .post('/runtime/model-providers/reload', async (c) => {
      try {
        let body: Record<string, unknown> = {}
        if (c.req.header('content-type')?.includes('application/json')) {
          try {
            body = await c.req.json<Record<string, unknown>>()
          } catch {}
        }
        return c.json(await control.reloadModelProviders(body))
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500)
      }
    })

    .post('/providers/chatgpt/oauth/start', async (c) => {
      try {
        return c.json(await control.startChatGptOAuth())
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500)
      }
    })

    .get('/providers/chatgpt/oauth/status', async (c) => {
      const status = await control.getOAuthStatus('chatgpt', c.req.query('refresh'))
      return c.json(status)
    })

    .get('/providers/anthropic/oauth/usage', async (c) => {
      try {
        return c.json(await control.fetchManagedOAuthUsage('anthropic'))
      } catch (error) {
        return c.json({ error: toErrorMessage(error) }, 500)
      }
    })

    .post('/config/secrets', async (c) => {
      const body = await c.req.json<{ key: string; value: string }>()
      if (!body.key || !body.value) {
        return c.json({ error: 'key and value are required' }, 400)
      }
      return c.json(control.saveSecret(body.key, body.value))
    })

    .post('/config/secrets/delete', async (c) => {
      const body = await c.req.json<{ key: string }>()
      if (!body.key) {
        return c.json({ error: 'key is required' }, 400)
      }
      return c.json(control.deleteSecret(body.key))
    })

    .post('/config/rollback', async (c) => {
      const result = await control.rollbackConfig(process.cwd())
      if (!result) return c.json({ error: 'No stable tag found to rollback to' }, 404)
      return c.json(result)
    })

    .get('/config/last-stable-tag', async (c) => {
      return c.json(await control.getLastStableTag(process.cwd()))
    })
}
