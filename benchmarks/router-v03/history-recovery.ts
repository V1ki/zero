import { captureProvider } from './provider-witness'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TriggerStore } from '@zero-os/observe'
import type { AgentDependencies } from '../../apps/server/src/triggers/event-agent'
import { createRouterAgent } from '../../apps/server/src/triggers/router-agent'
import { createRouterTraceSink } from '../../apps/server/src/triggers/router-trace'
import { RouterWorkspaceService } from '../../apps/server/src/triggers/router-workspace'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'

/** A real model in a restarted workspace. All sources and grants below are fixtures. */
export async function verifyHistoryRecovery(
  output: string,
  deps: AgentDependencies,
  oversized = false,
) {
  const seal = crypto.randomUUID().slice(0, 8)
  const file = join(output, 'workspace.sqlite')
  assert(!existsSync(file), 'Use a fresh isolated output directory')
  const initial = new TriggerStore(file)
  const scope = 'general'
  const sourceIds: number[] = []
  const matter = initial.ledger.createMatter(
    scope,
    '图像丢失的复现材料',
    '核对复现材料并给出处理建议',
    ['按最新授权处理'],
  )
  const other = initial.ledger.createMatter(scope, '图像显示的样式', '核对样式并调整展示', [
    '核实排版',
  ])
  let lastSource = 0
  try {
    function save(question: string, matterId?: string, revoked = false, text = '已记录') {
      const key = crypto.randomUUID()
      const input = initial.conversations.begin(scope, key, question)
      assert(input.kind === 'started')
      assert(
        initial.conversations.finish(scope, key, input.attempt, {
          text,
          matterIds: matterId ? [matterId] : [],
          ...(revoked && { workAccess: { github: true, key: 'revoked-fixture' } }),
        }),
      )
      return input.turn.id
    }
    sourceIds.push(save('图像丢失的材料标签是 P4，可公开评论。原文件只读。', matter.id))
    if (oversized) {
      const inventory = Array.from(
        { length: 4000 },
        (_, i) => `签收清册第 ${i + 1} 行，记录已归档。`,
      ).join('\n')
      sourceIds.push(
        save('核对图像材料的签收清册。', matter.id, false, inventory + '\n最终封签号 ' + seal),
      )
    }
    lastSource = save(
      '更正上一条：现在的标签是 Q7。撤回公开评论授权，结果只供我核对。原文件仍须保留。',
      matter.id,
    )
    sourceIds.push(lastSource)
    initial.ledger.updateMatter(scope, matter.id, 1, {
      state: 'waiting',
      context: { sourceTurns: sourceIds, next: '取回更正后的材料标签与操作范围' },
    })
    save('图像样式校验的参考标识是 S9。', other.id)
    // This answer predates the removal of its repository grant.
    save('受限资料 HIDDEN-GRANT-38', matter.id, true)
    for (let i = 0; i < 24; i++) save('其他日常话题 ' + (i + 1))
    if (oversized)
      save(
        '昨日的排版样本清单',
        other.id,
        false,
        Array.from({ length: 4600 }, (_, i) => `无关排版校样第 ${i} 行，待录入。`).join('\n'),
      )
  } finally {
    initial.close()
  }

  const store = new TriggerStore(file)
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: async () => {
      throw Error('Unexpected event analysis')
    },
    weixin: {
      listTargets: () => [],
      send: async () => {
        throw Error('Unexpected delivery')
      },
    },
  })
  const witness = captureProvider(
    deps,
    oversized ? { maxContext: 18000, maxOutput: 1800 } : undefined,
  )
  const ask = createRouterAgent({
    ...deps,
    modelRouter: {
      getDefaultModel: () => witness.model,
      getCurrentModel: () => witness.model,
      trace: createRouterTraceSink(store.ledger, (s) => deps.secretFilter.filter(s)),
    },
  })
  const service = new RouterWorkspaceService(store, routing, ask)
  try {
    service.start()
    const key = crypto.randomUUID()
    await service.message(
      scope,
      key,
      '接着图像丢失那件事：我要拿哪份复现材料核对？原文件和对外答复分别该怎么处理？请附上更正来自哪条记录。' +
        (oversized ? '还请从当时的签收清册中找到“最终封签号”，把号码一起给我。' : ''),
    )
    const saved = store.conversations.get(scope, key)
    const run = store.ledger.listRuns({ sessionId: 'router-general', limit: 1 })[0]
    const entries = store.ledger.entries(run.id)
    const requests = entries.filter((e) => e.kind === 'model_request')
    const tools = entries
      .filter((e) => e.kind === 'tool_start')
      .map((e) => (e.data as { name: string }).name)
    const reply = saved?.answer?.text ?? ''
    const proof = {
      mode: 'real-model-isolated-workspace',
      goal: matter.id,
      similarMatter: other.id,
      sourceIds,
      lastSource,
      runId: run.id,
      providerWitness: witness.compare(store.ledger, run.sessionId, entries),
      toolNames: tools,
      reply,
      requests: requests.length,
      initialWindowExcludesOldSource: !JSON.stringify(requests[0]?.data).includes('Q7'),
      laterRequestContainsCorrection: requests
        .slice(1)
        .some((e) => JSON.stringify(e.data).includes('Q7')),
      hiddenMaterialExcluded: !JSON.stringify(requests).includes('HIDDEN-GRANT-38'),
      ...(oversized && {
        projections: requests.flatMap(
          (entry) => (entry.data as { projection?: unknown }).projection ?? [],
        ),
        seal,
      }),
    }
    writeFileSync(join(output, 'observations.json'), JSON.stringify(proof, null, 2))
    assert(
      proof.initialWindowExcludesOldSource &&
        proof.laterRequestContainsCorrection &&
        proof.hiddenMaterialExcluded,
    )
    assert(
      tools.includes('read_conversation') &&
        !tools.includes('publish_update') &&
        !tools.includes('send_personal_reminder'),
    )
    if (oversized) {
      writeFileSync(
        join(output, 'trace-browser.json'),
        JSON.stringify({ run, entries, nextAfter: null }),
      )
      assert(proof.projections?.length && tools.includes('read_context_excerpt'))
      assert(
        (requests[0].data as { projection?: { historyMessages: string[] } }).projection
          ?.historyMessages.length,
      )
      assert(
        reply.includes(seal) &&
          reply.includes(String(lastSource)) &&
          /只读|保留原件|原文件.*保留/.test(reply),
      )
      assert(/仅供|只供|撤回|不对外|不.*公开|只给/.test(reply))
    }
    assert(reply.includes('Q7') && !reply.includes('S9'))
    console.log(JSON.stringify(proof))
  } finally {
    await service.close()
    await routing.close()
    store.close()
  }
}

/** The initial decisions, correction, unrelated turns and resumed lookup all enter through the workbench. */
export async function verifyNaturalHistory(output: string, deps: AgentDependencies) {
  const file = join(output, 'workspace.sqlite')
  assert(!existsSync(file))
  function open() {
    const store = new TriggerStore(file)
    const denied = async (): Promise<never> => {
      throw Error('Unexpected external effect')
    }
    const routing = new TriggerRoutingRuntime(store.routing, {
      analyze: denied,
      weixin: { listTargets: () => [], send: denied },
    })
    const agent = createRouterAgent({
      ...deps,
      modelRouter: {
        ...deps.modelRouter,
        trace: createRouterTraceSink(store.ledger, (s) => deps.secretFilter.filter(s)),
      },
    })
    const service = new RouterWorkspaceService(store, routing, agent, {
      agentIntake: true,
      principalFor: () => 'router-owner',
    })
    service.start()
    return {
      store,
      service,
      close: async () => {
        await service.close()
        await routing.close()
        store.close()
      },
    }
  }
  const ask = (text: string) => runtime.service.message('general', crypto.randomUUID(), text)
  let runtime = open()
  try {
    await ask(
      '跟进蓝封样册的损伤核查：材料标签 Z2，保留只读原件，可向项目组交付。等我上传实物照片后再判断损伤，只在网页回复。',
    )
    const m = runtime.store.ledger.searchMatters('router-owner')[0]
    assert(m)
    const correction = await ask(
      '更正蓝封样册的决定：标签应为 Q7；撤回对项目组的交付许可，只给我本人看，原件只读。我在修订记录中用的原话是「先保蓝封」。照片还没有上传。',
    )
    const correctedTurn = correction.turns.at(-1)!.id
    await ask(
      '另外跟进红封样册的排版，标签 S9，等排版校样后再定行距。这个目标独立于蓝封的损伤核查。',
    )
    const filler = [
      '帮我把“下次见”换种说法。',
      '鲸属于鱼类吗？',
      '把“门已关好”译成英文。',
      '十二减三是多少？',
      '如何读“珩”？',
      '五毫米是多少厘米？',
      '给“窗”写个短句。',
      '“余晖”指什么？',
      '列两个表示安静的词。',
      '英文 Friday 是星期几？',
      '七个十是多少？',
      '给“露水”写一句描述。',
      '“稀疏”的反义词是什么？',
      '一个半小时是多少分钟？',
      '简短解释什么是回声。',
      '将“请进”译成英文。',
      '正方形的四条边有什么关系？',
      '二十一除以三等于多少？',
      '给“海边”造句。',
      '“翌日”是什么意思？',
      '今天的日常话题到此，回一句“收到”即可。',
    ]
    assert(filler.length > 20)
    for (const question of filler) await ask(question)
    const before = runtime.store.ledger.getMatter('router-owner', m.id)
    await runtime.close()
    runtime = open()
    assert.deepEqual(runtime.store.ledger.getMatter('router-owner', m.id), before)
    const result = await ask(
      '继续核对之前有损伤问题的那本样册：请找回我更正时那句四字原话、材料标签、原件处理和交付范围，并说明照片到底能证明哪种损伤。引用当时的对话编号。',
    )
    const answer = result.turns.at(-1)?.answer?.text ?? ''
    const run = runtime.store.ledger.listRuns({ sessionId: 'router-general' })[0]
    const entries = runtime.store.ledger.entries(run.id)
    const request = entries.find((e) => e.kind === 'input')?.data as {
      history: unknown
      prompt: string
    }
    const prompt = JSON.parse(request.prompt)
    const tools = entries
      .filter((e) => e.kind === 'tool_start')
      .map((e) => (e.data as { name: string }).name)
    const proof = {
      mode: 'isolated-real-model-normal-history',
      matter: m.id,
      correctedTurn,
      insertedTurns: filler.length,
      run: run.id,
      historyIds: prompt.contextProvenance.historyTurnIds,
      earlierOmitted: prompt.contextProvenance.olderHistoryOmitted,
      tools,
      answer,
      context: runtime.store.ledger.getMatter('router-owner', m.id),
    }
    writeFileSync(join(output, 'natural-history.json'), JSON.stringify(proof, null, 2))
    assert(proof.earlierOmitted && !proof.historyIds.includes(correctedTurn))
    assert(
      !JSON.stringify(request.history).includes('先保蓝封') && tools.includes('read_conversation'),
    )
    assert(answer.includes('先保蓝封') && answer.includes('Q7') && !answer.includes('S9'))
    assert(answer.includes(String(correctedTurn)) && /只读|只读原件|不改动|保留原件/.test(answer))
    assert(/本人|只给你|仅给你|仅供你/.test(answer) && /没|未|无法/.test(answer))
    assert(runtime.store.ledger.getMatter('router-owner', m.id)?.state !== 'completed')
  } finally {
    await runtime.close()
  }
}

/** A native workspace card outlives the latest web page and the model's working history. */
export async function verifyHistoricalButton(output: string, deps: AgentDependencies) {
  const file = join(output, 'card.sqlite')
  assert(!existsSync(file))
  const store = new TriggerStore(file)
  const denied = async (): Promise<never> => {
    throw Error('Unexpected external operation')
  }
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: denied,
    weixin: { listTargets: () => [], send: denied },
  })
  const agent = createRouterAgent({
    ...deps,
    modelRouter: {
      getDefaultModel: () => deps.modelRouter.getDefaultModel(),
      getCurrentModel: () => deps.modelRouter.getCurrentModel(),
      trace: createRouterTraceSink(store.ledger, (text) => deps.secretFilter.filter(text)),
    },
  })
  const service = new RouterWorkspaceService(store, routing, agent, {
    agentIntake: true,
    principalFor: () => 'router-owner',
  })
  try {
    const { createRouterUICapability } = await import(
      '../../apps/server/src/triggers/router-ui-capability'
    )
    const label = '读出原卡回单上的签收号'
    const seal = 'JH-' + crypto.randomUUID().slice(0, 8)
    const ui = createRouterUICapability()
    await ui.tool.execute(
      {
        components: [
          { id: 'root', component: 'Column', children: ['note', 'read'] },
          { id: 'note', component: 'Text', text: '收货回单' },
          { id: 'label', component: 'Text', text: label },
          {
            id: 'read',
            component: 'Button',
            child: 'label',
            action: { event: { name: 'router_input' } },
          },
        ],
        data: {},
        actions: { read: { instruction: label } },
      },
      new AbortController().signal,
    )
    const card = ui.get()
    assert(card)
    const old = store.conversations.begin('general', 'receipt', '核对周二那批货的签收号。')
    assert(old.kind === 'started')
    store.conversations.finish('general', 'receipt', old.attempt, {
      text: '原件记录的签收号为 ' + seal + '。',
      generatedUI: card,
    })
    for (let i = 0; i < 60; i++) {
      const claim = store.conversations.begin('general', 'later-' + i, '其他批次的签收进展')
      assert(claim.kind === 'started')
      store.conversations.finish('general', claim.turn.requestId, claim.attempt, {
        text: '另一批货的签收号为 JH-f0e19372。',
      })
    }
    service.start()
    assert(!service.get('general').turns.some((t) => t.id === old.turn.id))
    const source = service.get('general', old.turn.id).turns.at(-1)
    assert(source?.surface)
    const clicked = await service.action('general', crypto.randomUUID(), {
      version: source.surface[0].version,
      action: {
        name: 'router_input',
        surfaceId: source.surface[0].createSurface.surfaceId,
        sourceComponentId: 'read',
        context: {},
        timestamp: new Date().toISOString(),
      },
    })
    const answer = clicked.turns.at(-1)?.answer
    const run = store.ledger.listRuns({ limit: 1 })[0],
      entries = store.ledger.entries(run.id)
    const tools = entries
      .filter((e) => e.kind === 'tool_start')
      .map((e) => e.data as { name: string; input: Record<string, unknown> })
    writeFileSync(
      join(output, 'historical-button.json'),
      JSON.stringify(
        { oldTurn: old.turn.id, run: run.id, tools, seal, answer: answer?.text },
        null,
        2,
      ),
    )
    assert(answer?.text.includes(seal) && !answer.text.includes('JH-f0e19372'))
    assert(tools.some((t) => t.name === 'read_conversation'))
  } finally {
    await service.close()
    await routing.close()
    store.close()
  }
}
