import { useInfiniteQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { TriggerWebNotification } from '@zero-os/shared'
import { apiFetch } from '../lib/api'
import {
  localWebNotifications,
  webNotificationHistoryKey,
  webNotificationsApi,
} from '../lib/web-notifications'
import './router-web-notifications.css'

const pageSize = 30

export function RouterWebNotifications() {
  const local = localWebNotifications()
  const notices = useInfiniteQuery({
    queryKey: webNotificationHistoryKey,
    enabled: local,
    initialPageParam: 0,
    gcTime: 0,
    queryFn: ({ pageParam, signal }) =>
      apiFetch<{ items: TriggerWebNotification[]; latestId: number }>(
        `${webNotificationsApi}?limit=${pageSize}${pageParam ? `&before=${pageParam}` : ''}`,
        { signal, cache: 'no-store' },
      ),
    getNextPageParam: (last) =>
      last.items.length === pageSize ? last.items.at(-1)?.id : undefined,
    retry: false,
    refetchInterval: (q) => (q.state.status === 'error' ? false : 30_000),
  })
  const items = local && notices.isSuccess ? notices.data.pages.flatMap((page) => page.items) : []
  return (
    <section className="wn-history" aria-label="网页提醒记录">
      <header>
        <div>
          <h2>网页提醒记录</h2>
          <p>按送达时间排列。打开任务查看上下文，或回到原始事件继续跟进。</p>
        </div>
        {local && (
          <button
            type="button"
            className="rw-inline-button"
            disabled={notices.isFetching}
            onClick={() => void notices.refetch()}
          >
            刷新网页提醒
          </button>
        )}
      </header>
      {!local && <p>请在运行 ZeRo 的电脑上打开本机网页查看。</p>}
      {local && notices.isLoading && <p>正在读取提醒…</p>}
      {notices.error && (
        <p role="alert" className="rw-error">
          {notices.error.message}
        </p>
      )}
      {notices.isSuccess && !items.length && <p>还没有送达网页的提醒。</p>}
      <ol>
        {items.map((item) => (
          <li key={item.id}>
            <div className="wn-entry-meta">
              <span>{item.taskId ? `持续任务 #${item.taskId}` : `事件 #${item.inboxId}`}</span>
              <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
            </div>
            <h3>
              <Link
                to="/router"
                search={item.taskId ? { task: item.taskId } : { event: item.inboxId }}
              >
                {item.title ||
                  (item.taskId ? `打开任务 #${item.taskId}` : `打开事件 #${item.inboxId}`)}
              </Link>
            </h3>
            {item.summary && <p>{item.summary}</p>}
          </li>
        ))}
      </ol>
      {notices.hasNextPage && (
        <button
          type="button"
          className="rw-inline-button"
          disabled={notices.isFetching}
          onClick={() => void notices.fetchNextPage()}
        >
          加载更早提醒
        </button>
      )}
    </section>
  )
}
