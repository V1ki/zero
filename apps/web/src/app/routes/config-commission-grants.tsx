import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CommissionGrant, CommissionGrantsView } from '@zero-os/shared'
import { useState } from 'react'
import { apiFetch, apiPut } from '../lib/api'

const path = '/api/listeners/commission-grants'
const key = ['listeners', 'commission-grants']
export function CommissionGrants() {
  const client = useQueryClient()
  const view = useQuery({ queryKey: key, queryFn: () => apiFetch<CommissionGrantsView>(path) })
  const [operator, setOperator] = useState('')
  const [source, setSource] = useState('')
  const [targetIds, setTargetIds] = useState<string[]>([])
  const [projectId, setProjectId] = useState('')
  const [doc, setDoc] = useState('')
  const save = useMutation({
    mutationFn: (grants: CommissionGrant[]) =>
      apiPut<CommissionGrantsView>(path, { revision: view.data?.revision, grants }),
    onSuccess: (value) => {
      client.setQueryData(key, value)
      setOperator('')
      setSource('')
      setTargetIds([])
      setProjectId('')
      setDoc('')
    },
  })
  const data = view.data
  const identity = (t: CommissionGrant['operator']) =>
    JSON.stringify([t.platform, t.channelId, t.peerId, t.operatorId])
  const sourceKey = (s: Omit<CommissionGrant, 'operator'>) => JSON.stringify([s.source, s.scope])
  const chosen = data?.operators.find((t) => identity(t) === operator)
  const scope = data?.scopes.find((s) => sourceKey(s) === source)
  const exists = data?.grants.some(
    (g) => identity(g.operator) === operator && sourceKey(g) === source,
  )
  return (
    <details className="listener-section">
      <summary>允许从 IM 管理跟踪委托</summary>
      <p>
        按会话、操作者和来源单独授权。获准的人可以在这个会话中创建委托，确认或暂停自己创建的委托。
      </p>
      {(view.error || save.error) && (
        <p role="alert">
          {(view.error ?? save.error)?.message}{' '}
          <button type="button" onClick={() => void view.refetch()}>
            刷新授权
          </button>
        </p>
      )}
      {!data && view.isPending && <p>正在读取绑定会话…</p>}
      {data && (
        <>
          <ul>
            {data.grants.map((g) => (
              <li key={identity(g.operator) + sourceKey(g)}>
                {g.operator.platform} · {g.operator.channelId} / {g.operator.peerId} · 操作者{' '}
                {g.operator.operatorId} →{' '}
                {data.scopes.find((s) => sourceKey(s) === sourceKey(g))?.label ?? g.scope}{' '}
                {g.projectId && (
                  <>
                    {' '}
                    · 项目规则{' '}
                    {data.projects.find((p) => p.id === g.projectId)?.name ?? g.projectId}
                  </>
                )}
                {!!g.targets?.length && (
                  <>
                    {' '}
                    · 可通知{' '}
                    {g.targets.map((t) => `${t.platform}/${t.channelId}/${t.peerId}`).join('、')}
                  </>
                )}
                {g.archive && (
                  <>
                    {' '}
                    · 文档 {g.archive.channelId}/{g.archive.documentId}
                  </>
                )}
                <button
                  type="button"
                  disabled={save.isPending}
                  onClick={() => save.mutate(data.grants.filter((row) => row !== g))}
                >
                  撤销授权
                </button>
              </li>
            ))}
          </ul>
          <label>
            绑定会话和操作者{' '}
            <select value={operator} onChange={(e) => setOperator(e.target.value)}>
              <option value="">选择已验证的操作者</option>
              {data.operators.map((t) => (
                <option key={identity(t)} value={identity(t)}>
                  {t.platform} · {t.label} · {t.operatorId}
                </option>
              ))}
            </select>
          </label>
          <label>
            允许管理的来源{' '}
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">选择已启用的来源</option>
              {data.scopes.map((s) => (
                <option key={sourceKey(s)} value={sourceKey(s)}>
                  {s.source} · {s.label}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>从该入口可以指定的其他去向</legend>
            <label>
              其他提醒会话（最多三个）
              <select
                multiple
                value={targetIds}
                onChange={(e) =>
                  setTargetIds(Array.from(e.target.selectedOptions, (v) => v.value).slice(0, 3))
                }
              >
                {data.operators
                  .filter((t) => identity(t) !== operator)
                  .map((t) => (
                    <option key={identity(t)} value={identity(t)}>
                      {t.platform} · {t.label}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              委托可用的归档文档{' '}
              <select value={doc} onChange={(e) => setDoc(e.target.value)}>
                <option value="">无</option>
                {data.archives.map((d) => (
                  <option key={JSON.stringify(d)} value={JSON.stringify(d)}>
                    {d.channelId} / {d.documentId}
                  </option>
                ))}
              </select>
            </label>
            <label>
              可管理提醒规则的项目{' '}
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">无</option>
                {data.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <small>项目中的每个监听来源都需要为此人授予同一项目的权限。</small>
          </fieldset>
          <button
            type="button"
            disabled={!chosen || !scope || exists || save.isPending}
            onClick={() => {
              if (!chosen || !scope) return
              const { label, ...operator } = chosen
              const targets = data.operators
                .filter((t) => targetIds.includes(identity(t)))
                .map(({ label, ...target }) => target)
              const archive = data.archives.find((d) => JSON.stringify(d) === doc)
              save.mutate([
                ...data.grants,
                {
                  operator,
                  source: scope.source,
                  scope: scope.scope,
                  ...(archive ? { archive } : {}),
                  ...(projectId ? { projectId } : {}),
                  ...(targets.length ? { targets } : {}),
                },
              ])
            }}
          >
            授权此人管理这个来源
          </button>
          {!data.operators.length && <p>先在已接入的机器人会话中发消息，建立可验证的身份绑定。</p>}
        </>
      )}
    </details>
  )
}
