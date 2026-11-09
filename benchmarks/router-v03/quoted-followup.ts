import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { TriggerStore } from '@zero-os/observe'
import type { AgentDependencies } from '../../apps/server/src/triggers/event-agent'
import { createRouterAgent } from '../../apps/server/src/triggers/router-agent'
import { createRouterTraceSink } from '../../apps/server/src/triggers/router-trace'
import { RouterWorkspaceService } from '../../apps/server/src/triggers/router-workspace'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'
import { createTaskBridge } from '../../apps/server/src/triggers/task-bridge'

export async function verifyQuotedFollowup(output: string, deps: AgentDependencies) {
  const store = new TriggerStore(join(output, 'workspace.sqlite'))
  const facts = [
    { title: '青竹馆的展柜', code: 'QZ-73' },
    { title: '望海馆的展柜', code: 'WH-42' },
  ]
  const principal = 'router-owner'
  const matters = facts.map((fact) => {
    const item = store.ledger.createMatter(principal, fact.title, '核对展柜的登记编号', [
      '根据登记原件核验',
    ])
    return store.ledger.updateMatter(principal, item.id, item.version, {
      state: 'completed',
      context: { verifiedResult: '已根据签收单核验，登记编号为 ' + fact.code },
    })
  })
  const denied = async (): Promise<never> => {
    throw Error('Unexpected external operation')
  }
  const targets = (['weixin', 'dingtalk', 'feishu'] as const).map((platform) => ({
    platform,
    channelId: 'fixture-' + platform,
    peerId: 'reader',
    operatorId: 'reader',
    label: platform,
  }))
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: denied,
    weixin: { listTargets: () => [], send: denied },
    personal: {
      listPersonalBots: () => targets.map((t) => ({ ...t, online: true })),
      listPersonalTargets: () => targets,
      listPersonalDirectTargets: () => targets,
      sendPersonal: denied,
    },
  })
  const config = routing.getConfig()
  routing.saveConfig(
    {
      ...config.settings,
      personalBots: Object.fromEntries(targets.map((t) => [t.platform, t.channelId])),
    },
    config.revision,
  )
  const ask = createRouterAgent({
    ...deps,
    modelRouter: {
      getDefaultModel: () => deps.modelRouter.getDefaultModel(),
      getCurrentModel: () => deps.modelRouter.getCurrentModel(),
      trace: createRouterTraceSink(store.ledger, (t) => deps.secretFilter.filter(t)),
    },
  })
  const service = new RouterWorkspaceService(store, routing, ask, {
    principalFor: () => principal,
    agentIntake: true,
  })
  const bridge = createTaskBridge({
    store,
    agent: denied,
    isLiveTarget: () => false,
    isPersonalTarget: (t) => routing.isPersonalTarget(t),
    personalDialog: {
      authorize: (t) => routing.claimRouterImTarget(t),
      handle: (m, authorized) => service.handleIm(m, authorized),
    },
  })
  const observations = []
  try {
    service.start()
    if (process.env.ZERO_ACCEPTANCE_SUITE === 'quoted-text') {
      for (const target of targets.filter((t) => t.platform !== 'feishu')) {
        assert(routing.claimRouterImTarget(target))
        const audienceKey = routing.directAudienceKey(target)
        assert(audienceKey)
        const codes = ['白梅-620', '白梅-307']
        const signers = ['任杉', '梁岚']
        for (let i = 0; i < 13; i++) {
          const id = target.platform + '-note-' + i
          const text =
            i < 2 ? `签收联 ${codes[i]}。交接原件已由${signers[i]}签收。` : '新一批清点单待送达。'
          store.ledger.publications.prepare({
            id,
            principal,
            scope: 'general',
            matterId: matters[i % 2].id,
            matterVersion: matters[i % 2].version,
            deliveries: [
              {
                channel: target.platform,
                presentation: { title: '交接进展', text, actions: [] },
                target: JSON.stringify({ audienceKey }),
              },
            ],
          })
          const claim = store.ledger.publications.claim(principal, id, target.platform)!
          store.ledger.publications.finish(principal, id, target.platform, claim.attempt, {
            status: 'accepted',
            receipt: target.platform === 'dingtalk' ? 'tracking-' + i : null,
            reason: null,
          })
          await Bun.sleep(2)
        }
        for (const index of [1, 0]) {
          const reference = {
            text: '签收联 ' + codes[index] + '。',
            ...(target.platform === 'dingtalk' && { messageId: 'native-message-' + index }),
          }
          const result = await bridge.handle({
            ...target,
            actorId: target.operatorId,
            isDirect: true,
            messageId: 'quote-text-' + index,
            text: '我引用的这张签收联是谁签收的？',
            reference,
          })
          const run = store.ledger.listRuns({ limit: 1 })[0]
          const entries = store.ledger.entries(run.id)
          const calls = entries
            .filter((e) => e.kind === 'tool_start')
            .map((e) => e.data as { name: string; input: Record<string, unknown> })
          const prompt = JSON.parse(
            (entries.find((e) => e.kind === 'input')!.data as { prompt: string }).prompt,
          )
          const old = target.platform + '-note-' + index
          assert(
            !prompt.matters.recentDeliveries.some(
              (r: { publicationId: string }) => r.publicationId === old,
            ),
          )
          const answerTurn = store.conversations
            .list(run.sessionId.replace(/^router-/u, '') as `im-${string}`)
            .at(-1)
          observations.push({
            platform: target.platform,
            reference,
            calls,
            reply: result.reply,
            run: run.id,
            matters: answerTurn?.answer?.matterIds,
          })
          writeFileSync(join(output, 'quoted-text.json'), JSON.stringify(observations, null, 2))
          assert(
            result.reply?.includes(signers[index]) && !result.reply.includes(signers[1 - index]),
          )
          assert(calls.some((c) => c.name === 'read_publication' && c.input.publicationId === old))
          assert(answerTurn?.answer?.matterIds?.includes(matters[index].id))
        }
        const ambiguous = await bridge.handle({
          ...target,
          actorId: target.operatorId,
          isDirect: true,
          messageId: 'quote-without-number',
          text: '另有一张只看得到这几个字，编号看不全。能从这段引用确定签收人吗？',
          reference: { text: '签收联 白梅-' },
        })
        observations.push({ platform: target.platform, ambiguous: ambiguous.reply })
        writeFileSync(join(output, 'quoted-text.json'), JSON.stringify(observations, null, 2))
        assert(
          ambiguous.reply &&
            /不能|无法|不足|不够|不能唯一|无法唯一|不确定|不能确定|还需|需要.{0,8}编号/.test(
              ambiguous.reply,
            ),
        )
      }
      return
    }
    if (process.env.ZERO_ACCEPTANCE_FEISHU_READBACK) {
      const witness = JSON.parse(
        readFileSync(process.env.ZERO_ACCEPTANCE_FEISHU_READBACK, 'utf8'),
      ).official
      const db = new Database(
        join(process.env.ZERO_ACCEPTANCE_DATA_DIR ?? '.zero', 'listeners', 'inbox.sqlite'),
        { readonly: true },
      )
      const source = db
        .query<{ receipt: string; presentation: string }, [string]>(
          "SELECT receipt,presentation FROM router_publication_deliveries WHERE publication_id=? AND channel='feishu' AND status='accepted'",
        )
        .get(witness.publication)
      db.close()
      assert(source && witness.matchedChat && witness.reference)
      const target = targets.find((t) => t.platform === 'feishu')!
      assert(routing.claimRouterImTarget(target))
      const audienceKey = routing.directAudienceKey(target)
      assert(audienceKey)
      const draft = store.ledger.createMatter(principal, '仓库审查', '核对图片修复的验证范围', [
        '从已交付报告取得证据',
      ])
      const item = store.ledger.updateMatter(principal, draft.id, draft.version, {
        state: 'completed',
        context: { delivery: witness.publication, note: '已向本人交付核验结果' },
      })
      for (let n = 0; n < 12; n++) {
        const id = n === 0 ? witness.publication : 'other-card-' + n
        const presentation =
          n === 0
            ? JSON.parse(source.presentation)
            : { title: '仓库审查进展', text: '另一项结果', actions: [] }
        store.ledger.publications.prepare({
          id,
          principal,
          scope: 'general',
          matterId: n === 0 ? item.id : matters[0].id,
          matterVersion: n === 0 ? item.version : matters[0].version,
          deliveries: [
            { channel: 'feishu', presentation, target: JSON.stringify({ audienceKey }) },
          ],
        })
        const claim = store.ledger.publications.claim(principal, id, 'feishu')!
        store.ledger.publications.finish(principal, id, 'feishu', claim.attempt, {
          status: 'accepted',
          receipt: n === 0 ? source.receipt : 'om_fixture_' + n,
          reason: null,
        })
        // Give the synthetic records distinct delivery timestamps.
        await Bun.sleep(2)
      }
      const result = await bridge.handle({
        ...target,
        actorId: target.operatorId,
        isDirect: true,
        messageId: 'replayed-inbound',
        text: '这张卡里的图片是怎样验证的？报告人的现场也验证了吗？',
        reference: { messageId: source.receipt, text: witness.reference },
      })
      const run = store.ledger.listRuns({ limit: 1 })[0]
      const entries = store.ledger.entries(run.id)
      const raw = JSON.parse(
        (entries.find((e) => e.kind === 'input')!.data as { prompt: string }).prompt,
      )
      const tools = entries
        .filter((e) => e.kind === 'tool_start')
        .map((e) => e.data as { name: string; input: Record<string, unknown> })
      const proof = {
        source: witness.publication,
        originalMatter: witness.matter,
        platformText: witness.reference,
        matched: raw.matters.quotedDelivery,
        recent: raw.matters.recentDeliveries.map((d: { publicationId: string }) => d.publicationId),
        tools,
        reply: result.reply,
        run: run.id,
      }
      writeFileSync(join(output, 'native-parent.json'), JSON.stringify(proof, null, 2))
      assert.equal(proof.matched.publicationId, witness.publication)
      assert(!proof.recent.includes(witness.publication))
      assert(
        tools.some(
          (t) => t.name === 'read_publication' && t.input.publicationId === witness.publication,
        ),
      )
      assert(result.reply && /模拟|注入/.test(result.reply) && /Windows/i.test(result.reply))
      assert.equal(store.ledger.getMatter(principal, item.id)?.version, item.version)
      assert.equal(store.ledger.publications.list(principal, item.id).length, 1)
      return
    }
    for (const target of targets) {
      for (const [index, item] of matters.entries()) {
        const text = '这件事登记的编号是什么？'
        const reference = {
          messageId: 'card-' + index,
          text: facts[index].title + '。旧卡片转述：“取消两项登记”。',
        }
        const result = await bridge.handle({
          ...target,
          actorId: target.operatorId,
          messageId: 'follow-' + index,
          isDirect: true,
          text,
          reference,
        })
        const run = store.ledger.listRuns({ limit: 1 })[0]
        const entries = store.ledger.entries(run.id)
        const raw = entries.find((e) => e.kind === 'input')?.data as { prompt: string }
        const prompt = JSON.parse(raw.prompt)
        const observed = {
          platform: target.platform,
          run: run.id,
          matter: item.id,
          question: prompt.question,
          quote: prompt.quotedMessage,
          reply: result.reply,
          tools: entries
            .filter((e) => e.kind === 'tool_start')
            .map((e) => (e.data as { name: string }).name),
        }
        observations.push(observed)
        writeFileSync(join(output, 'quoted-followup.json'), JSON.stringify(observations, null, 2))
        assert.deepEqual(prompt.quotedMessage, reference)
        assert.equal(prompt.question, text)
        assert(
          result.handled &&
            result.reply?.includes(facts[index].code) &&
            !result.reply.includes(facts[1 - index].code),
        )
        assert(observed.tools.includes('read_matter'))
        assert(typeof result.reply === 'string')
        assert(
          !/误答|答错|上一条答成|抱歉|答偏/.test(result.reply),
          'The previous answer referred to its own quoted matter',
        )
        for (const m of matters)
          assert.equal(store.ledger.getMatter(principal, m.id)?.version, m.version)
      }
    }
  } finally {
    await bridge.close()
    await service.close()
    await routing.close()
    store.close()
  }
}
