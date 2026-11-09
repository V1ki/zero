import { captureProvider } from './provider-witness'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TriggerStore } from '@zero-os/observe'
import type { CommissionOperator } from '@zero-os/shared'
import type { AgentDependencies } from '../../apps/server/src/triggers/event-agent'
import { createRouterAgent } from '../../apps/server/src/triggers/router-agent'
import {
  createRouterOwnerIdentity,
  RouterJobPrincipals,
  routerImScope,
} from '../../apps/server/src/triggers/router-job-principal'
import { createRouterTraceSink } from '../../apps/server/src/triggers/router-trace'
import { RouterWorkspaceService } from '../../apps/server/src/triggers/router-workspace'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'
import { createTaskBridge } from '../../apps/server/src/triggers/task-bridge'

export async function verifyPersonalContext(output: string, deps: AgentDependencies) {
  const store = new TriggerStore(join(output, 'workspace.sqlite'))
  const actors: CommissionOperator[] = (['weixin', 'feishu', 'dingtalk'] as const).map(
    (platform) => ({
      platform,
      channelId: platform + '-lab',
      peerId: platform + '-owner',
      operatorId: platform + '-owner',
    }),
  )
  const denied = async (): Promise<never> => {
    throw Error('Unexpected external operation')
  }
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: denied,
    weixin: { listTargets: () => [], send: denied },
    personal: {
      listPersonalBots: () => actors.map((a) => ({ ...a, label: a.platform, online: true })),
      listPersonalTargets: () => actors.map((a) => ({ ...a, label: a.platform })),
      listPersonalDirectTargets: () => actors,
      sendPersonal: async () => ({ status: 'accepted', receipt: 'fixture' }),
    },
  })
  const config = routing.getConfig()
  routing.saveConfig(
    {
      ...config.settings,
      personalBots: Object.fromEntries(actors.map((a) => [a.platform, a.channelId])),
    },
    config.revision,
  )
  const principals = new RouterJobPrincipals(store, {
    accessKey: (a) => store.getRouterGithubGrant(a)?.credentialRef ?? null,
  })
  const identity = createRouterOwnerIdentity(store, principals)
  const initial = store.getSettings()
  const revision = store.saveSettings(
    {
      ...initial.settings,
      github: {
        ...initial.settings.github,
        credentialRef: 'github_listener_fixture',
        routerOperators: actors.slice(0, 2),
      },
    },
    initial.revision,
  )
  for (const actor of actors) {
    assert(routing.claimRouterImTarget(actor))
    if (actor.platform === 'dingtalk') {
      assert.equal(identity.principalFor(actor), null)
      const binding = identity.sharing(actor.platform, actor.channelId)!
      identity.setSharing(actor.platform, actor.channelId, binding.revision, true)
    }
    assert.equal(identity.principalFor(actor), 'router-owner')
  }
  const stranger = { ...actors[2], operatorId: 'visitor', peerId: 'visitor' }
  assert.equal(routing.claimRouterImTarget(stranger), null)
  assert.equal(identity.principalFor(stranger), null)
  const principal = 'router-owner'
  const neighbor = store.ledger.createMatter(principal, '展册交接', '核对旧展册 R8 的纸张', [
    '等 R8 的厂样',
  ])
  const privateMarker = 'PRIVATE-ORBIT-634'
  const privateTurn = store.conversations.begin(
    routerImScope(actors[1]),
    'private-other',
    '另一个话题',
  )
  assert(privateTurn.kind === 'started')
  store.conversations.finish(routerImScope(actors[1]), 'private-other', privateTurn.attempt, {
    text: privateMarker,
    tracking: {
      id: 17,
      repository: `example/${privateMarker}`,
      issues: true,
      pullRequests: true,
      deliveryMode: 'poll',
    },
  })
  const witness = captureProvider(deps)
  const ask = createRouterAgent({
    ...deps,
    modelRouter: {
      getDefaultModel: () => witness.model,
      getCurrentModel: () => witness.model,
      trace: createRouterTraceSink(store.ledger, (s) => deps.secretFilter.filter(s)),
    },
  })
  const workspace = new RouterWorkspaceService(store, routing, ask, {
    ...identity,
    agentIntake: true,
    principals,
  })
  const bridge = createTaskBridge({
    store,
    agent: denied,
    isLiveTarget: () => false,
    isPersonalTarget: (t) => routing.isPersonalTarget(t),
    personalDialog: {
      authorize: (t) => routing.claimRouterImTarget(t),
      handle: (m, a) => workspace.handleIm(m, a),
    },
  })
  async function im(actor: CommissionOperator, text: string) {
    const result = await bridge.handle({
      ...actor,
      actorId: actor.operatorId,
      messageId: crypto.randomUUID(),
      isDirect: true,
      text,
    })
    assert(result.handled && result.reply)
    return result.reply
  }
  try {
    workspace.start()
    await workspace.message(
      'general',
      crypto.randomUUID(),
      '帮我跟进新展册 Q7 的交稿，等正文页数、封面编号和我的最终确认，先记下待办。',
    )
    const matter = store.ledger.searchMatters(principal).find((m) => m.id !== neighbor.id)
    assert(matter)
    store.saveSettings(
      { ...initial.settings, github: { credentialRef: '', repositories: [] } },
      revision,
    )
    for (const actor of actors) {
      assert.equal(identity.principalFor(actor), 'router-owner')
      assert.equal(principals.current(actor, true), null)
    }
    const outsider = await bridge.handle({
      ...stranger,
      actorId: stranger.operatorId,
      messageId: 'wrong-operator',
      isDirect: true,
      text: 'Q7的交接原话是什么？',
    })
    assert(outsider.handled && !outsider.reply)
    assert.equal(store.conversations.list(routerImScope(stranger)).length, 0)
    const weixin = await im(
      actors[0],
      'Q7 正文定为 24 页，等封面。我的交接原话是「留白那页也算」。',
    )
    const feishu = await im(actors[1], 'Q7 封面用 C-17 的浅蓝色。请接着刚才的记录，先保留待办。')
    const dingtalk = await im(
      actors[2],
      'Q7 这一本，正文几页、封面编号是什么？再找一下我在微信交代怎么数页的那句原话。先不要结束。',
    )
    assert(
      ['24', 'C-17', '留白那页也算'].every((s) => dingtalk.includes(s)),
      'Cross-platform response lost the selected matter',
    )
    assert.notEqual(store.ledger.getMatter(principal, matter.id)?.state, 'completed')
    assert.equal(store.ledger.getMatter(principal, neighbor.id)?.version, 1)
    const runs = store.ledger.listRuns().map((r) => {
      const entries = store.ledger.entries(r.id)
      const input = entries.find((e) => e.kind === 'input')?.data as {
        context: { platform: string }
        prompt: string
      }
      const provenance = JSON.parse(input.prompt).contextProvenance
      assert.equal(
        provenance.sourceSettingsRevision,
        input.context.platform === 'web' ? revision : revision + 1,
      )
      if (input.context.platform === 'web')
        assert(Number.isInteger(provenance.githubGrantGeneration))
      else
        assert(
          provenance.githubGrantGeneration === null &&
            Number.isInteger(provenance.personalBotBindingRevision),
        )
      const requests = entries.filter((e) => e.kind === 'model_request')
      assert(requests.length)
      if (input.context.platform !== 'feishu')
        assert(
          !JSON.stringify(requests).includes(privateMarker),
          'Unrelated private message crossed platforms',
        )
      return {
        id: r.id,
        sourceSettingsRevision: provenance.sourceSettingsRevision,
        githubGrantGeneration: provenance.githubGrantGeneration,
        providerWitness: witness.compare(store.ledger, r.sessionId, entries),
        platform: input.context.platform,
        requests: requests.length,
        tools: entries
          .filter((e) => e.kind === 'tool_start')
          .map((e) => (e.data as { name: string }).name),
      }
    })
    const grantBrowser = ['web', 'weixin'].map((platform) => {
      const observed = runs.find((run) => run.platform === platform)
      assert(observed)
      return {
        run: store.ledger.getRun(observed.id),
        entries: store.ledger.entries(observed.id),
        nextAfter: null,
      }
    })
    writeFileSync(join(output, 'grant-browser.json'), JSON.stringify(grantBrowser))
    assert.deepEqual(
      new Set(runs.map((r) => r.platform)),
      new Set(['web', 'weixin', 'feishu', 'dingtalk']),
    )
    assert(
      !runs.some((run) => run.tools.includes('correct_event_association')),
      'Personal replies tried to link an inbox event that does not exist',
    )
    const prior = identity.sharing(actors[2].platform, actors[2].channelId)!
    identity.setSharing(actors[2].platform, actors[2].channelId, prior.revision, false)
    assert.equal(identity.principalFor(actors[2]), null)
    await im(actors[2], '我在这里还可以继续哪些事项？')
    const detached = store.ledger.listRuns()[0]
    const detachedWitness = witness.compare(
      store.ledger,
      detached.sessionId,
      store.ledger.entries(detached.id),
    )
    const detachedRequests = store.ledger
      .entries(detached.id)
      .filter((e) => e.kind === 'model_request')
    assert(detachedRequests.length)
    assert(
      !JSON.stringify(detachedRequests).includes('C-17'),
      'Detached channel recovered the former owner context',
    )
    writeFileSync(
      join(output, 'personal-context.json'),
      JSON.stringify(
        {
          matter: matter.id,
          neighbor: neighbor.id,
          weixin,
          feishu,
          dingtalk,
          runs,
          githubGrant: false,
          strangerLinked: false,
          detachedRun: detached.id,
          detachedWitness,
        },
        null,
        2,
      ),
    )
  } finally {
    await workspace.close()
    await bridge.close()
    await routing.close()
    store.close()
  }
}
