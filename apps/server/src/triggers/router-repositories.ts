import { createHash } from 'node:crypto'
import type { CommissionOperator, RouterRepositoryPage } from '@zero-os/shared'
import { TriggerAgentError } from './event-agent'
import {
  GithubTriggerError,
  getGithubRepository,
  listGithubRepositoryPage,
  readRouterLatestFailure,
} from './github'

export type RouterRepositoryActor = 'web' | CommissionOperator
export type RouterRepositoryLookup = ReturnType<typeof createRouterRepositoryLookup>
type Fetch = (url: URL, init: RequestInit) => Promise<Response>

export function createRouterRepositoryLookup(
  getGrant: (actor: RouterRepositoryActor) => { credentialRef: string; generation: number } | null,
  resolveSecret: (ref: string) => string | undefined,
  fetcher: Fetch = fetch,
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
    async list(
      actor: RouterRepositoryActor,
      signal: AbortSignal,
      page = 1,
    ): Promise<RouterRepositoryPage> {
      if (!Number.isSafeInteger(page) || page < 1 || page > 100_000)
        throw new TriggerAgentError('请使用有效的 GitHub 仓库页码。')
      return read(actor, signal, (token, get) => listGithubRepositoryPage(token, page, signal, get))
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
