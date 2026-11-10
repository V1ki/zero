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

/** Minimal GitHub responses for a repository with no failed workflow runs. */
function github(url: URL) {
  return url.pathname.endsWith('/runs')
    ? Response.json({ workflow_runs: [] })
    : Response.json({ id: 5, full_name: 'org/project' })
}
const read = (
  service: ReturnType<typeof fixture>['service'],
  actor: CommissionOperator | 'web' = owner,
) => service.latestFailure(actor, 'org/project', signal)
const empty = { repository: 'org/project', latestFailure: null }

test('reads through the fixed connection, independent of listeners', async () => {
  const { service, fetcher } = fixture()
  fetcher.mockImplementation(async (url, init) => {
    expect(url.origin).toBe('https://api.github.com')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-token')
    return github(url)
  })
  expect(await read(service)).toEqual(empty)
  expect(fetcher).toHaveBeenCalledTimes(2)
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
    await expect(read(service, { ...owner, ...changed })).rejects.toThrow('授权')
  }
  snapshot.settings.github.routerOperators = undefined
  save()
  await expect(read(service)).rejects.toThrow('授权')
  expect(resolve).not.toHaveBeenCalled()
  expect(fetcher).not.toHaveBeenCalled()
  fetcher.mockImplementation(async (url) => github(url))
  expect(await read(service, 'web')).toEqual(empty)
})

test('missing or invalid connection never reads GitHub', async () => {
  for (const ref of ['', 'other_vault_item']) {
    const f = fixture(ref)
    await expect(read(f.service, 'web')).rejects.toThrow('配置 GitHub 凭证')
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.fetcher).not.toHaveBeenCalled()
  }
  const f = fixture()
  f.resolve.mockReturnValue(undefined)
  await expect(read(f.service)).rejects.toThrow('连接授权')
  expect(f.fetcher).not.toHaveBeenCalled()
})

test('withholds results if the grant is revoked or the connection changes during a read', async () => {
  for (const change of ['remove', 'rotate', 'switch']) {
    const { service, snapshot, resolve, fetcher, save } = fixture()
    const key = service.accessKey(owner)
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    fetcher.mockImplementation(async (url) => {
      if (change === 'rotate') resolve.mockReturnValue('replacement')
      if (change === 'remove') snapshot.settings.github.routerOperators = []
      if (change === 'switch') snapshot.settings.github.credentialRef = 'github_listener_new'
      save()
      return github(url)
    })
    await expect(read(service)).rejects.toThrow('授权已变化')
    expect(service.accessKey(owner)).not.toBe(key)
  }
})

test('sanitizes upstream errors', async () => {
  const { service, fetcher } = fixture()
  fetcher.mockImplementation(async () => new Response('private context', { status: 401 }))
  await expect(read(service)).rejects.toThrow('HTTP 401')
  fetcher.mockImplementation(async () => new Response('', { status: 429 }))
  await expect(read(service)).rejects.toThrow('限制查询频率')
})

test('unrelated settings changes preserve in-flight access while removing and restoring the same grant does not', async () => {
  const { service, snapshot, fetcher, save } = fixture()
  const original = service.accessKey(owner)
  fetcher.mockImplementation(async (url) => {
    snapshot.settings.wxarc.sessions.push({
      id: `room-${snapshot.revision}`,
      name: 'Room',
      enabled: false,
      keyword: '',
    })
    snapshot.settings.github.routerOperators?.push({ ...owner, operatorId: 'second' })
    save()
    return github(url)
  })
  expect(await read(service)).toEqual(empty)
  expect(service.accessKey(owner)).toBe(original)
  fetcher.mockImplementation(async (url) => {
    snapshot.settings.github.routerOperators = []
    save()
    snapshot.settings.github.routerOperators = [owner]
    save()
    return github(url)
  })
  await expect(read(service)).rejects.toThrow('授权已变化')
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
