import { RouterTrackingError, type TriggerStore } from '@zero-os/observe'
import { TriggerAgentError } from './event-agent'
import type { RouterJobPrincipals } from './router-job-principal'
import type { RouterRepositoryLookup } from './router-repositories'
import type { RouterWorkIntegrations } from './router-work-turn'

interface Dependencies {
  store: Pick<TriggerStore, 'tracking'>
  principals: Pick<RouterJobPrincipals, 'authorized' | 'capture'>
  repositories: Pick<RouterRepositoryLookup, 'verifyTracking'>
  changed(): void
}

export function createRouterRepositoryTracking({
  store,
  principals,
  repositories,
  changed,
}: Dependencies): NonNullable<RouterWorkIntegrations['trackRepository']> {
  return async (input, signal, authorized) => {
    const {
      actor,
      scope,
      audience,
      repository,
      issues,
      pullRequests,
      issueComments,
      pullRequestComments,
    } = input
    if (!issues && !pullRequests && !issueComments && !pullRequestComments)
      throw new TriggerAgentError('请选择 Issue 或 PR 的状态变化或普通评论。')
    const checkOrigin = () => {
      signal.throwIfAborted()
      if (!authorized() || !principals.authorized(scope, audience, repository))
        throw new TriggerAgentError('机器人或 GitHub 连接授权已变更，请重新发起跟踪。')
    }
    checkOrigin()
    const grant = store.tracking.grant(actor)
    if (!grant)
      throw new TriggerAgentError(
        '请在「配置 → 监听与收件箱 → GitHub」开启「允许 Router 跟踪 GitHub 仓库」。',
      )
    // Entry authorization permits a request. A single watch belongs to the local Router.
    const ownerAudience = principals.capture('web', true)
    const name = await repositories.verifyTracking(
      actor,
      repository,
      { issues, pullRequests, issueComments, pullRequestComments },
      signal,
    )
    checkOrigin()
    try {
      if (!principals.authorized('general', ownerAudience, name))
        throw new TriggerAgentError('Router 的 GitHub 连接已变更，请重新提出跟踪。')
      const receipt = store.tracking.start({
        ...input,
        ownerAudience,
        repository: name,
        expectedGrantGeneration: grant.generation,
      })
      changed()
      return receipt
    } catch (error) {
      if (error instanceof RouterTrackingError) throw new TriggerAgentError(error.message)
      throw error
    }
  }
}
