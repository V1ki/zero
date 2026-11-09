import { Database } from 'bun:sqlite'
import { expect, mock, test } from 'bun:test'
import { RouterLedgerStore, TriggerStore } from '@zero-os/observe'
import { routerCapabilities } from '../router-capabilities'
import { RouterDocuments } from '../router-documents'
import { preferenceCapabilities } from '../router-preference-capabilities'
import { RouterPublications } from '../router-publications'
import { TriggerRoutingRuntime } from '../routing-runtime'

const signal = new AbortController().signal
const presentation = {
  title: '复测仍待完成',
  text: '资料已核对，但还没有真实复测证据。',
  actions: [],
}

test('a prepared publication cannot send after its source access is revoked; a failed platform does not repeat accepted channels', async () => {
  const db = new Database(':memory:')
  try {
    const ledger = new RouterLedgerStore(db)
    const matter = ledger.createMatter('router-owner', '核查', '真实复测', ['复测记录'])
    let allowed = true
    const calls: string[] = []
    const transport = {
      listPersonalBots: () => [],
      getConfig: () => ({ revision: 0, settings: { personalBots: { feishu: 'bot' } } }),
      prepareDirectReminder: () => ({ channelId: 'bot', audienceKey: 'private' }),
      sendDirectReminder: async (...args: unknown[]) => {
        calls.push(String(args[0]))
        return { status: 'accepted' as const, receipt: 'receipt' }
      },
    }
    const publications = new RouterPublications(
      ledger,
      transport as unknown as ConstructorParameters<typeof RouterPublications>[1],
      () => allowed,
    )
    ledger.publications.prepare({
      id: 'test',
      principal: 'router-owner',
      matterId: matter.id,
      matterVersion: 1,
      scope: 'general',
      deliveries: [
        { channel: 'web', presentation, target: null },
        {
          channel: 'feishu',
          presentation,
          target: JSON.stringify({ channelId: 'bot', audienceKey: 'private' }),
        },
      ],
    })
    allowed = false
    await publications.resume(signal)
    expect(calls).toEqual([])
    expect(
      ledger.publications
        .get('router-owner', 'test')
        ?.deliveries.every((d) => d.status === 'rejected'),
    ).toBe(true)
    allowed = true
    ledger.updateMatter('router-owner', matter.id, matter.version, {
      state: 'completed',
      context: { verified: '已验收' },
    })
    const tools = routerCapabilities(
      publications.capabilities('router-owner', 'general', 1, () => true),
    )
    await tools.execute('retry_delivery', { publicationId: 'test', channel: 'feishu' }, signal)
    expect(calls).toEqual(['feishu'])
    expect(
      ledger.publications.recentDeliveredTo('router-owner', 'feishu', 'private'),
    ).toMatchObject([{ publicationId: 'test', matterId: matter.id, title: presentation.title }])
    expect(
      ledger.publications.recentDeliveredTo('router-owner', 'feishu', 'previous-peer'),
    ).toEqual([])
    expect(ledger.publications.recentDeliveredTo('another-owner', 'feishu', 'private')).toEqual([])
    const receipt = JSON.parse(
      await tools.execute('read_deliveries', { matterId: matter.id }, signal),
    )
    expect(
      receipt[0].deliveries.find((d: { channel: string }) => d.channel === 'feishu').status,
    ).toBe('accepted')
    expect(JSON.stringify(receipt)).not.toContain(presentation.text)
    const original = JSON.parse(
      await tools.execute('read_publication', { publicationId: 'test', channel: 'feishu' }, signal),
    )
    expect(original.presentation).toEqual(presentation)
    expect(ledger.publications.get('router-owner', 'test')?.deliveries[0].presentation.text).toBe(
      presentation.text,
    )
    await expect(
      tools.execute('retry_delivery', { publicationId: 'test', channel: 'feishu' }, signal),
    ).rejects.toThrow()
    expect(calls).toEqual(['feishu'])
    const restricted = routerCapabilities(
      publications.capabilities(
        'router-owner',
        'general',
        2,
        () => true,
        () => false,
      ),
    )
    await expect(
      restricted.execute('read_deliveries', { matterId: matter.id }, signal),
    ).rejects.toThrow('不可访问')
    await expect(
      restricted.execute('read_publication', { publicationId: 'test', channel: 'feishu' }, signal),
    ).rejects.toThrow('不可访问')
  } finally {
    db.close()
  }
})

test('an uncertain document write is not repeated, and revoked matter context cannot be archived', async () => {
  const db = new Database(':memory:')
  try {
    const ledger = new RouterLedgerStore(db)
    const matter = ledger.createMatter('router-owner', '归档', '保留证据', ['文档回执'])
    ledger.configureDocument({
      id: 'doc',
      principal: 'router-owner',
      channelId: 'feishu',
      documentId: 'abc',
      label: '测试文档',
      url: 'https://example.feishu.cn/docx/abc',
    })
    let calls = 0
    let allowed = true
    const docs = new RouterDocuments(ledger, {
      probeArchive: async () => ({ ok: true, reason: '可写' }),
      appendDocument: async () => {
        calls++
        throw Error('lost response')
      },
    })
    const tools = routerCapabilities(
      docs.capabilities(
        'router-owner',
        1,
        () => true,
        () => allowed,
      ),
    )
    const args = {
      matterId: matter.id,
      version: 1,
      targetId: 'doc',
      title: '核查结果',
      body: '已核对资料，仍缺复测证据。',
    }
    await expect(tools.execute('archive_document', args, signal)).rejects.toThrow('lost response')
    const repeated = JSON.parse(await tools.execute('archive_document', args, signal))
    expect(repeated.state).toBe('unknown')
    expect(ledger.operations.documentReceipts('router-owner', matter.id)).toMatchObject([
      {
        state: 'unknown',
        title: args.title,
        url: 'https://example.feishu.cn/docx/abc',
        reason: expect.stringContaining('需核对文档'),
      },
    ])
    expect(ledger.operations.documentReceipts('other', matter.id)).toEqual([])
    ledger.configureDocument({
      id: 'doc',
      principal: 'router-owner',
      channelId: 'feishu',
      documentId: 'new',
      label: '新目标',
      url: 'https://example.feishu.cn/docx/new',
    })
    expect(ledger.operations.documentReceipts('router-owner', matter.id)[0].url).toBeNull()
    expect(calls).toBe(1)
    const later = routerCapabilities(docs.capabilities('router-owner', 2, () => true))
    await expect(later.execute('archive_document', args, signal)).rejects.toThrow('结果待核实')
    expect(calls).toBe(1)
    allowed = false
    await expect(tools.execute('archive_document', args, signal)).rejects.toThrow('无效')
    expect(calls).toBe(1)
  } finally {
    db.close()
  }
})

test('notification changes use actual revisions and known bots without changing a private audience', async () => {
  const store = new TriggerStore(':memory:')
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: async () => {
      throw Error('unused')
    },
    weixin: {
      listTargets: () => [],
      send: async () => {
        throw Error('unused')
      },
    },
  })
  try {
    let allowed = true
    const tools = routerCapabilities(preferenceCapabilities(routing, () => allowed))
    const before = routing.getConfig()
    const saved = JSON.parse(
      await tools.execute(
        'update_notification_preference',
        { revision: before.revision, key: 'presence', value: 'away' },
        signal,
      ),
    )
    expect(saved.status).toBe('saved')
    expect(routing.getConfig().settings.presence).toBe('away')
    expect(routing.getConfig().settings.weixinTarget).toEqual(before.settings.weixinTarget)
    await expect(
      tools.execute(
        'update_notification_preference',
        { revision: before.revision, key: 'presence', value: 'present' },
        signal,
      ),
    ).rejects.toThrow('已变化')
    await expect(
      tools.execute(
        'update_notification_preference',
        { revision: saved.revision, key: 'personalBot', platform: 'feishu', value: 'unknown' },
        signal,
      ),
    ).rejects.toThrow('找不到')
    allowed = false
    await expect(tools.execute('read_notification_preferences', {}, signal)).rejects.toThrow('权限')
  } finally {
    await routing.close()
    store.close()
  }
})

test('explicit publication channels preserve native rich content without notifying other platforms', async () => {
  const db = new Database(':memory:')
  try {
    const ledger = new RouterLedgerStore(db)
    const matter = ledger.createMatter('router-owner', '排版反馈', '原生卡片可读', ['保留证据'])
    const calls: unknown[][] = []
    const transport = {
      listPersonalBots: () => [],
      getConfig: () => ({
        revision: 0,
        settings: { personalBots: { dingtalk: 'ding', feishu: 'fei', weixin: 'wx' } },
      }),
      prepareDirectReminder: (channel: string) => ({ channelId: channel, audienceKey: 'private' }),
      sendDirectReminder: async (...args: unknown[]) => {
        calls.push(args)
        return { status: 'accepted' as const, receipt: 'native-card' }
      },
    }
    const publications = new RouterPublications(
      ledger,
      transport as unknown as ConstructorParameters<typeof RouterPublications>[1],
    )
    const tools = routerCapabilities(
      publications.capabilities('router-owner', 'general', 10, () => true),
    )
    const formatted = {
      title: '修正版',
      text: '**结论**\n\n- 第一项\n- 第二项\n\n[查看依据](https://example.com/source)',
      actions: [],
    }
    const args = { matterId: matter.id, version: 1, presentations: { dingtalk: formatted } }
    // Existing all-platform behavior remains the default.
    await expect(tools.execute('publish_update', args, signal)).rejects.toThrow('已配置平台')
    for (const requested of [[], ['dingtalk', 'dingtalk'], ['unknown'], ['feishu']]) {
      await expect(
        tools.execute('publish_update', { ...args, deliveryChannels: requested }, signal),
      ).rejects.toThrow('交付平台')
    }
    await expect(
      tools.execute(
        'publish_update',
        {
          ...args,
          deliveryChannels: ['dingtalk'],
          presentations: { ...args.presentations, feishu: formatted },
        },
        signal,
      ),
    ).rejects.toThrow('交付平台')
    expect(calls).toHaveLength(0)
    const receipt = JSON.parse(
      await tools.execute('publish_update', { ...args, deliveryChannels: ['dingtalk'] }, signal),
    )
    expect(receipt.deliveries).toHaveLength(1)
    expect(receipt.deliveries[0]).toMatchObject({
      channel: 'dingtalk',
      status: 'accepted',
      receipt: 'native-card',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe('dingtalk')
    expect(calls[0]?.[6]).toEqual(formatted)
    expect(
      ledger.publications.get('router-owner', receipt.id)?.deliveries[0]?.presentation,
    ).toEqual(formatted)
    await tools.execute('publish_update', { ...args, deliveryChannels: ['dingtalk'] }, signal)
    expect(calls).toHaveLength(1)
    const report = {
      ...formatted,
      text: '这是要求保留的逐项核验记录。'.repeat(1200) + '最后一项仍待核对。',
    }
    const long = JSON.parse(
      await tools.execute(
        'publish_update',
        {
          ...args,
          deliveryChannels: ['web', 'feishu', 'dingtalk', 'weixin'],
          presentations: { web: report, feishu: formatted, dingtalk: report, weixin: formatted },
        },
        signal,
      ),
    )
    const deliveries = ledger.publications.get('router-owner', long.id)!.deliveries
    expect(deliveries.every((d) => d.status === 'accepted')).toBe(true)
    expect(deliveries.find((d) => d.channel === 'web')?.presentation.text).toBe(report.text)
    expect(calls.find((c) => c[0] === 'dingtalk' && c[2] === report.text)).toBeDefined()
    expect(publications.capabilities('general', 'general', 11, () => true)).toEqual([])
    expect(publications.capabilities('router-owner', 'general', 11, () => false)).toEqual([])
    let authorized = true
    const revoked = routerCapabilities(
      publications.capabilities('router-owner', 'general', 11, () => authorized),
    )
    authorized = false
    await expect(
      revoked.execute('publish_update', { ...args, deliveryChannels: ['dingtalk'] }, signal),
    ).rejects.toThrow('权限')
  } finally {
    db.close()
  }
})

test('contextual notifications persist the webpage and its later wake together, even when work completes', async () => {
  const db = new Database(':memory:')
  try {
    const ledger = new RouterLedgerStore(db)
    const m = ledger.createMatter('router-owner', '结果待交付', '跟进结果', ['已收到签收记录'])
    const readyAt = new Date(Date.now() + 3600000)
    const transport = {
      getConfig: () => ({
        settings: {
          enabled: true,
          notificationMode: 'contextual',
          personalBots: { weixin: 'fixture' },
        },
      }),
      sendDirectReminder: async () => {
        throw Error('unexpected send')
      },
    }
    const publications = new RouterPublications(
      ledger,
      transport as unknown as ConstructorParameters<typeof RouterPublications>[1],
    )
    const tool = publications
      .capabilities('router-owner', 'general', 1, () => true)
      .find((t) => t.definition.name === 'publish_update')!
    const args = {
      matterId: m.id,
      version: 1,
      presentations: { web: presentation },
      deliveryChannels: ['web'],
    }
    await expect(
      Promise.resolve(tool.execute({ ...args, remindAt: new Date(0).toISOString() }, signal)),
    ).rejects.toThrow('未来')
    expect(ledger.publications.list('router-owner')).toHaveLength(0)
    await expect(
      Promise.resolve(tool.execute({ ...args, deliveryChannels: undefined }, signal)),
    ).rejects.toThrow('选择交付渠道')
    const result = (await tool.execute({ ...args, remindAt: readyAt.toISOString() }, signal)) as {
      id: string
      reminder: { id: string; dueAt: string }
    }
    expect(result.reminder.dueAt).toBe(readyAt.toISOString())
    ledger.updateMatter('router-owner', m.id, 1, {
      state: 'completed',
      context: { receipt: '已签收' },
    })
    expect(ledger.listTimers('router-owner', m.id)[0].state).toBe('scheduled')
    const recovered = new RouterLedgerStore(db)
    expect(recovered.releaseDueTimers(readyAt)).toBe(1)
    expect(recovered.releaseDueTimers(readyAt)).toBe(0)
    expect(recovered.claimSignal()?.payload).toMatchObject({
      publicationId: result.id,
      matterId: m.id,
    })
    expect(
      recovered.publications
        .get('router-owner', result.id)
        ?.deliveries.map((d) => [d.channel, d.status]),
    ).toEqual([['web', 'accepted']])
  } finally {
    db.close()
  }
})

test('pausing notifications keeps web results readable and blocks an IM delivery prepared before the pause', async () => {
  const db = new Database(':memory:')
  try {
    const ledger = new RouterLedgerStore(db)
    const matter = ledger.createMatter('router-owner', '审批排期', '核对日期', ['取得日期'])
    const transport = {
      getConfig: () => ({ settings: { enabled: false, personalBots: { weixin: 'bot' } } }),
      sendDirectReminder: mock(async () => ({ status: 'accepted' })),
    }
    const publications = new RouterPublications(
      ledger,
      transport as unknown as ConstructorParameters<typeof RouterPublications>[1],
    )
    ledger.publications.prepare({
      id: 'pending',
      scope: 'general',
      principal: 'router-owner',
      matterId: matter.id,
      matterVersion: 1,
      deliveries: [
        { channel: 'weixin', presentation, target: 'previously-bound' },
        { channel: 'web', presentation, target: null },
      ],
    })
    await publications.resume(signal)
    const results = ledger.publications.get('router-owner', 'pending')!.deliveries
    expect(results.find((d) => d.channel === 'weixin')).toMatchObject({
      status: 'rejected',
      reason: '主动通知已暂停。',
    })
    expect(results.find((d) => d.channel === 'web')?.status).toBe('accepted')
    const tools = routerCapabilities(
      publications.capabilities('router-owner', 'general', 1, () => true),
    )
    const receipts = JSON.parse(
      await tools.execute('read_deliveries', { matterId: matter.id }, signal),
    )
    expect(
      receipts[0].deliveries.find((d: { channel: string }) => d.channel === 'weixin').reason,
    ).toBe('主动通知已暂停。')
    expect(transport.sendDirectReminder).not.toHaveBeenCalled()
  } finally {
    db.close()
  }
})

test('searching a quotation pages through accepted messages for the current reader, without binding every match as its matter', async () => {
  const db = new Database(':memory:')
  try {
    const ledger = new RouterLedgerStore(db)
    const publications = new RouterPublications(ledger, {} as TriggerRoutingRuntime)
    const observed: [string, boolean][] = []
    let authorized = true
    const tools = routerCapabilities(
      publications.capabilities(
        'router-owner',
        'general',
        1,
        () => authorized,
        (id) => id !== 'revoked',
        {
          channel: 'weixin',
          audienceKey: 'current',
          observe: (id, original) => {
            observed.push([id, original])
          },
        },
      ),
    )
    for (let i = 0; i < 38; i++) {
      const channel = i === 33 ? 'dingtalk' : 'weixin'
      const principal = i === 36 ? 'another-owner' : 'router-owner'
      const id = 'pub-' + i
      ledger.publications.prepare({
        id,
        principal,
        scope: 'general',
        matterId: i === 34 ? 'revoked' : 'matter-' + i,
        matterVersion: 1,
        deliveries: [
          {
            channel,
            target: JSON.stringify({ audienceKey: i === 32 ? 'previous' : 'current' }),
            presentation: { ...presentation, text: '第' + i + '份签收单：Lot%7' },
          },
        ],
      })
      const claim = ledger.publications.claim(principal, id, channel)!
      ledger.publications.finish(principal, id, channel, claim.attempt, {
        status: i === 35 ? 'unknown' : 'accepted',
        receipt: null,
        reason: null,
      })
    }
    const search = async (before?: string) =>
      JSON.parse(
        await tools.execute(
          'search_publications',
          {
            query: 'lot%7',
            ...(before && { before }),
          },
          signal,
        ),
      )
    const first = await search()
    expect(first.items.length).toBe(30)
    const second = await search(first.nextBefore)
    expect(second.nextBefore).toBe(null)
    const ids = [...first.items, ...second.items].map((x) => x.publicationId).sort()
    expect(ids).toEqual([...Array.from({ length: 32 }, (_, i) => 'pub-' + i), 'pub-37'].sort())
    expect(observed.every(([, original]) => !original)).toBe(true)
    await tools.execute('read_publication', { publicationId: 'pub-0', channel: 'weixin' }, signal)
    expect(observed.at(-1)).toEqual(['matter-0', true])
    expect(
      JSON.parse(await tools.execute('search_publications', { query: 'lot_7' }, signal)).items,
    ).toEqual([])
    authorized = false
    await expect(search()).rejects.toThrow('权限')
  } finally {
    db.close()
  }
})
