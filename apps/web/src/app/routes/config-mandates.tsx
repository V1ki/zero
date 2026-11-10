import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  MandatePolicy,
  TriggerMandate,
  TriggerMandateProject,
  TriggerMandateSettings,
  TriggerMandateSnapshot,
  TriggerSettings,
} from '@zero-os/shared'
import { useEffect, useState } from 'react'
import { apiFetch, apiPut } from '../lib/api'
import { MandatePreview, localInputDate } from './config-mandate-preview'
import { MandateTargets } from './config-mandate-targets'
import { MandatePolicyFields } from './mandate-policy-fields'
import './config-mandates.css'

export const mandateConfigKey = ['listeners', 'mandates', 'config']
const base = '/api/listeners/mandates/config'

function isMandate(row: TriggerMandate | TriggerMandateProject): row is TriggerMandate {
  return 'source' in row
}

function sourceChoices(sources: TriggerSettings, source: TriggerMandate['source']) {
  return source === 'github'
    ? sources.github.repositories.map((row) => ({
        id: row.name,
        name: row.name,
        enabled: row.enabled,
      }))
    : sources.wxarc.sessions
}

function createMandate(): TriggerMandate {
  return {
    id: crypto.randomUUID(),
    name: '',
    purpose: '',
    processing: 'agent',
    source: 'github',
    scope: '',
    enabled: true,
    keyword: '',
    projectId: null,
    targets: [],
    archive: null,
    policy: {},
    deadline: null,
    urgent: false,
  }
}

function policyError(policy: MandatePolicy) {
  if (
    policy.deadlineLeadMinutes !== undefined &&
    (!Number.isInteger(policy.deadlineLeadMinutes) ||
      policy.deadlineLeadMinutes < 0 ||
      policy.deadlineLeadMinutes > 10080)
  )
    return '截止提前量应为 0 至 10080 之间的整数分钟数。'
  for (const [index, rule] of (policy.rules ?? []).entries()) {
    if (!rule.name.trim()) return `请填写情境规则 ${index + 1} 的名称。`
    if (!Object.values(rule.when).some((condition) => condition !== undefined))
      return `请为情境规则 ${index + 1} 至少选择一项条件。`
  }
  if (
    !!policy.quietStart !== !!policy.quietEnd ||
    (policy.quietStart && policy.quietStart === policy.quietEnd)
  )
    return '请填写不同的静默开始和结束时间，或将两项都留空。'
  if (
    policy.digestMinutes !== undefined &&
    (!Number.isInteger(policy.digestMinutes) ||
      policy.digestMinutes < 0 ||
      policy.digestMinutes > 10080)
  )
    return '摘要窗口应为 0 至 10080 之间的整数分钟数。'
}

function validate(settings: TriggerMandateSettings) {
  for (const project of settings.projects) {
    if (!project.name.trim()) return '请填写项目名称。'
    const issue = policyError(project.policy)
    if (issue) return `${project.name} · ${issue}`
  }
  for (const mandate of settings.mandates) {
    if (!mandate.name.trim()) return '请填写委托名称。'
    const issues = [
      !mandate.purpose.trim() && '请填写跟踪目的。',
      !mandate.scope && '请选择已保存的监听范围。',
      mandate.archive &&
        (!mandate.archive.channelId || !/^[A-Za-z0-9]{1,128}$/.test(mandate.archive.documentId)) &&
        '请选择归档账号并填写有效的飞书文档 ID。',
      policyError(mandate.policy),
    ]
    const issue = issues.find(Boolean)
    if (issue) return `${mandate.name} · ${issue}`
  }
}

function MandateEditor({
  value,
  projects,
  sources,
  onChange,
}: {
  value: TriggerMandate
  projects: TriggerMandateProject[]
  sources: TriggerSettings
  onChange: (patch: Partial<TriggerMandate>) => void
}) {
  const choices = sourceChoices(sources, value.source)
  return (
    <div className="listener-stack mandate-editor">
      <div className="listener-fields">
        <label className="listener-field">
          委托名称
          <input
            maxLength={120}
            value={value.name}
            placeholder="例如，跟踪发布阻塞"
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </label>
        <label className="listener-field">
          所属项目
          <select
            value={value.projectId ?? ''}
            onChange={(e) => onChange({ projectId: e.target.value || null })}
          >
            <option value="">无项目</option>
            {projects.map((project) => (
              <option value={project.id} key={project.id}>
                {project.name || '未命名项目'}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="listener-field">
        跟踪目的
        <textarea
          maxLength={2000}
          rows={2}
          value={value.purpose}
          placeholder="哪些变化值得跟进？你希望看到什么结果？"
          onChange={(e) => onChange({ purpose: e.target.value })}
        />
      </label>
      <div className="listener-fields">
        <label className="listener-field">
          委托来源
          <select
            value={value.source}
            onChange={(e) => {
              const source = e.target.value === 'github' ? 'github' : 'wxarc'
              onChange({
                source,
                scope: '',
                // Reading GitHub details applies only to GitHub mandates.
                ...(source !== 'github' &&
                  value.processing === 'investigate' && { processing: 'agent' }),
              })
            }}
          >
            <option value="github">GitHub</option>
            <option value="wxarc">WXARC 微信</option>
          </select>
        </label>
        <label className="listener-field">
          {value.source === 'github' ? '已监听的仓库' : '已监听的微信会话'}
          <select value={value.scope} onChange={(e) => onChange({ scope: e.target.value })}>
            <option value="">选择监听范围…</option>
            {value.scope && !choices.some((entry) => entry.id === value.scope) && (
              <option value={value.scope}>已移除 · {value.scope}</option>
            )}
            {choices.map((entry) => (
              <option key={entry.id} value={entry.id} disabled={!entry.enabled}>
                {entry.name || entry.id}
                {entry.enabled ? '' : '（已暂停）'}
              </option>
            ))}
          </select>
        </label>
        <label className="listener-field">
          委托关键词
          <input
            maxLength={256}
            value={value.keyword}
            placeholder="留空则匹配范围内全部入箱事件"
            onChange={(e) => onChange({ keyword: e.target.value })}
          />
        </label>
      </div>
      {value.scope && !choices.some((entry) => entry.id === value.scope && entry.enabled) && (
        <small>此监听范围已暂停或移除。恢复来源后才能继续接收新事件。</small>
      )}
      <div className="listener-fields">
        <label className="listener-field">
          事件处理方式
          <select
            value={value.processing ?? 'agent'}
            aria-describedby="mandate-processing-description"
            onChange={(e) => {
              const mode = e.target.value
              onChange({
                processing:
                  mode === 'direct' || (mode === 'investigate' && value.source === 'github')
                    ? mode
                    : 'agent',
              })
            }}
          >
            <option value="agent">Agent 归纳</option>
            {value.source === 'github' && (
              <option value="investigate">读取 GitHub 详情后提醒</option>
            )}
            <option value="direct">直接生成事实提醒</option>
          </select>
        </label>
        <label className="listener-field">
          任务归并
          <select
            value={value.groupBy ?? 'thread'}
            onChange={(e) => {
              const kind = e.target.value
              onChange({ groupBy: kind === 'mandate' || kind === 'event' ? kind : 'thread' })
            }}
          >
            <option value="thread">按 PR 或工作流运行归并，微信逐条跟踪</option>
            <option value="mandate">整条委托持续跟进</option>
            <option value="event">每条事件单独跟进</option>
          </select>
        </label>
        <label className="listener-field">
          委托截止时间（{Intl.DateTimeFormat().resolvedOptions().timeZone}）
          <input
            type="datetime-local"
            value={value.deadline ? localInputDate(new Date(value.deadline)) : ''}
            onChange={(e) =>
              onChange({ deadline: e.target.value ? new Date(e.target.value).toISOString() : null })
            }
          />
        </label>
        <div className="listener-row">
          <label className="listener-row">
            <input
              type="checkbox"
              checked={value.urgent}
              onChange={(e) => onChange({ urgent: e.target.checked })}
            />
            紧急委托
          </label>
          <label className="listener-row">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(e) => onChange({ enabled: e.target.checked })}
            />
            启用此委托
          </label>
        </div>
      </div>
      <small id="mandate-processing-description">
        {value.processing === 'direct'
          ? '按固定格式整理命中事件，无需调用模型。提醒时间和去向仍由 Router 按偏好决定。'
          : value.processing === 'investigate'
            ? '分诊决定提醒后，Agent 先用监听凭证只读查看该仓库自身的 Actions 失败记录或 PR 记录，在提醒中写明出了什么问题、是否需要你处理，不做任何更改，提醒最多可能因此晚约一分半钟。'
            : 'Agent 会结合跟踪目的归纳每次命中的事件。'}
      </small>
      <details className="listener-item">
        <summary>提醒受众与成果归档</summary>
        <MandateTargets value={value} onChange={onChange} />
      </details>
      <details className="listener-item">
        <summary>覆盖此委托的时段与提醒偏好</summary>
        <p className="listener-muted">
          留空沿用所属项目或个人偏好。紧急委托或进入截止提前窗口时可采用紧急例外去向。
        </p>
        <MandatePolicyFields value={value.policy} onChange={(policy) => onChange({ policy })} />
      </details>
    </div>
  )
}

export function ConfigMandates({
  sources,
  routingEnabled,
}: { sources: TriggerSettings; routingEnabled?: boolean }) {
  const cache = useQueryClient()
  const config = useQuery({
    queryKey: mandateConfigKey,
    queryFn: ({ signal }) => apiFetch<TriggerMandateSnapshot>(base, { signal }),
    retry: false,
  })
  const [draft, setDraft] = useState<TriggerMandateSnapshot | null>(null)
  const [tab, setTab] = useState<'mandates' | 'projects'>('mandates')
  const [selection, setSelection] = useState(
    () => new URLSearchParams(window.location.search).get('mandate') ?? '',
  )
  const loaded = !!config.data
  useEffect(() => {
    if (loaded && window.location.hash === '#mandates') {
      const frame = requestAnimationFrame(() =>
        document.getElementById('mandates')?.scrollIntoView(),
      )
      return () => cancelAnimationFrame(frame)
    }
  }, [loaded])
  const [filter, setFilter] = useState('')
  const current = draft ?? config.data
  const save = useMutation({
    mutationFn: (snapshot: TriggerMandateSnapshot) =>
      apiPut<TriggerMandateSnapshot>(base, snapshot),
    onSuccess: (saved) => {
      cache.setQueryData(mandateConfigKey, saved)
      setDraft(null)
      void cache.invalidateQueries({ queryKey: ['listeners', 'mandates', 'tasks'] })
    },
  })
  function edit(settings: TriggerMandateSettings) {
    if (!current) return
    save.reset()
    setDraft({ revision: current.revision, settings })
  }
  const settings = current?.settings
  const rows = settings?.[tab] ?? []
  const needle = filter.trim().toLocaleLowerCase()
  const visible = rows.filter((row) =>
    [row.name, ...(isMandate(row) ? [row.scope, row.purpose, row.keyword] : [])].some((text) =>
      text.toLocaleLowerCase().includes(needle),
    ),
  )
  const active = visible.find((row) => row.id === selection) ?? visible[0]
  const mandate =
    tab === 'mandates' ? settings?.mandates.find((row) => row.id === active?.id) : undefined
  const project =
    tab === 'projects' ? settings?.projects.find((row) => row.id === active?.id) : undefined
  const dirty = !!draft && JSON.stringify(draft.settings) !== JSON.stringify(config.data?.settings)
  const error = settings && validate(settings)
  const databaseChanged = !!draft && config.data && draft.revision !== config.data.revision
  function add() {
    if (!settings) return
    setFilter('')
    if (tab === 'mandates') {
      const next = createMandate()
      edit({ ...settings, mandates: [...settings.mandates, next] })
      setSelection(next.id)
    } else {
      const next: TriggerMandateProject = { id: crypto.randomUUID(), name: '', policy: {} }
      edit({ ...settings, projects: [...settings.projects, next] })
      setSelection(next.id)
    }
  }
  async function reload() {
    const result = await config.refetch()
    if (result.isSuccess) {
      setDraft(null)
      save.reset()
    }
  }
  return (
    <section
      className="card listener-stack mandate-config"
      id="mandates"
      aria-label="长期委托与项目"
    >
      <div className="listener-actions">
        <div>
          <h2>长期委托与项目</h2>
          <p className="listener-muted">
            一个仓库或会话可有多条委托。各自决定跟踪目的、允许的受众和提醒时机。
          </p>
        </div>
        <a className="mandate-link" href="/router?view=tasks">
          查看持续任务 →
        </a>
      </div>
      {routingEnabled === false && (
        <p className="listener-muted">
          当前只接收入箱事件。需要自动建立持续任务时，请在{' '}
          <a className="mandate-link" href="#routing-settings">
            Agent 与通知路由
          </a>{' '}
          开启主动处理。
        </p>
      )}
      {config.error && (
        <div className="listener-row">
          <p role="alert" className="listener-error">
            {config.error.message}
          </p>
          <button type="button" onClick={() => void config.refetch()}>
            重试读取委托
          </button>
        </div>
      )}
      {config.isLoading && <small>正在读取委托…</small>}
      {settings && (
        <fieldset disabled={save.isPending} className="listener-stack">
          <div className="listener-actions">
            <div className="mandate-tabs" aria-label="管理对象">
              {(['mandates', 'projects'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={kind === tab}
                  onClick={() => {
                    setTab(kind)
                    setFilter('')
                    setSelection('')
                  }}
                >
                  {kind === 'mandates' ? '委托' : '项目'} · {settings[kind].length}
                </button>
              ))}
            </div>
            <button type="button" onClick={add}>
              {tab === 'mandates' ? '新增委托' : '新增项目'}
            </button>
          </div>
          {rows.length ? (
            <div className="mandate-layout">
              <div className="mandate-index">
                <label className="listener-field">
                  筛选{tab === 'mandates' ? '委托' : '项目'}
                  <input
                    type="search"
                    value={filter}
                    placeholder="输入名称或来源…"
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </label>
                {visible.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    aria-pressed={active?.id === row.id}
                    onClick={() => setSelection(row.id)}
                  >
                    <strong>{row.name || '尚未命名'}</strong>
                    <small>
                      {isMandate(row)
                        ? `${row.enabled ? '' : '已暂停 · '}${row.scope || '待选来源'}`
                        : `${settings.mandates.filter((m) => m.projectId === row.id).length} 条委托`}
                    </small>
                  </button>
                ))}
                {!visible.length && <small>没有匹配项。</small>}
              </div>
              <div className="listener-stack mandate-current" key={active?.id}>
                {mandate && (
                  <>
                    <MandateEditor
                      value={mandate}
                      sources={sources}
                      projects={settings.projects}
                      onChange={(patch) =>
                        edit({
                          ...settings,
                          mandates: settings.mandates.map((row) =>
                            row.id === mandate.id ? { ...row, ...patch } : row,
                          ),
                        })
                      }
                    />
                    {!dirty && (
                      <MandatePreview
                        key={`${mandate.id}-${current?.revision}`}
                        mandateId={mandate.id}
                      />
                    )}
                  </>
                )}
                {project && (
                  <>
                    <label className="listener-field">
                      项目名称
                      <input
                        maxLength={120}
                        value={project.name}
                        onChange={(e) =>
                          edit({
                            ...settings,
                            projects: settings.projects.map((row) =>
                              row.id === project.id ? { ...row, name: e.target.value } : row,
                            ),
                          })
                        }
                      />
                    </label>
                    <p className="listener-muted">
                      该项目内的委托会继承下面的偏好。每条委托仍须单独授权接收会话。
                    </p>
                    <MandatePolicyFields
                      value={project.policy}
                      onChange={(policy) =>
                        edit({
                          ...settings,
                          projects: settings.projects.map((row) =>
                            row.id === project.id ? { ...row, policy } : row,
                          ),
                        })
                      }
                    />
                  </>
                )}
                {active && (
                  <div className="listener-row">
                    <button
                      type="button"
                      disabled={
                        !!project && settings.mandates.some((row) => row.projectId === project.id)
                      }
                      onClick={() => {
                        edit({
                          ...settings,
                          [tab]: settings[tab].filter((row) => row.id !== active.id),
                        })
                        setSelection('')
                      }}
                    >
                      移除{mandate ? '这条委托' : '这个项目'}
                    </button>
                    {project && settings.mandates.some((row) => row.projectId === project.id) && (
                      <small>先转移项目内的委托即可移除。</small>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className="mandate-empty">
              {tab === 'mandates'
                ? '还没有长期委托。选择一个已监听的来源，写下希望持续跟踪的事。'
                : '还没有项目。可将相关委托放在同一项目下，共用提醒偏好。'}
            </p>
          )}
          <div className="listener-row">
            <button
              type="button"
              className="listener-primary"
              disabled={!dirty || !!error || !!databaseChanged}
              onClick={() => current && save.mutate(current)}
            >
              {save.isPending ? '正在保存…' : '保存委托与项目'}
            </button>
            {draft && (
              <button type="button" onClick={() => void reload()}>
                放弃委托草稿并重新载入
              </button>
            )}
            {dirty && <small>有未保存的修改</small>}
            {!dirty && save.isSuccess && (
              <output className="listener-info">委托与项目已保存</output>
            )}
          </div>
          {dirty && error && <small className="listener-error">{error}</small>}
          {databaseChanged && (
            <p role="alert" className="listener-error">
              其他入口已更新配置，请重新载入最新版本后编辑。
            </p>
          )}
          {save.error && (
            <p className="listener-error" role="alert">
              {save.error.message}
            </p>
          )}
        </fieldset>
      )}
    </section>
  )
}
