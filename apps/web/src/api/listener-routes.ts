import { isIP } from 'node:net'
import { TriggerSettingsConflictError } from '@zero-os/shared'
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

type ListenerEnv = { Bindings: { remoteAddress?: string } }
type ListenerService = Pick<
  ZeroOS['listeners'],
  | 'getSettings'
  | 'saveSettings'
  | 'getStatus'
  | 'listInbox'
  | 'listGithubRepositories'
  | 'listWxarcSessions'
  | 'scan'
> & {
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

function badInput(message: string): never {
  throw new HTTPException(400, { message })
}

function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    badInput('配置包含未知字段或对象格式无效。')
  }
  return value as Record<string, unknown>
}

function fieldText(value: unknown, label: string, maxLength: number, required = false): string {
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    /\p{Cc}/u.test(value) ||
    (required && !value.trim())
  )
    badInput(`${label}无效。`)
  return value.trim()
}

function checked(value: unknown): boolean {
  if (typeof value !== 'boolean') badInput('开关值无效。')
  return value
}

function version(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    badInput('配置版本无效。')
  return value
}

function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  return choices.find((option) => value === option) ?? badInput(`${label}无效。`)
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

function parseRepository(raw: unknown): TriggerGithubRepository {
  const repo = fields(raw, ['name', 'enabled', 'workflowFailures', 'branch', 'workflow', 'mention'])
  const enteredMention = fieldText(repo.mention, '提及账号', 64)
  const mention = enteredMention.replace(/^@/, '')
  if (enteredMention && !mentionPattern.test(mention)) badInput('GitHub 提及账号无效。')
  const workflowFailures = checked(repo.workflowFailures)
  if (!workflowFailures && !mention) badInput('每个仓库至少需要一种监听条件。')
  return {
    name: repositoryName(repo.name),
    enabled: checked(repo.enabled),
    workflowFailures,
    branch: fieldText(repo.branch, '分支', 255),
    workflow: fieldText(repo.workflow, '工作流', 255),
    mention,
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

function parseSettings(raw: unknown): TriggerSettingsSnapshot & { githubLookbackHours?: 1 | 24 } {
  const data = fields(raw, ['revision', 'settings', 'githubLookbackHours'])
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
    settings: {
      github: { credentialRef: credentialRef(github.credentialRef), repositories },
      wxarc: { sessions },
    },
  }
}

function parseRouting(raw: unknown): TriggerRoutingSettingsSnapshot {
  const data = fields(raw, ['revision', 'settings'])
  const settings = fields(data.settings, [
    'enabled',
    'timeZone',
    'workdays',
    'workStart',
    'workEnd',
    'presence',
    'awayFallback',
    'duringWork',
    'afterWork',
    'offDay',
    'weixinTarget',
  ])
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
      timeZone,
      workdays,
      workStart,
      workEnd,
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

async function requestJson(c: Context<ListenerEnv>): Promise<unknown> {
  if (c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HTTPException(415, { message: '此操作需要 application/json。' })
  }
  try {
    return await c.req.json()
  } catch (err) {
    if (err instanceof SyntaxError) badInput('JSON 格式无效。')
    throw err
  }
}

function pageNumber(raw: string | undefined, max: number): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value > max)
    badInput('分页参数无效。')
  return value
}

export function createListenerRoutes(service: ListenerService) {
  const app = new Hono<ListenerEnv>()
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
    if (err instanceof TriggerSettingsConflictError)
      return c.json({ error: '配置已被更新，请重新加载。' }, 409)
    // Discovery may fail with raw provider errors or chat metadata. Only expose a safe diagnostic.
    if (c.req.path.endsWith('/github/repositories')) {
      return c.json(
        { error: '无法读取 GitHub 仓库，请检查仓库名称、网络及监听凭证的读取权限。' },
        502,
      )
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
    .get('/config', (c) => c.json(service.getSettings()))
    .put('/config', async (c) => {
      const { settings, revision, githubLookbackHours } = parseSettings(await requestJson(c))
      return c.json(await service.saveSettings(settings, revision, githubLookbackHours))
    })
    .get('/status', (c) => c.json({ statuses: service.getStatus() }))
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
