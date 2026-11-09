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
import { captureProvider } from './provider-witness'

/** Use a dated GitHub snapshot and the corresponding real verification report for an independent comparison. */
export async function verifyNarrative(output: string, deps: AgentDependencies) {
  const input = process.env.ZERO_ACCEPTANCE_NARRATIVE_INPUT
  assert(input, 'Provide the GitHub snapshot and Worker report')
  const raw = readFileSync(input, 'utf8')
  const source = JSON.parse(raw) as {
    observedAt: string
    workerObservedAt: string
    appReadback: { observedAt: string; mergeAllowed: boolean }
    repository: string
    pullRequests: Array<{ number: number; files: string[]; state: string; url: string }>
    workerReport: string
  }
  assert(
    source.pullRequests.find((p) => p.number === 145)?.files.every((file) => file.endsWith('.md')),
  )
  assert(
    source.pullRequests
      .filter((p) => p.number !== 145)
      .every((p) => p.files.some((file) => !file.endsWith('.md'))),
  )
  assert(source.pullRequests.every((p) => p.state === 'open'))
  assert(
    source.appReadback.mergeAllowed &&
      Date.parse(source.appReadback.observedAt) > Date.parse(source.workerObservedAt),
  )
  const store = new TriggerStore(join(output, 'workspace.sqlite'))
  const owner = 'router-owner'
  const matter = store.ledger.createMatter(
    owner,
    '仓库候选核对',
    '依据审查记录比较候选并回答相应追问',
    ['给出有证据的筛选和部分完成状态'],
  )
  const principals = new RouterJobPrincipals(store, { accessKey: () => null })
  const witness = captureProvider(deps)
  const trace = createRouterTraceSink(store.ledger, (t) => deps.secretFilter.filter(t))
  const recorded: { channel: string; text: string }[] = []
  const platforms = ['weixin', 'dingtalk', 'feishu'] as const
  const bots = platforms.map((platform) => ({
    platform,
    channelId: platform + '-fixture',
    peerId: 'owner',
    operatorId: 'owner',
    label: '验收私聊',
  }))
  const forbidden = async (): Promise<never> => {
    throw Error('unexpected external effect')
  }
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: forbidden,
    weixin: { listTargets: () => [], send: forbidden },
    personal: {
      listPersonalBots: () => bots.map((b) => ({ ...b, online: true })),
      listPersonalDirectTargets: () => bots,
      listPersonalTargets: () => bots,
      sendPersonal: forbidden,
      async sendDirect(target, text, _id, _signal, allowed, presentation) {
        assert(allowed() && presentation)
        assert.equal(text, presentation.text)
        recorded.push({ channel: target.platform, text })
        return { status: 'accepted', receipt: 'fixture-' + recorded.length }
      },
    },
  })
  const config = routing.getConfig()
  routing.saveConfig(
    {
      ...config.settings,
      enabled: true,
      personalBots: Object.fromEntries(bots.map((b) => [b.platform, b.channelId])),
    },
    config.revision,
  )
  for (const bot of bots) assert(routing.claimRouterImTarget(bot))
  const jobs = new RouterJobs(store.jobs, {
    trace,
    authorized: principals.authorized.bind(principals),
    execute: async () => ({ result: raw, threadId: 'read-only-evidence' }),
    completed: async () => 'delivered',
  })
  const ask = createRouterAgent({
    ...deps,
    modelRouter: {
      getDefaultModel: () => witness.model,
      getCurrentModel: () => witness.model,
      trace,
    },
  })
  const service = new RouterWorkspaceService(store, routing, ask, {
    principalFor: () => owner,
    principals,
    delegatedJobs: jobs,
    agentIntake: true,
  })
  service.start()
  jobs.start()
  try {
    const audience = principals.capture('web', false)
    const job = jobs.submit(
      'general',
      'evidence',
      {
        executor: 'zero',
        audience,
        instruction: '读取已固定的 GitHub 文件清单和候选验证原始记录。',
      },
      (j) =>
        store.ledger.bindWorker({
          jobId: j.id,
          matterId: matter.id,
          principal: owner,
          scope: 'general',
          audience,
          eventIds: [],
          authority: 'user',
        }),
    )
    for (let i = 0; i < 1000 && store.jobs.get('general', job.id)?.status !== 'completed'; i++)
      await Bun.sleep(10)
    assert.equal(store.jobs.get('general', job.id)?.result, raw)
    const cases = [
      '对照已有的仓库候选核对记录，#145、#163、#185 中只列出纯文档 PR，给我来源链接和当时的合并状态。这份筛选结果同步给我。',
      '继续刚才的核对：比较 #145 的目录未加载和已加载两种情况，各有多少次宿主请求？另说明 #163 本地验证到哪一步，结合较新的权限回读，现有记录里还差什么才能远端合并。把这次比较也同步给我。',
    ]
    const results = []
    for (const question of cases) {
      const previous = new Set(store.ledger.publications.list(owner).map((p) => p.id))
      const initial = recorded.length
      const answer = (await service.message('general', crypto.randomUUID(), question)).turns.at(
        -1,
      )?.answer
      assert(answer)
      const publications = store.ledger.publications.list(owner).filter((p) => !previous.has(p.id))
      assert.equal(publications.length, 1, 'expected one new publication for the request')
      const publication = publications[0]
      assert.equal(publication.deliveries.length, 4)
      for (const d of publication.deliveries) assert.equal(d.status, 'accepted')
      const bodies = Object.fromEntries(
        publication.deliveries.map((d) => [d.channel, d.presentation.text]),
      )
      for (const packet of recorded.slice(initial))
        assert.equal(bodies[packet.channel], packet.text)
      results.push({
        question,
        text: answer.text,
        tools: answer.toolSteps,
        pub: publication.id,
        bodies,
      })
      writeFileSync(
        join(output, 'narratives.json'),
        JSON.stringify({ observedAt: source.observedAt, results }, null, 2),
      )
    }
    for (const text of [results[0].text, ...Object.values(results[0].bodies)]) {
      assert(text.includes('#145') && text.includes('/pull/145') && /未|尚|开放|待合/.test(text))
      assert(
        !/^[^\n]*(?:#163|#185)[^\n]*(?:\.ts|链接|https)/mu.test(text),
        'a code PR was returned instead of the filtered selection',
      )
    }
    for (const text of [results[1].text, ...Object.values(results[1].bodies)]) {
      assert(
        /未加载|冷|首次/.test(text) &&
          /[1一]\s*次/.test(text) &&
          /[0零]\s*次|无额外|不再.*请求/.test(text),
      )
      assert(
        text.includes('#163') &&
          /(?:未|尚|没有|待|无).{0,12}(?:合并|推送|落地)|仍开放|merged_at\s*=\s*null|满足后才能合并/.test(
            text,
          ),
        'missing remote status',
      )
      assert(
        /mergeAllowed\s*[:=]?\s*true|(?:权限|合并权).{0,10}(?:恢复|具备|已开|允许)|(?:已有|具备|恢复|已获|允许).{0,10}(?:权限|合并|写入)/i.test(
          text,
        ),
        'missing newer permission evidence',
      )
      assert(
        /原分支|分支.{0,10}更新|远端.{0,10}(?:提交|head)|head.{0,10}候选/i.test(text),
        'missing candidate head condition',
      )
    }
  } finally {
    await service.close()
    await jobs.close()
    await routing.close()
    store.close()
  }
}
