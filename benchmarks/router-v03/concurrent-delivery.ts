import { Database } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TriggerStore } from '@zero-os/observe'
import type { AgentDependencies } from '../../apps/server/src/triggers/event-agent'
import { createRouterAgent } from '../../apps/server/src/triggers/router-agent'
import { createRouterTraceSink } from '../../apps/server/src/triggers/router-trace'
import {
  type RouterSourceAdapter,
  RouterWorkspaceService,
} from '../../apps/server/src/triggers/router-workspace'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'

export async function verifyConcurrentDelivery(output: string, deps: AgentDependencies) {
  const file = join(output, 'workspace.sqlite')
  const store = new TriggerStore(file)
  const audit = new Database(file, { readonly: true })
  const owner = 'router-owner'
  const matter = store.ledger.createMatter(
    owner,
    '航标 S8 的两次实测交接',
    '把首测和复测分别交付到网页和飞书，两个回执都要保留。收到复测前继续跟进。',
    ['两次读数分别交付', '可定位两份实测记录'],
  )
  const target = {
    platform: 'feishu' as const,
    channelId: 'fixture-lamp',
    peerId: 'reader',
    operatorId: 'reader',
  }
  const held = Promise.withResolvers<void>()
  const calls: { id: string; text: string }[] = []
  const denied = async (): Promise<never> => {
    throw Error('Unexpected external operation')
  }
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: denied,
    weixin: { listTargets: () => [], send: denied },
    personal: {
      listPersonalBots: () => [{ ...target, label: '验收飞书', online: true }],
      listPersonalTargets: () => [{ ...target, label: '验收私聊' }],
      listPersonalDirectTargets: () => [target],
      sendPersonal: denied,
      async sendDirect(_target, text, id, _signal, maySend) {
        assert(maySend())
        calls.push({ id, text })
        if (calls.length === 1) await held.promise
        return { status: 'accepted', receipt: `fixture-${calls.length}` }
      },
    },
  })
  const config = routing.getConfig()
  routing.saveConfig(
    { ...config.settings, enabled: true, personalBots: { feishu: target.channelId } },
    config.revision,
  )
  assert(routing.claimRouterImTarget(target))
  const checkAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  store.ledger.scheduleTimer({
    principal: owner,
    scope: 'general',
    matterId: matter.id,
    requestKey: 'verify-second-reading',
    dueAt: checkAt,
    reason: '若尚未收到复测，核对交接进展。',
  })
  const emitters = new Map<string, Parameters<RouterSourceAdapter['subscribe']>[0]>()
  const sources = ['shore-log', 'inspection-log'].map((name) => ({
    name,
    description: '航标实测登记',
    subscribe(emit: Parameters<RouterSourceAdapter['subscribe']>[0]) {
      emitters.set(name, emit)
    },
  }))
  const ask = createRouterAgent({
    ...deps,
    modelRouter: {
      getDefaultModel: () => deps.modelRouter.getDefaultModel(),
      getCurrentModel: () => deps.modelRouter.getCurrentModel(),
      trace: createRouterTraceSink(store.ledger, (text) => deps.secretFilter.filter(text)),
    },
  })
  const service = new RouterWorkspaceService(store, routing, ask, {
    principalFor: () => owner,
    agentIntake: true,
    sources,
  })
  service.start()
  function state(id: number) {
    return audit
      .query<{ state: string; error: string | null }, [number]>(
        'SELECT state,error FROM router_signals WHERE id=?',
      )
      .get(id)
  }
  async function wait(id: number, predicate: () => boolean) {
    for (let n = 0; n < 1600; n++) {
      if (predicate()) return
      const row = state(id)
      if (row?.state === 'failed' || row?.state === 'completed')
        throw Error(row.error ?? 'Signal finished without expected delivery')
      await Bun.sleep(250)
    }
    throw Error('No observed delivery in the acceptance interval')
  }
  try {
    const first = {
      id: 'measurement-1',
      data: { station: 'S8', measurement: '首测', reading: '17 lx' },
    }
    const second = {
      id: 'measurement-2',
      data: { station: 'S8', measurement: '复测', reading: '31 lx' },
    }
    const emitFirst = emitters.get('shore-log')
    const emitSecond = emitters.get('inspection-log')
    assert(emitFirst && emitSecond)
    const a = emitFirst(first)
    await wait(a, () => calls.length === 1)
    const b = emitSecond(second)
    assert.equal(emitFirst(first), a)
    assert.equal(emitSecond(second), b)
    assert.equal(state(a)?.state, 'running')
    assert.equal(state(b)?.state, 'pending')
    held.resolve()
    await wait(b, () => state(b)?.state === 'completed')
    const turns = [a, b].map((id) => store.conversations.get('general', `signal-${id}`))
    const publications = store.ledger.publications.list(owner, matter.id)
    const reminder = store.ledger.getTimer(owner, 'verify-second-reading')
    const evidence = {
      reminder,
      matter: matter.id,
      signals: [a, b],
      turns: turns.map((t) => ({ id: t?.id, status: t?.status })),
      calls,
      delivery: publications.map((p) => ({
        id: p.id,
        receipts: p.deliveries.map((d) => [d.channel, d.status, d.receipt]),
      })),
    }
    writeFileSync(join(output, 'concurrent-delivery.json'), JSON.stringify(evidence, null, 2))
    assert(
      reminder?.state === 'cancelled' &&
        reminder.cancelReason &&
        reminder.cancelTurnId &&
        turns.some((t) => t?.id === reminder.cancelTurnId),
    )
    assert.equal(state(a)?.state, 'completed')
    assert(turns.every((t) => t?.status === 'completed'))
    assert.equal(calls.length, 2)
    assert.equal(new Set(calls.map((c) => c.id)).size, 2)
    assert(calls[0].text.includes('17') && calls[1].text.includes('31'))
    assert.equal(publications.length, 2)
    assert(
      publications.every(
        (p) => p.deliveries.length === 2 && p.deliveries.every((d) => d.status === 'accepted'),
      ),
    )
    assert.equal(
      audit
        .query<{ n: number }, []>("SELECT count(*) n FROM router_signals WHERE kind='event'")
        .get()?.n,
      2,
    )
  } finally {
    held.resolve()
    await service.close()
    await routing.close()
    store.close()
    audit.close()
  }
}
