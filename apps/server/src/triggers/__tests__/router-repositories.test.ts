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
const stores: TriggerStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture(ref = 'github_listener_account') {
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
