import { describe, expect, mock, test } from 'bun:test'
import type { TriggerGithubPermissionReport } from '@zero-os/shared'
import { checkGithubReadPermissions } from '../github'

const repo = 'sample/project'
const full = { workflowFailures: true, prComments: true, prBase: true }
const actions = { workflowFailures: true, prComments: false, prBase: false }
const signal = new AbortController().signal

describe('GitHub repository permission check', () => {
  test('only probes selected repository endpoints with no body access or token redirects', async () => {
    const fetcher = mock(async (url: URL, init: RequestInit) => {
      expect(init.method).toBe('HEAD')
      expect(init.redirect).toBe('manual')
      expect(url.origin).toBe('https://api.github.com')
      expect(url.search).toBe('?per_page=1')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-fixture')
      return new Response(null, { status: 200 })
    })
    expect(
      await checkGithubReadPermissions(
        repo,
        'test-fixture',
        { ...full, prComments: false },
        signal,
        fetcher,
      ),
    ).toEqual({
      access: 'credential',
      checks: [
        { resource: 'actions', status: 'readable' },
        { resource: 'prBase', status: 'readable' },
      ],
    })
    expect(fetcher.mock.calls.map(([url]) => url.pathname)).toEqual([
      '/repos/sample/project/actions/runs',
      '/repos/sample/project/pulls',
    ])
    await expect(
      checkGithubReadPermissions('sample/../private', 'test-fixture', actions, signal, fetcher),
    ).rejects.toThrow('owner/repository')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test('denials, absent repositories, rate limits, redirects and service failures are distinguished', async () => {
    type Result = Omit<TriggerGithubPermissionReport['checks'][number], 'resource'>
    const cases: [number, Record<string, string>, Result][] = [
      [401, {}, { status: 'denied' }],
      [403, {}, { status: 'denied' }],
      [404, {}, { status: 'not_found' }],
      [403, { 'retry-after': '10' }, { status: 'rate_limited', retryAfterMs: 10_000 }],
      [403, { 'x-ratelimit-remaining': '0' }, { status: 'rate_limited', retryAfterMs: 60_000 }],
      [429, {}, { status: 'rate_limited', retryAfterMs: 60_000 }],
      [
        302,
        { location: 'https://api.github.com/repos/different/project/actions/runs' },
        { status: 'unavailable' },
      ],
      [503, {}, { status: 'unavailable' }],
    ]
    for (const [status, headers, expected] of cases) {
      const fetcher = mock(async (_url: URL, init: RequestInit) => {
        expect(init.redirect).toBe('manual')
        expect(new Headers(init.headers).has('authorization')).toBe(false)
        return new Response(null, { status, headers })
      })
      expect(await checkGithubReadPermissions(repo, undefined, actions, signal, fetcher)).toEqual({
        access: 'anonymous',
        checks: [{ resource: 'actions', ...expected }],
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
    const offline = await checkGithubReadPermissions(repo, undefined, actions, signal, async () => {
      throw new Error('private diagnostic')
    })
    expect(offline.checks).toEqual([{ resource: 'actions', status: 'unavailable' }])
  })

  test('only HEAD method errors permit GET fallback and response content is canceled unread', async () => {
    for (const status of [405, 501]) {
      const cancel = mock(() => {})
      const pull = mock(() => {
        throw new Error('private content should never be read')
      })
      const fetcher = mock(async (_url: URL, init: RequestInit) => {
        if (init.method === 'HEAD') return new Response(null, { status })
        const stream = new ReadableStream({ pull, cancel }, { highWaterMark: 0 })
        return new Response(stream, { status: 200 })
      })
      const result = await checkGithubReadPermissions(
        repo,
        undefined,
        { workflowFailures: false, prComments: true, prBase: false },
        signal,
        fetcher,
      )
      expect(result.checks).toEqual([{ resource: 'prComments', status: 'readable' }])
      expect(fetcher.mock.calls.map(([_url, init]) => init.method)).toEqual(['HEAD', 'GET'])
      expect(pull).not.toHaveBeenCalled()
      expect(cancel).toHaveBeenCalledTimes(1)
    }
  })
})
