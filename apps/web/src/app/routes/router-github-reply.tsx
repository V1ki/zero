import { useQuery } from '@tanstack/react-query'
import type { TriggerInboxItem } from '@zero-os/shared'
import { useRef, useState } from 'react'
import { apiFetch } from '../lib/api'

interface Target {
  repository: string
  number: number
  kind: 'issue' | 'pr'
  author: string
  url: string
}

type SendState =
  | { status: 'draft' | 'sending' }
  | { status: 'sent'; author: string; url: string }
  | { status: 'failed' | 'unknown'; message: string }

type Delivery = { origin: 'manual' | 'worker' } & (
  | { state: 'sent'; id: number; author: string; url: string }
  | { state: 'pending' | 'unknown' }
  | { state: 'rejected'; error: string }
)

const uncertain = '未收到可核对的发布回执。请先打开原讨论，确认评论是否已出现。'

function matchesReceipt(target: Target, id: unknown, url: unknown): url is string {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || typeof url !== 'string')
    return false
  return ['issues', 'pull'].some(
    (path) =>
      url.toLowerCase() ===
      `https://github.com/${target.repository}/${path}/${target.number}#issuecomment-${id}`.toLowerCase(),
  )
}

function CommentForm({
  apiUrl,
  target,
  reloadIdentity,
}: {
  apiUrl: string
  target: Target
  reloadIdentity: () => void
}) {
  const [body, setBody] = useState('')
  const [state, setState] = useState<SendState>({ status: 'draft' })
  const lock = useRef(false)
  const canSubmit = !!body.trim() && state.status === 'draft'
  async function publish() {
    if (!canSubmit || lock.current) return
    lock.current = true
    setState({ status: 'sending' })
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'If-Match': `"${target.author}"` },
        body: JSON.stringify({ requestId: crypto.randomUUID(), body: body.trim() }),
      })
      const json: unknown = await response.json()
      if (typeof json !== 'object' || !json) {
        setState({ status: 'unknown', message: uncertain })
        return
      }
      const result = json as Record<string, unknown>
      if (!response.ok) {
        setState({
          status:
            result.status === 'unknown' || (response.status >= 500 && result.status !== 'rejected')
              ? 'unknown'
              : 'failed',
          message: typeof result.error === 'string' ? result.error : '未能确认评论已发布。',
        })
        if (response.status === 412) reloadIdentity()
      } else if (
        result.status === 'sent' &&
        result.author === target.author &&
        matchesReceipt(target, result.id, result.url)
      ) {
        setState({ status: 'sent', author: result.author, url: result.url })
      } else {
        setState({ status: 'unknown', message: uncertain })
      }
    } catch {
      setState({ status: 'unknown', message: uncertain })
    } finally {
      lock.current = false
    }
  }
  return (
    <details className="rw-original">
      <summary>在 GitHub 回复</summary>
      <form
        className="listeners-panel rw-comment-form rw-github-reply"
        aria-label="在 GitHub 回复"
        onSubmit={(e) => {
          e.preventDefault()
          void publish()
        }}
      >
        <p>
          以 <strong>{target.author}</strong> 在{' '}
          <a href={target.url} target="_blank" rel="noreferrer">
            {target.repository} · {target.kind === 'issue' ? 'Issue' : 'PR'} #{target.number}
          </a>{' '}
          发表普通评论。能查看该讨论的人都能看到。
        </p>
        {state.status === 'sent' ? (
          <output>
            {state.author} 已发布。{' '}
            <a href={state.url} target="_blank" rel="noreferrer">
              查看已发布的评论
            </a>
          </output>
        ) : (
          <label className="listener-field">
            评论正文
            <textarea
              value={body}
              rows={4}
              maxLength={4000}
              readOnly={state.status !== 'draft'}
              placeholder="写下要发到这条讨论的内容"
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
        )}
        {(state.status === 'failed' || state.status === 'unknown') && (
          <p role="alert" className="rw-error">
            {state.message}{' '}
            <a href={target.url} target="_blank" rel="noreferrer">
              查看原讨论
            </a>
          </p>
        )}
        <div className="listener-row">
          {(state.status === 'draft' || state.status === 'sending') && (
            <button type="submit" className="listener-primary" disabled={!canSubmit}>
              {state.status === 'sending' ? '正在发布…' : '发布到 GitHub'}
            </button>
          )}
          {(state.status === 'sent' || state.status === 'failed') && (
            <button
              type="button"
              onClick={() => {
                if (state.status === 'sent') setBody('')
                setState({ status: 'draft' })
              }}
            >
              {state.status === 'sent' ? '撰写另一条评论' : '继续编辑'}
            </button>
          )}
        </div>
      </form>
    </details>
  )
}

export function RouterGithubReply({ event }: { event: TriggerInboxItem }) {
  const apiUrl = `/api/listeners/workspace/${event.id}/github-reply`
  const source = event.url?.match(
    /^https:\/\/github\.com\/([\w-]+\/[\w.-]+)\/(issues|pull)\/([1-9]\d*)(?:#issuecomment-[1-9]\d*)?$/i,
  )
  const eligible =
    event.source === 'github' && source?.[1].toLowerCase() === event.scope.toLowerCase()
  const preview = useQuery({
    queryKey: ['router-github-reply', event.id],
    queryFn: ({ signal }) =>
      apiFetch<{ target: Target | null; delivery?: Delivery }>(apiUrl, { signal }),
    enabled: eligible,
    retry: false,
    refetchInterval: (query) => (query.state.status === 'error' ? false : 15_000),
  })
  if (!eligible || !source) return null
  if (preview.isError) {
    return (
      <p className="rw-hint">
        无法核对这条讨论的 GitHub 回复身份。{' '}
        <button type="button" className="rw-inline-button" onClick={() => void preview.refetch()}>
          重新读取
        </button>
      </p>
    )
  }
  const target = preview.data?.target
  if (
    !target ||
    target.repository.toLowerCase() !== event.scope.toLowerCase() ||
    target.number !== Number(source[3]) ||
    target.kind !== (source[2].toLowerCase() === 'issues' ? 'issue' : 'pr') ||
    target.url.toLowerCase() !== source[0].split('#')[0].toLowerCase()
  )
    return null
  const delivery = preview.data?.delivery
  return (
    <>
      {delivery && (
        <p className="rw-hint" aria-label="GitHub 回复回执">
          {delivery.origin === 'worker' ? 'Worker 自动回帖' : '手动发布'} ·{' '}
          {delivery.state === 'sent' && matchesReceipt(target, delivery.id, delivery.url) ? (
            <a href={delivery.url} target="_blank" rel="noreferrer">
              {delivery.author} 已回复原讨论
            </a>
          ) : delivery.state === 'rejected' ? (
            delivery.error
          ) : (
            '发送结果待核对，请查看原讨论。'
          )}
        </p>
      )}
      <CommentForm
        key={`${event.id}:${target.author}`}
        apiUrl={apiUrl}
        target={target}
        reloadIdentity={() => void preview.refetch()}
      />
    </>
  )
}
