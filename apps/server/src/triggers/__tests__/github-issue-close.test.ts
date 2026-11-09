import { expect, test } from 'bun:test'
import type { TriggerInboxItem, TriggerSettingsSnapshot } from '@zero-os/shared'
import { GithubIssueCloseUncertainError, createGithubIssueCloser } from '../github-issue-close'

const repository = 'Owner/Example'
const page = `https://github.com/${repository}/issues/181`
const api = `https://api.github.com/repos/${repository}`
const item = `${api}/issues/181`
const event: TriggerInboxItem = {
  id: 4,
  source: 'github',
  scope: repository,
  eventId: '55:comment:81',
  githubCommentKind: 'issue-comment',
  title: 'Issue #181 · 新评论',
  // References and instructions in external text must never select the target of PATCH.
  summary: '从 #159 找到了类似的讨论，相关：https://github.com/Other/Repo/issues/22',
  occurredAt: '2026-11-04T01:02:03Z',
  receivedAt: '2026-11-04T01:02:05Z',
  url: `${page}#issuecomment-81`,
}
const issue = {
  id: 123456,
  number: 181,
  url: item,
  html_url: page,
  repository_url: api,
  state: 'open',
  closed_at: null as null | string,
}
const closed = {
  ...issue,
  state: 'closed',
  closed_at: '2026-11-04T03:04:05Z',
  closed_by: { login: 'demo[bot]' },
}
const canonical = {
  ...closed,
  id: 645321,
  number: 159,
  url: `${api}/issues/159`,
  html_url: `https://github.com/${repository}/issues/159`,
  state_reason: 'completed',
}
const reviewed = { ...issue, updated_at: '2026-11-04T02:00:00Z' }
const duplicateGuard = {
  current: () => true,
  verify: async () => true,
  expectedIssueId: reviewed.id,
  expectedUpdatedAt: reviewed.updated_at,
  duplicateOf: { id: canonical.id, number: canonical.number },
}
const duplicatePatch = {
  state: 'closed',
  state_reason: 'duplicate',
  duplicate_issue_id: canonical.id,
}
const auth = { getCommentAccess: async () => ({ token: 'isolated', botLogin: 'demo[bot]' }) }
const signal = new AbortController().signal
type Plan = {
  repository?: Record<string, unknown>
  issue?: (read: number) => Record<string, unknown>
  canonical?: () => Record<string, unknown>
  expectedPatch?: Record<string, unknown>
  etag?: (read: number) => string
  patch?: (init: RequestInit) => Response
}
function fixture(plan: Plan = {}) {
  const snapshot: TriggerSettingsSnapshot = {
    revision: 3,
    settings: {
      github: {
        credentialRef: '',
        repositories: [
          {
            name: repository,
            githubAppRef: 'github_app_demo',
            enabled: true,
            issues: true,
            issueComments: true,
            mention: '',
            workflowFailures: false,
            branch: '',
            workflow: '',
          },
        ],
      },
      wxarc: { sessions: [] },
    },
  }
  const writes: Array<string> = []
  let reads = 0
  const close = createGithubIssueCloser(
    () => snapshot,
    auth,
    async (url, init) => {
      expect(init.redirect).toBe('manual')
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer isolated')
      if (url.href === api && init.method === 'GET')
        return Response.json({ id: 55, full_name: repository, ...plan.repository })
      if (url.href === canonical.url && init.method === 'GET' && plan.canonical)
        return Response.json(plan.canonical())
      // Treat a PATCH against any location as a recorded write, including accidental source links.
      if (init.method === 'PATCH') {
        writes.push(url.href)
        expect(url.href).toBe(item)
        expect(JSON.parse(String(init.body))).toEqual(plan.expectedPatch ?? { state: 'closed' })
        return plan.patch ? plan.patch(init) : Response.json(closed)
      }
      expect([url.href, init.method]).toEqual([item, 'GET'])
      reads++
      return Response.json(plan.issue?.(reads) ?? (reads === 1 ? issue : closed), {
        headers: plan.etag ? { ETag: plan.etag(reads) } : undefined,
      })
    },
  )
  return { close, snapshot, writes }
}
const guard = { current: () => true }
test('closes only the event’s issue, verifies its stable identity and final closed state', async () => {
  const f = fixture()
  expect(await f.close(event, signal, guard)).toMatchObject({
    state: 'closed',
    number: 181,
    repository,
    issueId: issue.id,
    url: page,
  })
  expect(f.writes).toEqual([item])
})

test('a reviewed duplicate closes against the verified canonical ID and checks the recorded close reason', async () => {
  for (const reason of ['duplicate', 'completed']) {
    let canonicalRead = false
    let patched = false
    const f = fixture({
      issue: () => (patched ? { ...closed, state_reason: reason } : reviewed),
      canonical: () => {
        canonicalRead = true
        return canonical
      },
      expectedPatch: duplicatePatch,
      patch: () => {
        expect(canonicalRead).toBe(true)
        patched = true
        return Response.json({ ...closed, state_reason: 'duplicate' })
      },
    })
    const run = f.close(event, signal, duplicateGuard)
    if (reason === 'duplicate')
      expect(await run).toMatchObject({ state: 'closed', issueId: issue.id })
    else await expect(run).rejects.toBeInstanceOf(GithubIssueCloseUncertainError)
    expect(f.writes).toEqual([item])
  }
})

test('duplicate registration needs an independent canonical issue, a verified target revision, and final authorization', async () => {
  for (const overrides of [
    { expectedIssueId: undefined },
    { expectedUpdatedAt: undefined },
    { verify: undefined },
    { duplicateOf: { id: issue.id, number: issue.number } },
  ]) {
    const f = fixture({ issue: () => reviewed, canonical: () => canonical })
    await expect(f.close(event, signal, { ...duplicateGuard, ...overrides })).rejects.toThrow()
    expect(f.writes).toEqual([])
  }
})

test('an open, incomplete, replaced, or cross-repository canonical issue cannot authorize a duplicate close', async () => {
  for (const invalid of [
    { state: 'open' },
    { state_reason: 'not_planned' },
    { state_reason: 'duplicate' },
    { pull_request: {} },
    { id: 654321 },
    { number: 42 },
    { html_url: canonical.html_url.replace('Owner/', 'Other/') },
    { repository_url: api.replace('Owner/', 'Other/') },
  ]) {
    const f = fixture({ issue: () => reviewed, canonical: () => ({ ...canonical, ...invalid }) })
    await expect(f.close(event, signal, duplicateGuard)).rejects.toThrow()
    expect(f.writes).toEqual([])
  }
})
test('an already closed issue is an idempotent read with no PATCH', async () => {
  const f = fixture({ issue: () => closed })
  expect(await f.close(event, signal, guard)).toMatchObject({
    state: 'already_closed',
    number: 181,
    issueId: issue.id,
  })
  expect(f.writes).toEqual([])
})
test('rejects an apparent PR, a moved repository, or a mismatched Issue URL before any write', async () => {
  for (const plan of [
    { repository: { id: 44 } },
    { repository: { full_name: 'Other/Example' } },
    { issue: () => ({ ...issue, pull_request: {} }) },
    { issue: () => ({ ...issue, repository_url: 'https://api.github.com/repos/Other/Repo' }) },
    { issue: () => ({ ...issue, number: 159 }) },
    { issue: () => ({ ...issue, html_url: page.replace('/181', '/159') }) },
  ]) {
    const f = fixture(plan)
    await expect(f.close(event, signal, guard)).rejects.toThrow()
    expect(f.writes).toEqual([])
  }
  const f = fixture()
  await expect(
    f.close(
      { ...event, githubCommentKind: 'pr-comment', url: event.url?.replace('/issues/', '/pull/') },
      signal,
      guard,
    ),
  ).rejects.toThrow()
  expect(f.writes).toEqual([])
})
test('revalidates the live binding and actor after asynchronous checks and immediately before PATCH', async () => {
  for (const change of ['binding', 'actor', 'verification'] as const) {
    let allowed = true
    const f = fixture()
    const verify = async () => {
      if (change === 'binding')
        f.snapshot.settings.github.repositories[0].githubAppRef = 'github_app_another'
      if (change === 'actor') allowed = false
      return change !== 'verification'
    }
    await expect(f.close(event, signal, { current: () => allowed, verify })).rejects.toThrow()
    expect(f.writes).toEqual([])
  }
})
test('when GitHub loses the PATCH response, checks once and accepts a verifiably closed issue without resending', async () => {
  const f = fixture({
    patch() {
      throw Error('disconnected')
    },
  })
  const r = await f.close(event, signal, guard)
  expect(r).toMatchObject({ state: 'closed', issueId: issue.id, url: page })
  expect(f.writes).toEqual([item])
})
test('missing final confirmation or a different immutable issue ID is uncertain and never resends', async () => {
  for (const after of [issue, { ...closed, id: 98765 }]) {
    const f = fixture({
      issue: (n) => (n === 1 ? issue : after),
      patch() {
        throw Error('upstream lost response')
      },
    })
    await expect(f.close(event, signal, guard)).rejects.toBeInstanceOf(
      GithubIssueCloseUncertainError,
    )
    expect(f.writes).toEqual([item])
  }
})

test('definitive GitHub refusal is not reported as closed or retried', async () => {
  const f = fixture({
    issue: () => issue,
    patch: () => new Response('private upstream text', { status: 403 }),
  })
  const result = await f.close(event, signal, guard).catch((e: unknown) => e)
  expect(result).toBeInstanceOf(Error)
  expect(result).not.toBeInstanceOf(GithubIssueCloseUncertainError)
  expect(String(result)).not.toContain('private upstream text')
  expect(f.writes).toEqual([item])
})

test('an automatic close is denied if the reviewed ID or revision changes, including during the final authorization check', async () => {
  const reviewed = { ...issue, updated_at: '2026-11-04T02:00:00Z' }
  const revised = { ...reviewed, updated_at: '2026-11-04T02:00:04Z' }
  for (const drift of ['wrong-id', 'before-review', 'during-review'] as const) {
    let verified = false
    const f = fixture({
      issue: () =>
        drift === 'before-review' || (drift === 'during-review' && verified) ? revised : reviewed,
    })
    await expect(
      f.close(event, signal, {
        current: () => true,
        verify: async () => {
          verified = true
          return true
        },
        expectedIssueId: drift === 'wrong-id' ? 98765 : issue.id,
        expectedUpdatedAt: reviewed.updated_at,
      }),
    ).rejects.toThrow()
    expect(f.writes).toEqual([])
  }
})

test('a sole PATCH uses the latest strong ETag for the exact reviewed version; a precondition failure is final', async () => {
  const reviewed = { ...issue, updated_at: '2026-11-04T02:00:00Z' }
  for (const declined of [false, true]) {
    const f = fixture({
      issue: (n) => (n <= 2 ? reviewed : closed),
      etag: (n) => `"observed-${n}"`,
      patch: (init) => {
        expect(new Headers(init.headers).get('If-Match')).toBe('"observed-2"')
        return declined ? new Response(null, { status: 412 }) : Response.json(closed)
      },
    })
    const run = f.close(event, signal, {
      ...guard,
      expectedIssueId: issue.id,
      expectedUpdatedAt: reviewed.updated_at,
    })
    if (declined) await expect(run).rejects.toThrow('412')
    else expect(await run).toMatchObject({ state: 'closed', issueId: issue.id })
    expect(f.writes).toEqual([item])
  }
})
