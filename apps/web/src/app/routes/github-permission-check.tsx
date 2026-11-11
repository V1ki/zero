import { useMutation } from '@tanstack/react-query'
import type {
  TriggerGithubPermissionReport,
  TriggerGithubPermissionSelection,
  TriggerGithubRepository,
} from '@zero-os/shared'
import { useEffect, useRef } from 'react'
import { apiFetch } from '../lib/api'

type Check = TriggerGithubPermissionReport['checks'][number]

const resourceLabels: Record<Check['resource'], string> = {
  actions: 'Actions 运行记录',
  prComments: 'PR 普通评论',
  prBase: 'PR 目标分支',
}

const statusLabels: Record<Check['status'], string> = {
  readable: '可读取',
  denied: 'GitHub 拒绝读取，请检查凭证和授权范围。',
  not_found: 'GitHub 返回 404，无法确认仓库或该资源的可见范围。',
  rate_limited: 'GitHub 已限制请求频率。',
  unavailable: '暂时无法核实，请稍后重试。',
}

export function GithubPermissionCheck({
  repo,
  credentialRef,
  validRef,
}: {
  repo: TriggerGithubRepository
  credentialRef: string
  validRef: boolean
}) {
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const prComments = Boolean(repo.mention.trim())
  const selection = {
    workflowFailures: repo.workflowFailures,
    prComments,
    prBase: prComments && Boolean(repo.branch.trim()),
  } satisfies TriggerGithubPermissionSelection
  const selected = [
    ...(selection.workflowFailures ? [resourceLabels.actions] : []),
    ...(selection.prComments ? [resourceLabels.prComments] : []),
    ...(selection.prBase ? [resourceLabels.prBase] : []),
  ]
  const probe = useMutation({
    mutationFn: () => {
      controller.current = new AbortController()
      return apiFetch<TriggerGithubPermissionReport>('/api/listeners/github/permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: repo.name, credentialRef, ...selection }),
        signal: controller.current.signal,
      })
    },
    retry: false,
  })
  return (
    <section className="listener-stack" aria-label={`${repo.name} 读取权限`}>
      <div className="listener-row">
        <button
          type="button"
          disabled={!validRef || !selected.length || probe.isPending}
          onClick={() => probe.mutate()}
        >
          {probe.isPending ? '正在检查读取权限…' : '检查读取权限'}
        </button>
        <small>{credentialRef ? '使用所选凭证' : '使用匿名访问'}</small>
      </div>
      <small>
        {selected.length
          ? `检查项目：${selected.join('、')}`
          : '请先选择要监听的工作流失败或 PR 提及。'}
      </small>
      {probe.error && (
        <p className="listener-error" role="alert">
          {probe.error.message}
        </p>
      )}
      {probe.data && (
        <div aria-live="polite">
          <small>{probe.data.access === 'anonymous' ? '匿名访问结果' : '所选凭证的读取结果'}</small>
          <ul className="listener-status">
            {probe.data.checks.map((item) => (
              <li key={item.resource}>
                <b>{resourceLabels[item.resource]}</b> · {statusLabels[item.status]}
                {item.status === 'rate_limited' &&
                  item.retryAfterMs !== undefined &&
                  ` 约 ${Math.max(1, Math.ceil(item.retryAfterMs / 1000))} 秒后可重试。`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
