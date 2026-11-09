import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderAdapter } from '@zero-os/model'
import { TriggerStore } from '@zero-os/observe'
import type {
  ContentBlock,
  MandateTarget,
  RouterActionName,
  RouterSurfaceAction,
  RouterSurfaceMessages,
  TriggerConversationAnswer,
} from '@zero-os/shared'
import type { GithubInvestigator } from '../investigation'
import { type RouterAgentInput, createRouterAgent } from '../router-agent'
import { RouterJobPrincipals, fingerprint, routerImScope } from '../router-job-principal'
import { RouterWorkspaceService } from '../router-workspace'
import { TriggerRoutingRuntime } from '../routing-runtime'

const closeAfterTest: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closeAfterTest.splice(0)) await close()
})

function setup(
  reply: (
    input: RouterAgentInput,
    signal?: AbortSignal,
  ) => Promise<TriggerConversationAnswer> = async () => ({
    text: '已根据本事件整理。',
    intent: 'route',
    points: ['请核对记录中的去向。'],
  }),
  investigator?: GithubInvestigator,
  agentIntake = false,
) {
  const store = new TriggerStore(':memory:')
  const source = 'private-room-fixture'
  const revision = store.saveSettings(
    {
      github: { credentialRef: '', repositories: [] },
      wxarc: { sessions: [{ id: source, name: 'Fixture', keyword: '', enabled: true }] },
    },
    0,
  )
  store.commitBatch({
    source: 'wxarc',
    stream: `wxarc:${source}`,
    previousCursor: null,
    cursor: '2',
    revision,
    events: ['first-only-secret', 'second-only-secret'].map((summary) => ({
      eventId: summary,
      scope: source,
      title: '匹配的文字',
      summary,
      occurredAt: '2026-11-03T09:00:00Z',
    })),
  })
  const [second, first] = store.listInbox().map((item) => item.id)
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: async () => {
      throw new Error('Unexpected automatic analysis')
    },
    weixin: {
      listTargets: () => [],
      send: async () => {
        throw new Error('Unexpected external delivery')
      },
    },
  })
  const ask = mock(reply)
  const process = mock((id: number) => routing.process(id))
  const catalog = mock(() => routing.listPersonalBots())
  const prepareReminder = mock(routing.prepareDirectReminder.bind(routing))
  const sendReminder = mock(routing.sendDirectReminder.bind(routing))
  const service = new RouterWorkspaceService(
    store,
    {
      getConfig: () => routing.getConfig(),
      saveConfig: routing.saveConfig.bind(routing),
      listPersonalBots: catalog,
      prepareDirectReminder: prepareReminder,
      sendDirectReminder: sendReminder,
      process,
    },
    ask,
    { investigator, agentIntake, principalFor: agentIntake ? () => 'router-owner' : undefined },
  )
  service.start()
  closeAfterTest.push(async () => {
    await service.close()
    await routing.close()
    store.close()
  })
  return {
    store,
    routing,
    process,
    catalog,
    prepareReminder,
    sendReminder,
    ask,
    service,
    first,
    second,
  }
}

function actionFor(surface: RouterSurfaceMessages, name: RouterActionName): RouterSurfaceAction {
  const { surfaceId, components } = surface[1].updateComponents
  const button = components.find((c) => c.component === 'Button' && c.action.event.name === name)
  if (!button) throw new Error(`Expected ${name} on ${surfaceId}`)
  return {
    version: surface[0].version,
    action: {
      name,
      sourceComponentId: button.id,
      surfaceId,
      context: {},
      timestamp: new Date().toISOString(),
    },
  }
}

test('an event inspection button reenters the Agent and only the Agent invokes the scoped reader', async () => {
  const evidence = {
    kind: 'related-issues' as const,
    observedAt: new Date().toISOString(),
    sourceUrl: 'https://github.com/o/r/issues/2#issuecomment-81',
    facts: [
      { label: 'Issue #1', value: 'matching evidence', url: 'https://github.com/o/r/issues/1' },
    ],
  }
  const inspect = mock<GithubInvestigator['inspect']>(async () => evidence)
  const { store, service, ask } = setup(undefined, {
    inspect,
    available: (event) => (event.source === 'github' ? ['find_related_issues'] : []),
  })
  const snapshot = store.getSettings()
  const revision = store.saveSettings(
    {
      ...snapshot.settings,
      github: {
        ...snapshot.settings.github,
        repositories: [
          {
            name: 'o/r',
            enabled: true,
            workflowFailures: false,
            branch: '',
            workflow: '',
            mention: '',
            issueComments: true,
          },
        ],
      },
    },
    snapshot.revision,
  )
  store.commitPush({
    source: 'github',
    stream: 'github:o/r',
    revision,
    events: [
      {
        eventId: '20:comment:81',
        scope: 'o/r',
        title: 'Issue #2 新评论',
        summary: '帮我找之前那个 issue',
        occurredAt: new Date().toISOString(),
        githubCommentKind: 'issue-comment',
        url: evidence.sourceUrl,
      },
    ],
  })
  const id = store.listInbox()[0].id
  ask.mockImplementation(async () => ({ text: '仅解释，不调用读取工具。' }))
  await service.message(id, crypto.randomUUID(), '先解释这条评论。')
  expect(inspect).not.toHaveBeenCalled()
  ask.mockImplementation(async (input) => {
    if (!input.actions?.inspectGithub) throw Error('missing scoped reader')
    const result = await input.actions.inspectGithub(
      'find_related_issues',
      new AbortController().signal,
    )
    return { text: '已核对历史讨论。', investigation: result }
  })
  const action = actionFor(service.get(id).surface, 'find_related_issues')
  const key = crypto.randomUUID()
  const searched = await service.action(id, key, action)
  expect(ask.mock.calls[0][0].signalContext?.kind).toBe('user')
  expect(ask.mock.calls[1][0].signalContext).toMatchObject({
    kind: 'ui_action',
    payload: {
      name: 'find_related_issues',
      surfaceId: action.action.surfaceId,
      sourceComponentId: action.action.sourceComponentId,
    },
  })
  expect(searched.turns.at(-1)?.answer?.investigation).toEqual(evidence)
  expect(ask).toHaveBeenCalledTimes(2)
  await service.action(id, key, action)
  expect(inspect).toHaveBeenCalledTimes(1)

  expect(service.get('general').turns).toEqual([])
})

test('general and event threads supply only their own event and retained dialogue to the Agent', async () => {
  const { service, first, second, ask } = setup()
  const key = crypto.randomUUID()
  await service.message('general', key, '工作日怎么提醒？')
  await service.message(first, key, '这一条有什么事实？')
  const detail = await service.message(first, crypto.randomUUID(), '继续解释之前的回答。')
  await service.message(second, key, '另一条事件呢？')
  const calls = ask.mock.calls.map(([input]) => input)
  expect(calls[0]).toMatchObject({
    event: null,
    route: null,
    subscriptions: { wxarc: 1, github: 0 },
  })
  expect(JSON.stringify(calls[0])).not.toContain('only-secret')
  expect(calls[1].event?.summary).toBe('first-only-secret')
  expect(JSON.stringify(calls[2])).not.toContain('second-only-secret')
  expect(
    calls[2].history.filter((turn) => turn.status === 'completed').map((turn) => turn.question),
  ).toEqual(['这一条有什么事实？'])
  expect(calls[3].event?.summary).toBe('second-only-secret')
  expect(JSON.stringify(calls[3].history)).not.toContain('这一条有什么事实')
  expect(detail.turns.map((turn) => turn.question)).toEqual([
    '这一条有什么事实？',
    '继续解释之前的回答。',
  ])
  expect(detail.turns[0].surface).toBeNull() // Text-only Agent answer does not acquire a backend-invented card.
  expect(await service.get(first)).toEqual(detail)
  expect((await service.get('general')).turns).toHaveLength(1)
  expect((await service.get(second)).turns).toHaveLength(1)
  expect(await service.listEvents(1, second)).toMatchObject([{ id: first }])
  expect(JSON.stringify(await service.listEvents(2))).not.toContain('only-secret')
  await expect(Promise.resolve().then(() => service.get(9999))).rejects.toMatchObject({
    status: 404,
  })
})

test('concurrent questions wait in arrival order, see the preceding answer and deduplicate replays', async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const last = Promise.withResolvers<void>()
  const seen: [string, string[]][] = []
  const { service, first } = setup(async (input) => {
    seen.push([input.question, input.history.map((turn) => turn.answer?.text ?? '')])
    started.resolve()
    await release.promise
    if (input.question === '第三问') last.resolve()
    return { text: `${input.question}的答复` }
  })
  const id = crypto.randomUUID()
  const second = crypto.randomUUID()
  const run = service.message(first, id, '第一问', false, true)
  await started.promise
  try {
    const repeated = await service.message(first, id, '第一问')
    expect(repeated.turns[0].status).toBe('pending')
    await service.message(first, second, '第二问')
    await service.message(first, second, '第二问')
    const snapshot = await service.message(first, crypto.randomUUID(), '第三问')
    expect(snapshot.turns.map((turn) => turn.status)).toEqual(['pending', 'queued', 'queued'])
    await expect(service.message(first, second, '复用编号改内容')).rejects.toMatchObject({
      status: 409,
    })
  } finally {
    release.resolve()
  }
  await run
  await last.promise
  expect(seen).toEqual([
    ['第一问', []],
    ['第二问', ['第一问的答复']],
    ['第三问', ['第一问的答复', '第二问的答复']],
  ])
})

test('after restart the Router can page back to corrections and reports exactly which turns reached its model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-router-history-'))
  const file = join(dir, 'test.sqlite')
  const { routing } = setup()
  const stored = new TriggerStore(file)
  const ids: number[] = []
  try {
    for (let index = 0; index < 20; index++) {
      const key = crypto.randomUUID()
      const question =
        [
          '请检查 A 和 B 两份材料，保留原件',
          '更正：只检查 B；撤回发布许可',
          '仅凭已撤销的连接可见的内容',
        ][index] ?? '插入无关话题'
      const started = stored.conversations.begin('general', key, question)
      if (started.kind !== 'started') throw Error('Expected a new turn')
      ids.push(started.turn.id)
      if (index === 12)
        stored.conversations.fail('general', key, started.attempt, 'fixture failure')
      else
        stored.conversations.finish('general', key, started.attempt, {
          text: '记录完成',
          ...(index === 2 && { workAccess: { github: true, key: 'previous-grant' } }),
        })
    }
  } finally {
    stored.close()
  }
  const reopened = new TriggerStore(file)
  try {
    const agent = mock(async (input: RouterAgentInput) => {
      const read = input.actions?.capabilities?.find(
        (tool) => tool.definition.name === 'read_conversation',
      )
      if (!read) throw Error('Missing history reader')
      const provenance = input.contextProvenance as {
        nextBeforeTurnId: number | null
        historyTurnIds: number[]
      }
      expect(provenance.historyTurnIds).toEqual(input.history.map((t) => t.id))
      expect(provenance.historyTurnIds).not.toContain(ids[12])
      if (input.question === '核对当前窗口') {
        expect(provenance).toMatchObject({
          olderHistoryOmitted: false,
          nextBeforeTurnId: null,
          excludedHistory: [{ turnId: ids[12], status: 'failed' }],
        })
      } else if (input.question === '继续核对原话') {
        expect(input.history.map((t) => t.id)).not.toContain(ids[1])
        const page = await read.execute(
          { beforeTurnId: provenance.nextBeforeTurnId },
          new AbortController().signal,
        )
        expect(page).toMatchObject({
          nextBeforeTurnId: null,
          turns: [
            { id: ids[0], question: '请检查 A 和 B 两份材料，保留原件' },
            { id: ids[1], question: '更正：只检查 B；撤回发布许可' },
            { id: ids[2], question: '此前的授权对话' },
          ],
        })
        expect(JSON.stringify(page)).not.toContain('仅凭已撤销的连接可见的内容')
      }
      return { text: '已核对' }
    })
    const service = new RouterWorkspaceService(reopened, routing, agent)
    try {
      service.start()
      for (const q of ['核对当前窗口', '插入话题一', '插入话题二', '继续核对原话'])
        await service.message('general', crypto.randomUUID(), q)
      expect(agent).toHaveBeenCalledTimes(4)
    } finally {
      await service.close()
    }
  } finally {
    reopened.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an answer derived from a protected older page follows its grant after revocation', async () => {
  const { routing, store, service: original } = setup()
  await original.close()
  let accessKey: string | null = 'fixture-connection'
  const principals = new RouterJobPrincipals(store, { accessKey: () => accessKey })
  for (let i = 0; i <= 20; i++) {
    const requestId = crypto.randomUUID()
    const started = store.conversations.begin('general', requestId, '历史资料')
    if (started.kind === 'started') {
      store.conversations.finish(
        'general',
        requestId,
        started.attempt,
        i === 0
          ? {
              text: '仅授权可见的旧记录',
              workAccess: { github: true, key: fingerprint(principals.capture('web', true)) },
            }
          : { text: '公开话题' },
      )
    } else throw Error('Expected fixture turn')
  }
  const service = new RouterWorkspaceService(
    store,
    routing,
    async (input, signal) => {
      const read = input.actions?.capabilities?.find(
        (c) => c.definition.name === 'read_conversation',
      )
      if (!read || !signal) throw Error('Missing history capability')
      expect(JSON.stringify(input.history)).not.toContain('仅授权可见的旧记录')
      const page = await read.execute({ beforeTurnId: input.history[0].id }, signal)
      expect(JSON.stringify(page)).toContain('仅授权可见的旧记录')
      return { text: '来自旧记录的答复' }
    },
    { principals },
  )
  try {
    service.start()
    const requestId = crypto.randomUUID()
    await service.message('general', requestId, '取回较早的资料')
    expect(store.conversations.get('general', requestId)?.answer?.workAccess?.github).toBe(true)
    accessKey = null
    const saved = service.get('general').turns.find((t) => t.requestId === requestId)
    expect(saved?.answer?.text).toContain('授权已变更')
    expect(JSON.stringify(saved)).not.toContain('来自旧记录的答复')
  } finally {
    await service.close()
  }
})

test('after reopening the database only the unstarted followup runs automatically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-router-web-queue-'))
  const path = join(dir, 'test.sqlite')
  const { routing } = setup()
  try {
    const before = new TriggerStore(path)
    before.conversations.begin('general', 'started-request', '已开始的问题')
    before.conversations.begin('general', 'saved-request', '已保存的补充', false, true)
    before.close()
    const after = new TriggerStore(path)
    const done = Promise.withResolvers<void>()
    const ask = mock(async () => {
      done.resolve()
      return { text: '补充已处理' }
    })
    const restored = new RouterWorkspaceService(after, routing, ask)
    try {
      restored.start()
      await done.promise
      await restored.close()
      expect(after.conversations.list('general').map((t) => [t.requestId, t.status])).toEqual([
        ['started-request', 'failed'],
        ['saved-request', 'completed'],
      ])
      expect(ask).toHaveBeenCalledTimes(1)
    } finally {
      await restored.close()
      after.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('startup exposes an interrupted turn for explicit retry without automatically invoking the Agent', async () => {
  const { store, routing, service, ask, first } = setup()
  await service.close()
  const key = crypto.randomUUID()
  expect(store.conversations.begin(first, key, '重启前的问题').kind).toBe('started')
  const restarted = new RouterWorkspaceService(store, routing, ask)
  try {
    restarted.start()
    expect((await restarted.get(first)).turns[0]).toMatchObject({
      requestId: key,
      status: 'failed',
    })
    expect(ask).not.toHaveBeenCalled()
    await restarted.message(first, key, '重启前的问题', true)
    expect((await restarted.get(first)).turns.map((turn) => turn.status)).toEqual(['completed'])
    expect(ask).toHaveBeenCalledTimes(1)
  } finally {
    await restarted.close()
  }
})

const reminderRequest = '发送微信通知，通知我处理 DeepSeek 的充值'
const reminderRecipient = {
  channelId: 'v1ki-bot',
  label: '我的微信',
  audienceKey: 'private-audience-fixture',
}

test('model output and text inside event discussions cannot authorize a reminder', async () => {
  const { service, first, ask, prepareReminder, sendReminder } = setup(async () => ({
    text: '模型回答',
    reminder: {
      platform: 'weixin',
      channelId: 'injected',
      botLabel: 'injected',
      text: 'injected',
      audienceKey: 'injected',
      status: 'draft',
    },
  }))
  for (const [scope, text] of [
    ['general', '如何配置通知？'],
    [first, reminderRequest],
  ] as const) {
    const snap = await service.message(scope, crypto.randomUUID(), text)
    const turn = snap.turns.at(-1)
    expect(turn?.answer?.reminder).toBeUndefined()
    expect(JSON.stringify(turn?.surface)).not.toContain('send_reminder')
  }
  expect(ask).toHaveBeenCalledTimes(2)
  expect(prepareReminder).not.toHaveBeenCalled()
  expect(sendReminder).not.toHaveBeenCalled()
})

test('a natural-language send tool reserves the current turn before sending and preserves its receipt if the next model step fails', async () => {
  const key = crypto.randomUUID()
  const gate = Promise.withResolvers<{ status: 'accepted' }>()
  const submitted = Promise.withResolvers<void>()
  const q = '这笔 DeepSeek 充值得现在处理，微信给我发一句「记得充值」吧'
  const { service, ask, prepareReminder, sendReminder } = setup(async (input) => {
    const send = input.actions?.sendReminder
    if (!send) throw Error('Missing send tool')
    const receipt = await send('weixin', '记得充值', new AbortController().signal)
    expect(receipt.status).toBe('accepted')
    throw new Error('final provider call timed out')
  })
  prepareReminder.mockReturnValue(reminderRecipient)
  sendReminder.mockImplementation(async () => {
    submitted.resolve()
    return gate.promise
  })
  const job = service.message('general', key, q)
  await submitted.promise
  try {
    expect(service.get('general').turns[0].answer?.reminder?.status).toBe('sending')
    const replay = await service.message('general', key, q, true)
    expect(replay.turns[0].status).toBe('pending')
    expect(sendReminder).toHaveBeenCalledTimes(1)
  } finally {
    gate.resolve({ status: 'accepted' })
  }
  const finished = await job
  expect(finished.turns[0]).toMatchObject({
    status: 'completed',
    answer: { reminder: { platform: 'weixin', text: '记得充值', status: 'accepted' } },
  })
  expect((await service.message('general', key, q, true)).turns[0].answer?.reminder?.status).toBe(
    'accepted',
  )
  expect(ask).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(finished)).not.toContain(reminderRecipient.audienceKey)
})

test('when the current user asks to send an existing draft its original card and the new turn share one outcome', async () => {
  const { service, prepareReminder, sendReminder } = setup(async (input) => {
    const text = '处理充值'
    if (!input.history.length) input.actions?.prepareReminder?.('weixin', text)
    else {
      const send = input.actions?.sendReminder
      if (!send) throw Error('Missing send tool')
      await send('weixin', text, new AbortController().signal, input.history[0].id)
    }
    return { text: '已处理' }
  })
  prepareReminder.mockReturnValue(reminderRecipient)
  sendReminder.mockResolvedValue({ status: 'accepted' })
  const key = crypto.randomUUID()
  const before = await service.message('general', key, '整理成微信草稿：处理充值')
  expect(before.turns[0].answer?.reminder?.status).toBe('draft')
  const done = await service.message('general', crypto.randomUUID(), '现在把上一条草稿发出去')
  expect(done.turns.map((t) => t.answer?.reminder?.status)).toEqual(['accepted', 'accepted'])
  expect(sendReminder).toHaveBeenCalledTimes(1)
  expect(sendReminder.mock.calls[0][3]).toBe(key)
  await service.message('general', key, '整理成微信草稿：处理充值')
  expect(sendReminder).toHaveBeenCalledTimes(1)
})

test('the normal workspace entry point runs successive model tool calls, feeds a real transport outcome back and persists the verified result', async () => {
  const channel = 'weixin'
  const body = '处理 DeepSeek 充值'
  const question = '我要你现在通过微信给我发这句话：「处理 DeepSeek 充值」'
  let calls = 0
  const adapter: ProviderAdapter = {
    apiType: 'test',
    healthCheck: async () => true,
    stream() {
      throw Error('Unexpected streaming')
    },
    async complete(request) {
      calls++
      const content: ContentBlock[] = []
      if (calls === 1) {
        expect(request.tools?.map((t) => t.name)).toContain('send_personal_reminder')
        content.push({
          type: 'tool_use',
          name: 'list_notification_bots',
          input: {},
          id: 'bot-directory',
        })
      } else if (calls === 2) {
        const tool = request.messages.at(-1)?.content[0]
        expect(tool?.type === 'tool_result' && tool.content).toContain('我的微信')
        content.push({
          type: 'tool_use',
          name: 'send_personal_reminder',
          input: { platform: channel, text: body },
          id: 'send-tool',
        })
      } else {
        const tool = request.messages.at(-1)?.content[0]
        expect(tool?.type === 'tool_result' && tool.content).toContain('accepted')
        expect(JSON.stringify(request.messages)).not.toContain(reminderRecipient.audienceKey)
        content.push({ type: 'text', text: '{"text":"微信平台已受理。"}' })
      }
      return {
        id: `test-${calls}`,
        model: 'fake',
        content,
        usage: { input: 1, output: 1 },
        stopReason: calls < 3 ? 'tool_use' : 'end_turn',
      }
    },
  }
  const ask = createRouterAgent({
    modelRouter: { getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined },
    secretFilter: { filter: (v) => v },
  })
  const { service, routing, catalog, prepareReminder, sendReminder } = setup(ask)
  const settings = routing.getConfig()
  routing.saveConfig(
    { ...settings.settings, personalBots: { weixin: reminderRecipient.channelId } },
    settings.revision,
  )
  catalog.mockReturnValue([
    {
      platform: channel,
      channelId: reminderRecipient.channelId,
      label: reminderRecipient.label,
      online: true,
      ready: true,
      deliveryState: 'ready',
    },
  ])
  prepareReminder.mockReturnValue(reminderRecipient)
  sendReminder.mockResolvedValue({ status: 'accepted' })
  const id = crypto.randomUUID()
  const answer = (await service.message('general', id, question)).turns[0].answer
  expect(answer?.reminder).toMatchObject({ platform: channel, text: body, status: 'accepted' })
  expect(answer?.toolSteps).toEqual([
    { name: 'list_notification_bots', ok: true },
    { name: 'send_personal_reminder', ok: true },
  ])
  await service.message('general', id, question)
  expect(sendReminder).toHaveBeenCalledTimes(1)
  expect(calls).toBe(3)
})

const routerDm = {
  platform: 'weixin' as const,
  channelId: 'v1ki-bot',
  actorId: 'im-owner',
  peerId: 'im-owner',
  messageId: 'im-upstream-id',
  text: '我的工作日偏好是什么？',
  isDirect: true,
}

test('Router IM retains history only for the authenticated platform, bot, peer and actor', async () => {
  const { service, ask } = setup(async (input) => ({ text: input.question }))
  await service.message('general', crypto.randomUUID(), '只存在于网页主对话')
  const allowed = () => true
  for (const identity of [
    routerDm,
    { ...routerDm, platform: 'feishu' as const },
    { ...routerDm, platform: 'feishu' as const, peerId: 'another-chat' },
    { ...routerDm, platform: 'feishu' as const, actorId: 'another-actor' },
    { ...routerDm, channelId: 'another-bot' },
  ]) {
    expect(await service.handleIm(identity, allowed)).toContain(routerDm.text)
    expect(ask.mock.lastCall?.[0].history).toEqual([])
  }
  const imSessions = ask.mock.calls.slice(1).map(([input]) => input.sessionId)
  expect(new Set(imSessions).size).toBe(5)
  const next = { ...routerDm, messageId: 'next-im-id', text: '接着上一个问题。' }
  await service.handleIm(next, allowed)
  expect(ask.mock.lastCall?.[0].sessionId).toBe(imSessions[0])
  expect(ask.mock.lastCall?.[0].history.map((turn) => turn.question)).toEqual([routerDm.text])
  expect(service.get('general').turns.map((turn) => turn.question)).toEqual(['只存在于网页主对话'])
})

test('Router IM deduplicates concurrent and replayed deliveries across service restarts', async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const { service, ask, store, routing } = setup(async () => {
    started.resolve()
    await release.promise
    return { text: '这是唯一一条回复。' }
  })
  const first = service.handleIm(routerDm, () => true)
  await started.promise
  const replay = service.handleIm(routerDm, () => true)
  release.resolve()
  expect((await Promise.all([first, replay])).filter(Boolean)).toEqual(['这是唯一一条回复。'])
  await service.close()
  const restored = new RouterWorkspaceService(store, routing, ask)
  restored.start()
  try {
    expect(await restored.handleIm(routerDm, () => true)).toBeNull()
    expect(ask).toHaveBeenCalledTimes(1)
  } finally {
    await restored.close()
  }
})

test('a second private message is saved immediately and only its original caller receives the reply', async () => {
  const release = Promise.withResolvers<void>()
  const { service, store, ask } = setup(async (input) => {
    if (input.question === '先问') await release.promise
    if (input.question === '再问')
      expect(input.history.map((t) => t.answer?.text)).toEqual(['第一答'])
    return { text: input.question === '先问' ? '第一答' : '第二答' }
  })
  const first = service.handleIm({ ...routerDm, text: '先问' }, () => true)
  const secondInput = { ...routerDm, messageId: 'second', text: '再问' }
  const second = service.handleIm(secondInput, () => true)
  const scope = routerImScope({ ...routerDm, operatorId: routerDm.actorId })
  try {
    expect(store.conversations.list(scope).map((t) => t.status)).toEqual(['pending', 'queued'])
    expect(await service.handleIm(secondInput, () => true)).toBeNull()
  } finally {
    release.resolve()
  }
  expect(await Promise.all([first, second])).toEqual(['第一答', '第二答'])
  expect(ask).toHaveBeenCalledTimes(2)
})

test('a restored private followup checks its saved binding and delivers only to the original bot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-router-im-queue-'))
  const path = join(dir, 'test.sqlite')
  const actor = {
    platform: 'weixin' as const,
    channelId: routerDm.channelId,
    peerId: routerDm.peerId,
    operatorId: routerDm.actorId,
  }
  const scope = routerImScope(actor)
  try {
    const before = new TriggerStore(path)
    const original = before.routing.getSettings()
    const revision = before.routing.saveSettings(
      { ...original.settings, enabled: true, personalBots: { weixin: actor.channelId } },
      original.revision,
    )
    const bindingRevision = before.routing.claimDirectBotBinding(actor, null, revision)
    expect(bindingRevision).not.toBeNull()
    before.conversations.begin(scope, 'old', '开始处理')
    for (const [requestId, pin] of [
      ['recover', bindingRevision],
      ['revoked', -1],
    ] as const) {
      before.conversations.begin(scope, requestId, requestId, false, {
        actor,
        routingRevision: revision,
        bindingRevision: pin,
        reference: { messageId: 'earlier-card', text: '库存核查' },
      })
    }
    before.close()
    const after = new TriggerStore(path)
    const forbid = async () => {
      throw Error('Unexpected operation')
    }
    const delivered = Promise.withResolvers<void>()
    const send = mock(async (_target: MandateTarget, _text: string) => {
      delivered.resolve()
      return { status: 'accepted' as const, receipt: 'delivery-receipt' }
    })
    const targets = [{ ...actor, label: 'bot' }]
    const routing = new TriggerRoutingRuntime(after.routing, {
      analyze: forbid,
      weixin: { listTargets: () => [], send: forbid },
      personal: {
        listPersonalBots: () => targets.map((t) => ({ ...t, online: true })),
        listPersonalTargets: () => targets,
        listPersonalDirectTargets: () => targets,
        sendPersonal: forbid,
        sendDirect: send,
      },
    })
    const ask = mock(async (input: RouterAgentInput) => ({ text: `处理了${input.question}` }))
    const workspace = new RouterWorkspaceService(after, routing, ask)
    try {
      workspace.start()
      expect(ask).not.toHaveBeenCalled()
      workspace.resumeQueuedImTurns()
      await delivered.promise
      await new Promise((resolve) => setImmediate(resolve))
      workspace.resumeQueuedImTurns()
      expect(after.conversations.list(scope).map((t) => [t.requestId, t.status])).toEqual([
        ['old', 'failed'],
        ['recover', 'completed'],
        ['revoked', 'failed'],
      ])
      const turn = after.conversations.get(scope, 'recover')
      expect(after.ledger.operations.get(scope, `recovered-im-reply:${turn?.id}`)).toMatchObject({
        state: 'accepted',
      })
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0]?.[0]).toMatchObject(actor)
      expect(send.mock.calls[0]?.[1]).toBe('处理了recover')
      expect(ask.mock.calls[0]?.[0].quotedMessage).toEqual({
        messageId: 'earlier-card',
        text: '库存核查',
      })
      expect(ask).toHaveBeenCalledTimes(1)
    } finally {
      await workspace.close()
      await routing.close()
      after.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Router IM refuses groups and revoked access before releasing a model response or an external send', async () => {
  let allowed = false
  const authorized = () => allowed
  const { ask, service, prepareReminder, sendReminder } = setup(async (input) => {
    allowed = false
    await input.actions?.sendReminder?.('weixin', '发送测试', new AbortController().signal)
    return { text: '不得发送这条回复。' }
  })
  prepareReminder.mockReturnValue(reminderRecipient)
  sendReminder.mockResolvedValue({ status: 'accepted' })
  expect(await service.handleIm(routerDm, authorized)).toBeNull()
  expect(await service.handleIm({ ...routerDm, isDirect: false }, () => true)).toBeNull()
  expect(ask).not.toHaveBeenCalled()
  allowed = true
  expect(
    await service.handleIm({ ...routerDm, text: '现在发微信提醒我发送测试' }, authorized),
  ).toBeNull()
  expect(ask).toHaveBeenCalledTimes(1)
  expect(sendReminder).not.toHaveBeenCalled()
})

test('an IM reminder draft stays in its private dialogue and confirmation survives delivery replay', async () => {
  const body = '处理充值'
  const { service, ask, prepareReminder, sendReminder } = setup(async (input) => {
    if (input.history.length === 0) {
      input.actions?.prepareReminder?.('weixin', body)
      return { text: `草稿里的提醒是「${body}」。金额等你核对后再补。` }
    } else {
      const prior = input.history[0]
      expect(prior.answer?.reminder?.status).toBe('draft')
      expect(prior.answer?.reminder?.audienceKey).toBeUndefined()
      await input.actions?.sendReminder?.('weixin', body, new AbortController().signal, prior.id)
    }
    return { text: '平台已受理这份提醒；金额仍待核对。' }
  })
  prepareReminder.mockReturnValue(reminderRecipient)
  sendReminder.mockResolvedValue({ status: 'accepted' })
  const draft = { ...routerDm, text: '先帮我拟一份微信草稿：处理充值' }
  const confirmation = { ...routerDm, text: '把上一条草稿发出去', messageId: 'confirmation' }
  expect(await service.handleIm(draft, () => true)).toBe(
    `草稿里的提醒是「${body}」。金额等你核对后再补。`,
  )
  expect(sendReminder).not.toHaveBeenCalled()
  expect(await service.handleIm(confirmation, () => true)).toBe(
    '平台已受理这份提醒；金额仍待核对。',
  )
  expect(await service.handleIm(confirmation, () => true)).toBeNull()
  expect(ask).toHaveBeenCalledTimes(2)
  expect(sendReminder).toHaveBeenCalledTimes(1)
  expect(service.get('general').turns).toHaveLength(0)
})

test('a read-only reply cannot leave the Router after ownership changes during the model call', async () => {
  let allowed = true
  const { service, ask } = setup(async () => {
    allowed = false
    return { text: '只应向原收件人展示。' }
  })
  expect(await service.handleIm(routerDm, () => allowed)).toBeNull()
  allowed = true
  expect(await service.handleIm(routerDm, () => allowed)).toBeNull()
  expect(ask).toHaveBeenCalledTimes(1)
})

test('an IM Router turn exposes personal reminder tools and keeps global confirmation cards in the Web workspace', async () => {
  const tools: string[][] = []
  const adapter: ProviderAdapter = {
    apiType: 'test',
    healthCheck: async () => true,
    stream() {
      throw Error('Unexpected streaming')
    },
    async complete(request) {
      tools.push(request.tools?.map((tool) => tool.name) ?? [])
      const first = tools.length === 1
      const content: ContentBlock[] = first
        ? [
            {
              type: 'tool_use',
              id: 'send',
              name: 'send_personal_reminder',
              input: { platform: 'weixin', text: '处理充值' },
            },
          ]
        : [{ type: 'text', text: '平台已受理。' }]
      if (!first) {
        const result = request.messages.at(-1)?.content[0]
        expect(result?.type === 'tool_result' && result.content).toContain('accepted')
      }
      return {
        id: 'local-test',
        model: 'fake',
        content,
        usage: { input: 1, output: 1 },
        stopReason: first ? 'tool_use' : 'end_turn',
      }
    },
  }
  const { service, prepareReminder, sendReminder } = setup(
    createRouterAgent({
      secretFilter: { filter: (v) => v },
      modelRouter: { getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined },
    }),
  )
  prepareReminder.mockReturnValue(reminderRecipient)
  sendReminder.mockResolvedValue({ status: 'accepted' })
  const message = { ...routerDm, text: '现在发微信提醒我处理充值' }
  expect(await service.handleIm(message, () => true)).toContain('受理')
  expect(await service.handleIm(message, () => true)).toBeNull()
  expect(tools[0]).toContain('get_routing_context')
  expect(tools[0]).toContain('send_personal_reminder')
  expect(tools[0]).toContain('prepare_personal_reminder')
  expect(tools[0]).not.toContain('prepare_routing_preference')
  expect(tools[0]).not.toContain('prepare_bot_selection')
  expect(tools[0]).not.toContain('bash')
  expect(tools).toHaveLength(2)
  expect(sendReminder).toHaveBeenCalledTimes(1)
  expect(service.get('general').turns).toHaveLength(0)
})

test('Agent-generated actions retain visible meaning and reenter the same loop exactly once', async () => {
  const { createRouterUICapability } = await import('../router-ui-capability')
  const ui = createRouterUICapability()
  ui.tool.execute(
    {
      components: [
        { id: 'root', component: 'Column', children: ['message', 'next'] },
        { id: 'message', component: 'Text', text: '尚未复测，下一步核对证据。' },
        { id: 'label', component: 'Text', text: '核对这份证据' },
        {
          id: 'next',
          component: 'Button',
          child: 'label',
          action: { event: { name: 'router_input' } },
        },
      ],
      data: {},
      actions: { next: { instruction: '核对这份证据' } },
    },
    new AbortController().signal,
  )
  const { service, store, ask, first, second } = setup(async () => ({
    text: '目前还缺复测。',
    generatedUI: ui.get(),
  }))
  const initial = await service.message(first, 'generated', '请说明进度并给我下一步操作')
  const surface = initial.turns[0].surface
  if (!surface) throw Error('missing Agent-generated UI')
  const action = actionFor(surface, 'router_input')
  // A bookmarked generated card remains actionable after it leaves both recent windows.
  for (let i = 0; i < 52; i++) {
    const claim = store.conversations.begin(first, 'newer-' + i, '较新的问题')
    if (claim.kind !== 'started') throw Error('missing fixture turn')
    store.conversations.finish(first, claim.turn.requestId, claim.attempt, { text: '另一条回复' })
  }
  const sourceId = initial.turns[0].id
  expect(service.get(first).turns.some((t) => t.id === sourceId)).toBe(false)
  const archived = service.get(first, sourceId)
  expect(archived.turns.at(-1)?.surface).toEqual(surface)
  expect(() => service.get(second, sourceId)).toThrow('找不到这条记录')
  await expect(service.action(second, 'foreign', action)).rejects.toThrow('失效')
  const result = await service.action(first, 'clicked', action)
  expect(result.turns.at(-1)?.question).toBe('核对这份证据')
  expect(ask.mock.calls.at(-1)?.[0].signalContext?.kind).toBe('ui_action')
  expect(ask.mock.calls.at(-1)?.[0].signalContext?.payload?.sourceTurnId).toBe(sourceId)
  await service.action(first, 'clicked', action)
  await service.action(first, 'second-click', action)
  expect(ask).toHaveBeenCalledTimes(2)
})

test('history pages stay in their conversation and hide text after a source grant changes', async () => {
  const { store, service } = setup()
  const ids: number[] = []
  for (let i = 0; i < 55; i++) {
    const claim = store.conversations.begin('general', 'history-' + i, '材料 ' + i)
    if (claim.kind !== 'started') throw Error('missing turn')
    store.conversations.finish('general', claim.turn.requestId, claim.attempt, {
      text: i === 1 ? '私有来源中保存的原文' : '普通结果',
      ...(i === 1 && { sourceEventIds: [1234567] }),
    })
    ids.push(claim.turn.id)
  }
  const recent = service.get('general')
  expect(recent.turns.map((t) => t.id)).toEqual(ids.slice(5))
  expect(recent.previousTurnId).toBe(ids[4])
  const history = service.get('general', recent.previousTurnId)
  expect(history.turns.map((t) => t.id)).toEqual(ids.slice(0, 5))
  expect(history.previousTurnId).toBeUndefined()
  const hidden = history.turns[1]
  expect(hidden.question).not.toBe('材料 1')
  expect(JSON.stringify(hidden)).not.toContain('私有来源')
  expect(hidden.surface).toBeNull()
  expect(hidden.traceRunIds).toBeUndefined()
})

test('an inbox process gesture enters the Router Agent and never invokes the former summary pipeline', async () => {
  const { service, process, ask, first, routing } = setup()
  const settings = routing.getConfig()
  routing.saveConfig({ ...settings.settings, enabled: true }, settings.revision)
  const action = actionFor(service.get(first).surface, 'process_event')
  const firstResult = await service.action(first, 'process-once', action)
  expect(firstResult.turns.at(-1)?.question).toContain('办理')
  expect(ask.mock.calls[0][0].signalContext).toMatchObject({
    kind: 'ui_action',
    payload: { name: 'process_event' },
  })
  expect(ask).toHaveBeenCalledTimes(1)
  expect(process).not.toHaveBeenCalled()
  await service.action(first, 'process-once', action)
  expect(ask).toHaveBeenCalledTimes(1)
})

test('a saved preference card applies once and returns its receipt to the main Agent', async () => {
  const { service, store, routing, ask } = setup(undefined, undefined, true)
  const old = store.conversations.begin('general', 'old-preference', '将我标为离开')
  if (old.kind !== 'started') throw Error('missing old turn')
  const before = routing.getConfig()
  store.conversations.finish('general', 'old-preference', old.attempt, {
    text: '将我标为离开，请确认。',
    proposal: { key: 'presence', value: 'away' },
    proposalRevision: before.revision,
  })
  const surface = service.get('general').turns[0].surface!
  const click = actionFor(surface, 'apply_preference')
  await service.action('general', 'accept-once', click)
  await service.action('general', 'accept-once', click)
  await service.close()
  expect(store.ledger.listSignals('router-owner').map((s) => s.state)).toEqual(['completed'])
  expect(routing.getConfig().revision).toBe(before.revision + 1)
  expect(ask).toHaveBeenCalledTimes(1)
  expect(ask.mock.calls[0][0].signalContext).toMatchObject({
    kind: 'ui_action',
    payload: {
      sourceTurnId: old.turn.id,
      savedAction: { proposal: { key: 'presence', value: 'away' } },
    },
  })
})

test('a saved reminder sends once and gives the model its platform receipt without the audience key', async () => {
  const { service, store, sendReminder, ask } = setup(undefined, undefined, true)
  sendReminder.mockResolvedValue({ status: 'accepted', receipt: 'fixture-receipt' })
  const old = store.conversations.begin('general', 'old-draft', '发一次提醒')
  if (old.kind !== 'started') throw Error('missing old turn')
  store.conversations.finish('general', 'old-draft', old.attempt, {
    text: '草稿',
    reminder: {
      status: 'draft',
      text: '读报告',
      platform: 'weixin',
      botLabel: '测试',
      channelId: 'bot',
      audienceKey: 'private-fixture',
    },
  })
  const click = actionFor(service.get('general').turns[0].surface!, 'send_reminder')
  await service.action('general', 'send-once', click)
  await service.action('general', 'send-once', click)
  await service.close()
  expect(sendReminder).toHaveBeenCalledTimes(1)
  expect(store.ledger.listSignals('router-owner').map((s) => s.state)).toEqual(['completed'])
  expect(ask).toHaveBeenCalledTimes(1)
  const signal = ask.mock.calls[0][0].signalContext
  expect(signal?.payload?.savedAction).toMatchObject({ reminder: { status: 'accepted' } })
  expect(JSON.stringify(signal)).not.toContain('private-fixture')
})

test('a generated matter button cannot act on a newer version or a revoked source', async () => {
  const { service, store, ask, first } = setup(undefined, undefined, true)
  const { createRouterUICapability } = await import('../router-ui-capability')
  const matter = store.ledger.createMatter('router-owner', '读复测结果', '核对现场读数', [
    '读数经确认',
  ])
  store.ledger.linkSource('router-owner', matter.id, first)
  const ui = createRouterUICapability()
  const saveCard = (version: number) => {
    const label = '核对读数'
    ui.tool.execute(
      {
        components: [
          { id: 'root', component: 'Column', children: ['go'] },
          { id: 'label', component: 'Text', text: label },
          {
            id: 'go',
            component: 'Button',
            child: 'label',
            action: { event: { name: 'router_input' } },
          },
        ],
        data: {},
        actions: { go: { instruction: label, matterId: matter.id, matterVersion: version } },
      },
      new AbortController().signal,
    )
    const claim = store.conversations.begin('general', 'card-' + version, '显示操作')
    if (claim.kind !== 'started') throw Error('missing turn')
    store.conversations.finish('general', claim.turn.requestId, claim.attempt, {
      text: label,
      generatedUI: ui.get(),
    })
    return actionFor(service.get('general').turns.at(-1)!.surface!, 'router_input')
  }
  const stale = saveCard(1)
  store.ledger.updateMatter('router-owner', matter.id, 1, {
    state: 'waiting',
    context: { evidence: '新读数' },
  })
  await expect(service.action('general', 'stale', stale)).rejects.toThrow('已变化')
  const revoked = saveCard(2)
  const settings = store.getSettings()
  store.saveSettings({ ...settings.settings, wxarc: { sessions: [] } }, settings.revision)
  await expect(service.action('general', 'revoked', revoked)).rejects.toThrow('授权已变化')
  expect(ask).toHaveBeenCalledTimes(0)
  expect(store.conversations.get('general', 'revoked')).toBeNull()
})

test('after restart a pending card receipt returns to the Agent without sending the reminder again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zero-card-receipt-'))
  const file = join(dir, 'test.sqlite')
  const { routing } = setup()
  const send = mock(async () => ({ status: 'accepted' as const, receipt: 'one-receipt' }))
  const transport = {
    getConfig: routing.getConfig.bind(routing),
    saveConfig: routing.saveConfig.bind(routing),
    listPersonalBots: routing.listPersonalBots.bind(routing),
    process: routing.process.bind(routing),
    prepareDirectReminder: routing.prepareDirectReminder.bind(routing),
    sendDirectReminder: send,
  }
  const seen: RouterAgentInput[] = []
  const ask = async (input: RouterAgentInput) => {
    seen.push(input)
    return { text: '提醒已受理。' }
  }
  let store = new TriggerStore(file)
  let service = new RouterWorkspaceService(store, transport, ask, {
    principalFor: () => 'router-owner',
  })
  try {
    service.start()
    const old = store.conversations.begin('general', 'old-card', '需要发通知')
    if (old.kind !== 'started') throw Error('missing turn')
    store.conversations.finish('general', 'old-card', old.attempt, {
      text: '草稿',
      reminder: {
        status: 'draft',
        text: '核对回执',
        platform: 'weixin',
        botLabel: '测试',
        channelId: 'bot',
        audienceKey: 'private-fixture',
      },
    })
    const click = actionFor(service.get('general').turns[0].surface!, 'send_reminder')
    await service.action('general', 'same-request', click)
    expect(store.ledger.listSignals('router-owner')[0].state).toBe('pending')
    await service.close()
    store.close()
    store = new TriggerStore(file)
    service = new RouterWorkspaceService(store, transport, ask, {
      principalFor: () => 'router-owner',
      agentIntake: true,
    })
    service.start()
    await service.action('general', 'same-request', click)
    await service.close()
    expect(seen).toHaveLength(1)
    expect(seen[0].signalContext?.payload?.savedAction).toMatchObject({
      reminder: { status: 'accepted' },
    })
    expect(store.ledger.listSignals('router-owner')[0].state).toBe('completed')
    expect(send).toHaveBeenCalledTimes(1)
  } finally {
    await service.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a published form accepts only the fields bound to its visible button and retains the submitted text', async () => {
  const { service, store, ask } = setup(undefined, undefined, true)
  const matter = store.ledger.createMatter('router-owner', '补充观察', '记录现象', ['已补充原文'])
  const { createRouterUICapability } = await import('../router-ui-capability')
  const ui = createRouterUICapability()
  ui.tool.execute(
    {
      components: [
        { id: 'root', component: 'Column', children: ['note', 'save'] },
        { id: 'note', component: 'TextField', label: '现场观察', value: { path: '/note' } },
        { id: 'label', component: 'Text', text: '保存观察' },
        {
          id: 'save',
          component: 'Button',
          child: 'label',
          action: { event: { name: 'router_input', context: { observation: { path: '/note' } } } },
        },
      ],
      data: { note: '' },
      actions: {
        save: { instruction: '保存观察', matterId: matter.id, matterVersion: matter.version },
      },
    },
    new AbortController().signal,
  )
  const generatedUI = ui.get()!
  const id = 'd'.repeat(64)
  store.ledger.publications.prepare({
    id,
    principal: 'router-owner',
    matterId: matter.id,
    matterVersion: matter.version,
    scope: 'general',
    deliveries: [
      {
        channel: 'web',
        target: null,
        presentation: {
          title: '补充观察',
          text: '填写记录',
          actions: [{ id: 'save', label: '保存观察' }],
          generatedUI,
        },
      },
    ],
  })
  const claim = store.ledger.publications.claim('router-owner', id, 'web')!
  store.ledger.publications.finish('router-owner', id, 'web', claim.attempt, {
    status: 'accepted',
    receipt: 'web',
    reason: null,
  })
  const gesture = actionFor(generatedUI.messages, 'router_input')
  expect(() => service.webPublicationAction(id, 'save', 'no-fields')).toThrow('填写')
  expect(() => service.webPublicationAction(id, 'save', 'blank', gesture)).toThrow('填写')
  gesture.action.context = { observation: '现场原文', injected: '隐藏内容' }
  expect(() => service.webPublicationAction(id, 'save', 'undeclared', gesture)).toThrow('原卡片')
  expect(ask).toHaveBeenCalledTimes(0)
  gesture.action.context = { observation: '现场原文' }
  service.webPublicationAction(id, 'save', 'click-1', gesture)
  service.webPublicationAction(id, 'save', 'click-2', gesture)
  await service.close()
  expect(ask).toHaveBeenCalledTimes(1)
  expect(ask.mock.calls[0][0].signalContext).toMatchObject({
    kind: 'ui_action',
    payload: { matterId: matter.id, formValues: { observation: '现场原文' } },
  })
  expect(ask.mock.calls[0][0].question).toContain('现场观察：现场原文')
})

test('a historical reply based on a withdrawn source is omitted from both working history and on-demand retrieval', async () => {
  const { store, service, ask, first } = setup(
    async (input) => {
      const reader = input.actions?.capabilities?.find(
        (t) => t.definition.name === 'read_conversation',
      )!
      const page = await reader.execute({ matterId: matter.id }, new AbortController().signal)
      expect(JSON.stringify(page)).not.toContain('restricted-A19')
      expect(page).toMatchObject({ redactedTurnIds: [oldTurnId], turns: [] })
      return { text: '按当前权限读取。' }
    },
    undefined,
    true,
  )
  const matter = store.ledger.createMatter('router-owner', '交接核对', '核对现场信息', ['收到签名'])
  const old = store.conversations.begin('general', 'record-1', '检查 restricted-A19')
  if (old.kind !== 'started') throw Error('Expected prior turn')
  const oldTurnId = old.turn.id
  store.conversations.finish('general', 'record-1', old.attempt, {
    text: 'restricted-A19',
    matterIds: [matter.id],
    sourceEventIds: [first],
  })
  const current = store.getSettings()
  store.saveSettings({ ...current.settings, wxarc: { sessions: [] } }, current.revision)
  await service.message('general', 'new-query', '查看已获准的资料。')
  expect(ask.mock.calls[0][0].history).toHaveLength(0)
  expect(ask.mock.calls[0][0].contextProvenance).toMatchObject({
    redactedAfterGrantChange: [old.turn.id],
  })
})
