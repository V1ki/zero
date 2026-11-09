import { useQuery } from '@tanstack/react-query'
import type { TriggerSettingsSnapshot } from '@zero-os/shared'
import { useState } from 'react'
import { apiFetch } from '../lib/api'

export function RouterCommentSubscription({
  busy,
  ask,
}: {
  busy: boolean
  ask: (text: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [repository, setRepository] = useState('')
  const [issues, setIssues] = useState(false)
  const [pulls, setPulls] = useState(false)
  const config = useQuery({
    queryKey: ['listeners', 'config'],
    queryFn: ({ signal }) => apiFetch<TriggerSettingsSnapshot>('/api/listeners/config', { signal }),
    enabled: open,
    retry: false,
  })
  const name = repository.trim()
  const valid = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i.test(name) && !/\/\.{1,2}$/.test(name)
  const types = [issues && 'Issue', pulls && 'PR'].filter(Boolean).join(' 和 ')
  const github = config.data?.settings.github
  return (
    <details className="rw-original" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>跟踪 GitHub 普通评论</summary>
      <form
        className="listeners-panel rw-comment-form"
        aria-label="跟踪 GitHub 普通评论"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid && types && !busy && github?.routerTrackingEnabled)
            ask(`跟踪 ${name} 的 ${types} 普通评论`)
        }}
      >
        <label className="listener-field">
          目标仓库
          <input
            list="router-comment-repositories"
            placeholder="选择已配置的仓库，或输入 owner/repo"
            value={repository}
            maxLength={140}
            onChange={(e) => setRepository(e.target.value)}
          />
          <datalist id="router-comment-repositories">
            {github?.repositories.map((repo) => (
              <option key={repo.name} value={repo.name} />
            ))}
          </datalist>
        </label>
        <div className="listener-row">
          <label className="listener-row">
            <input type="checkbox" checked={issues} onChange={(e) => setIssues(e.target.checked)} />
            Issue 普通评论
          </label>
          <label className="listener-row">
            <input type="checkbox" checked={pulls} onChange={(e) => setPulls(e.target.checked)} />
            PR 普通评论
          </label>
        </div>
        <small>选择要开启的讨论评论。新评论无需 @ 即可入箱，危险操作请求会被过滤。</small>
        {config.isError && (
          <p role="alert" className="listener-error">
            无法读取仓库配置。
            <button type="button" onClick={() => void config.refetch()}>
              重新读取
            </button>
          </p>
        )}
        {github && !github.routerTrackingEnabled && (
          <p className="rw-hint">
            请先在<a href="/config?tab=listeners">监听配置</a>开启「允许 Router 跟踪 GitHub 仓库」。
          </p>
        )}
        <div className="listener-row">
          <button
            type="submit"
            className="listener-primary"
            disabled={!valid || !types || busy || !github?.routerTrackingEnabled}
          >
            发送跟踪请求
          </button>
        </div>
      </form>
    </details>
  )
}
