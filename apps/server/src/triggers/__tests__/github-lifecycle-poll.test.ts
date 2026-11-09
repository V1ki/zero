import { expect, test } from 'bun:test'
import { type TriggerGithubRepository, githubLifecycleKind } from '@zero-os/shared'
import {
  GithubTriggerError,
  checkGithubReadPermissions,
  normalizeGithubWebhook,
  pollGithub,
} from '../github'

const repo: TriggerGithubRepository = {
  name: 'test/service',
  enabled: true,
  workflowFailures: false,
  mention: '',
  workflow: '',
  branch: 'old-ci-only',
  issues: true,
  pullRequests: true,
}
const identity = { id: 12, full_name: repo.name }
const path = '/repos/test/service'
const repositoryUrl = `https://api.github.com${path}`
const signal = new AbortController().signal
const at = (minute: number) => new Date(Date.UTC(2025, 0, 1, 0, minute)).toISOString()
const issue = {
  number: 5,
  body: 'Problem statement\nwith information',
  title: 'Test issue',
  repository_url: repositoryUrl,
  created_at: at(1),
  closed_at: null,
}
const pr = {
  ...issue,
  number: 6,
  title: 'Target PR',
  base: { ref: 'main', repo: identity },
  created_at: at(0),
  updated_at: at(8),
  closed_at: at(8),
  merged_at: at(8),
}
function page(rows: unknown, next?: string) {
  return Response.json(rows, {
    headers: next ? { link: `<https://api.github.com${next}>; rel="next"` } : {},
  })
}
function fail(url: URL): never {
  throw new Error(`Unexpected HTTP request: ${url.pathname}`)
}
const cursor = JSON.stringify({ repositoryId: 12, scannedAt: at(1), pending: [] })

test('poll replays issue and PR transitions across pages, merging the final close and keeping earlier close/reopen pairs', async () => {
  const poll = await pollGithub(repo, cursor, undefined, signal, at(1), async (url) => {
    switch (url.pathname) {
      case path:
        return page(identity)
      case `${path}/issues`:
        expect(url.searchParams.get('since')).toBe('2025-01-01T00:00:59.000Z')
        return page([{ ...issue, number: 6, pull_request: {} }], '/repositories/12/issues?page=2')
      case '/repositories/12/issues':
        return page([issue])
      case `${path}/pulls`:
        return page([pr, { ...pr, updated_at: at(0) }], `${path}/pulls?page=2`)
      case `${path}/issues/5/events`:
        return page([
          { event: 'closed', created_at: at(2) },
          { event: 'reopened', created_at: at(3) },
          { event: 'labeled', created_at: at(4) },
        ])
      case `${path}/issues/6/events`:
        return page(
          [
            { event: 'reopened', created_at: at(0) },
            { event: 'closed', created_at: at(4) },
            { event: 'reopened', created_at: at(5) },
            { event: 'merged', created_at: at(8) },
          ],
          '/repositories/12/issues/6/events?page=2',
        )
      case '/repositories/12/issues/6/events':
        return page([{ event: 'closed', created_at: at(8) }])
      default:
        return fail(url)
    }
  })
  const expected = [
    ['issue', 'opened', 1],
    ['issue', 'closed', 2],
    ['issue', 'reopened', 3],
    ['pr', 'closed', 4],
    ['pr', 'reopened', 5],
    ['pr', 'merged', 8],
  ] as const
  expect(poll.events.map((e) => e.eventId)).toEqual(
    expected.map(
      ([kind, action, time]) =>
        `12:${kind}:${kind === 'issue' ? 5 : 6}:${action}:${Date.parse(at(time))}`,
    ),
  )
  expect(poll.events[0].summary).toContain('采集时正文摘录：Problem statement with information')
  expect(poll.events.map((e) => githubLifecycleKind(e.eventId))).toEqual(expected.map((x) => x[0]))
  for (const [idx, [kind, action, min]] of expected.entries()) {
    const actual = await normalizeGithubWebhook(
      repo,
      kind === 'issue' ? 'issues' : 'pull_request',
      {
        repository: identity,
        action: action === 'merged' ? 'closed' : action,
        ...(kind === 'issue'
          ? { issue: { ...issue, updated_at: at(min), closed_at: at(min) } }
          : {
              number: 6,
              pull_request: {
                ...pr,
                updated_at: at(min),
                closed_at: at(min),
                merged: action === 'merged',
                merged_at: action === 'merged' ? at(min) : null,
              },
            }),
      },
      () => undefined,
      signal,
    )
    expect(actual).toEqual([poll.events[idx]])
  }
})

test('each selection uses only its own discovery endpoint; a private PR-only grant can poll without listing issues', async () => {
  for (const kind of ['pr', 'issue'] as const) {
    const modes = { issues: kind === 'issue', pullRequests: kind === 'pr' }
    const capture = (actual: string, method: string) => expected.push([actual, method])
    const expected: string[][] = []
    await checkGithubReadPermissions(
      repo.name,
      'fixture',
      { workflowFailures: false, prComments: false, prBase: false, ...modes },
      signal,
      async (url, init) => {
        capture(url.pathname, init.method ?? 'GET')
        return new Response(null)
      },
    )
    await pollGithub({ ...repo, ...modes }, cursor, 'fixture', signal, at(1), async (url, init) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture')
      capture(url.pathname, init.method ?? 'GET')
      return page([])
    })
    const endpoint = `${path}/${kind === 'pr' ? 'pulls' : 'issues'}`
    expect(expected).toEqual([
      [endpoint, 'HEAD'],
      [endpoint, 'GET'],
    ])
  }
})

test('never commits a partial scan or transfers an issue to a reused name', async () => {
  const scan = (mode: 'foreign_next' | 'partial' | 'renamed') =>
    pollGithub({ ...repo, pullRequests: false }, cursor, undefined, signal, at(1), async (url) => {
      if (url.pathname === `${path}/issues`) return page([issue])
      if (url.pathname === `${path}/issues/5/events`) {
        if (mode === 'partial')
          return new Response('', { status: 429, headers: { 'retry-after': '60' } })
        return page(
          [],
          mode === 'foreign_next' ? '/repos/other/private/issues/5/events?page=2' : undefined,
        )
      }
      if (url.pathname === path) return page({ ...identity, id: 99 })
      return fail(url)
    })
  await expect(scan('foreign_next')).rejects.toThrow('pagination')
  await expect(scan('partial')).rejects.toBeInstanceOf(GithubTriggerError)
  await expect(scan('renamed')).rejects.toThrow('identity changed')
})

test('a newly selected lifecycle kind can backfill without rewinding existing workflow or mention filters', async () => {
  const recentCursor = JSON.stringify({ repositoryId: 12, scannedAt: at(65), pending: [] })
  const got = await pollGithub(
    { ...repo, pullRequests: false, mention: 'zero' },
    recentCursor,
    undefined,
    signal,
    at(0),
    async (url) => {
      if (url.pathname === path) return page(identity)
      if (url.pathname === `${path}/issues/comments`) {
        expect(url.searchParams.get('since')).toBe(at(60))
        return page([])
      }
      if (url.pathname === `${path}/issues`) return page([issue])
      if (url.pathname === `${path}/issues/5/events`) return page([])
      return fail(url)
    },
    at(1),
  )
  expect(got.events.map((e) => [e.title, e.occurredAt])).toEqual([['Issue #5 · 新建', at(1)]])
})
