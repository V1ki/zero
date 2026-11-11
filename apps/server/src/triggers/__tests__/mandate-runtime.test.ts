import { expect, mock, test } from 'bun:test'
import * as lark from '@larksuiteoapi/node-sdk'
import { FeishuChannel } from '@zero-os/channel'
import { TriggerStore } from '@zero-os/observe'
import type {
  MandateTarget,
  TriggerAgentResult,
  TriggerInboxItem,
  TriggerMandate,
  TriggerPriorEvent,
} from '@zero-os/shared'
import type {
  MandateInvestigationContext,
  MandateInvestigationResult,
} from '../mandate-investigation'
import {
  type MandateDelivery,
  type MandateReceipt,
  TriggerMandateRuntime,
  investigationFallback,
} from '../mandate-runtime'

const scope = 'test/mandate-repo'
const target: MandateTarget = {
  platform: 'dingtalk',
  channelId: 'test-ding',
  peerId: 'test-room',
  operatorId: 'test-member',
}
const document = { channelId: 'test-feishu', documentId: 'test-doc' }
const mandate: TriggerMandate = {
  id: 'release',
  name: '发布跟进',
  purpose: '解释发布影响',
  enabled: true,
  source: 'github',
  scope,
  keyword: '',
  projectId: null,
  targets: [target],
  archive: null,
  policy: { duringWork: 'dingtalk' },
  urgent: false,
  deadline: null,
}

function fixture(
  mandates: TriggerMandate[],
  options: {
    send?: (
      target: MandateTarget,
      payload: MandateDelivery,
      maySend: () => boolean,
    ) => Promise<MandateReceipt>
    archive?: (
      payload: MandateDelivery,
      signal: AbortSignal,
      maySend: () => boolean,
    ) => Promise<MandateReceipt>
    analyze?: () => Promise<void>
    triage?: (event: TriggerInboxItem) => TriggerAgentResult['triage']
    investigate?: (
      event: TriggerInboxItem,
      signal: AbortSignal,
      context: MandateInvestigationContext,
    ) => Promise<MandateInvestigationResult>
    noInvestigator?: boolean
    now?: () => Date
  } = {},
) {
  const store = new TriggerStore(':memory:')
  store.saveSettings(
    {
      github: {
        credentialRef: '',
        repositories: [
          {
            name: scope,
            enabled: true,
            workflowFailures: true,
            branch: '',
            workflow: '',
            mention: '',
          },
        ],
      },
      wxarc: { sessions: [{ id: 'private-room', name: '测试', enabled: true, keyword: '' }] },
    },
    0,
  )
  const global = store.routing.getSettings()
  store.routing.saveSettings(
    {
      ...global.settings,
      timeZone: 'UTC',
      workdays: [1, 2, 3, 4, 5],
      workStart: '09:00',
      workEnd: '18:00',
      enabled: true,
      presence: 'present',
      duringWork: 'web',
    },
    global.revision,
  )
  store.mandates.saveSettings({ mandates, projects: [] }, 0)
  const now = options.now ?? (() => new Date('2030-01-07T12:00:00Z'))
  const analyze = mock(
    async (
      event: TriggerInboxItem,
      sessionId: string,
      _signal: AbortSignal,
      context: { purpose: string; previous: TriggerPriorEvent[] },
    ): Promise<TriggerAgentResult> => {
      await options.analyze?.()
      const triage = options.triage?.(event)
      return {
        summary: `${context.purpose} - ${event.summary}`,
        sessionId,
        ...(triage && { triage }),
      }
    },
  )
  const send = mock(
    async (
      to: MandateTarget,
      payload: MandateDelivery,
      _signal: AbortSignal,
      maySend: () => boolean,
    ): Promise<MandateReceipt> =>
      options.send?.(to, payload, maySend) ?? { status: 'accepted', receipt: 'test-message' },
  )
  const archive = mock(
    async (
      _target: typeof document,
      payload: MandateDelivery,
      signal: AbortSignal,
      maySend: () => boolean,
    ): Promise<MandateReceipt> =>
      options.archive?.(payload, signal, maySend) ?? { status: 'accepted', receipt: 'test-block' },
  )
  const investigate = mock(
    async (
      event: TriggerInboxItem,
      _sessionId: string,
      signal: AbortSignal,
      context: MandateInvestigationContext,
    ): Promise<MandateInvestigationResult> =>
      options.investigate?.(event, signal, context) ?? {
        status: 'read',
        summary: `调查结论 ${event.eventId}`,
      },
  )
  const deps = {
    analyze,
    ...(!options.noInvestigator && { investigate }),
    platforms: { listTargets: () => [target], send, archive },
  }
  const runtime = new TriggerMandateRuntime(store, deps, now)
  function ingest(source: 'github' | 'wxarc', ...ids: string[]) {
    const sourceScope = source === 'github' ? scope : 'private-room'
    expect(
      store.commitPush({
        source,
        revision: store.getSettings().revision,
        stream: `${source}:${sourceScope}`,
        events: ids.map((eventId) => ({
          eventId,
          scope: sourceScope,
          occurredAt: '2025-01-01T12:00:00Z',
          title: 'sensitive-fixture-title',
          summary: 'sensitive-fixture-body',
        })),
      }),
    ).toBe(true)
    runtime.notify()
  }
  async function close() {
    await runtime.close()
    store.close()
  }
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
  return { runtime, store, analyze, investigate, send, archive, ingest, close, flush, deps, now }
}

test('one inbox event can serve different purposes and audiences with independent archive and no legacy delivery', async () => {
  const research = {
    ...mandate,
    id: 'research',
    purpose: '归纳实验记录',
    targets: [],
    archive: document,
    policy: { duringWork: 'none' as const },
  }
  const f = fixture([mandate, research])
  try {
    f.ingest('github', 'event-1')
    f.runtime.start()
    await f.flush()
    const [event] = f.store.listInbox()
    const rows = f.store.mandates.listMatches()
    expect(rows).toHaveLength(2)
    expect(f.store.routing.get(event.id)).toBeNull()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send.mock.calls[0][1].entries[0].summary).toContain(mandate.purpose)
    expect(f.archive).toHaveBeenCalledTimes(1)
    expect(f.archive.mock.calls[0][0]).toEqual(document)
    const record = rows.find((row) => row.mandateId === 'research')
    expect(record?.summary).toContain(research.purpose)
    expect(record?.effects).toMatchObject([
      { kind: 'archive', status: 'done', receipt: 'test-block' },
      { kind: 'notify', status: 'skipped' },
    ])
    f.ingest('github', 'event-1')
    await f.flush()
    expect(f.analyze).toHaveBeenCalledTimes(2)
  } finally {
    await f.close()
  }
})

test('an offline window becomes a single authorized digest after its pending analyses, including private-source redaction', async () => {
  const f = fixture([
    {
      ...mandate,
      source: 'wxarc',
      scope: 'private-room',
      archive: document,
      policy: { duringWork: 'dingtalk', digestMinutes: 60 },
    },
  ])
  try {
    f.ingest('wxarc', 'event-a', 'event-b', 'event-c')
    f.runtime.start()
    await f.flush()
    expect(f.send).toHaveBeenCalledTimes(1)
    const payload = f.send.mock.calls[0][1]
    expect(payload.digest).toBe(true)
    expect(payload.entries.map((x) => x.matchId)).toEqual([1, 2, 3])
    expect(JSON.stringify(payload)).not.toContain('sensitive-fixture')
    expect(JSON.stringify(payload)).not.toContain('private-room')
    expect(f.archive).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(f.archive.mock.calls)).not.toContain('sensitive-fixture')
    expect(f.store.mandates.listTasks()).toHaveLength(3)
    expect(
      f.store.mandates
        .listMatches()
        .flatMap((row) => row.effects.filter((x) => x.kind === 'notify').map((x) => x.receipt)),
    ).toEqual(['test-message', 'test-message', 'test-message'])
  } finally {
    await f.close()
  }
})

test('unknown external acceptance survives restart without retry while a definitely rejected archive can be retried', async () => {
  let accepted = false
  const f = fixture([{ ...mandate, archive: document }], {
    send: async () => {
      throw new Error('private response')
    },
    archive: async () =>
      accepted
        ? { status: 'accepted', receipt: 'block-after-retry' }
        : { status: 'rejected', reason: '文档拒绝写入' },
  })
  try {
    f.ingest('github', 'event-1')
    f.runtime.start()
    await f.flush()
    const row = f.store.mandates.listMatches()[0]
    expect(row.effects.map((e) => e.status)).toEqual(['failed', 'unknown'])
    expect(JSON.stringify(row)).not.toContain('private response')
    expect(f.runtime.retry(row.id, 'notify')).toBe(false)
    accepted = true
    expect(f.runtime.retry(row.id, 'archive')).toBe(true)
    await f.flush()
    await f.runtime.close()
    const restarted = new TriggerMandateRuntime(f.store, f.deps, f.now)
    restarted.start()
    await f.flush()
    await restarted.close()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.archive).toHaveBeenCalledTimes(2)
    expect(f.archive.mock.calls[0][1].id).toBe(f.archive.mock.calls[1][1].id)
    expect(f.store.mandates.getMatch(row.id)?.effects.map((e) => e.status)).toEqual([
      'done',
      'unknown',
    ])
  } finally {
    await f.close()
  }
})

test('revoking a mandate during analysis prevents both effects, including after re-enabling', async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const item = { ...mandate, archive: document }
  const f = fixture([item], {
    analyze: async () => {
      started.resolve()
      await release.promise
    },
  })
  try {
    f.ingest('github', 'event-1')
    f.runtime.start()
    await started.promise
    f.store.mandates.saveSettings({ mandates: [{ ...item, enabled: false }], projects: [] }, 1)
    f.store.mandates.saveSettings({ mandates: [item], projects: [] }, 2)
    release.resolve()
    await f.flush()
    expect(f.store.mandates.listMatches()[0].status).toBe('revoked')
    expect(f.archive).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  } finally {
    release.resolve()
    await f.close()
  }
})

test('related runs reuse just their own authorized task summaries and session', async () => {
  const f = fixture([mandate, { ...mandate, id: 'research', purpose: '研究观点' }])
  try {
    f.ingest('github', '11:run:27:1:failure', '11:run:27:2:failure')
    f.runtime.start()
    await f.flush()
    expect(f.analyze).toHaveBeenCalledTimes(4)
    for (const purpose of [mandate.purpose, '研究观点']) {
      const calls = f.analyze.mock.calls.filter((call) => call[3].purpose === purpose)
      expect(calls[0][1]).toBe(calls[1][1])
      expect(calls[0][3]).toMatchObject({ previous: [] })
      expect(calls[1][3]).toMatchObject({
        previous: [{ summary: `${purpose} - sensitive-fixture-body` }],
      })
    }
    const sessions = new Set(f.analyze.mock.calls.map((c) => c[1]))
    expect(sessions.size).toBe(2)
  } finally {
    await f.close()
  }
})

test('presence wakes an eligible deferred Web item; preview simulates the same policy without effects', async () => {
  const f = fixture([{ ...mandate, policy: { duringWork: 'web' } }])
  const markers: number[] = []
  const unsubscribe = f.store.webNotifications.subscribe(() => {
    markers.push(f.store.webNotifications.latestId())
  })
  try {
    const { settings, revision } = f.store.routing.getSettings()
    f.store.routing.saveSettings({ ...settings, presence: 'auto', awayFallback: 'defer' }, revision)
    const simulation = f.runtime.preview(mandate.id, f.now().toISOString(), true)
    expect(simulation.decision.destination).toBe('web')
    expect(f.store.mandates.listMatches()).toHaveLength(0)
    f.ingest('github', 'web-event')
    f.runtime.start()
    await f.flush()
    const read = () => f.store.mandates.listMatches()[0].effects.find((e) => e.kind === 'notify')
    expect(read()?.status).toBe('deferred')
    expect(markers).toEqual([])
    f.runtime.heartbeat()
    await f.flush()
    expect(read()).toMatchObject({ destination: 'web', status: 'done' })
    const [notice] = f.store.webNotifications.list({}).items
    expect(notice.taskId).toBe(f.store.mandates.listMatches()[0].taskId)
    expect(markers).toEqual([notice.id])
    expect(f.analyze).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
  } finally {
    unsubscribe()
    await f.close()
  }
})

test('a completed digest opens at the persisted receipt boundary without an event or Web heartbeat', async () => {
  const minute = 60_000
  let clock = new Date()
  const f = fixture(
    [
      {
        ...mandate,
        policy: {
          duringWork: 'dingtalk',
          afterWork: 'dingtalk',
          offDay: 'dingtalk',
          digestMinutes: 1,
        },
      },
    ],
    { now: () => clock },
  )
  try {
    f.ingest('github', 'summary-1', 'summary-2')
    const received = Date.parse(f.store.listInbox()[0].receivedAt)
    const boundary = (Math.floor(received / minute) + 1) * minute
    clock = new Date(boundary - 20)
    f.runtime.start()
    await f.flush()
    expect(f.store.mandates.nextDueAt()).toBe(new Date(boundary).toISOString())
    expect(f.send).not.toHaveBeenCalled()
    clock = new Date(boundary)
    const deadline = performance.now() + 1200
    while (!f.send.mock.calls.length && performance.now() < deadline) await Bun.sleep(5)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send.mock.calls[0][1].entries).toHaveLength(2)
  } finally {
    await f.close()
  }
})

test('fixed reminders route without a model using only adapter facts, even when the same source also requires analysis', async () => {
  const direct: TriggerMandate = {
    ...mandate,
    id: 'fixed',
    processing: 'direct',
    archive: document,
  }
  const f = fixture([direct, mandate], {
    analyze: async () => {
      throw new Error('no model')
    },
  })
  try {
    f.ingest('github', '11:run:27:2:failure', '11:comment:44', 'ci:report-30', 'other')
    f.runtime.start()
    await f.flush()
    const grouped = f.store.mandates.listMatches()
    const analyzed = grouped.filter((row) => row.mandateId === mandate.id)
    expect(analyzed.map((row) => row.status)).toEqual(['failed', 'failed', 'failed', 'failed'])
    expect(f.analyze).toHaveBeenCalledTimes(4)
    const summaries = f.send.mock.calls.map((call) => call[1].entries[0].summary)
    expect(summaries).toEqual([
      'test/mandate-repo 的工作流运行 #27 第 2 次尝试失败。',
      'test/mandate-repo 的 PR 讨论评论 #44 提到了订阅中指定的账号。',
      'test/mandate-repo 收到一条匹配的 CI 失败报告。',
      'test/mandate-repo 收到一条符合监听条件的 GitHub 事件。',
    ])
    expect(f.archive).toHaveBeenCalledTimes(4)
    expect(JSON.stringify([f.send.mock.calls, f.archive.mock.calls])).not.toContain(
      'sensitive-fixture',
    )
  } finally {
    await f.close()
  }
})

test('direct WXARC reminders use a local fixed summary and keep the room and raw message out of external delivery', async () => {
  const f = fixture([
    { ...mandate, processing: 'direct', source: 'wxarc', scope: 'private-room', archive: document },
  ])
  try {
    f.ingest('wxarc', 'wxarc:text:14')
    f.runtime.start()
    await f.flush()
    expect(f.analyze).not.toHaveBeenCalled()
    expect(f.store.mandates.listMatches()[0].summary).toBe('已订阅的微信会话有一条匹配的文字消息。')
    const entry = f.send.mock.calls[0][1].entries[0]
    expect(entry).toMatchObject({
      taskId: 1,
      title: '微信监听事项',
      summary: '已订阅的微信会话有新的处理结果，可在 ZeRo 查看。',
    })
    const payloads = JSON.stringify([f.send.mock.calls, f.archive.mock.calls])
    expect(payloads).not.toContain('sensitive-fixture')
    expect(payloads).not.toContain('private-room')
  } finally {
    await f.close()
  }
})

test('moving an active mandate to direct processing retires the previous analysis before it can notify', async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const f = fixture([mandate], {
    analyze: async () => {
      started.resolve()
      await release.promise
    },
  })
  try {
    f.ingest('github', 'old')
    f.runtime.start()
    await started.promise
    f.store.mandates.saveSettings(
      { projects: [], mandates: [{ ...mandate, processing: 'direct' }] },
      1,
    )
    f.ingest('github', 'new')
    release.resolve()
    await f.flush()
    expect(f.store.mandates.listMatches().map((row) => row.status)).toEqual(['ready', 'revoked'])
    expect(f.analyze).toHaveBeenCalledTimes(1)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.send.mock.calls)).not.toContain('sensitive-fixture')
  } finally {
    release.resolve()
    await f.close()
  }
})

test('swapping overlapping mandate rules changes the persisted outcome and its explanation matches the preview', async () => {
  const rules: NonNullable<TriggerMandate['policy']['rules']> = [
    { id: 'desk', name: '电脑前展示', when: { presence: 'present' }, destination: 'web' },
    {
      id: 'pause',
      name: '普通工作先延后',
      when: { urgency: 'normal', period: 'duringWork' },
      destination: 'defer',
    },
  ]
  const row = { ...mandate, processing: 'direct' as const, policy: { rules } }
  const f = fixture([row])
  try {
    f.runtime.start()
    for (const [order, name, dest] of [
      [rules, '电脑前展示', 'web'],
      [[rules[1], rules[0]], '普通工作先延后', 'defer'],
    ] as const) {
      const config = f.store.mandates.getSettings()
      f.store.mandates.saveSettings(
        { projects: [], mandates: [{ ...row, policy: { rules: [...order] } }] },
        config.revision,
      )
      const preview = f.runtime.preview(row.id, f.now().toISOString(), true, false)
      expect(preview.decision.destination).toBe(dest)
      expect(preview.decision.reason).toContain(name)
      f.ingest('github', name)
      await f.flush()
      const effect = f.store.mandates.listMatches()[0].effects.find((e) => e.kind === 'notify')
      expect(effect).toMatchObject({ destination: dest, reason: preview.decision.reason })
    }
    expect(f.send).not.toHaveBeenCalled()
    expect(f.store.webNotifications.list().items).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test('retiring a WXARC grant during the Feishu ACL read prevents the document append', async () => {
  const append = mock(async () => ({ code: 0, data: { children: [{ block_id: 'fixture' }] } }))
  const acl = mock(async () => {
    const current = f.store.getSettings()
    current.settings.wxarc.sessions[0].keyword = 'new-private-filter'
    f.store.saveSettings(current.settings, current.revision)
    return { code: 0, data: { auth_result: true } }
  })
  const channel = new FeishuChannel(
    { name: 'test-feishu', appId: 'fixture', appSecret: 'fixture' },
    {
      createClient: () =>
        ({
          application: {
            scope: {
              list: async () => ({
                code: 0,
                data: {
                  scopes: [{ scope_name: 'docx:document', grant_status: 1, scope_type: 'tenant' }],
                },
              }),
            },
          },
          drive: { permissionMember: { auth: acl } },
          docx: { documentBlockChildren: { create: append } },
        }) as unknown as lark.Client,
      createEventDispatcher: (options) => new lark.EventDispatcher(options),
      createWsClient: () => ({ start: async () => {}, close() {} }),
    },
  )
  const f = fixture(
    [
      {
        ...mandate,
        source: 'wxarc',
        scope: 'private-room',
        processing: 'direct',
        archive: { channelId: 'test-feishu', documentId: 'doxcnTarget' },
        policy: { duringWork: 'none' },
      },
    ],
    {
      archive: (payload, signal, maySend) =>
        channel.router.archive('doxcnTarget', payload, signal, maySend),
    },
  )
  try {
    await channel.start()
    f.ingest('wxarc', 'wxarc:text:1')
    f.runtime.start()
    await f.flush()
    expect(acl).toHaveBeenCalledTimes(1)
    expect(append).not.toHaveBeenCalled()
    expect(f.store.mandates.getTask(1)?.active).toBe(false)
    expect(f.store.mandates.getMatch(1)?.effects.find((e) => e.kind === 'archive')?.status).toBe(
      'revoked',
    )
  } finally {
    await f.close()
    await channel.stop()
  }
})

test('a policy change while obtaining a token returns a provably unsent claim for rerouting', async () => {
  const f = fixture([mandate], {
    send: async (_target, _payload, maySend) => {
      const current = f.store.mandates.getSettings()
      current.settings.mandates[0].policy.duringWork = 'web'
      f.store.mandates.saveSettings(current.settings, current.revision)
      expect(maySend()).toBe(false)
      return { status: 'rejected', reason: '未发出' }
    },
  })
  try {
    f.ingest('github', 'test-run')
    f.runtime.start()
    await f.flush()
    expect(f.send).toHaveBeenCalledTimes(1)
    const notify = f.store.mandates.getMatch(1)?.effects.find((e) => e.kind === 'notify')
    expect(notify).toMatchObject({ status: 'done', destination: 'web' })
  } finally {
    await f.close()
  }
})

for (const receipt of ['accepted', 'unknown'] as const) {
  test(`retains the ${receipt} receipt when the grant is revoked after dispatch`, async () => {
    const f = fixture([mandate], {
      send: async (_target, _payload, maySend) => {
        expect(maySend()).toBe(true)
        // A provider write has already started. The grant can change while its reply is in flight.
        const current = f.store.getSettings()
        current.settings.github.repositories[0].branch = 'different'
        f.store.saveSettings(current.settings, current.revision)
        return receipt === 'accepted'
          ? { status: 'accepted', receipt: 'om_fixture' }
          : { status: 'unknown', reason: '回执丢失' }
      },
    })
    try {
      f.ingest('github', 'test-run')
      f.runtime.start()
      await f.flush()
      const effect = f.store.mandates.getMatch(1)?.effects.find((e) => e.kind === 'notify')
      expect(effect).toMatchObject({
        status: receipt === 'accepted' ? 'done' : 'unknown',
        destination: 'dingtalk',
      })
      expect(f.runtime.retry(1, 'notify')).toBe(false)
      expect(f.send).toHaveBeenCalledTimes(1)
    } finally {
      await f.close()
    }
  })
}

const skipAll = () => ({ decision: 'skip' as const, reason: '与上次相同。' })

test('triage skips only the notify effect, keeps archiving, and notify anyway re-opens it', async () => {
  const f = fixture([{ ...mandate, archive: document }], { triage: skipAll })
  try {
    f.ingest('github', 'event-1')
    f.runtime.start()
    await f.flush()
    const [match] = f.store.mandates.listMatches()
    expect(match.status).toBe('ready')
    expect(match.summary).toContain(mandate.purpose)
    expect(match.effects).toEqual([
      expect.objectContaining({ kind: 'archive', status: 'done' }),
      expect.objectContaining({
        kind: 'notify',
        status: 'skipped',
        reason: '分诊判断无需提醒：与上次相同。',
        triaged: true,
      }),
    ])
    expect(f.archive).toHaveBeenCalledTimes(1)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.runtime.retry(match.id, 'archive')).toBe(false)
    expect(f.runtime.retry(match.id, 'notify')).toBe(true)
    await f.flush()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.store.mandates.getMatch(match.id)?.effects[1]).toMatchObject({
      kind: 'notify',
      status: 'done',
    })
    expect(f.store.mandates.getMatch(match.id)?.effects[1].triaged).toBeUndefined()
    expect(f.analyze).toHaveBeenCalledTimes(1)
  } finally {
    await f.close()
  }
})

test('a policy skip cannot be re-opened by retry', async () => {
  const f = fixture([{ ...mandate, policy: { duringWork: 'none' } }])
  try {
    f.ingest('github', 'event-1')
    f.runtime.start()
    await f.flush()
    const [match] = f.store.mandates.listMatches()
    expect(match.effects[1]).toMatchObject({ kind: 'notify', status: 'skipped' })
    expect(match.effects[1].triaged).toBeUndefined()
    expect(f.runtime.retry(match.id, 'notify')).toBe(false)
  } finally {
    await f.close()
  }
})

test('urgent mandates, direct reminders and triage turned off are never filtered', async () => {
  for (const [rule, triageOn] of [
    [{ ...mandate, urgent: true }, true],
    [{ ...mandate, processing: 'direct' as const }, true],
    [mandate, false],
  ] as const) {
    const f = fixture([rule], { triage: skipAll })
    try {
      if (!triageOn) {
        const current = f.store.routing.getSettings()
        f.store.routing.saveSettings({ ...current.settings, triage: false }, current.revision)
      }
      f.ingest('github', 'event-1')
      f.runtime.start()
      await f.flush()
      expect(f.send).toHaveBeenCalledTimes(1)
      expect(f.analyze).toHaveBeenCalledTimes(rule.processing === 'direct' ? 0 : 1)
      expect(f.store.mandates.listMatches()[0].effects[1]).toMatchObject({ status: 'done' })
    } finally {
      await f.close()
    }
  }
})

test('a skipped match drops out of a digest, still counts as prior context and is marked filtered', async () => {
  const f = fixture(
    [{ ...mandate, groupBy: 'mandate', policy: { duringWork: 'dingtalk', digestMinutes: 60 } }],
    { triage: (event) => (event.eventId === 'event-b' ? skipAll() : undefined) },
  )
  try {
    f.ingest('github', 'event-a', 'event-b', 'event-c')
    f.runtime.start()
    await f.flush()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send.mock.calls[0][1].entries.map((entry) => entry.matchId)).toEqual([1, 3])
    const last = f.analyze.mock.calls[2][3].previous
    expect(last.map((prior) => prior.outcome)).toEqual(['not_notified', 'filtered'])
  } finally {
    await f.close()
  }
})

const investigating: TriggerMandate = {
  ...mandate,
  processing: 'investigate',
  groupBy: 'mandate',
}
const notified = (f: ReturnType<typeof fixture>) =>
  f.send.mock.calls.flatMap((call) => call[1].entries.map((entry) => entry.summary))

test('investigation runs only after a notify outcome and its text becomes the summary and the next prior context', async () => {
  const f = fixture([investigating], {
    triage: (event) => (event.eventId === 'event-b' ? skipAll() : undefined),
  })
  try {
    f.ingest('github', 'event-a', 'event-b', 'event-c')
    f.runtime.start()
    await f.flush()
    expect(f.investigate.mock.calls.map((call) => call[0].eventId)).toEqual(['event-a', 'event-c'])
    expect(f.investigate.mock.calls[0][3]).toEqual({
      purpose: mandate.purpose,
      triage: `${mandate.purpose} - sensitive-fixture-body`,
    })
    expect(f.investigate.mock.calls[0][1]).toBe(f.analyze.mock.calls[0][1])
    const [a, b, c] = [1, 2, 3].map((id) => f.store.mandates.getMatch(id))
    expect(a?.summary).toBe('调查结论 event-a')
    expect(b?.summary).toBe(`${mandate.purpose} - sensitive-fixture-body`)
    expect(b?.effects[1]).toMatchObject({ status: 'skipped', triaged: true })
    expect(c?.summary).toBe('调查结论 event-c')
    expect(f.analyze.mock.calls[1][3].previous.map((prior) => prior.summary)).toEqual([
      '调查结论 event-a',
    ])
    expect(notified(f)).toEqual(['调查结论 event-a', '调查结论 event-c'])
    // Notifying a filtered match anyway reuses its stored summary and reads nothing.
    expect(f.runtime.retry(2, 'notify')).toBe(true)
    await f.flush()
    expect(f.investigate).toHaveBeenCalledTimes(2)
  } finally {
    await f.close()
  }
})

test('urgent mandates still investigate; agent and direct mandates never do', async () => {
  for (const [rule, investigations] of [
    [{ ...investigating, urgent: true }, 1],
    [mandate, 0],
    [{ ...mandate, processing: 'direct' as const }, 0],
  ] as const) {
    const f = fixture([rule], { triage: skipAll })
    try {
      f.ingest('github', '11:run:27:1:failure')
      f.runtime.start()
      await f.flush()
      expect(f.investigate).toHaveBeenCalledTimes(investigations)
      expect(f.send).toHaveBeenCalledTimes(rule.urgent || rule.processing === 'direct' ? 1 : 0)
      if (investigations) expect(notified(f)).toEqual(['调查结论 11:run:27:1:failure'])
    } finally {
      await f.close()
    }
  }
})

test('a missing, unread or failed investigation still notifies with the triage summary and a visible note', async () => {
  const triage = `${mandate.purpose} - sensitive-fixture-body`
  for (const [options, note] of [
    [{ noInvestigator: true }, investigationFallback.unread],
    [{ investigate: async () => ({ status: 'unread' as const }) }, investigationFallback.unread],
    [
      {
        investigate: async () => {
          throw new Error('GitHub 调查超过 90 秒')
        },
      },
      investigationFallback.unfinished,
    ],
  ] as const) {
    const f = fixture([investigating], options)
    try {
      f.ingest('github', 'event-a')
      f.runtime.start()
      await f.flush()
      const match = f.store.mandates.getMatch(1)
      expect(match).toMatchObject({ status: 'ready', error: null, summary: `${triage}${note}` })
      expect(match?.effects[1]).toMatchObject({ status: 'done' })
      expect(notified(f)).toEqual([`${triage}${note}`])
      expect(f.runtime.retry(1, 'analysis')).toBe(false)
    } finally {
      await f.close()
    }
  }
  const long = fixture([investigating], { investigate: async () => ({ status: 'unread' }) })
  try {
    long.analyze.mockImplementationOnce(async (_event, sessionId) => ({
      summary: '长'.repeat(600),
      sessionId,
    }))
    long.ingest('github', 'event-a')
    long.runtime.start()
    await long.flush()
    const summary = long.store.mandates.getMatch(1)?.summary ?? ''
    expect(summary).toHaveLength(600)
    expect(summary.endsWith(investigationFallback.unread)).toBe(true)
  } finally {
    await long.close()
  }
})

test('a triage model error keeps today’s retryable failure and reads nothing', async () => {
  const f = fixture([investigating], {
    analyze: async () => {
      throw new Error('model offline')
    },
  })
  try {
    f.ingest('github', 'event-a')
    f.runtime.start()
    await f.flush()
    expect(f.store.mandates.getMatch(1)?.status).toBe('failed')
    expect(f.investigate).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})

test('pausing, disabling, switching the mode or removing the source during an investigation delivers nothing stale', async () => {
  const changes: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ['pause', (f) => f.store.mandates.setTaskPaused(1, true)],
    [
      'disable',
      (f) =>
        f.store.mandates.saveSettings(
          { projects: [], mandates: [{ ...investigating, enabled: false }] },
          1,
        ),
    ],
    [
      'switch',
      (f) =>
        f.store.mandates.saveSettings(
          { projects: [], mandates: [{ ...investigating, processing: 'agent' }] },
          1,
        ),
    ],
    [
      'source',
      (f) => {
        const current = f.store.getSettings()
        f.store.saveSettings(
          { ...current.settings, github: { credentialRef: '', repositories: [] } },
          current.revision,
        )
      },
    ],
  ]
  for (const [, change] of changes) {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const f = fixture([{ ...investigating, archive: document }], {
      investigate: async () => {
        started.resolve()
        await release.promise
        return { status: 'read', summary: 'stale' }
      },
    })
    try {
      f.ingest('github', 'event-a')
      f.runtime.start()
      await started.promise
      change(f)
      release.resolve()
      await f.flush()
      const match = f.store.mandates.getMatch(1)
      expect(match?.status).toBe('revoked')
      expect(match?.summary).toBeNull()
      expect(f.send).not.toHaveBeenCalled()
      expect(f.archive).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await f.close()
    }
  }
})

test('shutdown aborts an in-flight investigation and the next start runs it again', async () => {
  const started = Promise.withResolvers<void>()
  let aborted = false
  const f = fixture([investigating], {
    investigate: (_event, signal) => {
      started.resolve()
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => {
          aborted = true
          reject(new Error('GitHub 调查已取消。'))
        }),
      )
    },
  })
  try {
    f.ingest('github', 'event-a')
    f.runtime.start()
    await started.promise
    await f.runtime.close()
    expect(aborted).toBe(true)
    expect(f.store.mandates.getMatch(1)?.status).toBe('analyzing')
    expect(f.send).not.toHaveBeenCalled()
    const restarted = new TriggerMandateRuntime(
      f.store,
      {
        ...f.deps,
        investigate: async () => ({ status: 'read' as const, summary: '重启后的调查结论' }),
      },
      f.now,
    )
    restarted.start()
    await f.flush()
    await restarted.close()
    expect(f.analyze).toHaveBeenCalledTimes(2)
    expect(f.store.mandates.getMatch(1)).toMatchObject({
      status: 'ready',
      summary: '重启后的调查结论',
    })
    expect(notified(f)).toEqual(['重启后的调查结论'])
  } finally {
    await f.close()
  }
})

test('deliveries of other matches keep moving while an investigation is in flight', async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let accept = false
  const f = fixture(
    [
      { ...mandate, id: 'chat', source: 'wxarc', scope: 'private-room', processing: 'direct' },
      investigating,
    ],
    {
      send: async () =>
        accept
          ? { status: 'accepted', receipt: 'later' }
          : { status: 'rejected', reason: '平台拒绝' },
      investigate: async () => {
        started.resolve()
        await release.promise
        return { status: 'read', summary: '调查结论' }
      },
    },
  )
  try {
    f.ingest('wxarc', 'wxarc:text:1')
    f.runtime.start()
    await f.flush()
    expect(f.store.mandates.getMatch(1)?.effects[1]).toMatchObject({ status: 'failed' })
    f.ingest('github', 'event-a')
    await started.promise
    accept = true
    expect(f.runtime.retry(1, 'notify')).toBe(true)
    const deadline = performance.now() + 1000
    while (f.send.mock.calls.length < 2 && performance.now() < deadline) await Bun.sleep(5)
    expect(f.store.mandates.getMatch(1)?.effects[1]).toMatchObject({ status: 'done' })
    expect(f.store.mandates.getMatch(2)?.status).toBe('analyzing')
    release.resolve()
    await f.flush()
    expect(f.store.mandates.getMatch(2)?.summary).toBe('调查结论')
    expect(f.send).toHaveBeenCalledTimes(3)
  } finally {
    release.resolve()
    await f.close()
  }
})
