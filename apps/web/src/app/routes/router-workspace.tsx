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
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router'
import { isStandalonePullRequestAnswer, routerEventActivityLabel } from '@zero-os/shared'
import type {
  RouterOpenPullRequestsPage,
  RouterSurfaceAction,
  RouterWorkspaceSnapshot,
  TriggerConversationAnswer,
  TriggerConversationScope,
  TriggerRouteDecision,
  TriggerRouteRecord,
  TriggerRouteStatus,
  TriggerWorkspaceEvent,
} from '@zero-os/shared'
import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import { RouterMessage } from '../components/RouterMessage'
import { RouterSurface } from '../components/RouterSurface'
import { apiFetch, apiPost } from '../lib/api'
import { ListenerRoutingSettings, useListenerRoutingConfig } from './config-listener-routing'
import { RoutingPreview } from './config-routing-preview'
import { RouterCommentSubscription } from './router-comment-subscription'
import { RouterGithubReply } from './router-github-reply'
import { EventMandateMatches, RouterMandateTasks } from './router-mandate-tasks'
import { RouterMatterList, RouterPublicationFeed } from './router-matters'
import { EventWorkerActivity, RouterTrackingResults } from './router-tracking-results'
import { RouterWebNotifications } from './router-web-notifications'
import './config-listeners-tab.css'
import './router-workspace.css'

import { workspaceTraceLink, restoreWorkspaceAnchor } from '../lib/router-trace-navigation'
import { toolLabels } from '../lib/router-tool-labels'

const api = '/api/listeners'
const pageSize = 25
const eventsKey = ['router-workspace-events']
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

const destinationLabels: Record<TriggerRouteDecision['destination'], string> = {
  web: '网页',
  weixin: '微信',
  dingtalk: '钉钉',
  feishu: '飞书',
  defer: '延后提醒',
}
function NotificationActivity({
  request,
  route,
}: {
  request: NonNullable<RouterWorkspaceSnapshot['notificationRequest']>
  route: TriggerRouteRecord | null
}) {
  return (
    <article className="rw-turn rw-activity" aria-label="通知处理记录">
      <div className="rw-activity-heading">
        <b>你的操作 · 分析并路由通知</b>
        {request.submittedAt && <Time value={request.submittedAt} />}
      </div>
      <div className="rw-reply">
        <b className="rw-router-name">
          <GitBranch size={14} />
          Router
        </b>
        <p className="rw-answer">
          {route ? statuses[route.status] : '已收到通知处理请求。'}
          {route?.decision &&
            ` · ${destinationLabels[route.decision.destination]}：${route.decision.reason}`}
        </p>
        {route?.error && <p className="rw-error">{route.error}</p>}
        {route && (
          <small className="rw-hint">
            状态更新于 <Time value={route.updatedAt} />
          </small>
        )}
      </div>
    </article>
  )
}

function EventRail({ scope }: { scope: TriggerConversationScope }) {
  const [includeOwn, setIncludeOwn] = useState(false)
  const events = useInfiniteQuery({
    queryKey: [...eventsKey, includeOwn],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) =>
      apiFetch<{ items: TriggerWorkspaceEvent[] }>(
        `${api}/workspace-events?limit=${pageSize}&includeOwn=${includeOwn}${pageParam ? `&beforeId=${pageParam}` : ''}`,
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
      <label className="rw-own-filter">
        <input
          type="checkbox"
          checked={includeOwn}
          onChange={(e) => setIncludeOwn(e.target.checked)}
        />
        显示自身产生的事件
      </label>
      <div className="rw-rail-list">
        {events.isLoading && <p className="rw-hint">正在读取事件…</p>}
        {events.error && (
          <p role="alert" className="rw-error">
            {events.error.message}
          </p>
        )}
        {events.isSuccess && !rows.length && (
          <p className="rw-hint">
            {includeOwn
              ? '暂无事件。可以先配置一个仓库或微信会话。'
              : '暂无外部事件。自身产生的事件可勾选上方选项查看。'}
          </p>
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
            {row.githubOwnComment && <span className="rw-own-badge">自身产生</span>}
            <small className="rw-event-state" data-state={row.status ?? 'received'}>
              {row.activity
                ? routerEventActivityLabel(row.activity)
                : row.githubOwnComment
                  ? '已记录'
                  : row.status
                    ? statuses[row.status]
                    : '已入箱'}
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

function OpenPullRequests({ page }: { page: RouterOpenPullRequestsPage }) {
  const count = page.pullRequests.length
  return (
    <section className="rw-pr-list" aria-label={`${page.repository} 的开放 PR`}>
      <header>
        <strong>{page.repository}</strong>
        <span>
          开放 PR · 第 {page.page} 页 · 本页 {count} 项
        </span>
      </header>
      {count ? (
        <ul>
          {page.pullRequests.map((pr) => (
            <li key={pr.number}>
              <a href={pr.url} target="_blank" rel="noreferrer">
                <span className="rw-pr-number">#{pr.number}</span>
                <span>{pr.title}</span>
              </a>
              {pr.draft && <span className="rw-pr-draft">草稿</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p>{page.page === 1 ? '当前没有开放的 PR。' : '本页没有结果。'}</p>
      )}
    </section>
  )
}

function RouterAnswer({
  answer,
  disabled,
  ask,
}: {
  answer: TriggerConversationAnswer
  disabled: boolean
  ask: (text: string) => void
}) {
  const { repositories, pullRequests, job } = answer
  const nextPage = repositories?.nextPage
  const prRepository =
    pullRequests &&
    /^[a-z\d-]+\/[a-z\d_.-]+$/i.test(pullRequests.repository) &&
    !/\/\.{1,2}$/.test(pullRequests.repository)
      ? pullRequests.repository
      : undefined
  const prLinks = new Set<string>()
  if (prRepository && pullRequests) {
    for (const pr of pullRequests.pullRequests) {
      const url = `https://github.com/${prRepository}/pull/${pr.number}`
      if (Number.isSafeInteger(pr.number) && pr.number > 0 && pr.url === url) prLinks.add(url)
    }
  }
  const prPage =
    prRepository &&
    pullRequests &&
    prLinks.size === pullRequests.pullRequests.length &&
    isStandalonePullRequestAnswer(answer)
      ? pullRequests
      : null
  const text =
    repositories || pullRequests
      ? answer.text.split('\n').map((line, index) => {
          const entry = /^(\d+)\. ([a-z\d-]+\/[a-z\d_.-]+)$/i.exec(line)
          const name = entry?.[2]
          const verified =
            entry &&
            name &&
            !/\/\.{1,2}$/.test(name) &&
            name === repositories?.repositories[Number(entry[1]) - 1]
          return (
            <Fragment key={`${index}-${line}`}>
              {index > 0 && '\n'}
              {verified ? (
                <>
                  {entry[1]}.{' '}
                  <a href={`https://github.com/${name}`} target="_blank" rel="noreferrer">
                    {name}
                  </a>
                </>
              ) : prLinks.has(line) ? (
                <a href={line} target="_blank" rel="noreferrer">
                  {line}
                </a>
              ) : (
                line
              )}
            </Fragment>
          )
        })
      : answer.text
  return (
    <>
      {prPage ? (
        <OpenPullRequests page={prPage} />
      ) : typeof text === 'string' ? (
        <RouterMessage text={text} />
      ) : (
        <p className="rw-answer">{text}</p>
      )}
      {nextPage != null && (
        <button
          type="button"
          className="rw-inline-button rw-work-action"
          disabled={disabled}
          onClick={() => ask(`列出我可访问的 GitHub 仓库第 ${nextPage} 页`)}
        >
          查看第 {nextPage} 页
        </button>
      )}
      {prRepository && pullRequests?.nextPage != null && (
        <button
          type="button"
          className="rw-inline-button rw-work-action"
          disabled={disabled}
          onClick={() => ask(`查看 ${prRepository} 的开放 PR 第 ${pullRequests.nextPage} 页`)}
        >
          查看第 {pullRequests.nextPage} 页 PR
        </button>
      )}
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
  const hash = useLocation({ select: (location) => location.hash })
  const showSource = hash === 'rw-source-text'
  const requestedTurn = Number(/^rw-turn-([1-9]\d*)(?:-\d+)?$/u.exec(hash)?.[1])
  const navigate = useNavigate({ from: '/router' })
  const key = ['router-workspace', scope]
  const mutationKey = ['router-workspace-write', scope]
  const sending = useIsMutating({ mutationKey, exact: true }) > 0
  const lock = useRef(false)
  const dialogEnd = useRef<HTMLDivElement>(null)
  const notificationEntry = useRef<HTMLDivElement>(null)
  const workEntry = useRef<HTMLDivElement>(null)
  const composerInput = useRef<HTMLTextAreaElement>(null)
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
          t.status === 'queued' ||
          t.answer?.reminder?.status === 'sending' ||
          t.answer?.job?.status === 'queued' ||
          t.answer?.job?.status === 'running',
      ) ||
        data.trackingResult?.status === 'queued' ||
        data.trackingResult?.status === 'running' ||
        data.eventActivity?.state === 'pending' ||
        data.eventActivity?.state === 'running' ||
        data.eventActivity?.worker?.status === 'queued' ||
        data.eventActivity?.worker?.status === 'running' ||
        ['pending', 'analyzing', 'ready', 'sending'].includes(data.route?.status ?? '')
        ? 2000
        : 30_000
    },
  })
  const historical =
    Number.isSafeInteger(requestedTurn) &&
    !!workspace.data &&
    !workspace.data.turns.some((turn) => turn.id === requestedTurn)
  const older = useQuery({
    queryKey: [...key, 'throughTurn', requestedTurn],
    queryFn: ({ signal }) =>
      apiFetch<RouterWorkspaceSnapshot>(url + '?throughTurn=' + requestedTurn, { signal }),
    enabled: historical,
    retry: false,
    staleTime: 0,
    refetchInterval: historical ? 30_000 : false,
  })
  useLayoutEffect(() => {
    if (!Number.isSafeInteger(requestedTurn)) return
    const node = document.getElementById(hash)
    if (node) {
      delete node.dataset.restored
      restoreWorkspaceAnchor(node)
    }
  }, [hash, requestedTurn])
  const send = useMutation({
    mutationKey,
    mutationFn: (op: Operation) =>
      apiPost<RouterWorkspaceSnapshot>(
        `${url}/${'action' in op ? 'actions' : 'messages'}`,
        'text' in op ? { ...op, background: true } : op,
      ),
    onMutate: () => cache.cancelQueries({ queryKey: key, exact: true }),
    onSuccess: async (snapshot, op) => {
      await cache.cancelQueries({ queryKey: key, exact: true })
      cache.setQueryData(key, snapshot)
      if (historical) await navigate({ search: true, hash: '' })
      if ('text' in op && !op.retry) clearSubmitted(op.text)
      if ('action' in op) {
        void cache.invalidateQueries({ queryKey: eventsKey })
        if (op.action.action.name === 'work_on_event') {
          void cache.invalidateQueries({ queryKey: ['listeners', 'tracking-results'] })
        }
        if (op.action.action.name === 'confirm_mandate') {
          void cache.invalidateQueries({ queryKey: ['listeners', 'mandates'] })
          void cache.invalidateQueries({ queryKey: ['listeners', 'commission-grants'] })
        }
        if (op.action.action.name === 'apply_preference') {
          void cache.invalidateQueries({ queryKey: ['listeners', 'routing', 'config'] })
        }
      }
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
  const reading = historical ? older.data : data
  const readOnly = data?.task?.active === false
  const busy = sending || !!data?.turns.some((t) => t.status === 'pending' || t.status === 'queued')
  const routingRequested =
    send.variables &&
    'action' in send.variables &&
    send.variables.action.action.name === 'process_event'
  const workRequested =
    send.variables &&
    'action' in send.variables &&
    send.variables.action.action.name === 'work_on_event'
  useLayoutEffect(() => {
    if (followReply.current) {
      const entry =
        !busy &&
        (routingRequested ? notificationEntry.current : workRequested ? workEntry.current : null)
      const target = entry || dialogEnd.current
      target?.scrollIntoView({ block: 'nearest' })
    }
    if (!busy) followReply.current = false
  }, [busy, routingRequested, workRequested])
  function submit(op: Operation) {
    if (lock.current || ('text' in op ? sending : busy) || readOnly || !data) return
    lock.current = true
    followReply.current =
      'text' in op ||
      op.action.action.name === 'explain_route' ||
      op.action.action.name === 'suggest_next' ||
      op.action.action.name === 'process_event' ||
      op.action.action.name === 'work_on_event' ||
      op.action.action.name === 'find_related_issues' ||
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
  const tracked =
    typeof scope === 'number' && data.trackingResult?.inboxId === scope
      ? data.trackingResult
      : undefined
  const requested = typeof scope === 'number' ? data.notificationRequest : undefined
  const eventActivity = !!(tracked || requested)
  const context = (
    <div className="rw-context">
      {eventActivity && <h3>事件操作</h3>}
      <RouterSurface
        messages={data.surface}
        onAction={action}
        disabled={busy || readOnly}
        actionSlot={tracked ? { omit: 'work_on_event' } : undefined}
      />
      {scope === 'general' && (
        <RouterCommentSubscription
          busy={busy}
          ask={(text) => submit({ requestId: crypto.randomUUID(), text })}
        />
      )}
      {send.isSuccess &&
        'action' in send.variables &&
        send.variables.action.action.name === 'apply_preference' && (
          <output className="rw-hint">通知偏好已更新，可展开情境预演查看当前规则。</output>
        )}
      {data.event && !data.task && <EventMandateMatches inboxId={data.event.id} />}
      {typeof scope === 'number' && data.event && (
        <RouterGithubReply key={data.event.id} event={data.event} />
      )}
      {data.event && (
        <details className="rw-original" open={showSource || undefined}>
          <summary>{data.task ? '查看最近命中事件' : '查看原始事件'}</summary>
          <p id="rw-source-text">{data.event.summary}</p>
          <small>
            {data.event.source === 'github' && <>{data.event.scope} · </>}发生于{' '}
            <Time value={data.event.occurredAt} />
          </small>
          {data.task && (
            <Link to="/router" search={{ event: data.event.id }} className="rw-inline-button">
              打开原始事件 #{data.event.id}
            </Link>
          )}
          {data.event.source === 'github' && data.event.url?.startsWith('https://github.com/') && (
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
  )
  return (
    <section
      className="rw-panel"
      aria-label={data.task ? '任务对话' : data.event ? '事件讨论' : '通用对话'}
    >
      <div
        className="rw-thread-scroll"
        onWheel={() => {
          followReply.current = false
        }}
        onPointerDown={() => {
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
                  : '查询仓库、安排工作、跟进派工，或调整提醒与跟踪委托。'}
            </p>
            {data.task && <p>{data.task.purpose}</p>}
            {data.event?.githubOwnComment && <span className="rw-own-badge">自身产生</span>}
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
        {scope === 'general' && <RouterTrackingResults />}
        <RouterPublicationFeed scope={String(scope)} />
        {!eventActivity && context}
        <section className="rw-dialog" aria-label="对话记录">
          <h3>
            <ChatCircleDots size={17} />
            对话记录
          </h3>
          {(reading?.previousTurnId || historical) && (
            <nav className="rw-evidence-links" aria-label="对话历史">
              {reading?.previousTurnId && (
                <Link to="/router" search={true} hash={'rw-turn-' + reading.previousTurnId}>
                  查看更早对话
                </Link>
              )}
              {historical && (
                <Link to="/router" search={true} hash="">
                  返回最新对话
                </Link>
              )}
            </nav>
          )}
          {historical && !reading && (
            <p role={older.error ? 'alert' : 'status'}>
              {older.error?.message ?? '正在打开较早的对话…'}
            </p>
          )}
          {tracked && (
            <div ref={workEntry}>
              <EventWorkerActivity
                row={tracked}
                workAction={
                  <RouterSurface
                    messages={data.surface}
                    onAction={action}
                    disabled={busy || readOnly}
                    actionSlot={{ only: 'work_on_event' }}
                  />
                }
                focusQuestion={(prefix) => {
                  if (prefix && !draft.trimStart().startsWith(prefix)) changeDraft(prefix + draft)
                  composerInput.current?.focus()
                }}
              />
            </div>
          )}
          {requested && (
            <div ref={notificationEntry}>
              <NotificationActivity request={requested} route={data.route} />
            </div>
          )}
          {!eventActivity && reading && !reading.turns.length && !optimistic && (
            <p className="rw-hint">
              {data.event
                ? '从卡片选择一个问题，或写下你想了解的细节。'
                : '你可以问「我离开电脑后，通知会去哪里？」'}
            </p>
          )}
          {reading?.turns.map((turn) => (
            <article
              className="rw-turn"
              key={turn.id}
              id={`rw-turn-${turn.id}`}
              tabIndex={-1}
              ref={restoreWorkspaceAnchor}
            >
              <div className="rw-speaker">
                <b>{turn.requestId.startsWith('im-') ? '来自 IM 的提问' : '你'}</b>
                <Link
                  to="/router"
                  search={true}
                  hash={`rw-turn-${turn.id}`}
                  title="打开这条对话的固定链接"
                >
                  <Time value={turn.createdAt} />
                </Link>
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
                {turn.status === 'queued' && (
                  <output className="rw-busy">已排队，上一条处理结束后继续。</output>
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
                {turn.publications?.map((publication) => (
                  <a
                    key={publication.id}
                    className="rw-inline-button"
                    href={`/router?view=notifications#rw-publication-${publication.id}`}
                  >
                    打开「{publication.title}」
                  </a>
                ))}
                {turn.traceRunIds?.map((runId, index, runs) => (
                  <a
                    key={runId}
                    className="rw-inline-button"
                    id={`rw-turn-${turn.id}-${index}`}
                    ref={restoreWorkspaceAnchor}
                    href={workspaceTraceLink({ selected: runId }, `rw-turn-${turn.id}-${index}`)}
                  >
                    {runs.length === 1 ? '查看本轮轨迹' : `查看第 ${index + 1} 次处理轨迹`}
                  </a>
                ))}
                {!!turn.answer?.toolSteps?.length && (
                  <details className="rw-tool-steps">
                    <summary>查看处理过程（{turn.answer.toolSteps.length} 次工具调用）</summary>
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
          <div ref={dialogEnd} />
        </section>
        {eventActivity && context}
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
            ref={composerInput}
            id="router-message"
            aria-label="给 Router 发消息"
            placeholder={
              data.event ? '你想进一步了解什么？' : '例如「发送微信通知：处理充值」或「替我跟踪…」'
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
            <button type="submit" className="rw-send" disabled={sending || !draft.trim()}>
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
  const { event, view, task, matterId } = useSearch({ from: '/router' })
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
          <Link to="/router/traces" className="rw-inline-button">
            处理轨迹
          </Link>
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
          跟进事项
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
        <>
          <RouterPublicationFeed />
          <RouterWebNotifications />
        </>
      ) : showTasks ? (
        <>
          <RouterMatterList selectedId={matterId} />
          <details>
            <summary>已有的长期规则与任务</summary>
            <RouterMandateTasks
              selected={task}
              chat={view === 'chat'}
              renderConversation={(taskId) => conversation(`task-${taskId}`)}
            />
          </details>
        </>
      ) : (
        <div className="rw-layout">
          <EventRail scope={scope} />
          {conversation(scope)}
        </div>
      )}
    </div>
  )
}
