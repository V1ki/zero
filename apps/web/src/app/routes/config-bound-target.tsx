import type { MandatePlatform, MandateTarget } from '@zero-os/shared'

export type BoundOption = MandateTarget & { label: string }

const targetKey = (target: MandateTarget) =>
  JSON.stringify([target.channelId, target.peerId, target.operatorId])

export function BoundTargetSelect({
  platform,
  label,
  emptyLabel,
  selected,
  targets,
  onChange,
}: {
  platform: MandatePlatform
  label: string
  emptyLabel: string
  selected?: MandateTarget | null
  targets?: BoundOption[]
  onChange: (target: MandateTarget | null) => void
}) {
  const options = new Map(
    targets
      ?.filter((entry) => entry.platform === platform)
      .map((entry) => [targetKey(entry), entry]),
  )
  const current = selected ? targetKey(selected) : ''
  return (
    <div className="listener-stack">
      <label className="listener-field">
        {label}
        <select
          value={current}
          onChange={(e) => {
            const entry = options.get(e.target.value)
            onChange(
              entry
                ? {
                    platform,
                    channelId: entry.channelId,
                    peerId: entry.peerId,
                    ...(entry.operatorId && { operatorId: entry.operatorId }),
                  }
                : null,
            )
          }}
        >
          <option value="">{emptyLabel}</option>
          {selected && !options.has(current) && (
            <option value={current}>
              {targets ? '已保存 · 当前不可用' : '已保存'} · {selected.channelId} /{' '}
              {selected.peerId}
            </option>
          )}
          {Array.from(options, ([key, entry]) => (
            <option key={key} value={key}>
              {entry.label} · {entry.peerId}
            </option>
          ))}
        </select>
      </label>
      {selected && platform !== 'weixin' && (
        <small>授权操作人 · {selected.operatorId ?? '仅投递'}</small>
      )}
    </div>
  )
}
