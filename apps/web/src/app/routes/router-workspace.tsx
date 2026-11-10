import {
  ArrowClockwise,
  ArrowUp,
  ChatCircleDots,
  CircleNotch,
  GearSix,
  GitBranch,
  GithubLogo,
  Tray,
  WechatLogo,
} from '@phosphor-icons/react'
import {
  useInfiniteQuery,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { Link, useSearch } from '@tanstack/react-router'
import type {
  RouterSurfaceAction,
  RouterWorkspaceSnapshot,
  TriggerConversationAnswer,
  TriggerConversationScope,
  TriggerRouteStatus,
  TriggerWorkspaceEvent,
} from '@zero-os/shared'
import { useLayoutEffect, useRef, useState } from 'react'
import { RouterSurface } from '../components/RouterSurface'
import { apiFetch, apiPost } from '../lib/api'
import { ListenerRoutingSettings, useListenerRoutingConfig } from './config-listener-routing'
import { RoutingPreview } from './config-routing-preview'
import { EventMandateMatches, RouterMandateTasks } from './router-mandate-tasks'
import { RouterWebNotifications } from './router-web-notifications'
import './config-listeners-tab.css'
import './router-workspace.css'

const api = '/api/listeners'
const pageSize = 25
const eventsKey = ['router-workspace-events']
const toolLabels: Record<string, string> = {
  preview_current_route: '预演当前去向',
  get_routing_context: '查看路由状态',
  list_notification_bots: '查询通知机器人',
  inspect_github: '检查 GitHub 事件',
  delegate_task: '派发工作',
  get_task_status: '查询派工进度',
  continue_task: '继续派工',
  unknown: '工具未识别',
}
const statuses: Record<TriggerRouteStatus, string> = {
  pending: '等待分析',
  analyzing: '分析中',
  ready: '等待路由',
  web: '网页通知',
  deferred: '已延后',
  sending: '投递中',
  sent: '平台已受理',
  uncertain: '等待核对',
  failed: '处理失败',
  cancelled: '已撤销',
}
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})
function Time({ value }: { value: string }) {
  return <time dateTime={value}>{dateFormat.format(new Date(value))}</time>
}

function EventRail({ scope }: { scope: TriggerConversationScope }) {
  const events = useInfiniteQuery({
    queryKey: eventsKey,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) =>
      apiFetch<{ items: TriggerWorkspaceEvent[] }>(
        `${api}/workspace-events?limit=${pageSize}${pageParam ? `&beforeId=${pageParam}` : ''}`,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.items.length === pageSize ? last.items.at(-1)?.id : undefined,
    retry: false,
    refetchInterval: (q) => (q.state.status === 'error' ? false : 30_000),
  })
  const rows = events.data?.pages.flatMap((p) => p.items) ?? []
  return (
    <nav aria-label="Router 对话与事件" className="rw-rail">
      <Link
        to="/router"
        search={{ event: undefined }}
        activeOptions={{ exact: true, explicitUndefined: true }}
        aria-current={scope === 'general' ? 'page' : undefined}
        className="rw-general"
      >
        <ChatCircleDots size={21} aria-hidden="true" />
        <span>与 Router 对话</span>
      </Link>
      <div className="rw-rail-heading">
        <h2>
          <Tray size={17} aria-hidden="true" />
          事件收件箱
        </h2>
        <button
          type="button"
          title="刷新事件"
          aria-label="刷新事件"
          className="rw-icon-button"
          disabled={events.isFetching}
          onClick={() => void events.refetch()}
        >
          <ArrowClockwise size={17} />
        </button>
      </div>
      <div className="rw-rail-list">
        {events.isLoading && <p className="rw-hint">正在读取事件…</p>}
        {events.error && (
          <p role="alert" className="rw-error">
            {events.error.message}
          </p>
        )}
        {events.isSuccess && !rows.length && (
          <p className="rw-hint">暂无事件。可以先配置一个仓库或微信会话。</p>
        )}
        {rows.map((row) => (
          <Link
            key={row.id}
            to="/router"
            search={{ event: row.id }}
            className="rw-event"
            aria-current={scope === row.id ? 'page' : undefined}
          >
            <span className="rw-event-meta">
              <span className="rw-source">
                {row.source === 'github' ? <GithubLogo size={15} /> : <WechatLogo size={15} />}
                {row.source === 'github' ? 'GitHub' : 'WXARC'}
              </span>
              <Time value={row.receivedAt} />
            </span>
            <strong>{row.title}</strong>
            <small className="rw-event-state" data-state={row.status ?? 'received'}>
              {row.status ? statuses[row.status] : '已入箱'}
            </small>
          </Link>
        ))}
        {events.hasNextPage && (
          <button
            type="button"
            disabled={events.isFetching}
            className="rw-inline-button"
            onClick={() => void events.fetchNextPage()}
          >
            加载更早事件
          </button>
        )}
      </div>
    </nav>
  )
}

type Operation =
  | { requestId: string; text: string; retry?: boolean }
  | { requestId: string; action: RouterSurfaceAction; retry?: boolean }

function RouterAnswer({
  answer,
  disabled,
  ask,
}: {
  answer: TriggerConversationAnswer
  disabled: boolean
  ask: (text: string) => void
}) {
  const { job } = answer
  return (
    <>
      <p className="rw-answer">{answer.text}</p>
      {job && (job.status === 'queued' || job.status === 'running') && (
        <button
          type="button"
          className="rw-inline-button rw-work-action"
          disabled={disabled}
          onClick={() => ask(`查看派工 #${job.id} 的进度`)}
        >
          查询派工进度
        </button>
      )}
    </>
  )
}

function Conversation({
  scope,
  draft,
  changeDraft,
  clearSubmitted,
}: {
  scope: TriggerConversationScope
  draft: string
  changeDraft: (value: string) => void
  clearSubmitted: (text: string) => void
}) {
  const cache = useQueryClient()
  const key = ['router-workspace', scope]
  const mutationKey = ['router-workspace-write', scope]
  const sending = useIsMutating({ mutationKey, exact: true }) > 0
  const lock = useRef(false)
  const scrollArea = useRef<HTMLDivElement>(null)
  const followReply = useRef(false)
  const url = `${api}/workspace/${scope}`
  const workspace = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiFetch<RouterWorkspaceSnapshot>(url, { signal }),
    staleTime: 0,
    retry: false,
    refetchInterval: (q) => {
      const data = q.state.data
      if (sending || q.state.status === 'error' || !data) return false
      return data.turns.some(
        (t) =>
          t.status === 'pending' ||
          t.answer?.job?.status === 'queued' ||
          t.answer?.job?.status === 'running',
      ) || ['pending', 'analyzing', 'ready', 'sending'].includes(data.route?.status ?? '')
        ? 2000
        : 30_000
    },
  })
  const send = useMutation({
    mutationKey,
    mutationFn: (op: Operation) =>
      apiPost<RouterWorkspaceSnapshot>(`${url}/${'action' in op ? 'actions' : 'messages'}`, op),
    onMutate: () => cache.cancelQueries({ queryKey: key, exact: true }),
    onSuccess: async (snapshot, op) => {
      await cache.cancelQueries({ queryKey: key, exact: true })
      cache.setQueryData(key, snapshot)
      if ('text' in op && !op.retry) clearSubmitted(op.text)
      if ('action' in op) void cache.invalidateQueries({ queryKey: eventsKey })
    },
    onError: async (_error, op) => {
      await cache.invalidateQueries({ queryKey: key, exact: true })
      const latest = cache.getQueryData<RouterWorkspaceSnapshot>(key)
      if ('text' in op && latest?.turns.some((turn) => turn.requestId === op.requestId))
        clearSubmitted(op.text)
    },
    onSettled: () => {
      lock.current = false
    },
  })
  const data = workspace.data
  const readOnly = data?.task?.active === false
  const busy = sending || !!data?.turns.some((t) => t.status === 'pending')
  useLayoutEffect(() => {
    const area = scrollArea.current
    if (area && followReply.current && window.matchMedia('(min-width: 801px)').matches) {
      area.scrollTop = area.scrollHeight
    }
    if (!busy) followReply.current = false
  }, [busy])
  function submit(op: Operation) {
    if (lock.current || busy || readOnly || !data) return
    lock.current = true
    followReply.current =
      'text' in op ||
      op.action.action.name === 'explain_route' ||
      op.action.action.name === 'suggest_next' ||
      op.action.action.name === 'inspect_github' ||
      op.action.action.name === 'compare_runs'
    send.mutate(op)
  }
  function ask() {
    const text = draft.trim()
    if (!text || text.length > 2000) return
    if (failed && 'text' in failed && failed.text === text) submit({ ...failed, retry: true })
    else submit({ requestId: crypto.randomUUID(), text })
  }
  function action(action: RouterSurfaceAction) {
    if (
      failed &&
      'action' in failed &&
      failed.action.action.surfaceId === action.action.surfaceId &&
      failed.action.action.sourceComponentId === action.action.sourceComponentId &&
      failed.action.action.name === action.action.name
    ) {
      submit({ ...failed, retry: true })
    } else {
      submit({ requestId: crypto.randomUUID(), action })
    }
  }
  const optimistic =
    send.isPending &&
    send.variables &&
    !data?.turns.some((t) => t.requestId === send.variables.requestId)
      ? send.variables
      : undefined
  const failed =
    send.isError && !data?.turns.some((t) => t.requestId === send.variables.requestId)
      ? send.variables
      : undefined
  if (!data) {
    return (
      <section className="rw-panel rw-loading" aria-live="polite">
        {workspace.error ? (
          <>
            <p className="rw-error">{workspace.error.message}</p>
            <button
              type="button"
              className="rw-inline-button"
              onClick={() => void workspace.refetch()}
            >
              重新加载对话
            </button>
            <Link to="/router" search={{ event: undefined }}>
              回到通用对话
            </Link>
          </>
        ) : (
          '正在打开对话…'
        )}
      </section>
    )
  }
  const repositoryUrl =
    data.event?.source === 'github' ? `https://github.com/${data.event.scope}/` : null
  return (
    <section
      className="rw-panel"
      aria-label={data.task ? '任务对话' : data.event ? '事件讨论' : '通用对话'}
    >
      <div
        className="rw-thread-scroll"
        ref={scrollArea}
        onScroll={(e) => {
          const area = e.currentTarget
          if (area.scrollHeight - area.scrollTop - area.clientHeight > 100)
            followReply.current = false
        }}
      >
        <header className="rw-thread-heading">
          <span className="rw-thread-symbol">
            {data.event ? <GitBranch size={21} /> : <ChatCircleDots size={22} />}
          </span>
          <div>
            <h2>{data.task?.name ?? data.event?.title ?? '通用对话'}</h2>
            <p>
              {data.task
                ? `持续任务 #${data.task.id} · ${data.task.eventCount} 条命中`
                : data.event
                  ? `${data.event.source === 'github' ? 'GitHub' : 'WXARC'} 事件 #${data.event.id}`
                  : '安排工作、跟进派工，或询问通知去向。'}
            </p>
            {data.task && <p>{data.task.purpose}</p>}
          </div>
        </header>
        {workspace.error && (
          <p role="alert" className="rw-error">
            {workspace.error.message}
            <button
              type="button"
              className="rw-inline-button"
              onClick={() => void workspace.refetch()}
            >
              重新加载
            </button>
          </p>
        )}
        <div className="rw-context">
          <RouterSurface messages={data.surface} onAction={action} disabled={busy || readOnly} />
          {data.event && !data.task && <EventMandateMatches inboxId={data.event.id} />}
          {data.event && (
            <details className="rw-original">
              <summary>{data.task ? '查看最近命中事件' : '查看原始事件'}</summary>
              <p>{data.event.summary}</p>
              <small>
                {data.event.source === 'github' && <>{data.event.scope} · </>}发生于{' '}
                <Time value={data.event.occurredAt} />
              </small>
              {data.task && (
                <Link to="/router" search={{ event: data.event.id }} className="rw-inline-button">
                  打开原始事件 #{data.event.id}
                </Link>
              )}
              {data.event.source === 'github' &&
                data.event.url?.startsWith('https://github.com/') && (
                  <a href={data.event.url} target="_blank" rel="noreferrer">
                    在 GitHub 打开
                  </a>
                )}
            </details>
          )}
          {!data.task && (
            <div className="listeners-panel rw-preview">
              <RoutingPreview settings={data.settings.settings} saved />
            </div>
          )}
        </div>
        <section className="rw-dialog" aria-label="对话记录">
          <h3>
            <ChatCircleDots size={17} />
            对话记录
          </h3>
          {!data.turns.length && !optimistic && (
            <p className="rw-hint">
              {data.event
                ? '从卡片选择一个问题，或写下你想了解的细节。'
                : '你可以问「我离开电脑后，通知会去哪里？」'}
            </p>
          )}
          {data.turns.map((turn) => (
            <article className="rw-turn" key={turn.id}>
              <div className="rw-speaker">
                <b>{turn.requestId.startsWith('im-') ? '来自 IM 的提问' : '你'}</b>
                <Time value={turn.createdAt} />
              </div>
              <p className="rw-question">{turn.question}</p>
              <div className="rw-reply">
                <b className="rw-router-name">
                  <GitBranch size={14} />
                  Router
                </b>
                {turn.status === 'pending' && (
                  <output className="rw-busy">
                    <CircleNotch size={15} />
                    正在回复…
                  </output>
                )}
                {turn.status === 'failed' && (
                  <div role="alert" className="rw-failure">
                    <p className="rw-error">{turn.error || '本次回答未能完成。'}</p>
                    {turn.requestId.startsWith('im-') ? (
                      <p className="rw-hint">请在原会话中重新发送问题。</p>
                    ) : (
                      <button
                        type="button"
                        className="rw-inline-button"
                        disabled={busy || readOnly}
                        onClick={() =>
                          submit({ requestId: turn.requestId, text: turn.question, retry: true })
                        }
                      >
                        重新提问
                      </button>
                    )}
                  </div>
                )}
                {turn.answer && (
                  <RouterAnswer
                    answer={turn.answer}
                    disabled={busy || readOnly}
                    ask={(text) => submit({ requestId: crypto.randomUUID(), text })}
                  />
                )}
                {!!turn.answer?.toolSteps?.length && (
                  <details className="rw-tool-steps">
                    <summary>本轮调用了 {turn.answer.toolSteps.length} 次工具</summary>
                    <ol>
                      {turn.answer.toolSteps.map((step, index) => (
                        <li key={`${index}-${step.name}`}>
                          {toolLabels[step.name] ?? step.name} · {step.ok ? '已返回' : '未完成'}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                {turn.answer?.investigation && repositoryUrl && (
                  <nav className="rw-evidence-links" aria-label="GitHub 调查来源">
                    {[
                      { label: 'GitHub 原始记录', url: turn.answer.investigation.sourceUrl },
                      ...turn.answer.investigation.facts,
                    ]
                      .filter(({ url }) => url?.startsWith(repositoryUrl))
                      .map(({ label, url }) => (
                        <a key={url} href={url} target="_blank" rel="noreferrer">
                          {label} ↗
                        </a>
                      ))}
                  </nav>
                )}
                {turn.surface && (
                  <RouterSurface
                    messages={turn.surface}
                    disabled={busy || readOnly}
                    onAction={action}
                  />
                )}
              </div>
            </article>
          ))}
          {optimistic && (
            <div className="rw-turn" aria-live="polite">
              {'text' in optimistic && (
                <>
                  <div className="rw-speaker">
                    <b>你</b>
                  </div>
                  <p className="rw-question">{optimistic.text}</p>
                </>
              )}
              <p className="rw-busy">
                <CircleNotch size={15} />
                {'action' in optimistic ? '正在处理卡片操作…' : 'Router 正在回复…'}
              </p>
            </div>
          )}
        </section>
      </div>
      {readOnly ? (
        <p className="rw-hint">这项委托已停用，可以查看已有对话。</p>
      ) : (
        <form
          className="rw-composer"
          onSubmit={(e) => {
            e.preventDefault()
            ask()
          }}
        >
          {failed && (
            <div className="rw-failure" role="alert">
              <p className="rw-error">{send.error?.message}</p>
              <button
                type="button"
                className="rw-inline-button"
                disabled={busy}
                onClick={() => submit({ ...failed, retry: true })}
              >
                重试请求
              </button>
            </div>
          )}
          <label htmlFor="router-message">
            {data.task ? '继续跟进这项任务' : data.event ? '追问这条事件' : '给 Router 发消息'}
          </label>
          <textarea
            rows={2}
            id="router-message"
            aria-label="给 Router 发消息"
            placeholder={
              data.event
                ? '你想进一步了解什么？'
                : '例如「现在的通知会发到哪里？」或「分析 owner/repo 最近一次失败」'
            }
            maxLength={2000}
            value={draft}
            onChange={(e) => changeDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                ask()
              }
            }}
          />
          <div className="rw-compose-foot">
            <small>Ctrl / ⌘ + Enter 发送</small>
            <button type="submit" className="rw-send" disabled={busy || !draft.trim()}>
              <ArrowUp size={16} />
              发送
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

export function RouterWorkspacePage() {
  const { event, view, task } = useSearch({ from: '/router' })
  const showWebNotices = view === 'notifications' && task === undefined
  const showTasks = view === 'tasks' || task !== undefined
  const scope = event ?? 'general'
  const [settingsOpen, setSettingsOpen] = useState(false)
  const routingConfig = useListenerRoutingConfig(settingsOpen)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  function conversation(scope: TriggerConversationScope) {
    return (
      <Conversation
        key={scope}
        scope={scope}
        draft={drafts[scope] ?? ''}
        changeDraft={(value) => setDrafts((previous) => ({ ...previous, [scope]: value }))}
        clearSubmitted={(text) =>
          setDrafts((previous) =>
            previous[scope]?.trim() === text ? { ...previous, [scope]: '' } : previous,
          )
        }
      />
    )
  }
  return (
    <div className="rw-workspace">
      <header className="rw-header">
        <div className="rw-heading">
          <GitBranch size={32} weight="duotone" aria-hidden="true" />
          <h1>Router 工作台</h1>
        </div>
        <button
          type="button"
          className="rw-settings"
          aria-expanded={settingsOpen}
          aria-controls="rw-routing-settings"
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          <GearSix size={16} aria-hidden="true" />
          通知渠道与路由设置
        </button>
      </header>
      <div id="rw-routing-settings" hidden={!settingsOpen}>
        {(settingsOpen || routingConfig.data) && (
          <div className="listeners-panel rw-settings-panel">
            <ListenerRoutingSettings config={routingConfig} />
            <a className="rw-inline-button" href="/config?tab=listeners">
              管理监听来源与委托
            </a>
          </div>
        )}
      </div>
      <nav aria-label="工作台视图" className="mt-views">
        <Link
          to="/router"
          search={{ event }}
          aria-current={!showTasks && !showWebNotices ? 'page' : undefined}
        >
          对话与事件
        </Link>
        <Link to="/router" search={{ view: 'tasks' }} aria-current={showTasks ? 'page' : undefined}>
          持续任务
        </Link>
        <Link
          to="/router"
          search={{ view: 'notifications' }}
          aria-current={showWebNotices ? 'page' : undefined}
        >
          网页提醒
        </Link>
      </nav>
      {showWebNotices ? (
        <RouterWebNotifications />
      ) : showTasks ? (
        <RouterMandateTasks
          selected={task}
          chat={view === 'chat'}
          renderConversation={(taskId) => conversation(`task-${taskId}`)}
        />
      ) : (
        <div className="rw-layout">
          <EventRail scope={scope} />
          {conversation(scope)}
        </div>
      )}
    </div>
  )
}
