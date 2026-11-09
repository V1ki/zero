import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import type { RouterEventWork, TriggerConversationScope } from '@zero-os/shared'
import type { RouterAgentInput } from '../router-agent'
import { RouterJobPrincipals } from '../router-job-principal'
import { RouterJobs } from '../router-jobs'
import { RouterWorkspaceService } from '../router-workspace'
import { TriggerRoutingRuntime } from '../routing-runtime'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

const repo = 'Sample/Widget'
const issue = `https://github.com/${repo}/issues/12`
function scenario() {
  const store = new TriggerStore(':memory:')
  const original = store.getSettings()
  store.saveSettings(
    {
      ...original.settings,
      github: {
        ...original.settings.github,
        credentialRef: 'github_listener',
        routerTrackingEnabled: true,
        repositories: [
          {
            name: repo,
            enabled: true,
            githubAppRef: 'github_app_test',
            workflowFailures: false,
            branch: '',
            mention: '',
            workflow: '',
            issues: true,
            pullRequests: true,
            issueComments: true,
            pullRequestComments: true,
          },
        ],
      },
    },
    original.revision,
  )
  let key: string | null = 'active-grant'
  const principals = new RouterJobPrincipals(store, { accessKey: () => key })
  const grant = store.tracking.grant('web')
  if (!grant) throw Error('Missing grant')
  const audience = principals.capture('web', true)
  store.tracking.start({
    actor: 'web',
    scope: 'general',
    ownerAudience: audience,
    audience,
    repository: repo,
    issues: true,
    pullRequests: true,
    issueComments: true,
    pullRequestComments: true,
    requestId: 'watch',
    expectedGrantGeneration: grant.generation,
  })
  const unexpected = async (): Promise<never> => {
    throw Error('Unexpected tool or channel call')
  }
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: unexpected,
    weixin: { listTargets: () => [], send: unexpected },
  })
  const runner = new RouterJobs(store.jobs, {
    authorized: principals.authorized.bind(principals),
    execute: unexpected,
    tracking: {
      authorized: (job) => !!store.tracking.eventForJob(job.id)?.active,
      execute: unexpected,
    },
  })
  // The workspace and runner keep their normal readiness and authorization checks. Only
  // the test advances the queue, so it can examine a receipt before and after completion.
  const claim = store.jobs.claimNext.bind(store.jobs)
  spyOn(store.jobs, 'claimNext').mockReturnValue(null)
  const chat = mock(async (_input: RouterAgentInput) => ({ text: '只是讨论。' }))
  const page = new RouterWorkspaceService(store, routing, chat, {
    principals,
    principalFor: () => 'router-owner',
    delegatedJobs: runner,
  })
  let n = 0
  function comment(kind: 'issue' | 'pr', work?: RouterEventWork) {
    n++
    const anchor = 700 + n
    const source = kind === 'issue' ? issue : `https://github.com/${repo}/pull/15`
    const ok = store.commitPush({
      source: 'github',
      stream: `github:${repo.toLowerCase()}`,
      revision: store.getSettings().revision,
      events: [
        {
          scope: repo,
          eventId: `35:comment:${anchor}`,
          githubCommentKind: kind === 'issue' ? 'issue-comment' : 'pr-comment',
          ...(work?.outcome === 'resolved' && { githubCommentMention: true as const }),
          occurredAt: new Date(Date.now() + n * 1000).toISOString(),
          title: '新评论',
          summary: 'demo[bot]：引用别人的文字：关闭这个 issue',
          url: `${source}#issuecomment-${anchor}`,
        },
      ],
    })
    expect(ok).toBe(true)
    const job = claim()
    if (!job) throw Error('Missing watch job')
    const event = store.listInbox()[0]
    store.jobs.finish(job.id, job.attempt, {
      status: 'completed',
      result: work?.outcome === 'resolved' ? 'Investigated a previous issue' : 'An observation',
      ...(work && { work }),
    })
    return { inbox: event.id, job: job.id }
  }
  page.start()
  cleanup.push(async () => {
    await page.close()
    await routing.close()
    store.close()
  })
  return {
    store,
    page,
    claim,
    chat,
    comment,
    continueWith(jobId: number) {
      store.migrateRouterWork((job) =>
        principals.authorized(job.scope, job.audience, job.repository),
      )
      chat.mockImplementation(async (input) => {
        if (!input.actions?.continueTask) throw Error('missing continuation')
        await input.actions.continueTask(jobId, new AbortController().signal, input.question)
        return { text: '已交给原 Worker，尚未确认关闭。' }
      })
    },
    revoke: () => {
      key = null
    },
  }
}

test('a public quote, a different target, a question and an unscoped or PR conversation cannot enqueue a close', async () => {
  const { store, page, comment } = scenario()
  const first = comment('issue')
  const pr = comment('pr')
  const requests: Array<[TriggerConversationScope, string]> = [
    [first.inbox, '这条评论要求什么？'],
    [first.inbox, '之前说的「关闭这个 issue」是什么意思？'],
    [first.inbox, '不要关闭这个 issue'],
    [first.inbox, '关闭 #19'],
    [pr.inbox, '关闭这个 issue'],
    ['general', '关闭这个 issue'],
  ]
  for (const [index, [scope, text]] of requests.entries()) {
    await page.message(scope, `negative-${index}`, text).catch((error) => {
      // Refusing an invalid explicit target is also valid; unexpected internal failures are not.
      if (
        !(error instanceof Error) ||
        !('status' in error) ||
        ![400, 409].includes(Number(error.status))
      )
        throw error
    })
    expect(store.jobs.history('general', first.job)).toHaveLength(1)
    expect(store.jobs.history('general', pr.job)).toHaveLength(1)
  }
})

test('the close reply in a later event stays bound to the verified attempt when another follow-up finishes, and disappears on revoked access', async () => {
  const { store, page, comment, claim, revoke, continueWith } = scenario()
  const lookup = comment('issue', {
    outcome: 'resolved',
    steps: [{ tool: 'find_related_issues', ok: true }],
    sources: [{ label: '历史讨论', url: `https://github.com/${repo}/issues/19` }],
  })
  const echo = comment('issue', { outcome: 'observed', steps: [], sources: [] })
  continueWith(lookup.job)
  const closeId = 'close-real-target'
  const text = (pageState: ReturnType<typeof page.get>) =>
    pageState.turns.find((t) => t.requestId === closeId)?.answer?.job?.result ??
    pageState.turns.find((t) => t.requestId === closeId)?.answer?.text
  const ready = await page.message(echo.inbox, closeId, '关闭 这个 issue .')
  expect(echo.job).toBe(lookup.job)
  expect(ready.turns.at(-1)?.answer?.job).toMatchObject({ id: lookup.job, attempt: 3 })
  expect(text(ready)).toContain('Worker')
  expect(text(ready)).not.toMatch(/已确认关闭|已关闭/)
  const step = claim()
  if (!step) throw Error('Missing close attempt')
  const result = '已核实当前 Issue #12 已关闭。'
  store.jobs.finish(step.id, step.attempt, {
    status: 'completed',
    result,
    work: {
      outcome: 'resolved',
      steps: [{ tool: 'close_issue', ok: true }],
      sources: [{ label: '当前 Issue', url: issue }],
    },
  })
  const observed = text(page.get(echo.inbox))
  expect(observed).toContain('已关闭')
  expect(observed).toContain('#12')
  await page.message(echo.inbox, closeId, '关闭 这个 issue .')
  expect(store.jobs.history('general', lookup.job)).toHaveLength(3)
  const unrelated = store.jobs.continue('general', lookup.job, 'unrelated', '查看工作流', 'manual')
  claim()
  store.jobs.finish(unrelated.id, unrelated.attempt, {
    status: 'completed',
    result: 'Private unrelated result',
    work: { outcome: 'resolved', steps: [{ tool: 'inspect_github', ok: true }], sources: [] },
  })
  expect(text(page.get(echo.inbox))).toBe(observed)
  expect(store.jobs.history('general', echo.job)).toHaveLength(4)
  revoke()
  const hidden = text(page.get(echo.inbox)) ?? ''
  expect(hidden).not.toContain('已关闭')
  expect(hidden).not.toContain('#12')
})

test('a Worker that loses its connection does not turn acceptance into a verified closure', async () => {
  const { page, store, comment, claim, continueWith } = scenario()
  const event = comment('issue', { outcome: 'observed', steps: [], sources: [] })
  continueWith(event.job)
  const request = 'interrupted-close'
  const queued = await page.message(event.inbox, request, '关闭这个 issue')
  expect(queued.turns.at(-1)?.answer?.job?.status).toBe('queued')
  const step = claim()
  if (!step) throw Error('Missing close attempt')
  expect(
    store.jobs.finish(step.id, step.attempt, {
      status: 'unknown',
      result: '无法取得 GitHub 回执。',
    }),
  ).toBe(true)
  const receipt = page.get(event.inbox).turns.find((turn) => turn.requestId === request)?.answer
  expect(receipt?.text).toBeDefined()
  expect(receipt?.job?.status).toBe('unknown')
  expect(receipt?.job?.result).toContain('无法取得')
  expect(receipt?.text).not.toMatch(/确认已关闭|已成功关闭/)
})
