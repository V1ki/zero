import type {
  TriggerDateOverrides,
  TriggerNativePresence,
  TriggerRouteDecision,
  TriggerRoutingSettings,
} from './types/trigger-routing'

const minuteMs = 60_000
export const TRIGGER_PRESENCE_TTL_MS = 2 * minuteMs
export const TRIGGER_NATIVE_PRESENCE_TTL_MS = 30_000
export function isTriggerCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
const periodLabels = { duringWork: '工作时段', afterWork: '工作日非工作时段', offDay: '休息日' }

function wallMinute(time: string): number {
  const [hour, minute] = time.split(':').map(Number)
  return hour * 60 + minute
}

/** Date exceptions are local to the configured zone. A dated day off takes effect at midnight. */
export function getTriggerTimeContext(
  settings: TriggerRoutingSettings,
  now: Date,
  overrides: { dateOverrides?: TriggerDateOverrides; quietStart?: string; quietEnd?: string } = {},
) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: settings.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const { year, month, day, hour, minute } = Object.fromEntries(
    formatter.formatToParts(now).map(({ type, value }) => [type, value]),
  )
  const localDate = `${year.padStart(4, '0')}-${month}-${day}`
  const localTime = `${hour}:${minute}`
  const midnight = Date.parse(`${localDate}T00:00:00Z`)
  const isWorkday = (date: string, weekday: number) => {
    const exception = overrides.dateOverrides?.[date] ?? settings.dateOverrides?.[date]
    return exception ? exception === 'work' : settings.workdays.includes(weekday)
  }
  const previous = new Date(midnight - 86_400_000)
  const todayOverride = overrides.dateOverrides?.[localDate] ?? settings.dateOverrides?.[localDate]
  const weekday = new Date(midnight).getUTCDay()
  const current = Number(hour) * 60 + Number(minute)
  const start = wallMinute(settings.workStart)
  const end = wallMinute(settings.workEnd)
  const workday = isWorkday(localDate, weekday)
  const working =
    start <= end
      ? workday && current >= start && current < end
      : (workday && current >= start) ||
        (todayOverride !== 'off' &&
          current < end &&
          isWorkday(previous.toISOString().slice(0, 10), previous.getUTCDay()))
  const period = working ? 'duringWork' : workday ? 'afterWork' : 'offDay'

  // Recheck on a nearby wall-clock boundary, or within five minutes for changes in availability.
  const quietStart = overrides.quietStart ? wallMinute(overrides.quietStart) : null
  const quietEnd = overrides.quietEnd ? wallMinute(overrides.quietEnd) : null
  const quiet =
    quietStart !== null &&
    quietEnd !== null &&
    (quietStart < quietEnd
      ? current >= quietStart && current < quietEnd
      : quietStart > quietEnd && (current >= quietStart || current < quietEnd))
  const boundaries = [start, end, 1440, quietStart ?? 0, quietEnd ?? 0]
  const minutesToBoundary = Math.min(...boundaries.filter((m) => m > current)) - current
  const recheckAt = new Date(
    (Math.floor(now.getTime() / minuteMs) + Math.min(minutesToBoundary, 5)) * minuteMs,
  ).toISOString()
  return { period, recheckAt, localDate, localTime, quiet } as const
}

/** Web still requires explicit presence or recent Web activity, even with an active Mac or Bluetooth. */
export function getTriggerWebPresence(
  settings: TriggerRoutingSettings,
  now: Date,
  lastPresenceAt?: Date,
  native?: TriggerNativePresence,
) {
  const result = (state: 'present' | 'away' | 'unknown', reason: string) => ({
    present: state === 'present',
    state,
    reason,
  })
  if (settings.presence === 'away') return result('away', '已手动标记离开')
  let extra = ''
  if (settings.nativePresence?.enabled) {
    const age = native ? now.getTime() - Date.parse(native.observedAt) : Number.NaN
    if (!native || !(age >= 0 && age < TRIGGER_NATIVE_PRESENCE_TTL_MS))
      return result('unknown', 'Mac 在场信号缺失或已过期')
    if (native.locked === true) return result('away', 'Mac 已锁屏或当前用户已切出')
    if (
      native.idleSeconds !== null &&
      Number.isFinite(native.idleSeconds) &&
      native.idleSeconds >= settings.nativePresence.idleMinutes * 60
    )
      return result('away', 'Mac 空闲已达到设定时长')
    if (
      native.locked !== false ||
      native.idleSeconds === null ||
      !Number.isFinite(native.idleSeconds) ||
      native.idleSeconds < 0
    )
      return result('unknown', '当前无法确认 Mac 锁屏或空闲状态')
    if (settings.nativePresence.bluetooth && native.bluetoothConnected)
      extra = '，蓝牙音频设备已连接'
  }
  if (settings.presence === 'present') return result('present', `已手动标记在场${extra}`)
  const age = lastPresenceAt ? now.getTime() - lastPresenceAt.getTime() : Number.NaN
  if (age >= 0 && age < TRIGGER_PRESENCE_TTL_MS)
    return result('present', `近两分钟有网页活动${extra}`)
  return result('unknown', '近两分钟未确认网页活动')
}

export function decideTriggerRoute(
  settings: TriggerRoutingSettings,
  now: Date,
  lastPresenceAt?: Date,
  targetAvailable = false,
  native?: TriggerNativePresence,
): TriggerRouteDecision {
  const { period, recheckAt } = getTriggerTimeContext(settings, now)
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

  const { present, reason: why } = getTriggerWebPresence(settings, now, lastPresenceAt, native)
  if (present) return { destination: 'web', reason: `${label}首选网页，${why}` }
  if (settings.awayFallback === 'weixin') {
    return canSendWeixin
      ? { destination: 'weixin', reason: `${label}首选网页，${why}，按备用偏好转到已选微信` }
      : defer(`${label}首选网页，${why}，备用微信会话不可用`)
  }
  return defer(`${label}首选网页，${why}，按偏好延后提醒`)
}
