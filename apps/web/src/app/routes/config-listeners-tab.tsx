import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { sameTriggerRouteTarget, triggerWebhookSecretPatterns } from '@zero-os/shared'
import type {
  CommissionOperator,
  TriggerGithubRepository,
  TriggerInboxItem,
  TriggerRepositoryOption,
  TriggerRouteWork,
  TriggerSettings,
  TriggerSettingsSnapshot,
  TriggerStatus,
  TriggerWxarcOption,
  TriggerWxarcSession,
} from '@zero-os/shared'
import { useEffect, useState } from 'react'
import { apiFetch, apiPost, apiPut } from '../lib/api'
import { CommissionGrants } from './config-commission-grants'
import {
  ListenerRoutingResults,
  ListenerRoutingSettings,
  ProcessInboxEvent,
  useListenerRoutingConfig,
  useListenerRoutingResults,
} from './config-listener-routing'
import { ConfigMandates } from './config-mandates'
import { GithubPermissionCheck } from './github-permission-check'
import './config-listeners-tab.css'

const base = '/api/listeners'
const pageSize = 30
const credentialPattern = /^github_listener(?:_[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?$/
const repoPattern = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i
const keys = {
  config: ['listeners', 'config'],
  status: ['listeners', 'status'],
  inbox: ['listeners', 'inbox'],
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请重试。'
}

function DateStamp({ value }: { value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString()}</time>
}

function webhookSettingsError(repo: TriggerGithubRepository) {
  if (
    repo.deliveryMode === 'webhook' &&
    !triggerWebhookSecretPatterns.github.test(repo.webhookSecretRef?.trim() ?? '')
  )
    return '请填写 Secrets 中保存的 github_webhook 或 github_webhook_ 开头的密钥名称。'
  const ciRef = repo.ciWebhookSecretRef?.trim()
  if (ciRef && !triggerWebhookSecretPatterns.ci.test(ciRef)) {
    return '请填写 Secrets 中保存的 ci_webhook 或 ci_webhook_ 开头的密钥名称。'
  }
}

function GithubSettings({
  value,
  saved,
  onChange,
}: {
  value: TriggerSettings['github']
  saved: TriggerSettings['github']
  onChange(value: TriggerSettings['github']): void
}) {
  const [name, setName] = useState('')
  const [choices, setChoices] = useState<TriggerRepositoryOption[]>([])
  const credentialRef = value.credentialRef.trim()
  const validRef = !credentialRef || credentialPattern.test(credentialRef)
  const repositories = value.repositories
  const grants = value.routerOperators ?? []
  const setRead = (identity: CommissionOperator, selected: boolean) => {
    const others = grants.filter((t) => t.platform !== identity.platform)
    onChange({ ...value, routerOperators: selected ? [...others, identity] : others })
  }
  const replacingConnection = Boolean(saved.credentialRef && saved.credentialRef !== credentialRef)
  const changedAuthorizedConnection =
    saved.credentialRef !== credentialRef && Boolean(saved.routerOperators?.length)
  const options = useQuery({
    queryKey: ['listeners', 'github', 'router-operators'],
    enabled: Boolean(credentialRef && validRef),
    queryFn: ({ signal }) =>
      apiFetch<{ operators: (CommissionOperator & { label: string })[] }>(
        `${base}/github/router-operators`,
        { signal },
      ),
    retry: false,
  })
  const update = (repos: TriggerGithubRepository[]) => onChange({ ...value, repositories: repos })
  const patch = (name: string, fields: Partial<TriggerGithubRepository>) =>
    update(
      repositories.map((repo) => {
        if (repo.name !== name) return repo
        const next = { ...repo, ...fields }
        if (
          !next.enabled ||
          !next.githubAppRef ||
          repo.githubAppRef !== next.githubAppRef ||
          !next.issueComments
        ) {
          if (next.allowOwnerIssueClose) next.allowOwnerIssueClose = false
          next.allowOwnerIssueCloseSince = undefined
        }
        if (
          !next.enabled ||
          !next.issues ||
          !next.githubAppRef ||
          repo.githubAppRef !== next.githubAppRef
        ) {
          if (next.closeResolvedDuplicates) next.closeResolvedDuplicates = false
          next.closeResolvedDuplicatesSince = undefined
        }
        if (
          !next.enabled ||
          !next.githubAppRef ||
          !(next.issueComments || next.pullRequestComments)
        ) {
          if (next.ownerMentionReplies) next.ownerMentionReplies = false
          next.ownerMentionRepliesSince = undefined
        }
        return next
      }),
    )
  const exists = (candidate: string) =>
    repositories.some((repo) => repo.name.toLowerCase() === candidate.toLowerCase())
  const add = (candidate: string) => {
    if (!exists(candidate)) {
      update([
        ...repositories,
        {
          name: candidate,
          branch: '',
          workflow: '',
          workflowFailures: true,
          mention: '',
          enabled: true,
        },
      ])
    }
    setName('')
  }
  const discover = useMutation({
    mutationFn: async (candidate?: string) => {
      const query = new URLSearchParams()
      if (credentialRef) query.set('credentialRef', credentialRef)
      if (candidate) query.set('name', candidate)
      const result = await apiFetch<{ repositories: TriggerRepositoryOption[] }>(
        `${base}/github/repositories?${query}`,
      )
      if (candidate && !result.repositories.length) throw new Error('未找到可读取的仓库。')
      return result.repositories
    },
    onSuccess: (options, candidate) => {
      if (candidate) add(options[0].name)
      else setChoices(options)
    },
  })
  return (
    <section className="card listener-stack" aria-label="GitHub 监听配置">
      <h2>GitHub 仓库</h2>
      <p className="listener-muted">
        公共仓库可以直接添加。私有仓库请先在 Secrets 中保存专用只读凭证。
      </p>
      <fieldset className="listener-stack" disabled={discover.isPending}>
        <label className="listener-field">
          凭证名称（可选）
          <input
            value={value.credentialRef}
            placeholder="github_listener"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              onChange({
                ...value,
                credentialRef: e.target.value,
                routerOperators: [],
                ...(value.routerTrackingEnabled !== undefined && { routerTrackingEnabled: false }),
              })
              setChoices([])
              discover.reset()
            }}
          />
        </label>
        {!validRef && (
          <p className="listener-error">
            请填写已保存的 github_listener 或 github_listener_ 后缀名称，无需输入令牌值。
          </p>
        )}
        <fieldset className="listener-item listener-stack">
          <legend>Router 读取 GitHub</legend>
          <small>
            在配置页的 Secrets 中保存只读凭证（如 github_listener），将名称填在上方并保存。网页
            Router 即可查询，无需添加监听仓库。
          </small>
          <small>勾选机器人，允许它在已验证的本人私聊中列出和分析此凭证可访问的仓库。</small>
          {changedAuthorizedConnection ? (
            <small>保存新连接后，请为新连接重新勾选机器人。</small>
          ) : (
            credentialRef &&
            validRef && (
              <>
                <div className="listener-row">
                  <button
                    type="button"
                    disabled={options.isFetching}
                    onClick={() => void options.refetch()}
                  >
                    刷新可授权机器人
                  </button>
                  {options.isFetching && <small>正在读取机器人…</small>}
                </div>
                {options.error && (
                  <p className="listener-error" role="alert">
                    {errorMessage(options.error)}
                  </p>
                )}
                {options.isSuccess && !options.data.operators.length && (
                  <small>
                    尚无可授权的机器人。请先在通知路由设置中选择机器人，再给它发一条私聊。
                  </small>
                )}
                {options.data?.operators.map(({ label, ...identity }) => {
                  const { platform, channelId } = identity
                  const checked = grants.some((t) => sameTriggerRouteTarget(t, identity))
                  const platformLabel = { weixin: '微信', dingtalk: '钉钉', feishu: '飞书' }[
                    platform
                  ]
                  return (
                    <label key={`${platform}:${channelId}`} className="listener-row">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => setRead(identity, e.target.checked)}
                      />
                      {platformLabel} · {label}
                    </label>
                  )
                })}
                {!options.isPending &&
                  grants
                    .filter(
                      (t) => !options.data?.operators.some((o) => sameTriggerRouteTarget(t, o)),
                    )
                    .map((old) => (
                      <label className="listener-row" key={old.platform}>
                        <input type="checkbox" checked onChange={() => setRead(old, false)} />
                        {old.channelId} · 旧授权当前不可用，取消勾选可移除
                      </label>
                    ))}
              </>
            )
          )}
        </fieldset>
        <fieldset className="listener-item listener-stack">
          <legend>Router 仓库跟踪</legend>
          <label className="listener-row">
            <input
              type="checkbox"
              checked={value.routerTrackingEnabled === true}
              disabled={!credentialRef || !validRef || replacingConnection}
              onChange={(e) => onChange({ ...value, routerTrackingEnabled: e.target.checked })}
            />
            允许 Router 跟踪 GitHub 仓库
          </label>
          <small>
            网页和已获准读取 GitHub 的 IM 入口共用此设置。向 Router
            提出跟踪请求后，仓库会出现在下方，新发生的 Issue 和 PR 变化会交给后台 Worker 处理。
          </small>
          {replacingConnection && <small>保存新连接后，可为它开启仓库跟踪。</small>}
        </fieldset>
        <div className="listener-row">
          <label className="listener-field">
            仓库名称
            <input
              value={name}
              placeholder="owner/repo"
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={!validRef || !repoPattern.test(name.trim()) || exists(name.trim())}
            onClick={() => discover.mutate(name.trim())}
          >
            验证并添加
          </button>
        </div>
        <div className="listener-row">
          <button
            type="button"
            disabled={!credentialRef || !validRef}
            onClick={() => discover.mutate(undefined)}
          >
            列出可见仓库
          </button>
          {discover.isPending && <output>正在读取 GitHub…</output>}
        </div>
        {discover.isSuccess && !discover.variables && choices.length === 0 && (
          <small>此凭证未返回可选仓库，可输入完整仓库名称验证。</small>
        )}
        {discover.error && (
          <p className="listener-error" role="alert">
            {errorMessage(discover.error)}
          </p>
        )}
        {choices.length > 0 && (
          <label className="listener-field">
            从可见仓库中添加
            <select
              value=""
              onChange={(e) => {
                if (e.target.value) add(e.target.value)
              }}
            >
              <option value="">选择仓库…</option>
              {choices.map((repo) => (
                <option disabled={exists(repo.name)} key={repo.name} value={repo.name}>
                  {repo.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {repositories.map((repo) => (
          <div className="listener-item" key={repo.name}>
            <div className="listener-actions">
              <strong>{repo.name}</strong>
              <button
                type="button"
                aria-label={`移除 ${repo.name}`}
                onClick={() => update(repositories.filter((r) => r.name !== repo.name))}
              >
                移除
              </button>
            </div>
            <label className="listener-row">
              <input
                type="checkbox"
                checked={repo.enabled}
                onChange={(e) => patch(repo.name, { enabled: e.target.checked })}
              />
              启用监听
            </label>
            <label className="listener-field">
              GitHub 事件接收方式
              <select
                value={repo.deliveryMode ?? 'poll'}
                onChange={(e) =>
                  patch(repo.name, {
                    deliveryMode: e.target.value === 'webhook' ? 'webhook' : 'poll',
                    webhookSecretRef:
                      e.target.value === 'webhook' ? repo.webhookSecretRef : undefined,
                  })
                }
              >
                <option value="poll">定期从 GitHub 读取</option>
                <option value="webhook">由 GitHub 实时推送</option>
              </select>
            </label>
            {repo.deliveryMode === 'webhook' && (
              <>
                <label className="listener-field">
                  GitHub 推送签名密钥名称
                  <input
                    value={repo.webhookSecretRef ?? ''}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="github_webhook"
                    onChange={(e) => patch(repo.name, { webhookSecretRef: e.target.value })}
                  />
                </label>
                <small>
                  在仓库 Webhooks 中设置可从 GitHub 访问的 HTTPS 地址，路径为{' '}
                  <code>/webhook/github/{repo.name}</code>。选择 JSON 格式，按下方规则订阅
                  Issues、Pull requests、Workflow runs 或 Issue comments 事件，并使用与 Secrets
                  中相同的签名密钥。
                </small>
              </>
            )}
            <label className="listener-row">
              <input
                type="checkbox"
                checked={repo.workflowFailures}
                onChange={(e) =>
                  patch(repo.name, {
                    workflowFailures: e.target.checked,
                    ciWebhookSecretRef: e.target.checked ? repo.ciWebhookSecretRef : undefined,
                  })
                }
              />
              Actions 工作流失败
            </label>
            <label className="listener-row">
              <input
                type="checkbox"
                checked={!!repo.issues}
                onChange={(e) => patch(repo.name, { issues: e.target.checked })}
              />
              Issue 状态变化
            </label>
            <label className="listener-row">
              <input
                type="checkbox"
                checked={!!repo.pullRequests}
                onChange={(e) => patch(repo.name, { pullRequests: e.target.checked })}
              />
              PR 状态变化
            </label>
            {(repo.issues || repo.pullRequests) && (
              <small>
                所有分支上新建、关闭、重新打开和 PR 合并都会进入收件箱。私有仓库需为 GitHub
                凭证开通相应的 Issues 或 Pull requests 只读权限。
              </small>
            )}
            <label className="listener-row">
              <input
                type="checkbox"
                checked={!!repo.closeResolvedDuplicates}
                disabled={!repo.enabled || !repo.issues || !repo.githubAppRef}
                onChange={(e) => patch(repo.name, { closeResolvedDuplicates: e.target.checked })}
              />
              自动关闭已确认重复且已有解决记录的 Issue
            </label>
            <small>
              需绑定 GitHub App 并启用 Issue 状态变化监听。保存后，对新收到的事件核实重复关系及原
              Issue 的解决状态；只关闭当前重复项，主题相似或仅提到旧帖不会触发关闭。
            </small>
            <label className="listener-row">
              <input
                type="checkbox"
                checked={!!repo.issueComments}
                onChange={(e) => patch(repo.name, { issueComments: e.target.checked })}
              />
              Issue 普通评论
            </label>
            <label className="listener-row">
              <input
                type="checkbox"
                checked={!!repo.pullRequestComments}
                onChange={(e) => patch(repo.name, { pullRequestComments: e.target.checked })}
              />
              PR 普通评论
            </label>
            <small>
              新旧 Issue 和 PR 的主讨论区都接收新评论，无需
              @。默认从现在开始；自动检查可在下方选择回看 1 或 24 小时。编辑、删除、PR
              审阅和行内评论不入箱。含危险操作请求的评论会被过滤。
            </small>
            <label className="listener-row">
              <input
                type="checkbox"
                checked={!!repo.allowOwnerIssueClose}
                disabled={!repo.enabled || !repo.githubAppRef || !repo.issueComments}
                onChange={(e) => patch(repo.name, { allowOwnerIssueClose: e.target.checked })}
              />
              允许仓库所有者 @ 机器人关闭当前 Issue
            </label>
            <small>
              需绑定 GitHub App 并监听 Issue 普通评论。仅在保存后的新评论中，仓库所有者直接 @
              机器人并明确要求关闭当前 Issue 时执行。
            </small>
            <label className="listener-row">
              <input
                type="checkbox"
                checked={!!repo.ownerMentionReplies}
                disabled={
                  !repo.enabled ||
                  !repo.githubAppRef ||
                  !(repo.issueComments || repo.pullRequestComments)
                }
                onChange={(e) => patch(repo.name, { ownerMentionReplies: e.target.checked })}
              />
              仓库所有者 @ 机器人时，在原讨论回复办理结果
            </label>
            <small>
              只对保存后新发表的评论生效。Worker 办完后，用绑定的 GitHub App
              在原讨论发布结果和证据链接。
            </small>
            {repo.workflowFailures && (
              <>
                <label className="listener-field">
                  外部 CI 推送签名密钥名称（可选）
                  <input
                    value={repo.ciWebhookSecretRef ?? ''}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="留空关闭；例如 ci_webhook_build"
                    onChange={(e) => patch(repo.name, { ciWebhookSecretRef: e.target.value })}
                  />
                </label>
                {repo.ciWebhookSecretRef && (
                  <small>
                    外部 CI 可以将此仓库的工作流失败事件签名后 POST 到{' '}
                    <code>/webhook/ci/{repo.name}</code>。下方分支与工作流条件同样适用。
                  </small>
                )}
              </>
            )}
            {webhookSettingsError(repo) && (
              <p className="listener-error" role="alert">
                {webhookSettingsError(repo)}
              </p>
            )}
            <div className="listener-fields">
              <label className="listener-field">
                分支（PR 按目标分支）
                <input
                  placeholder="全部分支"
                  value={repo.branch}
                  onChange={(e) => patch(repo.name, { branch: e.target.value })}
                />
              </label>
              {repo.workflowFailures && (
                <label className="listener-field">
                  工作流
                  <input
                    placeholder="全部工作流"
                    value={repo.workflow}
                    onChange={(e) => patch(repo.name, { workflow: e.target.value })}
                  />
                </label>
              )}
            </div>
            <label className="listener-field">
              PR 普通评论中提及的账号
              <input
                placeholder="留空关闭单独的 @ 提及规则"
                spellCheck={false}
                value={repo.mention}
                onChange={(e) => patch(repo.name, { mention: e.target.value })}
              />
            </label>
            <GithubPermissionCheck
              key={JSON.stringify([credentialRef, repo])}
              repo={repo}
              credentialRef={credentialRef}
              validRef={validRef}
            />
          </div>
        ))}
      </fieldset>
    </section>
  )
}

function WxarcSettings({
  sessions,
  onChange,
}: {
  sessions: TriggerWxarcSession[]
  onChange(sessions: TriggerWxarcSession[]): void
}) {
  const [search, setSearch] = useState('')
  const browse = useMutation({
    mutationFn: () => apiFetch<{ sessions: TriggerWxarcOption[] }>(`${base}/wxarc/sessions`),
  })
  const candidates = browse.data?.sessions.filter((s) =>
    (s.name || s.id).toLowerCase().includes(search.toLowerCase()),
  )
  const patch = (id: string, fields: Partial<TriggerWxarcSession>) =>
    onChange(sessions.map((s) => (s.id === id ? { ...s, ...fields } : s)))
  return (
    <section className="card listener-stack" aria-label="WXARC 监听配置">
      <h2>WXARC 微信会话</h2>
      <p className="listener-muted">
        连接本机 WXARC，首次启用时从当前新消息开始。只有选中会话里符合条件的文字会进入收件箱。
      </p>
      <div className="listener-row">
        <button type="button" disabled={browse.isPending} onClick={() => browse.mutate()}>
          {browse.isPending ? '正在读取会话…' : '选择微信会话'}
        </button>
      </div>
      {browse.error && (
        <p className="listener-error" role="alert">
          {errorMessage(browse.error)}
        </p>
      )}
      {candidates && (
        <div className="listener-stack">
          <label className="listener-field">
            搜索可选会话
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <div className="listener-picker">
            {candidates.slice(0, 100).map((option) => {
              const selected = sessions.some((s) => s.id === option.id)
              return (
                <label className="listener-row" key={option.id}>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={(e) =>
                      onChange(
                        e.target.checked
                          ? [...sessions, { ...option, keyword: '', enabled: true }]
                          : sessions.filter((s) => s.id !== option.id),
                      )
                    }
                  />
                  {option.name || option.id}
                </label>
              )
            })}
            {!candidates.length && <small>未找到会话，请调整搜索条件或检查 WXARC。</small>}
            {candidates.length > 100 && <small>显示前 100 项，输入名称可缩小范围。</small>}
          </div>
        </div>
      )}
      {sessions.map((session) => (
        <div className="listener-item" key={session.id}>
          <div className="listener-actions">
            <strong>{session.name || session.id}</strong>
            <button
              type="button"
              aria-label={`移除 ${session.name || session.id}`}
              onClick={() => onChange(sessions.filter((s) => s.id !== session.id))}
            >
              移除
            </button>
          </div>
          <label className="listener-row">
            <input
              type="checkbox"
              checked={session.enabled}
              onChange={(e) => patch(session.id, { enabled: e.target.checked })}
            />
            启用监听
          </label>
          <label className="listener-field">
            匹配关键词
            <input
              value={session.keyword}
              placeholder="留空则接收该会话的所有新文字"
              onChange={(e) => patch(session.id, { keyword: e.target.value })}
            />
          </label>
        </div>
      ))}
    </section>
  )
}

function ListenerInbox({
  routingEnabled,
  records,
}: { routingEnabled: boolean; records: TriggerRouteWork[] }) {
  const inbox = useInfiniteQuery({
    queryKey: keys.inbox,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      apiFetch<{ items: TriggerInboxItem[] }>(
        `${base}/inbox?limit=${pageSize}${pageParam ? `&beforeId=${pageParam}` : ''}`,
        { signal },
      ),
    getNextPageParam: (last) =>
      last.items.length === pageSize ? last.items.at(-1)?.id : undefined,
    retry: false,
    refetchInterval: (query) => (query.state.status === 'error' ? false : 15000),
  })
  const items = inbox.data?.pages.flatMap((p) => p.items) ?? []
  const processed = new Set(records.map(({ route }) => route.inboxId))
  return (
    <section
      id="listener-inbox"
      className="card listener-inbox listener-stack"
      aria-label="原始事件收件箱"
    >
      <div className="listener-actions">
        <h2>原始事件收件箱</h2>
        <button type="button" disabled={inbox.isFetching} onClick={() => void inbox.refetch()}>
          刷新收件箱
        </button>
      </div>
      {inbox.error && (
        <p className="listener-error" role="alert">
          {errorMessage(inbox.error)}
        </p>
      )}
      {inbox.isLoading && <output>正在读取事件…</output>}
      {inbox.isSuccess && !items.length && (
        <p className="listener-muted">尚无匹配事件。保存监听范围后，新的匹配事件会在这里出现。</p>
      )}
      {items.map((item) => (
        <details key={item.id}>
          <summary>
            <span className="listener-tag">{item.source === 'github' ? 'GitHub' : 'WXARC'}</span>
            {item.title}
          </summary>
          <p className="listener-body">{item.summary}</p>
          <Link to="/router" search={{ event: item.id }}>
            打开事件对话
          </Link>
          <small>
            {item.scope} · #{item.id} · 事件 <DateStamp value={item.occurredAt} /> · 入箱{' '}
            <DateStamp value={item.receivedAt} />
          </small>
          {item.source === 'github' && item.url?.startsWith('https://github.com/') && (
            <p>
              <a href={item.url} target="_blank" rel="noreferrer">
                在 GitHub 查看
              </a>
            </p>
          )}
          {processed.has(item.id) ? (
            <p className="listener-process">
              <a href={`#routing-record-${item.id}`}>查看已有路由记录</a>
            </p>
          ) : (
            routingEnabled && <ProcessInboxEvent inboxId={item.id} />
          )}
        </details>
      ))}
      {inbox.hasNextPage && (
        <div>
          <button
            type="button"
            disabled={inbox.isFetching}
            onClick={() => void inbox.fetchNextPage()}
          >
            加载更早事件
          </button>
        </div>
      )}
    </section>
  )
}

export function ConfigListenersTab() {
  const cache = useQueryClient()
  const routingConfig = useListenerRoutingConfig()
  const routeRecords = useListenerRoutingResults('records')
  const webNotifications = useListenerRoutingResults('web')
  const routingEnabled = routingConfig.data?.settings.enabled === true
  useEffect(() => {
    const anchor = window.location.hash.slice(1)
    if (
      ['mandates', 'routing-settings', 'listener-inbox', 'routing-web', 'routing-records'].includes(
        anchor,
      )
    ) {
      const frame = requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView())
      return () => cancelAnimationFrame(frame)
    }
  }, [])
  const config = useQuery({
    queryKey: keys.config,
    queryFn: ({ signal }) => apiFetch<TriggerSettingsSnapshot>(`${base}/config`, { signal }),
    refetchInterval: (query) => (query.state.status === 'error' ? false : 15_000),
    retry: false,
  })
  const status = useQuery({
    queryKey: keys.status,
    queryFn: ({ signal }) => apiFetch<{ statuses: TriggerStatus[] }>(`${base}/status`, { signal }),
    retry: false,
    refetchInterval: (query) => (query.state.status === 'error' ? false : 15000),
  })
  const [draft, setDraft] = useState<TriggerSettingsSnapshot | null>(null)
  const [lookback, setLookback] = useState(0)
  const current = draft || config.data
  const save = useMutation({
    mutationFn: (snapshot: TriggerSettingsSnapshot) =>
      apiPut<TriggerSettingsSnapshot>(`${base}/config`, {
        ...snapshot,
        ...(lookback ? { githubLookbackHours: lookback } : {}),
      }),
    onSuccess: async (saved) => {
      cache.setQueryData(keys.config, saved)
      setDraft(null)
      setLookback(0)
      await cache.invalidateQueries({ queryKey: keys.status })
    },
  })
  const scan = useMutation({
    mutationFn: () => apiPost(`${base}/scan`, {}),
    onSuccess: () =>
      Promise.all([
        cache.invalidateQueries({ queryKey: keys.status }),
        cache.invalidateQueries({ queryKey: keys.inbox }),
      ]),
  })
  const dirty = Boolean(
    draft && JSON.stringify(draft.settings) !== JSON.stringify(config.data?.settings),
  )
  const update = (settings: TriggerSettings) => {
    if (!current) return
    save.reset()
    setDraft({ revision: current.revision, settings })
  }
  return (
    <div className="listeners-panel">
      <nav className="listener-section-links" aria-label="监听页面导航">
        <Link to="/router">Router 工作台</Link>
        <a href="#mandates">长期委托与项目</a>
        <a href="#routing-settings">通知路由设置</a>
        <a href="#listener-inbox">原始事件</a>
        <a href="#routing-web">网页通知</a>
        <a href="#routing-records">路由记录</a>
      </nav>
      {current ? (
        <>
          <fieldset className="listener-sources" disabled={save.isPending}>
            <GithubSettings
              value={current.settings.github}
              saved={config.data?.settings.github ?? current.settings.github}
              onChange={(github) => update({ ...current.settings, github })}
            />
            <WxarcSettings
              sessions={current.settings.wxarc.sessions}
              onChange={(sessions) => update({ ...current.settings, wxarc: { sessions } })}
            />
          </fieldset>
          <section className="card listener-stack" aria-label="保存与检查">
            <div className="listener-fields">
              <label className="listener-field">
                新增或变更 GitHub 监听的读取起点
                <select
                  value={lookback}
                  disabled={save.isPending}
                  onChange={(e) => setLookback(Number(e.target.value))}
                >
                  <option value={0}>从当前开始</option>
                  <option value={1}>最近 1 小时</option>
                  <option value={24}>最近 24 小时</option>
                </select>
              </label>
            </div>
            <div className="listener-actions">
              <div className="listener-row">
                <button
                  type="button"
                  className="listener-primary"
                  disabled={
                    !dirty ||
                    save.isPending ||
                    current.settings.github.repositories.some(webhookSettingsError) ||
                    (!!current.settings.github.credentialRef &&
                      !credentialPattern.test(current.settings.github.credentialRef.trim()))
                  }
                  onClick={() => save.mutate(current)}
                >
                  {save.isPending ? '正在保存…' : '保存监听设置'}
                </button>
                {dirty && <small>有未保存的修改</small>}
                {!dirty && save.isSuccess && (
                  <output className="listener-info">已保存监听设置</output>
                )}
              </div>
              <button
                type="button"
                disabled={scan.isPending || dirty || save.isPending}
                onClick={() => scan.mutate()}
              >
                {scan.isPending ? '正在检查…' : '立即检查'}
              </button>
            </div>
            {save.error && (
              <div className="listener-row" role="alert">
                <span className="listener-error">{errorMessage(save.error)}</span>
                <button
                  type="button"
                  onClick={async () => {
                    const result = await config.refetch()
                    if (result.isSuccess) {
                      setDraft(null)
                      setLookback(0)
                      save.reset()
                    }
                  }}
                >
                  放弃修改并重新载入
                </button>
              </div>
            )}
            {scan.error && (
              <p className="listener-error" role="alert">
                {errorMessage(scan.error)}
              </p>
            )}
            {scan.isSuccess && <output>已请求检查，请查看来源状态和收件箱。</output>}
          </section>
        </>
      ) : (
        <section className="card" aria-live="polite">
          {config.error ? (
            <>
              <p className="listener-error">{errorMessage(config.error)}</p>
              <button type="button" onClick={() => void config.refetch()}>
                重试加载设置
              </button>
            </>
          ) : (
            '正在读取监听设置…'
          )}
        </section>
      )}
      <section className="card listener-stack" aria-label="来源状态">
        <div className="listener-actions">
          <h3>来源状态</h3>
          <button type="button" disabled={status.isFetching} onClick={() => void status.refetch()}>
            刷新状态
          </button>
        </div>
        {status.error && (
          <p className="listener-error" role="alert">
            {errorMessage(status.error)}
          </p>
        )}
        {status.isLoading && <small>正在读取状态…</small>}
        {status.data?.statuses.length === 0 && <small>暂无来源检查记录</small>}
        <ul className="listener-status">
          {status.data?.statuses.map((s) => {
            const range =
              s.source === 'github'
                ? config.data?.settings.github.repositories.find((repo) => repo.name === s.scope)
                : config.data?.settings.wxarc.sessions.find((session) => session.id === s.scope)
            const githubPush =
              s.source === 'github' &&
              range &&
              'deliveryMode' in range &&
              range.deliveryMode === 'webhook'
            const labels = {
              watching: '监听中',
              error: '检查失败',
              idle: githubPush ? '等待回调' : '等待检查',
            }
            return (
              <li key={`${s.source}:${s.scope}`}>
                <b>{s.source === 'github' ? 'GitHub' : 'WXARC'}</b> · {range?.name || s.scope} ·{' '}
                {range?.enabled === false ? '已暂停' : labels[s.state]}
                {s.lastCheckedAt && (
                  <>
                    {' '}
                    · <DateStamp value={s.lastCheckedAt} />
                  </>
                )}
                {s.error && <p className="listener-error">{s.error}</p>}
                {s.lastIgnoredComment && (
                  <p>
                    最近跳过的
                    <a href={s.lastIgnoredComment.url} target="_blank" rel="noreferrer">
                      评论
                    </a>
                    {' · '}
                    {s.lastIgnoredComment.reason}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      </section>
      {config.data && (
        <ConfigMandates
          sources={config.data.settings}
          routingEnabled={routingConfig.data?.settings.enabled}
        />
      )}
      <CommissionGrants />
      <ListenerRoutingSettings config={routingConfig} />
      <ListenerInbox routingEnabled={routingEnabled} records={routeRecords.data?.records ?? []} />
      <ListenerRoutingResults kind="web" query={webNotifications} routingEnabled={routingEnabled} />
      <ListenerRoutingResults kind="records" query={routeRecords} routingEnabled={routingEnabled} />
    </div>
  )
}
