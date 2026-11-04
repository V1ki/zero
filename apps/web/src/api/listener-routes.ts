import { isIP } from 'node:net'
import { isTriggerCalendarDate, isTriggerRetentionDays } from '@zero-os/shared'
import { TriggerSettingsConflictError, triggerWebhookSecretPatterns } from '@zero-os/shared'
import type {
  TriggerGithubRepository,
  TriggerRoutingSettingsSnapshot,
  TriggerSettingsSnapshot,
  TriggerWxarcSession,
} from '@zero-os/shared'
import { type Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import type { ZeroOS } from '../../../server/src/main'
import {
  RouterWorkspaceError,
  type RouterWorkspaceService,
} from '../../../server/src/triggers/router-workspace'

import { MandateInputError } from '../../../server/src/triggers/mandate-input'
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
  version,
} from './listener-input'
import { createMandateRoutes } from './mandate-routes'
type ListenerService = Pick<
  ZeroOS['listeners'],
  | 'getSettings'
  | 'saveSettings'
  | 'getStatus'
  | 'listInbox'
  | 'listGithubRepositories'
  | 'checkGithubPermissions'
  | 'listWxarcSessions'
  | 'scan'
> & {
  webNotifications: Pick<ZeroOS['listeners']['webNotifications'], 'list' | 'latestId' | 'subscribe'>
  mandates?: MandateService
  workspace: Pick<RouterWorkspaceService, 'get' | 'message' | 'action' | 'listEvents'> &
    Partial<Pick<RouterWorkspaceService, 'commission'>>
  routing: Pick<
    ZeroOS['listeners']['routing'],
    | 'getConfig'
    | 'saveConfig'
    | 'listTargets'
    | 'listRoutes'
    | 'listWeb'
    | 'latestWebDeliveryId'
    | 'heartbeat'
    | 'process'
  >
}
const credentialPattern = /^github_listener(?:_[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?$/
const repoPattern = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i
const mentionPattern = /^[a-z\d][a-z\d-]{0,38}(?:\[bot\])?$/i

function loopback(address: string) {
  const ip = address.replace(/^::ffff:/i, '')
  return address === '::1' || (isIP(ip) === 4 && ip.startsWith('127.'))
}

function isLocalRequest(c: Context<ListenerEnv>) {
  if (!loopback(c.env?.remoteAddress ?? '')) return false
  const url = new URL(c.req.url)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false
  const host = c.req.header('Host')
  if (host && host.toLowerCase() !== url.host) return false
  const forwardedFor = c.req.header('X-Forwarded-For')
  if (forwardedFor && !forwardedFor.split(',').every((ip) => loopback(ip.trim()))) return false
  const forwardedHost = c.req.header('X-Forwarded-Host')
  if (c.req.header('Forwarded') || (forwardedHost && forwardedHost.toLowerCase() !== url.host))
    return false
  const origin = c.req.header('Origin')
  const site = c.req.header('Sec-Fetch-Site')
  return (!origin || origin === url.origin) && (!site || site === 'same-origin' || site === 'none')
}

function credentialRef(value: unknown): string {
  const ref = fieldText(value, '凭证引用', 80)
  if (ref && !credentialPattern.test(ref)) badInput('请选择专用于 GitHub 监听的凭证引用。')
  return ref
}

function repositoryName(value: unknown): string {
  const name = fieldText(value, '仓库名称', 148, true)
  if (!repoPattern.test(name) || ['.', '..'].includes(name.split('/')[1]))
    badInput('仓库名称格式应为 owner/repo。')
  return name
}

function webhookRef(value: unknown, provider: keyof typeof triggerWebhookSecretPatterns) {
  if (value === undefined) return undefined
  const ref = fieldText(value, '推送密钥引用', 80)
  if (ref && !triggerWebhookSecretPatterns[provider].test(ref)) {
    badInput(`请选择专用于 ${provider === 'ci' ? 'CI' : 'GitHub'} 推送的密钥引用。`)
  }
  return ref || undefined
}

function parseRepository(raw: unknown): TriggerGithubRepository {
  const repo = fields(raw, [
    'name',
    'enabled',
    'workflowFailures',
    'branch',
    'workflow',
    'mention',
    'deliveryMode',
    'webhookSecretRef',
    'ciWebhookSecretRef',
  ])
  const enteredMention = fieldText(repo.mention, '提及账号', 64)
  const mention = enteredMention.replace(/^@/, '')
  if (enteredMention && !mentionPattern.test(mention)) badInput('GitHub 提及账号无效。')
  const workflowFailures = checked(repo.workflowFailures)
  if (!workflowFailures && !mention) badInput('每个仓库至少需要一种监听条件。')
  const mode =
    repo.deliveryMode === undefined
      ? undefined
      : choice(repo.deliveryMode, ['poll', 'webhook'], 'GitHub 接收方式')
  const webhookSecretRef = webhookRef(repo.webhookSecretRef, 'github')
  const ciWebhookSecretRef = webhookRef(repo.ciWebhookSecretRef, 'ci')
  if (mode === 'webhook' && !webhookSecretRef) badInput('GitHub 推送需要配置签名密钥名称。')
  if (ciWebhookSecretRef && !workflowFailures) badInput('接收 CI 推送需要启用工作流失败监听。')
  return {
    name: repositoryName(repo.name),
    enabled: checked(repo.enabled),
    workflowFailures,
    branch: fieldText(repo.branch, '分支', 255),
    workflow: fieldText(repo.workflow, '工作流', 255),
    mention,
    ...(mode && { deliveryMode: mode }),
    ...(mode === 'webhook' && { webhookSecretRef }),
    ...(ciWebhookSecretRef && { ciWebhookSecretRef }),
  }
}

function parseSession(raw: unknown): TriggerWxarcSession {
  const session = fields(raw, ['id', 'name', 'enabled', 'keyword'])
  return {
    id: fieldText(session.id, '会话标识', 256, true),
    name: fieldText(session.name, '会话名称', 256, true),
    enabled: checked(session.enabled),
    keyword: fieldText(session.keyword, '关键词', 256),
  }
}

function parseSettings(
  raw: unknown,
): TriggerSettingsSnapshot & { githubLookbackHours?: 1 | 24; expectedMandateRevision?: number } {
  const data = fields(raw, [
    'revision',
    'settings',
    'githubLookbackHours',
    'expectedMandateRevision',
  ])
  const revision = version(data.revision)
  if (
    data.githubLookbackHours !== undefined &&
    data.githubLookbackHours !== 1 &&
    data.githubLookbackHours !== 24
  )
    badInput('GitHub 回看范围只能为 1 或 24 小时。')
  const settings = fields(data.settings, ['github', 'wxarc'])
  const github = fields(settings.github, ['credentialRef', 'repositories'])
  const wxarc = fields(settings.wxarc, ['sessions'])
  if (
    !Array.isArray(github.repositories) ||
    github.repositories.length > 100 ||
    !Array.isArray(wxarc.sessions) ||
    wxarc.sessions.length > 500
  )
    badInput('监听列表格式或数量无效。')
  const repositories = github.repositories.map(parseRepository)
  const sessions = wxarc.sessions.map(parseSession)
  if (
    new Set(repositories.map((r) => r.name.toLowerCase())).size !== repositories.length ||
    new Set(sessions.map((s) => s.id)).size !== sessions.length
  )
    badInput('监听范围不能重复。')
  return {
    revision,
    githubLookbackHours: data.githubLookbackHours,
    expectedMandateRevision:
      data.expectedMandateRevision === undefined
        ? undefined
        : version(data.expectedMandateRevision),
    settings: {
      github: { credentialRef: credentialRef(github.credentialRef), repositories },
      wxarc: { sessions },
    },
  }
}

function parseCalendarDates(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    badInput('工作日历例外格式无效。')
  const entries = Object.entries(value)
  if (entries.length > 366) badInput('最多可配置 366 个日期例外。')
  const dates: Record<string, 'work' | 'off'> = {}
  for (const [date, kind] of entries) {
    if (!isTriggerCalendarDate(date)) badInput('请输入有效的日历日期。')
    dates[date] = choice(kind, ['work', 'off'], '日历例外类型')
  }
  return dates
}

function parseNativePresence(value: unknown) {
  const values = fields(value, ['enabled', 'idleMinutes', 'bluetooth'])
  const minutes = values.idleMinutes
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 120)
    badInput('Mac 空闲时长须为 1 到 120 分钟。')
  return {
    enabled: checked(values.enabled),
    idleMinutes: minutes,
    bluetooth: checked(values.bluetooth),
  }
}

function parseRouting(raw: unknown): TriggerRoutingSettingsSnapshot {
  const data = fields(raw, ['revision', 'settings'])
  const settings = fields(data.settings, [
    'enabled',
    'timeZone',
    'workdays',
    'dateOverrides',
    'nativePresence',
    'retentionDays',
    'workStart',
    'workEnd',
    'presence',
    'awayFallback',
    'duringWork',
    'afterWork',
    'offDay',
    'weixinTarget',
  ])
  const retentionDays = settings.retentionDays
  if (
    retentionDays !== undefined &&
    retentionDays !== null &&
    !isTriggerRetentionDays(retentionDays)
  )
    badInput('正文保留期限可选 7、30、90 或 365 天。')
  const timeZone = fieldText(settings.timeZone, '时区', 100, true)
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timeZone)) badInput('时区无效。')
  try {
    new Intl.DateTimeFormat('en', { timeZone })
  } catch (err) {
    if (err instanceof RangeError) badInput('时区无效。')
    throw err
  }
  const workdays = settings.workdays
  if (
    !Array.isArray(workdays) ||
    workdays.length > 7 ||
    !workdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) ||
    new Set(workdays).size !== workdays.length
  )
    badInput('工作日必须是互不重复的 0 到 6。')
  const workStart = fieldText(settings.workStart, '上班时间', 5)
  const workEnd = fieldText(settings.workEnd, '下班时间', 5)
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/
  if (!clock.test(workStart) || !clock.test(workEnd) || workStart === workEnd)
    badInput('请输入两个不同的有效时间（HH:mm）。')
  const target =
    settings.weixinTarget === null ? null : fields(settings.weixinTarget, ['channelId', 'peerId'])
  const destinations = ['web', 'weixin', 'defer'] as const
  return {
    revision: version(data.revision),
    settings: {
      enabled: checked(settings.enabled),
      ...(retentionDays !== undefined && { retentionDays }),
      timeZone,
      workdays,
      workStart,
      workEnd,
      ...(settings.dateOverrides !== undefined && {
        dateOverrides: parseCalendarDates(settings.dateOverrides),
      }),
      ...(settings.nativePresence !== undefined && {
        nativePresence: parseNativePresence(settings.nativePresence),
      }),
      presence: choice(settings.presence, ['auto', 'present', 'away'], '在场模式'),
      awayFallback: choice(settings.awayFallback, ['weixin', 'defer'], '离席处理方式'),
      duringWork: choice(settings.duringWork, destinations, '工作时段目的地'),
      afterWork: choice(settings.afterWork, destinations, '下班时段目的地'),
      offDay: choice(settings.offDay, destinations, '非工作日目的地'),
      weixinTarget: target && {
        channelId: fieldText(target.channelId, '微信通道', 256, true),
        peerId: fieldText(target.peerId, '微信目标', 256, true),
      },
    },
  }
}

function workspaceScope(raw: string) {
  if (raw === 'general') return raw
  if (/^task-[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw.slice(5))))
    return raw as `task-${number}`
  const id = Number(raw)
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(id))
    badInput('请选择有效的 Router 对话或收件箱事件。')
  return id
}

function workspaceRequest(value: Record<string, unknown>) {
  if (
    typeof value.requestId !== 'string' ||
    !/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value.requestId)
  )
    badInput('请求标识无效。')
  return {
    requestId: value.requestId.toLowerCase(),
    retry: value.retry === undefined ? false : checked(value.retry),
  }
}

export function createListenerRoutes(service: ListenerService) {
  const app = new Hono<ListenerEnv>()
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
    if (err instanceof MandateInputError) return c.json({ error: err.message }, err.status)
    if (err instanceof RouterWorkspaceError) return c.json({ error: err.message }, err.status)
    if (err instanceof TriggerSettingsConflictError)
      return c.json({ error: '配置已被更新，请重新加载。' }, 409)
    // Discovery may fail with raw provider errors or chat metadata. Only expose a safe diagnostic.
    if (c.req.path.endsWith('/github/repositories')) {
      return c.json(
        { error: '无法读取 GitHub 仓库，请检查仓库名称、网络及监听凭证的读取权限。' },
        502,
      )
    }
    if (c.req.path.endsWith('/github/permissions')) {
      return c.json({ error: '无法检查读取权限，请核对已保存的 GitHub 监听凭证及网络连接。' }, 502)
    }
    if (c.req.path.endsWith('/wxarc/sessions')) {
      return c.json({ error: '无法读取微信会话，请确认本机 WXARC 监听服务已启动。' }, 502)
    }
    return c.json({ error: '监听服务未能完成请求。请查看本机服务状态。' }, 500)
  })
  return app
    .use('*', async (c, next) => {
      c.header('Cache-Control', 'no-store')
      c.header('Cross-Origin-Resource-Policy', 'same-origin')
      c.header('X-Content-Type-Options', 'nosniff')
      if (!isLocalRequest(c)) return c.json({ error: '仅允许来自本机 ZeRo 页面的请求。' }, 403)
      if (c.req.method === 'OPTIONS') return c.body(null, 405)
      await next()
    })
    .use(
      '*',
      bodyLimit({ maxSize: 512 * 1024, onError: (c) => c.json({ error: '配置过大。' }, 413) }),
    )
    .route('/mandates', createMandateRoutes(service.mandates))
    .get('/config', (c) => c.json(service.getSettings()))
    .put('/config', async (c) => {
      const { settings, revision, githubLookbackHours, expectedMandateRevision } = parseSettings(
        await requestJson(c),
      )
      return c.json(
        await service.saveSettings(
          settings,
          revision,
          githubLookbackHours,
          expectedMandateRevision,
        ),
      )
    })
    .get('/status', (c) => c.json({ statuses: service.getStatus() }))
    .get('/commission-grants', async (c) => {
      const serviceForGrants = service.workspace.commission
      if (!serviceForGrants) throw new HTTPException(503, { message: '委托对话服务不可用。' })
      return c.json(await serviceForGrants.grants())
    })
    .put('/commission-grants', async (c) => {
      const serviceForGrants = service.workspace.commission
      if (!serviceForGrants) throw new HTTPException(503, { message: '委托对话服务不可用。' })
      return c.json(await serviceForGrants.saveGrants(await requestJson(c)))
    })
    .get('/workspace-events', (c) =>
      c.json({
        items: service.workspace.listEvents(
          pageNumber(c.req.query('limit'), 100) ?? 30,
          pageNumber(c.req.query('beforeId'), Number.MAX_SAFE_INTEGER),
        ),
      }),
    )
    .get('/workspace/:scope', (c) =>
      c.json(service.workspace.get(workspaceScope(c.req.param('scope')))),
    )
    .post('/workspace/:scope/messages', async (c) => {
      const scope = workspaceScope(c.req.param('scope'))
      const body = fields(await requestJson(c), ['requestId', 'text', 'retry'])
      const { requestId, retry } = workspaceRequest(body)
      if (
        typeof body.text !== 'string' ||
        body.text.length > 2000 ||
        !body.text.trim() ||
        /\p{Cc}/u.test(body.text.replace(/[\t\r\n]/g, ''))
      )
        badInput('请输入 1 到 2000 个字的提问。')
      return c.json(await service.workspace.message(scope, requestId, body.text.trim(), retry))
    })
    .post('/workspace/:scope/actions', async (c) => {
      const scope = workspaceScope(c.req.param('scope'))
      const body = fields(await requestJson(c), ['requestId', 'action', 'retry'])
      const { requestId, retry } = workspaceRequest(body)
      return c.json(await service.workspace.action(scope, requestId, body.action, retry))
    })
    .get('/routing/config', (c) => c.json(service.routing.getConfig()))
    .put('/routing/config', async (c) => {
      const { settings, revision } = parseRouting(await requestJson(c))
      const { settings: previous, revision: currentRevision } = service.routing.getConfig()
      if (revision !== currentRevision) throw new TriggerSettingsConflictError()
      const target = settings.weixinTarget
      if (
        target &&
        (target.channelId !== previous.weixinTarget?.channelId ||
          target.peerId !== previous.weixinTarget?.peerId)
      ) {
        const available = await service.routing.listTargets()
        if (
          !available.some(
            ({ channelId, peerId }) => channelId === target.channelId && peerId === target.peerId,
          )
        )
          badInput('请选择已绑定且可用的微信目标。')
      }
      return c.json(await service.routing.saveConfig(settings, revision))
    })
    .get('/routing/targets', async (c) => {
      const targets = await service.routing.listTargets()
      return c.json({
        targets: targets.map(({ channelId, peerId, label }) => ({ channelId, peerId, label })),
      })
    })
    .get('/routing/records', (c) =>
      c.json({ records: service.routing.listRoutes(pageNumber(c.req.query('limit'), 100) ?? 50) }),
    )
    .get('/routing/web', (c) =>
      c.json({ records: service.routing.listWeb(pageNumber(c.req.query('limit'), 100) ?? 30) }),
    )
    .get('/routing/web/latest', (c) => c.json({ latestId: service.routing.latestWebDeliveryId() }))
    .get('/web-notifications/latest', (c) => c.json({ id: service.webNotifications.latestId() }))
    .get('/web-notifications/changes', (c) => {
      // This loopback-only stream carries no content or identifiers. Readers fetch their own cursor.
      const signal = c.req.raw.signal
      const encoder = new TextEncoder()
      const changed = encoder.encode('data: changed\n\n')
      const heartbeat = encoder.encode(': keepalive\n\n')
      let cleanup = () => {}
      let flush = () => {}
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let pending = true
          flush = () => {
            if (pending && (controller.desiredSize ?? 0) > 0) {
              pending = false
              controller.enqueue(changed)
            }
          }
          const unsubscribe = service.webNotifications.subscribe(() => {
            pending = true
            flush()
          })
          const timer = setInterval(() => {
            if ((controller.desiredSize ?? 0) > 0) controller.enqueue(heartbeat)
          }, 5_000)
          timer.unref?.()
          const close = () => {
            cleanup()
            controller.close()
          }
          cleanup = () => {
            clearInterval(timer)
            unsubscribe()
            signal.removeEventListener('abort', close)
          }
          if (signal.aborted) close()
          else {
            signal.addEventListener('abort', close, { once: true })
            flush()
          }
        },
        pull() {
          flush()
        },
        cancel() {
          cleanup()
        },
      })
      return c.body(body, 200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' })
    })
    .get('/web-notifications', (c) => {
      const query = c.req.query()
      if (query.after !== undefined && query.before !== undefined) badInput('请选择一个分页方向。')
      if (query.brief !== undefined && query.brief !== '1') badInput('简要视图参数无效。')
      return c.json(
        service.webNotifications.list({
          after: query.after === '0' ? 0 : pageNumber(query.after, Number.MAX_SAFE_INTEGER),
          before: pageNumber(query.before, Number.MAX_SAFE_INTEGER),
          limit: pageNumber(query.limit, 100),
          brief: query.brief === '1',
        }),
      )
    })
    .post('/routing/presence', async (c) => {
      fields(await requestJson(c), [])
      await service.routing.heartbeat()
      return c.body(null, 204)
    })
    .post('/routing/process', async (c) => {
      const { inboxId } = fields(await requestJson(c), ['inboxId'])
      if (typeof inboxId !== 'number' || !Number.isSafeInteger(inboxId) || inboxId < 1)
        badInput('收件箱编号无效。')
      const result = await service.routing.process(inboxId)
      if (result === 'not_found') return c.json({ error: '收件箱事件不存在。' }, 404)
      if (result === 'disabled') return c.json({ error: '请先启用路由。' }, 409)
      if (result === 'already_processed') return c.json({ accepted: false })
      return c.json({ accepted: true }, 202)
    })
    .get('/inbox', (c) =>
      c.json({
        items: service.listInbox(
          pageNumber(c.req.query('limit'), 100),
          pageNumber(c.req.query('beforeId'), Number.MAX_SAFE_INTEGER),
        ),
      }),
    )
    .get('/github/repositories', async (c) => {
      const ref = credentialRef(c.req.query('credentialRef') ?? '')
      const name = c.req.query('name')
      const repositories = await service.listGithubRepositories(
        c.req.raw.signal,
        ref,
        name ? repositoryName(name) : undefined,
      )
      return c.json({ repositories })
    })
    .post('/github/permissions', async (c) => {
      const input = fields(await requestJson(c), [
        'name',
        'credentialRef',
        'workflowFailures',
        'prComments',
        'prBase',
      ])
      const name = repositoryName(input.name)
      const ref = credentialRef(input.credentialRef)
      const selection = {
        workflowFailures: checked(input.workflowFailures),
        prComments: checked(input.prComments),
        prBase: checked(input.prBase),
      }
      if (!selection.workflowFailures && !selection.prComments)
        badInput('请先选择要检查的仓库监听条件。')
      if (selection.prBase && !selection.prComments) badInput('目标分支检查需要启用 PR 评论规则。')
      return c.json(await service.checkGithubPermissions(name, ref, selection, c.req.raw.signal))
    })
    .get('/wxarc/sessions', async (c) => {
      const sessions = await service.listWxarcSessions(c.req.raw.signal)
      return c.json({ sessions })
    })
    .post('/scan', async (c) => {
      fields(await requestJson(c), [])
      await service.scan()
      return c.json({ ok: true }, 202)
    })
}
