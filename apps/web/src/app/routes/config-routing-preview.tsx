import {
  TRIGGER_NATIVE_PRESENCE_TTL_MS,
  type TriggerPresence,
  type TriggerRoutingSettings,
  decideTriggerRoute,
  getTriggerTimeContext,
} from '@zero-os/shared'
import { useState } from 'react'

const destinationNames = { web: '网页展示', weixin: '发送微信', defer: '延后提醒' }
type PresenceScenario = 'draft' | 'present' | 'away' | 'inactive'

type NativeScenario = 'active' | 'locked' | 'idle' | 'bluetooth' | 'unknown' | 'stale'

function asLocalInput(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function outcome(
  draft: TriggerRoutingSettings,
  instant: string,
  scenario: PresenceScenario,
  assumeAvailable: boolean,
  native: NativeScenario,
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
    assumeAvailable,
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
  const [assumeAvailable, setAssumeAvailable] = useState(true)
  return (
    <details className="listener-item">
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
        <label className="listener-field">
          模拟微信会话
          <select
            disabled={!settings.weixinTarget}
            value={settings.weixinTarget && assumeAvailable ? 'online' : 'unavailable'}
            onChange={(e) => setAssumeAvailable(e.target.value === 'online')}
          >
            <option value="online">假设已选会话可用</option>
            <option value="unavailable">
              {settings.weixinTarget
                ? '假设已选会话不可用'
                : saved
                  ? '尚未选择接收会话'
                  : '草稿尚未选择接收会话'}
            </option>
          </select>
        </label>
      </div>
      <output className="listener-stack" aria-live="polite">
        {outcome(settings, instant, scenario, assumeAvailable, native)}
      </output>
    </details>
  )
}
