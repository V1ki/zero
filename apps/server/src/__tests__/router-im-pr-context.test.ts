import { expect, mock, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import { TriggerStore } from '@zero-os/observe'
import type { CommissionOperator, CompletionRequest } from '@zero-os/shared'
import { createRouterAgent } from '../triggers/router-agent'
import { RouterJobPrincipals, routerImScope } from '../triggers/router-job-principal'
import { createRouterRepositoryLookup } from '../triggers/router-repositories'
import { createRouterRepositoryTracking } from '../triggers/router-repository-tracking'
import { RouterWorkspaceService } from '../triggers/router-workspace'
import { TriggerRoutingRuntime } from '../triggers/routing-runtime'

test('WeChat follows its tracked repository through live PR pages and detail, preserving old pagination and chat authorization', async () => {
  const owner: CommissionOperator = {
    platform: 'weixin',
    channelId: 'weixin-bot',
    peerId: 'private-owner',
    operatorId: 'owner',
  }
  const other: CommissionOperator = { ...owner, platform: 'feishu', channelId: 'feishu-bot' }
  const repository = { id: 47, full_name: 'V1ki/dsh-plugin-subscriptions' }
  const alternative = { id: 48, full_name: 'V1ki/other' }
  const path = `/repos/${repository.full_name}`
  const url = `https://github.com/${repository.full_name}/pull/62`
  const title = '恢复失效的订阅'
  const question = '帮我查一下这个项目里面现有的 PR。'
  const store = new TriggerStore(':memory:')
  const { settings, revision } = store.getSettings()
  store.saveSettings(
    {
      ...settings,
      github: {
        ...settings.github,
        credentialRef: 'github_listener_fixture',
        routerOperators: [owner, other],
        routerTrackingEnabled: true,
      },
    },
    revision,
  )
  const targets = [owner, other].map((t) => ({ ...t, label: t.platform }))
  const unexpected = async () => {
    throw Error('Unexpected notification or worker')
  }
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: unexpected,
    weixin: { listTargets: () => [], send: unexpected },
    personal: {
      listPersonalBots: () => targets.map((t) => ({ ...t, online: true })),
      listPersonalTargets: () => targets,
      listPersonalDirectTargets: () => targets,
      sendPersonal: unexpected,
    },
  })
  const initialRouting = routing.getConfig()
  routing.saveConfig(
    {
      ...initialRouting.settings,
      personalBots: { weixin: owner.channelId, feishu: other.channelId },
    },
    initialRouting.revision,
  )

  let pullCount = 16
  const pages: { repo: string; page: number; size: number }[] = []
  const fetcher = mock(async (input: URL, init: RequestInit) => {
    const repo = [repository, alternative].find((r) =>
      [`/repos/${r.full_name}`, `/repos/${r.full_name}/pulls`].includes(input.pathname),
    )
    if (repo && input.pathname === `/repos/${repo.full_name}`) return Response.json(repo)
    if (init.method === 'HEAD' && [`${path}/issues`, `${path}/pulls`].includes(input.pathname))
      return new Response(null, { status: 200 })
    if (repo && input.searchParams.get('state') === 'open') {
      const page = Number(input.searchParams.get('page'))
      const size = Number(input.searchParams.get('per_page'))
      pages.push({ repo: repo.full_name, page, size })
      const start = 1 + (page - 1) * size
      const pulls = Array.from(
        { length: Math.max(0, Math.min(size, pullCount - start + 1)) },
        (_, i) => {
          const number = 63 - start - i
          return {
            number,
            title: number === 62 ? title : `修订 ${number}`,
            state: 'open',
            draft: false,
            html_url: `https://github.com/${repo.full_name}/pull/${number}`,
            base: { repo },
          }
        },
      )
      const next = new URL(input)
      next.searchParams.set('page', String(page + 1))
      return Response.json(pulls, {
        headers: page * size < pullCount ? { link: `<${next}>; rel="next"` } : {},
      })
    }
    throw Error(`Unexpected GitHub route: ${input.pathname}`)
  })
  const repositories = createRouterRepositoryLookup(
    (actor) => store.getRouterGithubGrant(actor),
    () => 'fixture-only',
    fetcher,
  )
  const principals = new RouterJobPrincipals(store, repositories)
  const changed = mock(() => {})
  const trackRepository = createRouterRepositoryTracking({
    store,
    repositories,
    principals,
    changed,
  })
  const requests: CompletionRequest[] = []
  // Script the model's intent; the host supplies history and executes its explicit tool calls.
  type Decision = {
    kind?: 'track' | 'detail' | 'last'
    page?: number
    pageSize?: 5 | 10
    repo?: string
  }
  let decision: Decision = {}
  const adapter: ProviderAdapter = {
    apiType: 'fixture',
    healthCheck: async () => true,
    stream() {
      throw Error('Unexpected streaming')
    },
    async complete(req) {
      requests.push(structuredClone(req))
      const last = req.messages.at(-1)?.content[0]
      const meta = { id: crypto.randomUUID(), model: 'fixture', usage: { input: 1, output: 1 } }
      const answer = (text: string) => ({
        ...meta,
        stopReason: 'end_turn' as const,
        content: [{ type: 'text' as const, text }],
      })
      if (last?.type === 'tool_result') {
        if (last.isError) return answer('当前无法读取这个仓库。')
        const data = JSON.parse(last.content)
        if (Array.isArray(data.pullRequests))
          return answer(
            data.pullRequests.length
              ? data.pullRequests
                  .map((pr: { number: number; title: string }) => `#${pr.number} ${pr.title}`)
                  .join('\n')
              : '当前没有开放 PR。',
          )
        return answer(`已保存 ${data.repository} 的监听。`)
      }
      const visible = JSON.stringify(req.messages)
      const repo = decision.repo ?? repository.full_name
      if (!visible.includes(repo)) return answer('请告诉我仓库名称。')
      if (decision.kind === 'detail') {
        expect(visible).toContain(title)
        expect(visible).toContain(url)
        return answer(`#62 ${title}\n${url}`)
      }
      if (decision.kind === 'last') {
        expect(visible).toContain('nextPage')
        return answer('已经到最后一页。')
      }
      const track = decision.kind === 'track'
      return {
        ...meta,
        stopReason: 'tool_use' as const,
        content: [
          {
            type: 'tool_use' as const,
            id: crypto.randomUUID(),
            name: track ? 'track_github_repository' : 'list_github_pull_requests',
            input: track
              ? {
                  repository: repo,
                  issues: true,
                  pullRequests: true,
                  issueComments: false,
                  pullRequestComments: false,
                }
              : {
                  repository: repo,
                  page: decision.page ?? 1,
                  ...(decision.pageSize && { pageSize: decision.pageSize }),
                },
          },
        ],
      }
    },
  }
  const core = {
    modelRouter: { getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined },
    secretFilter: { filter: (s: string) => s },
  }
  const createWorkspace = () =>
    new RouterWorkspaceService(store, routing, createRouterAgent(core), {
      repositories,
      principals,
      trackRepository,
    })
  let workspace = createWorkspace()
  function receive(actor: CommissionOperator, text: string, plan: Decision = {}) {
    decision = plan
    const access = routing.claimRouterImTarget(actor)
    if (!access) throw Error('Expected an authenticated direct target')
    return workspace.handleIm(
      { ...actor, actorId: actor.operatorId, messageId: crypto.randomUUID(), isDirect: true, text },
      access,
    )
  }
  const scope = routerImScope(owner)
  try {
    workspace.start()
    expect(
      await receive(owner, '帮我跟踪 V1ki/dsh-plugin-subscriptions 的 Issue 和 PR', {
        kind: 'track',
      }),
    ).toContain(repository.full_name)
    expect(store.conversations.list(scope).at(-1)?.answer?.tracking?.repository).toBe(
      repository.full_name,
    )
    // Preserve the old product's completed error turn; upgrading must not require tracking again.
    const old = store.conversations.begin(scope, 'old-error', question)
    if (old.kind !== 'started') throw Error('Failed to create old Router turn')
    store.conversations.finish(scope, 'old-error', old.attempt, {
      text: '请选择用户本轮点名的仓库，或按刚才列表中的序号选择。',
    })
    await workspace.close()
    workspace = createWorkspace()
    workspace.start()

    const result = await receive(owner, question)
    expect(result).toContain(title)
    expect(result).not.toContain(url)
    const answer = store.conversations.list(scope).at(-1)?.answer
    expect(answer?.toolSteps).toContainEqual({ name: 'list_github_pull_requests', ok: true })
    const lastPage = () => store.conversations.list(scope).at(-1)?.answer?.pullRequests
    const legacyEntries = [...(answer?.pullRequests?.pullRequests ?? [])]
    expect(lastPage()?.repository).toBe(repository.full_name)
    expect(lastPage()?.pullRequests.map((pr) => pr.number)).toEqual([62, 61, 60, 59, 58])
    expect(pages.at(-1)).toEqual({ repo: repository.full_name, page: 1, size: 5 })
    expect(changed).toHaveBeenCalledTimes(1)

    const readCount = pages.length
    const detail = await receive(owner, 'PR 62', { kind: 'detail' })
    expect(detail).toContain(title)
    expect(detail).toContain(url)
    expect(pages).toHaveLength(readCount)

    for (const [index, text] of ['下一页', '更多 PR', '继续看 PR'].entries()) {
      const expectedPage = 2 + index
      await receive(owner, text, { page: expectedPage })
      expect(pages.at(-1)).toEqual({ repo: repository.full_name, page: expectedPage, size: 5 })
      expect(lastPage()?.pullRequests[0].number).toBe(62 - 5 * (expectedPage - 1))
      if (expectedPage === 2) legacyEntries.push(...(lastPage()?.pullRequests ?? []))
    }
    const lastRead = pages.length
    expect(await receive(owner, '更多 PR', { kind: 'last' })).toContain('最后一页')
    expect(pages).toHaveLength(lastRead)
    // A pre-upgrade receipt used ten PRs per page but did not store its page size.
    const legacy = store.conversations.begin(scope, 'legacy-pr-page', question)
    if (legacy.kind !== 'started' || !answer?.pullRequests) throw Error('Expected prior PR receipt')
    const persisted = structuredClone(answer)
    persisted.pullRequests = {
      repository: repository.full_name,
      page: 1,
      nextPage: 2,
      pullRequests: legacyEntries,
    }
    store.conversations.finish(scope, 'legacy-pr-page', legacy.attempt, persisted)
    await receive(owner, '下一页', { page: 2, pageSize: 10 })
    expect(pages.at(-1)).toEqual({ repo: repository.full_name, page: 2, size: 10 })
    expect(lastPage()?.pullRequests[0].number).toBe(52)

    // Recreate the two receipts left by an older Router: it showed an empty second page
    // and then asked for the repository again. Neither turn changes the selected repository.
    const inventory = '这个项目现在有哪些 PR」'
    const firstPage = '那第一页呢？'
    const empty = store.conversations.begin(scope, 'old-empty-second-page', inventory)
    if (empty.kind !== 'started') throw Error('Expected prior empty page')
    store.conversations.finish(scope, 'old-empty-second-page', empty.attempt, {
      ...persisted,
      text: '开放 PR 第 2 页没有结果。',
      pullRequests: {
        repository: repository.full_name,
        page: 2,
        pageSize: 10,
        nextPage: null,
        pullRequests: [],
      },
    })
    const failed = store.conversations.begin(scope, 'old-clarification', firstPage)
    if (failed.kind !== 'started') throw Error('Expected prior failed lookup')
    store.conversations.finish(scope, 'old-clarification', failed.attempt, {
      text: '请指定要查开放 PR 的仓库全名，例如 owner/repository。',
    })
    await workspace.close()
    workspace = createWorkspace()
    workspace.start()
    const beforeFirst = pages.length
    expect(await receive(owner, firstPage)).toContain(title)
    expect(lastPage()).toMatchObject({ repository: repository.full_name, page: 1 })
    expect(pages).toHaveLength(beforeFirst + 1)

    // A fresh inventory uses the model's requested first page, even after an old empty page.
    const beforeRefresh = pages.length
    const listed = await receive(owner, inventory)
    expect(listed).toContain(title)
    expect(pages.slice(beforeRefresh)).toEqual([{ repo: repository.full_name, page: 1, size: 5 }])
    expect(lastPage()?.pullRequests.map((pr) => pr.number)).toEqual([62, 61, 60, 59, 58])

    // A natural follow-up can use the Agent's navigation intent without repeating the tool or repository.
    await receive(owner, '这一批看过了，换一批看看。', { page: 2 })
    expect(pages.at(-1)).toEqual({ repo: repository.full_name, page: 2, size: 5 })
    await receive(owner, '上一页')
    expect(pages.at(-1)).toEqual({ repo: repository.full_name, page: 1, size: 5 })

    await receive(owner, `列出 ${alternative.full_name} 的 PR 第 2 页`, {
      repo: alternative.full_name,
      page: 2,
    })
    expect(pages.at(-1)).toEqual({ repo: alternative.full_name, page: 2, size: 5 })

    pullCount = 0
    const refreshed = await receive(owner, question, { repo: alternative.full_name })
    expect(refreshed).not.toContain(title)
    expect(refreshed).toMatch(/没有|暂无|0|未找到|无开放/u)
    expect(store.conversations.list(scope).at(-1)?.answer?.pullRequests?.pullRequests).toEqual([])

    const before = fetcher.mock.calls.length
    const beforeOther = requests.length
    const otherPage = await receive(other, '下一页')
    expect(otherPage).not.toContain(alternative.full_name)
    const isolated = await receive(other, question)
    expect(isolated).not.toContain(repository.full_name)
    expect(
      store.conversations.list(routerImScope(other)).at(-1)?.answer?.pullRequests,
    ).toBeUndefined()
    expect(JSON.stringify(requests.slice(beforeOther))).not.toContain(repository.full_name)
    expect(JSON.stringify(requests.slice(beforeOther))).not.toContain(alternative.full_name)
    expect(fetcher.mock.calls.length).toBe(before)

    const grant = store.getSettings()
    store.saveSettings(
      { ...grant.settings, github: { ...grant.settings.github, routerOperators: [other] } },
      grant.revision,
    )
    const beforeRevoke = requests.length
    const denied = await receive(owner, question)
    expect(denied).not.toContain(title)
    expect(store.conversations.list(scope).at(-1)?.answer?.pullRequests).toBeUndefined()
    expect(JSON.stringify(requests.slice(beforeRevoke))).not.toContain(title)
    expect(fetcher.mock.calls.length).toBe(before)
    await receive(other, `列出 ${repository.full_name} 的开放 PR`)
    expect(pages.at(-1)).toEqual({ repo: repository.full_name, page: 1, size: 10 })
  } finally {
    await workspace.close()
    await routing.close()
    store.close()
  }
})
