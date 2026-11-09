import { expect, mock, spyOn, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import type { TriggerGithubRepository } from '@zero-os/shared'
import { RouterWorkspaceService } from '../router-workspace'
import { TriggerRoutingRuntime } from '../routing-runtime'
import { ListenerRuntime } from '../runtime'

const appRef = 'github_app_router'
const patRef = 'github_listener_example'
const appRepo = 'Example/selected'
const patRepo = 'Example/unchanged'
const signal = new AbortController().signal
const selection = { workflowFailures: false, prComments: false, prBase: false, issues: true }

function fixture(
  getToken: (ref: string, repository: string, signal: AbortSignal) => Promise<string>,
) {
  const store = new TriggerStore(':memory:')
  const plain: TriggerGithubRepository = {
    name: patRepo,
    enabled: true,
    issues: true,
    workflowFailures: false,
    mention: '',
    workflow: '',
    branch: '',
  }
  store.saveSettings(
    {
      github: {
        credentialRef: patRef,
        repositories: [{ ...plain, name: appRepo, githubAppRef: appRef }, plain],
      },
      wxarc: { sessions: [] },
    },
    0,
  )
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected call')
  }
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: unexpected,
    weixin: { listTargets: () => [], send: unexpected },
  })
  const poll = mock(
    async (_repo: TriggerGithubRepository, _cursor: string | null, _token: string | undefined) => ({
      cursor: 'checked',
      events: [],
    }),
  )
  const secret = mock((ref: string) => (ref === patRef ? 'personal-test-token' : undefined))
  const runtime = new ListenerRuntime(
    store,
    secret,
    routing,
    new RouterWorkspaceService(store, routing, unexpected),
    { pollGithub: poll, pollWxarc: unexpected },
    undefined,
    { getToken },
  )
  async function waitForScan() {
    runtime.start()
    for (let i = 0; i < 100 && !store.readCursor('github:example/unchanged'); i++)
      await Bun.sleep(5)
    expect(store.readCursor('github:example/unchanged')).toBe('checked')
  }
  return { runtime, poll, secret, waitForScan, store }
}

test('poll and permission probes use only the installation bound to the selected repository', async () => {
  const getToken = mock(
    async (_ref: string, _name: string, _signal: AbortSignal) => 'installation-test-token',
  )
  const f = fixture(getToken)
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }))
  try {
    await f.waitForScan()
    expect(f.poll.mock.calls.map(([repo, , credential]) => [repo.name, credential])).toEqual([
      [appRepo, 'installation-test-token'],
      [patRepo, 'personal-test-token'],
    ])
    for (const repo of [appRepo.toLowerCase(), patRepo]) {
      const report = await f.runtime.checkGithubPermissions(repo, patRef, selection, signal)
      expect(report.checks).toEqual([{ resource: 'issues', status: 'readable' }])
    }
    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('Authorization')),
    ).toEqual(['Bearer installation-test-token', 'Bearer personal-test-token'])
    expect(getToken).toHaveBeenCalledTimes(2)
    expect(
      getToken.mock.calls.every(
        ([ref, name, signal]) =>
          ref === appRef &&
          name.toLowerCase() === appRepo.toLowerCase() &&
          signal instanceof AbortSignal,
      ),
    ).toBe(true)
    expect(f.secret.mock.calls).toEqual([[patRef], [patRef]])
  } finally {
    fetch.mockRestore()
    await f.runtime.close()
  }
})

test('failed App access records a scan error without advancing the cursor or trying another identity', async () => {
  const f = fixture(async () => {
    throw new Error('Installation unavailable')
  })
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }))
  try {
    await f.waitForScan()
    expect(f.runtime.getStatus().find((s) => s.scope === appRepo)?.state).toBe('error')
    expect(f.store.readCursor('github:example/selected')).toBeNull()
    expect(f.poll.mock.calls.map(([repo]) => repo.name)).toEqual([patRepo])
    await expect(
      f.runtime.checkGithubPermissions(appRepo, patRef, selection, signal),
    ).rejects.toThrow()
    expect(f.secret.mock.calls).toEqual([[patRef]])
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    fetch.mockRestore()
    await f.runtime.close()
  }
})
