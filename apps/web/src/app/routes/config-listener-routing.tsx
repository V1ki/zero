import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  type TriggerRouteDestination,
  type TriggerRouteStatus,
  type TriggerRouteWork,
  type TriggerRoutingSettings,
  type TriggerRoutingSettingsSnapshot,
  getTriggerRouteBot,
  triggerRoutePlatforms,
} from '@zero-os/shared'
import { useState } from 'react'
import { apiFetch, apiPost, apiPut } from '../lib/api'
import { RetentionField } from './config-retention-field'
import { RoutingContextFields } from './config-routing-context'
import { RoutingPreview } from './config-routing-preview'
import { botDeliveryHints, useRoutingBots } from './routing-bots'

const base = '/api/listeners/routing'
const configKey = ['listeners', 'routing', 'config']
const resultsKey = ['listeners', 'routing', 'results']
const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const periods = [
  ['duringWork', '工作时段'],
  ['afterWork', '下班时段'],
  ['offDay', '休息日'],
] as const
const destinations: Record<TriggerRouteDestination, string> = {
  web: '网页',
  weixin: '微信',
  dingtalk: '钉钉',
  feishu: '飞书',
  defer: '延后提醒',
}
const statuses: Record<TriggerRouteStatus, string> = {
  pending: '等待 Agent',
  analyzing: 'Agent 正在分析',
  ready: '等待路由',
  web: '已投递网页',
  deferred: '已延后',
  sending: '正在发送',
  sent: '平台已受理',
  cancelled: '已撤销',
  failed: '处理失败',
  uncertain: '投递待确认',
}

export function useListenerRoutingConfig(enabled = true) {
  return useQuery({
    queryKey: configKey,
    enabled,
    queryFn: ({ signal }) =>
      apiFetch<TriggerRoutingSettingsSnapshot>(`${base}/preferences`, { signal }),
    retry: false,
  })
}

function PersonalDeliveryBots({
  settings,
  update,
}: { settings: TriggerRoutingSettings; update: (patch: Partial<TriggerRoutingSettings>) => void }) {
  const choices = useRoutingBots()
  return (
    <div className="listener-stack">
      <div className="listener-actions">
        <h3>Router 专用机器人</h3>
        <button type="button" disabled={choices.isFetching} onClick={() => void choices.refetch()}>
          {choices.isFetching ? '正在读取机器人…' : '刷新机器人'}
        </button>
      </div>
      <p className="listener-muted">
        保存后，Router 接管所选机器人的本人私聊。原来的普通 Agent 会话会解绑，历史记录保留。
      </p>
      <div className="listener-fields">
        {triggerRoutePlatforms.map((platform) => {
          const selected = getTriggerRouteBot(settings, platform)
          const options = choices.data?.bots.filter((bot) => bot.platform === platform) ?? []
          const current = options.find((bot) => bot.channelId === selected)
          return (
            <label className="listener-field" key={platform}>
              {destinations[platform]}机器人
              <select
                aria-label={`${destinations[platform]}机器人`}
                value={selected ?? ''}
                onChange={(event) =>
                  update({
                    personalBots: {
                      ...settings.personalBots,
                      [platform]: event.target.value || null,
                    },
                  })
                }
              >
                <option value="">未选择</option>
                {selected && !current && (
                  <option value={selected}>
                    {selected} · {choices.data ? '已移除' : '已保存'}
                  </option>
                )}
                {options.map((bot) => (
                  <option key={bot.channelId} value={bot.channelId}>
                    {bot.label}
                    {bot.online ? ' · 在线' : ' · 离线'}
                  </option>
                ))}
              </select>
              {choices.data && !options.length && (
                <small>暂无已接入的{destinations[platform]}机器人</small>
              )}
              {current && <small>{botDeliveryHints[current.deliveryState]}</small>}
              {selected && !current && choices.data && (
                <small>这个机器人已移除。请选择其他机器人。</small>
              )}
            </label>
          )
        })}
      </div>
      {choices.error && (
        <p className="listener-error" role="alert">
          {choices.error.message}
        </p>
      )}
    </div>
  )
}

export function ListenerRoutingSettings({
  config,
}: { config: ReturnType<typeof useListenerRoutingConfig> }) {
  const cache = useQueryClient()
  const [draft, setDraft] = useState<TriggerRoutingSettingsSnapshot | null>(null)
  const save = useMutation({
    mutationFn: (next: TriggerRoutingSettingsSnapshot) =>
      apiPut<TriggerRoutingSettingsSnapshot>(`${base}/preferences`, next),
    onSuccess: (saved) => {
      cache.setQueryData(configKey, saved)
      setDraft(null)
      void cache.invalidateQueries({ queryKey: resultsKey })
      void cache.invalidateQueries({ queryKey: ['router-workspace'] })
    },
  })
  const current = draft ?? config.data
  const settings = current?.settings
  const update = (patch: Partial<TriggerRoutingSettings>) => {
    if (!current) return
    save.reset()
    setDraft({ revision: current.revision, settings: { ...current.settings, ...patch } })
  }
  const dirty = draft !== null && JSON.stringify(settings) !== JSON.stringify(config.data?.settings)
  const invalidTime = settings && settings.workStart === settings.workEnd
  const missingBots = settings
    ? triggerRoutePlatforms.filter(
        (platform) =>
          [...periods.map(([key]) => settings[key]), settings.awayFallback].includes(platform) &&
          !getTriggerRouteBot(settings, platform),
      )
    : []
  return (
    <section id="routing-settings" aria-label="Agent 与通知路由" className="card listener-stack">
      <div className="listener-actions">
        <h2>Agent 与通知路由</h2>
        {config.data && (
          <span className="listener-tag">{config.data.settings.enabled ? '已启用' : '已暂停'}</span>
        )}
      </div>
      <p className="listener-muted">
        启用后，ZeRo 会把新入箱的命中片段交给当前配置的模型生成摘要，其中包括所选 WXARC
        会话中的匹配消息。保存规则后按时段和在场状态投递。历史事件可在收件箱中逐条提交。
      </p>
      {config.error && (
        <div className="listener-row">
          <p role="alert" className="listener-error">
            {config.error.message}
          </p>
          <button type="button" onClick={() => void config.refetch()}>
            重试读取路由设置
          </button>
        </div>
      )}
      {!settings && config.isLoading && <small>正在读取路由设置…</small>}
      {current && settings && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (dirty && !invalidTime) save.mutate(current)
          }}
        >
          <fieldset className="listener-stack listener-routing-form" disabled={save.isPending}>
            <label className="listener-row">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => update({ enabled: e.target.checked })}
              />
              启用 Agent 与通知路由
            </label>
            <div className="listener-fields">
              <label className="listener-field">
                时区
                <input
                  required
                  value={settings.timeZone}
                  placeholder="Asia/Shanghai"
                  onChange={(e) => update({ timeZone: e.target.value })}
                />
              </label>
              <label className="listener-field">
                工作开始
                <input
                  type="time"
                  required
                  value={settings.workStart}
                  onChange={(e) => update({ workStart: e.target.value })}
                />
              </label>
              <label className="listener-field">
                工作结束
                <input
                  type="time"
                  required
                  value={settings.workEnd}
                  onChange={(e) => update({ workEnd: e.target.value })}
                />
              </label>
            </div>
            {invalidTime && (
              <small className="listener-error">
                开始和结束时间必须不同。结束早于开始时按跨午夜处理。
              </small>
            )}
            <RetentionField
              value={settings.retentionDays}
              onChange={(retentionDays) => update({ retentionDays })}
            />
            <fieldset className="listener-weekdays">
              <legend className="listener-muted">工作日</legend>
              {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                <label key={day} className="listener-row">
                  <input
                    type="checkbox"
                    checked={settings.workdays.includes(day)}
                    onChange={(e) =>
                      update({
                        workdays: e.target.checked
                          ? [...settings.workdays, day].sort()
                          : settings.workdays.filter((d) => d !== day),
                      })
                    }
                  />
                  {days[day]}
                </label>
              ))}
            </fieldset>
            <PersonalDeliveryBots settings={settings} update={update} />
            <div className="listener-fields">
              {periods.map(([key, label]) => (
                <label key={key} className="listener-field">
                  {label}
                  <select value={settings[key]} onChange={(e) => update({ [key]: e.target.value })}>
                    {Object.entries(destinations).map(([destination, text]) => (
                      <option key={destination} value={destination}>
                        {text}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="listener-fields">
              <label className="listener-field">
                在场状态
                <select
                  value={settings.presence}
                  onChange={(e) =>
                    update({ presence: e.target.value as TriggerRoutingSettings['presence'] })
                  }
                >
                  <option value="auto">自动 · 最近两分钟有网页操作</option>
                  <option value="present">手动 · 在电脑前</option>
                  <option value="away">手动 · 已离开</option>
                </select>
              </label>
              <label className="listener-field">
                网页无人时
                <select
                  value={settings.awayFallback}
                  onChange={(e) =>
                    update({
                      awayFallback: e.target.value as TriggerRoutingSettings['awayFallback'],
                    })
                  }
                >
                  <option value="defer">延后提醒</option>
                  {triggerRoutePlatforms.map((platform) => (
                    <option key={platform} value={platform}>
                      转到{destinations[platform]}机器人
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <RoutingContextFields settings={settings} update={update} />
            {missingBots.length > 0 && (
              <small>
                当前规则会投递{missingBots.map((platform) => destinations[platform]).join('、')}
                。选择可用的机器人之前，这些通知会延后。
              </small>
            )}
            <div className="listener-row">
              <button className="listener-primary" type="submit" disabled={!dirty || !!invalidTime}>
                {save.isPending ? '正在保存…' : '保存路由设置'}
              </button>
              {dirty ? (
                <small>有未保存的修改</small>
              ) : (
                save.isSuccess && <output className="listener-info">已保存路由设置</output>
              )}
            </div>
            {save.error && (
              <div className="listener-row">
                <p role="alert" className="listener-error">
                  {save.error.message}
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    const latest = await config.refetch()
                    if (latest.isSuccess) {
                      setDraft(null)
                      save.reset()
                    }
                  }}
                >
                  放弃路由修改并重新载入
                </button>
              </div>
            )}
          </fieldset>
        </form>
      )}
      {settings && <RoutingPreview settings={settings} />}
    </section>
  )
}

export function ProcessInboxEvent({
  inboxId,
  retry = false,
}: { inboxId: number; retry?: boolean }) {
  const cache = useQueryClient()
  const process = useMutation({
    mutationFn: () => apiPost<{ accepted: boolean }>(`${base}/process`, { inboxId }),
    onSuccess: () => cache.invalidateQueries({ queryKey: resultsKey }),
  })
  return (
    <div className="listener-row listener-process">
      <button
        type="button"
        disabled={process.isPending || (!retry && process.isSuccess)}
        onClick={() => process.mutate()}
      >
        {process.isPending ? '正在提交…' : retry ? '重新处理' : '交给 Agent'}
      </button>
      {!retry && process.isSuccess && (
        <output>
          {process.data.accepted ? '已加入处理队列' : '已有处理记录'} ·{' '}
          <a href="#routing-records">查看路由记录</a>
        </output>
      )}
      {process.error && (
        <span role="alert" className="listener-error">
          {process.error.message}
        </span>
      )}
    </div>
  )
}

function RoutingEntry({
  event,
  route,
  routingEnabled,
  id,
}: TriggerRouteWork & { routingEnabled: boolean; id?: string }) {
  const decision = route.decision
  const target =
    route.deliveryTarget ??
    (route.weixinTarget && { ...route.weixinTarget, platform: 'weixin' as const })
  const platform = target ? destinations[target.platform] : ''
  const status =
    platform && ['sending', 'sent', 'uncertain'].includes(route.status)
      ? `${platform}${statuses[route.status]}`
      : statuses[route.status]
  return (
    <article id={id} className="listener-stack listener-route-entry">
      <div className="listener-actions">
        <span className="listener-muted">
          {event.source === 'github' ? 'GitHub' : 'WXARC'} · {event.scope} · #{event.id}
        </span>
        <span
          className={
            route.status === 'failed' || route.status === 'uncertain'
              ? 'listener-error'
              : 'listener-route-status'
          }
        >
          {status}
        </span>
      </div>
      <h3>{event.title}</h3>
      <Link to="/router" search={{ event: event.id }}>
        在 Router 中继续
      </Link>
      {route.agent && (
        <p className="listener-body">
          <b>Agent 摘要</b>　{route.agent.summary}
        </p>
      )}
      {decision && (
        <p>
          <b>路由原因</b>　{decision.reason}
        </p>
      )}
      {route.firstDeferred && route.status !== 'deferred' && (
        <p className="listener-muted">
          首次延后 ·{' '}
          <time dateTime={route.firstDeferred.at}>
            {new Date(route.firstDeferred.at).toLocaleString()}
          </time>{' '}
          · {route.firstDeferred.reason}
        </p>
      )}
      {target && (
        <small>
          {platform}机器人 · {target.channelId}
        </small>
      )}
      {decision?.destination === 'defer' && (
        <small>
          {Date.parse(decision.recheckAt) <= Date.now() ? '复查时间已到' : '下次复查'} ·{' '}
          <time dateTime={decision.recheckAt}>{new Date(decision.recheckAt).toLocaleString()}</time>
        </small>
      )}
      {route.error && <p className="listener-error">{route.error}</p>}
      {route.status === 'uncertain' && (
        <small>请在{platform}核对机器人的投递结果，系统已停止重发。</small>
      )}
      {route.status === 'cancelled' && (
        <small>来源监听已暂停或筛选已变更。如需处理这条历史事件，可以手动重新提交。</small>
      )}
      {(route.status === 'failed' || route.status === 'cancelled') && routingEnabled && (
        <ProcessInboxEvent retry inboxId={event.id} />
      )}
      <small>
        {route.origin === 'manual' ? '手动提交' : '自动监听'} · 更新于{' '}
        <time dateTime={route.updatedAt}>{new Date(route.updatedAt).toLocaleString()}</time>
        {route.sessionId && <> · 分析编号 {route.sessionId}</>}
        {event.source === 'github' && event.url?.startsWith('https://github.com/') && (
          <>
            {' '}
            ·{' '}
            <a href={event.url} target="_blank" rel="noreferrer">
              查看原始事件
            </a>
          </>
        )}
      </small>
    </article>
  )
}

export function useListenerRoutingResults(kind: 'web' | 'records') {
  return useQuery({
    queryKey: [...resultsKey, kind],
    queryFn: ({ signal }) =>
      apiFetch<{ records: TriggerRouteWork[] }>(`${base}/${kind}?limit=50`, { signal }),
    retry: false,
    refetchInterval: (q) => (q.state.status === 'error' ? false : 15000),
  })
}

export function ListenerRoutingResults({
  kind,
  query,
  routingEnabled,
}: {
  kind: 'web' | 'records'
  query: ReturnType<typeof useListenerRoutingResults>
  routingEnabled: boolean
}) {
  const webOnly = kind === 'web'
  const title = webOnly ? '网页通知' : '路由记录'
  return (
    <section
      id={webOnly ? 'routing-web' : 'routing-records'}
      className="card listener-stack listener-routing-results"
      aria-label={title}
    >
      <div className="listener-actions">
        <h2>{title}</h2>
        <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
          刷新{title}
        </button>
      </div>
      <p className="listener-muted">
        {webOnly ? (
          <>
            最近 50 条由基础路由送达网页的提醒。
            <Link to="/router" search={{ view: 'notifications' }}>
              查看全部网页提醒及委托任务
            </Link>
          </>
        ) : (
          '最近 50 条处理记录，含各平台的投递状态、延后复查和失败原因。'
        )}
      </p>
      {query.isLoading && <small>正在读取…</small>}
      {query.error && (
        <p className="listener-error" role="alert">
          {query.error.message}
        </p>
      )}
      {query.data?.records.length === 0 && (
        <small>{webOnly ? '暂无由基础路由投递的网页通知。' : '暂无路由记录。'}</small>
      )}
      {query.data?.records.map((work) => (
        <RoutingEntry
          key={work.route.inboxId}
          {...work}
          routingEnabled={routingEnabled}
          id={webOnly ? undefined : `routing-record-${work.route.inboxId}`}
        />
      ))}
    </section>
  )
}
