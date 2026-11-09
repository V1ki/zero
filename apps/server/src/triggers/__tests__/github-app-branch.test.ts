import { expect, mock, test } from 'bun:test'
import { publishGithubAppBranch } from '../github-app-branch'

const branch = 'review/docs'
const head = 'a'.repeat(40)
const input = {
  repository: 'Org/Repo',
  ref: 'github_app_test',
  branch,
  head,
  source: '/test/repo',
  signal: new AbortController().signal,
  beforeWrite() {},
}
const auth = { getMergeAccess: async () => ({ token: 'test-secret', botLogin: 'fixture[bot]' }) }
function remote() {
  let sha: string | null = null
  return {
    set(value: string) {
      sha = value
    },
    fetch: async (url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-secret')
      if (url.endsWith('/repos/Org/Repo'))
        return Response.json({ full_name: 'Org/Repo', default_branch: 'main' })
      expect(url).toBe('https://api.github.com/repos/Org/Repo/git/ref/heads/review/docs')
      return sha
        ? Response.json({ ref: 'refs/heads/review/docs', object: { type: 'commit', sha } })
        : new Response(null, { status: 404 })
    },
  }
}
test('readback recovers a lost branch acknowledgement; retry never pushes twice', async () => {
  const r = remote()
  const push = mock(async () => {
    r.set(head)
    throw Error('ack lost')
  })
  expect(await publishGithubAppBranch(auth, input, r.fetch, push)).toMatchObject({
    status: 'published',
    branch,
    head,
    app: 'fixture[bot]',
  })
  expect(await publishGithubAppBranch(auth, input, r.fetch, push)).toMatchObject({
    status: 'existing',
    head,
  })
  expect(push).toHaveBeenCalledTimes(1)
})
test('invalid/default refs, changed binding and non-fast-forward updates cannot report success', async () => {
  const r = remote()
  const push = mock(async () => {
    throw Error('non-fast-forward secret-value')
  })
  await expect(
    publishGithubAppBranch(auth, { ...input, branch: 'main' }, r.fetch, push),
  ).rejects.toThrow('默认分支')
  await expect(
    publishGithubAppBranch(auth, { ...input, branch: '../main' }, r.fetch, push),
  ).rejects.toThrow('分支名称无效')
  await expect(
    publishGithubAppBranch(
      auth,
      {
        ...input,
        beforeWrite() {
          throw Error('绑定已改变')
        },
      },
      r.fetch,
      push,
    ),
  ).rejects.toThrow('绑定已改变')
  expect(push).not.toHaveBeenCalled()
  r.set('b'.repeat(40))
  await expect(publishGithubAppBranch(auth, input, r.fetch, push)).rejects.toThrow('远端分支已变化')
  expect(push).toHaveBeenCalledTimes(1)
})
