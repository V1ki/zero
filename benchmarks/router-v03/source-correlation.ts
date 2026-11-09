import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TriggerStore } from '@zero-os/observe'
import type { AgentDependencies } from '../../apps/server/src/triggers/event-agent'
import { createRouterAgent } from '../../apps/server/src/triggers/router-agent'
import { RouterJobs } from '../../apps/server/src/triggers/router-jobs'
import { RouterJobPrincipals } from '../../apps/server/src/triggers/router-job-principal'
import { createRouterTraceSink } from '../../apps/server/src/triggers/router-trace'
import { RouterWorkspaceService } from '../../apps/server/src/triggers/router-workspace'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'
import { createTaskBridge } from '../../apps/server/src/triggers/task-bridge'

export async function verifySourceCorrelation(output: string, deps: AgentDependencies) {
  const store = new TriggerStore(join(output, 'workspace.sqlite'))
  store.useAgentIntake()
  const operator = 'router-owner'
  const repo = 'example/field-station'
  const actor = {
    platform: 'weixin' as const,
    channelId: 'lab',
    peerId: 'owner',
    operatorId: 'owner',
    label: '验收',
  }
  const denied = async (): Promise<never> => {
    throw Error('Unexpected external operation')
  }
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: denied,
    weixin: { listTargets: () => [], send: denied },
    personal: {
      listPersonalBots: () => [{ ...actor, online: true }],
      listPersonalTargets: () => [actor],
      listPersonalDirectTargets: () => [actor],
      sendPersonal: async () => ({ status: 'accepted', receipt: 'fixture' }),
    },
  })
  const config = routing.getConfig()
  routing.saveConfig(
    { ...config.settings, personalBots: { weixin: actor.channelId } },
    config.revision,
  )
  const rev = store.saveSettings(
    {
      github: {
        credentialRef: 'github_listener_fixture',
        routerOperators: [actor],
        repositories: [
          {
            name: repo,
            enabled: true,
            issues: true,
            pullRequests: true,
            issueComments: true,
            pullRequestComments: true,
            workflowFailures: false,
            workflow: '',
            branch: '',
            mention: '',
          },
        ],
      },
      wxarc: { sessions: [] },
    },
    0,
  )
  const principals = new RouterJobPrincipals(store, { accessKey: () => 'fixture' })
  const alpha = store.ledger.createMatter(operator, '交接核对', '核对K7样品箱封条与本人签收记录', [
    '封条、对应照片及本人签收回执齐备',
  ])
  const beta = store.ledger.createMatter(operator, '交接核对', '核对M2冰箱温度记录', [
    '温度实测与仪表校准报告齐备',
  ])
  const ask = createRouterAgent({
    ...deps,
    modelRouter: {
      ...deps.modelRouter,
      trace: createRouterTraceSink(store.ledger, (s) => deps.secretFilter.filter(s)),
    },
  })
  const triage = process.env.ZERO_ACCEPTANCE_SUITE === 'value-triage'
  const evidenceFile = join(output, 'weighing.json')
  const measurements = { sample: 'L3', grossGrams: 420, tareGrams: 90 }
  if (triage) writeFileSync(evidenceFile, JSON.stringify(measurements))
  const executions: number[] = []
  const jobs = triage
    ? new RouterJobs(store.jobs, {
        authorized: principals.authorized.bind(principals),
        execute: async (job) => {
          executions.push(job.id)
          const report = readFileSync(evidenceFile, 'utf8')
          return { result: '计量员的原始读数：' + report, threadId: 'scale-record-reader' }
        },
        completed: async (job) => {
          const link = store.ledger.workerLink(job.id)
          assert(link)
          store.ledger.receiveSignal({
            key: `worker:${job.id}:${job.attempt}`,
            principal: operator,
            kind: 'worker_result',
            scope: 'general',
            payload: {
              matterId: link.matterId,
              jobId: job.id,
              attempt: job.attempt,
              status: job.status,
            },
          })
          service.notifySignals()
          return 'delivered'
        },
      })
    : undefined
  const service = new RouterWorkspaceService(store, routing, ask, {
    principalFor: (a) => (a === 'web' || a.operatorId === 'owner' ? operator : null),
    principals,
    delegatedJobs: jobs,
    agentIntake: true,
    investigator: {
      available: () => ['inspect_github'],
      inspect: async (e) => ({
        kind: e.url?.includes('/pull/') ? 'pull' : 'issue',
        sourceUrl: e.url!,
        observedAt: e.occurredAt,
        facts: [
          { label: '原记录', value: e.summary },
          ...(triage && e.url?.endsWith('/issues/95')
            ? [{ label: '计量员的原始记录', value: readFileSync(evidenceFile, 'utf8') }]
            : []),
        ],
      }),
    },
  })
  const bridge = createTaskBridge({
    store,
    agent: denied,
    isLiveTarget: () => false,
    isPersonalTarget: (t) => routing.isPersonalTarget(t),
    personalDialog: {
      authorize: (t) => routing.claimRouterImTarget(t),
      handle: (m, a) => service.handleIm(m, a),
    },
  })
  async function push(url: string, text: string, key: string) {
    assert(
      store.commitPush({
        source: 'github',
        stream: 'github:' + repo,
        revision: rev,
        events: [
          {
            eventId: key,
            scope: repo,
            url: `https://github.com/${repo}/${url}`,
            title: '交接核对 · 新记录',
            summary: text,
            occurredAt: new Date().toISOString(),
          },
        ],
      }),
    )
    const event = store.listInbox()[0]
    service.notifySignals()
    const end = Date.now() + 180_000
    while (Date.now() < end) {
      const input = store.ledger
        .listSignals(operator)
        .find((s) => s.kind === 'event' && s.scope === String(event.id))
      if (input && !['pending', 'running'].includes(input.state)) {
        assert.equal(input.state, 'completed', input.error ?? 'signal')
        return event.id
      }
      await Bun.sleep(150)
    }
    throw Error('Event not completed')
  }
  try {
    service.start()
    if (triage) {
      const thanks = await push('issues/81#issuecomment-81', '收到，谢谢！', 'thanks-81')
      assert.equal(
        store.ledger.searchMatters(operator).length,
        2,
        'An acknowledgement created additional work',
      )
      assert.equal(executions.length, 0, 'An acknowledgement dispatched a Worker')
      assert.equal(
        store.ledger.publications.list(operator).length,
        0,
        'An acknowledgement notified the owner',
      )
      const thankTurn = store.conversations.list(thanks).at(-1)
      assert(thankTurn?.answer)
      const small = await push(
        'issues/95',
        '请核对计量员上传的 L3 样品净重是多少克，在这件事的网页留下结论。',
        'weight-95',
      )
      const until = Date.now() + 180_000
      let smallText = ''
      while (Date.now() < until) {
        smallText = [
          ...store.conversations.list(small).map((t) => t.answer?.text ?? ''),
          ...store.ledger.publications
            .list(operator)
            .flatMap((p) =>
              p.deliveries
                .filter((d) => d.channel === 'web' && d.status === 'accepted')
                .map((d) => d.presentation.text),
            ),
        ].join('\n')
        if (smallText.includes('330')) break
        await Bun.sleep(200)
      }
      assert(smallText.includes('330'), 'The check did not deliver the measured net weight')
      const requested = await service.message(
        'general',
        crypto.randomUUID(),
        '把我的 Router 在场状态改成“在场”。现在生效。',
      )
      assert.equal(routing.getConfig().settings.presence, 'present')
      const traces = store.ledger.listRuns({ limit: 30 }).map((r) => ({
        id: r.id,
        session: r.sessionId,
        status: r.status,
        calls: store.ledger
          .entries(r.id)
          .filter((e) => e.kind === 'tool_start')
          .map((e) => (e.data as { name: string }).name),
      }))
      assert(
        traces.some(
          (r) =>
            r.session === 'router-event-' + small &&
            (r.calls.includes('read_source') ||
              r.calls.includes('inspect_github') ||
              r.calls.includes('delegate_task')),
        ),
      )
      writeFileSync(
        join(output, 'value-triage.json'),
        JSON.stringify(
          {
            thanks: thankTurn.answer.text,
            smallText,
            executions,
            authorized: requested.turns.at(-1)?.answer?.text,
            traces,
          },
          null,
          2,
        ),
      )
      return
    }
    const ambiguous = await service.message(
      'general',
      crypto.randomUUID(),
      '先暂停一下那件叫“交接核对”的事。',
    )
    assert(ambiguous.turns.at(-1)?.answer?.text)
    assert.equal(store.ledger.getMatter(operator, alpha.id)?.version, 1)
    assert.equal(store.ledger.getMatter(operator, beta.id)?.version, 1)
    const issue = await push(
      'issues/73',
      'K7 的封条号码已读为 SE-508；照片会在相关 PR 补上，签收记录稍后到。',
      'issue-73',
    )
    assert.deepEqual(
      store.ledger.eventMatters(operator, issue),
      [alpha.id],
      'Issue must link to the seal matter',
    )
    const pr = await push(
      'pull/14',
      '为 Issue #73 的 K7 封条提供拍照佐证，附件编号 PH-42，封条号码 SE-508。仍等签收记录。',
      'pr-14',
    )
    assert.deepEqual(
      store.ledger.eventMatters(operator, pr),
      [alpha.id],
      'PR is evidence for the same matter',
    )
    const other = await push(
      'issues/73#issuecomment-9',
      '另记一个进展：M2冰箱的实测温度是 4.2 °C。校准报告稍后交。',
      'issue-73-comment-9',
    )
    assert.deepEqual(
      store.ledger.eventMatters(operator, other),
      [beta.id],
      'An independent goal shares the same GitHub discussion',
    )
    const im = await bridge.handle({
      ...actor,
      actorId: 'owner',
      messageId: 'q-1',
      isDirect: true,
      text: 'K7 的本人签收回执号是 S19。先保存这份资料，暂时保留待办，我还要核对。',
    })
    assert(im.handled && im.reply)
    assert(
      JSON.stringify(store.ledger.getMatter(operator, alpha.id)?.context).includes('S19'),
      'IM evidence did not reach the seal matter',
    )
    // Rehearse recovery from a known erroneous historical association.
    store.ledger.changeSourceAssociation(operator, pr, alpha.id, beta.id, '隔离复验：历史错误关联')
    const correction = await service.message(
      'general',
      crypto.randomUUID(),
      `入箱事件 #${pr} 的封条照片被挂到了 M2 温度事项。请把它移回 K7 的封条事项，M2 的温度和校准待办还保留。`,
    )
    assert.deepEqual(
      store.ledger.eventMatters(operator, pr),
      [alpha.id],
      'Source was not moved back',
    )
    assert(store.ledger.sourceCorrections(operator, beta.id).some((c) => c.eventId === pr))
    const check = await service.message(
      'general',
      crypto.randomUUID(),
      '请核对这两件“交接核对”目前各自挂着的收件箱事件编号，列出它们分别跟进什么。',
    )
    const answer = check.turns.at(-1)?.answer?.text ?? ''
    const runs = store.ledger.listRuns({ limit: 40 }).map((run) => {
      const entries = store.ledger.entries(run.id)
      return {
        id: run.id,
        session: run.sessionId,
        status: run.status,
        tools: entries
          .filter((e) => e.kind === 'tool_start')
          .map((e) => (e.data as { name: string }).name),
      }
    })
    assert(runs[0].tools.includes('read_matter'), 'Read back current associations after correction')
    assert(store.ledger.matterSources(beta.id).includes(other))
    assert.equal(store.ledger.searchMatters(operator).length, 2)
    writeFileSync(
      join(output, 'correlation.json'),
      JSON.stringify(
        {
          alpha: alpha.id,
          beta: beta.id,
          issue,
          pr,
          other,
          ambiguous: ambiguous.turns.at(-1)?.answer?.text,
          im: im.reply,
          correction: correction.turns.at(-1)?.answer?.text,
          answer,
          runs,
        },
        null,
        2,
      ),
    )
  } finally {
    await service.close()
    await bridge.close()
    await routing.close()
    store.close()
  }
}
