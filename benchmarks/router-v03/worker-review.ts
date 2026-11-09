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
import { RouterWorkspaceService } from '../../apps/server/src/triggers/router-workspace'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'

/** Worker returns are controlled inputs to the acceptance test. Router decisions use the real model. */
export async function verifyWorkerReview(output: string, deps: AgentDependencies) {
  const missingSite = process.env.ZERO_ACCEPTANCE_SUITE === 'worker-review-missing'
  const privateFollowup = process.env.ZERO_ACCEPTANCE_SUITE === 'worker-review-im'
  const file = join(output, 'workspace.sqlite')
  const store = new TriggerStore(file)
  const audit = new Database(file, { readonly: true })
  const archive = join(output, 'inspection-records.json')
  const exhausted = '已查完索引内的全部原始资料，没有其他记录。'
  const mark = `T${crypto.randomUUID().slice(0, 6)}`
  const reports = [
    '档案索引只找到一份未署名便笺：所有旧热封机都要停机。便笺未引用原条款，同批目录另有制造商通告 B17。',
    '已打开制造商现行原始通告 B17 修订 2 的第 4 条，原文为「R4 温控板且固件版本低于 3.8 时停机」。第 5 条将 3.8 及以上列为已修复。附件目录含设备出厂装配单和当前维护记录。尚未确认本机是否符合这两个条件。',
    missingSite
      ? 'H21 现行装配单 A21 第 2 项与最近签名维保单 M31 第 1 项均确认当前温控板为 R4，之后无换板记录。M31 第 2 项记载固件曾在现场更换，但没有当前版本。目录内的原始资料已全部核对，没有在线诊断权限；只有设备现场控制面板能读出当前固件版本。'
      : `H21 现行装配单 A21 第 2 项确认当前温控板为 R4，之后无换板记录；签名维护记录 ${mark} 确认固件已更新到 3.8，通告 B17 的停机条件不适用。`,
  ]
  if (privateFollowup)
    reports.push(
      `H21 高温连续运行试验记录 ${mark}-HOT：第 6 小时探头读数漂移 4°C，超过 2°C 的容差。常温短测的结论不能覆盖此工况。`,
    )
  writeFileSync(archive, JSON.stringify(reports))
  const history: { attempt: number; id: number; instruction: string; previous: string[] }[] = []
  const trace = createRouterTraceSink(store.ledger, (text) => deps.secretFilter.filter(text))
  const principals = new RouterJobPrincipals(store, { accessKey: () => null })
  const denied = async (): Promise<never> => {
    throw Error('Unexpected built-in executor or external delivery')
  }
  const target = {
    platform: 'dingtalk' as const,
    channelId: 'review-bot',
    peerId: 'owner',
    operatorId: 'owner',
    label: '测试私聊',
  }
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: denied,
    weixin: { listTargets: () => [], send: denied },
    ...(privateFollowup && {
      personal: {
        listPersonalBots: () => [{ ...target, online: true }],
        listPersonalTargets: () => [target],
        listPersonalDirectTargets: () => [target],
        sendPersonal: denied,
        sendDirect: async () => ({ status: 'accepted' as const, receipt: 'fixture-receipt' }),
      },
    }),
  })
  if (privateFollowup) {
    const config = routing.getConfig()
    routing.saveConfig(
      { ...config.settings, enabled: true, personalBots: { dingtalk: target.channelId } },
      config.revision,
    )
    assert(routing.claimRouterImTarget(target))
  }
  const jobs = new RouterJobs(store.jobs, {
    trace,
    authorized: principals.authorized.bind(principals),
    execute: denied,
    executors: [
      {
        name: 'records',
        description:
          '检索设备档案站的索引、制造商通告及维护记录，可按同一核查线程补读下一份原始材料。',
        async execute(job, steps) {
          const pages = JSON.parse(readFileSync(archive, 'utf8')) as string[]
          history.push({
            id: job.id,
            attempt: job.attempt,
            instruction: job.instruction,
            previous: steps.filter((s) => s.attempt < job.attempt).map((s) => s.result ?? ''),
          })
          const result = pages[job.attempt - 1]
          return {
            result: result ?? exhausted,
            threadId: 'records-H21',
          }
        },
      },
    ],
    completed: async (job) => {
      const link = store.ledger.workerLink(job.id)
      assert(link)
      store.ledger.receiveSignal({
        principal: 'router-owner',
        scope: 'general',
        key: `worker:${job.id}:${job.attempt}`,
        kind: 'worker_result',
        payload: {
          jobId: job.id,
          attempt: job.attempt,
          matterId: link.matterId,
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
      getCurrentModel: () => deps.modelRouter.getCurrentModel(),
      getDefaultModel: () => deps.modelRouter.getDefaultModel(),
      trace,
    },
  })
  const service = new RouterWorkspaceService(store, routing, ask, {
    principalFor: () => 'router-owner',
    principals,
    delegatedJobs: jobs,
    agentIntake: true,
  })
  jobs.start()
  service.start()
  try {
    const objective = `核查设备 H21 是否适用停机通告。需要有出处的结论，结果给我放在${privateFollowup ? '网页和钉钉' : '网页'}。`
    await service.message('general', crypto.randomUUID(), objective)
    for (let i = 0; i < 2400; i++) {
      const pending = audit
        .query(
          "SELECT 1 FROM router_signals WHERE state IN ('pending','running') UNION ALL SELECT 1 FROM router_job_steps WHERE status IN ('queued','running') OR return_state IN ('pending','sending') LIMIT 1",
        )
        .get()
      if (!pending || history.length > 5) break
      await Bun.sleep(250)
    }
    const [matter] = store.ledger.searchMatters('router-owner')
    assert(matter)
    const publications = store.ledger.publications.list('router-owner', matter.id)
    const signals = audit
      .query<{ id: number; state: string; attempt: number }, []>(
        "SELECT id,state,json_extract(payload,'$.attempt') AS attempt FROM router_signals WHERE kind='worker_result' ORDER BY id",
      )
      .all()
    const turns = signals.map((s) => store.conversations.get('general', `signal-${s.id}`))
    const proof = {
      objective,
      matter: matter.id,
      state: matter.state,
      history,
      signals,
      answers: turns.map((t) => t?.answer?.text),
      publications: publications.flatMap((p) =>
        p.deliveries
          .filter((d) => d.channel === 'web' && d.status === 'accepted')
          .map((d) => d.presentation.text),
      ),
      marker: mark,
    }
    writeFileSync(join(output, 'worker-review.json'), JSON.stringify(proof, null, 2))
    assert.equal(history.length, 3)
    assert.equal(new Set(history.map((h) => h.id)).size, 1)
    assert.deepEqual(
      signals.map((s) => [s.attempt, s.state]),
      [
        [1, 'completed'],
        [2, 'completed'],
        [3, 'completed'],
      ],
    )
    assert.deepEqual(history[2].previous, reports.slice(0, 2))
    assert(/B17|通告|原始|一手/.test(history[1].instruction))
    assert(/R4|固件|装配|维护/.test(history[2].instruction))
    const final = proof.answers.at(-1) ?? ''
    if (missingSite) {
      assert(
        matter.state === 'waiting' &&
          /版本/.test(final) &&
          /请|提供|告诉|读取/.test(final) &&
          /固件/.test(final),
      )
    } else {
      assert(
        matter.state === 'completed' &&
          proof.publications.some((text) => text.includes(mark) && /不适用|不需要|无需/.test(text)),
      )
    }
    if (privateFollowup) {
      assert(
        publications.some((p) =>
          p.deliveries.some((d) => d.channel === 'dingtalk' && d.status === 'accepted'),
        ),
      )
      const question = '这个结论用在高温连续运行时也合适吗？会不会带来其他问题？'
      const reply = await service.handleIm(
        {
          ...target,
          actorId: target.operatorId,
          isDirect: true,
          text: question,
          messageId: crypto.randomUUID(),
        },
        routing.claimRouterImTarget(target)!,
      )
      for (let i = 0; i < 2400; i++) {
        if (
          !audit
            .query(
              "SELECT 1 FROM router_signals WHERE state IN ('pending','running') UNION ALL SELECT 1 FROM router_job_steps WHERE status IN ('queued','running') OR return_state IN ('pending','sending') LIMIT 1",
            )
            .get()
        )
          break
        await Bun.sleep(250)
      }
      const updated = store.ledger.publications.list('router-owner', matter.id)
      const proof = {
        question,
        reply,
        history,
        deliveries: updated.flatMap((p) =>
          p.deliveries.filter((d) => d.channel === 'dingtalk').map((d) => d.presentation.text),
        ),
      }
      writeFileSync(join(output, 'worker-im-followup.json'), JSON.stringify(proof, null, 2))
      assert(history.some((step) => step.attempt > 3 && /高温|连续运行/.test(step.instruction)))
      assert(!history.some((step) => step.previous.includes(exhausted)), '档案已查尽后重复派工')
      assert.equal(new Set(history.map((h) => h.id)).size, 1)
      assert(
        proof.deliveries.some(
          (text) => text.includes(`${mark}-HOT`) && /4\s*°?C|4\s*度/.test(text),
        ),
      )
    }
  } finally {
    await service.close()
    await jobs.close()
    await routing.close()
    store.close()
    audit.close()
  }
}
