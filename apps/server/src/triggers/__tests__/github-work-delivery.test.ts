import { expect, test } from 'bun:test'
import { type RouterJob, TriggerStore } from '@zero-os/observe'
import type { TriggerGithubRepository, TriggerInboxItem } from '@zero-os/shared'
import { postGithubAppComment } from '../github-app-comment'
import { createGithubWorkDelivery } from '../github-work-delivery'
import { RouterGithubReplies } from '../router-github-reply'
const name = 'A/B'
const base = `https://github.com/${name}`
const author = 'example[bot]'
const repo: TriggerGithubRepository = {
  name,
  enabled: true,
  githubAppRef: 'github_app_demo',
  issueComments: true,
  ownerMentionReplies: true,
  mention: '',
  branch: '',
  workflow: '',
  workflowFailures: false,
}
const event: TriggerInboxItem & { url: string } = {
  id: 1,
  source: 'github',
  scope: name,
  title: 'Issue #10',
  summary: 'a comment',
  eventId: '5:comment:11',
  githubCommentKind: 'issue-comment',
  url: `${base}/issues/10#issuecomment-11`,
  occurredAt: new Date(Date.now() + 5000).toISOString(),
  receivedAt: new Date().toISOString(),
}
const job = {
  id: 7,
  scope: 'general',
  kind: 'github-watch',
  executor: 'zero',
  status: 'completed',
  attempt: 1,
  repository: name,
  requestId: 'watch',
  instruction: 'observe',
  audience: null,
  result: 'arbitrary model reply @another https://bad.invalid/',
  threadId: null,
  createdAt: event.occurredAt,
  updatedAt: event.occurredAt,
  work: {
    outcome: 'resolved',
    steps: [{ tool: 'find_related_issues', ok: true }],
    sources: [
      { label: 'ignore', url: `${base}/issues/9#issuecomment-3` },
      { label: 'arbitrary', url: 'https://evil.invalid/c' },
      { label: 'original', url: event.url },
    ],
  },
} satisfies RouterJob
function fixture(request = { instruction: 'find the older issue', closeIssue: false }) {
  const store = new TriggerStore(':memory:')
  store.saveSettings(
    { github: { repositories: [repo], credentialRef: '' }, wxarc: { sessions: [] } },
    0,
  )
  store.commitPush({ source: 'github', stream: 'github:a/b', revision: 1, events: [event] })
  let verifyUntil = Number.POSITIVE_INFINITY
  let current = true
  let ambiguity = false
  let revokeOnCheck = false
  let sourceCalls = 0
  const bodies: string[] = []
  const auth = {
    getCommentIdentity: async () => author,
    getCommentAccess: async () => ({ botLogin: author, token: 'test' }),
  }
  const replies = new RouterGithubReplies(
    store,
    auth,
    (x) => x,
    async (auth, params) =>
      postGithubAppComment(auth, params, async (url, init) => {
        if (init.method === 'GET') return Response.json({ id: 5, full_name: name })
        if (init.method !== 'POST' || url.pathname !== '/repos/A/B/issues/10/comments')
          throw Error('Unexpected call')
        bodies.push(JSON.parse(String(init.body)).body)
        if (ambiguity) throw Error('after POST')
        return Response.json(
          {
            id: 17,
            user: { login: author, type: 'Bot' },
            issue_url: `https://api.github.com/repos/${name}/issues/10`,
            html_url: `${base}/issues/10#issuecomment-17`,
          },
          { status: 201 },
        )
      }),
  )
  let nowEvent = event
  let followup = false
  const delivery = createGithubWorkDelivery(
    {
      getSettings: () => store.getSettings(),
      tracking: {
        eventForJob: () => ({
          trackingId: 1,
          inboxId: 1,
          event: nowEvent,
          active: true,
          selfEcho: false,
          followup,
        }),
      },
    },
    replies,
    async () => {
      sourceCalls++
      if (revokeOnCheck) current = false
      return sourceCalls <= verifyUntil ? request : null
    },
    () => current,
  )
  const signal = new AbortController().signal
  return {
    store,
    bodies,
    replies,
    run: (input: RouterJob = job) => delivery(input, signal),
    uncertain: () => {
      ambiguity = true
    },
    revoke: () => {
      revokeOnCheck = true
    },
    forged: () => {
      verifyUntil = 1
    },
    unmentioned: () => {
      verifyUntil = 0
    },
    newEventForWorker: () => {
      followup = true
    },
    sourceCalls: () => sourceCalls,
    old: () => {
      nowEvent = { ...event, occurredAt: '2000-01-01T12:00:00Z' }
    },
  }
}
test('verified owner mention returns only trusted links to the same discussion once; receipt survives refresh', async () => {
  const f = fixture()
  try {
    expect(await f.run()).toBe('delivered')
    expect(await f.run()).toBe('delivered')
    expect(f.bodies).toHaveLength(1)
    expect(f.bodies[0]).toContain(`${base}/issues/9#issuecomment-3`)
    expect(f.bodies[0]).not.toContain('/issues/10')
    expect(f.bodies[0]).not.toMatch(/bad\.invalid|evil\.invalid|@another/)
    expect(await f.replies.preview(1)).toMatchObject({
      delivery: {
        state: 'sent',
        origin: 'worker',
        author,
        url: `${base}/issues/10#issuecomment-17`,
      },
    })
  } finally {
    await f.replies.close()
    f.store.close()
  }
})
test('old events, manual attempts, missing evidence, and notification-only jobs cannot send', async () => {
  const f = fixture()
  try {
    expect(await f.run({ ...job, workOrigin: 'manual' })).toBeNull()
    expect(await f.run({ ...job, attempt: 2 })).toBeNull()
    expect(await f.run({ ...job, work: { ...job.work, steps: [] } })).toBeNull()
    expect(await f.run({ ...job, work: { ...job.work, outcome: 'observed' } })).toBeNull()
    f.old()
    expect(await f.run()).toBeNull()
    expect(f.sourceCalls()).toBe(0)
    expect(f.bodies).toHaveLength(0)
  } finally {
    await f.replies.close()
    f.store.close()
  }
})
test('ordinary resolved work returns to the Router without reserving a GitHub reply', async () => {
  const f = fixture()
  try {
    f.unmentioned()
    expect(await f.run()).toBeNull()
    expect(f.bodies).toHaveLength(0)
    expect(f.store.githubReplies.latest(event.id)).toBeUndefined()
  } finally {
    await f.replies.close()
    f.store.close()
  }
})
test('a freshly verified owner mention can receive a reply from the same continuing Worker', async () => {
  const f = fixture()
  try {
    f.newEventForWorker()
    expect(await f.run({ ...job, attempt: 2 })).toBe('delivered')
    expect(f.bodies).toHaveLength(1)
    expect(f.sourceCalls()).toBe(2)
  } finally {
    await f.replies.close()
    f.store.close()
  }
})
test('needs-input asks a safe follow-up instead of publishing model or private diagnostics', async () => {
  const f = fixture()
  try {
    expect(
      await f.run({
        ...job,
        work: { ...job.work, outcome: 'needs_input' },
        attentionQuestion: 'secret internal question',
      }),
    ).toBe('delivered')
    expect(f.bodies[0]).toContain('关键词')
    expect(f.bodies[0]).not.toMatch(/secret|bad\.invalid/)
  } finally {
    await f.replies.close()
    f.store.close()
  }
})
for (const invalid of ['forged', 'revoke', 'uncertain'] as const)
  test(`does not repeat posts on ${invalid}`, async () => {
    const f = fixture()
    try {
      f[invalid]()
      expect(await f.run()).toBe(invalid === 'uncertain' ? 'unknown' : 'unavailable')
      await f.run()
      expect(f.bodies).toHaveLength(invalid === 'uncertain' ? 1 : 0)
    } finally {
      await f.replies.close()
      f.store.close()
    }
  })

test('ordinary state inquiry answers with the GitHub state, never a model-written or unverified value', async () => {
  const f = fixture()
  try {
    const work: NonNullable<RouterJob['work']> = {
      outcome: 'resolved',
      steps: [{ tool: 'inspect_github', ok: true }],
      sources: [{ label: '当前事件的 GitHub 记录', url: `${base}/issues/10#issuecomment-11` }],
      publicFacts: [
        { label: '当前状态', value: '已关闭' },
        { label: '评论时间', value: 'unverified arbitrary prose' },
      ],
    }
    expect(await f.run({ ...job, work })).toBe('delivered')
    expect(f.bodies[0]).toContain('Issue #10 当前状态：已关闭')
    expect(f.bodies[0]).not.toMatch(/unverified|arbitrary|bad\.invalid|@another/)
  } finally {
    await f.replies.close()
    f.store.close()
  }
})

test('publishes only the verified closure on a continued owner request; an edited instruction cannot authorize delivery', async () => {
  const input: RouterJob = {
    ...job,
    attempt: 3,
    workOrigin: 'owner',
    instruction: 'close this issue',
    work: {
      outcome: 'resolved',
      steps: [{ tool: 'close_issue', ok: true }],
      sources: [{ label: 'receipt', url: `${base}/issues/10` }],
      publicFacts: [{ label: '当前状态', value: '已关闭' }],
    },
  }
  for (const unchanged of [true, false]) {
    const f = fixture({
      instruction: unchanged ? input.instruction : 'tell me its status',
      closeIssue: unchanged,
    })
    try {
      expect(await f.run(input)).toBe(unchanged ? 'delivered' : 'unavailable')
      expect(f.bodies).toEqual(unchanged ? [`已核实 [Issue #10](${base}/issues/10) 已关闭。`] : [])
    } finally {
      await f.replies.close()
      f.store.close()
    }
  }
})
