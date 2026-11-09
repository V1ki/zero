import { expect, mock, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import type { TriggerInboxItem, TriggerSettingsSnapshot } from '@zero-os/shared'
import type { createGithubIssueCloser } from '../github-issue-close'
import {
  createDuplicateEvidenceReader,
  createResolvedDuplicatePolicy,
} from '../github-resolved-duplicate'
import { RouterGithubReplies } from '../router-github-reply'
import { createRouterRepositoryLookup } from '../router-repositories'
import { createRouterWorkerCapabilities } from '../router-worker-capabilities'

const repo = 'Owner/Tools'
const base = `https://api.github.com/repos/${repo}`
const web = `https://github.com/${repo}/issues/`
const at = '2026-09-12T10:11:12Z'
const event: TriggerInboxItem = {
  id: 4,
  source: 'github',
  scope: repo,
  eventId: '55:comment:29',
  occurredAt: at,
  receivedAt: at,
  title: 'Issue #20',
  summary: 'Owner：Duplicate of #7',
  url: `${web}20#issuecomment-29`,
  githubCommentKind: 'issue-comment',
}
const user = { type: 'User', id: 99, login: 'Owner' }
type Row = Record<string, unknown>
function setup(observedAt = at) {
  const source = { ...event, occurredAt: observedAt, receivedAt: observedAt }
  const settings: TriggerSettingsSnapshot = {
    revision: 1,
    settings: {
      github: {
        credentialRef: '',
        repositories: [
          {
            name: repo,
            githubAppRef: 'github_app_test',
            enabled: true,
            issues: true,
            issueComments: true,
            closeResolvedDuplicates: true,
            closeResolvedDuplicatesSince: '2026-09-12T08:00:00Z',
            mention: '',
            branch: '',
            workflow: '',
            workflowFailures: false,
          },
        ],
      },
      wxarc: { sessions: [] },
    },
  }
  const current: Row = {
    id: 220,
    node_id: 'I20',
    number: 20,
    repository_url: base,
    html_url: `${web}20`,
    state: 'open',
    created_at: '2026-09-10T00:00:00Z',
    updated_at: observedAt,
    comments: 1,
    title: 'Cannot restore checkpoint',
    body: null,
  }
  const previous: Row = {
    id: 77,
    node_id: 'I7',
    number: 7,
    repository_url: base,
    html_url: `${web}7`,
    state: 'closed',
    state_reason: 'completed',
    created_at: '2026-05-01T00:00:00Z',
    closed_at: '2026-06-02T10:00:00Z',
  }
  const comment: Row = {
    id: 29,
    node_id: 'C29',
    issue_url: `${base}/issues/20`,
    html_url: event.url,
    user,
    author_association: 'OWNER',
    body: 'Duplicate of #7',
    created_at: observedAt,
    updated_at: observedAt,
  }
  const marks: Row[] = [
    {
      id: 'M29',
      __typename: 'MarkedAsDuplicateEvent',
      isCrossRepository: false,
      createdAt: observedAt,
      actor: { login: 'Owner' },
      canonical: { id: 'I7' },
      duplicate: { id: 'I20' },
    },
  ]
  const markerContext: Row[] = [
    { __typename: 'IssueComment', id: 'C29' },
    { __typename: 'MarkedAsDuplicateEvent', id: 'M29' },
  ]
  const discussion: Row[] = [comment]
  let beforePatch = () => {}
  const patches = mock(() => {})
  const close: ReturnType<typeof createGithubIssueCloser> = async (e, s, g) => {
    expect(e.scope).toBe(repo)
    expect(g.expectedIssueId).toBe(220)
    expect(g.expectedUpdatedAt).toBe(observedAt)
    expect(g.duplicateOf).toEqual({ id: 77, number: 7 })
    beforePatch()
    if (!g.current() || !(await g.verify?.(s))) throw Error('authorization changed')
    patches()
    return { state: 'closed', repository: repo, number: 20, issueId: 220, url: `${web}20` }
  }
  const read = mock(async (url: URL, init: RequestInit) => {
    expect(url.origin).toBe('https://api.github.com')
    expect(init.redirect).toBe('manual')
    if (url.pathname === '/graphql') {
      expect(init.method).toBe('POST')
      expect(JSON.parse(String(init.body)).query).not.toContain('mutation')
      return Response.json({
        data: {
          node: {
            id: 'I20',
            state: 'OPEN',
            url: `${web}20`,
            repository: { id: 'R55' },
            timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: marks },
            markerContext: { nodes: markerContext },
          },
        },
      })
    }
    expect(init.method).toBe('GET')
    if (url.pathname === '/search/issues')
      return Response.json({ incomplete_results: false, total_count: 1, items: [previous] })
    const path = url.href.slice(base.length)
    if (path === '') return Response.json({ id: 55, node_id: 'R55', full_name: repo, owner: user })
    if (path === '/issues/20') return Response.json(current)
    if (path === '/issues/7') return Response.json(previous)
    if (path === '/issues/20/comments?per_page=100') return Response.json(discussion)
    throw Error('unexpected URL')
  })
  return {
    source,
    close,
    run: (e = source) =>
      createResolvedDuplicatePolicy(
        () => settings,
        { getToken: async () => 'fixture' },
        close,
        read,
      )(e, new AbortController().signal, () => true),
    settings,
    current,
    previous,
    comment,
    discussion,
    marks,
    markerContext,
    read,
    patches,
    changeAtPatch: (f: () => void) => {
      beforePatch = f
    },
  }
}
test('verifies a current owner duplicate marker twice, closes only the new issue and records the resolved original', async () => {
  const f = setup()
  const r = await f.run()
  expect(f.patches).toHaveBeenCalledTimes(1)
  expect(r?.work.sources).toContainEqual({ label: '已解决的重复项 #7', url: `${web}7` })
  expect(r?.work.steps).toEqual([{ tool: 'close_issue', ok: true }])
  expect(f.read.mock.calls.filter(([u]) => u.pathname === '/graphql')).toHaveLength(2)
})
test('GitHub may reverse the endpoints: only the exact owner comment followed by its own native marker proves direction', async () => {
  for (const fault of ['none', 'comment', 'mark', 'missing', 'time', 'target']) {
    const f = setup()
    Object.assign(f.marks[0], { canonical: { id: 'I20' }, duplicate: { id: 'I7' } })
    if (fault === 'comment') f.markerContext[0].id = 'OtherComment'
    if (fault === 'mark') f.markerContext[1].id = 'OtherMark'
    if (fault === 'missing') f.markerContext.splice(0)
    if (fault === 'time') f.marks[0].createdAt = '2026-09-12T10:11:13Z'
    if (fault === 'target') f.marks[0].duplicate = { id: 'OtherIssue' }
    const result = await f.run()
    expect(!!result).toBe(fault === 'none')
    expect(f.patches).toHaveBeenCalledTimes(fault === 'none' ? 1 : 0)
  }
})
test('history, unrelated comments, PRs and later changes cannot trigger a closure', async () => {
  for (const x of [
    { occurredAt: '2026-09-11T10:00:00Z' },
    { summary: 'Owner：Looks similar to #7' },
    { githubCommentKind: 'pr-comment' as const },
    {
      eventId: `55:issue:20:reopened:${Date.parse(at)}`,
      url: `${web}20`,
      githubCommentKind: undefined,
    },
  ]) {
    const f = setup()
    expect(await f.run({ ...event, ...x })).toBeNull()
    expect(f.read).not.toHaveBeenCalled()
  }
  const bad: ((f: ReturnType<typeof setup>) => void)[] = [
    (f) => {
      f.discussion.unshift({
        ...f.comment,
        id: 22,
        body: 'Please do not close; this has a different cause.',
      })
      f.current.comments = 2
    },
    (f) => {
      f.current.comments = 2
    },
    (f) => {
      f.marks.push({ __typename: 'UnmarkedAsDuplicateEvent' })
    },
    (f) => {
      f.previous.state_reason = 'not_planned'
    },
    (f) => {
      f.previous.html_url = 'https://github.com/other/project/issues/7'
    },
    (f) => {
      f.current.updated_at = '2026-09-12T10:12:00Z'
    },
    (f) => {
      f.previous.state = 'open'
    },
    (f) => {
      f.marks[0].isCrossRepository = true
    },
    (f) => {
      f.comment.author_association = 'MEMBER'
    },
    (f) => {
      f.comment.body = 'perhaps duplicate of #7'
    },
    (f) => {
      f.marks[0].actor = { login: 'Contributor' }
    },
    (f) => {
      f.marks[0].canonical = { id: 'I20' }
    },
  ]
  for (const mutate of bad) {
    const f = setup()
    mutate(f)
    expect(await f.run()).toBeNull()
    expect(f.patches).not.toHaveBeenCalled()
  }
})
test('a new incident replay can be closed with a canonical source without a manual duplicate marker', async () => {
  const f = setup()
  f.marks.splice(0)
  const issue = {
    user,
    title: 'Checkpoint segmented spool cannot restore buffers',
    body: [
      'Restoring the local checkpoint into a newly scheduled process failed to reconnect a buffer while the checkpoint writer was committing its final header.',
      'Request ID: c9f67b1a2e34530de78ab6d1d6798270',
      'RestoreFrameError: missing buffer partition in committed writer',
      '    at reconnectFrame (src/checkpoint/receive.ts:234:5)',
      '    at verifyPartition (src/restore/reconnect.ts:566:3)',
    ].join('\n'),
  }
  Object.assign(f.current, issue, { created_at: at, closed_at: null, comments: 0 })
  Object.assign(f.previous, issue)
  const r = await f.run({
    ...event,
    githubCommentKind: undefined,
    eventId: `55:issue:20:opened:${Date.parse(at)}`,
    url: `${web}20`,
    summary: '',
  })
  expect(f.patches).toHaveBeenCalledTimes(1)
  expect(r?.result).toContain('完整故障报告')
  expect(r?.work.sources?.at(-1)?.url).toBe(`${web}7`)
})
test('rechecks the canonical resolution and the rule grant before mutation', async () => {
  const f = setup()
  f.changeAtPatch(() => {
    f.previous.state = 'open'
  })
  await expect(f.run()).rejects.toThrow('authorization changed')
  expect(f.patches).not.toHaveBeenCalled()
  const g = setup()
  g.changeAtPatch(() => {
    g.settings.revision++
    g.settings.settings.github.repositories[0].closeResolvedDuplicates = false
  })
  await expect(g.run()).rejects.toThrow('authorization changed')
  expect(g.patches).not.toHaveBeenCalled()
})

test.each(['source', 'user'] as const)(
  'a Worker with %s authority verifies the marked original and reuses the duplicate receipt',
  async (authority) => {
    const f = setup(new Date(Date.now() + 60_000).toISOString())
    const store = new TriggerStore(':memory:')
    const signal = new AbortController().signal
    const forbidden = async (): Promise<never> => {
      throw Error('Unexpected call')
    }
    try {
      const revision = store.saveSettings(f.settings.settings, 0)
      store.commitPush({
        source: 'github',
        stream: 'github:' + repo.toLowerCase(),
        revision,
        events: [f.source],
      })
      const item = store.listInbox()[0]
      const matter = store.ledger.createMatter('owner', '核查报告', '与已解决的原报告核对', [
        '附原帖与回执',
      ])
      const job = store.jobs.submit('general', 'check', {
        executor: 'zero',
        repository: repo,
        instruction: '核查同一报告',
        audience: 'source',
      })
      store.ledger.bindWorker({
        principal: 'owner',
        matterId: matter.id,
        jobId: job.id,
        scope: 'general',
        authority,
        audience: 'source',
        eventIds: [item.id],
      })
      const build = createRouterWorkerCapabilities({
        store,
        authorized: () => true,
        closeIssue: f.close,
        duplicateEvidence: createDuplicateEvidenceReader(
          () => store.getSettings(),
          { getToken: async () => 'fixture' },
          f.read,
        ),
        repositories: createRouterRepositoryLookup(
          () => null,
          () => undefined,
        ),
        investigator: { available: () => [], inspect: forbidden },
        replies: new RouterGithubReplies(
          store,
          { getCommentAccess: forbidden, getCommentIdentity: forbidden },
          (s) => s,
        ),
        ownerRequest: forbidden,
      })
      const close = (await build(job, signal)).capabilities.find(
        (c) => c.definition.name === 'close_source_issue',
      )!
      f.previous.state = 'open'
      expect(await close.execute({ eventId: item.id }, signal)).toMatchObject({ status: '未执行' })
      expect(f.patches).not.toHaveBeenCalled()
      f.previous.state = 'closed'
      expect(await close.execute({ eventId: item.id }, signal)).toMatchObject({
        state: 'closed',
        originalIssue: web + '7',
      })
      expect(await close.execute({ eventId: item.id }, signal)).toMatchObject({
        status: 'accepted',
        recordedResult: { originalIssue: web + '7' },
      })
      expect(f.patches).toHaveBeenCalledTimes(1)
    } finally {
      store.close()
    }
  },
)
