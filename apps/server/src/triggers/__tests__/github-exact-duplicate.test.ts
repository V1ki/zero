import { expect, mock, test } from 'bun:test'
import { findExactResolvedDuplicate } from '../github-exact-duplicate'
const repository = 'Wheel/Queue'
const base = 'https://github.com/Wheel/Queue/issues/'
const user = { type: 'User', id: 13 }
const body = [
  'Dispatch stalls while processing a queued acknowledgement from an expired websocket; a backoff timer does not release the lock.',
  'Request ID: c9f67b1a2e34530de78ab6d1d6798270',
  'QueueExpiredError: cannot acknowledge a completed transfer in the retry callback',
  '    at flushTransaction (src/queue/transfer.ts:241:7)',
  '    at dispatchAcknowledgement (src/bridge/receiver.ts:78:13)',
].join('\n')
const original = {
  id: 23,
  number: 14,
  title: 'Queue transfer lock leaked on expired socket',
  body,
  url: '',
  html_url: `${base}14`,
  repository_url: 'https://api.github.com/repos/Wheel/Queue',
  user,
  state: 'closed',
  state_reason: 'completed',
  created_at: '2024-01-01T04:00:00Z',
  closed_at: '2024-02-02T13:00:00Z',
}
const current = {
  ...original,
  id: 71,
  number: 25,
  html_url: `${base}25`,
  state: 'open',
  closed_at: null,
  state_reason: null,
  comments: 0,
  created_at: '2024-03-04T13:00:00Z',
  updated_at: '2024-03-04T13:00:00Z',
}
function lookup(
  c: Record<string, unknown> = current,
  previous: Record<string, unknown>[] = [original],
  page: Record<string, unknown> = {},
) {
  const get = mock(async (path: string) => previous.find((p) => path === `/issues/${p.number}`))
  const search = mock(async (q: string) => {
    expect(q).toMatch(/^repo:Wheel\/Queue is:issue in:title "[\p{L}\d]+"$/u)
    return { incomplete_results: false, total_count: previous.length, items: previous, ...page }
  })
  return {
    run: () => findExactResolvedDuplicate({ repository, current: c, get, search }),
    get,
    search,
  }
}

test('returns a pinned unique completed Issue for a second copy of the same reported incident', async () => {
  const read = lookup({ ...current, body: `${body.replaceAll('\n', '\r\n')}\n` })
  expect(await read.run()).toEqual({ id: 23, number: 14, url: `${base}14` })
  expect(read.get.mock.calls).toEqual([['/issues/14']])
})

test('similar title, shared template, copied stack, edited report or different reporter is not duplicate proof', async () => {
  const differences = [
    { title: `${current.title} now` },
    { body: body.replace('241:7', '242:7') },
    { body: body.replace('completed', 'rejected') },
    { user: { type: 'User', id: 12 } },
    { user: { type: 'Bot', id: 13 } },
    { comments: 1 },
    { assignees: [{ id: 12 }] },
    { labels: [{ name: 'do-not-close' }] },
    { updated_at: '2024-03-05T13:00:00Z' },
    { state: 'closed' },
    { pull_request: {} },
    { html_url: `${base}51` },
  ]
  for (const x of differences) expect(await lookup({ ...current, ...x }).run()).toBeNull()
  for (const bad of [
    'Boilerplate: please fill in the stack trace.',
    `<!-- paste trace -->\n${body}`,
    body.replace(/Request ID:[^\n]+/, 'the standard upload failed'),
    body.replace('at flushTransaction (src/queue/transfer.ts:241:7)', ''),
    body.replace('c9f67b1a2e34530de78ab6d1d6798270', 'deadbeefdeadbeefdeadbeefdeadbeef'),
    `Regression after upgrading: ${body}`,
  ]) {
    const f = lookup({ ...current, body: bad }, [{ ...original, body: bad }])
    expect(await f.run()).toBeNull()
    expect(f.search).not.toHaveBeenCalled()
  }
})

test('fresh pinned build, incident date and identical report can identify the historical occurrence without a trace ID', async () => {
  const withBuild = body.replace(
    /Request ID:[^\n]+/,
    'Commit: c9f67b1a2e34530de78ab6d1d6798270\nFailure timestamp: 2024-01-01T02:01:03Z',
  )
  expect(
    await lookup({ ...current, body: withBuild }, [{ ...original, body: withBuild }]).run(),
  ).toEqual({ id: 23, number: 14, url: `${base}14` })
  const future = withBuild.replace('2024-01-01', '2024-02-04')
  expect(
    await lookup({ ...current, body: future }, [{ ...original, body: future }]).run(),
  ).toBeNull()
})
test('a second candidate, an open or uncompleted canonical, or a partial search blocks automation', async () => {
  for (const diff of [
    { state: 'open' },
    { state_reason: null },
    { state_reason: 'not_planned' },
    { pull_request: {} },
    { closed_at: current.created_at },
    { repository_url: 'https://api.github.com/repos/Other/Repo' },
  ]) {
    expect(await lookup(current, [{ ...original, ...diff }]).run()).toBeNull()
  }
  expect(
    await lookup(current, [
      original,
      { ...original, id: 91, number: 20, html_url: `${base}20` },
    ]).run(),
  ).toBeNull()
  expect(await lookup(current, [original], { total_count: 3 }).run()).toBeNull()
  expect(await lookup(current, [original], { incomplete_results: true }).run()).toBeNull()
})
test('search metadata is not authority over the canonical issue returned by GET', async () => {
  const read = lookup(current, [{ ...original, id: 190, body: body.replace('241:7', '242:7') }], {
    items: [original],
  })
  expect(await read.run()).toBeNull()
})
