import { expect, test } from 'bun:test'
import { readGithubRepositoryResource } from '../github-repository-reader'
const stop = () => new AbortController().signal
const head = 'a'.repeat(40)
const base = 'b'.repeat(40)

test('authenticated repository inventory excludes PRs without discarding pagination', async () => {
  const result = await readGithubRepositoryResource(
    'org/repo',
    'fixture-secret',
    { resource: 'issues', page: 2 },
    stop(),
    async (url, init) => {
      expect(url.origin).toBe('https://api.github.com')
      expect(url.pathname).toBe('/repos/org/repo/issues')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-secret')
      expect(init.redirect).toBe('manual')
      expect(url.searchParams.get('page')).toBe('2')
      return Response.json(
        [
          { number: 1, title: 'Bug' },
          { number: 2, pull_request: {} },
        ],
        { headers: { link: '<https://evil.invalid>; rel="next"' } },
      )
    },
  )
  expect(JSON.parse(result.content)).toEqual([{ number: 1, title: 'Bug' }])
  expect(result.nextPage).toBe(3)
  expect(JSON.stringify(result)).not.toContain('fixture-secret')
})

test('checks use the current head and reject stale expected versions', async () => {
  const paths: string[] = []
  const fetcher = async (url: URL) => {
    paths.push(url.pathname)
    return Response.json(
      url.pathname.endsWith('/pulls/3')
        ? { head: { sha: head }, base: { sha: base } }
        : { total_count: 0, check_runs: [] },
    )
  }
  const x = await readGithubRepositoryResource(
    'org/repo',
    'token',
    { resource: 'checks', number: 3, expectedHead: head },
    stop(),
    fetcher,
  )
  expect(paths).toEqual(['/repos/org/repo/pulls/3', `/repos/org/repo/commits/${head}/check-runs`])
  expect(JSON.parse(x.content).total_count).toBe(0)
  await expect(
    readGithubRepositoryResource(
      'org/repo',
      'token',
      { resource: 'checks', number: 3, expectedHead: base },
      stop(),
      fetcher,
    ),
  ).rejects.toThrow('版本已变化')
})

test('files detect a concurrent PR update and require rereading', async () => {
  let reads = 0
  await expect(
    readGithubRepositoryResource(
      'org/repo',
      'token',
      { resource: 'files', number: 3 },
      stop(),
      async (url) => {
        if (url.pathname.endsWith('/files'))
          return Response.json([{ filename: 'test.ts', patch: '@@' }])
        return Response.json({ head: { sha: reads++ ? base : head }, base: { sha: base } })
      },
    ),
  ).rejects.toThrow('读取补丁期间 PR 版本已变化')
})

test('file reads are pinned to a commit and support explicit continuation', async () => {
  const content = 'source'.repeat(6000)
  const fetcher = async (url: URL) => {
    expect(url.pathname).toBe('/repos/org/repo/contents/src/a.ts')
    expect(url.searchParams.get('ref')).toBe(head)
    return Response.json({
      path: 'src/a.ts',
      sha: base,
      encoding: 'base64',
      content: Buffer.from(content).toString('base64'),
    })
  }
  const input = { resource: 'file' as const, ref: head, path: 'src/a.ts' }
  const first = await readGithubRepositoryResource('org/repo', 'token', input, stop(), fetcher)
  const second = await readGithubRepositoryResource(
    'org/repo',
    'token',
    { ...input, offset: first.nextOffset! },
    stop(),
    fetcher,
  )
  expect(JSON.parse(first.content + second.content).content).toBe(content)
  await expect(
    readGithubRepositoryResource(
      'org/repo',
      'token',
      { ...input, path: '../other' },
      stop(),
      fetcher,
    ),
  ).rejects.toThrow('相对路径')
})

test('rate limits and authorization failures remain distinct without exposing credentials', async () => {
  for (const remaining of ['0', '55']) {
    await expect(
      readGithubRepositoryResource(
        'org/repo',
        'token',
        { resource: 'issues' },
        stop(),
        async () =>
          new Response('secret server text', {
            status: 403,
            headers: {
              'x-ratelimit-remaining': remaining,
              'x-ratelimit-reset': '123456',
              'x-github-request-id': 'test-request',
            },
          }),
      ),
    ).rejects.toThrow(remaining === '0' ? '限流；' : '未证实为限流')
  }
})

test('does not follow redirects or allow another repository in resource arguments', async () => {
  let calls = 0
  const fetcher = async () => {
    calls++
    return new Response('', { status: 302, headers: { location: 'https://evil.invalid' } })
  }
  await expect(
    readGithubRepositoryResource('../other/repo', 'token', { resource: 'issues' }, stop(), fetcher),
  ).rejects.toThrow('仓库名称')
  expect(calls).toBe(0)
  await expect(
    readGithubRepositoryResource('org/repo', 'token', { resource: 'issues' }, stop(), fetcher),
  ).rejects.toThrow('HTTP 302')
  expect(calls).toBe(1)
})

test('repository metadata uses the authorized repository URL and needs no issue number', async () => {
  const result = await readGithubRepositoryResource(
    'org/repo',
    'fixture-secret',
    { resource: 'repository' },
    stop(),
    async (url, init) => {
      expect(url.href).toBe('https://api.github.com/repos/org/repo')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-secret')
      return Response.json({ full_name: 'org/repo', default_branch: 'release', other: 'internal' })
    },
  )
  expect(JSON.parse(result.content)).toEqual({ full_name: 'org/repo', default_branch: 'release' })
  expect(result.sourceUrl).toBe('https://api.github.com/repos/org/repo')
})
