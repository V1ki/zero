import { isIP } from 'node:net'
import {
  botRoutingPreferences,
  getTriggerRouteBot,
  isTriggerCalendarDate,
  isTriggerRetentionDays,
  sameTriggerRouteTarget,
  triggerGithubAppRefPattern,
  triggerRoutePlatforms,
} from '@zero-os/shared'
import { TriggerSettingsConflictError, triggerWebhookSecretPatterns } from '@zero-os/shared'
import type {
  CommissionOperator,
  TriggerGithubRepository,
  TriggerRoutingSettings,
  TriggerRoutingSettingsSnapshot,
  TriggerSettingsSnapshot,
  TriggerWxarcSession,
} from '@zero-os/shared'
import { type Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import type { ZeroOS } from '../../../server/src/main'
import {
  GithubReplyError,
  type RouterGithubReplies,
} from '../../../server/src/triggers/router-github-reply'
import {
  RouterWorkspaceError,
  type RouterWorkspaceService,
} from '../../../server/src/triggers/router-workspace'

import { MandateInputError, parseMandateTarget } from '../../../server/src/triggers/mandate-input'
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
  | 'listTrackingResults'
  | 'listGithubRepositories'
  | 'checkGithubPermissions'
  | 'listWxarcSessions'
  | 'scan'
> & {
  githubReplies?: Pick<RouterGithubReplies, 'preview' | 'send'>
  webNotifications: Pick<ZeroOS['listeners']['webNotifications'], 'list' | 'latestId' | 'subscribe'>
  mandates?: MandateService
  workspace: Pick<RouterWorkspaceService, 'get' | 'message' | 'action' | 'listEvents'> &
    Partial<
      Pick<
        RouterWorkspaceService,
        | 'traces'
        | 'expiredTraceSources'
        | 'replayTrace'
        | 'documents'
        | 'listMatters'
        | 'listPublications'
        | 'webPublicationAction'
      >
    > &
    Partial<Pick<RouterWorkspaceService, 'commission' | 'ownerIdentity'>>
  routing: Pick<
    ZeroOS['listeners']['routing'],
    | 'getConfig'
    | 'saveConfig'
    | 'listTargets'
    | 'listPersonalTargets'
    | 'isSelectedDirectTarget'
    | 'listPersonalBots'
    | 'getBotBindings'
    | 'saveBotBinding'
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

function parseRepository(
  raw: unknown,
  previous: TriggerGithubRepository[],
): TriggerGithubRepository {
  const repo = fields(raw, [
    'name',
    'enabled',
    'githubAppRef',
    'ownerMentionReplies',
    'ownerMentionRepliesSince',
    'closeResolvedDuplicates',
    'closeResolvedDuplicatesSince',
    'allowOwnerIssueClose',
    'allowOwnerIssueCloseSince',
    'workflowFailures',
    'issues',
    'pullRequests',
    'issueComments',
    'pullRequestComments',
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
  const name = repositoryName(repo.name)
  const prior = previous.find((r) => r.name.toLowerCase() === name.toLowerCase())
  const githubAppRef =
    repo.githubAppRef === undefined
      ? prior?.githubAppRef
      : fieldText(repo.githubAppRef, 'GitHub App 凭证引用', 80)
  if (githubAppRef && !triggerGithubAppRefPattern.test(githubAppRef))
    badInput('请使用 github_app_ 开头的 GitHub App 专用凭证引用。')
  const issues = repo.issues === undefined ? prior?.issues : checked(repo.issues)
  const pullRequests =
    repo.pullRequests === undefined ? prior?.pullRequests : checked(repo.pullRequests)
  const issueComments =
    repo.issueComments === undefined ? prior?.issueComments : checked(repo.issueComments)
  const pullRequestComments =
    repo.pullRequestComments === undefined
      ? prior?.pullRequestComments
      : checked(repo.pullRequestComments)
  const enabled = checked(repo.enabled)
  function writeGrant(
    field: 'ownerMentionReplies' | 'closeResolvedDuplicates' | 'allowOwnerIssueClose',
    listens: boolean,
    requirement: string,
  ) {
    const timestamp = `${field}Since` as const
    if (repo[timestamp] !== undefined && repo[timestamp] !== prior?.[timestamp])
      badInput('授权生效时间由服务端记录。')
    const eligible = enabled && !!githubAppRef && listens
    const requested =
      repo[field] === undefined
        ? eligible && prior?.githubAppRef === githubAppRef && prior?.[field]
        : checked(repo[field])
    if (requested && !eligible) badInput(requirement)
    if (requested && prior?.[field] && prior.githubAppRef !== githubAppRef)
      badInput('请先关闭原机器人的授权，再为新的 GitHub App 开启。')
    return requested
  }
  const ownerMentionReplies = writeGrant(
    'ownerMentionReplies',
    !!(issueComments || pullRequestComments),
    '自动回复需要先启用仓库监听、绑定 GitHub App 并监听 Issue 或 PR 普通评论。',
  )
  const closeResolvedDuplicates = writeGrant(
    'closeResolvedDuplicates',
    !!issues,
    '自动关闭重复 Issue 需要启用仓库监听、绑定 GitHub App 并监听 Issue 状态变化。',
  )
  const allowOwnerIssueClose = writeGrant(
    'allowOwnerIssueClose',
    !!issueComments,
    '允许仓主点名关闭 Issue 需要启用仓库监听、绑定 GitHub App 并监听 Issue 普通评论。',
  )
  if (
    !workflowFailures &&
    !mention &&
    !issues &&
    !pullRequests &&
    !issueComments &&
    !pullRequestComments
  )
    badInput('每个仓库至少需要一种监听条件。')
  const mode =
    repo.deliveryMode === undefined
      ? undefined
      : choice(repo.deliveryMode, ['poll', 'webhook'], 'GitHub 接收方式')
  const webhookSecretRef = webhookRef(repo.webhookSecretRef, 'github')
  const ciWebhookSecretRef = webhookRef(repo.ciWebhookSecretRef, 'ci')
  if (mode === 'webhook' && !webhookSecretRef) badInput('GitHub 推送需要配置签名密钥名称。')
  if (ciWebhookSecretRef && !workflowFailures) badInput('接收 CI 推送需要启用工作流失败监听。')
  return {
    name,
    ...(githubAppRef && { githubAppRef }),
    ...(ownerMentionReplies && { ownerMentionReplies: true }),
    ...(closeResolvedDuplicates && { closeResolvedDuplicates: true }),
    ...(allowOwnerIssueClose && { allowOwnerIssueClose: true }),
    ...(issues !== undefined && { issues }),
    ...(pullRequests !== undefined && { pullRequests }),
    ...(issueComments !== undefined && { issueComments }),
    ...(pullRequestComments !== undefined && { pullRequestComments }),
    enabled,
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

function parseGithubOperators(raw: unknown): CommissionOperator[] {
  if (!Array.isArray(raw) || raw.length > triggerRoutePlatforms.length)
    badInput('每个平台最多授权一个 Router 机器人。')
  const operators = raw.map((row) => {
    const target = parseMandateTarget(row)
    if (!target.operatorId) badInput('缺少机器人私聊身份，请刷新后重试。')
    return { ...target, operatorId: target.operatorId }
  })
  if (new Set(operators.map((t) => t.platform)).size !== operators.length)
    badInput('同一平台不能重复授权。')
  return operators
}

function parseSettings(
  raw: unknown,
  previous: TriggerGithubRepository[],
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
  const github = fields(settings.github, [
    'credentialRef',
    'repositories',
    'routerOperators',
    'routerTrackingEnabled',
  ])
  const wxarc = fields(settings.wxarc, ['sessions'])
  if (
    !Array.isArray(github.repositories) ||
    github.repositories.length > 100 ||
    !Array.isArray(wxarc.sessions) ||
    wxarc.sessions.length > 500
  )
    badInput('监听列表格式或数量无效。')
  const repositories = github.repositories.map((repo) => parseRepository(repo, previous))
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
      github: {
        credentialRef: credentialRef(github.credentialRef),
        repositories,
        ...(github.routerOperators !== undefined && {
          routerOperators: parseGithubOperators(github.routerOperators),
        }),
        ...(github.routerTrackingEnabled !== undefined && {
          routerTrackingEnabled: checked(github.routerTrackingEnabled),
        }),
      },
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

function parsePersonalBots(raw: unknown) {
  const input = fields(raw, [...triggerRoutePlatforms])
  const result: NonNullable<TriggerRoutingSettings['personalBots']> = {}
  for (const platform of triggerRoutePlatforms) {
    if (platform in input)
      result[platform] =
        input[platform] === null ? null : fieldText(input[platform], '机器人账号', 256, true)
  }
  return result
}

function parseRouting(raw: unknown, botOnly: boolean): TriggerRoutingSettingsSnapshot {
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
    'notificationMode',
    'urgentDestination',
    'duringWork',
    'afterWork',
    'offDay',
    'weixinTarget',
    'personalBots',
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
  if (botOnly && settings.weixinTarget != null) badInput('请在渠道配置中设置投递地址。')
  const target =
    botOnly || settings.weixinTarget === null
      ? null
      : fields(settings.weixinTarget, ['channelId', 'peerId'])
  const destinations = ['web', ...triggerRoutePlatforms, 'defer'] as const
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
      awayFallback: choice(
        settings.awayFallback,
        [...triggerRoutePlatforms, 'defer'],
        '离席处理方式',
      ),
      ...(settings.notificationMode !== undefined && {
        notificationMode: choice(
          settings.notificationMode,
          ['all', 'contextual'] as const,
          '进展通知方式',
        ),
      }),
      ...(settings.urgentDestination !== undefined && {
        urgentDestination:
          settings.urgentDestination === null
            ? null
            : choice(settings.urgentDestination, destinations, '紧急提醒去向'),
      }),
      duringWork: choice(settings.duringWork, destinations, '工作时段目的地'),
      afterWork: choice(settings.afterWork, destinations, '下班时段目的地'),
      offDay: choice(settings.offDay, destinations, '非工作日目的地'),
      weixinTarget: target && {
        channelId: fieldText(target.channelId, '微信通道', 256, true),
        peerId: fieldText(target.peerId, '微信目标', 256, true),
      },
      ...('personalBots' in settings && { personalBots: parsePersonalBots(settings.personalBots) }),
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

function githubReplyScope(raw: string) {
  const scope = workspaceScope(raw)
  if (typeof scope !== 'number') badInput('请在对应的 GitHub 收件箱事件下回复。')
  return scope
}

export function createListenerRoutes(service: ListenerService) {
  const app = new Hono<ListenerEnv>()
  const preferences = ({ revision, settings }: TriggerRoutingSettingsSnapshot) => ({
    revision,
    settings: botRoutingPreferences(settings),
  })
  async function saveRouting(c: Context<ListenerEnv>, botOnly: boolean) {
    const { settings, revision } = parseRouting(await requestJson(c), botOnly)
    const { settings: previous, revision: currentRevision } = service.routing.getConfig()
    if (revision !== currentRevision) throw new TriggerSettingsConflictError()
    if (botOnly) settings.weixinTarget = previous.weixinTarget
    const legacy = settings.weixinTarget
    if (
      legacy &&
      (legacy.channelId !== previous.weixinTarget?.channelId ||
        legacy.peerId !== previous.weixinTarget?.peerId)
    ) {
      const available = await service.routing.listTargets()
      if (
        !available.some(
          (item) => item.channelId === legacy.channelId && item.peerId === legacy.peerId,
        )
      )
        badInput('请选择已绑定且可用的微信目标。')
    }
    const changed = triggerRoutePlatforms.filter(
      (platform) =>
        settings.personalBots?.[platform] != null &&
        settings.personalBots[platform] !== getTriggerRouteBot(previous, platform),
    )
    if (changed.length) {
      const bots = service.routing.listPersonalBots()
      for (const platform of changed) {
        if (
          !bots.some(
            (bot) =>
              bot.platform === platform && bot.channelId === settings.personalBots?.[platform],
          )
        )
          badInput('请选择已接入该平台的机器人。')
      }
    }
    const saved = await service.routing.saveConfig(settings, revision)
    return c.json(botOnly ? preferences(saved) : saved)
  }
  app.onError((err, c) => {
    if (err instanceof GithubReplyError)
      return c.json(
        { error: err.message, status: err.unknown ? 'unknown' : 'rejected' },
        err.httpStatus,
      )
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
      const input = await requestJson(c)
      const current = service.getSettings()
      const { settings, revision, githubLookbackHours, expectedMandateRevision } = parseSettings(
        input,
        current.settings.github.repositories,
      )
      if (current.revision !== revision) throw new TriggerSettingsConflictError()
      const previous = current.settings.github
      const github = settings.github
      const sameConnection = github.credentialRef === previous.credentialRef
      if (github.routerOperators === undefined && sameConnection && previous.routerOperators)
        github.routerOperators = previous.routerOperators
      if (github.routerOperators?.length) {
        if (!github.credentialRef) badInput('请先设置用于 Router 的 GitHub 只读凭证。')
        if (!sameConnection && previous.routerOperators?.length)
          badInput('请先保存新的 GitHub 连接，再为新连接授权机器人。')
        for (const operator of github.routerOperators) {
          const retained =
            sameConnection &&
            previous.routerOperators?.some((t) => sameTriggerRouteTarget(t, operator))
          if (!retained && !service.routing.isSelectedDirectTarget(operator))
            badInput('该机器人私聊身份已变更或不可用，请刷新并重新选择。')
        }
      }
      if (
        github.routerTrackingEnabled === undefined &&
        sameConnection &&
        previous.routerTrackingEnabled !== undefined
      )
        github.routerTrackingEnabled = previous.routerTrackingEnabled
      if (github.routerTrackingEnabled) {
        if (!github.credentialRef) badInput('请先配置 GitHub 连接，再开启 Router 仓库跟踪。')
        if (previous.credentialRef && !sameConnection)
          badInput('请先保存新的 GitHub 连接，再为它开启 Router 仓库跟踪。')
      }
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
    .get('/tracking-results', (c) =>
      c.json({
        items: service.listTrackingResults(
          pageNumber(c.req.query('limit'), 100) ?? 20,
          pageNumber(c.req.query('beforeId'), Number.MAX_SAFE_INTEGER),
        ),
      }),
    )
    .get('/router-documents', (c) =>
      c.json(service.workspace.documents?.list('router-owner') ?? []),
    )
    .post('/router-documents', async (c) => {
      if (!service.workspace.documents)
        throw new RouterWorkspaceError(503, '文档归档服务尚未就绪。')
      const body = fields(await requestJson(c), ['id', 'channelId', 'documentId', 'label', 'url'])
      return c.json(
        await service.workspace.documents.configure('router-owner', {
          id: fieldText(body.id, '目标标识', 80, true),
          channelId: fieldText(body.channelId, '机器人', 200, true),
          documentId: fieldText(body.documentId, '文档标识', 128, true),
          label: fieldText(body.label, '名称', 200, true),
          url: fieldText(body.url, '文档链接', 500, true),
        }),
      )
    })
    .get('/router-matters', (c) => c.json(service.workspace.listMatters?.(c.req.query('id')) ?? []))
    .get('/router-publications', (c) =>
      c.json(service.workspace.listPublications?.(c.req.query('id')) ?? []),
    )
    .post('/router-publications/:id/actions', async (c) => {
      if (!service.workspace.webPublicationAction)
        throw new RouterWorkspaceError(503, 'Router 交付服务未就绪。')
      const body = fields(await requestJson(c), ['actionId', 'requestId', 'gesture'])
      return c.json(
        service.workspace.webPublicationAction(
          fieldText(c.req.param('id'), '交付编号', 100, true),
          fieldText(body.actionId, '操作编号', 40, true),
          fieldText(body.requestId, '请求编号', 100, true),
          body.gesture,
        ),
      )
    })
    .get('/router-traces', (c) => {
      const traces = service.workspace.traces
      if (!traces) throw new HTTPException(503, { message: 'Router 轨迹尚未就绪。' })
      const before = c.req.query('before')
      if (before && (!/^[1-9]\d*$/.test(before) || !Number.isSafeInteger(Number(before))))
        badInput('无效的轨迹游标。')
      const dateFilter = (name: string) => {
        const value = c.req.query(name)
        if (!value) return undefined
        if (!Number.isFinite(Date.parse(value))) badInput('无效的轨迹时间。')
        return new Date(value).toISOString()
      }
      const status = c.req.query('status')
      if (status && !['running', 'completed', 'failed', 'interrupted'].includes(status))
        badInput('无效的轨迹状态。')
      const sessionId = c.req.query('sessionId')
      const eventId = pageNumber(c.req.query('eventId'), Number.MAX_SAFE_INTEGER)
      const workerId = pageNumber(c.req.query('workerId'), Number.MAX_SAFE_INTEGER)
      const expiredSources = service.workspace.expiredTraceSources?.(
        eventId ?? Number(/^router-event-(\d+)$/.exec(sessionId ?? '')?.[1]),
        workerId ?? Number(/^router-job-(\d+)$/.exec(sessionId ?? '')?.[1]),
      )
      return c.json({
        ...(expiredSources?.length && { expiredSources }),
        items: traces.listRuns({
          sessionId,
          matterId: c.req.query('matterId'),
          query: c.req.query('q'),
          runId: c.req.query('runId'),
          toolCallId: c.req.query('toolCallId'),
          status,
          platform: c.req.query('platform'),
          eventId,
          workerId,
          startedAfter: dateFilter('startedAfter'),
          startedBefore: dateFilter('startedBefore'),
          before: before ? Number(before) : undefined,
        }),
      })
    })
    .post('/router-traces/:id/replay', async (c) => {
      if (!service.workspace.replayTrace)
        throw new HTTPException(503, { message: '隔离重放尚未就绪。' })
      const body = fields(await requestJson(c), ['prompt'])
      const prompt = body.prompt
      if (prompt !== undefined && typeof prompt !== 'string') badInput('调试输入必须是文字。')
      return c.json(await service.workspace.replayTrace(c.req.param('id'), prompt))
    })
    .get('/router-traces/:id/export', (c) => {
      const traces = service.workspace.traces
      if (!traces) throw new HTTPException(503, { message: 'Router 轨迹尚未就绪。' })
      const run = traces.getRun(c.req.param('id'))
      if (!run) throw new HTTPException(404, { message: '没有找到这条轨迹。' })
      const entries = []
      let after = 0
      for (;;) {
        const page = traces.entries(run.id, after, 200)
        entries.push(...page)
        if (page.length < 200) break
        after = page[page.length - 1].ordinal
      }
      c.header('Content-Disposition', `attachment; filename="router-trace-${run.id}.json"`)
      c.header('Cache-Control', 'no-store')
      return c.json({ format: 'zero-router-trace-v1', run, entries })
    })
    .get('/router-traces/:id', (c) => {
      const traces = service.workspace.traces
      if (!traces) throw new HTTPException(503, { message: 'Router 轨迹尚未就绪。' })
      const run = traces.getRun(c.req.param('id'))
      if (!run)
        throw new HTTPException(404, { message: '没有找到这条轨迹。当前版本不会自动清理轨迹。' })
      const after = c.req.query('after')
      if (after && (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))))
        badInput('无效的轨迹游标。')
      const entries = traces.entries(run.id, after ? Number(after) : 0)
      return c.json({
        run,
        entries,
        nextAfter: entries.length === 100 ? entries.at(-1)?.ordinal : null,
      })
    })
    .get('/workspace-events', (c) => {
      const includeOwn = c.req.query('includeOwn')
      if (includeOwn !== undefined && includeOwn !== 'true' && includeOwn !== 'false')
        badInput('无效的自身事件筛选。')
      return c.json({
        items: service.workspace.listEvents(
          pageNumber(c.req.query('limit'), 100) ?? 30,
          pageNumber(c.req.query('beforeId'), Number.MAX_SAFE_INTEGER),
          includeOwn !== 'false',
        ),
      })
    })
    .get('/workspace/:scope', (c) =>
      c.json(
        service.workspace.get(
          workspaceScope(c.req.param('scope')),
          pageNumber(c.req.query('throughTurn'), Number.MAX_SAFE_INTEGER),
        ),
      ),
    )
    .get('/workspace/:scope/github-reply', async (c) => {
      const id = githubReplyScope(c.req.param('scope'))
      return c.json(
        service.githubReplies ? await service.githubReplies.preview(id) : { target: null },
      )
    })
    .post('/workspace/:scope/github-reply', async (c) => {
      const id = githubReplyScope(c.req.param('scope'))
      const input = fields(await requestJson(c), ['requestId', 'body'])
      const { requestId } = workspaceRequest(input)
      const author = /^"([a-z0-9][a-z0-9-]*\[bot\])"$/u.exec(c.req.header('If-Match') ?? '')?.[1]
      if (!author) throw new HTTPException(412, { message: '请刷新并核对 GitHub App 身份后发布。' })
      if (!service.githubReplies)
        throw new HTTPException(503, { message: 'GitHub 评论服务未启动。' })
      return c.json(await service.githubReplies.send(id, requestId, input.body, author))
    })
    .post('/workspace/:scope/messages', async (c) => {
      const scope = workspaceScope(c.req.param('scope'))
      const body = fields(await requestJson(c), ['requestId', 'text', 'retry', 'background'])
      const { requestId, retry } = workspaceRequest(body)
      if (
        typeof body.text !== 'string' ||
        body.text.length > 2000 ||
        !body.text.trim() ||
        /\p{Cc}/u.test(body.text.replace(/[\t\r\n]/g, ''))
      )
        badInput('请输入 1 到 2000 个字的提问。')
      if (body.background !== undefined && checked(body.background))
        return c.json(
          await service.workspace.message(scope, requestId, body.text.trim(), retry, true),
          202,
        )
      return c.json(await service.workspace.message(scope, requestId, body.text.trim(), retry))
    })
    .post('/workspace/:scope/actions', async (c) => {
      const scope = workspaceScope(c.req.param('scope'))
      const body = fields(await requestJson(c), ['requestId', 'action', 'retry'])
      const { requestId, retry } = workspaceRequest(body)
      return c.json(await service.workspace.action(scope, requestId, body.action, retry))
    })
    .get('/routing/config', (c) => c.json(service.routing.getConfig()))
    .put('/routing/config', (c) => saveRouting(c, false))
    .get('/routing/preferences', (c) => c.json(preferences(service.routing.getConfig())))
    .put('/routing/preferences', (c) => saveRouting(c, true))
    .get('/routing/bots', (c) =>
      c.json({
        bots: service.routing
          .listPersonalBots()
          .map(({ platform, channelId, label, online, ready, deliveryState }) => ({
            platform,
            channelId,
            label,
            online,
            ready,
            deliveryState,
            ownerSharing: service.workspace.ownerIdentity?.sharing(platform, channelId),
          })),
      }),
    )
    .put('/routing/owner-sharing', async (c) => {
      const identity = service.workspace.ownerIdentity
      if (!identity) throw new RouterWorkspaceError(503, 'Router 身份服务尚未就绪。')
      const body = fields(await requestJson(c), ['platform', 'channelId', 'revision', 'shared'])
      const platform = choice(body.platform, triggerRoutePlatforms, '平台')
      const channelId = fieldText(body.channelId, '机器人', 256, true)
      const target = service.routing
        .getBotBindings()
        .targets.find((t) => t.platform === platform && t.channelId === channelId)
      const shared = checked(body.shared)
      if (
        !target ||
        !identity.sharing(platform, channelId) ||
        (shared && !service.routing.isSelectedDirectTarget(target))
      )
        throw new RouterWorkspaceError(409, '该机器人当前没有可核实的本人私聊。')
      identity.setSharing(platform, channelId, version(body.revision), shared)
      return c.json(identity.sharing(platform, channelId))
    })
    .get('/channels/bot-bindings', (c) => c.json(service.routing.getBotBindings()))
    .put('/channels/bot-bindings', async (c) => {
      const body = fields(await requestJson(c), ['revision', 'platform', 'channelId', 'target'])
      const revision = version(body.revision)
      const platform = choice(body.platform, triggerRoutePlatforms, '平台')
      const channelId = fieldText(body.channelId, '机器人账号', 256, true)
      const target = body.target === null ? null : parseMandateTarget(body.target)
      if (revision !== service.routing.getBotBindings().revision)
        throw new TriggerSettingsConflictError()
      if (
        target &&
        (target.platform !== platform ||
          target.channelId !== channelId ||
          !service.routing
            .listPersonalTargets()
            .some((candidate) => sameTriggerRouteTarget(candidate, target)))
      )
        badInput('请选择该机器人已绑定的接收地址。')
      return c.json(service.routing.saveBotBinding(platform, channelId, target, revision))
    })
    .get('/routing/targets', async (c) => {
      const targets = await service.routing.listTargets()
      return c.json({
        targets: targets.map(({ channelId, peerId, label }) => ({ channelId, peerId, label })),
      })
    })
    .get('/channels/personal-targets', async (c) => {
      const targets = await service.routing.listPersonalTargets()
      return c.json({
        targets: targets.map(({ platform, channelId, peerId, operatorId, label }) => ({
          platform,
          channelId,
          peerId,
          operatorId,
          label,
        })),
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
    .get('/github/router-operators', (c) => {
      const bots = service.routing.listPersonalBots()
      const operators = service.routing.listPersonalTargets().flatMap((target) => {
        if (!target.operatorId || !service.routing.isSelectedDirectTarget(target)) return []
        const { platform, channelId, peerId, operatorId } = target
        const bot = bots.find((b) => b.platform === platform && b.channelId === channelId)
        return bot ? [{ platform, channelId, peerId, operatorId, label: bot.label }] : []
      })
      return c.json({ operators })
    })
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
        'issues',
        'pullRequests',
        'issueComments',
        'pullRequestComments',
      ])
      const name = repositoryName(input.name)
      const ref = credentialRef(input.credentialRef)
      const selection = {
        workflowFailures: checked(input.workflowFailures),
        prComments: checked(input.prComments),
        prBase: checked(input.prBase),
        ...(input.issues !== undefined && { issues: checked(input.issues) }),
        ...(input.pullRequests !== undefined && { pullRequests: checked(input.pullRequests) }),
        ...(input.issueComments !== undefined && { issueComments: checked(input.issueComments) }),
        ...(input.pullRequestComments !== undefined && {
          pullRequestComments: checked(input.pullRequestComments),
        }),
      }
      if (
        !selection.workflowFailures &&
        !selection.prComments &&
        !selection.issues &&
        !selection.pullRequests &&
        !selection.issueComments &&
        !selection.pullRequestComments
      )
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
