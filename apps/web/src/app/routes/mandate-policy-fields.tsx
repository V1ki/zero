import type { MandateDestination, MandatePolicy } from '@zero-os/shared'
import { useState } from 'react'
import { MandateOrderedRules } from './mandate-ordered-rules'

export const mandateDestinations: Record<MandateDestination, string> = {
  web: '网页展示',
  weixin: '微信',
  feishu: '飞书',
  dingtalk: '钉钉',
  defer: '延后提醒',
  none: '不发提醒',
}

const periods = [
  ['duringWork', '工作时段'],
  ['afterWork', '下班时段'],
  ['offDay', '休息日'],
  ['awayFallback', '网页不可达时'],
  ['urgentDestination', '紧急例外'],
] as const

export function MandatePolicyFields({
  value,
  onChange,
}: { value: MandatePolicy; onChange: (policy: MandatePolicy) => void }) {
  const [date, setDate] = useState('')
  const [dayKind, setDayKind] = useState<'work' | 'off'>('work')
  const overrides = value.dateOverrides ?? {}
  function patch(change: Partial<MandatePolicy>) {
    onChange({ ...value, ...change })
  }
  return (
    <div className="listener-stack">
      <div className="listener-fields">
        {periods.map(([key, label]) => (
          <label className="listener-field" key={key}>
            {label}
            <select
              value={value[key] ?? ''}
              onChange={(e) => patch({ [key]: e.target.value || undefined })}
            >
              <option value="">沿用上层偏好</option>
              {Object.entries(mandateDestinations).map(([id, name]) => (
                <option value={id} key={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <MandateOrderedRules
        value={value.rules ?? []}
        onChange={(rules) => patch({ rules: rules.length ? rules : undefined })}
        destinations={mandateDestinations}
      />
      <div className="listener-fields">
        <label className="listener-field">
          截止前多久使用紧急例外（分钟）
          <input
            type="number"
            min={0}
            max={10080}
            step={1}
            value={value.deadlineLeadMinutes ?? ''}
            placeholder="沿用上层，默认 60"
            onChange={(e) =>
              patch({
                deadlineLeadMinutes: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
          />
        </label>
        <label className="listener-field">
          静默开始
          <input
            type="time"
            value={value.quietStart ?? ''}
            onChange={(e) => patch({ quietStart: e.target.value || undefined })}
          />
        </label>
        <label className="listener-field">
          静默结束
          <input
            type="time"
            value={value.quietEnd ?? ''}
            onChange={(e) => patch({ quietEnd: e.target.value || undefined })}
          />
        </label>
        <label className="listener-field">
          摘要窗口（分钟）
          <input
            type="number"
            min={0}
            max={10080}
            step={1}
            placeholder="沿用上层偏好"
            value={value.digestMinutes ?? ''}
            onChange={(e) =>
              patch({ digestMinutes: e.target.value === '' ? undefined : Number(e.target.value) })
            }
          />
        </label>
      </div>
      <small>截止提前量填 0 表示不提前。摘要窗口填 0 可关闭汇总。静默时段按路由时区计算。</small>
      <div className="listener-stack">
        <div className="listener-row">
          <label className="listener-field">
            指定日期例外
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="listener-field">
            日期类型
            <select
              value={dayKind}
              onChange={(e) => setDayKind(e.target.value === 'off' ? 'off' : 'work')}
            >
              <option value="work">工作日</option>
              <option value="off">休息日</option>
            </select>
          </label>
          <button
            type="button"
            disabled={!date}
            onClick={() => {
              patch({ dateOverrides: { ...overrides, [date]: dayKind } })
              setDate('')
            }}
          >
            加入例外
          </button>
        </div>
        {Object.entries(overrides)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([day, kind]) => (
            <div className="listener-row" key={day}>
              <span>
                {day} · {kind === 'work' ? '工作日' : '休息日'}
              </span>
              <button
                type="button"
                aria-label={`移除日期例外 ${day}`}
                onClick={() => {
                  const remaining = { ...overrides }
                  delete remaining[day]
                  patch({ dateOverrides: remaining })
                }}
              >
                移除
              </button>
            </div>
          ))}
      </div>
    </div>
  )
}
