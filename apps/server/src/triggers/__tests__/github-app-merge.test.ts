import { expect, mock, test } from 'bun:test'
import { mergeGithubAppPull } from '../github-app-merge'

const head = 'a'.repeat(40)
const commit = 'b'.repeat(40)
const repo = 'fixture/review'
const actor = 'fixture[bot]'
const open = {
  number: 19,
  base: { repo: { full_name: repo } },
  head: { sha: head },
  draft: false,
  state: 'open',
  merged: false,
  merged_by: null,
  merge_commit_sha: null,
}
const closed = {
  ...open,
  state: 'closed',
  merged: true,
  merged_by: { login: actor },
  merge_commit_sha: commit,
}
const auth = { getMergeAccess: async () => ({ token: 'fixture', botLogin: actor }) }
const input = {
  repository: repo,
  number: 19,
  head,
  ref: 'github_app_fixture',
  signal: new AbortController().signal,
  beforeWrite: () => {},
}

test('submits the reviewed SHA once and verifies the actual merger even when the acknowledgement is lost', async () => {
  let writes = 0
  const receipt = await mergeGithubAppPull(auth, input, async (url, init) => {
    if (init.method === 'PUT') {
      expect(url.pathname).toBe('/repos/fixture/review/pulls/19/merge')
      expect(JSON.parse(String(init.body))).toEqual({ sha: head })
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer fixture')
      writes++
      throw Error('lost after acceptance')
    }
    return Response.json(writes ? closed : open)
  })
  expect(writes).toBe(1)
  expect(receipt).toEqual({
    status: 'merged',
    author: actor,
    url: 'https://github.com/fixture/review/pull/19',
    head,
    commit,
  })
})
test('reads an already merged PR without attributing a personal merge to the App', async () => {
  const get = mock(async () => Response.json({ ...closed, merged_by: { login: 'owner' } }))
  expect(await mergeGithubAppPull(auth, input, get)).toMatchObject({
    status: 'already_merged',
    author: 'owner',
    commit,
  })
  expect(get).toHaveBeenCalledTimes(1)
})
test('a different head, draft, revoked binding or protected branch never silently succeeds', async () => {
  for (const changed of [
    { ...open, head: { sha: commit } },
    { ...open, draft: true },
  ]) {
    const get = mock(async () => Response.json(changed))
    await expect(mergeGithubAppPull(auth, input, get)).rejects.toThrow()
    expect(get).toHaveBeenCalledTimes(1)
  }
  const get = mock(async () => Response.json(open))
  await expect(
    mergeGithubAppPull(
      auth,
      {
        ...input,
        beforeWrite() {
          throw Error('revoked')
        },
      },
      get,
    ),
  ).rejects.toThrow('revoked')
  expect(get).toHaveBeenCalledTimes(1)
  let writes = 0
  await expect(
    mergeGithubAppPull(auth, input, async (_, init) => {
      if (init.method === 'PUT') {
        writes++
        return new Response(null, { status: 405 })
      }
      return Response.json(open)
    }),
  ).rejects.toThrow('405')
  expect(writes).toBe(1)
})
