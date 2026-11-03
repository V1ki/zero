import { describe, expect, test } from 'bun:test'
import { TriggerSettingsConflictError } from '@zero-os/shared'
import type { TriggerRoutingSettings, TriggerSettings } from '@zero-os/shared'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createListenerRoutes } from '../listener-routes'

function fixture() {
  const repo = {
    name: 'acme/repo',
    enabled: true,
    workflowFailures: true,
    branch: 'main',
    workflow: '',
    mention: '@zero',
  }
  const settings: TriggerSettings = {
    github: { credentialRef: 'github_listener_work', repositories: [repo] },
    wxarc: { sessions: [{ id: 'room', name: 'Group', keyword: 'release', enabled: true }] },
  }
  let revision = 0
  let received: TriggerSettings | undefined
  let lookback: number | undefined
  let scanned = false
  let routingSettings: TriggerRoutingSettings = {
    enabled: false,
    timeZone: 'Asia/Shanghai',
    workdays: [1, 2, 3, 4, 5],
    workStart: '09:00',
    workEnd: '18:00',
    presence: 'auto',
    awayFallback: 'defer',
    duringWork: 'web',
    afterWork: 'defer',
    offDay: 'defer',
    weixinTarget: null,
  }
  let routeRevision = 0
  let heartbeatCount = 0
  let targetsAvailable = true
  const target = { channelId: 'account-1', peerId: 'peer-1' }
  const processCalls: number[] = []
  const app = new Hono()
    .route(
      '/api/listeners',
      createListenerRoutes({
        getSettings: () => ({ revision, settings: received ?? settings }),
        saveSettings(next, expected, hours) {
          if (expected !== revision) throw new TriggerSettingsConflictError()
          revision += 1
          received = next
          lookback = hours
          return { revision, settings: next }
        },
        getStatus: () => [],
        listInbox: () => [],
        listGithubRepositories: async (_signal, ref, name) => {
          if (ref !== 'github_listener_work') throw new Error('private upstream response')
          return [{ name: name ?? repo.name }]
        },
        listWxarcSessions: async () => [{ id: 'room', name: 'Group' }],
        scan: async () => {
          scanned = true
        },
        routing: {
          getConfig: () => ({ settings: routingSettings, revision: routeRevision }),
          saveConfig: (next: TriggerRoutingSettings, expected: number) => {
            if (expected !== routeRevision) throw new TriggerSettingsConflictError()
            routingSettings = next
            return { settings: routingSettings, revision: ++routeRevision }
          },
          listTargets: () =>
            targetsAvailable ? [{ ...target, label: 'Test', sessionSecret: 'private' }] : [],
          listRoutes: () => [],
          listWeb: () => [],
          latestWebDeliveryId: () => 7,
          heartbeat: () => {
            heartbeatCount++
          },
          process: (id: number) => {
            processCalls.push(id)
            if (!routingSettings.enabled) return 'disabled' as const
            if (id === 1) return 'already_processed' as const
            return id === 2 ? ('accepted' as const) : ('not_found' as const)
          },
        },
      }),
    )
    .use('*', cors())
    .get('/api/other', (c) => c.text('ok'))
  const req = (path: string, init: RequestInit = {}, peer = '127.0.0.1') =>
    app.request(`http://localhost:3001/api/listeners/${path}`, init, { remoteAddress: peer })
  const put = (payload: unknown, headers: Record<string, string> = {}) =>
    req('config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    })
  const routingWrite = (path: string, payload: unknown) =>
    req(`routing/${path}`, {
      method: path === 'config' ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  return {
    app,
    req,
    put,
    settings,
    getScanned: () => scanned,
    getLookback: () => lookback,
    routingWrite,
    routingSettings,
    target,
    getHeartbeats: () => heartbeatCount,
    unbindTarget: () => {
      targetsAvailable = false
    },
    processCalls,
  }
}

describe('listener control plane', () => {
  test('rejects remote sockets, cross-origin reads, and forged proxy traffic before legacy CORS', async () => {
    const { req, app } = fixture()
    const rejected = [
      await req('wxarc/sessions', { headers: { Host: 'localhost:3001' } }, '192.0.2.1'),
      await req('inbox', { headers: { Origin: 'https://site.example' } }),
      await req('inbox', { headers: { 'Sec-Fetch-Site': 'same-site' } }),
      await req('config', { method: 'OPTIONS', headers: { Origin: 'https://site.example' } }),
      await req('config', { headers: { 'X-Forwarded-For': '127.0.0.1, 192.0.2.1' } }),
      await req('config', { headers: { Host: 'attacker.example' } }),
      await app.request('http://public.example/api/listeners/config', {}, { remoteAddress: '::1' }),
      await app.request('http://localhost/api/listeners/config'),
    ]
    for (const res of rejected) {
      expect(res.status).toBe(403)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    }
    const proxied = await app.request(
      'http://localhost:3000/api/listeners/wxarc/sessions',
      {
        headers: {
          Host: 'localhost:3000',
          Origin: 'http://localhost:3000',
          'X-Forwarded-Host': 'localhost:3000',
          'X-Forwarded-For': '::1',
        },
      },
      { remoteAddress: '::ffff:127.0.0.1' },
    )
    expect(proxied.status).toBe(200)
    expect((await proxied.json()).sessions).toHaveLength(1)
    expect((await app.request('/api/other')).headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  test('requires JSON, validates nested settings and handles optimistic revisions', async () => {
    const { req, put, settings, getScanned, getLookback } = fixture()
    expect((await req('scan', { method: 'POST', body: '{}' })).status).toBe(415)
    expect(getScanned()).toBe(false)
    expect((await put({ revision: 0, settings, githubLookbackHours: 24 })).status).toBe(200)
    expect(getLookback()).toBe(24)
    expect((await put({ revision: 0, settings })).status).toBe(409)
    const res = await req('config')
    expect((await res.json()).settings.github.repositories[0].mention).toBe('zero')
    for (const payload of [
      { revision: 1, settings, githubLookbackHours: 48 },
      {
        revision: 1,
        settings: { ...settings, github: { ...settings.github, token: 'private-value' } },
      },
      {
        revision: 1,
        settings: {
          ...settings,
          github: { ...settings.github, credentialRef: 'unrelated_credential' },
        },
      },
      {
        revision: 1,
        settings: {
          ...settings,
          github: {
            ...settings.github,
            repositories: [
              ...settings.github.repositories,
              { ...settings.github.repositories[0], name: 'ACME/REPO' },
            ],
          },
        },
      },
    ])
      expect((await put(payload)).status).toBe(400)
    expect(
      (
        await req('scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(202)
    expect(getScanned()).toBe(true)
  })

  test('checks credential namespaces on lookup and does not echo upstream private information', async () => {
    const { req } = fixture()
    const refused = await req('github/repositories?credentialRef=provider_secret')
    expect(refused.status).toBe(400)
    const failure = await req('github/repositories?name=valid/repo')
    expect(failure.status).toBe(502)
    expect(await failure.text()).not.toContain('private upstream')
    const ok = await req('github/repositories?name=valid/repo&credentialRef=github_listener_work')
    expect(await ok.json()).toEqual({ repositories: [{ name: 'valid/repo' }] })
    expect((await req('inbox?beforeId=-1')).status).toBe(400)
  })

  test('routing writes reject unknown preferences and unbound Weixin recipients', async () => {
    const { req, routingWrite, routingSettings, target, unbindTarget } = fixture()
    const save = (
      changes: Partial<TriggerRoutingSettings> | Record<string, unknown>,
      revision = 0,
    ) => routingWrite('config', { revision, settings: { ...routingSettings, ...changes } })
    expect((await (await req('routing/config')).json()).settings.enabled).toBe(false)
    for (const changes of [
      { presence: 'unknown' },
      { duringWork: 'dingtalk' },
      { awayFallback: 'web' },
      { workStart: '9:00' },
      { workEnd: '24:00' },
      { workEnd: '09:00' },
      { workdays: [1, 1] },
      { workdays: ['1'] },
      { timeZone: 'Not/A_Zone' },
      { timeZone: '+08:00' },
      { weixinTarget: { ...target, peerId: 'stranger' } },
      { weixinTarget: { ...target, token: 'raw credential' } },
      { token: 'raw credential' },
    ])
      expect((await save(changes)).status).toBe(400)
    const changed = { weixinTarget: target, workStart: '22:00', workEnd: '06:00' }
    expect((await save(changed)).status).toBe(200)
    expect((await save(changed)).status).toBe(409)
    unbindTarget()
    expect((await save({ ...changed, presence: 'away' }, 1)).status).toBe(200)
    expect(
      (await save({ weixinTarget: { ...target, channelId: 'different-account' } }, 2)).status,
    ).toBe(400)
    expect((await save({ weixinTarget: null }, 2)).status).toBe(200)
  })

  test('routing endpoints share the local guard and only process an explicitly requested row', async () => {
    const { req, routingWrite, routingSettings, target, processCalls, getHeartbeats } = fixture()
    for (const path of ['targets', 'records', 'web', 'web/latest', 'config']) {
      const denied = await req(`routing/${path}`, {
        headers: { Origin: 'https://another.example' },
      })
      expect(denied.status).toBe(403)
      expect(denied.headers.get('Access-Control-Allow-Origin')).toBeNull()
    }
    expect(await (await req('routing/targets')).json()).toEqual({
      targets: [{ ...target, label: 'Test' }],
    })
    expect(await (await req('routing/web/latest')).json()).toEqual({ latestId: 7 })
    for (const path of ['records', 'web']) {
      expect(await (await req(`routing/${path}?limit=5`)).json()).toEqual({ records: [] })
      expect((await req(`routing/${path}?limit=101`)).status).toBe(400)
    }
    expect((await req('routing/presence', { method: 'POST', body: '{}' })).status).toBe(415)
    expect((await routingWrite('presence', { at: 'spoof' })).status).toBe(400)
    expect(getHeartbeats()).toBe(0)
    expect((await routingWrite('presence', {})).status).toBe(204)
    expect(getHeartbeats()).toBe(1)
    for (const payload of [{}, { inboxId: '1' }, { inboxId: -1 }, { inboxId: 2, force: true }])
      expect((await routingWrite('process', payload)).status).toBe(400)
    expect(processCalls).toHaveLength(0)
    expect((await routingWrite('process', { inboxId: 2 })).status).toBe(409)
    expect(
      (
        await routingWrite('config', {
          revision: 0,
          settings: { ...routingSettings, enabled: true },
        })
      ).status,
    ).toBe(200)
    expect((await routingWrite('process', { inboxId: 99 })).status).toBe(404)
    const already = await routingWrite('process', { inboxId: 1 })
    expect(already.status).toBe(200)
    expect(await already.json()).toEqual({ accepted: false })
    const accepted = await routingWrite('process', { inboxId: 2 })
    expect(accepted.status).toBe(202)
    expect(await accepted.json()).toEqual({ accepted: true })
    expect(processCalls).toEqual([2, 99, 1, 2])
  })
})
