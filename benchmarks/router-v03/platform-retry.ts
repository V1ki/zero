import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TriggerStore } from '@zero-os/observe'
import type { RouterPresentation } from '@zero-os/shared'
import type { AgentDependencies } from '../../apps/server/src/triggers/event-agent'
import { createRouterAgent } from '../../apps/server/src/triggers/router-agent'
import { RouterDocuments } from '../../apps/server/src/triggers/router-documents'
import { createRouterTraceSink } from '../../apps/server/src/triggers/router-trace'
import { RouterWorkspaceService } from '../../apps/server/src/triggers/router-workspace'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'

export async function verifyPlatformRetry(output: string, deps: AgentDependencies) {
  const store = new TriggerStore(join(output, 'workspace.sqlite'))
  const matter = store.ledger.createMatter(
    'router-owner',
    '样稿的签收结论',
    '向已配置的个人入口交付签收版本',
    ['读者知道签收版本'],
  )
  const platforms = ['weixin', 'dingtalk', 'feishu'] as const
  const bots = platforms.map((platform) => ({
    platform,
    channelId: `${platform}-test`,
    operatorId: 'reader',
    peerId: 'peer',
    label: '测试私聊',
  }))
  const calls: { platform: string; text: string; id: string; presentation?: RouterPresentation }[] =
    []
  let recovered = false
  const denied = async (): Promise<never> => {
    throw Error('Unexpected real channel')
  }
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: denied,
    weixin: { listTargets: () => [], send: denied },
    personal: {
      listPersonalBots: () => bots.map((b) => ({ ...b, online: true })),
      listPersonalTargets: () => bots,
      listPersonalDirectTargets: () => bots,
      sendPersonal: denied,
      async sendDirect(target, text, id, _signal, maySend, presentation) {
        assert(maySend())
        calls.push({ platform: target.platform, id, text, presentation })
        if (target.platform === 'dingtalk' && !recovered)
          return { status: 'rejected', reason: '测试平台暂不可用' }
        return { status: 'accepted', receipt: `${target.platform}-receipt-${calls.length}` }
      },
    },
  })
  const config = routing.getConfig()
  routing.saveConfig(
    {
      ...config.settings,
      enabled: true,
      personalBots: Object.fromEntries(bots.map((b) => [b.platform, b.channelId])),
      duringWork: 'defer',
      afterWork: 'defer',
      offDay: 'defer',
      presence: 'away',
    },
    config.revision,
  )
  for (const bot of bots) assert(routing.claimRouterImTarget(bot))
  const ask = createRouterAgent({
    ...deps,
    modelRouter: {
      getDefaultModel: () => deps.modelRouter.getDefaultModel(),
      getCurrentModel: () => deps.modelRouter.getCurrentModel(),
      trace: createRouterTraceSink(store.ledger, (t) => deps.secretFilter.filter(t)),
    },
  })
  const written: { key: string; title: string; body: string }[] = []
  const documents = new RouterDocuments(store.ledger, {
    probeArchive: async () => ({ ok: true, reason: '可写' }),
    async appendDocument(_target, key, title, body, _signal, authorized) {
      assert(authorized())
      written.push({ key, title, body })
      return { status: 'accepted', receipt: 'sample-document-write' }
    },
  })
  const docUrl = 'https://example.feishu.cn/docx/Q17archive'
  await documents.configure('router-owner', {
    id: 'sample',
    documentId: 'Q17archive',
    channelId: 'feishu-test',
    label: '样稿验收册',
    url: docUrl,
  })
  const service = new RouterWorkspaceService(store, routing, ask, {
    principalFor: () => 'router-owner',
    agentIntake: true,
    documents,
  })
  service.start()
  try {
    const objective =
      '样稿已签收，最终版是 Q17，保留蓝色封面。请把结果存入样稿验收册，再把文档链接和签收结论通知给我。'
    const key = crypto.randomUUID()
    await service.message('general', key, objective)
    const [publication] = store.ledger.publications.list('router-owner', matter.id)
    assert(publication)
    assert.equal(written.length, 1)
    assert(written[0].body.includes('Q17') && written[0].body.includes('蓝'))
    assert.equal(store.ledger.operations.get('router-owner', written[0].key)?.state, 'accepted')
    assert(publication.deliveries.every((d) => d.presentation.text.includes(docUrl)))
    assert.deepEqual(Object.fromEntries(publication.deliveries.map((d) => [d.channel, d.status])), {
      web: 'accepted',
      feishu: 'accepted',
      weixin: 'accepted',
      dingtalk: 'rejected',
    })
    const failedAttempts = calls.filter((c) => c.platform === 'dingtalk').length
    assert(failedAttempts >= 1 && calls.length === failedAttempts + 2)
    const priorCalls = calls.length
    assert(publication.deliveries.every((d) => d.presentation.text.includes('Q17')))
    const initial = publication.deliveries.map((d) => ({
      platform: d.channel,
      status: d.status,
      attempt: d.attempt,
      receipt: d.receipt,
    }))
    recovered = true
    await service.message(
      'general',
      crypto.randomUUID(),
      '刚才失败的那一端已经恢复，请把原来的那条通知补发给我。',
    )
    const final = store.ledger.publications.get('router-owner', publication.id)
    assert(final)
    const evidence = {
      publication: publication.id,
      matter: matter.id,
      document: {
        url: docUrl,
        writes: written,
        operation: store.ledger.operations.get('router-owner', written[0].key),
      },
      initial,
      after: final.deliveries.map((d) => ({
        channel: d.channel,
        status: d.status,
        attempt: d.attempt,
        receipt: d.receipt,
      })),
      calls: calls.map((c) => ({ platform: c.platform, id: c.id, text: c.text })),
      runs: store.ledger.conversationRuns(
        'router-general',
        store.conversations.list('general').map((t) => t.id),
      ).size,
    }
    writeFileSync(join(output, 'platform-retry.json'), JSON.stringify(evidence, null, 2))
    assert.equal(store.ledger.publications.list('router-owner', matter.id).length, 1)
    assert.equal(written.length, 1)
    assert.deepEqual(
      calls.slice(priorCalls).map((c) => c.platform),
      ['dingtalk'],
    )
    assert(
      final.deliveries.every(
        (d) =>
          d.status === 'accepted' &&
          d.attempt === (d.channel === 'dingtalk' ? failedAttempts + 1 : 1),
      ),
    )
    assert.equal(
      final.deliveries.find((d) => d.channel === 'dingtalk')?.presentation.text,
      publication.deliveries.find((d) => d.channel === 'dingtalk')?.presentation.text,
    )
  } finally {
    await service.close()
    await routing.close()
    store.close()
  }
}
