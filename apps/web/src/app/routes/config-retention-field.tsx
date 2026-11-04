import { type TriggerRetentionDays, triggerRetentionPeriods } from '@zero-os/shared'

export function RetentionField({
  value,
  onChange,
}: { value?: TriggerRetentionDays | null; onChange: (days: TriggerRetentionDays | null) => void }) {
  return (
    <label className="listener-field">
      已完成事项的正文保留时间
      <select
        value={value ?? ''}
        onChange={(event) =>
          onChange(
            triggerRetentionPeriods.find((days) => String(days) === event.target.value) ?? null,
          )
        }
      >
        <option value="">一直保留</option>
        {triggerRetentionPeriods.map((days) => (
          <option key={days} value={days}>
            {days} 天
          </option>
        ))}
      </select>
      <small>
        首次启用或重新启用后，已有记录也会完整保留所选天数。到期后清除本机事件、摘要与已完成对话的正文。正在跟进、待确认或可重试的事项继续保留。
      </small>
    </label>
  )
}
