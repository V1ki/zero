import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  RouterMatter,
  RouterPublication,
  RouterPublicationTrace,
  RouterSurfaceAction,
} from '@zero-os/shared'
import { useState } from 'react'
import { RouterMessage } from '../components/RouterMessage'
import { RouterSurface } from '../components/RouterSurface'
import { apiFetch, apiPost } from '../lib/api'
import { workspaceTraceLink, restoreWorkspaceAnchor } from '../lib/router-trace-navigation'
import { channels, deliveryNames } from '../lib/router-delivery-labels'

const stateNames = {
  open: '待办理',
  working: '办理中',
  waiting: '等待后续',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已停止',
}
export function RouterMatterList({ selectedId }: { selectedId?: string }) {
  const query = useQuery({
    queryKey: ['router-matters', selectedId ?? ''],
    queryFn: ({ signal }) =>
      apiFetch<
        (RouterMatter & {
          sources?: Array<{ id: number; title: string }>
          documents?: Array<{
            key: string
            title: string
            state: 'running' | 'accepted' | 'rejected' | 'unknown'
            reason?: string | null
            url: string | null
          }>
          corrections?: Array<{ eventId: number; reason: string; recordedAt: string }>
          workerSessions?: {
            jobId: number
            latestRunId: string | null
            handoffFromJobId?: number | null
          }[]
        })[]
      >(
        `/api/listeners/router-matters${selectedId ? `?id=${encodeURIComponent(selectedId)}` : ''}`,
        { signal },
      ),
    refetchInterval: 3000,
  })
  return (
    <section aria-label="正在跟进的事项">
      {selectedId && <a href="/router?view=tasks">查看全部跟进事项</a>}
      {query.isError && <p role="alert">无法读取事项，请刷新后重试。</p>}
      {query.data?.length === 0 && (
        <p className="rw-hint">
          {selectedId
            ? '此事项当前不可查看。'
            : '还没有需要持续跟进的事项。Router 会根据收到的线索判断是否建立事项。'}
        </p>
      )}
      {query.data?.map((matter) => (
        <article className="rw-turn" key={matter.id}>
          <div className="rw-speaker">
            <b>{matter.title}</b>
            <span>{stateNames[matter.state]}</span>
          </div>
          <RouterMessage text={matter.goal} />
          {!!matter.documents?.length && (
            <ul aria-label="文档归档结果">
              {matter.documents.map((doc) => (
                <li key={doc.key}>
                  {
                    {
                      accepted: '已写入',
                      running: '正在写入',
                      rejected: '写入失败',
                      unknown: '写入结果待核对',
                    }[doc.state]
                  }
                  {' · '}
                  {doc.url ? (
                    <a href={doc.url} target="_blank" rel="noreferrer">
                      {doc.title}
                    </a>
                  ) : (
                    doc.title
                  )}
                  {doc.reason && <p>{doc.reason}</p>}
                </li>
              ))}
            </ul>
          )}
          {matter.workerSessions?.map((worker) =>
            worker.latestRunId ? (
              <p key={worker.jobId}>
                <a
                  id={`rw-worker-${worker.jobId}`}
                  ref={restoreWorkspaceAnchor}
                  href={workspaceTraceLink(
                    { sessionId: `router-job-${worker.jobId}`, selected: worker.latestRunId },
                    `rw-worker-${worker.jobId}`,
                  )}
                >
                  查看 Worker #{worker.jobId} 的工作轨迹
                </a>
                {worker.handoffFromJobId && (
                  <span> · 接手自 Worker #{worker.handoffFromJobId}</span>
                )}
              </p>
            ) : (
              <p key={worker.jobId}>Worker #{worker.jobId} 暂无已记录的轨迹。</p>
            ),
          )}
          {(!!matter.sources?.length || !!matter.corrections?.length) && (
            <details>
              <summary>关联事件（{matter.sources?.length ?? 0}）</summary>
              {!!matter.sources?.length && (
                <ul>
                  {matter.sources.map((source) => (
                    <li key={source.id}>
                      <a href={`/router?event=${source.id}`}>
                        事件 #{source.id} · {source.title}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              {!!matter.corrections?.length && (
                <details>
                  <summary>查看历史纠正</summary>
                  <ul>
                    {matter.corrections.map((c, i) => (
                      <li key={`${c.eventId}-${i}`}>
                        {new Date(c.recordedAt).toLocaleString('zh-CN')} 移出事件 #{c.eventId} ·{' '}
                        {c.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </details>
          )}
          <details>
            <summary>完成标准与记录</summary>
            <ul>
              {matter.criteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
            <p className="rw-hint">
              记录版本 {matter.version} · 更新于{' '}
              {new Date(matter.updatedAt).toLocaleString('zh-CN')}
            </p>
            <a href={`/router/traces?matterId=${encodeURIComponent(matter.id)}`}>
              查看这件事的处理轨迹
            </a>
            <details>
              <summary>调试：完整事项上下文</summary>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {JSON.stringify(matter.context, null, 2)}
              </pre>
            </details>
          </details>
        </article>
      ))}
    </section>
  )
}
export function RouterPublicationFeed({ scope }: { scope?: string }) {
  const cache = useQueryClient()
  const [notice, setNotice] = useState('')
  const selected = /^#rw-publication-([a-f0-9]{64})$/.exec(window.location.hash)?.[1]
  const query = useQuery({
    queryKey: ['router-publications', selected ?? 'recent'],
    queryFn: ({ signal }) =>
      apiFetch<
        (RouterPublication & {
          traceReceipts?: RouterPublicationTrace[]
          reminder?: { dueAt: string; state: string }
        })[]
      >('/api/listeners/router-publications' + (selected ? '?id=' + selected : ''), { signal }),
    refetchInterval: 3000,
  })
  const action = useMutation({
    mutationFn: ({ id, gesture }: { id: string; gesture: RouterSurfaceAction }) =>
      apiPost<{ message: string }>(`/api/listeners/router-publications/${id}/actions`, {
        actionId: gesture.action.sourceComponentId,
        gesture,
        requestId: crypto.randomUUID(),
      }),
    onSuccess: (result) => {
      setNotice(result.message)
      void cache.invalidateQueries({ queryKey: ['router-matters'] })
    },
  })
  const entries =
    query.data?.filter((p) => !scope || scope === 'general' || p.scope === scope) ?? []
  return (
    <section aria-label="Router 交付与各平台回执">
      {selected && <a href="/router?view=notifications">查看最近交付</a>}
      {selected && query.data?.length === 0 && <p>这份交付当前不可查看。</p>}
      {query.isError && <p role="alert">交付记录暂时无法读取。</p>}
      {notice && <output>{notice}</output>}
      {action.isError && <p role="alert">{action.error.message}</p>}
      {entries.map((publication) => {
        const web = publication.deliveries.find((d) => d.channel === 'web')
        return (
          <article
            className="rw-turn"
            key={publication.id}
            id={`rw-publication-${publication.id}`}
            tabIndex={-1}
            ref={restoreWorkspaceAnchor}
          >
            <div className="rw-speaker">
              <b>{web?.presentation.title ?? '事项更新'}</b>
              <time dateTime={publication.createdAt}>
                {new Date(publication.createdAt).toLocaleString('zh-CN')}
              </time>
            </div>
            {publication.reminder && (
              <p className="rw-hint">
                {publication.reminder.state === 'scheduled'
                  ? '提醒复核时间'
                  : publication.reminder.state === 'cancelled'
                    ? '已取消提醒复核'
                    : '提醒复核已到期'}
                {' · '}
                {new Date(publication.reminder.dueAt).toLocaleString()}
              </p>
            )}
            {web?.status === 'accepted' && web.presentation.generatedUI && (
              <RouterSurface
                messages={web.presentation.generatedUI.messages}
                disabled={action.isPending}
                onAction={(event) => action.mutate({ id: publication.id, gesture: event })}
              />
            )}
            {web &&
              (web.presentation.generatedUI ? (
                <details>
                  <summary>完整文字与证据链接</summary>
                  <RouterMessage text={web.presentation.text} />
                </details>
              ) : (
                <RouterMessage text={web.presentation.text} />
              ))}
            <a href={`/router/traces?matterId=${encodeURIComponent(publication.matterId)}`}>
              查看这件事的处理轨迹
            </a>
            <details>
              <summary>查看各平台投递结果</summary>
              <ul>
                {publication.deliveries.map((delivery) => (
                  <li key={delivery.channel}>
                    {channels[delivery.channel]}：{deliveryNames[delivery.status]}
                    {delivery.reason && ` · ${delivery.reason}`}
                  </li>
                ))}
              </ul>
              {publication.traceReceipts?.map((trace) => (
                <a
                  key={trace.ordinal}
                  id={`rw-receipt-${trace.ordinal}`}
                  ref={restoreWorkspaceAnchor}
                  href={workspaceTraceLink(
                    { selected: trace.runId, entry: String(trace.ordinal) },
                    `rw-receipt-${trace.ordinal}`,
                  )}
                >
                  {trace.operation === 'publish_update'
                    ? '查看首次投递回执'
                    : `查看${trace.channel ? channels[trace.channel] : ''}重试回执`}
                </a>
              ))}
              <p className="rw-hint">
                平台已受理表示接口确认接收，不代表你已读。待核对的投递不会自动重发。
              </p>
            </details>
          </article>
        )
      })}
    </section>
  )
}
