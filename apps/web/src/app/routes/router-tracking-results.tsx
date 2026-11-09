import { ArrowClockwise, GitBranch } from '@phosphor-icons/react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { RouterTrackingResult } from '@zero-os/shared'
import { type ReactNode, useState } from 'react'
import { RouterMessage } from '../components/RouterMessage'
import { restoreWorkspaceAnchor, workspaceTraceLink } from '../lib/router-trace-navigation'
import { apiFetch } from '../lib/api'
import { localWebNotifications } from '../lib/web-notifications'
import './router-tracking-results.css'

const pageSize = 15
const previewSize = 3
const kindLabels: Record<RouterTrackingResult['kind'], string> = {
  issue: 'Issue',
  pr: 'PR',
  'issue-comment': 'Issue 评论',
  'pr-comment': 'PR 评论',
  'workflow-failure': 'Actions 运行失败',
  'archive-message': '微信归档',
}
type Receipt = Pick<RouterTrackingResult, 'status' | 'work' | 'workOrigin' | 'result'>
const legacySummary = (row: Receipt) =>
  row.status === 'completed' && !row.work && row.workOrigin !== 'manual'

function statusLabel(row: Receipt) {
  switch (row.status) {
    case 'queued':
      return '等待开始处理'
    case 'running':
      return '正在处理'
    case 'failed':
      return '办理失败'
    case 'unknown':
      return '执行结果未知'
    case 'completed':
      switch (row.work?.outcome) {
        case 'observed':
          return '无需办理'
        case 'resolved':
          return '已办结'
        case 'needs_input':
          return '尚未完成'
        default:
          return legacySummary(row) ? '摘要已完成' : '处理结果尚未核实'
      }
  }
}

const stepLabel = {
  inspect_github: '查看原始记录',
  inspect_archive: '核对归档原文',
  compare_runs: '对比工作流运行',
  find_related_issues: '查找相关历史 Issue',
  close_issue: '关闭当前 Issue 并核对 GitHub 状态',
} as const

function Evidence({ receipt, row }: { receipt: Receipt; row: RouterTrackingResult }) {
  const decision = receipt.work?.followup
  const archive = row.source === 'wxarc'
  const sourceEvent = `/router?event=${row.inboxId}`
  const sources =
    receipt.work?.sources.filter(({ url }) => {
      if (archive) return url === sourceEvent
      try {
        const parsed = new URL(url)
        return (
          parsed.origin === 'https://github.com' &&
          !parsed.username &&
          !parsed.password &&
          parsed.pathname.toLowerCase().startsWith(`/${row.repository.toLowerCase()}/`)
        )
      } catch {
        return false
      }
    }) ?? []
  return (
    <>
      {decision && (
        <p className="rw-decision">
          <strong>
            {decision.kind === 'continue' ? '已有事项' : '新线索'}
            {' · '}
            {decision.decision === 'observe'
              ? '留作记录'
              : decision.kind === 'continue'
                ? '原 Worker 接续办理'
                : '自动办理'}
          </strong>
          {decision.reason}
        </p>
      )}
      {receipt.result && receipt.result !== decision?.reason && (
        <RouterMessage text={receipt.result} />
      )}
      {!!sources.length && (
        <nav className="rw-evidence-links" aria-label="Worker 核对的来源">
          {sources.map(({ url, label }) =>
            archive ? (
              <Link key={url} to="/router" search={{ event: row.inboxId }} hash="rw-source-text">
                {label}
              </Link>
            ) : (
              <a key={url} href={url} target="_blank" rel="noreferrer">
                {label} ↗
              </a>
            ),
          )}
        </nav>
      )}
      {!!receipt.work?.steps.length && (
        <details className="rw-work-steps">
          <summary>办理经过（{receipt.work.steps.length} 步）</summary>
          <ol>
            {receipt.work.steps.map(({ tool, ok }, i) => (
              <li key={`${i}-${tool}`}>
                {stepLabel[tool]} · {ok ? '已返回' : '未完成'}
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  )
}

function githubEventUrl(item: RouterTrackingResult) {
  if (item.source === 'wxarc' || !item.url || !/^[\w.-]+\/[\w.-]+$/u.test(item.repository))
    return null
  const match =
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/[1-9]\d*(#issuecomment-[1-9]\d*)?$/iu.exec(
      item.url,
    )
  return match &&
    match[1].toLowerCase() === item.repository.toLowerCase() &&
    match[2] === (item.kind.startsWith('issue') ? 'issues' : 'pull') &&
    Boolean(match[3]) === item.kind.endsWith('-comment')
    ? item.url
    : null
}

function WorkerTrace({
  row,
  attempt,
  run,
}: { row: RouterTrackingResult; attempt?: number; run?: string }) {
  const anchor = `rw-event-${row.inboxId}-worker-${row.id}-${attempt ?? 'all'}`
  return (
    <a
      id={anchor}
      ref={restoreWorkspaceAnchor}
      href={workspaceTraceLink(
        { sessionId: `router-job-${row.id}`, ...(run && { selected: run }) },
        anchor,
      )}
    >
      {run ? `查看第 ${attempt} 轮运行轨迹` : `查看 Worker #${row.id} 的运行记录`}
    </a>
  )
}

export function EventWorkerActivity({
  row,
  focusQuestion,
  workAction,
}: {
  row: RouterTrackingResult
  focusQuestion: (prefix?: string) => void
  workAction: ReactNode
}) {
  const pending = row.status === 'queued' || row.status === 'running'
  const legacy = legacySummary(row)
  const title = legacy ? '自动生成的摘要' : '处理进展'
  const prior = row.previous
  return (
    <article className="rw-turn rw-activity" aria-label={title}>
      <div className="rw-activity-heading">
        <b>{title}</b>
        <output>{statusLabel(row)}</output>
      </div>
      <p className="rw-hint">
        {row.workOrigin === 'manual' ? '手动派工' : row.source === 'wxarc' ? '微信归档' : 'GitHub'}
        {' · '}Worker #{row.id}
        {row.attempt && ` · 第 ${row.attempt} 轮`}
        {legacy && ' · 这次只生成了摘要'}
      </p>
      <Evidence receipt={row} row={row} />
      {pending && <p className="rw-hint">处理结果会自动更新到这条对话。</p>}
      {row.attentionQuestion && <p className="rw-tracking-question">{row.attentionQuestion}</p>}
      {prior && (
        <details className="rw-work-previous">
          <summary>
            上一次{legacySummary(prior) ? '摘要' : '办理'} · 第 {prior.attempt} 轮 ·{' '}
            {statusLabel(prior)}
          </summary>
          <Evidence receipt={prior} row={row} />
          <WorkerTrace row={row} attempt={prior.attempt} run={prior.traceRunId} />
        </details>
      )}
      {!pending && (
        <div className="rw-work-controls">
          {row.source !== 'wxarc' && workAction}
          <button type="button" className="rw-inline-button" onClick={() => focusQuestion()}>
            {legacy ? '追问这条摘要' : '询问这次结果'}
          </button>
          {!legacy && row.source !== 'wxarc' && (
            <button
              type="button"
              className="rw-inline-button"
              onClick={() => focusQuestion('继续办理：')}
            >
              补充办理要求
            </button>
          )}
        </div>
      )}
    </article>
  )
}

export function RouterTrackingResults() {
  const local = localWebNotifications()
  const [expanded, setExpanded] = useState(false)
  const query = useInfiniteQuery({
    queryKey: ['listeners', 'tracking-results'],
    enabled: local,
    initialPageParam: 0,
    gcTime: 0,
    queryFn: ({ pageParam, signal }) =>
      apiFetch<{ items: RouterTrackingResult[] }>(
        `/api/listeners/tracking-results?limit=${pageSize}${pageParam ? `&beforeId=${pageParam}` : ''}`,
        { signal, cache: 'no-store' },
      ),
    getNextPageParam: (last) =>
      last.items.length === pageSize ? last.items.at(-1)?.inboxId : undefined,
    retry: false,
    refetchInterval: (q) => {
      if (q.state.status === 'error') return false
      const pending = q.state.data?.pages.some(({ items }) =>
        items.some((row) => row.status === 'queued' || row.status === 'running'),
      )
      return pending ? 4000 : 30_000
    },
  })
  if (!local) return null
  const rows = query.isSuccess ? query.data.pages.flatMap(({ items }) => items) : []
  const visible = expanded ? rows : rows.slice(0, previewSize)
  const attention = rows.filter((row) => row.needsAttention).length
  return (
    <section className="rw-tracking" aria-label="Router 跟进动态">
      <header>
        <div className="rw-tracking-heading">
          <GitBranch size={18} aria-hidden="true" />
          <h2>Router 跟进动态</h2>
          {attention > 0 && (
            <span className="rw-tracking-attention">最近记录中 {attention} 项待确认</span>
          )}
        </div>
        <button
          type="button"
          className="rw-icon-button"
          aria-label="刷新跟踪动态"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <ArrowClockwise size={16} />
        </button>
      </header>
      {query.isLoading && <p className="rw-hint">正在读取跟踪动态…</p>}
      {query.error && (
        <p className="rw-error" role="alert">
          {query.error.message}
        </p>
      )}
      {query.isSuccess && !rows.length && (
        <p className="rw-hint">
          收到已监听的线索后，这里会显示 Router 的判断和 Worker 的办理结果。
        </p>
      )}
      {visible.length > 0 && (
        <ol>
          {visible.map((row) => {
            const url = githubEventUrl(row)
            return (
              <li key={row.inboxId} data-attention={row.needsAttention}>
                <div className="rw-tracking-meta">
                  {row.repository && <span>{row.repository}</span>}
                  <span>{kindLabels[row.kind]}</span>
                  <time dateTime={row.occurredAt}>
                    {new Date(row.occurredAt).toLocaleString('zh-CN')}
                  </time>
                  <strong>
                    {row.needsAttention && row.work?.outcome !== 'needs_input'
                      ? `待确认 · ${statusLabel(row)}`
                      : statusLabel(row)}
                  </strong>
                </div>
                <h3>
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer">
                      {row.title}
                    </a>
                  ) : (
                    row.title
                  )}
                </h3>
                {row.needsAttention && row.attentionQuestion && (
                  <p className="rw-tracking-question">{row.attentionQuestion}</p>
                )}
                {(row.result || row.work) && (
                  <details>
                    <summary>
                      {row.needsAttention
                        ? '查看待确认事项'
                        : row.work?.followup?.decision === 'observe'
                          ? '查看记录原因'
                          : legacySummary(row)
                            ? '查看自动摘要'
                            : '查看办理结果'}
                    </summary>
                    <Evidence receipt={row} row={row} />
                  </details>
                )}
                <Link to="/router" search={{ event: row.inboxId }} className="rw-inline-button">
                  查看事件 #{row.inboxId}
                </Link>
              </li>
            )
          })}
        </ol>
      )}
      {rows.length > previewSize && (
        <button type="button" className="rw-inline-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起较早记录' : '展开较早记录'}
        </button>
      )}
      {expanded && query.hasNextPage && (
        <button
          type="button"
          className="rw-inline-button"
          disabled={query.isFetching}
          onClick={() => void query.fetchNextPage()}
        >
          加载更多跟踪动态
        </button>
      )}
    </section>
  )
}
