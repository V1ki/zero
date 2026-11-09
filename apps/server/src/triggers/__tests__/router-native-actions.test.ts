import { expect, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import type { RouterAgentInput } from '../router-agent'
import { RouterWorkspaceService } from '../router-workspace'
import { TriggerRoutingRuntime } from '../routing-runtime'

test('native card callbacks require the exact actor and receipt, then enter the Agent once with the same matter', async () => {
  const store = new TriggerStore(':memory:')
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: async () => {
      throw Error('legacy')
    },
    weixin: {
      listTargets: () => [],
      send: async () => {
        throw Error('external')
      },
    },
  })
  const matter = store.ledger.createMatter('router-owner', '核对证据', '记录复测', ['复测结果'])
  const id = 'a'.repeat(64)
  store.ledger.publications.prepare({
    id,
    principal: 'router-owner',
    matterId: matter.id,
    matterVersion: 1,
    scope: 'general',
    deliveries: [
      {
        channel: 'feishu',
        target: JSON.stringify({ channelId: 'feishu', audienceKey: 'bound-private' }),
        presentation: {
          title: '复测待办',
          text: '请核对复测结果',
          actions: [{ id: 'confirm', label: '确认已读' }],
        },
      },
    ],
  })
  const claim = store.ledger.publications.claim('router-owner', id, 'feishu')
  if (!claim) throw Error('missing claim')
  store.ledger.publications.finish('router-owner', id, 'feishu', claim.attempt, {
    status: 'accepted',
    receipt: 'native-card',
    reason: null,
  })
  const received: RouterAgentInput[] = []
  const service = new RouterWorkspaceService(
    store,
    {
      getConfig: () => routing.getConfig(),
      saveConfig: routing.saveConfig.bind(routing),
      listPersonalBots: () => [],
      process: () => 'accepted',
      prepareDirectReminder: () => ({
        channelId: 'feishu',
        audienceKey: 'bound-private',
        label: 'OpenClaw',
      }),
      sendDirectReminder: async () => {
        throw Error('external')
      },
    },
    async (input) => {
      received.push(input)
      return { text: '已记录已读，复测仍未完成。' }
    },
    {
      agentIntake: true,
      principalFor: (actor) =>
        actor === 'web' ||
        (actor.operatorId === 'owner' && actor.peerId === 'owner' && actor.channelId === 'feishu')
          ? 'router-owner'
          : null,
    },
  )
  service.start()
  const action = {
    platform: 'feishu' as const,
    channelId: 'feishu',
    peerId: 'owner',
    actorId: 'owner',
    cardId: 'native-card',
    messageId: 'native-event',
    deliveryId: `publication-${id}-feishu`,
    actionId: 'confirm',
  }
  try {
    expect(await service.publicationAction({ ...action, actorId: 'other' })).toBe(false)
    expect(await service.publicationAction({ ...action, cardId: 'forged' })).toBe(false)
    expect(await service.publicationAction(action)).toBe(true)
    expect(await service.publicationAction({ ...action, messageId: 'second-click' })).toBe(true)
    const deadline = Date.now() + 2000
    while (
      store.ledger.listSignals('router-owner')[0]?.state !== 'completed' &&
      Date.now() < deadline
    )
      await Bun.sleep(5)
    expect(store.ledger.listSignals('router-owner')).toHaveLength(1)
    expect(store.ledger.listSignals('router-owner')[0].state).toBe('completed')
    expect(received).toHaveLength(1)
    expect(received[0].question).toBe('确认已读')
    expect(received[0].signalContext?.payload?.matterId).toBe(matter.id)
    expect(received[0].imPlatform).toBe('feishu')
    expect(JSON.stringify(received[0].matterContext)).toContain('记录复测')
    store.ledger.updateMatter('router-owner', matter.id, 1, {
      state: 'waiting',
      context: { evidence: 'updated' },
    })
    expect(await service.publicationAction({ ...action, messageId: 'later' })).toBe(false)
    expect(received).toHaveLength(1)
  } finally {
    await service.close()
    await routing.close()
    store.close()
  }
})
