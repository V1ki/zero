import { expect, test } from 'bun:test'
import { createHmac, randomUUID } from 'node:crypto'
import type { ProviderAdapter } from '@zero-os/model'
import { TriggerStore } from '@zero-os/observe'
import { githubWorkflowFollowupSubject } from '@zero-os/shared'
import { createGithubInvestigator } from '../triggers/investigation'
import { acceptRepositoryWebhook } from '../triggers/repository-webhook'
import { createRouterEventWorker } from '../triggers/router-event-worker'
import { createRouterJobDelivery } from '../triggers/router-job-delivery'
import { RouterJobPrincipals } from '../triggers/router-job-principal'
import { RouterJobs } from '../triggers/router-jobs'
import { createRouterRepositoryLookup } from '../triggers/router-repositories'
import { TriggerRoutingRuntime } from '../triggers/routing-runtime'

test('signed Actions failures prompt a private investigation and another attempt continues the same Worker', async () => {
  const store = new TriggerStore(':memory:')
  const name = 'private-fixture/build'
  const repository = { id: 7, full_name: name, private: true }
  const at = new Date(Date.now() + 2000).toISOString()
  const run = (attempt: number) => ({
    repository,
    head_repository: repository,
    id: 51,
    run_attempt: attempt,
    run_number: 11,
    workflow_id: 4,
    name: 'Build',
    path: '.github/workflows/build.yml',
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'failure',
    created_at: at,
    updated_at: at,
  })
  const filter = (text: string) => text
  const resolveSecret = (ref: string) =>
    ref === 'github_listener_fixture' ? 'fixture-read' : undefined
  const reads: string[] = []
  async function readGithub(url: URL, init: RequestInit) {
    expect(init.method ?? 'GET').toBe('GET')
    expect(url.origin).toBe('https://api.github.com')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fixture-read')
    expect(init.redirect).toBe('manual')
    const base = `/repos/${name}`
    reads.push(url.pathname)
    if (url.pathname === base) return Response.json(repository)
    for (const attempt of [1, 2]) {
      const path = `${base}/actions/runs/51/attempts/${attempt}`
      if (url.pathname === path) return Response.json(run(attempt))
      if (url.pathname === `${path}/jobs`) {
        return Response.json({
          total_count: 1,
          jobs: [
            {
              id: 99,
              run_id: 51,
              run_attempt: attempt,
              name: 'release',
              conclusion: 'failure',
              steps: [{ number: 3, name: 'npm publish', conclusion: 'failure' }],
            },
          ],
        })
      }
    }
    if (url.pathname === `${base}/actions/jobs/99/logs`)
      return new Response('##[error]Process completed with exit code 1.')
    if (url.pathname === `${base}/actions/workflows/4/runs`)
      return Response.json({ workflow_runs: [] })
    throw Error(`Unexpected GitHub read: ${url.pathname}`)
  }

  const triage: string[] = []
  const workers: string[] = []
  const firstResult = '已核实 release 作业的第 3 步 npm publish 失败。'
  const adapter: ProviderAdapter = {
    apiType: 'test',
    healthCheck: async () => true,
    stream() {
      throw Error('Unexpected stream')
    },
    async complete(req) {
      const session = req.meta?.sessionId ?? ''
      const envelope = { id: 'fixture', model: 'fixture', usage: { input: 1, output: 1 } }
      const done = (data: object) => ({
        ...envelope,
        stopReason: 'end_turn' as const,
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      })
      if (session.startsWith('router-followup-triage-')) {
        triage.push(session)
        expect(req.tools ?? []).toHaveLength(0)
        return done({ decision: 'act', reason: '需要核实发布失败的步骤。' })
      }
      const prompt = JSON.stringify(req.messages)
      const second = prompt.includes('第 2 次运行')
      if (req.messages.at(-1)?.content[0]?.type !== 'tool_result') {
        workers.push(session)
        if (second) expect(prompt).toContain(firstResult)
        const tool = second ? 'compare_runs' : 'inspect_github'
        expect(req.tools?.map((t) => t.name)).toContain(tool)
        return {
          ...envelope,
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'q', name: tool, input: {} }],
        }
      }
      expect(prompt).toContain(second ? '同一次运行的上一次尝试' : '步骤 3 · npm publish')
      return done({
        outcome: 'resolved',
        attentionQuestion: null,
        result: second ? '同一运行的两次尝试都失败，已有 GitHub 对比记录。' : firstResult,
      })
    },
  }
  const repo = {
    name,
    enabled: true,
    workflow: 'Build',
    branch: 'main',
    mention: '',
    workflowFailures: true,
    deliveryMode: 'webhook' as const,
    webhookSecretRef: 'github_webhook_fixture',
    ciWebhookSecretRef: 'ci_webhook_fixture',
  }
  store.saveSettings(
    {
      github: {
        credentialRef: 'github_listener_fixture',
        repositories: [repo],
      },
      wxarc: { sessions: [] },
    },
    0,
  )
  const policy = store.routing.getSettings()
  store.routing.saveSettings({ ...policy.settings, enabled: true }, policy.revision)
  const deps = {
    modelRouter: { getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined },
    secretFilter: { filter },
  }
  const investigator = createGithubInvestigator(
    () => store.getSettings(),
    resolveSecret,
    filter,
    readGithub,
  )
  const worker = createRouterEventWorker(deps, store.tracking, { investigator })
  const lookup = createRouterRepositoryLookup(
    (actor) => store.getRouterGithubGrant(actor),
    resolveSecret,
    readGithub,
  )
  const principals = new RouterJobPrincipals(store, lookup)
  store.tracking.setWorkflowAudience(() => principals.current('web', true))
  let sends = 0
  const unexpectedSend = async (): Promise<never> => {
    sends++
    throw Error('Worker attempted an extra outbound delivery')
  }
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: unexpectedSend,
    weixin: { listTargets: () => [], send: unexpectedSend },
  })
  const delivery = createRouterJobDelivery(
    routing,
    worker.authorized,
    undefined,
    unexpectedSend,
    (job) => {
      const event = store.tracking.eventForJob(job.id, job.attempt)?.event
      return !!event && !!githubWorkflowFollowupSubject(event)
    },
  )
  const jobs = new RouterJobs(store.jobs, {
    authorized: principals.authorized.bind(principals),
    tracking: worker,
    execute() {
      throw Error('Unexpected general executor')
    },
    completed: delivery,
  })
  jobs.start()
  async function send(provider: 'github' | 'ci', payload: object) {
    const body = JSON.stringify(payload)
    const ref = provider === 'github' ? repo.webhookSecretRef : repo.ciWebhookSecretRef
    const signature = `sha256=${createHmac('sha256', ref).update(body).digest('hex')}`
    const response = await acceptRepositoryWebhook(
      provider,
      name,
      new Request('http://localhost/hooks', {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          ...(provider === 'github'
            ? {
                'x-hub-signature-256': signature,
                'x-github-event': 'workflow_run',
                'x-github-delivery': randomUUID(),
              }
            : { 'x-zero-signature-256': signature }),
        },
      }),
      {
        store,
        resolveSecret: (ref) => ref,
        githubToken: () => {
          throw Error('Unexpected credential lookup')
        },
        signal: new AbortController().signal,
        accepted: (_name, accepted) => {
          if (accepted) jobs.notify()
        },
      },
    )
    expect(response.status).toBe(200)
  }
  const native = (attempt: number, updated_at = at) =>
    send('github', {
      repository,
      action: 'completed',
      workflow_run: { ...run(attempt), updated_at },
    })
  const result = (id: number) => store.tracking.resultForEvent(id, worker.authorized)
  async function settled(id: number) {
    for (let i = 0; i < 150; i++) {
      const item = result(id)
      if (item && ['completed', 'failed', 'unknown'].includes(item.status)) return item
      await Bun.sleep(4)
    }
    throw Error(`No terminal Actions investigation for inbox #${id}: ${JSON.stringify(result(id))}`)
  }

  try {
    await native(1, '2020-01-01T00:00:00Z')
    expect(store.listInbox()).toHaveLength(0)
    await native(1)
    await native(1)
    const first = await settled(1)
    expect(store.routing.get(1)?.origin).toBe('subscription')
    expect(first).toMatchObject({
      attempt: 1,
      status: 'completed',
      work: {
        outcome: 'resolved',
        steps: [{ tool: 'inspect_github', ok: true }],
        followup: { kind: 'new', decision: 'act' },
      },
    })
    expect(first.work?.sources).toContainEqual(
      expect.objectContaining({ url: `https://github.com/${name}/actions/runs/51/job/99` }),
    )
    await native(2)
    await native(2)
    const second = await settled(2)
    expect(second).toMatchObject({
      id: first.id,
      attempt: 2,
      status: 'completed',
      work: {
        outcome: 'resolved',
        steps: [{ tool: 'compare_runs', ok: true }],
        followup: { kind: 'continue', decision: 'act' },
      },
    })
    expect(second.work?.sources).toContainEqual(
      expect.objectContaining({ url: `https://github.com/${name}/actions/runs/51/attempts/1` }),
    )
    expect(triage).toHaveLength(1)
    expect(workers).toHaveLength(2)
    expect(workers[0]).toBe(workers[1])
    expect(sends).toBe(0)
    expect(reads).toContain(`/repos/${name}/actions/workflows/4/runs`)

    await send('ci', {
      version: 1,
      kind: 'workflow_failure',
      eventId: '7:run:51:3:failure',
      repository: name,
      branch: 'main',
      workflow: 'Build',
      occurredAt: at,
      summary: 'External CI text',
    })
    expect(store.listInbox()).toHaveLength(3)
    const ci = store.getInboxItem(3)
    if (!ci) throw Error('External CI inbox item missing')
    expect(ci.eventId).toBe('ci:7:run:51:3:failure')
    expect(store.followups.latestForKey('inbox:3')).toBeNull()
    expect(investigator.available(ci)).toEqual([])
    store.mandates.saveSettings(
      {
        projects: [],
        mandates: [
          {
            id: 'archive-build',
            name: '保存构建记录',
            enabled: true,
            source: 'github',
            scope: name,
            processing: 'direct',
            purpose: '归档',
            keyword: '',
            projectId: null,
            targets: [],
            archive: null,
            policy: {},
            deadline: null,
            urgent: false,
          },
        ],
      },
      0,
    )
    await native(3)
    expect(store.listInbox()).toHaveLength(4)
    expect(store.followups.latestForKey('inbox:4')).toBeNull()
    const snapshot = store.getSettings()
    store.saveSettings(
      {
        ...snapshot.settings,
        github: {
          ...snapshot.settings.github,
          repositories: [{ ...repo, workflowFailures: false }],
        },
      },
      snapshot.revision,
    )
    expect(result(2)).toBeUndefined()
    expect(workers).toHaveLength(2)
  } finally {
    await jobs.close()
    store.close()
  }
})
