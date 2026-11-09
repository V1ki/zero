import { expect, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import type { RouterAgentInput } from '../router-agent'
import { RouterJobPrincipals } from '../router-job-principal'
import { RouterJobs } from '../router-jobs'
import { RouterWorkspaceService } from '../router-workspace'
import { TriggerRoutingRuntime } from '../routing-runtime'

function required<T>(value: T | undefined | null): T {
  if (value == null) throw Error('Required test capability or record missing')
  return value
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw Error('Timed out waiting for loop')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
test('new input, existing matter continuation and Worker returns enter the same Router with durable context', async () => {
  const store = new TriggerStore(':memory:')
  store.useAgentIntake()
  const revision = store.saveSettings(
    {
      github: { credentialRef: '', repositories: [] },
      wxarc: { sessions: [{ id: 'fixture', name: 'Fixture', keyword: '', enabled: true }] },
    },
    0,
  )
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: async () => {
      throw Error('legacy analyzer must not run')
    },
    weixin: {
      listTargets: () => [],
      send: async () => {
        throw Error('external send')
      },
    },
  })
  const principals = new RouterJobPrincipals(store, { accessKey: () => null })
  const config = routing.getConfig()
  routing.saveConfig({ ...config.settings, enabled: true }, config.revision)
  const executed: number[] = []
  let workspace: RouterWorkspaceService
  const runner = new RouterJobs(store.jobs, {
    authorized: (...args) => principals.authorized(...args),
    execute: async (job, history) => {
      executed.push(job.id)
      expect(history.every((h) => h.id === job.id)).toBe(true)
      return {
        result: `已核对第 ${job.attempt} 次材料，仍需等待真实复测。`,
        threadId: `thread-${job.id}`,
      }
    },
    completed: async (job) => {
      const link = store.ledger.workerLink(job.id)
      if (!link) throw Error('Expected a Worker matter link')
      store.ledger.receiveSignal({
        key: `worker:${job.id}:${job.attempt}`,
        principal: link.principal,
        kind: 'worker_result',
        scope: String(link.eventIds.at(-1)),
        payload: { jobId: job.id, matterId: link.matterId, attempt: job.attempt },
      })
      workspace.notifySignals()
      return 'delivered'
    },
  })
  const received: RouterAgentInput[] = []
  let matterId = ''
  let workerId = 0
  workspace = new RouterWorkspaceService(
    store,
    routing,
    async (input, signal) => {
      received.push(input)
      if (input.signalContext?.kind === 'event' || input.signalContext?.kind === 'worker_result') {
        expect(input.actions?.sendReminder).toBeUndefined()
        expect(
          input.actions?.capabilities?.some((c) => c.definition.name === 'publish_update'),
        ).toBe(true)
      }
      const capabilities = input.actions?.capabilities ?? []
      const use = async (name: string, args: Record<string, unknown>) => {
        const tool = capabilities.find((c) => c.definition.name === name)
        if (!tool) throw Error(`missing ${name}`)
        return tool.execute(args, signal ?? new AbortController().signal)
      }
      if (input.signalContext?.kind === 'event') {
        if (!matterId) {
          const matter = (await use('create_matter', {
            title: '验证设备',
            goal: '核实问题并复测',
            criteria: ['真实复测记录'],
          })) as { id: string }
          matterId = matter.id
          const job = await required(input.actions?.delegateTask)(
            { executor: 'zero', matterId, instruction: '核对原始材料并汇报未完成部分' },
            new AbortController().signal,
          )
          workerId = job.id
        } else
          await required(input.actions?.continueTask)(
            workerId,
            new AbortController().signal,
            '已有新材料，继续原事项并保留之前的否定结论',
          )
      } else if (input.signalContext?.kind === 'worker_result') {
        const job = await required(input.actions?.getTaskStatus)(
          workerId,
          new AbortController().signal,
        )
        expect(job.result).toContain('仍需等待')
        const matter = required(store.ledger.getMatter('router-owner', matterId))
        await use('update_matter', {
          matterId,
          version: matter.version,
          state: 'waiting',
          context: { workerId, verified: job.result, ruledOut: ['还没有证据证明已修复'] },
        })
      }
      return { text: '已更新这件事，尚未确认修复。' }
    },
    { agentIntake: true, principalFor: () => 'router-owner', principals, delegatedJobs: runner },
  )
  const commit = (cursor: string, previousCursor: string | null) =>
    store.commitBatch({
      source: 'wxarc',
      stream: 'wxarc:fixture',
      previousCursor,
      cursor,
      revision,
      events: [
        {
          eventId: `source-${cursor}`,
          scope: 'fixture',
          title: '新的材料',
          summary: '设备复测有新结果',
          occurredAt: new Date().toISOString(),
        },
      ],
    })
  try {
    commit('one', null)
    workspace.start()
    await until(
      () => received.filter((r) => r.signalContext?.kind === 'worker_result').length === 1,
    )
    await until(() =>
      store.ledger.listSignals('router-owner').every((s) => s.state === 'completed'),
    )
    commit('two', 'one')
    workspace.notifySignals()
    await until(
      () => received.filter((r) => r.signalContext?.kind === 'worker_result').length === 2,
    )
    await until(() =>
      store.ledger.listSignals('router-owner').every((s) => s.state === 'completed'),
    )
    expect(executed).toEqual([workerId, workerId])
    expect(store.ledger.searchMatters('router-owner')).toHaveLength(1)
    expect(store.ledger.workerLink(workerId)?.eventIds).toHaveLength(2)
    expect(store.ledger.getMatter('router-owner', matterId)?.state).toBe('waiting')
    expect(received.map((r) => r.signalContext?.kind)).toEqual([
      'event',
      'worker_result',
      'event',
      'worker_result',
    ])
    expect(JSON.stringify(received.at(-1)?.matterContext)).toContain('还没有证据证明已修复')
  } finally {
    await workspace.close()
    await routing.close()
    store.close()
  }
})
