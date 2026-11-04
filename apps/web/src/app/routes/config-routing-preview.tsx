import {
  type MandatePlatform,
  TRIGGER_NATIVE_PRESENCE_TTL_MS,
  type TriggerPresence,
  type TriggerRoutingSettings,
  decideTriggerRoute,
  getTriggerRouteBot,
  getTriggerTimeContext,
  isTriggerRoutePlatform,
  triggerRoutePlatforms,
} from '@zero-os/shared'
import { useState } from 'react'
import { useRoutingBots } from './routing-bots'

const names = { weixin: '微信', dingtalk: '钉钉', feishu: '飞书' }
const destinationNames = {
  web: '网页展示',
  weixin: '发送微信',
  dingtalk: '发送钉钉',
  feishu: '发送飞书',
  defer: '延后提醒',
}
type PresenceScenario = 'draft' | 'present' | 'away' | 'inactive'
type BotScenario = 'current' | 'online' | 'unavailable'

type NativeScenario = 'active' | 'locked' | 'idle' | 'bluetooth' | 'unknown' | 'stale'

function asLocalInput(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function outcome(
  draft: TriggerRoutingSettings,
  instant: string,
  scenario: PresenceScenario,
  available: Partial<Record<MandatePlatform, boolean>>,
  native: NativeScenario,
  botLabels: Partial<Record<MandatePlatform, string>>,
) {
  const at = new Date(instant)
  if (!Number.isFinite(at.getTime()) || asLocalInput(at) !== instant)
    return '请选择有效的模拟时间。'
  if (
    !draft.timeZone.trim() ||
    !draft.workStart ||
    !draft.workEnd ||
    draft.workStart === draft.workEnd
  )
    return '请先填写有效的时区和工作时段。'

  let dateFormat: Intl.DateTimeFormat
  try {
    dateFormat = new Intl.DateTimeFormat('zh-CN', {
      timeZone: draft.timeZone,
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
  } catch (error) {
    if (error instanceof RangeError) return '请先填写有效的时区。'
    throw error
  }

  const presence: TriggerPresence =
    scenario === 'draft' ? draft.presence : scenario === 'inactive' ? 'auto' : scenario
  const decision = decideTriggerRoute(
    { ...draft, enabled: true, presence },
    at,
    scenario === 'inactive' ? undefined : at,
    available,
    {
      observedAt: new Date(
        at.getTime() - (native === 'stale' ? TRIGGER_NATIVE_PRESENCE_TTL_MS : 0),
      ).toISOString(),
      locked: native === 'unknown' ? null : native === 'locked',
      idleSeconds:
        native === 'unknown'
          ? null
          : native === 'idle'
            ? (draft.nativePresence?.idleMinutes ?? 5) * 60
            : 0,
      bluetoothConnected: native === 'bluetooth',
    },
  )
  const exception = draft.dateOverrides?.[getTriggerTimeContext(draft, at).localDate]
  return (
    <>
      <strong>{destinationNames[decision.destination]}</strong>
      {isTriggerRoutePlatform(decision.destination) && (
        <span>机器人 · {botLabels[decision.destination]}</span>
      )}
      <span>{decision.reason}</span>
      <small>
        {draft.timeZone} · {dateFormat.format(at)}
        {exception && (exception === 'off' ? '，日历指定休息' : '，日历指定上班')}
        {decision.destination === 'defer' &&
          `，将在 ${dateFormat.format(new Date(decision.recheckAt))} 复核`}
      </small>
    </>
  )
}

export function RoutingPreview({
  settings,
  saved = false,
}: { settings: TriggerRoutingSettings; saved?: boolean }) {
  const [instant, setInstant] = useState(() => asLocalInput(new Date()))
  const [scenario, setScenario] = useState<PresenceScenario>('draft')
  const [native, setNative] = useState<NativeScenario>('active')
  const [open, setOpen] = useState(false)
  const [scenarios, setScenarios] = useState<Partial<Record<MandatePlatform, BotScenario>>>({})
  const bots = useRoutingBots(open)
  const selectedBots = triggerRoutePlatforms.flatMap((platform) => {
    const id = getTriggerRouteBot(settings, platform)
    if (!id) return []
    const bot = bots.data?.bots.find(
      (entry) => entry.channelId === id && entry.platform === platform,
    )
    return [{ platform, label: bot?.label ?? id, ready: !!bot?.online && bot.ready }]
  })
  const available: Partial<Record<MandatePlatform, boolean>> = {}
  const botLabels: Partial<Record<MandatePlatform, string>> = {}
  for (const { platform, label, ready } of selectedBots) {
    const mode = scenarios[platform] ?? 'current'
    available[platform] = mode === 'current' ? ready : mode === 'online'
    botLabels[platform] = label
  }
  return (
    <details className="listener-item" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>情境预演</summary>
      <p className="listener-muted">
        假设已启用{saved ? '已保存的规则' : '当前草稿'}
        ，在浏览器中试算一条提醒的去向。预演不会发送消息或写入收件箱。
      </p>
      <div className="listener-fields">
        <label className="listener-field">
          模拟时间（设备时区 {Intl.DateTimeFormat().resolvedOptions().timeZone}）
          <input
            type="datetime-local"
            value={instant}
            onChange={(e) => setInstant(e.target.value)}
          />
        </label>
        <label className="listener-field">
          模拟在场状态
          <select
            value={scenario}
            onChange={(e) => setScenario(e.target.value as PresenceScenario)}
          >
            <option value="draft">
              沿用{saved ? '已保存规则' : '草稿'} · 自动模式假设刚操作网页
            </option>
            <option value="present">手动 · 在电脑前</option>
            <option value="away">手动 · 已离开</option>
            <option value="inactive">自动 · 无近期网页活动</option>
          </select>
        </label>
        {settings.nativePresence?.enabled && (
          <label className="listener-field">
            模拟 Mac 状态
            <select value={native} onChange={(e) => setNative(e.target.value as NativeScenario)}>
              <option value="active">解锁，近期使用</option>
              <option value="locked">已锁屏</option>
              <option value="idle">空闲已达离席时长</option>
              {settings.nativePresence.bluetooth && (
                <option value="bluetooth">解锁，已连接蓝牙音频</option>
              )}
              <option value="unknown">系统状态不可用</option>
              <option value="stale">信号过期</option>
            </select>
          </label>
        )}
        {selectedBots.map(({ platform, label, ready }) => (
          <label className="listener-field" key={platform}>
            模拟{names[platform]}机器人 · {label}
            <select
              aria-label={`模拟${names[platform]}机器人`}
              value={scenarios[platform] ?? 'current'}
              onChange={(e) =>
                setScenarios({ ...scenarios, [platform]: e.target.value as BotScenario })
              }
            >
              <option value="current">
                沿用当前状态 · {bots.data ? (ready ? '可主动提醒' : '主动提醒将延后') : '尚未确认'}
              </option>
              <option value="online">假设可以主动提醒</option>
              <option value="unavailable">假设主动提醒暂不可用</option>
            </select>
          </label>
        ))}
      </div>
      <output className="listener-stack" aria-live="polite">
        {outcome(settings, instant, scenario, available, native, botLabels)}
      </output>
    </details>
  )
}
