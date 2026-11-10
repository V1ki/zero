import { afterEach, expect, mock, test } from 'bun:test'
import { type RouterJob, TriggerStore } from '@zero-os/observe'
import type {
  RouterSurfaceAction,
  RouterSurfaceMessages,
  RouterWorkspaceSnapshot,
  TriggerConversationAnswer,
} from '@zero-os/shared'
import type { RouterAgentInput } from '../router-agent'
import { RouterJobPrincipals } from '../router-job-principal'
import { RouterJobs } from '../router-jobs'
import { RouterWorkspaceService } from '../router-workspace'
import type { RouterWriteRequest } from '../router-write-check'
import { TriggerRoutingRuntime } from '../routing-runtime'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

const report = {
  verdict: '发布脚本已修好，草稿尚未发布。',
  done: ['修改了 release.yml'],
  decision: { question: '现在发布吗？', options: ['发布这份草稿', '先不发布'], recommended: 0 },
}

async function until(predicate: () => boolean) {
  const end = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Timed out')
    await Bun.sleep(5)
  }
}

function setup() {
  const store = new TriggerStore(':memory:')
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: async () => {
      throw new Error('Unexpected analysis')
    },
    weixin: {
      listTargets: () => [],
      send: async () => {
        throw new Error('Unexpected delivery')
      },
    },
  })
  const access = { github: 'github-key' as string | null, checkout: '/checkout' as string | null }
  const principals = new RouterJobPrincipals(store, { accessKey: () => access.github })
  const executed: RouterJob[] = []
  const delegatedJobs = new RouterJobs(store.jobs, {
    authorized: (scope, audience, repository) => principals.authorized(scope, audience, repository),
    execute: async (job) => {
      executed.push(job)
      return { result: `raw work log ${job.attempt}`, threadId: 'thread' }
    },
    report: async (job) => (job.attempt === 1 ? report : { verdict: '已发布。', done: [] }),
    completed: async () => 'delivered',
  })
  const claim = () => {}
  const ask = mock(
    async (input: RouterAgentInput, signal?: AbortSignal): Promise<TriggerConversationAnswer> => {
      const { delegateTask: delegate, continueTask } = input.actions ?? {}
      if (!delegate || !continueTask || !signal) throw new Error('Expected delegation')
      const job = input.question.startsWith('继续派工')
        ? await continueTask(1, signal, claim)
        : await delegate(
            { executor: 'codex', repository: 'owner/repo', brief: '用户今天要发版' },
            signal,
            claim,
          )
      return { text: '已派工。', job }
    },
  )
  const checks: RouterWriteRequest[] = []
  const confirmWrite = mock(async (request: RouterWriteRequest) => {
    checks.push(request)
  })
  const service = new RouterWorkspaceService(
    store,
    {
      getConfig: () => routing.getConfig(),
      listPersonalBots: () => [],
      process: (id) => routing.process(id),
    },
    ask,
    { principals, delegatedJobs, checkout: async () => access.checkout, confirmWrite },
  )
  service.start()
  cleanup.push(async () => {
    await service.close()
    await routing.close()
    store.close()
  })
  return { store, service, ask, access, executed, checks }
}

function click(surface: RouterSurfaceMessages, option: number): RouterSurfaceAction {
  return {
    version: surface[0].version,
    action: {
      name: 'choose_option',
      surfaceId: surface[0].createSurface.surfaceId,
      sourceComponentId: `btn-choose_option-${option}`,
      timestamp: new Date().toISOString(),
      context: {},
    },
  }
}

async function reported(service: RouterWorkspaceService, turn = 0) {
  let snapshot: RouterWorkspaceSnapshot = service.get('general')
  await until(() => {
    snapshot = service.get('general')
    return !!snapshot.turns[turn]?.answer?.job?.report
  })
  return snapshot
}

test('clicking an option continues the same job once, without a Router model call', async () => {
  const { store, service, ask, executed } = setup()
  await service.message('general', 'ask-1', '帮我修复 owner/repo 的发布脚本')
  const snapshot = await reported(service)
  const [turn] = snapshot.turns
  expect(turn.answer?.job).toMatchObject({
    status: 'completed',
    result: 'raw work log 1',
    report,
  })
  expect(turn.answer?.text).toContain('需要你决定：现在发布吗？')
  expect(turn.answer?.text).not.toContain('raw work log')
  const surface = turn.surface
  if (!surface) throw new Error('Expected a decision surface')
  const buttons = surface[1].updateComponents.components.filter((c) => c.component === 'Button')
  expect(buttons.map((b) => [b.id, b.component === 'Button' && b.variant])).toEqual([
    ['btn-choose_option-0', 'primary'],
    ['btn-choose_option-1', undefined],
  ])
  expect(surface[2].updateDataModel.value).toMatchObject({
    heading: '现在发布吗？',
    'option-0': '发布这份草稿（推荐）',
    'option-1': '先不发布',
  })

  // A button the server never rendered is refused.
  await expect(service.action('general', 'tampered', click(surface, 2))).rejects.toMatchObject({
    status: 409,
  })
  await expect(
    service.action('general', 'invalid', {
      ...click(surface, 0),
      action: { ...click(surface, 0).action, sourceComponentId: 'btn-choose_option-7' },
    }),
  ).rejects.toMatchObject({ status: 400 })

  const answered = await service.action('general', 'click-1', click(surface, 1))
  expect(ask).toHaveBeenCalledTimes(1)
  expect(answered.turns).toHaveLength(2)
  expect(answered.turns[1].question).toBe('选择：先不发布')
  expect(answered.turns[1].answer?.job).toMatchObject({ id: turn.answer?.job?.id, attempt: 2 })
  // The older step's decision is closed and its buttons are gone.
  expect(answered.turns[0].answer?.job?.continued).toBe(true)
  expect(answered.turns[0].surface).toBeNull()
  expect(answered.turns[0].answer?.text).not.toContain('需要你决定')
  const stored = store.jobs.get('general', turn.answer?.job?.id ?? 0)
  expect(stored?.instruction).toBe(
    '用户在网页上回答了这项派工上一步提出的问题「现在发布吗？」，选择了：「先不发布」。请按这个选择继续。',
  )
  expect(store.jobs.get('general', stored?.id ?? 0, 1)?.instruction).toBe(
    '帮我修复 owner/repo 的发布脚本',
  )

  // Replaying the same click returns the same turn; a new click on the old step is stale.
  const replay = await service.action('general', 'click-1', click(surface, 1))
  expect(replay.turns).toHaveLength(2)
  await expect(service.action('general', 'click-2', click(surface, 0))).rejects.toMatchObject({
    status: 409,
  })
  await until(() => executed.length === 2)
  const final = await reported(service, 1)
  expect(final.turns[1].answer?.job?.report).toEqual({ verdict: '已发布。', done: [] })
  expect(store.jobs.get('general', stored?.id ?? 0)?.attempt).toBe(2)
  expect(ask).toHaveBeenCalledTimes(1)
})

test('a click is refused in another scope and after authorization or checkout changes', async () => {
  const { store, service, access } = setup()
  await service.message('general', 'ask-1', '帮我修复 owner/repo 的发布脚本')
  const surface = (await reported(service)).turns[0].surface
  if (!surface) throw new Error('Expected a decision surface')
  const id = (await reported(service)).turns[0].answer?.job?.id ?? 0

  // Another conversation scope cannot answer it.
  await expect(service.action('task-1', 'scope', click(surface, 0))).rejects.toMatchObject({
    status: 404,
  })

  access.checkout = null
  await expect(service.action('general', 'checkout', click(surface, 0))).rejects.toMatchObject({
    status: 502,
  })
  expect(store.jobs.get('general', id)?.attempt).toBe(1)

  access.checkout = '/checkout'
  access.github = 'rotated-key'
  await expect(service.action('general', 'revoked', click(surface, 0))).rejects.toMatchObject({
    status: 409,
  })
  expect(store.jobs.get('general', id)?.attempt).toBe(1)
})

test('replying with the printed phrase continues a Codex job without a confirmation call', async () => {
  const { store, service, executed, checks } = setup()
  await service.message('general', 'ask-1', '帮我修复 owner/repo 的发布脚本')
  const snapshot = await reported(service)
  expect(checks).toEqual([
    { question: '帮我修复 owner/repo 的发布脚本', kind: 'submit', repository: 'owner/repo' },
  ])
  const printed = snapshot.turns[0].answer?.text.match(/回复「([^」]+)」/u)?.[1]
  expect(printed).toBe('继续派工 #1：选 1')
  const answered = await service.message('general', 'reply-1', printed ?? '')
  expect(answered.turns[1].answer?.job).toMatchObject({ id: 1, attempt: 2 })
  expect(checks).toHaveLength(1)
  expect(store.jobs.get('general', 1)?.instruction).toBe(
    '继续派工 #1：选 1\n（用户选择的是上一步提出的问题「现在发布吗？」的选项：「发布这份草稿」）',
  )
  await until(() => executed.length === 2)
})

test('a numbered answer with more words is confirmed, told only the option number', async () => {
  const { store, service, checks } = setup()
  await service.message('general', 'ask-1', '帮我修复 owner/repo 的发布脚本')
  await reported(service)
  await service.message('general', 'reply-1', '继续派工 #1：选 2，顺便把 changelog 补上')
  expect(checks.at(-1)).toEqual({
    question: '继续派工 #1：选 2，顺便把 changelog 补上',
    kind: 'continue',
    repository: 'owner/repo',
    jobId: 1,
    chosenOption: 2,
  })
  expect(JSON.stringify(checks)).not.toContain('先不发布')
  expect(store.jobs.get('general', 1)?.attempt).toBe(2)
})
