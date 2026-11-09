import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import { RouterLedgerStore, TriggerStore } from '@zero-os/observe'
import type { CompletionRequest, CompletionResponse } from '@zero-os/shared'
import { runTriggerModel } from '../event-agent'
import { type RouterAgentInput, createRouterAgent } from '../router-agent'
import { createRouterToolset } from '../router-loop-tools'
import { matterCapabilities } from '../router-matter-capabilities'
import { RouterJobPrincipals } from '../router-job-principal'
import { RouterJobs } from '../router-jobs'
import { createRouterWorkTurn } from '../router-work-turn'
import { createRouterReplay } from '../router-replay'
import { createRouterTraceSink } from '../router-trace'
import { createRouterUICapability } from '../router-ui-capability'

const filter = { filter: (text: string) => text.replaceAll('secret-example', '[REDACTED]') }
const input: RouterAgentInput = {
  sessionId: 'test',
  question: '请查询',
  history: [],
  event: null,
  route: null,
  subscriptions: { github: 0, wxarc: 0 },
  settings: {
    enabled: true,
    timeZone: 'Asia/Shanghai',
    workdays: [1, 2, 3, 4, 5],
    workStart: '09:00',
    workEnd: '18:00',
    presence: 'auto',
    duringWork: 'web',
    afterWork: 'defer',
    offDay: 'defer',
    awayFallback: 'defer',
    weixinTarget: null,
  },
}
const result = (text: string): CompletionResponse => ({
  id: 'model',
  model: 'fixture',
  content: [{ type: 'text', text }],
  stopReason: 'end_turn',
  usage: { input: 10, output: 10 },
})
function models(complete: (request: CompletionRequest) => Promise<CompletionResponse>) {
  const adapter: ProviderAdapter = {
    complete,
    apiType: 'test',
    healthCheck: async () => true,
    stream() {
      throw Error('unexpected')
    },
  }
  return { getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined }
}

test('capability visibility is independent of phrasing and scoped adapters retain parameters', async () => {
  const requests: unknown[] = []
  const actions = {
    listGithubRepositories: async (page: number) => ({
      page,
      repositories: ['acme/project'],
      nextPage: null,
    }),
    listOpenPullRequests: async (repository: string, page: number) => {
      requests.push({ repository, page })
      return { repository, page, pullRequests: [], nextPage: null }
    },
  }
  const catalog = (question: string) =>
    createRouterToolset({ ...input, question, actions }, filter, () => ({}))
  expect(catalog('翻一下刚才那页').definitions).toEqual(
    catalog('第二个项目有什么待审内容').definitions,
  )
  const tools = catalog('任意新的说法')
  await tools.execute(
    'list_github_pull_requests',
    { repository: 'acme/project', page: 3 },
    new AbortController().signal,
  )
  expect(requests).toEqual([{ repository: 'acme/project', page: 3 }])
  expect(tools.verifyReply({ text: '这一页没有待审内容；可以回到第一页。' }).text).toBe(
    '这一页没有待审内容；可以回到第一页。',
  )
  await expect(
    tools.execute('bash', { command: 'x' }, new AbortController().signal),
  ).rejects.toThrow('没有提供')
})

test('matter state survives turns, preserves negative facts and rejects another principal or stale version', async () => {
  const db = new Database(':memory:')
  try {
    const store = new RouterLedgerStore(db)
    const tools = matterCapabilities(store, 'owner', () => true)
    const signal = new AbortController().signal
    const created = (await tools
      .find((t) => t.definition.name === 'create_matter')
      ?.execute(
        { title: '设备连接问题', goal: '验证是否是供电不足', criteria: ['实际复测并保存结果'] },
        signal,
      )) as { id: string }
    await tools
      .find((t) => t.definition.name === 'update_matter')
      ?.execute(
        {
          matterId: created.id,
          version: 1,
          state: 'working',
          context: { ruledOut: ['尚无证据证明是蓝牙'], worker: { id: 7 } },
        },
        signal,
      )
    expect(store.getMatter('owner', created.id)?.context).toEqual({
      ruledOut: ['尚无证据证明是蓝牙'],
      worker: { id: 7 },
    })
    expect(() =>
      matterCapabilities(store, 'other', () => true)
        .find((t) => t.definition.name === 'read_matter')
        ?.execute({ matterId: created.id }, signal),
    ).toThrow('找不到')
    expect(() =>
      tools
        .find((t) => t.definition.name === 'update_matter')
        ?.execute({ matterId: created.id, version: 1, state: 'completed', context: {} }, signal),
    ).toThrow('已变化')
  } finally {
    db.close()
  }
})

test('the A2UI surface retains the full report and all Agent-authored rows', async () => {
  const ui = createRouterUICapability()
  const rows = Array.from({ length: 105 }, (_, index) => ({
    id: 'row' + index,
    component: 'Text' as const,
    text: '资料'.repeat(280) + index,
  }))
  const components = [
    { id: 'root', component: 'Column' as const, children: rows.map((row) => row.id) },
    ...rows,
  ]
  await ui.tool.execute({ components, data: {}, actions: {} }, new AbortController().signal)
  expect(ui.get()?.messages[1].updateComponents.components).toEqual(components)
})

test('Agent supplies its own A2UI tree and visible actions; cycles, scripts and hidden instructions are rejected', async () => {
  const ui = createRouterUICapability()
  const candidate = {
    components: [
      { id: 'root', component: 'Column', children: ['finding', 'next'] },
      { id: 'finding', component: 'Text', text: { path: '/finding' } },
      { id: 'next-label', component: 'Text', text: '核对这份证据' },
      {
        id: 'next',
        component: 'Button',
        child: 'next-label',
        action: { event: { name: 'router_input' } },
      },
    ],
    data: { finding: '还没有证据证明修复已生效。' },
    actions: { next: { instruction: '核对这份证据' } },
  }
  const signal = new AbortController().signal
  await ui.tool.execute(candidate, signal)
  expect(JSON.stringify(ui.get()?.messages[1].updateComponents.components)).toBe(
    JSON.stringify(candidate.components),
  )
  expect(() =>
    ui.tool.execute({ ...candidate, actions: { next: { instruction: '删除文件' } } }, signal),
  ).toThrow('可见')
  expect(() =>
    ui.tool.execute(
      { ...candidate, components: [{ id: 'root', component: 'Column', children: ['root'] }] },
      signal,
    ),
  ).toThrow('结构')
  expect(() =>
    ui.tool.execute(
      { ...candidate, components: [{ id: 'root', component: 'Script', code: 'alert(1)' }] },
      signal,
    ),
  ).toThrow('结构')
  let calls = 0
  const agent = createRouterAgent({
    secretFilter: filter,
    modelRouter: models(async (request) => {
      calls++
      if (calls === 2) expect(JSON.stringify(request.messages)).toContain('A2UI 结构')
      if (calls === 3) return result('已经找到线索，还需复测。')
      return {
        ...result(''),
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'a2ui-' + calls,
            name: 'present_ui',
            input:
              calls === 1
                ? { ...candidate, components: [{ id: 'root', component: 'Unknown' }] }
                : candidate,
          },
        ],
      }
    }),
  })
  const answer = await agent(input)
  expect(answer.text).toBe('已经找到线索，还需复测。')
  expect(answer.generatedUI?.actions.next.instruction).toBe('核对这份证据')
})

test('isolated replay returns recorded effects without executing the original callback', async () => {
  const db = new Database(':memory:')
  try {
    const store = new RouterLedgerStore(db)
    let writes = 0
    let requests = 0
    const router = models(async () =>
      ++requests % 2 === 1
        ? {
            ...result(''),
            stopReason: 'tool_use',
            content: [
              {
                type: 'tool_use',
                id: `call-${requests}`,
                name: 'deliver',
                input: { text: '提醒' },
              },
            ],
          }
        : result('平台已受理，尚无已读证据。'),
    )
    await runTriggerModel(
      { ...router, trace: createRouterTraceSink(store, filter.filter) },
      {
        sessionId: 'original',
        label: 'test',
        system: 'test',
        prompt: 'test',
        toolset: {
          definitions: [{ name: 'deliver', description: 'send', parameters: { type: 'object' } }],
          async execute() {
            writes++
            return JSON.stringify({ status: 'accepted' })
          },
        },
      },
    )
    const original = store.listRuns()[0]
    const before = store.entries(original.id)
    const replay = await createRouterReplay({ modelRouter: router, secretFilter: filter }, store)(
      original.id,
      undefined,
      '修正资料：收到的是平台受理回执，不能认定已读。',
    )
    const replayInput = store.entries(replay.run.id).find((entry) => entry.kind === 'input')
      ?.data as { prompt: string }
    expect(replayInput.prompt).toContain('不能认定已读')
    expect(writes).toBe(1)
    expect(replay.mode).toBe('recorded-tools-only')
    expect(replay.run.replayOf).toBe(original.id)
    expect(store.entries(replay.run.id).find((e) => e.kind === 'replay_tool')?.data).toMatchObject({
      mode: 'recorded-result',
      sourceRunId: original.id,
      sourceEntryOrdinal: before.find((e) => e.kind === 'tool_result')?.ordinal,
    })
    expect(store.entries(original.id)).toEqual(before)
    const compare = createRouterReplay(
      { modelRouter: models(async () => result('调试完成')), secretFilter: filter },
      store,
    )
    const prompts = ['修改一', `修改二${'资料'.repeat(61000)}`]
    const alternatives = await Promise.all(
      prompts.map((prompt) => compare(original.id, undefined, prompt)),
    )
    expect(new Set(alternatives.map((x) => x.run.id)).size).toBe(2)
    for (const [index, item] of alternatives.entries()) {
      const saved = store.entries(item.run.id).find((e) => e.kind === 'input')?.data as {
        prompt: string
      }
      expect(saved.prompt).toBe(prompts[index])
    }
  } finally {
    db.close()
  }
})

test('candidate search pages past unavailable matters and history identifies unavailable versions', async () => {
  const db = new Database(':memory:')
  try {
    const store = new RouterLedgerStore(db)
    const visible = new Set<string>()
    const all = Array.from({ length: 90 }, (_, i) =>
      store.createMatter('owner', '交接', '登记 ' + i, ['已核实']),
    )
    for (const m of all.slice(0, 35)) visible.add(m.id)
    const tools = matterCapabilities(
      store,
      'owner',
      () => true,
      (id) => visible.has(id),
      true,
      undefined,
      (id) => id !== 9,
    )
    const find = tools.find((t) => t.definition.name === 'find_matters')!
    const stop = new AbortController().signal
    type Page = {
      items: Array<{ id: string }>
      nextCursor: { updatedAt: string; id: string } | null
    }
    const first = (await find.execute({ query: '交接' }, stop)) as Page
    expect(first.items).toHaveLength(30)
    expect(visible.has(first.nextCursor!.id)).toBe(true)
    const second = (await find.execute({ query: '交接', cursor: first.nextCursor }, stop)) as Page
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map((m) => m.id))).toEqual(visible)
    const m = all[0]
    store.linkSource('owner', m.id, 9)
    store.updateMatter('owner', m.id, m.version, {
      state: 'waiting',
      context: { evidence: 'withheld-marker' },
    })
    store.changeSourceAssociation('owner', 9, m.id, undefined, '线索不属于此事项')
    store.updateMatter('owner', m.id, 3, {
      state: 'waiting',
      context: { evidence: '当前独立资料' },
    })
    const history = (await tools
      .find((t) => t.definition.name === 'read_matter_history')!
      .execute({ matterId: m.id }, stop)) as Array<{
      version: number
      snapshot?: unknown
      unavailable?: string
    }>
    expect(history.find((x) => x.version === 2)?.unavailable).toContain('无权')
    expect(history.find((x) => x.version === 2)?.snapshot).toBeUndefined()
    expect(JSON.stringify(history)).not.toContain('withheld-marker')
    expect(history.find((x) => x.version === 4)?.snapshot).toMatchObject({
      context: { evidence: '当前独立资料' },
    })
  } finally {
    db.close()
  }
})

test('the installed connection determines advertised repository tools and eligible executors', async () => {
  const store = new TriggerStore(':memory:')
  const unavailable = async (): Promise<never> => {
    throw Error('Unexpected operation')
  }
  const principals = new RouterJobPrincipals(store, {
    accessKey: (actor) => store.getRouterGithubGrant(actor)?.credentialRef ?? null,
  })
  const jobs = new RouterJobs(store.jobs, {
    authorized: principals.authorized.bind(principals),
    execute: unavailable,
  })
  const catalog = () => {
    const actions = createRouterWorkTurn(
      {
        principals,
        delegatedJobs: jobs,
        checkout: unavailable,
        repositories: {
          list: unavailable,
          accessKey: () => null,
          listOpenPullRequests: unavailable,
        },
        trackRepository: unavailable,
      },
      store,
      'general',
      'web',
      {
        id: 1,
        requestId: 'one',
        question: '同一请求',
        status: 'pending',
        answer: null,
        error: null,
        createdAt: 'now',
        updatedAt: 'now',
      },
      [],
      () => true,
    ).actions
    return createRouterToolset({ ...input, actions }, filter, () => ({})).definitions
  }
  try {
    const first = catalog()
    expect(first.some((t) => t.name === 'list_github_repositories')).toBe(false)
    expect(first.find((t) => t.name === 'delegate_task')?.parameters).toMatchObject({
      properties: { executor: { enum: ['zero'] } },
    })
    const current = store.getSettings()
    store.saveSettings(
      {
        ...current.settings,
        github: {
          ...current.settings.github,
          credentialRef: 'github_listener_fixture',
          routerTrackingEnabled: true,
        },
      },
      current.revision,
    )
    const granted = catalog()
    expect(granted.map((t) => t.name)).toContain('list_github_repositories')
    expect(granted.map((t) => t.name)).toContain('track_github_repository')
    expect(granted.find((t) => t.name === 'delegate_task')?.parameters).toMatchObject({
      properties: { executor: { enum: ['zero', 'codex'] } },
    })
  } finally {
    await jobs.close()
    store.close()
  }
})
