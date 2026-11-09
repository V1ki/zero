import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TriggerStore } from '@zero-os/observe'
import type { AgentDependencies } from '../../apps/server/src/triggers/event-agent'
import { createRouterAgent } from '../../apps/server/src/triggers/router-agent'
import { RouterJobPrincipals } from '../../apps/server/src/triggers/router-job-principal'
import { RouterJobs } from '../../apps/server/src/triggers/router-jobs'
import { createRouterTraceSink } from '../../apps/server/src/triggers/router-trace'
import { RouterWorkspaceService } from '../../apps/server/src/triggers/router-workspace'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'
import { createTaskBridge } from '../../apps/server/src/triggers/task-bridge'

/** Actual Router and queue. Only the ingress transport, source reader and measuring instrument are fixtures. */
export async function verifyUnifiedEntrypoints(output: string, deps: AgentDependencies) {
  const file = join(output, 'workspace.sqlite')
  assert(!existsSync(file), 'Use a fresh output directory')
  const store = new TriggerStore(file)
  const principal = 'router-owner'
  const repo = 'example/lab'
  const owner = {
    platform: 'weixin' as const,
    channelId: 'fixture',
    peerId: 'operator',
    operatorId: 'operator',
  }
  const denied = async (): Promise<never> => {
    throw Error('Unexpected external operation')
  }
  const targets = [{ ...owner, label: '隔离验收' }]
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: denied,
    weixin: { listTargets: () => [], send: denied },
    personal: {
      listPersonalBots: () => targets.map((t) => ({ ...t, online: true })),
      listPersonalTargets: () => targets,
      listPersonalDirectTargets: () => targets,
      sendPersonal: denied,
    },
  })
  const config = routing.getConfig()
  routing.saveConfig(
    { ...config.settings, personalBots: { weixin: owner.channelId } },
    config.revision,
  )
  store.useAgentIntake()
  const revision = store.saveSettings(
    {
      github: {
        credentialRef: 'github_listener_fixture',
        routerOperators: [owner],
        repositories: [
          {
            name: repo,
            enabled: true,
            workflowFailures: true,
            workflow: '',
            branch: '',
            mention: '',
          },
        ],
      },
      wxarc: { sessions: [] },
    },
    0,
  )
  const principals = new RouterJobPrincipals(store, { accessKey: () => 'fixture-repository' })
  const specimen = join(output, 'readings.json')
  const readings = process.env.ZERO_ACCEPTANCE_SAMPLE === 'above' ? [17, 22, 17] : [17, 18, 17]
  writeFileSync(specimen, JSON.stringify({ batch: 'Q42', unit: 'mV', readings }))
  const jobs = new RouterJobs(store.jobs, {
    authorized: principals.authorized.bind(principals),
    execute: async () => {
      const raw = readFileSync(specimen, 'utf8')
      const { readings, unit } = JSON.parse(raw) as { readings: number[]; unit: string }
      return {
        result: `原始仪器文件 readings.json：${raw}。三次测量中峰值 ${Math.max(...readings)} ${unit}。`,
      }
    },
    completed: async (job) => {
      const link = store.ledger.workerLink(job.id)
      assert(link)
      store.ledger.receiveSignal({
        principal,
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
      service.notifySignals()
      return 'delivered'
    },
  })
  const ask = createRouterAgent({
    ...deps,
    modelRouter: {
      ...deps.modelRouter,
      trace: createRouterTraceSink(store.ledger, (s) => deps.secretFilter.filter(s)),
    },
  })
  const service = new RouterWorkspaceService(store, routing, ask, {
    principalFor: (actor) =>
      actor === 'web' ||
      (actor.channelId === owner.channelId && actor.operatorId === owner.operatorId)
        ? principal
        : null,
    principals,
    agentIntake: true,
    delegatedJobs: jobs,
    investigator: {
      available: () => ['inspect_github'],
      inspect: async (event) => ({
        kind: 'issue',
        observedAt: event.receivedAt,
        sourceUrl: event.url!,
        facts: [{ label: '该批次的核定限值', value: 'Q42 的上限为 20 mV，含 20。' }],
      }),
    },
  })
  const bridge = createTaskBridge({
    store,
    agent: denied,
    isLiveTarget: () => false,
    isPersonalTarget: (t) => routing.isPersonalTarget(t),
    personalDialog: {
      authorize: (t) => routing.claimRouterImTarget(t),
      handle: (m, authorized) => service.handleIm(m, authorized),
    },
  })
  async function waitFor(kind: 'event' | 'worker_result' | 'ui_action') {
    const until = Date.now() + 180_000
    for (;;) {
      const signal = store.ledger
        .listSignals(principal)
        .reverse()
        .find((x) => x.kind === kind)
      if (signal && !['pending', 'running'].includes(signal.state)) {
        assert.equal(signal.state, 'completed', signal.error ?? kind)
        return
      }
      if (Date.now() > until) throw Error('Timed out observing ' + kind)
      await Bun.sleep(200)
    }
  }
  try {
    service.start()
    await service.message(
      'general',
      crypto.randomUUID(),
      '请帮我跟进 Q42 的检验。先记下待办：等仪器峰值和批次限值都齐了，比较两者，只在网页交付结论并给我一个“确认收下”的按钮。在我点之前保留这件事。当前没有数据。',
    )
    const matters = store.ledger.searchMatters(principal)
    assert.equal(matters.length, 1)
    const matter = matters[0]
    const response = await bridge.handle({
      ...owner,
      actorId: owner.operatorId,
      messageId: 'im-dispatch',
      isDirect: true,
      text: '继续 Q42。现在仪器记录在检验员手上，请安排检验员读取 readings.json 的三次测量，拿到峰值。限值稍后会从仓库记录送来，交付仍只放网页。',
    })
    assert(response.handled && response.reply, 'Expected the selected IM bot to answer')
    assert(store.ledger.workerSessions(principal, matter.id).length, 'Missing agent delegation')
    await waitFor('worker_result')
    assert(
      store.commitPush({
        source: 'github',
        stream: `github:${repo}`,
        revision,
        events: [
          {
            eventId: '31:run:10:1:failure',
            scope: repo,
            title: 'Q42 批次限值记录已到',
            summary: '检验员已上传 Q42 的限值，请从原文核对。',
            url: 'https://github.com/example/lab/actions/runs/10',
            occurredAt: new Date().toISOString(),
          },
        ],
      }),
    )
    service.notifySignals()
    await waitFor('event')
    const publication = store.ledger.publications
      .list(principal, matter.id)
      .find(
        (p) =>
          p.matterVersion === store.ledger.getMatter(principal, matter.id)?.version &&
          p.deliveries.some((d) => d.channel === 'web' && d.presentation.actions.length),
      )
    assert(publication, 'Missing actionable web delivery for the current version')
    const web = publication.deliveries.find((d) => d.channel === 'web')!
    assert(
      web.status === 'accepted' &&
        web.presentation.text.includes(String(Math.max(...readings))) &&
        web.presentation.text.includes('20'),
    )
    const action = web.presentation.actions.find((a) => a.label.includes('确认收下'))
    assert(action, 'Missing requested action')
    service.webPublicationAction(publication.id, action.id, crypto.randomUUID())
    await waitFor('ui_action')
    const runs = store.ledger.listRuns({ limit: 50 }).map((run) => {
      const entries = store.ledger.entries(run.id)
      const raw = entries.find((e) => e.kind === 'input')?.data as {
        prompt: string
        context: { platform: string }
      }
      const prompt = JSON.parse(raw.prompt)
      const requests = entries.filter((e) => e.kind === 'model_request')
      assert(requests.length && prompt.contextProvenance.principal === principal)
      const tools = entries
        .filter((e) => e.kind === 'tool_start')
        .map((e) => (e.data as { name: string }).name)
      return {
        id: run.id,
        kind: prompt.signal.kind,
        platform: raw.context.platform,
        entry: prompt.scope,
        requests: requests.length,
        status: run.status,
        tools,
      }
    })
    const required = [
      ['general', 'user'],
      ['weixin', 'user'],
      ['event', 'event'],
      ['general', 'worker_result'],
      [publication.scope === 'general' ? 'general' : 'event', 'ui_action'],
    ]
    for (const [entry, kind] of required)
      assert(
        runs.some((r) => r.entry === entry && r.kind === kind && r.status === 'completed'),
        `${entry}/${kind}`,
      )
    assert(
      runs
        .filter((r) => r.kind === 'user' || r.kind === 'ui_action')
        .every((r) => r.platform === (r.entry === 'weixin' ? 'weixin' : 'web')),
    )
    assert(
      runs.filter((r) => r.kind === 'worker_result').every((r) => r.platform === 'worker_result'),
    )
    assert(runs.filter((r) => r.kind === 'event').every((r) => r.platform === 'github'))
    assert(runs.some((r) => r.entry === 'weixin' && r.tools.includes('delegate_task')))
    assert(runs.some((r) => r.kind === 'event' && r.tools.includes('read_source')))
    assert(runs.some((r) => r.kind === 'worker_result' && r.tools.includes('get_task_status')))
    const final = store.ledger.getMatter(principal, matter.id)
    assert.equal(final?.state, 'completed')
    const proof = {
      mode: 'isolated-real-model-fixture-source-worker',
      matterId: matter.id,
      runs,
      publicationId: publication.id,
      readings,
      webText: web.presentation.text,
      action: action.label,
      versions: store.ledger.matterHistory(principal, matter.id),
      workerSessions: store.ledger.workerSessions(principal, matter.id),
    }
    writeFileSync(join(output, 'observations.json'), JSON.stringify(proof, null, 2))
    assert.equal(
      runs.filter((r) => r.kind === 'worker_result').length,
      1,
      'The instrument returned all requested readings. Waiting for the repository must not trigger another measurement.',
    )
    console.log(JSON.stringify({ runs, action: action.label, state: final.state }))
  } finally {
    await service.close()
    await bridge.close()
    await routing.close()
    store.close()
  }
}
