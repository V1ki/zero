import {
  type GithubInvestigationAction,
  ROUTER_A2UI_CATALOG,
  type RouterActionName,
  type RouterJobReport,
  type RouterSurfaceComponent,
  type RouterSurfaceMessages,
  type RouterWorkspaceTask,
  type TriggerConversationAnswer,
  type TriggerConversationScope,
  type TriggerInboxItem,
  type TriggerRouteRecord,
  type TriggerRouteStatus,
  type TriggerRoutingSettings,
  getTriggerRouteBot,
  triggerRoutePlatforms,
  ROUTER_A2UI_VERSION as version,
} from '@zero-os/shared'
import type { RouterBot } from './router-agent'

export { isRouterSurfaceAction, matchesRouterSurfaceAction } from '@zero-os/shared'

const labels: Record<RouterActionName, string> = {
  explain_route: '解释这次路由',
  suggest_next: '建议下一步',
  process_event: '交给 Agent 处理',
  inspect_github: '查看 GitHub 事件详情',
  compare_runs: '对比此前的运行',
  choose_option: '选择这个选项',
}
const statuses: Record<TriggerRouteStatus, string> = {
  pending: '等待 Agent',
  analyzing: '正在分析',
  ready: '等待路由',
  web: '已投递到网页',
  deferred: '等待复核',
  sending: '正在发送提醒',
  sent: '接收平台已受理',
  failed: '处理失败',
  uncertain: '投递结果待确认',
  cancelled: '来源规则已撤销',
  filtered: '分诊已过滤，未发送通知',
}
const destination = {
  web: '网页',
  weixin: '微信机器人',
  dingtalk: '钉钉机器人',
  feishu: '飞书机器人',
  defer: '延后提醒',
}
const presence = {
  auto: '按网页最近两分钟的活动判断',
  present: '手动标记在场',
  away: '手动标记离开',
}

function surfaceId(scope: TriggerConversationScope) {
  return typeof scope === 'number' ? `router-event-${scope}` : `router-${scope}`
}

interface Fact {
  label?: string
  value: string
}
function buildSurface(
  id: string,
  title: string,
  facts: Fact[],
  actions: RouterActionName[],
  processLabel?: string,
): RouterSurfaceMessages {
  const components: RouterSurfaceComponent[] = [
    { id: 'heading', component: 'Text', text: { path: '/heading' }, variant: 'h3' },
  ]
  const children = ['heading']
  const values: Record<string, string> = { heading: title }
  for (const [index, fact] of facts.entries()) {
    const key = `fact-${index}`
    const valueId = `${key}-value`
    values[key] = fact.value
    components.push({ id: valueId, component: 'Text', text: { path: `/${key}` } })
    if (fact.label) {
      const labelId = `${key}-label`
      components.push(
        { id: labelId, component: 'Text', text: fact.label, variant: 'caption' },
        { id: key, component: 'Column', children: [labelId, valueId] },
      )
      children.push(key)
    } else children.push(valueId)
  }
  for (const name of actions) {
    components.push(
      {
        id: `label-${name}`,
        component: 'Text',
        text: (name === 'process_event' && processLabel) || labels[name],
      },
      {
        id: `btn-${name}`,
        component: 'Button',
        child: `label-${name}`,
        action: { event: { name } },
      },
    )
  }
  components.push(
    { id: 'actions', component: 'Row', children: actions.map((name) => `btn-${name}`) },
    { id: 'root', component: 'Column', children: [...children, 'actions'] },
  )
  return [
    { version, createSurface: { surfaceId: id, catalogId: ROUTER_A2UI_CATALOG } },
    { version, updateComponents: { surfaceId: id, components } },
    { version, updateDataModel: { surfaceId: id, path: '/', value: values } },
  ]
}

export function buildRouterSurface(
  scope: TriggerConversationScope,
  event: TriggerInboxItem | null,
  route: TriggerRouteRecord | null,
  settings: TriggerRoutingSettings,
  investigationActions: GithubInvestigationAction[] = [],
  task?: RouterWorkspaceTask,
  bots?: readonly RouterBot[],
): RouterSurfaceMessages {
  const actions: RouterActionName[] = ['explain_route', 'suggest_next']
  if (scope === 'general') {
    const selectedBots = triggerRoutePlatforms.flatMap((platform) => {
      const channelId = getTriggerRouteBot(settings, platform)
      if (!channelId) return []
      const bot = bots?.find((item) => item.platform === platform && item.channelId === channelId)
      const state = !bot
        ? '账号已移除'
        : !bot.online
          ? '离线'
          : bot.ready
            ? '可投递'
            : '投递尚未就绪'
      return [`${destination[platform]} · ${bot?.label || channelId}（${state}）`]
    })
    const days = [1, 2, 3, 4, 5, 6, 0]
      .filter((d) => settings.workdays.includes(d))
      .map((d) => ['日', '一', '二', '三', '四', '五', '六'][d])
    return buildSurface(
      surfaceId(scope),
      settings.enabled ? '当前通知偏好' : '主动路由已暂停',
      [
        {
          label: '工作时段',
          value: [
            days.length
              ? `周${days.join('、')}　${settings.workStart}–${settings.workEnd}（${settings.timeZone}）`
              : '尚未设置工作日',
            ...(Object.keys(settings.dateOverrides ?? {}).length
              ? [`${Object.keys(settings.dateOverrides ?? {}).length} 个指定日期例外`]
              : []),
          ].join('，'),
        },
        {
          label: '首选去向',
          value: `工作时段 · ${destination[settings.duringWork]}　下班后 · ${destination[settings.afterWork]}　休息日 · ${destination[settings.offDay]}`,
        },
        {
          label: '在场判断',
          value: `${presence[settings.presence]}。${settings.nativePresence?.enabled ? '投递前复核 Mac 锁屏与空闲状态。' : ''}网页无人时${settings.awayFallback === 'defer' ? '延后提醒' : `尝试已选${destination[settings.awayFallback]}`}。`,
        },
        ...(bots
          ? [
              {
                label: '已选机器人',
                value: selectedBots.length
                  ? selectedBots.join('；')
                  : '可在通知设置中选择微信、钉钉或飞书机器人。',
              },
            ]
          : []),
      ],
      actions,
    )
  }
  if (typeof scope === 'string') {
    if (!task || scope !== `task-${task.id}`) throw new Error('Router surface task mismatch')
    const latest = task.matches[0]
    return buildSurface(
      surfaceId(scope),
      task.name,
      [
        { label: '委托目的', value: task.purpose || '历史委托' },
        {
          label: '跟进记录',
          value: `已匹配 ${task.eventCount} 条事件，${!task.active ? '委托已归档' : task.paused ? '后续提醒已暂停' : '正在跟进'}`,
        },
        ...(latest?.summary ? [{ label: '最近一次分析', value: latest.summary }] : []),
      ],
      task.active ? actions : [],
    )
  }
  if (!event || event.id !== scope || (route && route.inboxId !== scope))
    throw new Error('Router surface event mismatch')
  const clock = (iso: string) =>
    new Date(iso).toLocaleString('zh-CN', { timeZone: settings.timeZone, hour12: false })
  const facts: Fact[] = [
    {
      label: route?.agent ? 'Agent 摘要' : '事件摘要',
      value: route?.agent?.summary || event.summary || event.title,
    },
  ]
  if (route?.decision) {
    facts.push({
      label: '路由决定',
      value: `${destination[route.decision.destination]} · ${route.decision.reason}`,
    })
    if (route.firstDeferred)
      facts.push({
        label: '首次延后',
        value: `${clock(route.firstDeferred.at)}　${route.firstDeferred.reason}`,
      })
    if (route.status === 'deferred' && route.decision.destination === 'defer')
      facts.push({
        label: `下次复核（${settings.timeZone}）`,
        value: clock(route.decision.recheckAt),
      })
  }
  const filtered = route?.status === 'filtered'
  if (filtered)
    facts.push({ label: '分诊理由', value: route.agent?.triage?.reason || '分诊判断无需通知。' })
  if (route?.error) facts.push({ label: '处理记录', value: route.error })
  actions.push(...investigationActions)
  const retry = route?.status === 'failed' || route?.status === 'cancelled'
  if (settings.enabled && (!route || retry || filtered)) actions.push('process_event')
  return buildSurface(
    surfaceId(scope),
    route ? statuses[route.status] : '事件已入箱',
    facts,
    actions,
    filtered ? '仍然通知' : retry ? '重新处理' : undefined,
  )
}

/** One button per option; option text is untrusted and only ever rendered as text. */
function buildDecisionSurface(
  id: string,
  decision: NonNullable<RouterJobReport['decision']>,
): RouterSurfaceMessages {
  const components: RouterSurfaceComponent[] = [
    { id: 'heading', component: 'Text', text: { path: '/heading' }, variant: 'h3' },
  ]
  const values: Record<string, string> = { heading: decision.question }
  const buttons = decision.options.slice(0, 3).map((option, index) => {
    const button = `btn-choose_option-${index}`
    values[`option-${index}`] = index === decision.recommended ? `${option}（推荐）` : option
    components.push(
      { id: `label-option-${index}`, component: 'Text', text: { path: `/option-${index}` } },
      {
        id: button,
        component: 'Button',
        child: `label-option-${index}`,
        ...(index === decision.recommended && { variant: 'primary' as const }),
        action: { event: { name: 'choose_option' } },
      },
    )
    return button
  })
  components.push(
    { id: 'actions', component: 'Row', children: buttons },
    { id: 'root', component: 'Column', children: ['heading', 'actions'] },
  )
  return [
    { version, createSurface: { surfaceId: id, catalogId: ROUTER_A2UI_CATALOG } },
    { version, updateComponents: { surfaceId: id, components } },
    { version, updateDataModel: { surfaceId: id, path: '/', value: values } },
  ]
}

export function buildRouterReplySurface(
  scope: TriggerConversationScope,
  turnId: number,
  answer: TriggerConversationAnswer,
): RouterSurfaceMessages | null {
  const id = `${surfaceId(scope)}-turn-${turnId}`
  const job = answer.job
  // Only the latest completed step of a job in the general conversation can still be answered.
  if (scope === 'general' && job?.status === 'completed' && !job.continued && job.report?.decision)
    return buildDecisionSurface(id, job.report.decision)
  const evidence = answer.investigation
  if (evidence) {
    const heading = { jobs: '失败作业与步骤', history: '历史运行对比', pull: 'PR 与原评论' }[
      evidence.kind
    ]
    const facts = [
      ...evidence.facts,
      { label: '获取时间 · GitHub REST', value: evidence.observedAt },
    ]
    return buildSurface(id, heading, facts, ['suggest_next'])
  }
  if (!answer.intent) return null
  const title = { route: '路由依据', event: '事件要点', next: '建议的下一步' }[answer.intent]
  const facts: Fact[] = []
  for (const [i, value] of (answer.points ?? []).slice(0, 3).entries())
    facts.push({ label: answer.intent === 'next' ? `步骤 ${i + 1}` : undefined, value })
  return buildSurface(id, title, facts, [
    answer.intent === 'next' ? 'explain_route' : 'suggest_next',
  ])
}
