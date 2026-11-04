import type { MandateContextRule, MandateDestination } from '@zero-os/shared'

type Rule = MandateContextRule
const maxRules = 12
const periods = [
  ['duringWork', '工作时段'],
  ['afterWork', '下班时段'],
  ['offDay', '休息日'],
] as const
const presence = [
  ['present', '在电脑前'],
  ['away', '已离开'],
  ['unknown', '未知'],
] as const
const urgency = [
  ['urgent', '紧急'],
  ['normal', '普通'],
] as const
const quiet = [
  ['yes', '静默时段内'],
  ['no', '静默时段外'],
] as const

function Condition<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string
  value?: T
  choices: ReadonlyArray<readonly [T, string]>
  onChange: (value?: T) => void
}) {
  return (
    <label className="listener-field">
      {label}
      <select
        value={value ?? ''}
        onChange={(e) => onChange(choices.find(([id]) => id === e.target.value)?.[0])}
      >
        <option value="">不限</option>
        {choices.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </label>
  )
}

export function MandateOrderedRules({
  value,
  onChange,
  destinations,
}: {
  value: Rule[]
  onChange: (rules: Rule[]) => void
  destinations: Record<MandateDestination, string>
}) {
  function replace(index: number, patch: Partial<Rule>) {
    onChange(value.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)))
  }
  function move(index: number, offset: -1 | 1) {
    const ordered = [...value]
    const [selected] = ordered.splice(index, 1)
    ordered.splice(index + offset, 0, selected)
    onChange(ordered)
  }
  return (
    <details className="listener-item mandate-order">
      <summary>自定义情境顺序</summary>
      <p className="listener-muted">
        每层采用从上往下第一条满足全部条件的规则。委托已有匹配规则、本时段去向或生效的紧急例外时优先，其余情况继续检查项目规则。
      </p>
      <small>
        时段设置为“不发提醒”时始终静默。要在静默时段提醒，请明确选择“静默时段内”。选中“紧急”的规则命中时可以跳过摘要等待。外部提醒只会发往委托已授权的会话。
      </small>
      <div className="listener-stack">
        {value.map((rule, index) => {
          const condition = (change: Partial<Rule['when']>) =>
            replace(index, { when: { ...rule.when, ...change } })
          return (
            <fieldset className="listener-item mandate-rule" key={rule.id}>
              <legend>规则 {index + 1}</legend>
              <div className="listener-fields">
                <label className="listener-field">
                  规则名称
                  <input
                    value={rule.name}
                    maxLength={80}
                    placeholder="例如，离开时先延后"
                    onChange={(e) => replace(index, { name: e.target.value })}
                  />
                </label>
                <label className="listener-field">
                  命中去向
                  <select
                    value={rule.destination}
                    onChange={(e) =>
                      replace(index, { destination: e.target.value as MandateDestination })
                    }
                  >
                    {Object.entries(destinations).map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="listener-fields">
                <Condition
                  label="适用时段"
                  choices={periods}
                  value={rule.when.period}
                  onChange={(period) => condition({ period })}
                />
                <Condition
                  label="在场条件"
                  choices={presence}
                  value={rule.when.presence}
                  onChange={(presence) => condition({ presence })}
                />
                <Condition
                  label="紧急程度"
                  choices={urgency}
                  value={rule.when.urgency}
                  onChange={(urgency) => condition({ urgency })}
                />
                <Condition
                  label="静默条件"
                  choices={quiet}
                  value={rule.when.quiet === undefined ? undefined : rule.when.quiet ? 'yes' : 'no'}
                  onChange={(state) =>
                    condition({ quiet: state === undefined ? undefined : state === 'yes' })
                  }
                />
              </div>
              <div className="listener-row">
                <button type="button" disabled={!index} onClick={() => move(index, -1)}>
                  上移
                </button>
                <button
                  type="button"
                  disabled={index === value.length - 1}
                  onClick={() => move(index, 1)}
                >
                  下移
                </button>
                <button
                  type="button"
                  onClick={() => onChange(value.filter((entry) => entry.id !== rule.id))}
                >
                  删除规则
                </button>
              </div>
            </fieldset>
          )
        })}
        <div className="listener-row">
          <button
            type="button"
            disabled={value.length >= maxRules}
            onClick={() =>
              onChange([
                ...value,
                {
                  id: crypto.randomUUID(),
                  name: '',
                  when: { period: 'duringWork' },
                  destination: 'defer',
                },
              ])
            }
          >
            添加情境规则
          </button>
          <small>
            {value.length} / {maxRules} 条
          </small>
        </div>
      </div>
    </details>
  )
}
