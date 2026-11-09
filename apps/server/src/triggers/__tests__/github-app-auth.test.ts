import { expect, mock, test } from 'bun:test'
import { generateKeyPairSync, verify } from 'node:crypto'
import { createGithubAppAuth } from '../github-app-auth'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const repository = 'example/monitor'
const ref = 'github_app_fixture'
const app = {
  appId: 23,
  slug: 'fixture',
  repository,
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
}
const raw = JSON.stringify(app)
const installed = {
  app_id: 23,
  app_slug: 'fixture',
  id: 17,
  account: { login: 'example' },
  suspended_at: null,
}
const rights = { metadata: 'read', issues: 'read', pull_requests: 'read' }
const current = Date.UTC(2026, 10, 4)
const hour = 60 * 60_000
const signal = new AbortController().signal

test('previews only the bound bot name without minting or exposing an installation token', async () => {
  const fetcher = mock(async () => Response.error())
  const auth = createGithubAppAuth(() => raw, { fetcher })
  expect(await auth.getCommentIdentity(ref, repository, signal)).toBe('fixture[bot]')
  await expect(auth.getCommentIdentity(ref, 'wrong/repo', signal)).rejects.toThrow('未授权')
  await expect(auth.getCommentIdentity('wrong-ref', repository, signal)).rejects.toThrow('引用')
  expect(fetcher).not.toHaveBeenCalled()
})
function issued(time = current) {
  return {
    token: 'ghs_test_formatted.variable.length',
    expires_at: new Date(time + hour).toISOString(),
    permissions: rights,
    repositories: [{ full_name: repository }],
    repository_selection: 'selected',
  }
}

test('signs only for the selected installation and mints one repository-only read token per refresh', async () => {
  let now = current
  const endpoints: string[] = []
  const auth = createGithubAppAuth(() => raw, {
    now: () => now,
    fetcher: async (url, req) => {
      endpoints.push(url.pathname)
      expect(url.origin).toBe('https://api.github.com')
      expect(req.redirect).toBe('manual')
      const authHeader = new Headers(req.headers).get('Authorization') ?? ''
      const [header, claims, signature] = authHeader.replace(/^Bearer /, '').split('.')
      expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
        typ: 'JWT',
        alg: 'RS256',
      })
      expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
        iss: '23',
        iat: now / 1000 - 60,
        exp: now / 1000 + 540,
      })
      expect(
        verify(
          'RSA-SHA256',
          Buffer.from(`${header}.${claims}`),
          publicKey,
          Buffer.from(signature, 'base64url'),
        ),
      ).toBe(true)
      if (req.method === 'GET') return Response.json(installed)
      expect(JSON.parse(String(req.body))).toEqual({
        repositories: ['monitor'],
        permissions: rights,
      })
      return Response.json(issued(now))
    },
  })
  const get = () => auth.getToken(ref, repository.toUpperCase(), signal)
  expect(await Promise.all([get(), get(), get()])).toEqual([
    issued().token,
    issued().token,
    issued().token,
  ])
  now += 54 * 60_000
  await get()
  expect(endpoints).toEqual([
    '/repos/example/monitor/installation',
    '/app/installations/17/access_tokens',
  ])
  now += 60_000
  await get()
  expect(endpoints).toHaveLength(4)
})

test('does not share an installation token outside its vault reference, bound repo or credentials', async () => {
  let rawValue: string | undefined = raw
  let reads = 0
  const auth = createGithubAppAuth(
    () => {
      reads++
      return rawValue
    },
    {
      now: () => current,
      fetcher: async (_, req) => Response.json(req.method === 'GET' ? installed : issued()),
    },
  )
  await expect(auth.getToken('some_other_secret', repository, signal)).rejects.toThrow('引用')
  expect(reads).toBe(0)
  expect(await auth.getToken(ref, repository, signal)).toBe(issued().token)
  await expect(auth.getToken(ref, 'example/other', signal)).rejects.toThrow('未授权')
  rawValue = JSON.stringify({ ...app, privateKey: 'invalid key material not for errors' })
  await expect(auth.getToken(ref, repository, signal)).rejects.toThrow(
    '无法使用 GitHub App 私钥签名。',
  )
  rawValue = undefined
  await expect(auth.getToken(ref, repository, signal)).rejects.toThrow('找不到')
})

test('rejects invalid / suspended installations and broadened or expired tokens', async () => {
  for (const [installation, token] of [
    [{ ...installed, app_id: 24 }, issued()],
    [{ ...installed, app_slug: 'other' }, issued()],
    [{ ...installed, account: { login: 'someone' } }, issued()],
    [{ ...installed, suspended_at: 'yesterday' }, issued()],
    [installed, { ...issued(), expires_at: new Date(current - 1000).toISOString() }],
    [installed, { ...issued(), permissions: { ...rights, contents: 'write' } }],
    [installed, { ...issued(), permissions: { ...rights, pull_requests: 'write' } }],
    [
      installed,
      { ...issued(), repositories: [{ full_name: repository }, { full_name: 'other/private' }] },
    ],
    [installed, { ...issued(), repository_selection: 'all' }],
  ]) {
    const auth = createGithubAppAuth(() => raw, {
      now: () => current,
      fetcher: async (_, req) => Response.json(req.method === 'GET' ? installation : token),
    })
    await expect(auth.getToken(ref, repository, signal)).rejects.toThrow(/不匹配/)
  }
})

test('failed exchanges are retryable and never include the raw GitHub error or a broken token', async () => {
  let phase = 0
  const auth = createGithubAppAuth(() => raw, {
    now: () => current,
    fetcher: async (_, req) => {
      if (req.method === 'GET') return Response.json(installed)
      if (phase === 0) return new Response('credential-must-not-leak', { status: 422 })
      if (phase === 1) return new Response('{"token":"credential-must-not-leak"broken')
      if (phase === 2) throw new Error('credential-must-not-leak')
      return Response.json(issued())
    },
  })
  for (phase = 0; phase < 3; phase++) {
    await expect(auth.getToken(ref, repository, signal)).rejects.toThrow(
      /^GitHub App 身份校验失败（HTTP 422）。$|^GitHub App 接口返回了无效的数据。$|^无法连接 GitHub App 身份验证接口。$/,
    )
  }
  expect(await auth.getToken(ref, repository, signal)).toBe(issued().token)
})

test('one cancelled waiter leaves shared refresh intact; a rotated key fences an in-flight result', async () => {
  let rawValue = raw
  const gate = Promise.withResolvers<void>()
  let gets = 0
  const auth = createGithubAppAuth(() => rawValue, {
    now: () => current,
    fetcher: async (_, req) => {
      if (req.method === 'GET') {
        gets++
        await gate.promise
        return Response.json(installed)
      }
      return Response.json(issued())
    },
  })
  const stop = new AbortController()
  const waiter = auth.getToken(ref, repository, stop.signal)
  const other = auth.getToken(ref, repository, signal)
  stop.abort(new Error('cancel-waiter'))
  await expect(waiter).rejects.toThrow('cancel-waiter')
  rawValue = JSON.stringify({ ...app, appId: 24 })
  gate.resolve()
  await expect(other).rejects.toThrow('已更换')
  expect(gets).toBe(1)
})

test('isolates write and listener credentials even for simultaneous requests on the same installation', async () => {
  const commentRights = { metadata: 'read', issues: 'write' }
  const scopes: Record<string, string>[] = []
  const auth = createGithubAppAuth(() => raw, {
    now: () => current,
    fetcher: async (_, req) => {
      if (req.method === 'GET') return Response.json(installed)
      const requested = JSON.parse(String(req.body))
      expect(requested.repositories).toEqual(['monitor'])
      scopes.push(requested.permissions)
      return Response.json({
        ...issued(),
        token: requested.permissions.issues,
        permissions: requested.permissions,
      })
    },
  })
  const [read, write1, write2] = await Promise.all([
    auth.getToken(ref, repository, signal),
    auth.getCommentAccess(ref, repository, signal),
    auth.getCommentAccess(ref, repository, signal),
  ])
  expect([read, write1, write2]).toEqual([
    'read',
    { token: 'write', botLogin: 'fixture[bot]' },
    { token: 'write', botLogin: 'fixture[bot]' },
  ])
  expect(scopes).toHaveLength(2)
  expect(scopes).toContainEqual(rights)
  expect(scopes).toContainEqual(commentRights)
  for (const permissions of [
    rights,
    { ...commentRights, pull_requests: 'write' },
    { ...commentRights, metadata: 'write' },
  ]) {
    const invalid = createGithubAppAuth(() => raw, {
      now: () => current,
      fetcher: async (_, req) =>
        Response.json(req.method === 'GET' ? installed : { ...issued(), permissions }),
    })
    await expect(invalid.getCommentAccess(ref, repository, signal)).rejects.toThrow(
      '权限或仓库范围不匹配',
    )
  }
})

test.each(['read', 'write'])(
  'comment tokens include the granted PR write permission when its level is %s',
  async (pullRequests) => {
    const scopes: Record<string, string>[] = []
    const auth = createGithubAppAuth(() => raw, {
      now: () => current,
      fetcher: async (_, request) => {
        if (request.method === 'GET')
          return Response.json({
            ...installed,
            permissions: { issues: 'write', pull_requests: pullRequests, contents: 'write' },
          })
        const { permissions } = JSON.parse(String(request.body))
        scopes.push(permissions)
        return Response.json({ ...issued(), permissions })
      },
    })
    await auth.getCommentAccess(ref, repository, signal)
    await auth.getCommentAccess(ref, repository, signal)
    await auth.getToken(ref, repository, signal)
    expect(scopes).toEqual([
      {
        metadata: 'read',
        issues: 'write',
        ...(pullRequests === 'write' ? { pull_requests: 'write' } : {}),
      },
      rights,
    ])
  },
)

test('installation inspection is read-only and the merge token is limited to the reviewed repository', async () => {
  let contents = 'read'
  let mints = 0
  const permissions = { metadata: 'read', issues: 'write', pull_requests: 'read' }
  const auth = createGithubAppAuth(() => raw, {
    now: () => current,
    fetcher: async (_, req) => {
      if (req.method === 'GET')
        return Response.json({ ...installed, permissions: { ...permissions, contents } })
      mints++
      const data = JSON.parse(String(req.body))
      expect(data).toEqual({
        repositories: ['monitor'],
        permissions: { metadata: 'read', contents: 'write', pull_requests: 'read' },
      })
      return Response.json({ ...issued(), permissions: data.permissions })
    },
  })
  expect(await auth.inspectInstallation(ref, repository, signal)).toEqual({
    author: 'fixture[bot]',
    repository,
    commentsAllowed: true,
    pullRequestsAllowed: false,
    mergeAllowed: false,
  })
  await expect(auth.getMergeAccess(ref, repository, signal)).rejects.toThrow('Contents')
  expect(mints).toBe(0)
  contents = 'write'
  expect(await auth.inspectInstallation(ref, repository, signal)).toMatchObject({
    mergeAllowed: true,
  })
  expect(await auth.getMergeAccess(ref, repository, signal)).toMatchObject({
    botLogin: 'fixture[bot]',
  })
  expect(mints).toBe(1)
})

test('opening a PR requires pull-request write, independently of merge and comment permissions', async () => {
  let level = 'read'
  let exchanges = 0
  const auth = createGithubAppAuth(() => raw, {
    now: () => current,
    fetcher: async (_, req) => {
      if (req.method === 'GET')
        return Response.json({
          ...installed,
          permissions: { pull_requests: level, issues: 'write', contents: 'read' },
        })
      exchanges++
      const request = JSON.parse(String(req.body))
      expect(request).toEqual({
        repositories: ['monitor'],
        permissions: { pull_requests: 'write', metadata: 'read' },
      })
      return Response.json({ ...issued(), permissions: request.permissions })
    },
  })
  await expect(auth.getPullAccess(ref, repository, signal)).rejects.toThrow('Pull requests 写权限')
  expect(exchanges).toBe(0)
  level = 'write'
  expect(await auth.inspectInstallation(ref, repository, signal)).toMatchObject({
    pullRequestsAllowed: true,
    mergeAllowed: false,
  })
  expect((await auth.getPullAccess(ref, repository, signal)).botLogin).toBe('fixture[bot]')
  expect(exchanges).toBe(1)
})
