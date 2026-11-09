import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TriggerStore } from '@zero-os/observe'
import type { AgentDependencies } from '../../apps/server/src/triggers/event-agent'
import { createRouterAgent } from '../../apps/server/src/triggers/router-agent'
import { RouterJobPrincipals } from '../../apps/server/src/triggers/router-job-principal'
import {
  RouterJobExecutionUncertainError,
  RouterJobs,
} from '../../apps/server/src/triggers/router-jobs'
import { createRouterTraceSink } from '../../apps/server/src/triggers/router-trace'
import {
  handoffAuthorized,
  readWorkerHandoff,
} from '../../apps/server/src/triggers/router-worker-capabilities'
import { RouterWorkspaceService } from '../../apps/server/src/triggers/router-workspace'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'

export async function verifyWorkerRecovery(output: string, deps: AgentDependencies) {
  const store = new TriggerStore(join(output, 'workspace.sqlite'))
  const owner = 'router-owner',
    repo = 'example/lab',
    receipt = join(output, 'inspection.json')
  const denied = async (): Promise<never> => {
    throw Error('Unexpected external operation')
  }
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: denied,
    weixin: { listTargets: () => [], send: denied },
  })
  const principals = new RouterJobPrincipals(store, { accessKey: () => 'local-reader' })
  const calls: Array<{ jobId: number; attempt: number; executor: string; thread: string | null }> =
    []
  let writes = 0
  let transferred: ReturnType<typeof readWorkerHandoff> = null
  const jobs = new RouterJobs(store.jobs, {
    authorized: principals.authorized.bind(principals),
    handoffAuthorized: (job) =>
      handoffAuthorized(store, job, (source) =>
        principals.authorized(source.scope, source.audience, source.repository),
      ),
    execute: async (job, history, _signal, onThreadReady) => {
      calls.push({
        jobId: job.id,
        attempt: job.attempt,
        executor: job.executor,
        thread: job.threadId,
      })
      if (job.executor === 'codex') {
        if (job.attempt === 1) {
          onThreadReady?.('instrument-worker')
          return {
            threadId: 'instrument-worker',
            result:
              '仪表序列 S-07，独立时钟对照已排除采样时间错位。等操作者提供批次号，下一步在仪表登记一次检验，再核对签名回执。',
          }
        }
        assert.equal(job.attempt, 2, 'The uncertain registration was repeated')
        assert.equal(job.threadId, 'instrument-worker')
        assert(history[0].result?.includes('S-07'))
        assert(job.instruction.includes('B16'), 'Missing batch correction')
        writes++
        writeFileSync(
          receipt,
          JSON.stringify({ batch: 'B16', instrument: 'S-07', signed: 'R-418', count: writes }),
        )
        const run = store.ledger.begin('router-job-' + job.id, '登记仪表', { attempt: job.attempt })
        store.ledger.append(run, 'tool_result', {
          name: 'register',
          result: {
            output: '仪表已提交登记，待从独立档案 inspection.json 核对签名；原线程通信中断。',
          },
        })
        store.ledger.end(run, 'failed')
        throw new RouterJobExecutionUncertainError(
          '仪表线程断连。登记可能已执行；通用 Worker 可以只读独立档案 inspection.json 核对签名。',
        )
      }
      transferred = readWorkerHandoff(store, job, () => true)
      assert(transferred && transferred.fromStatus === 'unknown')
      assert(transferred.steps.some((s) => s.result?.includes('排除采样时间错位')))
      assert(JSON.stringify(transferred.evidence).includes('inspection.json'))
      return {
        result: '已只读复核仪表独立签名档案：' + readFileSync(receipt, 'utf8') + '。登记仅一次。',
      }
    },
    completed: async (job) => {
      const link = store.ledger.workerLink(job.id)
      assert(link)
      store.ledger.receiveSignal({
        principal: owner,
        kind: 'worker_result',
        scope: 'general',
        key: `worker:${job.id}:${job.attempt}`,
        payload: {
          matterId: link.matterId,
          jobId: job.id,
          attempt: job.attempt,
          status: job.status,
        },
      })
      workspace.notifySignals()
      return 'delivered'
    },
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
    principalFor: () => owner,
    principals,
    checkout: async () => output,
    delegatedJobs: jobs,
  })
  async function waitFor(check: () => boolean) {
    const until = Date.now() + 240_000
    while (!check()) {
      const failure = store.ledger.listSignals(owner).find((s) => s.state === 'failed')
      if (failure) throw Error(failure.error ?? 'Signal failed')
      assert(Date.now() < until, 'Timed out observing Worker handoff')
      await Bun.sleep(150)
    }
  }
  try {
    workspace.start()
    await workspace.message(
      'general',
      crypto.randomUUID(),
      `请用工程 Worker 读取 ${repo} 仪表台账，先核实仪表序列号和采样时钟。批次号稍后我给你，再由原 Worker 登记一次、核对独立签名并在网页交付；签名才能作为完成依据。登记不能重复。若工程线程失联，安排可用的通用 Worker 接过原证据，只读取独立回执。现在先等批次号。`,
    )
    await waitFor(() =>
      store.ledger
        .listSignals(owner)
        .some((s) => s.kind === 'worker_result' && s.state === 'completed'),
    )
    assert.equal(calls.length, 1)
    const matter = store.ledger.searchMatters(owner)[0]
    assert(matter && store.ledger.getMatter(owner, matter.id)?.state !== 'completed')
    await workspace.message(
      'general',
      crypto.randomUUID(),
      '批次号到了，是 B16。继续先前的登记并核对签名。',
    )
    await waitFor(
      () =>
        store.ledger.getMatter(owner, matter.id)?.state === 'completed' &&
        store.ledger
          .listSignals(owner)
          .filter((s) => s.kind === 'worker_result' && s.state === 'completed').length >= 3,
    )
    assert.equal(calls.length, 3)
    assert.equal(calls[0].jobId, calls[1].jobId)
    assert.notEqual(calls[1].jobId, calls[2].jobId)
    assert.equal(writes, 1)
    const publications = store.ledger.publications.list(owner, matter.id)
    const web = publications
      .flatMap((p) => p.deliveries)
      .filter((d) => d.channel === 'web' && d.status === 'accepted')
    assert(web.some((d) => d.presentation.text.includes('R-418')))
    writeFileSync(
      join(output, 'worker-recovery.json'),
      JSON.stringify(
        {
          matter: matter.id,
          calls,
          writes,
          handoff: transferred,
          proof: JSON.parse(readFileSync(receipt, 'utf8')),
          web: web.map((d) => d.presentation.text),
          signals: store.ledger.listSignals(owner),
        },
        null,
        2,
      ),
    )
  } finally {
    await workspace.close()
    await routing.close()
    store.close()
  }
}
