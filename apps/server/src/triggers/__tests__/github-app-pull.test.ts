import { expect, mock, test } from 'bun:test'
import { openGithubAppPull } from '../github-app-pull'

const input = {
  repository: 'one/project',
  ref: 'github_app_fixture',
  head: 'fix/image',
  base: 'main',
  title: 'Restore images',
  body: 'Tests passed',
  signal: new AbortController().signal,
  beforeWrite() {},
}
const ref = (name: string) => ({
  repo: { full_name: input.repository },
  ref: name,
  sha: 'a'.repeat(40),
})
const pull = {
  head: ref(input.head),
  base: ref(input.base),
  number: 10,
  user: { type: 'Bot', login: 'fixture[bot]' },
  html_url: 'https://github.com/one/project/pull/10',
}
const auth = { getPullAccess: async () => ({ token: 'fixture', botLogin: 'fixture[bot]' }) }
test('opens the review as the configured bot and reports its GitHub author', async () => {
  const methods: string[] = []
  const result = await openGithubAppPull(auth, input, async (url, req) => {
    expect(new Headers(req.headers).get('Authorization')).toBe('Bearer fixture')
    methods.push(req.method ?? 'GET')
    if (req.method === 'POST') {
      expect(JSON.parse(String(req.body))).toEqual({
        head: input.head,
        base: input.base,
        title: input.title,
        body: input.body,
      })
      return Response.json(pull, { status: 201 })
    }
    expect(url.searchParams.get('head')).toBe('one:fix/image')
    return Response.json([])
  })
  expect(methods).toEqual(['GET', 'POST'])
  expect(result).toMatchObject({ status: 'created', author: 'fixture[bot]', url: pull.html_url })
})
test('returns the actual author of an existing personal PR without posting again', async () => {
  const fetcher = mock(async () =>
    Response.json([{ ...pull, user: { login: 'one', type: 'User' } }]),
  )
  expect(await openGithubAppPull(auth, input, fetcher)).toMatchObject({
    status: 'existing',
    author: 'one',
  })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
test('checks for an accepted PR after a lost response instead of repeating the POST', async () => {
  let calls = 0
  const result = await openGithubAppPull(auth, input, async (_, r) => {
    if (r.method === 'POST') {
      calls++
      throw Error('lost')
    }
    return Response.json(calls ? [pull] : [])
  })
  expect(result.author).toBe('fixture[bot]')
  expect(calls).toBe(1)
})
test('does not claim a personal creation response as an App receipt or post after a rebind', async () => {
  await expect(
    openGithubAppPull(auth, input, async (_, r) =>
      r.method === 'POST'
        ? Response.json({ ...pull, user: { type: 'User', login: 'one' } }, { status: 201 })
        : Response.json([]),
    ),
  ).rejects.toThrow('作者')
  const get = mock(async () => Response.json([]))
  await expect(
    openGithubAppPull(
      auth,
      {
        ...input,
        beforeWrite() {
          throw Error('rebound')
        },
      },
      get,
    ),
  ).rejects.toThrow('rebound')
  expect(get).toHaveBeenCalledTimes(1)
})
