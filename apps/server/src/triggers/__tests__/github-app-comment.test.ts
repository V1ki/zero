import { expect, mock, test } from 'bun:test'
import {
  GithubAppCommentRejectedError,
  GithubAppCommentUncertainError,
  postGithubAppComment,
} from '../github-app-comment'

const input = {
  ref: 'github_app_fixture',
  repository: 'sample/repo',
  issueNumber: 23,
  body: 'Discussed with the owner.',
  signal: new AbortController().signal,
}
const auth = { getCommentAccess: async () => ({ token: 'test-token', botLogin: 'sample[bot]' }) }
const receipt = {
  id: 45,
  issue_url: 'https://api.github.com/repos/sample/repo/issues/23',
  user: { type: 'Bot', login: 'sample[bot]' },
  html_url: 'https://github.com/sample/repo/pull/23#issuecomment-45',
}

test.each(['issues', 'pull'])(
  'posts exactly one top-level comment and validates its %s receipt',
  async (area) => {
    const result = {
      ...receipt,
      html_url: `https://github.com/sample/repo/${area}/23#issuecomment-45`,
    }
    const post = mock(async (url: URL, req: RequestInit) => {
      expect(url.href).toBe('https://api.github.com/repos/sample/repo/issues/23/comments')
      expect([req.method, req.redirect, new Headers(req.headers).get('authorization')]).toEqual([
        'POST',
        'manual',
        'Bearer test-token',
      ])
      expect(JSON.parse(String(req.body))).toEqual({ body: input.body })
      return Response.json(result, { status: 201 })
    })
    expect(await postGithubAppComment(auth, input, post)).toEqual({
      id: 45,
      url: result.html_url,
      author: 'sample[bot]',
    })
    expect(post).toHaveBeenCalledTimes(1)
  },
)

test('does not post when the binding has changed during credential exchange', async () => {
  const post = mock(async () => Response.json(receipt, { status: 201 }))
  await expect(
    postGithubAppComment(
      auth,
      {
        ...input,
        beforePost: () => {
          throw new Error('revoked')
        },
      },
      post,
    ),
  ).rejects.toThrow('revoked')
  expect(post).not.toHaveBeenCalled()
})

test('preserves uncertainty without replaying on lost responses or invalid GitHub receipts', async () => {
  for (const result of [
    new Response('sensitive', { status: 503 }),
    Response.redirect('https://example.invalid'),
    Response.json({ ...receipt, user: { type: 'Bot', login: 'other[bot]' } }, { status: 201 }),
    Response.json({ ...receipt, html_url: 'https://example.invalid' }, { status: 201 }),
    Response.json(
      { ...receipt, issue_url: 'https://api.github.com/repos/sample/another/issues/23' },
      { status: 201 },
    ),
    new Response('bad token echoed', { status: 201 }),
    null,
  ]) {
    const post = mock(async () => {
      if (!result) throw new Error('token-must-not-escape')
      return result
    })
    await expect(postGithubAppComment(auth, input, post)).rejects.toThrow(
      /^GitHub 评论发送结果待核对。请先查看原讨论，避免重复发送。$/,
    )
    expect(post).toHaveBeenCalledTimes(1)
  }
})

test('revalidates the previewed bot and immutable repository id before allowing POST', async () => {
  const order: string[] = []
  const beforePost = () => {
    order.push('binding')
  }
  const fetcher = async (url: URL, init: RequestInit) => {
    order.push(`${init.method} ${url.href}`)
    expect(init.redirect).toBe('manual')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token')
    if (init.method === 'GET') return Response.json({ id: 910, full_name: 'Sample/Repo' })
    return Response.json(receipt, { status: 201 })
  }
  const preview = { ...input, expectedAuthor: 'sample[bot]', expectedRepositoryId: 910, beforePost }
  await expect(
    postGithubAppComment(auth, { ...preview, expectedAuthor: 'new[bot]' }, fetcher),
  ).rejects.toThrow('身份与预览不符')
  await expect(
    postGithubAppComment(auth, { ...preview, expectedRepositoryId: -1 }, fetcher),
  ).rejects.toThrow('ID 无效')
  expect(order).toEqual([])
  for (const candidate of [
    { id: 909, full_name: input.repository },
    { id: 910, full_name: 'sample/other' },
    {},
  ]) {
    const check = mock(async () => Response.json(candidate))
    await expect(postGithubAppComment(auth, preview, check)).rejects.toThrow('未能核对')
    expect(check).toHaveBeenCalledTimes(1)
  }
  expect(order).toEqual([])
  await postGithubAppComment(auth, preview, fetcher)
  expect(order).toEqual([
    'GET https://api.github.com/repos/sample/repo',
    'binding',
    'POST https://api.github.com/repos/sample/repo/issues/23/comments',
  ])
})

test('distinguishes an explicit rejection from an uncertain POST and omits upstream text', async () => {
  for (const [status, kind] of [
    [403, GithubAppCommentRejectedError],
    [422, GithubAppCommentRejectedError],
    [408, GithubAppCommentUncertainError],
    [500, GithubAppCommentUncertainError],
  ] as const) {
    const failure = await postGithubAppComment(
      auth,
      input,
      async () => new Response('token-leak', { status }),
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(kind)
    expect(String(failure)).not.toContain('token-leak')
  }
})

test('preserves GitHub refusal diagnostics without returning the response body or posting twice', async () => {
  const post = mock(
    async () =>
      new Response('private payload', {
        status: 403,
        headers: {
          'x-github-request-id': 'ABC:123',
          'x-accepted-github-permissions': 'issues=write',
          'x-ratelimit-remaining': '19',
        },
      }),
  )
  const error = await postGithubAppComment(auth, input, post).catch((error) => error)
  expect(error).toBeInstanceOf(GithubAppCommentRejectedError)
  expect(error.message).toContain('x-accepted-github-permissions=issues=write')
  expect(error.message).toContain('x-ratelimit-remaining=19')
  expect(error.message).toContain('ABC:123')
  expect(error.message).not.toContain('private payload')
  expect(post).toHaveBeenCalledTimes(1)
})
