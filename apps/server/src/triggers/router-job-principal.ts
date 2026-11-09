import { createHash } from 'node:crypto'
import type { RouterImScope, RouterJob, RouterJobScope, TriggerStore } from '@zero-os/observe'
import {
  type CommissionOperator,
  getTriggerRouteBot,
  isTriggerRoutePlatform,
  sameTriggerRouteTarget,
} from '@zero-os/shared'
import { TriggerAgentError } from './event-agent'

export type RouterActor = 'web' | CommissionOperator

export function routerImScope(actor: CommissionOperator): RouterImScope {
  return `im-${fingerprint(JSON.stringify([actor.platform, actor.channelId, actor.peerId, actor.operatorId]))}`
}

export function fingerprint(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

// Persist the transport's verified principal so a restarted executor can recheck access.
function decodeActor(audience: string | null): RouterActor | null {
  if (!audience) return null
  try {
    const [actor] = JSON.parse(audience)
    if (actor === 'web') return actor
    if (
      actor &&
      isTriggerRoutePlatform(actor.platform) &&
      [actor.channelId, actor.peerId, actor.operatorId].every(
        (id) => typeof id === 'string' && id.length > 0,
      )
    )
      return actor
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error
  }
  return null
}

export function jobActor(job: Pick<RouterJob, 'audience'>) {
  return decodeActor(job.audience)
}

export class RouterJobPrincipals {
  constructor(
    private readonly store: Pick<TriggerStore, 'routing'>,
    private readonly repositories: { accessKey(actor: RouterActor): string | null },
  ) {}

  current(actor: RouterActor, github: boolean): string | null {
    let pin: number | null = null
    if (actor !== 'web') {
      const binding = this.store.routing.getPersonalBotBinding(actor.platform, actor.channelId)
      const { settings } = this.store.routing.getSettings()
      if (
        getTriggerRouteBot(settings, actor.platform) !== actor.channelId ||
        !binding ||
        !sameTriggerRouteTarget(binding.target, actor)
      )
        return null
      pin = binding.revision
    }
    const githubKey = github ? this.repositories.accessKey(actor) : null
    if (github && !githubKey) return null
    return JSON.stringify([actor, pin, githubKey])
  }

  capture(actor: RouterActor, github: boolean) {
    const audience = this.current(actor, github)
    if (!audience)
      throw new TriggerAgentError(
        github
          ? '请在「配置 → 监听与收件箱 → GitHub」设置连接，并授权当前入口读取仓库。'
          : '当前机器人私聊已解绑。',
      )
    return audience
  }

  authorized(scope: RouterJobScope, audience: string | null, repository: string | null) {
    const actor = decodeActor(audience)
    return (
      !!actor &&
      (actor === 'web' ? 'general' : routerImScope(actor)) === scope &&
      this.current(actor, !!repository) === audience
    )
  }
}

/** A verified personal identity outlives individual resource grants; changing its bot binding invalidates the proof. */
export function createRouterOwnerIdentity(store: TriggerStore, principals: RouterJobPrincipals) {
  const principalFor = (actor: RouterActor) => {
    if (actor === 'web') return 'router-owner'
    const authority = principals.current(actor, false)
    if (!authority) return null
    const scope = routerImScope(actor)
    const saved = store.ledger.identityBinding(scope)
    if (saved) return saved.authority === authority && saved.principal === 'router-owner' ? saved.principal : null
    // Import the verified operators of installations which predate independent Router identities.
    if (
      !store.getRouterGithubGrant(actor) ||
      !store
        .getSettings()
        .settings.github.routerOperators?.some((candidate) => routerImScope(candidate) === scope)
    )
      return null
    store.ledger.linkIdentity(scope, 'router-owner', authority)
    return 'router-owner'
  }
  return {
    principalFor,
    sharing(platform: CommissionOperator['platform'], channelId: string) {
      const binding = store.routing.getPersonalBotBinding(platform, channelId)
      if (!binding?.target?.operatorId) return undefined
      const actor = { ...binding.target, operatorId: binding.target.operatorId }
      if (!principals.current(actor, false)) return undefined
      return { revision: binding.revision, shared: principalFor(actor) === 'router-owner' }
    },
    setSharing(
      platform: CommissionOperator['platform'],
      channelId: string,
      expectedRevision: number,
      shared: boolean,
    ) {
      const target = store.routing.getPersonalBotBinding(platform, channelId)?.target
      const actor = target?.operatorId ? { ...target, operatorId: target.operatorId } : null
      if (!actor || !principals.current(actor, false))
        throw new TriggerAgentError('这台机器人尚没有已核实的私聊。')
      const scope = routerImScope(actor)
      store.routing.renewBotIdentity(actor, expectedRevision, () => {
        const authority = principals.current(actor, false)
        if (!authority) throw new TriggerAgentError('所选机器人已变化，请刷新。')
        store.ledger.linkIdentity(scope, shared ? 'router-owner' : scope, authority)
      })
    },
    contextScopes(actor: RouterActor) {
      const principal = principalFor(actor)
      if (!principal) return []
      return [
        { scope: 'general' as const, actor: 'web' as const },
        ...store.routing
          .getBotBindings()
          .targets.filter((t): t is CommissionOperator => !!t.operatorId)
          .filter((target) => principalFor(target) === principal)
          .map((target) => ({ scope: routerImScope(target), actor: target })),
      ]
    },
  }
}
