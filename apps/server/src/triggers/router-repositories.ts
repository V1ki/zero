import { createHash } from 'node:crypto'
import type {
  CommissionOperator,
  RouterRepositoryPage,
  TriggerGithubPermissionReport,
} from '@zero-os/shared'
import { TriggerAgentError } from './event-agent'
import {
  GithubTriggerError,
  checkGithubReadPermissions,
  getGithubRepository,
  listGithubOpenPullRequests,
  listGithubRepositoryPage,
  readRouterLatestFailure,
} from './github'
import type { GithubAppAuth } from './github-app-auth'
import {
  type GithubRepositoryRead,
  GithubRepositoryReadError,
  readGithubRepositoryResource,
} from './github-repository-reader'
import type { RouterTrackingSelection } from './router-tracking-intent'

export type RouterRepositoryActor = 'web' | CommissionOperator
export type RouterRepositoryLookup = ReturnType<typeof createRouterRepositoryLookup>
type Fetch = (url: URL, init: RequestInit) => Promise<Response>

function ensureTrackingPermissions(report: TriggerGithubPermissionReport) {
  const blocked = report.checks.find((check) => check.status !== 'readable')
  if (blocked) {
    if (blocked.status === 'rate_limited')
      throw new TriggerAgentError('GitHub 暂时限制读取，请稍后再启动跟踪。')
    const comments =
      blocked.resource === 'issueComments' || blocked.resource === 'pullRequestComments'
    const resource = comments
      ? '普通评论'
      : blocked.resource === 'issues'
        ? 'Issues'
        : 'Pull requests'
    if (blocked.status === 'unavailable')
      throw new TriggerAgentError(`暂时无法核对 ${resource}，请稍后重试。`)
    const permission = comments ? 'Issues 或 Pull requests' : resource
    throw new TriggerAgentError(
      `当前 GitHub 连接缺少读取权限（${resource}）。请在 GitHub 为这个仓库授予 ${permission} 只读权限后重试。`,
    )
  }
}

export function createRouterRepositoryLookup(
  getGrant: (actor: RouterRepositoryActor) => { credentialRef: string; generation: number } | null,
  resolveSecret: (ref: string) => string | undefined,
  fetcher: Fetch = fetch,
  appBinding?: { auth: GithubAppAuth; ref(repository: string): string | undefined },
  filter: (text: string) => string = (text) => text,
) {
  function connection(actor: RouterRepositoryActor) {
    const grant = getGrant(actor)
    if (
      !grant ||
      !/^github_listener(?:_[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?$/.test(grant.credentialRef)
    )
      return null
    const token = resolveSecret(grant.credentialRef)
    if (!token) return null
    // Pin the principal, saved grant revision and concrete connection across async work.
    // Only the digest leaves this service, never the credential or its reference.
    const identity =
      actor === 'web' ? actor : [actor.platform, actor.channelId, actor.peerId, actor.operatorId]
    const key = createHash('sha256')
      .update(JSON.stringify([identity, grant.generation, grant.credentialRef, token]))
      .digest('hex')
    return { key, token }
  }

  async function read<T>(
    actor: RouterRepositoryActor,
    signal: AbortSignal,
    perform: (token: string, guardedFetch: Fetch) => Promise<T>,
  ): Promise<T> {
    const grant = connection(actor)
    if (!grant)
      throw new TriggerAgentError(
        '当前入口没有可用的 GitHub 连接授权。请在网页「监听与收件箱」配置 GitHub 凭证，并授权需要查询的机器人私聊。',
      )
    const check = () => {
      signal.throwIfAborted()
      if (connection(actor)?.key !== grant.key)
        throw new TriggerAgentError('GitHub 连接或查询授权已变化，请重新查询。')
    }
    try {
      const value = await perform(grant.token, (url, init) => {
        check()
        return fetcher(url, init)
      })
      check()
      return value
    } catch (error) {
      if (signal.aborted || error instanceof TriggerAgentError) throw error
      if (error instanceof GithubRepositoryReadError) throw new TriggerAgentError(error.message)
      if (error instanceof GithubTriggerError) {
        if (error.retryAfterMs) throw new TriggerAgentError('GitHub 暂时限制查询频率，请稍后重试。')
        throw new TriggerAgentError(
          `GitHub 无法提供此记录（HTTP ${error.status}），请核对连接权限。`,
        )
      }
      throw new TriggerAgentError('未能读取 GitHub 数据，请稍后重试或检查连接。', { cause: error })
    }
  }

  return {
    accessKey: (actor: RouterRepositoryActor): string | null => connection(actor)?.key ?? null,
    async readRepository(
      actor: RouterRepositoryActor,
      repository: string,
      input: GithubRepositoryRead,
      signal: AbortSignal,
    ) {
      return read(actor, signal, async (token, get) => {
        const result = await readGithubRepositoryResource(repository, token, input, signal, get)
        return { ...result, content: filter(result.content) }
      })
    },
    async list(
      actor: RouterRepositoryActor,
      signal: AbortSignal,
      page = 1,
    ): Promise<RouterRepositoryPage> {
      if (!Number.isSafeInteger(page) || page < 1 || page > 100_000)
        throw new TriggerAgentError('请使用有效的 GitHub 仓库页码。')
      return read(actor, signal, (token, get) => listGithubRepositoryPage(token, page, signal, get))
    },
    async listOpenPullRequests(
      actor: RouterRepositoryActor,
      repository: string,
      signal: AbortSignal,
      page = 1,
      pageSize: 5 | 10 = actor !== 'web' && actor.platform === 'weixin' ? 5 : 10,
    ) {
      if (!Number.isSafeInteger(page) || page < 1 || page > 100_000)
        throw new TriggerAgentError('请使用有效的 GitHub PR 页码。')
      if (pageSize !== 5 && pageSize !== 10)
        throw new TriggerAgentError('这份 PR 记录的分页大小无效，请重新查询第一页。')
      return read(actor, signal, async (token, get) => {
        const result = await listGithubOpenPullRequests(
          repository,
          token,
          signal,
          get,
          page,
          pageSize,
        )
        return {
          ...result,
          pullRequests: result.pullRequests.map((pull) => ({
            ...pull,
            title: filter(pull.title).slice(0, 180),
          })),
        }
      })
    },
    /** Resolve the canonical repo and test the exact read endpoints before enabling a watcher. */
    async verifyTracking(
      actor: RouterRepositoryActor,
      repository: string,
      kinds: Omit<RouterTrackingSelection, 'repository'>,
      signal: AbortSignal,
    ): Promise<string> {
      return read(actor, signal, async (token, get) => {
        const actual = await getGithubRepository(repository, token, signal, get)
        if (actual.name.toLowerCase() !== repository.toLowerCase())
          throw new TriggerAgentError('仓库名称已变更，请使用新的全名重新提出跟踪。')
        const appRef = appBinding?.ref(actual.name)
        const selection = { workflowFailures: false, prComments: false, prBase: false, ...kinds }
        const report = await checkGithubReadPermissions(actual.name, token, selection, signal, get)
        ensureTrackingPermissions(report)
        if (appBinding && appRef !== undefined) {
          // Prove the operator can read each resource before asking the App for its own access.
          const appToken = await appBinding.auth.getToken(appRef, actual.name, signal)
          ensureTrackingPermissions(
            await checkGithubReadPermissions(actual.name, appToken, selection, signal, get),
          )
        }
        if (appBinding?.ref(actual.name) !== appRef)
          throw new TriggerAgentError('仓库绑定的 GitHub App 已变更，请重新发起跟踪。')
        return actual.name
      })
    },
    /** The caller supplies the repository pinned to the job, never a worker-selected credential. */
    async latestFailure(
      actor: RouterRepositoryActor,
      repository: string,
      signal: AbortSignal,
      workflowFile?: string,
    ) {
      return read(actor, signal, async (token, get) => {
        const actual = await getGithubRepository(repository, token, signal, get)
        if (actual.name.toLowerCase() !== repository.toLowerCase())
          throw new TriggerAgentError('GitHub 仓库名称已变化，请重新选择仓库。')
        return readRouterLatestFailure(actual.name, token, signal, get, workflowFile)
      })
    },
  }
}
