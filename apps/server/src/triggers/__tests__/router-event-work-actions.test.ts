import { expect, mock, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import type { RouterEventWork, RouterSurfaceAction } from '@zero-os/shared'
import { RouterJobPrincipals } from '../router-job-principal'
import { RouterJobs } from '../router-jobs'
import { RouterWorkspaceService } from '../router-workspace'
import { TriggerRoutingRuntime } from '../routing-runtime'

test('the event owner can upgrade a legacy summary once, see evidence, and continue the same job from its own thread', async () => {
  const store = new TriggerStore(':memory:')
  const settings = store.getSettings().settings
  store.saveSettings(
    {
      ...settings,
      github: { ...settings.github, credentialRef: 'github_listener', routerTrackingEnabled: true },
    },
    0,
  )
  const principals = new RouterJobPrincipals(store, { accessKey: () => 'current-grant' })
  const audience = principals.capture('web', true)
  const grant = store.tracking.grant('web')
  if (!grant) throw Error('Expected a tracking grant')
  store.tracking.start({
    actor: 'web',
    scope: 'general',
    audience,
    ownerAudience: audience,
    repository: 'Owner/Repo',
    issues: true,
    pullRequests: false,
    requestId: 'watch',
    expectedGrantGeneration: grant.generation,
  })
  const at = Date.now() + 1000
  store.commitPush({
    source: 'github',
    stream: 'github:owner/repo',
    revision: store.getSettings().revision,
    events: [
      {
        scope: 'Owner/Repo',
        eventId: `7:issue:11:opened:${at}`,
        title: 'Issue #11',
        summary: 'An untrusted request',
        occurredAt: new Date(at).toISOString(),
        url: 'https://github.com/Owner/Repo/issues/11',
      },
    ],
  })
  const id = store.listInbox()[0].id
  const legacy = store.jobs.claimNext()
  if (!legacy) throw Error('Expected an intake job')
  store.jobs.finish(legacy.id, legacy.attempt, { status: 'completed', result: 'Old observation.' })
  const unexpected = mock(async (): Promise<never> => {
    throw Error('Unexpected general delegation, model talk or external send')
  })
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: unexpected,
    weixin: { listTargets: () => [], send: unexpected },
  })
  const source = 'https://github.com/Owner/Repo/issues/8'
  const receipts: RouterEventWork = {
    outcome: 'resolved',
    steps: [{ tool: 'inspect_github', ok: true }],
    sources: [{ label: 'Old issue', url: source }],
  }
  let finish = Promise.withResolvers<void>()
  const runner = new RouterJobs(store.jobs, {
    authorized: principals.authorized.bind(principals),
    unifiedExecution: true,
    execute: async (job, history) => {
      expect(history.some((step) => step.result === 'Old observation.')).toBe(true)
      await finish.promise
      return { result: 'Confirmed the earlier discussion.', threadId: `worker-${job.id}` }
    },
    tracking: {
      authorized: (job) => !!store.tracking.eventForJob(job.id)?.active,
      execute: async (job) => {
        expect(job.workOrigin).toBe('manual')
        await finish.promise
        return { result: 'Confirmed the earlier discussion.', work: receipts }
      },
    },
  })
  store.migrateRouterWork((job) => principals.authorized(job.scope, job.audience, job.repository))
  const workspace = new RouterWorkspaceService(
    store,
    routing,
    async (input, signal) => {
      if (!input.actions?.continueTask || !signal) throw Error('missing continuation')
      await input.actions.continueTask(legacy.id, signal, input.question)
      return { text: '已交给原 Worker 继续核查。' }
    },
    {
      principals,
      principalFor: () => 'router-owner',
      delegatedJobs: runner,
    },
  )
  const button = (): RouterSurfaceAction => {
    const surface = workspace.get(id).surface
    const node = surface[1].updateComponents.components.find(
      (c) => c.component === 'Button' && c.action.event.name === 'work_on_event',
    )
    if (!node) throw Error('Missing actual work action')
    return {
      version: surface[0].version,
      action: {
        name: 'work_on_event',
        sourceComponentId: node.id,
        surfaceId: surface[0].createSurface.surfaceId,
        timestamp: new Date().toISOString(),
        context: {},
      },
    }
  }
  workspace.start()
  try {
    const click = button()
    await expect(workspace.action('general', 'not-an-event', click)).rejects.toThrow()
    const queued = await workspace.action(id, 'one', click)
    expect(queued.turns.at(-1)?.answer?.job).toMatchObject({ id: legacy.id, attempt: 2 })
    expect(['queued', 'running']).toContain(queued.turns.at(-1)?.answer?.job?.status ?? 'missing')
    expect(queued.route).toBeNull()
    await workspace.action(id, 'one', click)
    await expect(workspace.action(id, 'other-uuid', click)).rejects.toThrow()
    finish.resolve()
    await Promise.resolve()
    for (let i = 0; i < 100 && store.jobs.get('general', legacy.id)?.status !== 'completed'; i++)
      await Bun.sleep(5)
    expect(workspace.get(id).turns.find((t) => t.requestId === 'one')?.answer?.job?.result).toBe(
      'Confirmed the earlier discussion.',
    )
    await workspace.action(id, 'one', click)
    expect(store.jobs.history('general', legacy.id)).toHaveLength(2)
    finish = Promise.withResolvers<void>()
    const continued = await workspace.message(id, 'clarify', '继续办理：核对发布时间')
    expect(continued.turns.at(-1)?.answer?.job).toMatchObject({ id: legacy.id, attempt: 3 })
    expect(continued.turns.at(-1)?.answer?.text).toContain('原 Worker')
    expect(store.jobs.get('general', legacy.id)?.instruction).toBe('继续办理：核对发布时间')
    await expect(workspace.message(id, 'busy', '继续办理：更换关键词')).rejects.toThrow()
    expect(workspace.get(id).turns.at(-1)?.status).toBe('failed')
    expect(store.jobs.history('general', legacy.id)).toHaveLength(3)
    expect(unexpected).not.toHaveBeenCalled()
  } finally {
    finish.resolve()
    await workspace.close()
    await routing.close()
    store.close()
  }
})
