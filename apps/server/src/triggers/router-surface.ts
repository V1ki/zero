import {
  type GithubInvestigationAction,
  ROUTER_A2UI_CATALOG,
  type RouterActionName,
  type RouterEventActivity,
  type RouterSurfaceComponent,
  type RouterSurfaceMessages,
  type RouterTrackingResult,
  type RouterWorkspaceTask,
  type TriggerConversationAnswer,
  type TriggerConversationScope,
  type TriggerInboxItem,
  type TriggerRouteRecord,
  type TriggerRouteStatus,
  type TriggerRoutingSettings,
  getTriggerRouteBot,
  isTriggerRoutePlatform,
  routerEventActivityLabel,
  triggerRoutePlatforms,
  ROUTER_A2UI_VERSION as version,
} from '@zero-os/shared'
import type { RouterBot } from './router-agent'

export { isRouterSurfaceAction, matchesRouterSurfaceAction } from '@zero-os/shared'

const labels: Record<RouterActionName, string> = {
  router_input: '继续处理',
  explain_route: '解释这次路由',
  suggest_next: '建议下一步',
  process_event: '分析并路由通知',
  work_on_event: '让 Worker 处理',
  apply_preference: '确认应用偏好',
  confirm_mandate: '确认此委托变更',
  prepare_reminder: '准备这条通知',
  send_reminder: '发送通知',
  inspect_github: '查看 GitHub 事件详情',
  compare_runs: '对比此前的运行',
  find_related_issues: '查找相关历史 Issue',
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
  retry = false,
  tracking?: RouterTrackingResult,
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
  const buttons: string[] = []
  for (const name of actions) {
    const work = name === 'work_on_event'
    const button = work ? `btn-work_on_event-${tracking?.attempt ?? 1}` : `btn-${name}`
    buttons.push(button)
    components.push(
      {
        id: `label-${name}`,
        component: 'Text',
        text:
          work && tracking?.work?.outcome === 'resolved'
            ? '重新办理此事'
            : name === 'process_event' && retry
              ? '重试通知路由'
              : labels[name],
      },
      {
        id: button,
        component: 'Button',
        ...(work ||
        name === 'apply_preference' ||
        name === 'confirm_mandate' ||
        name === 'send_reminder'
          ? { variant: 'primary' as const }
          : {}),
        child: `label-${name}`,
        action: { event: { name } },
      },
    )
  }
  components.push(
    { id: 'actions', component: 'Row', children: buttons },
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
  tracking?: RouterTrackingResult,
  activity?: RouterEventActivity,
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
  if (
    event.source === 'github' &&
    tracking?.inboxId === scope &&
    tracking.repository.toLowerCase() === event.scope.toLowerCase() &&
    tracking.status !== 'queued' &&
    tracking.status !== 'running'
  )
    actions.unshift('work_on_event')
  const clock = (iso: string) =>
    new Date(iso).toLocaleString('zh-CN', { timeZone: settings.timeZone, hour12: false })
  const facts: Fact[] = [
    {
      label: route?.agent ? 'Agent 摘要' : '事件摘要',
      value: route?.agent?.summary || event.summary || event.title,
    },
  ]
  if (event.githubOwnComment)
    facts.unshift({
      label: '事件来源',
      value: '自身产生 · 已核验为绑定 GitHub App 的评论或本机已发送评论的回流。',
    })
  if (activity?.error) facts.push({ label: '处理记录', value: activity.error })
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
  if (route?.error) facts.push({ label: '处理记录', value: route.error })
  actions.push(...investigationActions)
  const retry = route?.status === 'failed' || route?.status === 'cancelled'
  if (settings.enabled && (!route || retry)) actions.push('process_event')
  return buildSurface(
    surfaceId(scope),
    activity
      ? routerEventActivityLabel(activity)
      : event.githubOwnComment
        ? '自身产生 · 已记录'
        : route
          ? statuses[route.status]
          : '事件已入箱',
    facts,
    actions,
    retry,
    tracking,
  )
}

const preferenceLabels = {
  presence: '在场状态',
  duringWork: '工作时段',
  afterWork: '下班后',
  offDay: '休息日',
  awayFallback: '网页无人时',
}

function describeProposal(change: TriggerConversationAnswer['proposal']) {
  if (change?.key === 'personalBot')
    return isTriggerRoutePlatform(change.platform)
      ? `${destination[change.platform]}改为「${change.label}」（${change.value}）`
      : null
  if (!change || !Object.hasOwn(preferenceLabels, change.key)) return null
  const choices: Record<string, string> =
    change.key === 'presence'
      ? presence
      : change.key === 'awayFallback'
        ? {
            weixin: '使用已选微信机器人',
            dingtalk: '使用已选钉钉机器人',
            feishu: '使用已选飞书机器人',
            defer: '延后提醒',
          }
        : destination
  return Object.hasOwn(choices, change.value)
    ? `${preferenceLabels[change.key]}改为「${choices[change.value]}」`
    : null
}

export function buildRouterReplySurface(
  scope: TriggerConversationScope,
  turnId: number,
  answer: TriggerConversationAnswer,
  currentRevision?: number,
  proposalTargetAvailable = false,
  commissionStatus: 'pending' | 'expired' | 'applied' = 'expired',
  canPrepareReminder = false,
): RouterSurfaceMessages | null {
  if (answer.generatedUI) return answer.generatedUI.messages
  if (answer.toolSteps) return null
  const id = `${surfaceId(scope)}-turn-${turnId}`
  if (scope === 'general' && answer.reminder) {
    const reminder = answer.reminder
    const status = {
      draft: '待发送',
      sending: '正在发送，等待平台回执',
      accepted: '平台已受理',
      rejected: '未能发送',
      unknown: '发送结果待核实，请查看机器人私聊',
    }[reminder.status]
    return buildSurface(
      id,
      '一次性通知',
      [
        {
          label: destination[reminder.platform],
          value:
            reminder.botLabel === reminder.channelId
              ? reminder.botLabel
              : `${reminder.botLabel}（${reminder.channelId}）`,
        },
        { label: '通知内容', value: reminder.text },
        { label: '发送状态', value: status },
        ...(reminder.reason ? [{ label: '详情', value: reminder.reason }] : []),
      ],
      reminder.status === 'draft' ? ['send_reminder'] : [],
    )
  }
  if (answer.commission) {
    const { title, details } = answer.commission
    const notice = {
      pending: '请核对后确认，草案十分钟内有效。',
      expired: '草案已失效，请重新提出。',
      applied: '已确认并保存。',
    }[commissionStatus]
    return buildSurface(
      id,
      title,
      [...details.map((value) => ({ value })), { value: notice }],
      commissionStatus === 'pending' ? ['confirm_mandate'] : [],
    )
  }
  const evidence = answer.investigation
  if (evidence) {
    const heading = {
      jobs: '失败作业与步骤',
      history: '历史运行对比',
      'related-issues': '相关历史 Issue · GitHub 检索记录',
      pull: 'PR 与原评论',
      issue: 'Issue 与原评论',
    }[evidence.kind]
    const facts = [
      ...evidence.facts,
      { label: '获取时间 · GitHub REST', value: evidence.observedAt },
    ]
    return buildSurface(id, heading, facts, ['suggest_next'])
  }
  const proposal = describeProposal(answer.proposal)
  if (scope === 'general' && canPrepareReminder && !answer.proposal) {
    return buildSurface(
      id,
      '一次性通知',
      [{ value: '可根据原请求准备通知，核对机器人和正文后发送。' }],
      ['prepare_reminder'],
    )
  }
  if (!answer.intent && !proposal) return null
  const title = proposal
    ? '通知偏好变更'
    : { route: '路由依据', event: '事件要点', next: '建议的下一步' }[answer.intent ?? 'route']
  const facts: Fact[] = []
  const actions: RouterActionName[] = []
  if (proposal) {
    facts.push({
      label: answer.proposalAppliedAt ? '已保存的全局设置' : '拟调整的全局设置',
      value: proposal,
    })
    if (answer.proposalAppliedAt) {
      facts.push({ value: '已确认并保存此偏好。' })
    } else if (currentRevision === undefined || currentRevision !== answer.proposalRevision) {
      facts.push({ value: '设置版本已更新。如需这项更改，请重新提出。' })
    } else if (
      (answer.proposal?.key === 'personalBot' || isTriggerRoutePlatform(answer.proposal?.value)) &&
      !proposalTargetAvailable
    ) {
      facts.push({
        value: '请在渠道配置中核对机器人账号，并在 Router 通知设置中选定机器人。',
      })
    } else {
      facts.push({ value: '确认后会保存新偏好，并按新规则复核等待提醒的事件。' })
      actions.push('apply_preference')
    }
  }
  for (const [i, value] of (answer.points ?? []).slice(0, 3).entries())
    facts.push({ label: answer.intent === 'next' ? `步骤 ${i + 1}` : undefined, value })
  actions.push(answer.intent === 'next' ? 'explain_route' : 'suggest_next')
  return buildSurface(id, title, facts, actions)
}
