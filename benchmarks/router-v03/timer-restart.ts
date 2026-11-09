import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TriggerStore } from '@zero-os/observe'
import type { AgentDependencies } from '../../apps/server/src/triggers/event-agent'
import { createRouterAgent } from '../../apps/server/src/triggers/router-agent'
import { createRouterTraceSink } from '../../apps/server/src/triggers/router-trace'
import { RouterWorkspaceService } from '../../apps/server/src/triggers/router-workspace'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'

export async function verifyTimerRestart(output: string, deps: AgentDependencies) {
  const file = join(output, 'workspace.sqlite')
  const open = () => {
    const store = new TriggerStore(file)
    const forbidden = async (): Promise<never> => {
      throw Error('Unexpected external send')
    }
    const routing = new TriggerRoutingRuntime(store.routing, {
      analyze: forbidden,
      weixin: { listTargets: () => [], send: forbidden },
    })
    const agent = createRouterAgent({
      ...deps,
      modelRouter: {
        ...deps.modelRouter,
        trace: createRouterTraceSink(store.ledger, (s) => deps.secretFilter.filter(s)),
      },
    })
    const workspace = new RouterWorkspaceService(store, routing, agent, {
      agentIntake: true,
      principalFor: () => 'router-owner',
    })
    workspace.start()
    return {
      store,
      workspace,
      close: async () => {
        await workspace.close()
        await routing.close()
        store.close()
      },
    }
  }
  let runtime = open()
  try {
    const due = new Date(Date.now() + 100_000).toISOString()
    await runtime.workspace.message(
      'general',
      crypto.randomUUID(),
      `请在 ${due} 到点后，只在网页提醒我拿蓝色的交接册。提醒交付就完成。现在只安排，到点之前不要提醒。`,
    )
    const matter = runtime.store.ledger.searchMatters('router-owner')[0]
    assert(matter)
    const timers = runtime.store.ledger.listTimers('router-owner', matter.id)
    assert.equal(timers.length, 1)
    assert.equal(timers[0].dueAt, due)
    assert.equal(timers[0].state, 'scheduled')
    assert.equal(
      runtime.store.ledger.listSignals('router-owner').filter((s) => s.kind === 'timer').length,
      0,
    )
    await runtime.close()
    runtime = open()
    assert.equal(runtime.store.ledger.getTimer('router-owner', timers[0].id)?.dueAt, due)
    const until = Date.parse(due) + 180_000
    let signal
    while (Date.now() < until) {
      signal = runtime.store.ledger.listSignals('router-owner').find((s) => s.kind === 'timer')
      if (signal && !['pending', 'running'].includes(signal.state)) break
      await Bun.sleep(300)
    }
    assert(signal)
    assert.equal(signal.state, 'completed', signal.error ?? 'timer signal did not complete')
    assert(Date.parse(signal.createdAt) >= Date.parse(due))
    assert.equal(signal.payload.matterId, matter.id)
    assert.equal(
      runtime.store.ledger.listSignals('router-owner').filter((s) => s.kind === 'timer').length,
      1,
    )
    const deliveries = runtime.store.ledger.publications
      .list('router-owner', matter.id)
      .filter((p) => Date.parse(p.createdAt) >= Date.parse(due))
      .flatMap((p) => p.deliveries)
      .filter((d) => d.channel === 'web' && d.status === 'accepted')
    assert(deliveries.some((d) => d.presentation.text.includes('交接册')))
    const final = runtime.store.ledger.getMatter('router-owner', matter.id)
    assert.equal(final?.state, 'completed')
    const traces = runtime.store.ledger.listRuns({ platform: 'timer' })
    assert.equal(traces.length, 1)
    assert(runtime.store.ledger.entries(traces[0].id).some((e) => e.kind === 'model_request'))
    writeFileSync(
      join(output, 'timer.json'),
      JSON.stringify(
        {
          due,
          signal,
          matter: final.id,
          finalState: final.state,
          run: traces[0].id,
          web: deliveries.map((d) => d.presentation.text),
        },
        null,
        2,
      ),
    )
  } finally {
    await runtime.close()
  }
}
