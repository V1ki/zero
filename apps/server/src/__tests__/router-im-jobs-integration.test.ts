import { expect, mock, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import { type RouterJob, TriggerStore } from '@zero-os/observe'
import type { CommissionOperator, CompletionRequest } from '@zero-os/shared'
import { createRouterAgent } from '../triggers/router-agent'
import { createRouterJobExecutor } from '../triggers/router-job-executors'
import { RouterJobPrincipals, jobActor } from '../triggers/router-job-principal'
import { RouterJobs } from '../triggers/router-jobs'
import { createRouterRepositoryLookup } from '../triggers/router-repositories'
import { RouterWorkspaceService } from '../triggers/router-workspace'
import { TriggerRoutingRuntime } from '../triggers/routing-runtime'
import { createTaskBridge } from '../triggers/task-bridge'

const owner: CommissionOperator = {
  platform: 'weixin',
  channelId: 'personal-bot',
  peerId: 'private-actor',
  operatorId: 'private-actor',
}
// Same peer and operator strings on another authorized bot must not unlock this job.
const other: CommissionOperator = { ...owner, platform: 'feishu', channelId: 'work-bot' }

test('a private Router can delegate a named repository and resume only its own job', async () => {
  const store = new TriggerStore(':memory:')
  store.saveSettings(
    {
      github: {
        credentialRef: 'github_listener_fixture',
        routerOperators: [owner],
        repositories: [],
      },
      wxarc: { sessions: [] },
    },
    0,
  )
  const targets = [owner, other].map((t) => ({ ...t, label: t.channelId }))
  const externalSend = mock(async () => {
    throw new Error('Unexpected delivery')
  })
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: externalSend,
    weixin: { listTargets: () => [], send: externalSend },
    personal: {
      listPersonalBots: () => targets.map((t) => ({ ...t, online: true })),
      listPersonalTargets: () => targets,
      listPersonalDirectTargets: () => targets,
      sendPersonal: externalSend,
    },
  })
  const settings = routing.getConfig()
  routing.saveConfig(
    { ...settings.settings, personalBots: { weixin: owner.channelId, feishu: other.channelId } },
    settings.revision,
  )
  const fetcher = mock(async (url: URL) => {
    const repo = { id: 2, full_name: 'fixture/second' }
    const path = '/repos/fixture/second'
    switch (url.pathname) {
      case path:
        return Response.json(repo)
      case `${path}/actions/runs`:
        return Response.json({
          workflow_runs: [
            {
              id: 7,
              run_attempt: 1,
              repository: repo,
              name: 'release',
              path: '.github/workflows/release.yml',
              head_branch: 'main',
              conclusion: 'failure',
              status: 'completed',
              updated_at: '2026-10-21T12:00:00Z',
            },
          ],
        })
      case `${path}/actions/runs/7/attempts/1/jobs`:
        return Response.json({
          total_count: 1,
          jobs: [
            {
              id: 81,
              run_id: 7,
              run_attempt: 1,
              name: 'npm',
              conclusion: 'failure',
              steps: [{ number: 3, name: 'publish', conclusion: 'failure' }],
            },
          ],
        })
      default:
        throw new Error('Unexpected GitHub API request')
    }
  })
  const repositories = createRouterRepositoryLookup(
    (actor) => store.getRouterGithubGrant(actor),
    () => 'fixture-secret',
    fetcher,
  )
  const principals = new RouterJobPrincipals(store, repositories)
  const reported: RouterJob[] = []
  const first = Promise.withResolvers<RouterJob>()
  const second = Promise.withResolvers<RouterJob>()
  const requests: CompletionRequest[] = []
  let tool = { name: '', input: {} as Record<string, unknown> }
  const adapter: ProviderAdapter = {
    apiType: 'fixture',
    healthCheck: async () => true,
    stream() {
      throw new Error('Unexpected streaming')
    },
    async complete(req) {
      requests.push(structuredClone(req))
      const last = req.messages.at(-1)?.content[0]
      const toolDone = last?.type === 'tool_result'
      const isWorker = req.meta?.sessionId?.startsWith('router-job-')
      const continued = isWorker && JSON.stringify(req.messages[0]).includes('失败步骤是 publish')
      const nextTool = isWorker ? { name: 'inspect_latest_github_failure', input: {} } : tool
      let answer = '已核对工具回执。'
      if (isWorker && toolDone) {
        expect(last.content).toContain('步骤 3 · publish')
        answer = '失败步骤是 publish'
      }
      if (continued) answer = '第二轮分析完成'
      const finished = toolDone || continued
      return {
        id: 'scripted',
        model: 'fixture',
        stopReason: finished ? 'end_turn' : 'tool_use',
        usage: { input: 1, output: 1 },
        content: finished
          ? [{ type: 'text', text: answer }]
          : [{ type: 'tool_use', name: nextTool.name, id: 'step', input: nextTool.input }],
      }
    },
  }
  const deps = {
    modelRouter: { getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined },
    secretFilter: { filter: (text: string) => text },
  }
  const execute = createRouterJobExecutor({
    ...deps,
    codex: { runRouterJob: externalSend },
    workspaceForRepository: externalSend,
    latestFailure(job, repo, signal, workflow) {
      const actor = jobActor(job)
      if (!actor) throw new Error('Missing execution principal')
      return repositories.latestFailure(actor, repo, signal, workflow)
    },
  })
  const jobs = new RouterJobs(store.jobs, {
    authorized: principals.authorized.bind(principals),
    execute,
    async completed(job) {
      reported.push(job)
      const completed = job.attempt === 1 ? first : second
      completed.resolve(job)
      return 'delivered'
    },
  })
  const workspace = new RouterWorkspaceService(store, routing, createRouterAgent(deps), {
    delegatedJobs: jobs,
    principals,
  })
  const ordinary = mock(async () => {
    throw new Error('Unexpected fallback to earlier IM session')
  })
  const bridge = createTaskBridge({
    store,
    agent: ordinary,
    isLiveTarget: () => false,
    isPersonalTarget: (t) => routing.isPersonalTarget(t),
    personalDialog: {
      authorize: (t) => routing.claimRouterImTarget(t),
      handle: (m, allowed) => workspace.handleIm(m, allowed),
    },
  })
  let id = 0
  function receive(
    actor: CommissionOperator,
    text: string,
    name: string,
    input: Record<string, unknown> = {},
  ) {
    tool = { name, input }
    return bridge.handle({
      ...actor,
      actorId: actor.operatorId,
      text,
      isDirect: true,
      messageId: String(++id),
    })
  }
  try {
    workspace.start()
    jobs.start()
    const task = await receive(owner, '帮我分析 fixture/second 最近一次发布失败', 'delegate_task', {
      executor: 'zero',
      repository: 'fixture/second',
    })
    expect(task.handled).toBe(true)
    expect(task.reply).toContain('1')
    expect((await first.promise).result).toBe('失败步骤是 publish')
    expect(reported[0]).toMatchObject({
      executor: 'zero',
      repository: 'fixture/second',
      attempt: 1,
    })
    // Changing unrelated listener preferences cannot invalidate the retained job.
    const listeners = store.getSettings()
    store.saveSettings(
      {
        ...listeners.settings,
        wxarc: { sessions: [{ id: 'fixture-room', name: 'Fixture', keyword: '', enabled: false }] },
      },
      listeners.revision,
    )
    const progress = await receive(owner, '刚才的执行任务进展如何', 'get_task_status', { jobId: 1 })
    expect(progress.reply).toContain('失败步骤是 publish')
    const continued = await receive(owner, '继续执行任务 1，进一步分析修复方向', 'continue_task', {
      jobId: 1,
    })
    expect(continued.handled).toBe(true)
    const resumed = await second.promise
    expect(resumed).toMatchObject({
      id: 1,
      attempt: 2,
      result: '第二轮分析完成',
      scope: reported[0].scope,
    })
    expect(workspace.get('general').turns).toHaveLength(0)

    const count = requests.length
    await receive(other, '帮我看看执行任务 1', 'get_task_status', { jobId: 1 })
    expect(JSON.stringify(requests.slice(count))).not.toContain('fixture/second')
    expect(JSON.stringify(requests.slice(count))).not.toContain('失败步骤是 publish')
    // Turning off this user's grant also removes private work history from the next model call.
    const grant = store.getSettings()
    store.saveSettings(
      { ...grant.settings, github: { ...grant.settings.github, routerOperators: [] } },
      grant.revision,
    )
    const beforeRevoke = requests.length
    await receive(owner, '查询刚才派工 1 的完整结果', 'get_task_status', { jobId: 1 })
    const afterRevoke = JSON.stringify(requests.slice(beforeRevoke))
    expect(afterRevoke).not.toContain('fixture/second')
    expect(afterRevoke).not.toContain('失败步骤是 publish')
    expect(afterRevoke).not.toContain('第二轮分析完成')
    expect(JSON.stringify(requests)).not.toContain('fixture-secret')
    expect(ordinary).not.toHaveBeenCalled()
    expect(externalSend).not.toHaveBeenCalled()
    expect(reported).toHaveLength(2)
  } finally {
    await workspace.close()
    await jobs.close()
    await bridge.close()
    await routing.close()
    store.close()
  }
})

test('Web card follow-ups inherit job repository access across failed turns and hide revoked history from the model', async () => {
  const store = new TriggerStore(':memory:')
  const settings = store.getSettings()
  const github = { ...settings.settings.github, credentialRef: 'github_listener_web' }
  store.saveSettings({ ...settings.settings, github }, settings.revision)
  const privateRepo = 'fixture/owner-only'
  const derivedFact = '发布代号琥珀'
  const repositories = createRouterRepositoryLookup(
    (actor) => store.getRouterGithubGrant(actor),
    () => 'fixture-token',
    async () => {
      throw new Error('Unexpected GitHub request')
    },
  )
  const principals = new RouterJobPrincipals(store, repositories)
  const jobs = new RouterJobs(store.jobs, {
    authorized: principals.authorized.bind(principals),
    // Keep the job running; only the receipt and its access snapshot matter here.
    execute: (_job, _history, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      ),
  })
  const requests: CompletionRequest[] = []
  const adapter: ProviderAdapter = {
    apiType: 'fixture',
    healthCheck: async () => true,
    stream() {
      throw new Error('Unexpected streaming')
    },
    async complete(req) {
      requests.push(req)
      const delegating = requests.length === 1
      const text = JSON.stringify(req.messages).includes(privateRepo)
        ? derivedFact
        : '当前授权无仓库记录。'
      return {
        id: crypto.randomUUID(),
        model: 'fixture',
        usage: { input: 1, output: 1 },
        stopReason: delegating ? 'tool_use' : 'end_turn',
        content: delegating
          ? [{ type: 'tool_use', id: 'job', name: 'delegate_task', input: { executor: 'zero' } }]
          : [{ type: 'text', text }],
      }
    },
  }
  const unexpected = async () => {
    throw new Error('Unexpected external operation')
  }
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: unexpected,
    weixin: { listTargets: () => [], send: unexpected },
  })
  const workspace = new RouterWorkspaceService(
    store,
    routing,
    createRouterAgent({
      modelRouter: { getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined },
      secretFilter: { filter: (text) => text },
    }),
    { principals, delegatedJobs: jobs },
  )
  function click(name: 'suggest_next' | 'explain_route') {
    const surface = workspace.get('general').surface
    const { surfaceId, components } = surface[1].updateComponents
    const button = components.find((c) => c.component === 'Button' && c.action.event.name === name)
    if (!button) throw new Error('Missing Router card action')
    return workspace.action('general', crypto.randomUUID(), {
      version: surface[0].version,
      action: {
        surfaceId,
        name,
        sourceComponentId: button.id,
        context: {},
        timestamp: new Date().toISOString(),
      },
    })
  }
  try {
    workspace.start()
    const delegated = await workspace.message(
      'general',
      'web-job',
      `帮我分析 GitHub 仓库 ${privateRepo} 的发布记录`,
    )
    expect(delegated.turns[0].answer?.job?.repository).toBe(privateRepo)
    for (let i = 0; i < 8; i++) {
      const id = String(i)
      const pending = store.conversations.begin('general', id, '临时请求')
      if (pending.kind !== 'started') throw new Error('Failed to seed intervening conversation')
      store.conversations.fail('general', id, pending.attempt, '服务暂不可用')
    }
    const derived = await click('suggest_next')
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(privateRepo)
    expect(derived.turns.at(-1)?.answer?.text).toBe(derivedFact)

    const current = store.getSettings()
    store.saveSettings(
      { ...current.settings, github: { ...github, credentialRef: '' } },
      current.revision,
    )
    const webPreview = JSON.stringify(workspace.get('general'))
    expect(webPreview).not.toContain(privateRepo)
    expect(webPreview).not.toContain(derivedFact)
    const previousCalls = requests.length
    const explanation = await click('explain_route')
    expect(explanation.turns.at(-1)?.answer?.text).toBe('当前授权无仓库记录。')
    const sentToModel = JSON.stringify(requests.slice(previousCalls))
    expect(sentToModel).not.toContain(privateRepo)
    expect(sentToModel).not.toContain(derivedFact)
  } finally {
    await workspace.close()
    await jobs.close()
    await routing.close()
    store.close()
  }
})
