import type { TriggerRouteDecision, TriggerRoutingSettings } from './types/trigger-routing'

const minuteMs = 60_000
export const TRIGGER_PRESENCE_TTL_MS = 2 * minuteMs
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const periodLabels = { duringWork: '工作时段', afterWork: '工作日非工作时段', offDay: '休息日' }

function wallMinute(time: string): number {
  const [hour, minute] = time.split(':').map(Number)
  return hour * 60 + minute
}

function localSchedule(settings: TriggerRoutingSettings, now: Date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: settings.timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const { weekday, hour, minute } = Object.fromEntries(
    formatter.formatToParts(now).map(({ type, value }) => [type, value]),
  )
  const day = weekdays.indexOf(weekday)
  const current = Number(hour) * 60 + Number(minute)
  const start = wallMinute(settings.workStart)
  const end = wallMinute(settings.workEnd)
  const workday = settings.workdays.includes(day)
  const working =
    start <= end
      ? workday && current >= start && current < end
      : (workday && current >= start) ||
        (settings.workdays.includes((day + 6) % 7) && current < end)
  const period = working ? 'duringWork' : workday ? 'afterWork' : 'offDay'

  // Recheck on a nearby wall-clock boundary, or within five minutes for changes in availability.
  const minutesToBoundary = Math.min(...[start, end, 1440].filter((m) => m > current)) - current
  const recheckAt = new Date(
    (Math.floor(now.getTime() / minuteMs) + Math.min(minutesToBoundary, 5)) * minuteMs,
  ).toISOString()
  return { period, recheckAt } as const
}

export function decideTriggerRoute(
  settings: TriggerRoutingSettings,
  now: Date,
  lastPresenceAt?: Date,
  targetAvailable = false,
): TriggerRouteDecision {
  const { period, recheckAt } = localSchedule(settings, now)
  const defer = (reason: string): TriggerRouteDecision => ({
    destination: 'defer',
    reason,
    recheckAt,
  })
  if (!settings.enabled) return defer('主动通知已暂停')
  const label = periodLabels[period]
  const preferred = settings[period]
  if (preferred === 'defer') return defer(`${label}的偏好为延后提醒`)

  const canSendWeixin = settings.weixinTarget !== null && targetAvailable
  if (preferred === 'weixin') {
    return canSendWeixin
      ? { destination: 'weixin', reason: `${label}首选微信，已选会话可用` }
      : defer(`${label}首选微信，当前没有可用的已选会话`)
  }

  const ageMs = lastPresenceAt ? now.getTime() - lastPresenceAt.getTime() : Number.NaN
  if (settings.presence === 'present') {
    return { destination: 'web', reason: `${label}首选网页，已手动标记在场` }
  }
  if (settings.presence === 'auto' && ageMs >= 0 && ageMs < TRIGGER_PRESENCE_TTL_MS) {
    return { destination: 'web', reason: `${label}首选网页，近两分钟有网页活动` }
  }

  const why = settings.presence === 'away' ? '已手动标记离开' : '近两分钟未确认网页活动'
  if (settings.awayFallback === 'weixin') {
    return canSendWeixin
      ? { destination: 'weixin', reason: `${label}首选网页，${why}，按备用偏好转到已选微信` }
      : defer(`${label}首选网页，${why}，备用微信会话不可用`)
  }
  return defer(`${label}首选网页，${why}，按偏好延后提醒`)
}
