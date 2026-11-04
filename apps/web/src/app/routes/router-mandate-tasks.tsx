import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type {
  MandateAnalysisStatus,
  MandateAuditEntry,
  MandateEffect,
  MandateEffectStatus,
  MandateMatch,
  MandateTask,
  MandateTaskDetail,
  TriggerMandateSnapshot,
} from '@zero-os/shared'
import { type ReactNode, useState } from 'react'
import { apiFetch, apiPost, apiPut } from '../lib/api'
import { mandateConfigKey } from './config-mandates'
import { mandateDestinations } from './mandate-policy-fields'
import './router-mandate-tasks.css'

const base = '/api/listeners/mandates'
const tasksKey = ['listeners', 'mandates', 'tasks']
const pageSize = 25
const statusName: Record<MandateAnalysisStatus, string> = {
  pending: '待分析',
  analyzing: '正在分析',
  ready: '已分析',
  failed: '分析失败',
  revoked: '已撤销',
}
const effectStatus: Record<MandateEffectStatus, string> = {
  pending: '待处理',
  deferred: '已延后',
  sending: '执行中',
  done: '已完成',
  failed: '失败',
  unknown: '结果待核对',
  revoked: '已撤销',
  skipped: '已跳过',
}
type WorkKind = 'notify' | 'archive' | 'analysis'
const workNames: Record<WorkKind, string> = { notify: '提醒', archive: '归档', analysis: '分析' }

function taskState(task: MandateTask) {
  if (!task.active) return '已终止'
  return task.paused ? '已暂停' : '跟踪中'
}

function EffectRow({
  effect,
  retry,
  busy,
}: { effect: MandateEffect; retry: (kind: WorkKind) => void; busy: boolean }) {
  const label = workNames[effect.kind]
  const target = effect.target
  const name =
    effect.destination === 'archive'
      ? '飞书文档'
      : effect.destination
        ? mandateDestinations[effect.destination]
        : ''
  return (
    <section className="mt-effect" aria-label={label} data-status={effect.status}>
      <strong>
        {label} · {effectStatus[effect.status]}
        {name && ` · ${name}`}
      </strong>
      {effect.reason && <span>{effect.reason}</span>}
      {target && (
        <small>
          {target.channelId} / {'documentId' in target ? target.documentId : target.peerId}
        </small>
      )}
      {effect.dueAt && <small>计划复核于 {new Date(effect.dueAt).toLocaleString()}</small>}
      {effect.receipt && effect.status === 'failed' && (
        <span className="rw-error">{effect.receipt}</span>
      )}
      {effect.receipt && effect.status !== 'failed' && (
        <details>
          <summary>查看回执</summary>
          <code>{effect.receipt}</code>
        </details>
      )}
      {effect.status === 'unknown' && <small>请先在目标平台核对这次操作的结果。</small>}
      {effect.status === 'failed' && (
        <button
          type="button"
          className="rw-inline-button"
          disabled={busy}
          onClick={() => retry(effect.kind)}
        >
          重试{label}
        </button>
      )}
    </section>
  )
}

function TimelineEntry({
  match,
  retry,
  busy,
}: { match: MandateMatch; retry: (kind: WorkKind) => void; busy: boolean }) {
  return (
    <li className="mt-match">
      <div className="mt-match-head">
        <Link to="/router" search={{ event: match.inboxId }}>
          原始事件 #{match.inboxId}
        </Link>
        <span>{statusName[match.status]}</span>
      </div>
      {match.summary && <p>{match.summary}</p>}
      {match.error && <p className="rw-error">{match.error}</p>}
      {match.status === 'failed' && (
        <button
          type="button"
          className="rw-inline-button"
          disabled={busy}
          onClick={() => retry('analysis')}
        >
          重试分析
        </button>
      )}
      {match.effects.map((effect) => (
        <EffectRow key={effect.kind} effect={effect} retry={retry} busy={busy} />
      ))}
    </li>
  )
}

function TaskDetail({ taskId, config }: { taskId: number; config?: TriggerMandateSnapshot }) {
  const cache = useQueryClient()
  const key = [...tasksKey, taskId]
  const task = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiFetch<MandateTaskDetail>(`${base}/tasks/${taskId}`, { signal }),
    retry: false,
    refetchInterval: (q) => (q.state.status === 'error' ? false : 10000),
  })
  const change = useMutation({
    mutationFn: (paused: boolean) =>
      apiPut<MandateTaskDetail>(`${base}/tasks/${taskId}/pause`, { paused }),
    onSuccess: (next) => {
      cache.setQueryData(key, next)
      void cache.invalidateQueries({ queryKey: tasksKey })
    },
  })
  const retry = useMutation({
    mutationFn: ({ matchId, kind }: { matchId: number; kind: WorkKind }) =>
      apiPost(`${base}/records/${matchId}/retry`, { kind }),
    onSettled: () => cache.invalidateQueries({ queryKey: key }),
  })
  const data = task.data
  const mandate = config?.settings.mandates.find((rule) => rule.id === data?.mandateId)
  return (
    <section className="mt-detail" aria-label="任务时间线">
      {task.isLoading && <p>正在读取任务…</p>}
      {task.error && (
        <div role="alert">
          <p className="rw-error">{task.error.message}</p>
          <button type="button" className="rw-inline-button" onClick={() => void task.refetch()}>
            重新载入任务
          </button>
        </div>
      )}
      {data && (
        <>
          <header className="mt-heading">
            <small>
              持续任务 #{data.id} · {(data.active && mandate?.name) || data.mandateId}
            </small>
            <h2>{data.title}</h2>
            {data.active && mandate?.purpose && <p>{mandate.purpose}</p>}
            <div className="mt-meta">
              <span>{data.eventCount} 条命中</span>
              <span>{taskState(data)}</span>
              {data.acknowledgedAt && (
                <span>
                  {data.acknowledgedBy &&
                    `跟进人 ${data.acknowledgedBy.operatorId}（${mandateDestinations[data.acknowledgedBy.platform]} · 应用 ${data.acknowledgedBy.channelId} · 会话 ${data.acknowledgedBy.peerId}） · `}
                  已于{' '}
                  <time dateTime={data.acknowledgedAt}>
                    {new Date(data.acknowledgedAt).toLocaleString()}
                  </time>{' '}
                  确认跟进
                </span>
              )}
              <time dateTime={data.updatedAt}>
                更新于 {new Date(data.updatedAt).toLocaleString()}
              </time>
            </div>
            <div className="mt-actions">
              <Link to="/router" search={{ task: taskId, view: 'chat' }}>
                {data.active ? '继续任务对话' : '查看任务对话'}
              </Link>
              {data.active && mandate && (
                <a
                  href={`/config?tab=listeners&mandate=${encodeURIComponent(mandate.id)}#mandates`}
                >
                  编辑这条委托
                </a>
              )}
              {data.active && (
                <button
                  type="button"
                  className="rw-inline-button"
                  disabled={change.isPending || retry.isPending}
                  onClick={() => change.mutate(!data.paused)}
                >
                  {data.paused ? '恢复任务' : '暂停任务'}
                </button>
              )}
            </div>
            {data.active && <small>后续提问会保留在这项任务的独立对话中。</small>}
            {data.active && (
              <small>暂停会撤销排队中和等待重试的步骤。恢复后从新命中的事件继续。</small>
            )}
          </header>
          {change.error && (
            <p role="alert" className="rw-error">
              {change.error.message}
            </p>
          )}
          {retry.error && (
            <p role="alert" className="rw-error">
              {retry.error.message}
            </p>
          )}
          {retry.isSuccess && <output>已请求重试{workNames[retry.variables.kind]}</output>}
          <h3>命中与投递记录</h3>
          <ol className="mt-timeline">
            {data.matches.map((match) => (
              <TimelineEntry
                key={match.id}
                match={match}
                busy={!data.active || data.paused || retry.isPending || change.isPending}
                retry={(kind) => retry.mutate({ matchId: match.id, kind })}
              />
            ))}
          </ol>
        </>
      )}
    </section>
  )
}

function MandateAudit() {
  const [open, setOpen] = useState(false)
  const audit = useInfiniteQuery({
    queryKey: ['listeners', 'mandates', 'audit'],
    enabled: open,
    retry: false,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      apiFetch<{ items: MandateAuditEntry[] }>(
        `${base}/audit?limit=${pageSize}${pageParam ? `&beforeId=${pageParam}` : ''}`,
        { signal },
      ),
    getNextPageParam: (page) =>
      page.items.length === pageSize ? page.items.at(-1)?.id : undefined,
  })
  const rows = audit.data?.pages.flatMap((page) => page.items) ?? []
  return (
    <details className="mt-audit" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>操作审计</summary>
      {audit.isLoading && <p>正在读取…</p>}
      {audit.error && (
        <p role="alert" className="rw-error">
          {audit.error.message}
        </p>
      )}
      {audit.isSuccess && !rows.length && <p>还没有审计记录。</p>}
      {open && (
        <button
          type="button"
          className="rw-inline-button"
          disabled={audit.isFetching}
          onClick={() => void audit.refetch()}
        >
          刷新审计
        </button>
      )}
      <ol>
        {rows.map((row) => (
          <li key={row.id}>
            <b>{row.action}</b> · {new Date(row.at).toLocaleString()}
            <p>{row.detail}</p>
          </li>
        ))}
      </ol>
      {audit.hasNextPage && (
        <button
          type="button"
          className="rw-inline-button"
          disabled={audit.isFetching}
          onClick={() => void audit.fetchNextPage()}
        >
          加载更早审计
        </button>
      )}
    </details>
  )
}

export function RouterMandateTasks({
  selected,
  chat,
  renderConversation,
}: {
  selected?: number
  chat: boolean
  renderConversation(taskId: number): ReactNode
}) {
  const config = useQuery({
    queryKey: mandateConfigKey,
    queryFn: ({ signal }) => apiFetch<TriggerMandateSnapshot>(`${base}/config`, { signal }),
    retry: false,
  })
  const tasks = useInfiniteQuery({
    queryKey: [...tasksKey, 'list'],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      apiFetch<{ items: MandateTask[] }>(
        `${base}/tasks?limit=${pageSize}${pageParam ? `&beforeId=${pageParam}` : ''}`,
        { signal },
      ),
    getNextPageParam: (page) =>
      page.items.length === pageSize ? page.items.at(-1)?.id : undefined,
    retry: false,
    refetchInterval: (q) => (q.state.status === 'error' ? false : 15000),
  })
  const rows = tasks.data?.pages.flatMap((page) => page.items) ?? []
  const active = selected ?? rows[0]?.id
  return (
    <div className="mt-workspace">
      <div className="rw-layout">
        <nav aria-label="持续任务" className="rw-rail">
          <div className="rw-rail-heading mt-list-title">
            <h2>持续任务</h2>
            <button
              type="button"
              className="rw-inline-button"
              disabled={tasks.isFetching}
              onClick={() => void tasks.refetch()}
            >
              刷新任务
            </button>
          </div>
          {tasks.isLoading && <p className="rw-hint">正在读取任务…</p>}
          {tasks.error && (
            <p role="alert" className="rw-error">
              {tasks.error.message}
            </p>
          )}
          {tasks.isSuccess && !rows.length && <p className="rw-hint">暂无持续任务。</p>}
          {config.error && <p className="rw-error">{config.error.message}</p>}
          <div className="rw-rail-list">
            {rows.map((row) => (
              <Link
                key={row.id}
                className="rw-event"
                to="/router"
                search={{ task: row.id, view: chat ? 'chat' : undefined }}
                aria-current={active === row.id ? 'page' : undefined}
              >
                <small>
                  {(row.active &&
                    config.data?.settings.mandates.find((rule) => rule.id === row.mandateId)
                      ?.name) ||
                    row.mandateId}
                </small>
                <strong>{row.title}</strong>
                <small>
                  {taskState(row)} · {row.eventCount} 条命中
                </small>
              </Link>
            ))}
            {tasks.hasNextPage && (
              <button
                type="button"
                className="rw-inline-button"
                disabled={tasks.isFetching}
                onClick={() => void tasks.fetchNextPage()}
              >
                加载更早任务
              </button>
            )}
          </div>
        </nav>
        {active ? (
          <div className="mt-task-pane">
            <nav className="mt-task-views" aria-label="任务视图">
              <Link to="/router" search={{ task: active }} aria-current={chat ? undefined : 'page'}>
                时间线
              </Link>
              <Link
                to="/router"
                search={{ task: active, view: 'chat' }}
                aria-current={chat ? 'page' : undefined}
              >
                任务对话
              </Link>
            </nav>
            {chat ? (
              renderConversation(active)
            ) : (
              <TaskDetail key={active} taskId={active} config={config.data} />
            )}
          </div>
        ) : (
          <section className="mt-detail mt-empty">
            <h2>按委托跟踪进展</h2>
            <p>来源中的新事件命中委托后，会在这里按业务对象归集，可以分别检查提醒与归档结果。</p>
            <a href="/config?tab=listeners#mandates">配置长期委托</a>
          </section>
        )}
      </div>
      <MandateAudit />
    </div>
  )
}

export function EventMandateMatches({ inboxId }: { inboxId: number }) {
  const [open, setOpen] = useState(false)
  const matches = useInfiniteQuery({
    queryKey: ['listeners', 'mandates', 'event-matches', inboxId],
    enabled: open,
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      apiFetch<{ items: MandateMatch[] }>(
        `${base}/records?inboxId=${inboxId}&limit=${pageSize}${pageParam ? `&beforeId=${pageParam}` : ''}`,
        { signal },
      ),
    getNextPageParam: (page) =>
      page.items.length === pageSize ? page.items.at(-1)?.id : undefined,
    retry: false,
  })
  const config = useQuery({
    queryKey: mandateConfigKey,
    enabled: open,
    retry: false,
    queryFn: ({ signal }) => apiFetch<TriggerMandateSnapshot>(`${base}/config`, { signal }),
  })
  const items = matches.data?.pages.flatMap((page) => page.items) ?? []
  return (
    <details className="mt-audit" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>查看此事件命中的委托</summary>
      {matches.isSuccess && !items.length && <p>此事件没有命中长期委托。</p>}
      {matches.isLoading && <p>正在读取…</p>}
      {matches.error && (
        <p role="alert" className="rw-error">
          {matches.error.message}
        </p>
      )}
      <ol>
        {items.map((record) => (
          <li key={record.id}>
            <Link className="rw-inline-button" to="/router" search={{ task: record.taskId }}>
              {config.data?.settings.mandates.find((rule) => rule.id === record.mandateId)?.name ??
                record.mandateId}{' '}
              · 任务 #{record.taskId}
            </Link>
          </li>
        ))}
      </ol>
      {matches.hasNextPage && (
        <button
          type="button"
          className="rw-inline-button"
          disabled={matches.isFetching}
          onClick={() => void matches.fetchNextPage()}
        >
          更多命中委托
        </button>
      )}
    </details>
  )
}
