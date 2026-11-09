import { Database } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TriggerStore } from '@zero-os/observe'
import type { AgentDependencies } from '../../apps/server/src/triggers/event-agent'
import { createRouterAgent } from '../../apps/server/src/triggers/router-agent'
import { RouterJobPrincipals } from '../../apps/server/src/triggers/router-job-principal'
import { RouterJobs } from '../../apps/server/src/triggers/router-jobs'
import { createRouterTraceSink } from '../../apps/server/src/triggers/router-trace'
import {
  type RouterSourceAdapter,
  RouterWorkspaceService,
} from '../../apps/server/src/triggers/router-workspace'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'

export async function verifyConnectorExtension(output: string, deps: AgentDependencies) {
  const file = join(output, 'workspace.sqlite')
  const sheet = join(output, 'scale-readings.json')
  const key = `K${crypto.randomUUID().slice(0, 8)}`
  const reversed = process.env.ZERO_ACCEPTANCE_ORDER === 'tare-first'
  const calls: { id: number; attempt: number; previousThread: string | null; result: string }[] = []
  function boot() {
    const store = new TriggerStore(file)
    const audit = new Database(file, { readonly: true })
    const principal = 'router-owner'
    const principals = new RouterJobPrincipals(store, { accessKey: () => null })
    const blocked = async (): Promise<never> => {
      throw Error('Unexpected built-in executor or external delivery')
    }
    const routing = new TriggerRoutingRuntime(store.routing, {
      analyze: blocked,
      weixin: { listTargets: () => [], send: blocked },
    })
    const trace = createRouterTraceSink(store.ledger, (text) => deps.secretFilter.filter(text))
    let emit!: Parameters<RouterSourceAdapter['subscribe']>[0]
    const source: RouterSourceAdapter = {
      name: 'weighbridge',
      description: '天平归档通知，记录批次与原始单据到达。',
      subscribe(receive) {
        emit = receive
      },
    }
    const jobs = new RouterJobs(store.jobs, {
      trace,
      authorized: principals.authorized.bind(principals),
      execute: blocked,
      executors: [
        {
          name: 'scale-reader',
          description:
            '可读取本机天平的原始称量单，核对毛重、皮重并计算净重。其他执行器没有仪器访问能力。',
          async execute(job, _history, signal, onThreadReady) {
            signal.throwIfAborted()
            const raw = JSON.parse(readFileSync(sheet, 'utf8')) as { gross?: number; tare?: number }
            const result =
              raw.gross === undefined
                ? `原单 ${key} 皮重为 ${raw.tare} g，毛重尚未入账。尚不能计算净重，请跟进同一单据。`
                : raw.tare === undefined
                  ? `原单 ${key} 毛重为 ${raw.gross} g，皮重尚未入账。尚不能计算净重，请跟进同一单据。`
                  : `原单 ${key} 的毛重 ${raw.gross} g，皮重 ${raw.tare} g，实测净重 ${raw.gross - raw.tare} g。`
            calls.push({ id: job.id, attempt: job.attempt, previousThread: job.threadId, result })
            onThreadReady?.(key)
            return { result, threadId: key }
          },
        },
      ],
      completed: async (job) => {
        const link = store.ledger.workerLink(job.id)
        assert(link)
        store.ledger.receiveSignal({
          principal,
          scope: 'general',
          kind: 'worker_result',
          key: `worker:${job.id}:${job.attempt}`,
          payload: {
            matterId: link.matterId,
            jobId: job.id,
            attempt: job.attempt,
            status: job.status,
          },
        })
        service.notifySignals()
        return 'delivered'
      },
    })
    const ask = createRouterAgent({
      ...deps,
      modelRouter: {
        getDefaultModel: () => deps.modelRouter.getDefaultModel(),
        getCurrentModel: () => deps.modelRouter.getCurrentModel(),
        trace,
      },
    })
    const service = new RouterWorkspaceService(store, routing, ask, {
      agentIntake: true,
      principalFor: () => principal,
      principals,
      delegatedJobs: jobs,
      sources: [source],
    })
    jobs.start()
    service.start()
    return {
      store,
      service,
      emit,
      audit,
      async close() {
        await service.close()
        await jobs.close()
        await routing.close()
        store.close()
        audit.close()
      },
    }
  }
  let rt = boot()
  async function settle(attempt: number) {
    for (let n = 0; n < 2400; n++) {
      const failure = rt.audit
        .query<{ error: string }, []>(
          "SELECT error FROM router_signals WHERE state='failed' LIMIT 1",
        )
        .get()
      if (failure) throw Error(failure.error)
      if (
        calls.some((c) => c.attempt === attempt) &&
        rt.audit
          .query("SELECT 1 FROM router_signals WHERE key=? AND state='completed'")
          .get(`worker:${calls[0].id}:${attempt}`)
      )
        return
      await Bun.sleep(250)
    }
    throw Error('Worker result not processed within the acceptance observation interval')
  }
  try {
    await rt.service.message(
      'general',
      crypto.randomUUID(),
      `跟进称量单 ${key}。等仪器通知到达再查原单，先核已到的那份记录，另一份补齐后计算并核对净重，在网页交付。现在还没有原单。`,
    )
    const matter = rt.store.ledger.searchMatters('router-owner')[0]
    assert(matter)
    writeFileSync(sheet, JSON.stringify(reversed ? { tare: 275 } : { gross: 843 }))
    const first = {
      id: reversed ? 'tare-1' : 'gross-1',
      data: { batch: key, notice: reversed ? '皮重原单已入库。' : '毛重原单已入库。' },
    }
    const input = rt.emit(first)
    assert.equal(rt.emit(first), input)
    await settle(1)
    assert.equal(rt.store.ledger.workerLink(calls[0].id)?.matterId, matter.id)
    assert.notEqual(rt.store.ledger.getMatter('router-owner', matter.id)?.state, 'completed')
    let earlier: string | undefined
    let independent: string | undefined
    if (process.env.ZERO_ACCEPTANCE_RELATED === '1') {
      for (const [kind, goal, condition] of [
        ['tare', '核对空容器的实测重量', '从该批次称量原单取得皮重与单位'],
        ['receipt', '核对收件人签收', '有经办人签名的独立收件回执'],
      ]) {
        const issue = rt.store.ledger.createMatter('router-owner', key + ' ' + goal, goal, [
          condition,
        ])
        rt.store.ledger.updateMatter('router-owner', issue.id, issue.version, {
          state: 'waiting',
          context: { batch: key, pending: condition },
        })
        if (kind === 'tare') earlier = issue.id
        else independent = issue.id
      }
    }
    const oldEmitter = rt.emit
    await rt.close()
    assert.throws(() => oldEmitter(first))
    rt = boot()
    assert.equal(
      rt.emit({ ...first, data: { notice: first.data.notice, batch: first.data.batch } }),
      input,
    )
    assert.throws(() => rt.emit({ ...first, data: { batch: 'different' } }))
    writeFileSync(sheet, JSON.stringify({ gross: 843, tare: 275 }))
    rt.emit({
      id: reversed ? 'gross-1' : 'tare-1',
      data: {
        batch: key,
        notice: reversed
          ? '补充的毛重原单已入库，称量单齐全。'
          : '补充的皮重原单已入库，称量单齐全。',
      },
    })
    await settle(2)
    assert.deepEqual(
      calls.map((c) => c.id),
      [calls[0].id, calls[0].id],
    )
    assert.equal(calls[1].previousThread, key)
    assert.equal(rt.store.ledger.getMatter('router-owner', matter.id)?.state, 'completed')
    if (earlier && independent) {
      const sibling = rt.store.ledger.getMatter('router-owner', earlier)
      const unrelated = rt.store.ledger.getMatter('router-owner', independent)
      writeFileSync(
        join(output, 'related-status.json'),
        JSON.stringify({ sibling, unrelated }, null, 2),
      )
      assert.equal(sibling?.state, 'completed')
      assert(JSON.stringify(sibling.context).includes('275'))
      assert.equal(unrelated?.state, 'waiting')
    }
    const delivery = rt.store.ledger.publications
      .list('router-owner', matter.id)
      .flatMap((p) => p.deliveries)
      .find(
        (d) =>
          d.channel === 'web' && d.status === 'accepted' && d.presentation.text.includes('568'),
      )
    assert(delivery)
    const runs = rt.store.ledger.listRuns({ platform: 'weighbridge' })
    assert.equal(runs.length, 2)
    const workerRuns = rt.store.ledger.listRuns({ sessionId: `router-job-${calls[0].id}` })
    assert.equal(workerRuns.length, 2)
    for (const run of workerRuns) {
      assert.equal(run.matterId, matter.id)
      const entries = rt.store.ledger.entries(run.id)
      assert(
        entries.some((e) => e.kind === 'result') &&
          entries.some(
            (e) => (e.data as { transport?: string })?.transport === 'registered-executor',
          ),
      )
    }
    const requests = rt.store.ledger.entries(runs[0].id).filter((e) => e.kind === 'model_request')
    assert(requests.some((e) => JSON.stringify(e.data).includes('scale-reader')))

    writeFileSync(
      join(output, 'connector-extension.json'),
      JSON.stringify(
        {
          matter: matter.id,
          calls,
          order: reversed ? ['tare', 'gross'] : ['gross', 'tare'],
          sourceRuns: runs.map((r) => r.id),
          workerRuns: workerRuns.map((r) => r.id),
          delivery: delivery.presentation.text,
        },
        null,
        2,
      ),
    )
  } finally {
    await rt.close()
  }
}
