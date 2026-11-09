import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TriggerStore } from '@zero-os/observe'
import type { AgentDependencies } from '../../apps/server/src/triggers/event-agent'
import { createRouterAgent } from '../../apps/server/src/triggers/router-agent'
import { RouterJobPrincipals } from '../../apps/server/src/triggers/router-job-principal'
import { RouterJobs } from '../../apps/server/src/triggers/router-jobs'
import { createRouterTraceSink } from '../../apps/server/src/triggers/router-trace'
import { RouterWorkspaceService } from '../../apps/server/src/triggers/router-workspace'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'

/** Same goal and latest result in both cases. Only the earlier inspection differs. */
export async function verifyPartialWork(output: string, deps: AgentDependencies) {
  for (const verified of [false, true]) {
    const name = verified ? 'both-shelves' : 'first-shelf'
    const store = new TriggerStore(join(output, name + '.sqlite'))
    const owner = 'router-owner'
    const principals = new RouterJobPrincipals(store, { accessKey: () => null })
    const audience = principals.capture('web', false)
    const matter = store.ledger.createMatter(
      owner,
      '展柜复查',
      '交付上下层灯带的实测结果与馆藏标签清单',
      ['两层分别有可查的测量记录，标签清单已交付'],
    )
    const denied = async (): Promise<never> => {
      throw Error('unexpected external action')
    }
    const routing = new TriggerRoutingRuntime(store.routing, {
      analyze: denied,
      weixin: { listTargets: () => [], send: denied },
    })
    const jobs = new RouterJobs(store.jobs, {
      authorized: principals.authorized.bind(principals),
      execute: denied,
      completed: async () => 'delivered',
    })
    const model = createRouterAgent({
      ...deps,
      modelRouter: {
        getDefaultModel: () => deps.modelRouter.getDefaultModel(),
        getCurrentModel: () => deps.modelRouter.getCurrentModel(),
        trace: createRouterTraceSink(store.ledger, (s) => deps.secretFilter.filter(s)),
      },
    })
    const service = new RouterWorkspaceService(store, routing, model, {
      agentIntake: true,
      principalFor: () => owner,
      principals,
      delegatedJobs: jobs,
    })
    try {
      const job = store.jobs.submit(
        'general',
        'inspection',
        { executor: 'zero', instruction: '现场核对展柜上层及下层灯带。', audience },
        (job) =>
          store.ledger.bindWorker({
            jobId: job.id,
            matterId: matter.id,
            principal: owner,
            scope: 'general',
            audience,
            eventIds: [],
            authority: 'user',
          }),
      )
      store.jobs.claimNext()
      const first =
        '巡检员原始签字记录：上层照度 142 lx。' +
        (verified
          ? '下层照度 107 lx，两个位置都已交付测量单。'
          : '下层传感器线缆未到，待接线后实测；142 lx 仅属于上层。')
      store.jobs.finish(job.id, 1, { status: 'completed', result: first })
      store.jobs.continue('general', job.id, 'labels', '另整理馆藏标签清单。')
      store.jobs.claimNext()
      store.jobs.finish(job.id, 2, { status: 'completed', result: '标签清单已核对并交付。' })
      jobs.start()
      service.start()
      const view = await service.message(
        'general',
        crypto.randomUUID(),
        '展柜复查里还有什么没有处理？按已有现场记录告诉我各处测得多少、哪部分还要做。',
      )
      const answer = view.turns.at(-1)?.answer
      assert(answer)
      writeFileSync(join(output, name + '.json'), JSON.stringify({ first, answer }, null, 2))
      assert(answer.text.includes('142') && answer.text.includes('上层'))
      assert(answer.text.includes('下层'))
      if (verified) assert(answer.text.includes('107'))
      else assert(!answer.text.includes('107') && /待|未|缺|还需|补测|需接/.test(answer.text))
    } finally {
      await service.close()
      await jobs.close()
      await routing.close()
      store.close()
    }
  }
}
