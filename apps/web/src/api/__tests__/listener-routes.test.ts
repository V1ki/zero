import { describe, expect, test } from 'bun:test'
import { TriggerSettingsConflictError } from '@zero-os/shared'
import type {
  MandateTarget,
  TriggerGithubPermissionSelection,
  TriggerRoutingSettings,
  TriggerSettings,
} from '@zero-os/shared'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { TriggerStore } from '../../../../../packages/observe/src/trigger-store'
import {
  type MandateService,
  createMandateService,
} from '../../../../server/src/triggers/mandate-service'
import { buildRouterSurface } from '../../../../server/src/triggers/router-surface'
import { RouterWorkspaceError } from '../../../../server/src/triggers/router-workspace'
import { createListenerRoutes } from '../listener-routes'

function fixture(mandates?: MandateService) {
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
  let mandateRevision: number | undefined
  let scanned = false
  const permissionChecks: {
    name: string
    credentialRef: string
    selection: TriggerGithubPermissionSelection
  }[] = []
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
  let bindings: { revision: number; targets: MandateTarget[] } = { revision: 0, targets: [] }
  let targetsAvailable = true
  const target = { channelId: 'account-1', peerId: 'peer-1' }
  const group = { channelId: 'agent', peerId: 'project', operatorId: 'maintainer' }
  const processCalls: number[] = []
  const workspaceCalls: unknown[][] = []
  const noticeListeners = new Set<() => void>()
  const snapshot = () => ({
    scope: 'general' as const,
    event: null,
    route: null,
    turns: [],
    settings: { settings: routingSettings, revision: routeRevision },
    surface: buildRouterSurface('general', null, null, routingSettings),
  })
  const app = new Hono()
    .route(
      '/api/listeners',
      createListenerRoutes({
        mandates,
        webNotifications: {
          latestId: () => 29,
          list(query = {}) {
            const pointer = { id: 29, inboxId: 8, taskId: 3, createdAt: '2026-11-01T00:00:00Z' }
            return {
              latestId: 29,
              items:
                query.after === 29
                  ? []
                  : [
                      query.brief
                        ? pointer
                        : { ...pointer, title: 'private title', summary: 'private content' },
                    ],
            }
          },
          subscribe(listener) {
            noticeListeners.add(listener)
            return () => {
              noticeListeners.delete(listener)
            }
          },
        },
        getSettings: () => ({ revision, settings: received ?? settings }),
        saveSettings(next, expected, hours, expectedMandateRevision) {
          if (expected !== revision) throw new TriggerSettingsConflictError()
          revision += 1
          received = next
          lookback = hours
          mandateRevision = expectedMandateRevision
          return { revision, settings: next }
        },
        getStatus: () => [],
        listInbox: () => [],
        listGithubRepositories: async (_signal, ref, name) => {
          if (ref !== 'github_listener_work') throw new Error('private upstream response')
          return [{ name: name ?? repo.name }]
        },
        checkGithubPermissions: async (name, credentialRef, selection) => {
          permissionChecks.push({ name, credentialRef, selection })
          if (credentialRef === 'github_listener_missing')
            throw new Error('private credential details')
          return {
            access: credentialRef ? 'credential' : 'anonymous',
            checks: [{ resource: 'actions', status: 'readable' }],
          }
        },
        listWxarcSessions: async () => [{ id: 'room', name: 'Group' }],
        scan: async () => {
          scanned = true
        },
        workspace: {
          listEvents(limit, beforeId) {
            workspaceCalls.push(['events', limit, beforeId])
            return []
          },
          get(scope) {
            workspaceCalls.push(['get', scope])
            if (scope !== 'general') throw new RouterWorkspaceError(404, '事件不存在。')
            return snapshot()
          },
          async message(scope, requestId, text, retry) {
            workspaceCalls.push(['message', scope, requestId, text, retry])
            if (text === 'busy') throw new RouterWorkspaceError(409, '已有进行中的回合。')
            if (text === 'fail') throw new RouterWorkspaceError(502, '模型暂不可用。')
            if (text === 'unexpected') throw new Error('sensitive upstream body')
            return snapshot()
          },
          async action(scope, requestId, action, retry) {
            workspaceCalls.push(['action', scope, requestId, action, retry])
            throw new RouterWorkspaceError(409, '卡片已更新。')
          },
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
          getBotBindings: () => bindings,
          saveBotBinding: (platform, channelId, target, revision) => {
            if (revision !== bindings.revision) throw new TriggerSettingsConflictError()
            const targets = bindings.targets.filter(
              (t) => t.platform !== platform || t.channelId !== channelId,
            )
            if (target) targets.push(target)
            bindings = { revision: revision + 1, targets }
            return bindings
          },
          listPersonalBots: () => [
            {
              platform: 'weixin',
              channelId: target.channelId,
              label: 'iLink',
              online: true,
              ready: true,
              deliveryState: 'ready',
            },
            {
              platform: 'dingtalk',
              channelId: 'agent',
              label: '运维',
              online: true,
              ready: false,
              deliveryState: 'awaiting_private',
            },
            {
              platform: 'feishu',
              channelId: 'bot-only',
              label: '研究',
              online: false,
              ready: false,
              deliveryState: 'offline',
            },
          ],
          listPersonalTargets: () =>
            targetsAvailable
              ? [
                  { platform: 'weixin', ...target, operatorId: target.peerId, label: 'Test' },
                  { platform: 'dingtalk', ...group, label: '运维', sessionSecret: 'private' },
                  { platform: 'feishu', ...group, label: '研究' },
                ]
              : [],
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
    req(path === 'bot-bindings' ? 'channels/bot-bindings' : `routing/${path}`, {
      method: ['config', 'preferences', 'bot-bindings'].includes(path) ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  return {
    app,
    req,
    put,
    settings,
    getScanned: () => scanned,
    permissionChecks,
    getLookback: () => lookback,
    getMandateRevision: () => mandateRevision,
    routingWrite,
    routingSettings,
    target,
    getHeartbeats: () => heartbeatCount,
    unbindTarget: () => {
      targetsAvailable = false
    },
    processCalls,
    workspaceCalls,
    noticeListeners,
  }
}

test('web delivery changes have a loopback-only, content-free signal and cursor; bodies require explicit listing', async () => {
  const { req, noticeListeners } = fixture()
  for (const path of [
    'web-notifications',
    'web-notifications/latest',
    'web-notifications/changes',
  ]) {
    expect((await req(path, {}, '10.0.0.8')).status).toBe(403)
    expect((await req(path, { headers: { Origin: 'https://foreign.example' } })).status).toBe(403)
  }
  expect(await (await req('web-notifications/latest')).json()).toEqual({ id: 29 })
  expect(await (await req('routing/web/latest')).json()).toEqual({ latestId: 7 })
  expect(await (await req('web-notifications?after=29&brief=1')).json()).toEqual({
    latestId: 29,
    items: [],
  })
  const pointers = await req('web-notifications?after=0&brief=1')
  expect(await pointers.text()).not.toContain('private')
  const details = await req('web-notifications')
  expect(await details.text()).toContain('private content')
  for (const q of ['?after=1&before=2', '?after=-1', '?brief=body', '?limit=999']) {
    expect((await req(`web-notifications${q}`)).status).toBe(400)
  }
  const stream = await req('web-notifications/changes')
  expect(stream.headers.get('Content-Type')).toBe('text/event-stream')
  expect(stream.headers.get('Cache-Control')).toBe('no-store')
  const reader = stream.body?.getReader()
  if (!reader) throw new Error('Missing notification stream')
  try {
    const decoder = new TextDecoder()
    expect(decoder.decode((await reader.read()).value)).toBe('data: changed\n\n')
    for (const signal of noticeListeners) signal()
    expect(decoder.decode((await reader.read()).value)).toBe('data: changed\n\n')
  } finally {
    await reader.cancel()
  }
  expect(noticeListeners.size).toBe(0)
})

describe('listener control plane', () => {
  test('protects workspace threads and validates scope, request identity and text before invoking the Agent', async () => {
    const { req, workspaceCalls } = fixture()
    const requestId = crypto.randomUUID()
    const post = (path: string, payload: unknown, headers: Record<string, string> = {}) =>
      req(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(payload),
      })
    for (const path of [
      'workspace-events',
      'workspace/general',
      'workspace/2/messages',
      'workspace/2/actions',
    ]) {
      const res = await req(path, {
        method: path.startsWith('workspace/2/') ? 'POST' : 'GET',
        headers: { Origin: 'https://untrusted.example' },
      })
      expect(res.status).toBe(403)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    }
    for (const scope of ['GENERAL', '0', '01', '-1', '1e3', '9007199254740992']) {
      expect((await req(`workspace/${scope}`)).status).toBe(400)
    }
    for (const query of ['limit=101', 'beforeId=0']) {
      expect((await req(`workspace-events?${query}`)).status).toBe(400)
    }
    for (const payload of [
      {},
      { text: 'ok', requestId: 'bad-id' },
      { text: ' ', requestId },
      { text: 'x'.repeat(2001), requestId },
      { text: 'hello\u0000', requestId },
      { text: 'ok', requestId, retry: 'true' },
      { text: 'ok', requestId, system: 'untrusted' },
    ])
      expect((await post('workspace/general/messages', payload)).status).toBe(400)
    expect(
      (await post('workspace/general/actions', { requestId, action: {}, peer: 'someone' })).status,
    ).toBe(400)
    expect(
      (
        await post(
          'workspace/general/messages',
          { requestId, text: 'hi' },
          { 'Content-Type': 'text/plain' },
        )
      ).status,
    ).toBe(415)
    expect(workspaceCalls).toEqual([])
    expect(await (await req('workspace-events?limit=5&beforeId=60')).json()).toEqual({ items: [] })
    expect((await (await req('workspace/general')).json()).scope).toBe('general')
    expect((await req('workspace/99')).status).toBe(404)
    expect(
      (
        await post('workspace/general/messages', {
          requestId: requestId.toUpperCase(),
          text: ' hi\nthere ',
          retry: true,
        })
      ).status,
    ).toBe(200)
    const action = {
      version: 'v0.9.1',
      action: {
        surfaceId: 'router-event-2',
        sourceComponentId: 'btn-explain_route',
        name: 'explain_route',
        context: {},
        timestamp: '2026-11-03T12:00:00.000Z',
      },
    }
    expect((await post('workspace/2/actions', { requestId, action })).status).toBe(409)
    expect(workspaceCalls).toEqual([
      ['events', 5, 60],
      ['get', 'general'],
      ['get', 99],
      ['message', 'general', requestId, 'hi\nthere', true],
      ['action', 2, requestId, action, false],
    ])
    expect((await post('workspace/general/messages', { requestId, text: 'busy' })).status).toBe(409)
    expect((await post('workspace/general/messages', { requestId, text: 'fail' })).status).toBe(502)
    const failure = await post('workspace/general/messages', { requestId, text: 'unexpected' })
    expect(failure.status).toBe(500)
    expect(await failure.text()).not.toContain('sensitive upstream body')
  })

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

  test('a read permission check probes only the selected repository rules and leaves local state untouched', async () => {
    const { req, permissionChecks, getScanned, processCalls } = fixture()
    const before = await (await req('config')).json()
    const selection = { workflowFailures: true, prComments: false, prBase: false }
    const input = { name: 'draft/repo', credentialRef: '', ...selection }
    const check = (change: Record<string, unknown>, peer = '127.0.0.1') =>
      req(
        'github/permissions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...input, ...change }),
        },
        peer,
      )
    expect((await check({}, '203.0.113.2')).status).toBe(403)
    for (const change of [
      { credentialRef: 'github_webhook' },
      { name: 'draft/repo/../other' },
      { workflowFailures: false },
      { prBase: true },
      { resource: '/private/path' },
    ])
      expect((await check(change)).status).toBe(400)
    expect(permissionChecks).toHaveLength(0)
    const success = await check({})
    expect(success.headers.get('Cache-Control')).toBe('no-store')
    expect(await success.json()).toEqual({
      access: 'anonymous',
      checks: [{ resource: 'actions', status: 'readable' }],
    })
    expect(permissionChecks).toEqual([{ name: 'draft/repo', credentialRef: '', selection }])
    const missing = await check({ credentialRef: 'github_listener_missing' })
    expect(missing.status).toBe(502)
    expect(await missing.text()).not.toContain('private credential details')
    expect(await (await req('config')).json()).toEqual(before)
    expect(getScanned()).toBe(false)
    expect(processCalls).toEqual([])
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
      { retentionDays: 0 },
      { retentionDays: '30' },
      { duringWork: 'email' },
      { awayFallback: 'web' },
      { workStart: '9:00' },
      { workEnd: '24:00' },
      { workEnd: '09:00' },
      { workdays: [1, 1] },
      { workdays: ['1'] },
      { dateOverrides: { '2026-02-29': 'off' } },
      { dateOverrides: { '2028-02-29': true } },
      { dateOverrides: [] },
      { nativePresence: { enabled: true, idleMinutes: 0, bluetooth: false } },
      { nativePresence: { enabled: true, idleMinutes: 5, bluetooth: 'yes' } },
      { nativePresence: { enabled: true, idleMinutes: 5, bluetooth: true, deviceName: 'private' } },
      { timeZone: 'Not/A_Zone' },
      { timeZone: '+08:00' },
      { weixinTarget: { ...target, peerId: 'stranger' } },
      { weixinTarget: { ...target, token: 'raw credential' } },
      { token: 'raw credential' },
    ])
      expect((await save(changes)).status).toBe(400)
    const changed = {
      weixinTarget: target,
      workStart: '22:00',
      workEnd: '06:00',
      retentionDays: 30,
      dateOverrides: { '2028-02-29': 'work' },
      nativePresence: { enabled: true, idleMinutes: 5, bluetooth: false },
    } as const
    expect((await save(changed)).status).toBe(200)
    expect((await save(changed)).status).toBe(409)
    unbindTarget()
    expect((await save({ ...changed, presence: 'away' }, 1)).status).toBe(200)
    expect(
      (await save({ weixinTarget: { ...target, channelId: 'different-account' } }, 2)).status,
    ).toBe(400)
    expect((await save({ weixinTarget: null }, 2)).status).toBe(200)
  })

  test('Router can choose an attached robot without a delivery address and never returns a legacy peer', async () => {
    const { req, routingWrite, routingSettings, target } = fixture()
    expect(
      (
        await routingWrite('config', {
          revision: 0,
          settings: { ...routingSettings, weixinTarget: target },
        })
      ).status,
    ).toBe(200)
    const original = await (await req('routing/preferences')).json()
    expect(original.settings.weixinTarget).toBeNull()
    expect(original.settings.personalBots.weixin).toBe(target.channelId)
    const save = (patch: Record<string, unknown>, revision = 1) =>
      routingWrite('preferences', {
        revision,
        settings: { ...original.settings, ...patch },
      })
    for (const patch of [
      { dingtalkTarget: { platform: 'dingtalk', ...target } },
      { weixinTarget: target },
      { personalBots: { feishu: 'agent' } },
      { personalBots: { email: 'anything' } },
      { personalBots: { dingtalk: { peerId: 'unwanted' } } },
    ])
      expect((await save(patch)).status).toBe(400)
    const directory = await (await req('routing/bots')).json()
    expect(directory.bots.map((bot: { label: string }) => bot.label)).toEqual([
      'iLink',
      '运维',
      '研究',
    ])
    expect(JSON.stringify(directory)).not.toContain('peerId')
    expect(directory.bots.map((bot: { deliveryState: string }) => bot.deliveryState)).toEqual([
      'ready',
      'awaiting_private',
      'offline',
    ])
    const personalBots = { weixin: target.channelId, feishu: 'bot-only', dingtalk: 'agent' }
    const saved = await save({ personalBots, duringWork: 'dingtalk', awayFallback: 'feishu' })
    expect(saved.status).toBe(200)
    expect((await saved.json()).settings.personalBots).toEqual(personalBots)
    expect((await save({ personalBots })).status).toBe(409)
    expect((await (await req('channels/bot-bindings')).json()).targets).toEqual([])
    expect((await (await req('routing/config')).json()).settings.weixinTarget).toEqual(target)
  })

  test('channel address configuration verifies the exact account, chat and operator and cannot change router preferences', async () => {
    const { req, routingWrite, unbindTarget } = fixture()
    const { targets } = await (await req('channels/personal-targets')).json()
    expect(targets[1]).not.toHaveProperty('sessionSecret')
    const target = {
      platform: 'dingtalk',
      channelId: 'agent',
      peerId: 'project',
      operatorId: 'maintainer',
    }
    const save = (to: unknown, revision = 0) =>
      routingWrite('bot-bindings', {
        revision,
        platform: 'dingtalk',
        channelId: 'agent',
        target: to,
      })
    for (const invalid of [
      { ...target, platform: 'feishu' },
      { ...target, channelId: 'another' },
      { ...target, peerId: 'stranger' },
      { ...target, operatorId: 'different' },
      { ...target, token: 'bad' },
    ])
      expect((await save(invalid)).status).toBe(400)
    expect((await save(target)).status).toBe(200)
    expect(await (await req('channels/bot-bindings')).json()).toEqual({
      revision: 1,
      targets: [target],
    })
    expect((await save(null)).status).toBe(409)
    unbindTarget()
    expect((await save(null, 1)).status).toBe(200)
    expect((await (await req('routing/preferences')).json()).revision).toBe(0)
  })

  test('routing endpoints share the local guard and only process an explicitly requested row', async () => {
    const { req, routingWrite, routingSettings, target, processCalls, getHeartbeats } = fixture()
    for (const path of [
      'routing/targets',
      'routing/preferences',
      'routing/bots',
      'channels/bot-bindings',
      'channels/personal-targets',
      'routing/records',
      'routing/web',
      'routing/web/latest',
      'routing/config',
    ]) {
      const denied = await req(path, {
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

  test('keeps legacy subscriptions and validates per-repository webhook credentials', async () => {
    const { put, settings } = fixture()
    const repo = settings.github.repositories[0]
    const write = (revision: number, changes: Record<string, unknown>) =>
      put({
        revision,
        settings: {
          ...settings,
          github: { ...settings.github, repositories: [{ ...repo, ...changes }] },
        },
      })
    const cleaned = { ...repo, mention: 'zero' }
    const legacy = await write(0, {})
    expect(legacy.status).toBe(200)
    expect((await legacy.json()).settings.github.repositories).toEqual([cleaned])
    for (const invalid of [
      { deliveryMode: 'unknown' },
      { deliveryMode: 'webhook' },
      { deliveryMode: 'webhook', webhookSecretRef: 'github_listener' },
      { deliveryMode: 'webhook', webhookSecretRef: 'ci_webhook_build' },
      { ciWebhookSecretRef: 'github_webhook' },
      { ciWebhookSecretRef: 'ci_webhook:secret' },
      { ciWebhookSecretRef: 'ci_webhook_build', workflowFailures: false },
    ]) {
      expect((await write(1, invalid)).status).toBe(400)
    }
    const signed = {
      deliveryMode: 'webhook',
      webhookSecretRef: 'github_webhook_release',
      ciWebhookSecretRef: 'ci_webhook_build',
    }
    const enabled = await write(1, signed)
    expect(enabled.status).toBe(200)
    expect((await enabled.json()).settings.github.repositories).toEqual([{ ...cleaned, ...signed }])
    const ciOnly = await write(2, { ...signed, deliveryMode: 'poll' })
    expect(ciOnly.status).toBe(200)
    expect((await ciOnly.json()).settings.github.repositories).toEqual([
      { ...cleaned, deliveryMode: 'poll', ciWebhookSecretRef: 'ci_webhook_build' },
    ])
  })
})

test('mandate routes share the control plane guard and body limit, and expose paged records, preview and independent document checks', async () => {
  const store = new TriggerStore(':memory:')
  try {
    let probed = 0
    let wakes = 0
    const mandates = createMandateService({
      store,
      listTargets: () => [],
      listArchiveChannels: () => ['feishu-test'],
      probeArchive: async () => {
        probed++
        return { ok: false, reason: 'private provider data' }
      },
      runtime: {
        wakeDeferred() {
          wakes++
        },
        retry() {
          return false
        },
        preview() {
          return { decision: { destination: 'web', reason: '模拟' }, archive: null }
        },
      },
    })
    const { req } = fixture(mandates)
    const call = (path: string, method = 'GET', body?: unknown) =>
      req(`mandates/${path}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    for (const [method, path] of [
      ['GET', 'tasks'],
      ['PUT', 'config'],
      ['POST', 'documents/verify'],
      ['POST', 'preview'],
      ['GET', 'audit'],
      ['POST', 'records/1/retry'],
      ['GET', 'targets'],
    ]) {
      expect((await req(`mandates/${path}`, { method }, '10.0.0.2')).status).toBe(403)
      expect(
        (await req(`mandates/${path}`, { method, headers: { Origin: 'https://outside.example' } }))
          .status,
      ).toBe(403)
    }
    expect((await call('config', 'PUT', { junk: 'x'.repeat(520 * 1024) })).status).toBe(413)
    expect((await call('config', 'PUT')).status).toBe(415)
    expect((await call('tasks?limit=999')).status).toBe(400)
    expect((await call('audit?beforeId=1.5')).status).toBe(400)
    expect((await call('records?inboxId=0')).status).toBe(400)
    expect((await call('tasks/1')).status).toBe(404)
    expect((await call('tasks/1/pause', 'PUT', { paused: 'no' })).status).toBe(400)
    expect((await call('records/1/retry', 'POST', { kind: 'unsafe' })).status).toBe(400)
    expect((await call('records/1/retry', 'POST', { kind: 'notify' })).status).toBe(404)
    expect(
      (
        await call('preview', 'POST', {
          mandateId: 'none',
          at: '2026-01-01T00:00:00Z',
          present: null,
        })
      ).status,
    ).toBe(404)
    expect(
      (await call('documents/verify', 'POST', { channelId: 'other', documentId: 'selected' }))
        .status,
    ).toBe(400)
    const doc = await call('documents/verify', 'POST', {
      channelId: 'feishu-test',
      documentId: 'selected',
    })
    expect(doc.status).toBe(200)
    expect(await doc.json()).toEqual({ writable: false })
    expect(probed).toBe(1)
    expect(wakes).toBe(0)
    const config = {
      revision: 0,
      settings: { projects: [{ id: 'p', name: '发布', policy: { offDay: 'none' } }], mandates: [] },
    }
    expect((await call('config', 'PUT', config)).status).toBe(200)
    expect((await call('config', 'PUT', config)).status).toBe(409)
    expect(await (await call('config')).json()).toEqual({ ...config, revision: 1 })
    expect(wakes).toBe(1)
    expect(await (await call('records?inboxId=1')).json()).toEqual({ items: [] })
    expect(await (await call('tasks')).json()).toEqual({ items: [] })
    expect((await (await call('audit')).json()).items).toHaveLength(1)
  } finally {
    store.close()
  }
})

test('source updates validate and forward an optional mandate version without changing older callers', async () => {
  const { put, settings, getMandateRevision } = fixture()
  for (const expectedMandateRevision of [-1, 0.5, '1', null]) {
    expect((await put({ revision: 0, settings, expectedMandateRevision })).status).toBe(400)
  }
  expect((await put({ revision: 0, settings, expectedMandateRevision: 12 })).status).toBe(200)
  expect(getMandateRevision()).toBe(12)
  expect((await put({ revision: 1, settings })).status).toBe(200)
  expect(getMandateRevision()).toBeUndefined()
})
