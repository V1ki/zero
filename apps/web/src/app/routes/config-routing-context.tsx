import { type TriggerRoutingSettings, isTriggerCalendarDate } from '@zero-os/shared'
import { useState } from 'react'

export function RoutingContextFields({
  settings,
  update,
}: { settings: TriggerRoutingSettings; update: (patch: Partial<TriggerRoutingSettings>) => void }) {
  const [date, setDate] = useState('')
  const [kind, setKind] = useState<'work' | 'off'>('off')
  const dates = settings.dateOverrides ?? {}
  const native = settings.nativePresence ?? { enabled: false, idleMinutes: 5, bluetooth: false }
  return (
    <>
      <details className="listener-item">
        <summary>
          假日与补班{Object.keys(dates).length > 0 && `（${Object.keys(dates).length}）`}
        </summary>
        <p className="listener-muted">
          日期以路由时区为准。指定休息日从当天零点起生效，包括前一天延续过来的夜班。
        </p>
        <div className="listener-row">
          <label className="listener-field">
            例外日期
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="listener-field">
            当天安排
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value === 'off' ? 'off' : 'work')}
            >
              <option value="off">休息</option>
              <option value="work">上班</option>
            </select>
          </label>
          <button
            type="button"
            disabled={
              !isTriggerCalendarDate(date) ||
              dates[date] === kind ||
              (!dates[date] && Object.keys(dates).length >= 366)
            }
            onClick={() => {
              update({ dateOverrides: { ...dates, [date]: kind } })
              setDate('')
            }}
          >
            {dates[date] ? '更新日期' : '加入日历'}
          </button>
        </div>
        {Object.entries(dates)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([day, value]) => (
            <div key={day} className="listener-row">
              <time dateTime={day}>{day}</time>
              <span>{value === 'work' ? '上班' : '休息'}</span>
              <button
                type="button"
                aria-label={`移除 ${day} 的安排`}
                onClick={() => {
                  const next = { ...dates }
                  delete next[day]
                  update({ dateOverrides: next })
                }}
              >
                移除
              </button>
            </div>
          ))}
      </details>
      <details className="listener-item">
        <summary>Mac 在场信号{native.enabled && '（已启用）'}</summary>
        <p className="listener-muted">
          仅在 ZeRo 运行于你日常使用的 Mac
          上时开启。锁屏、空闲或信号不可用时，按「网页无人时」处理。
        </p>
        <label className="listener-row">
          <input
            type="checkbox"
            checked={native.enabled}
            onChange={(e) => {
              const validIdle =
                Number.isInteger(native.idleMinutes) &&
                native.idleMinutes >= 1 &&
                native.idleMinutes <= 120
              update({
                nativePresence: {
                  ...native,
                  enabled: e.target.checked,
                  idleMinutes: validIdle ? native.idleMinutes : 5,
                },
              })
            }}
          />
          判断网页在场时检查 Mac 锁屏和空闲状态
        </label>
        {native.enabled && (
          <div className="listener-stack">
            <label className="listener-field">
              离席判定（空闲分钟数）
              <input
                type="number"
                min="1"
                max="120"
                step="1"
                required
                value={native.idleMinutes || ''}
                onChange={(e) =>
                  update({ nativePresence: { ...native, idleMinutes: Number(e.target.value) } })
                }
              />
            </label>
            <label className="listener-row">
              <input
                type="checkbox"
                checked={native.bluetooth}
                onChange={(e) =>
                  update({ nativePresence: { ...native, bluetooth: e.target.checked } })
                }
              />
              同时检查蓝牙音频设备是否连接
            </label>
            <small>
              系统按需读取，结果最多使用 30 秒。蓝牙仅补充已确认的在场判断，仅保留连接状态。
            </small>
          </div>
        )}
      </details>
    </>
  )
}
