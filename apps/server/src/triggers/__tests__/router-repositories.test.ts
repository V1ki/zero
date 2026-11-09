import { afterEach, expect, mock, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import type { CommissionOperator, TriggerSettingsSnapshot } from '@zero-os/shared'
import { createRouterRepositoryLookup } from '../router-repositories'

const owner: CommissionOperator = {
  platform: 'weixin',
  channelId: 'bot',
  operatorId: 'private-user',
  peerId: 'private-dm',
}
const signal = new AbortController().signal

test('repository evidence uses the same actor grant and rejects revocation during reading', async () => {
  const { service, snapshot, fetcher, save } = fixture()
  fetcher.mockImplementation(async (url, init) => {
    expect(url.pathname).toBe('/repos/org/project/issues')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-token')
    snapshot.settings.github.routerOperators = []
    save()
    return Response.json([{ number: 1, title: 'private evidence' }])
  })
  await expect(
    service.readRepository(owner, 'org/project', { resource: 'issues' }, signal),
  ).rejects.toThrow('授权已变化')
  expect(fetcher).toHaveBeenCalledTimes(1)
  await expect(
    service.readRepository(owner, 'org/project', { resource: 'issues' }, signal),
  ).rejects.toThrow('授权')
  expect(fetcher).toHaveBeenCalledTimes(1)
})
const stores: TriggerStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture(
  ref = 'github_listener_account',
  appBinding?: Parameters<typeof createRouterRepositoryLookup>[3],
  filter?: Parameters<typeof createRouterRepositoryLookup>[4],
) {
  const snapshot: TriggerSettingsSnapshot = {
    revision: 0,
    settings: {
      github: { credentialRef: ref, repositories: [], routerOperators: [owner] },
      wxarc: { sessions: [] },
    },
  }
  const resolve = mock((_ref: string): string | undefined => 'fixture-token')
  const fetcher = mock(
    async (_url: URL, _init: RequestInit): Promise<Response> => Response.json([]),
  )
  const store = new TriggerStore(':memory:')
  stores.push(store)
  const save = () => {
    snapshot.revision = store.saveSettings(snapshot.settings, snapshot.revision)
  }
  save()
  const service = createRouterRepositoryLookup(
    (actor) => store.getRouterGithubGrant(actor),
    resolve,
    fetcher,
    appBinding,
    filter,
  )
  return { service, snapshot, resolve, fetcher, save }
}

test('lists a bounded page of the fixed connection, independent of listeners', async () => {
  const { service, fetcher } = fixture()
  fetcher.mockImplementation(async (url, init) => {
    expect(url.origin).toBe('https://api.github.com')
    expect(url.pathname).toBe('/user/repos')
    expect(url.searchParams.get('per_page')).toBe('20')
    expect(url.searchParams.get('sort')).toBe('full_name')
    expect(url.searchParams.get('page')).toBe('2')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-token')
    return Response.json([{ full_name: 'org/project' }, { full_name: 'user/second' }], {
      headers: { link: '<https://api.github.com/user/repos?page=3>; rel="next"' },
    })
  })
  expect(await service.list(owner, signal, 2)).toEqual({
    page: 2,
    repositories: ['org/project', 'user/second'],
    nextPage: 3,
  })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

const pullRepo = { full_name: 'Org/Project', id: 8 }
const openPull = {
  number: 23,
  title: 'Update CLI',
  state: 'open',
  draft: true,
  base: { repo: pullRepo },
  html_url: 'https://github.com/Org/Project/pull/23',
}

test('reads the requested live open PR page with the actor grant and returns canonical links and pagination', async () => {
  const { service, fetcher } = fixture()
  fetcher.mockImplementation(async (url, init) => {
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-token')
    if (url.pathname === '/repos/org/project') return Response.json(pullRepo)
    expect(url.pathname).toBe('/repos/Org/Project/pulls')
    expect(url.searchParams.get('state')).toBe('open')
    expect(url.searchParams.get('per_page')).toBe('5')
    expect(url.searchParams.get('page')).toBe('2')
    return Response.json([openPull], {
      headers: { link: '<https://api.github.com/repositories/8/pulls?page=3>; rel="next"' },
    })
  })
  expect(await service.listOpenPullRequests(owner, 'org/project', signal, 2)).toEqual({
    repository: 'Org/Project',
    page: 2,
    pageSize: 5,
    nextPage: 3,
    pullRequests: [{ number: 23, title: 'Update CLI', draft: true, url: openPull.html_url }],
  })
  await expect(service.listOpenPullRequests(owner, 'org/project', signal, 0)).rejects.toThrow(
    '页码',
  )
  expect(fetcher).toHaveBeenCalledTimes(2)
})

test('new web, Feishu and DingTalk inventories read ten per page', async () => {
  const { service, fetcher, snapshot, save } = fixture()
  const feishu = { ...owner, platform: 'feishu' } as const
  const dingtalk = { ...owner, platform: 'dingtalk' } as const
  snapshot.settings.github.routerOperators = [feishu, dingtalk]
  save()
  fetcher.mockImplementation(async (url) => {
    if (!url.pathname.endsWith('/pulls')) return Response.json(pullRepo)
    expect(url.searchParams.get('per_page')).toBe('10')
    return Response.json([])
  })
  for (const actor of ['web', feishu, dingtalk] as const) {
    expect((await service.listOpenPullRequests(actor, 'org/project', signal)).pageSize).toBe(10)
  }
})

test('redacts secrets in a PR title before bounding the result returned to the private chat', async () => {
  const secret = 'credential-for-fixtures'
  const prefix = 'x'.repeat(170)
  const { service, fetcher } = fixture(undefined, undefined, (s) => s.replaceAll(secret, '***'))
  fetcher.mockImplementation(async (url) =>
    Response.json(
      url.pathname.endsWith('/pulls') ? [{ ...openPull, title: prefix + secret }] : pullRepo,
    ),
  )
  const page = await service.listOpenPullRequests(owner, 'org/project', signal)
  expect(page.pullRequests[0].title).toBe(`${prefix}***`)
})

test('never releases other repositories, closed PRs, or private results after revoking the actor', async () => {
  const { service, fetcher, snapshot, save } = fixture()
  for (const changed of [
    { base: { repo: { ...pullRepo, id: 9 } } },
    { html_url: 'https://github.com/other/private/pull/23' },
    { state: 'closed' },
  ]) {
    fetcher.mockImplementation(async (url) =>
      Response.json(url.pathname.endsWith('/pulls') ? [{ ...openPull, ...changed }] : pullRepo),
    )
    await expect(service.listOpenPullRequests(owner, 'org/project', signal)).rejects.toThrow(
      '读取 GitHub',
    )
  }
  fetcher.mockImplementation(async (url) => {
    if (!url.pathname.endsWith('/pulls')) return Response.json(pullRepo)
    snapshot.settings.github.routerOperators = []
    save()
    return Response.json([openPull])
  })
  await expect(service.listOpenPullRequests(owner, 'org/project', signal)).rejects.toThrow(
    '授权已变化',
  )
})

test('legacy settings allow the local owner only; access is pinned to all four IM identity fields', async () => {
  const { service, snapshot, resolve, fetcher, save } = fixture()
  for (const changed of [
    { platform: 'dingtalk' as const },
    { channelId: 'other' },
    { peerId: 'elsewhere' },
    { operatorId: 'stranger' },
    { operatorId: '' },
  ]) {
    expect(service.accessKey({ ...owner, ...changed })).toBeNull()
    await expect(service.list({ ...owner, ...changed }, signal)).rejects.toThrow('授权')
  }
  snapshot.settings.github.routerOperators = undefined
  save()
  await expect(service.list(owner, signal)).rejects.toThrow('授权')
  expect(resolve).not.toHaveBeenCalled()
  expect(fetcher).not.toHaveBeenCalled()
  expect(await service.list('web', signal)).toEqual({ page: 1, repositories: [], nextPage: null })
})

test('missing or invalid connection never simulates an empty repository list', async () => {
  for (const ref of ['', 'other_vault_item']) {
    const f = fixture(ref)
    await expect(f.service.list('web', signal)).rejects.toThrow('配置 GitHub 凭证')
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.fetcher).not.toHaveBeenCalled()
  }
  const f = fixture()
  f.resolve.mockReturnValue(undefined)
  await expect(f.service.list(owner, signal)).rejects.toThrow('连接授权')
  expect(f.fetcher).not.toHaveBeenCalled()
})

test('withholds results if the grant is revoked or the connection changes during a read', async () => {
  for (const change of ['remove', 'rotate', 'switch']) {
    const { service, snapshot, resolve, fetcher, save } = fixture()
    const key = service.accessKey(owner)
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    fetcher.mockImplementation(async () => {
      if (change === 'rotate') resolve.mockReturnValue('replacement')
      if (change === 'remove') snapshot.settings.github.routerOperators = []
      if (change === 'switch') snapshot.settings.github.credentialRef = 'github_listener_new'
      save()
      return Response.json([{ full_name: 'private/sensitive-project' }])
    })
    await expect(service.list(owner, signal)).rejects.toThrow('授权已变化')
    expect(service.accessKey(owner)).not.toBe(key)
  }
})

test('rejects invalid pages and sanitizes upstream errors', async () => {
  const { service, fetcher } = fixture()
  await expect(service.list(owner, signal, -2)).rejects.toThrow('页码')
  expect(fetcher).not.toHaveBeenCalled()
  fetcher.mockImplementation(async () => new Response('private context', { status: 401 }))
  await expect(service.list(owner, signal)).rejects.toThrow('HTTP 401')
  fetcher.mockImplementation(async () => new Response('', { status: 429 }))
  await expect(service.list(owner, signal)).rejects.toThrow('限制查询频率')
})

test('unrelated settings changes preserve in-flight access while removing and restoring the same grant does not', async () => {
  const { service, snapshot, fetcher, save } = fixture()
  const original = service.accessKey(owner)
  fetcher.mockImplementation(async () => {
    snapshot.settings.wxarc.sessions.push({
      id: 'whole-room',
      name: 'Room',
      enabled: false,
      keyword: '',
    })
    snapshot.settings.github.routerOperators?.push({ ...owner, operatorId: 'second' })
    save()
    return Response.json([{ full_name: 'org/accessible' }])
  })
  expect((await service.list(owner, signal)).repositories).toEqual(['org/accessible'])
  expect(service.accessKey(owner)).toBe(original)
  fetcher.mockImplementation(async () => {
    snapshot.settings.github.routerOperators = []
    save()
    snapshot.settings.github.routerOperators = [owner]
    save()
    return Response.json([{ full_name: 'org/private' }])
  })
  await expect(service.list(owner, signal)).rejects.toThrow('授权已变化')
  expect(service.accessKey(owner)).not.toBe(original)
})

test('a job cannot follow renamed repositories or use credentials after revocation', async () => {
  const { service, snapshot, fetcher, save } = fixture()
  fetcher.mockImplementation(async () => Response.json({ id: 5, full_name: 'other/renamed' }))
  await expect(service.latestFailure(owner, 'org/project', signal)).rejects.toThrow('名称已变化')
  expect(fetcher).toHaveBeenCalledTimes(1)
  snapshot.settings.github.routerOperators = []
  save()
  await expect(service.latestFailure(owner, 'org/project', signal)).rejects.toThrow('连接授权')
  expect(fetcher).toHaveBeenCalledTimes(1)
})

test('revoking a running job after identity verification prevents the subsequent workflow request', async () => {
  const { service, snapshot, fetcher, save } = fixture()
  fetcher.mockImplementation(async (url) => {
    expect(url.pathname).toBe('/repos/org/project')
    snapshot.settings.github.routerOperators = []
    save()
    return Response.json({ id: 5, full_name: 'org/project' })
  })
  await expect(service.latestFailure(owner, 'org/project', signal)).rejects.toThrow('授权已变化')
  expect(fetcher).toHaveBeenCalledTimes(1)
})

test('starting a watch resolves the canonical repository and verifies each chosen private resource', async () => {
  const { service, fetcher } = fixture()
  const seen: string[] = []
  fetcher.mockImplementation(async (url, init) => {
    seen.push(url.pathname)
    if (url.pathname === '/repos/org/project')
      return Response.json({ id: 41, full_name: 'Org/Project' })
    expect(init.method).toBe('HEAD')
    if (url.pathname.endsWith('/pulls')) return new Response(null, { status: 403 })
    return new Response(null, { status: 200 })
  })
  const name = await service.verifyTracking(
    owner,
    'org/project',
    { issues: true, pullRequests: false },
    signal,
  )
  expect(name).toBe('Org/Project')
  expect(seen.map((p) => p.toLowerCase())).toEqual([
    '/repos/org/project',
    '/repos/org/project/issues',
  ])
  await expect(
    service.verifyTracking(owner, 'org/project', { issues: true, pullRequests: true }, signal),
  ).rejects.toThrow('Pull requests 只读权限')
})

test('a comments-only watch verifies the shared discussion endpoint before registration', async () => {
  const { service, fetcher } = fixture()
  const paths: string[] = []
  let status = 200
  fetcher.mockImplementation(async (url, init) => {
    paths.push(url.pathname)
    if (url.pathname === '/repos/org/project')
      return Response.json({ id: 41, full_name: 'org/project' })
    expect(init.method).toBe('HEAD')
    return new Response(null, { status })
  })
  const selection = {
    issues: false,
    pullRequests: false,
    issueComments: true,
    pullRequestComments: true,
  }
  expect(await service.verifyTracking('web', 'org/project', selection, signal)).toBe('org/project')
  expect(paths).toEqual(['/repos/org/project', '/repos/org/project/issues/comments'])
  status = 403
  await expect(service.verifyTracking(owner, 'org/project', selection, signal)).rejects.toThrow(
    '缺少读取权限（普通评论）',
  )
})

test('a bound App supplements but cannot widen the operator’s repository permission', async () => {
  const getToken = mock(async () => 'fixture-installation-token')
  const binding = { auth: { getToken }, ref: () => 'github_app_example' }
  const { service, fetcher } = fixture('github_listener_account', binding)
  let denied = 'Bearer fixture-token'
  const seen: (string | null)[] = []
  fetcher.mockImplementation(async (url, init) => {
    if (url.pathname === '/repos/org/project')
      return Response.json({ id: 1, full_name: 'org/project' })
    const credential = new Headers(init.headers).get('authorization')
    seen.push(credential)
    return new Response(null, { status: credential === denied ? 403 : 200 })
  })
  const start = () =>
    service.verifyTracking(owner, 'org/project', { issues: true, pullRequests: false }, signal)
  await expect(start()).rejects.toThrow('Issues 只读权限')
  expect(getToken).not.toHaveBeenCalled()
  denied = 'Bearer fixture-installation-token'
  await expect(start()).rejects.toThrow('Issues 只读权限')
  expect(getToken).toHaveBeenCalledTimes(1)
  denied = ''
  expect(await start()).toBe('org/project')
  expect(seen.slice(-2)).toEqual(['Bearer fixture-token', 'Bearer fixture-installation-token'])
})
