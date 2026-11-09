import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TriggerStore } from '@zero-os/observe'
import type { AgentDependencies } from '../../apps/server/src/triggers/event-agent'
import { createRouterAgent } from '../../apps/server/src/triggers/router-agent'
import { RouterJobPrincipals } from '../../apps/server/src/triggers/router-job-principal'
import { RouterJobs } from '../../apps/server/src/triggers/router-jobs'
import { createRouterTraceSink } from '../../apps/server/src/triggers/router-trace'
import { RouterWorkspaceService } from '../../apps/server/src/triggers/router-workspace'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'

/** The barriers control arrival order only. The configured Router decides how to reconcile the inputs. */
export async function verifyConcurrentInputs(output: string, deps: AgentDependencies) {
  const expectedState = process.env.ZERO_ACCEPTANCE_CONCURRENT_STATE ?? 'waiting'
  assert(['waiting', 'paused', 'cancelled'].includes(expectedState))
  const file = join(output, 'workspace.sqlite')
  assert(!existsSync(file), 'Use a fresh output directory')
  const store = new TriggerStore(file)
  const principal = 'router-owner'
  const matter = store.ledger.createMatter(
    principal,
    '兼容性核查',
    '核实接口兼容性并等待处置决定',
    ['核对复现', '取得负责人最终决定'],
  )
  store.ledger.updateMatter(principal, matter.id, 1, {
    state: 'working',
    context: { target: '样本 M17', decision: '先核验样本，等负责人决定如何处理' },
  })
  const principals = new RouterJobPrincipals(store, { accessKey: () => null })
  const work = Promise.withResolvers<string>(),
    started = Promise.withResolvers<void>()
  const owner = principals.capture('web', false)
  const currentJob = store.jobs.submit(
    'general',
    'fixture-probe',
    { executor: 'zero', instruction: '检查 M17 的兼容性', audience: owner },
    (j) => {
      store.ledger.bindWorker({
        principal,
        matterId: matter.id,
        jobId: j.id,
        scope: 'general',
        audience: owner,
        eventIds: [],
        authority: 'user',
      })
    },
  )
  const jobs = new RouterJobs(store.jobs, {
    authorized: principals.authorized.bind(principals),
    execute: async () => {
      started.resolve()
      return { result: await work.promise }
    },
    completed: async (j) => {
      store.ledger.receiveSignal({
        principal,
        key: `worker:${j.id}:${j.attempt}`,
        kind: 'worker_result',
        scope: 'general',
        payload: { jobId: j.id, attempt: j.attempt, status: j.status, matterId: matter.id },
      })
      service.notifySignals()
      return 'delivered'
    },
  })
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: async () => {
      throw Error('Unexpected analysis')
    },
    weixin: {
      listTargets: () => [],
      send: async () => {
        throw Error('Unexpected external delivery')
      },
    },
  })
  const ask = createRouterAgent({
    ...deps,
    modelRouter: {
      ...deps.modelRouter,
      trace: createRouterTraceSink(store.ledger, (s) => deps.secretFilter.filter(s)),
    },
  })
  const older = '兼容性核查补一条现场证据：M17 的用例 E14 已通过。按当前计划继续核对 M17。'
  const correction =
    '兼容性核查的目标改成 M23，把 M17 留作历史。撤回采用 M17 的许可。' +
    (expectedState === 'cancelled'
      ? '现在取消这件事，保留历史材料。'
      : expectedState === 'paused'
        ? '现在暂停这件事，等我明确恢复再继续。'
        : '等我确认 M23 的结果后再决定。') +
    '只在当前事项记下这个决定。'
  const webEntered = Promise.withResolvers<void>(),
    releaseWeb = Promise.withResolvers<void>()
  const service = new RouterWorkspaceService(
    store,
    routing,
    async (input, signal) => {
      if (input.question === older) {
        webEntered.resolve()
        await releaseWeb.promise
      }
      return ask(input, signal)
    },
    { principalFor: () => principal, principals, delegatedJobs: jobs, agentIntake: true },
  )
  try {
    service.start()
    await started.promise
    const web = service.message('general', crypto.randomUUID(), older)
    await webEntered.promise
    const im = await service.handleIm(
      {
        isDirect: true,
        platform: 'weixin',
        channelId: 'fixture',
        actorId: 'fixture',
        peerId: 'fixture',
        messageId: 'correction',
        text: correction,
      },
      () => true,
    )
    const corrected = store.ledger.getMatter(principal, matter.id)
    releaseWeb.resolve()
    await web
    work.resolve('旧目标 M17 的用例 E15 也通过，按原计划可以采用 M17。没有测试 M23。')
    // Poll the actual durable signal; a timeout is an incomplete run, not a second submission.
    const deadline = Date.now() + 180_000
    let item = store.ledger.listSignals(principal).find((s) => s.kind === 'worker_result')
    while (
      (!item || item.state === 'pending' || item.state === 'running') &&
      Date.now() < deadline
    ) {
      await Bun.sleep(200)
      item = store.ledger.listSignals(principal).find((s) => s.kind === 'worker_result')
    }
    const latest = store.ledger.getMatter(principal, matter.id)
    const runs = store.ledger.listRuns({ limit: 30 })
    const reply = item && store.conversations.get('general', `signal-${item.id}`)?.answer?.text
    const proof = {
      mode: 'live-model-isolated-concurrent-web-and-weixin-fixture-worker',
      matterId: matter.id,
      corrected,
      latest,
      latestOwnerInput: store.ledger.latestUserUpdate(principal, matter.id),
      im,
      reply,
      job: store.jobs.get('general', currentJob.id)?.result,
      workerSignal: item,
      versions: store.ledger.matterHistory(principal, matter.id),
      runs: runs.map((r) => ({ id: r.id, session: r.sessionId, status: r.status })),
      publications: store.ledger.publications
        .list(principal, matter.id)
        .map((p) => ({ id: p.id, channels: p.deliveries.map((d) => d.channel) })),
    }
    writeFileSync(join(output, 'observations.json'), JSON.stringify(proof, null, 2))
    assert(item?.state === 'completed' && corrected && latest && reply)
    assert(
      JSON.stringify(corrected).includes('M23') &&
        JSON.stringify(latest).includes('M23') &&
        latest.state !== 'completed',
    )
    assert(proof.latestOwnerInput?.turnId === 2)
    assert(
      latest.state === expectedState &&
        ['E14', 'E15', 'M23'].every((fact) => JSON.stringify(latest.context).includes(fact)),
    )
    assert(reply.includes('M23') && proof.publications.length === 0)
    console.log(JSON.stringify({ state: latest.state, reply, output }))
  } finally {
    releaseWeb.resolve()
    work.resolve('验收结束')
    await service.close()
    await routing.close()
    store.close()
  }
}
