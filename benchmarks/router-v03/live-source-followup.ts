import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { TriggerStore } from '@zero-os/observe'
import type { TriggerSettings } from '@zero-os/shared'
import type { AgentDependencies } from '../../apps/server/src/triggers/event-agent'
import { pollGithub } from '../../apps/server/src/triggers/github'
import { createVaultGithubAppAuth } from '../../apps/server/src/triggers/github-app-auth'
import { createGithubInvestigator } from '../../apps/server/src/triggers/investigation'
import { createRouterAgent } from '../../apps/server/src/triggers/router-agent'
import { RouterGithubReplies } from '../../apps/server/src/triggers/router-github-reply'
import { createRouterJobExecutor } from '../../apps/server/src/triggers/router-job-executors'
import { RouterJobPrincipals } from '../../apps/server/src/triggers/router-job-principal'
import { RouterJobs } from '../../apps/server/src/triggers/router-jobs'
import { createRouterRepositoryLookup } from '../../apps/server/src/triggers/router-repositories'
import { createRouterTraceSink } from '../../apps/server/src/triggers/router-trace'
import { createRouterWorkerCapabilities } from '../../apps/server/src/triggers/router-worker-capabilities'
import { RouterWorkspaceService } from '../../apps/server/src/triggers/router-workspace'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'

/** Collect a real recent GitHub close via the polling connector. Isolate its replay, work and Web result. */
export async function verifyLiveSource(output: string, deps: AgentDependencies, liveDir: string) {
  const name = process.env.ZERO_ACCEPTANCE_REPOSITORY
  const number = Number(process.env.ZERO_ACCEPTANCE_ISSUE)
  assert(name && Number.isSafeInteger(number) && number > 0)
  const live = new Database(join(liveDir, 'listeners', 'inbox.sqlite'), { readonly: true })
  const row = live.query<{ json: string }, []>('SELECT json FROM trigger_settings WHERE id=1').get()
  live.close()
  const configured = (JSON.parse(row!.json) as TriggerSettings).github.repositories.find(
    (r) => r.enabled && r.name === name,
  )
  assert(
    configured?.issues && configured.githubAppRef,
    'Select a tracked repository with its existing App',
  )
  const ref = configured.githubAppRef
  const signal = new AbortController().signal
  const auth = createVaultGithubAppAuth(liveDir)
  const token = await auth.getToken(ref, name, signal)
  const stopWrites = async (): Promise<never> => {
    throw Error(
      'External write or local engineering execution outside this read-only acceptance run',
    )
  }
  const file = join(output, 'workspace.sqlite')
  const store = new TriggerStore(file)
  store.useAgentIntake()
  const repo = {
    name,
    issues: true,
    enabled: true,
    mention: '',
    branch: '',
    workflow: '',
    workflowFailures: false,
    githubAppRef: ref,
  }
  const revision = store.saveSettings(
    {
      github: { credentialRef: 'github_listener_fixture', repositories: [repo] },
      wxarc: { sessions: [] },
    },
    0,
    24,
  )
  const stream = 'github:' + name.toLowerCase()
  const observedUrls: string[] = []
  const read: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input)
      assert.equal(url.hostname, 'api.github.com')
      assert.equal(init?.method ?? 'GET', 'GET')
      observedUrls.push(url.href)
      return fetch(input, init)
    },
    { preconnect: fetch.preconnect },
  )
  const polled = await pollGithub(
    repo,
    null,
    token,
    signal,
    store.getStreamStartedAt(stream)!,
    read,
  )
  const events = polled.events.filter(
    (e) =>
      e.url === 'https://github.com/' + name + '/issues/' + number &&
      e.eventId.includes(':closed:'),
  )
  writeFileSync(
    join(output, 'intake.json'),
    JSON.stringify(
      {
        polled: polled.events.map((e) => ({ id: e.eventId, url: e.url })),
        selected: events.map((e) => e.eventId),
        observedUrls,
      },
      null,
      2,
    ),
  )
  assert.equal(events.length, 1, 'Select a real Issue closed in the configured 24h lookback')
  const trace = createRouterTraceSink(store.ledger, (t) => deps.secretFilter.filter(t))
  const modelRouter = {
    getDefaultModel: () => deps.modelRouter.getDefaultModel(),
    getCurrentModel: () => deps.modelRouter.getCurrentModel(),
    trace,
  }
  const resolve = (key: string) => (key === 'github_listener_fixture' ? token : undefined)
  const investigator = createGithubInvestigator(
    () => store.getSettings(),
    resolve,
    (t) => deps.secretFilter.filter(t),
    read,
    auth,
  )
  const repositories = createRouterRepositoryLookup(
    () => ({ credentialRef: 'github_listener_fixture', generation: 1 }),
    resolve,
    read,
    { auth, ref: (repoName) => (repoName === name ? ref : undefined) },
    (t) => deps.secretFilter.filter(t),
  )
  const principals = new RouterJobPrincipals(store, repositories)
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: stopWrites,
    weixin: { listTargets: () => [], send: stopWrites },
  })
  const executor = createRouterJobExecutor({
    ...deps,
    modelRouter,
    codex: { runRouterJob: stopWrites },
    workspaceForRepository: stopWrites,
    latestFailure: stopWrites,
    capabilitiesFor: createRouterWorkerCapabilities({
      store,
      investigator,
      repositories,
      closeIssue: stopWrites,
      replies: new RouterGithubReplies(
        store,
        { getCommentAccess: stopWrites, getCommentIdentity: stopWrites },
        (t) => t,
      ),
      ownerRequest: async () => null,
      authorized: (job) => principals.authorized(job.scope, job.audience, job.repository),
    }),
  })
  const jobs = new RouterJobs(store.jobs, {
    trace,
    execute: executor,
    authorized: principals.authorized.bind(principals),
    completed: async (job) => {
      const link = store.ledger.workerLink(job.id)
      assert(link)
      store.ledger.receiveSignal({
        principal: link.principal,
        scope: 'general',
        kind: 'worker_result',
        key: 'worker:' + job.id + ':' + job.attempt,
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
  const service = new RouterWorkspaceService(
    store,
    routing,
    createRouterAgent({ ...deps, modelRouter }),
    {
      principalFor: () => 'router-owner',
      principals,
      delegatedJobs: jobs,
      investigator,
      agentIntake: true,
      repositories,
    },
  )
  const audit = new Database(file, { readonly: true })
  try {
    jobs.start()
    service.start()
    const question = `跟进 ${name} 的 Issue #${number}。等关闭事件到达时，请让 Worker 从真实原帖、关联改动及验证材料核实：报告的问题在哪个环节发生，改动实际验证到了哪里，哪些仍缺现场证据。收到事件前只登记。把结果交付在网页。`
    await service.message('general', crypto.randomUUID(), question)
    assert.equal(
      audit.query<{n:number},[]>('SELECT count(*) AS n FROM router_job_steps').get()?.n,
      0,
      'The event must initiate the work',
    )
    assert(
      store.commitBatch({
        source: 'github',
        stream,
        revision,
        previousCursor: null,
        ...polled,
        events,
      }),
    )
    service.notifySignals()
    for (let i = 0; i < 3600; i++) {
      const pending = audit
        .query(
          "SELECT 1 FROM router_signals WHERE state IN ('pending','running') UNION ALL SELECT 1 FROM router_job_steps WHERE status IN ('queued','running') OR return_state IN ('pending','sending') LIMIT 1",
        )
        .get()
      if (!pending) break
      await Bun.sleep(250)
    }
    const item = store.listInbox()[0]
    assert(item)
    const matters = store.ledger.eventMatters('router-owner', item.id)
    const runs = store.ledger.listRuns({ limit: 100 }).map((r) => ({
      id: r.id,
      label: r.label,
      status: r.status,
      session: r.sessionId,
      tools: store.ledger
        .entries(r.id)
        .filter((e) => e.kind === 'tool_start')
        .map((e) => (e.data as { name: string }).name),
    }))
    const steps = audit
      .query<{job_id:number;attempt:number;status:string;return_state:string|null;result:string|null},[]>('SELECT job_id,attempt,status,return_state,result FROM router_job_steps')
      .all()
    const publications = store.ledger.publications
      .list('router-owner')
      .flatMap((p) =>
        p.deliveries
          .filter((d) => d.channel === 'web' && d.status === 'accepted')
          .map((d) => ({ id: p.id, matter: p.matterId, text: d.presentation.text })),
      )
    writeFileSync(
      join(output, 'followup.json'),
      JSON.stringify({ question, item, matters, steps, runs, publications, observedUrls }, null, 2),
    )
    assert.equal(matters.length, 1)
    assert(
      steps.length &&
        steps.every((s) => s.status === 'completed' && s.return_state === 'delivered'),
    )
    assert(runs.some((r) => r.tools.includes('delegate_task')))
    assert(
      publications.some((p) => p.text.includes('/issues/' + number) && p.text.includes('/pull/')),
    )
    assert(
      observedUrls.some((url) => url.includes('/pulls/')) &&
        observedUrls.some((url) => url.includes('/issues/' + number)),
    )
  } finally {
    await service.close()
    await jobs.close()
    await routing.close()
    store.close()
    audit.close()
  }
}
