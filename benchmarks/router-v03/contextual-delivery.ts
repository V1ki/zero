import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TriggerStore } from '@zero-os/observe'
import type { TriggerRoutingSettings } from '@zero-os/shared'
import type { AgentDependencies } from '../../apps/server/src/triggers/event-agent'
import { createRouterAgent } from '../../apps/server/src/triggers/router-agent'
import { createRouterTraceSink } from '../../apps/server/src/triggers/router-trace'
import { RouterWorkspaceService } from '../../apps/server/src/triggers/router-workspace'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'

/** Real Router, configuration, timers, workbench receipts and outbound adapter boundary. Delivery targets and clock are isolated. */
export async function verifyContextualDelivery(output: string, deps: AgentDependencies) {
  const store = new TriggerStore(join(output, 'workspace.sqlite'))
  let at = new Date(Date.now() + 86400000)
  at.setUTCHours(10, 0, 0, 0)
  const targets = (['weixin', 'dingtalk', 'feishu'] as const).map((platform) => ({
    platform,
    channelId: platform + '-fixture',
    peerId: 'owner',
    operatorId: 'owner',
    label: platform,
  }))
  const denied = async (): Promise<never> => {
    throw Error('Unexpected external operation')
  }
  const sends: { platform: string; id: string; text: string }[] = []
  const runtime = new TriggerRoutingRuntime(
    store.routing,
    {
      analyze: denied,
      weixin: { listTargets: () => [], send: denied },
      personal: {
        listPersonalBots: () => targets.map((t) => ({ ...t, online: true })),
        listPersonalTargets: () => targets,
        listPersonalDirectTargets: () => targets,
        sendPersonal: denied,
        sendDirect: async (target, text, id, _signal, maySend) => {
          assert(maySend())
          sends.push({ platform: target.platform, id, text })
          return { status: 'accepted', receipt: 'test-' + id }
        },
      },
    },
    () => at,
  )
  function config(patch: Partial<TriggerRoutingSettings>) {
    const existing = runtime.getConfig()
    runtime.saveConfig({ ...existing.settings, ...patch }, existing.revision)
  }
  config({
    enabled: true,
    timeZone: 'UTC',
    workdays: [0, 1, 2, 3, 4, 5, 6],
    workStart: '09:00',
    workEnd: '18:00',
    duringWork: 'web',
    afterWork: 'feishu',
    offDay: 'defer',
    awayFallback: 'defer',
    presence: 'auto',
    personalBots: Object.fromEntries(targets.map((t) => [t.platform, t.channelId])),
  })
  for (const target of targets) assert(runtime.claimRouterImTarget(target))
  const ask = createRouterAgent({
    ...deps,
    modelRouter: {
      getDefaultModel: () => deps.modelRouter.getDefaultModel(),
      getCurrentModel: () => deps.modelRouter.getCurrentModel(),
      trace: createRouterTraceSink(store.ledger, (t) => deps.secretFilter.filter(t)),
    },
  })
  const service = new RouterWorkspaceService(store, runtime, ask, {
    principalFor: () => 'router-owner',
    agentIntake: true,
  })
  async function handover(title: string, text: string) {
    const m = store.ledger.createMatter('router-owner', title, '把验收结果通知本人', [
      '本人收到结果或已安排提醒',
    ])
    await service.message(
      'general',
      crypto.randomUUID(),
      title + ' 有了新的实测结果：' + text + '。请在这件事里记录并交付给我，遵照我保存的通知偏好。',
    )
    const publication = store.ledger.publications.list('router-owner', m.id)[0]
    assert(publication, 'Missing Web result for ' + title)
    return {
      matter: m.id,
      pub: publication.id,
      channels: publication.deliveries.map((d) => d.channel).sort(),
    }
  }
  try {
    service.start()
    const broadcast = await handover('南桥纸样签收', '3 份样张已入库')
    assert.deepEqual(broadcast.channels, ['dingtalk', 'feishu', 'web', 'weixin'])
    config({ notificationMode: 'contextual', urgentDestination: 'weixin' })
    const before = sends.length
    const initialPreview = await runtime.previewCurrentRoute('normal')
    assert.equal(initialPreview.destination, 'defer')
    const deferred = await handover('白果纸样核对', '第 2 箱有 14 册，普通进展，无需立即打扰')
    assert.deepEqual(deferred.channels, ['web'])
    assert.equal(sends.length, before)
    const timer = store.ledger
      .listTimers('router-owner', deferred.matter)
      .find((t) => t.publicationId === deferred.pub)
    assert(timer, 'Web was saved without a durable reminder')
    at = new Date(timer.dueAt)
    config({ duringWork: 'feishu', afterWork: 'feishu', offDay: 'feishu' })
    assert.equal((await runtime.previewCurrentRoute('normal')).destination, 'feishu')
    store.ledger.releaseDueTimers(at)
    service.notifySignals()
    for (let i = 0; i < 1800; i++) {
      const result = store.ledger
        .listSignals('router-owner')
        .find((s) => s.payload.timerId === timer.id)
      if (result && !['running', 'pending'].includes(result.state)) {
        assert.equal(result.state, 'completed', result.error ?? 'timer')
        break
      }
      await Bun.sleep(250)
    }
    assert.deepEqual(
      sends.slice(before).map((s) => s.platform),
      ['feishu'],
    )
    const urgentPreview = await runtime.previewCurrentRoute('urgent')
    assert.equal(urgentPreview.destination, 'weixin')
    const urgent = await handover('南桥库房告警', '冷库已断电，温度超过安全线，需要马上处置')
    assert.deepEqual(urgent.channels, ['web', 'weixin'])
    const turns = store.ledger.listRuns({ limit: 30 }).map((r) => ({
      run: r.id,
      tools: store.ledger
        .entries(r.id)
        .filter((e) => e.kind === 'tool_start')
        .map((e) => e.data),
    }))
    assert(
      turns.some((r) =>
        r.tools.some(
          (t) =>
            (t as { name: string; input?: { urgency?: string } }).name ===
              'preview_current_route' &&
            (t as { input?: { urgency?: string } }).input?.urgency === 'urgent',
        ),
      ),
    )
    writeFileSync(
      join(output, 'contextual.json'),
      JSON.stringify(
        { broadcast, initialPreview, deferred, timer, urgentPreview, urgent, turns, sends },
        null,
        2,
      ),
    )
  } finally {
    await service.close()
    await runtime.close()
    store.close()
  }
}
