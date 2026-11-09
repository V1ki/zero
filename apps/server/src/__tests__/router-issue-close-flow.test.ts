import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TriggerStore } from '@zero-os/observe'
import { createGithubIssueCloser } from '../triggers/github-issue-close'
import { createRouterEventWorker } from '../triggers/router-event-worker'
import { jobReply } from '../triggers/router-work-reply'
import { RouterJobPrincipals } from '../triggers/router-job-principal'
import { RouterJobs } from '../triggers/router-jobs'
import { RouterWorkspaceService } from '../triggers/router-workspace'
import { TriggerRoutingRuntime } from '../triggers/routing-runtime'

function required<T>(item: T | null | undefined) {
  if (item == null) throw new Error('Expected a fixture record')
  return item
}

test('a close request made on the bot reply continues the earlier issue worker, never the cited issue, even on replay after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'zero-close-original-issue-'))
  const name = 'fixture/repo'
  const root = `https://api.github.com/repos/${name}`
  const web = `https://github.com/${name}`
  const url = `${web}/issues/181`
  const reference = `${web}/issues/159#issuecomment-16`
  const denied = async (): Promise<never> => {
    throw new Error('Unexpected external operation')
  }
  let state = 'open'
  const methods: string[] = []
  const auth = { getCommentAccess: async () => ({ token: 'fixture', botLogin: 'test[bot]' }) }
  const github = async (target: URL, init: RequestInit) => {
    const method = init.method ?? 'GET'
    methods.push(`${method} ${target.pathname}`)
    if (target.href === root && method === 'GET') return Response.json({ id: 35, full_name: name })
    expect(target.href).toBe(`${root}/issues/181`)
    if (method === 'PATCH') {
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fixture')
      expect(JSON.parse(String(init.body))).toEqual({ state: 'closed' })
      state = 'closed'
    } else expect(method).toBe('GET')
    return Response.json({
      id: 4097,
      number: 181,
      state,
      state_reason: state === 'closed' ? 'completed' : null,
      url: target.href,
      repository_url: root,
      html_url: url,
      closed_at: state === 'closed' ? '2026-03-13T07:00:00Z' : null,
    })
  }
  function setup(fresh = false) {
    const store = new TriggerStore(join(directory, 'inbox.sqlite'))
    const principals = new RouterJobPrincipals(store, {
      accessKey: () => store.getRouterGithubGrant('web')?.credentialRef ?? null,
    })
    if (fresh) {
      store.saveSettings(
        {
          github: {
            credentialRef: 'github_listener_fixture',
            routerTrackingEnabled: true,
            repositories: [
              {
                name,
                enabled: true,
                issues: true,
                issueComments: true,
                githubAppRef: 'github_app_fixture',
                workflowFailures: false,
                mention: '',
                workflow: '',
                branch: '',
              },
            ],
          },
          wxarc: { sessions: [] },
        },
        0,
      )
      const grant = store.tracking.grant('web')
      if (!grant) throw new Error('Missing fixture grant')
      const audience = principals.capture('web', true)
      store.tracking.start({
        actor: 'web',
        scope: 'general',
        repository: name,
        issues: true,
        pullRequests: false,
        issueComments: true,
        ownerAudience: audience,
        audience,
        expectedGrantGeneration: grant.generation,
        requestId: 'start',
      })
      const receive = (id: number, summary: string) => {
        expect(
          store.commitPush({
            source: 'github',
            stream: `github:${name}`,
            revision: store.getSettings().revision,
            events: [
              {
                scope: name,
                eventId: `35:comment:${id}`,
                title: 'Issue #181 · 新评论',
                summary,
                url: `${url}#issuecomment-${id}`,
                occurredAt: new Date(Date.now() + 1000 + id).toISOString(),
                githubCommentKind: 'issue-comment',
              },
            ],
          }),
        ).toBe(true)
      }
      receive(99, 'owner：请找一下相关的历史 issue')
      const base = required(store.jobs.claimNext())
      expect(
        store.jobs.finish(base.id, base.attempt, { status: 'completed', result: '只做了摘要' }),
      ).toBe(true)
      const source = required(store.tracking.eventForJob(base.id, base.attempt))
      const resumed = required(
        store.tracking.continueIssueWork(
          source.inboxId,
          'previous-work',
          '帮我查 pnpm 历史问题',
          () => true,
        ),
      )
      expect(resumed.id).toBe(base.id)
      const work = required(store.jobs.claimNext())
      expect(
        store.jobs.finish(work.id, work.attempt, {
          status: 'completed',
          result: '旧评论提供线索，尚未确认当前故障也是这个原因。',
          work: {
            outcome: 'resolved',
            steps: [{ tool: 'find_related_issues', ok: true }],
            sources: [{ label: 'Issue #159 原评论', url: reference }],
          },
        }),
      ).toBe(true)
      receive(100, `test[bot]：之前的讨论在 ${reference}，不能以此证实本次原因。`)
      const observation = required(store.jobs.claimNext())
      expect(observation).toMatchObject({ id: work.id, attempt: 3 })
      expect(
        store.jobs.finish(observation.id, observation.attempt, {
          status: 'completed',
          result: '收到机器人的评论',
          work: { outcome: 'observed', sources: [], steps: [] },
        }),
      ).toBe(true)
    }
    const reads = () => store.getSettings()
    const tracking = createRouterEventWorker(
      {
        secretFilter: { filter: (s: string) => s },
        modelRouter: { getCurrentModel: () => undefined, getDefaultModel: () => undefined },
      },
      store.tracking,
      {
        investigator: { available: () => [], inspect: denied },
        closeIssue: createGithubIssueCloser(reads, auth, github),
      },
    )
    const jobs = new RouterJobs(store.jobs, {
      tracking,
      authorized: principals.authorized.bind(principals),
      execute: denied,
      completed: async () => 'delivered',
    })
    const routing = new TriggerRoutingRuntime(store.routing, {
      analyze: denied,
      weixin: { listTargets: () => [], send: denied },
    })
    const service = new RouterWorkspaceService(
      store,
      routing,
      async (input, signal) => {
        if (input.question !== '关闭 这个 issue .') return { text: '未进行任何操作。' }
        const job = await required(input.actions?.continueTask)(
          required(input.trackingResult).id,
          required(signal),
          input.question,
        )
        return { text: jobReply(job) }
      },
      { principals, delegatedJobs: jobs },
    )
    service.start()
    return {
      store,
      service,
      async close() {
        await service.close()
        await routing.close()
        store.close()
      },
    }
  }
  let system = setup(true)
  try {
    const [bot, original] = system.store.listInbox()
    const primary = required(system.store.tracking.resultForEvent(original.id, () => true))
    const observed = required(system.store.tracking.resultForEvent(bot.id, () => true))
    expect(primary).toMatchObject({
      attempt: 2,
      work: { outcome: 'resolved', sources: [{ url: reference }] },
    })
    expect(observed).toMatchObject({ id: primary.id, attempt: 3, work: { outcome: 'observed' } })
    // A referenced issue and a question about closure are not authority to mutate the current one.
    for (const message of ['之前为什么没关闭这个 issue？', '关闭参考资料里的 #159']) {
      await system.service.message(bot.id, crypto.randomUUID(), message)
    }
    expect(methods).toEqual([])
    expect(system.store.jobs.get('general', primary.id)?.attempt).toBe(3)
    const requestId = crypto.randomUUID()
    const command = '关闭 这个 issue .'
    const started = await system.service.message(bot.id, requestId, command)
    expect(started.trackingResult).toMatchObject({ id: primary.id, attempt: 4 })
    for (let i = 0; i < 100; i++) {
      if (
        !['queued', 'running'].includes(system.store.jobs.get('general', primary.id)?.status ?? '')
      )
        break
      await Bun.sleep(10)
    }
    const result = system.service.get(bot.id)
    expect(result.trackingResult).toMatchObject({
      id: primary.id,
      attempt: 4,
      status: 'completed',
      work: { outcome: 'resolved' },
    })
    expect(result.trackingResult?.work?.steps).toContainEqual({ tool: 'close_issue', ok: true })
    expect(result.trackingResult?.work?.sources.map((source) => source.url)).toContain(url)
    expect(result.turns.find((t) => t.requestId === requestId)?.answer?.text).toContain('已关闭')
    expect(system.store.jobs.get('general', observed.id, 3)?.work?.outcome).toBe('observed')
    expect(system.store.jobs.get('general', primary.id, 2)?.work?.sources[0].url).toBe(reference)
    await system.close()
    system = setup()
    const replay = await system.service.message(bot.id, requestId, command)
    expect(replay.trackingResult).toMatchObject({ id: primary.id, attempt: 4, status: 'completed' })
    expect(replay.turns.filter((turn) => turn.requestId === requestId)).toHaveLength(1)
    expect(state).toBe('closed')
    expect(methods.filter((m) => m.startsWith('PATCH '))).toEqual([
      `PATCH /repos/${name}/issues/181`,
    ])
    expect(methods.slice(methods.indexOf(`PATCH /repos/${name}/issues/181`) + 1)).toContain(
      `GET /repos/${name}/issues/181`,
    )
    expect(methods.some((m) => m.includes('/issues/159'))).toBe(false)
  } finally {
    await system.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
