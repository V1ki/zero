import { describe, expect, test } from 'bun:test'
import type { TriggerGithubRepository } from '@zero-os/shared'
import {
  GithubTriggerError,
  getGithubRepository,
  listGithubRepositories,
  pollGithub,
} from '../github'

const signal = new AbortController().signal
const settings: TriggerGithubRepository = {
  name: 'sample/project',
  branch: 'main',
  workflow: 'Release',
  mention: '',
  workflowFailures: true,
  enabled: true,
}
const time = (offset: number) => new Date(Date.now() + offset * 1000).toISOString()
const json = (data: unknown, headers?: Record<string, string>) => Response.json(data, { headers })
const apiRepo = () => json({ id: 7, full_name: settings.name })
const endpoint = '/repos/sample/project'
function run(id: number, status = 'completed', branch = 'main', age = 0) {
  return {
    id,
    repository: { id: 7 },
    name: 'Release',
    path: '.github/workflows/ci.yml',
    head_branch: branch,
    run_attempt: 1,
    status,
    conclusion: status === 'completed' ? 'failure' : null,
    created_at: time(age),
    updated_at: time(age),
  }
}

describe('GitHub trigger source', () => {
  test('manual repository and allowlisted pagination never forward a token to another origin', async () => {
    const calls: string[] = []
    const fetcher = async (url: URL, init: RequestInit) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-credential')
      calls.push(url.pathname)
      return new Response(null, {
        status: 302,
        headers: { location: 'https://elsewhere.invalid/private' },
      })
    }
    await expect(
      getGithubRepository('sample/project', 'test-credential', signal, fetcher),
    ).rejects.toThrow('Unsafe GitHub')
    expect(calls).toEqual([endpoint])
    await expect(
      getGithubRepository('sample/..', 'test-credential', signal, fetcher),
    ).rejects.toThrow('owner/repository')
    expect(await listGithubRepositories(undefined, signal, fetcher)).toEqual([])
    const results = await listGithubRepositories('token', signal, async (url) =>
      url.searchParams.get('page')
        ? json([{ full_name: 'sample/b' }])
        : json([{ full_name: 'sample/a' }], {
            link: '<https://api.github.com/user/repos?page=2>; rel="next"',
          }),
    )
    expect(results).toEqual([{ name: 'sample/a' }, { name: 'sample/b' }])
  })

  test('branch filter, activation boundary, repeat runs and cached 304', async () => {
    const start = time(-30)
    const fetcher = async (url: URL) => {
      if (url.pathname === endpoint) return apiRepo()
      expect(url.searchParams.get('branch')).toBe('main')
      return json(
        {
          workflow_runs: [
            { ...run(1), run_attempt: 2 },
            run(2, 'completed', 'else'),
            { ...run(3), name: 'Other' },
            run(4, 'completed', 'main', -500),
          ],
        },
        { etag: '"runs"' },
      )
    }
    const first = await pollGithub(settings, null, undefined, signal, start, fetcher)
    expect(first.events.map((event) => event.eventId)).toEqual(['7:run:1:2:failure'])
    expect(first.events[0].url).toEndWith('/1/attempts/2')
    const cached = await pollGithub(
      settings,
      first.cursor,
      undefined,
      signal,
      start,
      async (_url, init) => {
        expect(new Headers(init.headers).get('if-none-match')).toBe('"runs"')
        return new Response(null, { status: 304 })
      },
    )
    expect(cached.events).toEqual([])
  })

  test('reads subsequent pages and keeps following observed in-flight runs', async () => {
    const start = time(-4000)
    const first = await pollGithub(settings, null, undefined, signal, start, async (url) => {
      if (url.pathname === endpoint) return apiRepo()
      if (url.searchParams.has('page'))
        return json({ workflow_runs: [run(3, 'in_progress', 'main', -3)] })
      return json(
        { workflow_runs: [run(1)] },
        { link: `<https://api.github.com${endpoint}/actions/runs?page=2>; rel="next"` },
      )
    })
    expect(JSON.parse(first.cursor).pending).toEqual([3])
    const repeated = await pollGithub(
      settings,
      first.cursor,
      undefined,
      signal,
      start,
      async (url) => {
        if (url.pathname.endsWith('/3'))
          return json({ ...run(3, 'completed', 'main', -3800), updated_at: time(-3) })
        return json({ workflow_runs: [run(21, 'completed', 'other')] })
      },
    )
    expect(repeated.events.map((event) => event.eventId)).toEqual(['7:run:3:1:failure'])
    expect(JSON.parse(repeated.cursor).pending).toEqual([])
  })

  test('falls back to the uncapped list only after 1,000 filtered results inside the watch window', async () => {
    const start = time(-180)
    const pages = Array.from({ length: 100 }, (_, i) => ({ ...run(i + 1), conclusion: 'success' }))
    let fallback = 0
    const result = await pollGithub(settings, null, undefined, signal, start, async (url) => {
      if (url.pathname === endpoint) return apiRepo()
      if (!url.searchParams.has('branch')) {
        fallback++
        return json({ workflow_runs: [run(1011)] })
      }
      const page = Number(url.searchParams.get('page') ?? 1)
      return json(
        { workflow_runs: pages },
        page < 10
          ? {
              link: `<https://api.github.com${endpoint}/actions/runs?branch=main&page=${page + 1}>; rel="next"`,
            }
          : {},
      )
    })
    expect(fallback).toBe(1)
    expect(result.events.map((e) => e.eventId)).toEqual(['7:run:1011:1:failure'])
  })

  test('PR discussions enforce source, exact mention, time and target branch', async () => {
    const start = time(-60)
    const comment = (id: number, number: number, body: string, kind = 'pull') => ({
      id,
      body,
      user: { login: 'author' },
      created_at: time(-2),
      html_url: `https://github.com/sample/project/${kind}/${number}#issuecomment-${id}`,
    })
    let lookups = 0
    const result = await pollGithub(
      { ...settings, workflowFailures: false, mention: '@zero' },
      null,
      undefined,
      signal,
      start,
      async (url) => {
        if (url.pathname === endpoint) return apiRepo()
        if (url.pathname.includes('/pulls/')) {
          lookups++
          return json({ base: { ref: url.pathname.endsWith('/42') ? 'main' : 'else' } })
        }
        return json([
          comment(3, 42, 'hi @ZERO!'),
          comment(4, 42, '@zero please'),
          comment(5, 44, '@zero on wrong branch'),
          comment(6, 42, 'address@zero'),
          comment(7, 42, 'ping @zero-bot'),
          comment(8, 42, '@zero', 'issues'),
          { ...comment(9, 42, '@zero'), created_at: time(-300) },
        ])
      },
    )
    expect(lookups).toBe(2)
    expect(result.events.map((event) => event.eventId)).toEqual(['7:comment:3', '7:comment:4'])
  })

  test('repository name reuse cannot transfer a previous private comment subscription', async () => {
    const start = time(-30)
    const repo = { ...settings, workflowFailures: false, branch: '', mention: 'zero' }
    const initial = await pollGithub(repo, null, undefined, signal, start, async (url) =>
      url.pathname === endpoint ? apiRepo() : json([]),
    )
    await expect(
      pollGithub(repo, initial.cursor, undefined, signal, start, async (url) =>
        url.pathname === endpoint
          ? json({ id: 8, full_name: settings.name })
          : json([
              {
                id: 4,
                body: '@zero ping',
                user: { login: 'author' },
                created_at: time(-2),
                html_url: 'https://github.com/sample/project/pull/2#issuecomment-4',
              },
            ]),
      ),
    ).rejects.toThrow('identity changed')
  })

  test('reports primary and secondary rate limits safely without checkpointing a partial page', async () => {
    for (const [status, headers, body] of [
      [429, { 'retry-after': '3' }, ''],
      [403, {}, '{"message":"You have exceeded a secondary rate limit"}'],
    ] as const) {
      const failure = await pollGithub(
        settings,
        null,
        undefined,
        signal,
        time(-60),
        async (url) => {
          if (url.pathname === endpoint) return apiRepo()
          if (!url.searchParams.has('page'))
            return json(
              { workflow_runs: [run(1)] },
              { link: `<https://api.github.com${endpoint}/actions/runs?page=2>; rel="next"` },
            )
          return new Response(body, { status, headers })
        },
      ).catch((error) => error)
      expect(failure).toBeInstanceOf(GithubTriggerError)
      expect(failure.status).toBe(status)
      expect(failure.retryAfterMs).toBe(status === 429 ? 3000 : 60_000)
      expect(failure.cursor).toBeUndefined()
    }
  })
})
