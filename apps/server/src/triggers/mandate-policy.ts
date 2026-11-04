import {
  type MandateContextRule,
  type MandatePlatform,
  type MandateTarget,
  type TriggerMandate,
  type TriggerMandateProject,
  type TriggerNativePresence,
  type TriggerRoutingSettings,
  getTriggerTimeContext,
  getTriggerWebPresence,
} from '@zero-os/shared'

const minute = 60_000
const periods = { duringWork: '工作时段', afterWork: '工作日非工作时段', offDay: '休息日' }
const platformNames = { weixin: '微信', dingtalk: '钉钉', feishu: '飞书' }

export interface MandateNotificationInput {
  mandate: TriggerMandate
  project: TriggerMandateProject | null
  settings: TriggerRoutingSettings
  now: Date
  /** Trusted local receipt time. Replaying an event preserves its digest window. */
  receivedAt: string
  availableTargets: readonly MandateTarget[]
  lastPresenceAt?: Date
  nativeContext?: TriggerNativePresence
}

export type MandateNotificationDecision =
  | { destination: 'web'; reason: string; digestKey?: string }
  | { destination: MandatePlatform; target: MandateTarget; reason: string; digestKey?: string }
  | { destination: 'none'; reason: string }
  | { destination: 'defer'; recheckAt: string; reason: string }

type RuleContext = Required<MandateContextRule['when']>

function firstMatchingRule(
  rules: readonly MandateContextRule[] | undefined,
  context: RuleContext,
  level: '委托' | '项目',
) {
  if (!rules) return
  for (const [index, rule] of rules.entries()) {
    const { period, presence, urgency, quiet } = rule.when
    if (
      (period === undefined || period === context.period) &&
      (presence === undefined || presence === context.presence) &&
      (urgency === undefined || urgency === context.urgency) &&
      (quiet === undefined || quiet === context.quiet)
    )
      return { rule, reason: `命中${level}规则第 ${index + 1} 条「${rule.name}」` }
  }
}

/** Decide only the notification. The separately authorized archive can proceed through quiet hours. */
export function decideMandateNotification({
  mandate,
  project,
  settings,
  now,
  receivedAt,
  availableTargets,
  lastPresenceAt,
  nativeContext,
}: MandateNotificationInput): MandateNotificationDecision {
  const projectPolicy = project && project.id === mandate.projectId ? project.policy : undefined
  const policy = { ...projectPolicy, ...mandate.policy }
  const context = getTriggerTimeContext(settings, now, {
    ...policy,
    dateOverrides: { ...projectPolicy?.dateOverrides, ...mandate.policy.dateOverrides },
  })

  // Only the operator-saved deadline and urgency qualify for the explicit exception.
  const deadlineLeadMinutes = policy.deadlineLeadMinutes ?? 60
  const deadlineWindow = deadlineLeadMinutes * minute
  const deadline = mandate.deadline ? Date.parse(mandate.deadline) : Number.NaN
  const remaining = deadline - now.getTime()
  const deadlineNear = remaining >= 0 && remaining <= deadlineWindow
  const urgent = mandate.urgent || deadlineNear
  const defer = (reason: string, until = context.recheckAt): MandateNotificationDecision => {
    const usesUrgency =
      policy.urgentDestination !== undefined ||
      mandate.policy.rules?.some(({ when }) => when.urgency !== undefined) ||
      projectPolicy?.rules?.some(({ when }) => when.urgency !== undefined)
    let next = Date.parse(until)
    if (usesUrgency && !mandate.urgent && remaining >= 0) {
      // Re-evaluate on either edge, including when a deferred urgent event becomes ordinary again.
      const boundary = deadlineNear ? deadline + 1 : deadline - deadlineWindow
      next = Math.min(next, boundary)
    }
    return { destination: 'defer', reason, recheckAt: new Date(next).toISOString() }
  }
  if (!settings.enabled || !mandate.enabled) return defer('主动处理已暂停')

  const period = context.period
  let destination = policy[period] ?? settings[period]
  const level = mandate.policy[period] ? '委托' : projectPolicy?.[period] ? '项目' : '个人'
  let reason = `${periods[period]}采用${level}偏好`
  if (destination === 'none') return { destination, reason: `${reason}，无需提醒` }
  const urgencyReason = mandate.urgent
    ? '委托已标记紧急'
    : `距离委托截止时间不超过 ${deadlineLeadMinutes} 分钟`
  if (urgent && policy.urgentDestination === 'none')
    return { destination: 'none', reason: `${urgencyReason}，紧急例外设置为无需提醒` }

  const presence = getTriggerWebPresence(settings, now, lastPresenceAt, nativeContext)
  const ruleContext: RuleContext = {
    period,
    presence: presence.state,
    urgency: urgent ? 'urgent' : 'normal',
    quiet: context.quiet,
  }
  const mandateHasPreference =
    mandate.policy[period] !== undefined ||
    (urgent && mandate.policy.urgentDestination !== undefined)
  const match =
    firstMatchingRule(mandate.policy.rules, ruleContext, '委托') ??
    (!mandateHasPreference
      ? firstMatchingRule(projectPolicy?.rules, ruleContext, '项目')
      : undefined)
  let allowQuiet = false
  let skipDigest = false
  if (match) {
    destination = match.rule.destination
    reason = match.reason
    allowQuiet = match.rule.when.quiet === true
    skipDigest = match.rule.when.urgency === 'urgent'
  } else if (urgent && policy.urgentDestination) {
    destination = policy.urgentDestination
    reason = `${urgencyReason}，采用紧急例外`
    allowQuiet = true
    skipDigest = true
  }
  if (destination === 'none') return { destination, reason: `${reason}，无需提醒` }
  if (context.quiet && !allowQuiet) return defer(`${reason}，当前为静默时段`)
  if (destination === 'defer') return defer(`${reason}，延后提醒`)

  // Finite, half-open receipt windows give every worker the same digest key after a restart.
  let digestKey: string | undefined
  if (!skipDigest && policy.digestMinutes && policy.digestMinutes > 0) {
    const interval = policy.digestMinutes * minute
    const close = (Math.floor(Date.parse(receivedAt) / interval) + 1) * interval
    digestKey = new Date(close).toISOString()
    if (close > now.getTime())
      return defer(`${reason}，等待 ${policy.digestMinutes} 分钟摘要窗口结束`, digestKey)
    reason += `，按 ${policy.digestMinutes} 分钟摘要汇总`
  }

  if (destination === 'web') {
    if (presence.present) return { destination, reason: `${reason}，${presence.reason}`, digestKey }
    reason += `，${presence.reason}`
    destination = policy.awayFallback ?? settings.awayFallback
    if (destination === 'none') return { destination, reason: `${reason}，离开时无需提醒` }
    if (destination === 'defer' || destination === 'web') return defer(`${reason}，延后提醒`)
  }

  // Preferences select a platform, never an unapproved identity (including the global Weixin peer).
  const target = mandate.targets.find(
    (candidate) =>
      candidate.platform === destination &&
      availableTargets.some(
        (bound) =>
          candidate.platform === bound.platform &&
          candidate.channelId === bound.channelId &&
          candidate.peerId === bound.peerId &&
          candidate.operatorId === bound.operatorId,
      ),
  )
  if (!target) return defer(`${reason}，没有可用且经此委托授权的${platformNames[destination]}会话`)
  return {
    destination,
    target,
    reason: `${reason}，投递到已授权的${platformNames[destination]}会话`,
    digestKey,
  }
}
