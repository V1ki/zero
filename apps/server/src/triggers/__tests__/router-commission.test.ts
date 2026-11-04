import { afterEach, expect, mock, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import { TriggerStore } from '@zero-os/observe'
import type {
  CommissionOperator,
  CompletionRequest,
  MandatePolicy,
  RouterSurfaceAction,
} from '@zero-os/shared'
import { type CommissionCatalog, type CommissionIntent, commissionIntent } from '../commission-plan'
import { mandateSnapshot } from '../mandate-input'
import { RouterCommissionService } from '../router-commission'
import { RouterWorkspaceService } from '../router-workspace'
import { TriggerRoutingRuntime } from '../routing-runtime'

function draftCode(value: { commission?: { code: string } } | null) {
  if (!value?.commission) throw Error('Expected commission preview')
  return value.commission.code
}
const actor: CommissionOperator = {
  platform: 'feishu',
  channelId: 'f1',
  peerId: 'room1',
  operatorId: 'user1',
}
const create = {
  source: 'S1',
  name: '发布进展',
  purpose: '跟踪构建失败',
  keyword: '构建失败',
  targets: [],
  archive: null,
  project: null,
  policy: { duringWork: 'web' },
  urgent: false,
  deadline: null,
}
const stores: TriggerStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
})
function fixture() {
  const store = new TriggerStore(':memory:')
  stores.push(store)
  store.saveSettings(
    {
      github: { repositories: [], credentialRef: '' },
      wxarc: {
        sessions: ['room-a', 'secret-room'].map((id) => ({
          id,
          name: id,
          keyword: '',
          enabled: true,
        })),
      },
    },
    0,
  )
  let at = 500
  let result: unknown = create
  let beforeSave = async () => {}
  let beforePlan = async () => {}
  const plan = mock(
    async (_question: string, _intent: CommissionIntent, _catalog: CommissionCatalog) => {
      await beforePlan()
      return result
    },
  )
  const registry = {
    getConfig: () => store.mandates.getSettings(),
    async targets() {
      return {
        targets: [
          { ...actor, label: '工程群' },
          {
            platform: 'dingtalk' as const,
            channelId: 'ding',
            peerId: 'project',
            operatorId: 'staff',
            label: '发布群',
          },
        ],
        archiveChannels: [],
      }
    },
    async saveConfig(raw: unknown, hooks?: { before(): void; after(): void }) {
      const { settings, revision } = mandateSnapshot(raw)
      await beforeSave()
      store.mandates.saveSettings(settings, revision, hooks)
      return store.mandates.getSettings()
    },
  }
  const commission = new RouterCommissionService(store, registry, plan, () => at)
  const grant = () =>
    commission.saveGrants({
      revision: store.conversations.commissions.grants().revision,
      grants: [{ operator: actor, source: 'wxarc', scope: 'room-a' }],
    })
  return {
    store,
    commission,
    plan,
    grant,
    registry,
    modelOutput: (v: unknown) => {
      result = v
    },
    later: () => {
      at += 600001
    },
    beforePlan: (fn: () => Promise<void>) => {
      beforePlan = fn
    },
    beforeSave: (fn: () => Promise<void>) => {
      beforeSave = fn
    },
  }
}

test('Web A2UI owns a named preview and atomically saves its mandate and receipt only once', async () => {
  const f = fixture()
  const unavailable = async (): Promise<never> => {
    throw Error('unexpected')
  }
  const routing = new TriggerRoutingRuntime(f.store.routing, {
    analyze: unavailable,
    weixin: { listTargets: () => [], send: unavailable },
  })
  const workspace = new RouterWorkspaceService(
    f.store,
    routing,
    async ({ actions }, signal) => {
      if (!actions?.prepareCommission || !signal) throw Error('Missing Web commission tool')
      await actions.prepareCommission('create', signal)
      return { text: '请核对委托草案。' }
    },
    { commission: f.commission },
  )
  workspace.start()
  try {
    const question = 'room-a 的发布流水线麻烦帮我盯着，一有构建失败就记下来。'
    expect(commissionIntent(question)).toBeNull()
    const view = await workspace.message('general', 'r1', question)
    expect(f.plan.mock.calls[0]?.slice(0, 2)).toEqual([question, 'create'])
    expect((await workspace.message('general', 'r1', question)).turns).toHaveLength(1)
    expect(f.plan).toHaveBeenCalledTimes(1)
    const card = view.turns[0].surface
    if (!card) throw Error('missing card')
    const action: RouterSurfaceAction = {
      version: card[0].version,
      action: {
        name: 'confirm_mandate',
        surfaceId: card[0].createSurface.surfaceId,
        sourceComponentId: 'btn-confirm_mandate',
        timestamp: new Date().toISOString(),
        context: {},
      },
    }
    expect(f.registry.getConfig().settings.mandates).toHaveLength(0)
    await expect(workspace.action('general', 'r1', action)).rejects.toThrow('请求编号')
    expect(f.registry.getConfig().revision).toBe(0)
    await workspace.action('general', 'confirmation', action)
    await workspace.action('general', 'confirmation', action)
    expect(f.registry.getConfig().settings.mandates.map((m) => m.purpose)).toEqual(['跟踪构建失败'])
    const changed = workspace.get('general').turns[0].surface
    expect(changed?.[2].updateDataModel.value).toContainValue('已确认并保存。')
  } finally {
    await workspace.close()
    await routing.close()
  }
})

test('concurrent web tool calls plan once from the original wording without publishing a mandate', async () => {
  const f = fixture()
  const question = 'room-a 里再出现构建失败就帮我记下来。'
  const prepare = () => f.commission.prepareFromIntent('draft', question, 'create')
  const [first, second] = await Promise.all([prepare(), prepare()])
  expect(draftCode(first)).toBe(draftCode(second))
  expect(f.plan.mock.calls.map(([text, intent]) => [text, intent])).toEqual([[question, 'create']])
  expect(f.registry.getConfig().settings.mandates).toHaveLength(0)
})

test('IM drafts use only granted sources and addresses, bind the confirmation to the verified actor and chat, support pause/resume', async () => {
  const f = fixture()
  expect(await f.commission.handleIm(actor, 'u1', '跟踪 room-a 的构建失败')).toContain('没有可用')
  expect(f.plan).toHaveBeenCalledTimes(0)
  await f.grant()
  const text = await f.commission.handleIm(actor, 'u1', '跟踪 room-a 的构建失败')
  const code = /确认委托 ([0-9a-f]{12})/.exec(text ?? '')?.[1]
  expect(code).toBeDefined()
  expect(await f.commission.handleIm(actor, 'u1', '跟踪 room-a 的构建失败')).toEqual(text)
  expect(f.plan.mock.calls[0][2].sources.map((s) => s.scope)).toEqual(['room-a'])
  expect(f.plan.mock.calls[0][2].projects).toEqual([])
  expect(
    await f.commission.handleIm({ ...actor, operatorId: 'user2' }, 'x', `确认委托 ${code}`),
  ).toContain('没有这项')
  expect(
    await f.commission.handleIm({ ...actor, peerId: 'other' }, 'y', `确认委托 ${code}`),
  ).toContain('没有这项')
  expect(f.registry.getConfig().revision).toBe(0)
  for (const request of ['c1', 'c2'])
    expect(await f.commission.handleIm(actor, request, `确认委托 ${code}`)).toBe('委托已确认。')
  f.modelOutput({ mandate: 'M1' })
  for (const [idx, verb] of ['暂停', '恢复'].entries()) {
    const a = await f.commission.prepare(actor, `m${idx}`, `${verb}发布进展委托`)
    expect(f.plan.mock.lastCall?.[2].mandates).toHaveLength(1)
    await f.commission.confirm(actor, draftCode(a))
    expect(f.registry.getConfig().settings.mandates[0].enabled).toBe(idx === 1)
  }
  // A Web delete and recreation with identical content and id must not restore old IM authority.
  const current = f.registry.getConfig()
  await f.registry.saveConfig({
    revision: current.revision,
    settings: { projects: [], mandates: [] },
  })
  await f.registry.saveConfig({ ...current, revision: current.revision + 1 })
  expect(await f.commission.handleIm(actor, 'after-delete', '暂停发布进展委托')).toContain(
    '授权范围',
  )
  expect(f.plan.mock.lastCall?.[2].mandates).toEqual([])
})

test('expired/revoked grants, stale projects, and out-of-catalog identifiers cannot change a mandate', async () => {
  const f = fixture()
  await f.grant()
  const prepare = async (key: string) =>
    draftCode(await f.commission.prepare(actor, key, '跟踪 room-a 的构建失败'))
  const expired = await prepare('e')
  f.later()
  await expect(f.commission.confirm(actor, expired)).rejects.toThrow('失效')
  const revoked = await prepare('r')
  f.beforeSave(async () => {
    await f.commission.saveGrants({ revision: 1, grants: [] })
  })
  await expect(f.commission.confirm(actor, revoked)).rejects.toThrow('失效')
  expect(f.registry.getConfig().revision).toBe(0)
  f.beforeSave(async () => {})
  await f.grant()
  f.modelOutput({ ...create, source: 'S2' })
  await expect(f.commission.prepare(actor, 'bad', '跟踪未授权会话')).rejects.toThrow('授权范围')
  f.modelOutput({ ...create, archive: 'D1' })
  await expect(f.commission.prepare(actor, 'doc', '跟踪 room-a 并归档')).rejects.toThrow('授权范围')
  await f.registry.saveConfig({
    revision: 0,
    settings: { mandates: [], projects: [{ id: 'pr', name: '发布项目', policy: {} }] },
  })
  f.modelOutput({ project: 'P1', policy: { offDay: 'defer' } })
  expect(await f.commission.handleIm(actor, 'pj', '调整发布项目周末通知')).toContain('授权范围')
  const web = await f.commission.prepare('web', 'p', '调整发布项目周末通知')
  await f.registry.saveConfig({
    revision: 1,
    settings: { mandates: [], projects: [{ id: 'pr', name: '发布项目二', policy: {} }] },
  })
  await expect(f.commission.confirm('web', draftCode(web))).rejects.toThrow('配置已更新')
  expect(commissionIntent('如果我说「跟踪某个群」呢？')).toBe(null)
})

test('explicit project and destination grants permit cross-channel work only for the named source', async () => {
  const f = fixture()
  await f.registry.saveConfig({
    revision: 0,
    settings: { mandates: [], projects: [{ id: 'release', name: '发布项目', policy: {} }] },
  })
  const grants = await f.commission.grants()
  const dingtalk = grants.operators.find((t) => t.platform === 'dingtalk')
  if (!dingtalk) throw Error('Missing fixture target')
  await f.commission.saveGrants({
    revision: 0,
    grants: [
      {
        operator: actor,
        source: 'wxarc',
        scope: 'room-a',
        projectId: 'release',
        targets: [dingtalk],
      },
      { operator: actor, source: 'wxarc', scope: 'secret-room' },
    ],
  })
  f.modelOutput({ ...create, project: 'P1', targets: ['T2'], policy: { offDay: 'dingtalk' } })
  const draft = await f.commission.prepare(actor, 'cross', '跟踪发布项目的构建失败，周末发钉钉')
  expect(draft?.commission?.details.join(' ')).toContain('ding / project / staff')
  await f.commission.confirm(actor, draftCode(draft))
  expect(f.registry.getConfig().settings.mandates[0].targets[0].platform).toBe('dingtalk')
  f.modelOutput({
    ...create,
    source: 'S2',
    project: 'P1',
    targets: ['T2'],
    policy: { offDay: 'dingtalk' },
  })
  expect(await f.commission.handleIm(actor, 'wrong-source', '跟踪另一个来源，也发钉钉')).toContain(
    '同一授权',
  )
  f.modelOutput({ project: 'P1', policy: { afterWork: 'defer' } })
  const project = await f.commission.prepare(actor, 'policy', '只对发布项目调整下班后通知')
  await f.commission.confirm(actor, draftCode(project))
  expect(f.registry.getConfig().settings.projects[0].policy).toEqual({ afterWork: 'defer' })
})

test('an in-flight clarification cannot release a catalog label once the operator grant is revoked', async () => {
  const f = fixture()
  await f.grant()
  f.modelOutput({ clarify: '请确认私密研究群名称。' })
  f.beforePlan(async () => {
    await f.commission.saveGrants({ revision: 1, grants: [] })
  })
  const reply = await f.commission.handleIm(actor, 'revoked', '跟踪项目构建')
  expect(reply).not.toContain('私密研究群')
  expect(reply).toContain('授权')
})

test('the configured model receives only its permitted labels through a tool-free, redacted request', async () => {
  const f = fixture()
  await f.grant()
  const captured: CompletionRequest[] = []
  const adapter: ProviderAdapter = {
    apiType: 'test',
    healthCheck: async () => true,
    stream() {
      throw Error('unexpected stream')
    },
    async complete(input) {
      captured.push(input)
      return {
        id: 'commission',
        model: 'test',
        content: [{ type: 'text', text: JSON.stringify(create) }],
        usage: { input: 1, output: 1 },
        stopReason: 'end_turn',
      }
    },
  }
  const real = new RouterCommissionService(f.store, f.registry, {
    modelRouter: { getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined },
    secretFilter: { filter: (t) => t.replaceAll('private-token', '[redacted]') },
  })
  const preview = await real.prepare(
    actor,
    'model-r1',
    '帮我跟踪 room-a 里标有 private-token 的构建失败',
  )
  expect(preview?.commission?.title).toContain('发布进展')
  const payload = JSON.stringify(captured)
  expect(payload).toContain('room-a')
  expect(payload).not.toContain('secret-room')
  expect(payload).not.toContain('private-token')
  expect(captured[0].tools ?? []).toHaveLength(0)
})

test('edited fields preserve other parts of the confirmed mandate and support per-event grouping', async () => {
  const f = fixture()
  await f.grant()
  const draft = await f.commission.prepare(actor, 'create', '跟踪构建失败')
  await f.commission.confirm(actor, draftCode(draft))
  f.modelOutput({
    mandate: 'M1',
    patch: { keyword: '构建中断', groupBy: 'event', processing: 'direct' },
  })
  const edit = await f.commission.prepare(
    actor,
    'edit',
    '把发布委托关键词改为构建中断，并按事件归组，只要直接发事实提醒',
  )
  expect(edit?.commission?.details.join(' ')).toContain('逐条事件')
  expect(edit?.commission?.details.join(' ')).toContain('直接生成事实提醒')
  await f.commission.confirm(actor, draftCode(edit))
  expect(f.registry.getConfig().settings.mandates[0]).toMatchObject({
    purpose: '跟踪构建失败',
    keyword: '构建中断',
    groupBy: 'event',
    processing: 'direct',
  })
})

test('ordering is previewed and confirmed without modifying any other rule or policy field', async () => {
  const f = fixture()
  const quiet = {
    id: 'quiet',
    name: '夜间安静',
    when: { quiet: true },
    destination: 'defer',
  } as const
  const urgent = {
    id: 'urgent',
    name: '紧急在场',
    when: { urgency: 'urgent', presence: 'present' },
    destination: 'web',
  } as const
  const original = {
    rules: [quiet, urgent],
    offDay: 'defer',
    deadlineLeadMinutes: 60,
  } satisfies MandatePolicy
  await f.registry.saveConfig({
    revision: 0,
    settings: { projects: [{ id: 'release', name: '发布项目', policy: original }], mandates: [] },
  })
  f.modelOutput({ project: 'P1', policy: { rules: [urgent, quiet] } })
  await expect(f.commission.prepare('web', 'silent', '调整发布项目的休息日规则')).rejects.toThrow(
    '优先顺序',
  )
  await expect(
    f.commission.prepare('web', 'negative', '调整发布项目的规则，保持排序不变'),
  ).rejects.toThrow('优先顺序')
  await expect(
    f.commission.prepare('web', 'inspect-order', '调整发布项目名称，并列出目前规则顺序'),
  ).rejects.toThrow('优先顺序')
  f.modelOutput({ project: 'P1', policy: { rules: [{ ...urgent, destination: 'none' }, quiet] } })
  await expect(
    f.commission.prepare('web', 'two', '调整发布项目规则顺序，把紧急在场置顶'),
  ).rejects.toThrow('保留原有')
  f.modelOutput({ project: 'P1', policy: { rules: [urgent, quiet] } })
  const draft = await f.commission.prepare('web', 'ordered', '调整发布项目规则顺序，把紧急在场置顶')
  const details = draft?.commission?.details ?? []
  expect(details.join('\n')).toContain(
    '1. 紧急在场（在场且紧急）→ 网页\n2. 夜间安静（静默时段内）→ 延后',
  )
  expect(details.join('\n')).toContain('委托规则先于项目规则')
  expect(f.registry.getConfig().settings.projects[0].policy).toEqual(original)
  await f.commission.confirm('web', draftCode(draft))
  expect(f.registry.getConfig().settings.projects[0].policy).toEqual({
    ...original,
    rules: [urgent, quiet],
  })
  f.modelOutput({ project: 'P1', policy: { offDay: 'web' } })
  const tweak = await f.commission.prepare('web', 'tweak', '调整发布项目的周末去向为网页')
  await f.commission.confirm('web', draftCode(tweak))
  expect(f.registry.getConfig().settings.projects[0].policy.rules).toEqual([urgent, quiet])
  f.modelOutput({ project: 'P1', policy: { deadlineLeadMinutes: 0 } })
  await expect(f.commission.prepare('web', 'not-asked', '调整发布项目的工作时段')).rejects.toThrow(
    '提前多久',
  )
  const lead = await f.commission.prepare(
    'web',
    'lead',
    '调整发布项目的紧急窗口，到截止点才视为紧急',
  )
  expect(lead?.commission?.details).toContain('到截止时间才视为紧急。')
  await f.commission.confirm('web', draftCode(lead))
  expect(f.registry.getConfig().settings.projects[0].policy.deadlineLeadMinutes).toBe(0)
})

test('a rule can use only the exact project audiences granted for this IM operator and scope', async () => {
  const f = fixture()
  await f.registry.saveConfig({
    revision: 0,
    settings: { mandates: [], projects: [{ id: 'release', name: '发布项目', policy: {} }] },
  })
  const targets = (await f.commission.grants()).operators
  const ding = targets.find((t) => t.platform === 'dingtalk')
  if (!ding) throw Error('Missing test target')
  await f.commission.saveGrants({
    revision: 0,
    grants: [
      { operator: actor, source: 'wxarc', scope: 'room-a', projectId: 'release' },
      { operator: actor, source: 'wxarc', scope: 'secret-room', targets: [ding] },
    ],
  })
  f.modelOutput({
    project: 'P1',
    policy: {
      rules: [{ id: 'urgent', name: '紧急', when: { urgency: 'urgent' }, destination: 'dingtalk' }],
    },
  })
  expect(
    await f.commission.handleIm(actor, 'bad-scope', '设置发布项目规则，紧急时发钉钉'),
  ).toContain('同一授权')
  f.modelOutput({
    ...create,
    policy: {
      rules: [{ id: 'urgent', name: '紧急', when: { urgency: 'urgent' }, destination: 'dingtalk' }],
    },
  })
  expect(
    await f.commission.handleIm(
      actor,
      'missing-target',
      '跟踪构建失败，设置一条紧急时发钉钉的规则',
    ),
  ).toContain('授权范围')
  expect(f.registry.getConfig().settings.projects[0].policy).toEqual({})
  f.modelOutput({
    ...create,
    policy: {
      rules: [
        { id: 'unsafe', name: '自定义', when: { script: 'process.env.X' }, destination: 'web' },
      ],
    },
  })
  await expect(f.commission.prepare('web', 'invalid', '跟踪仓库，添加规则')).rejects.toThrow()
})
