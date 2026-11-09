import { expect, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import { RouterJobPrincipals } from '../router-job-principal'
import { RouterJobs } from '../router-jobs'
import { createRouterWorkTurn } from '../router-work-turn'
import { handoffAuthorized, readWorkerHandoff } from '../router-worker-capabilities'

test('a transfer carries full evidence from the selected authorized Worker and survives replay', async () => {
  const store = new TriggerStore(':memory:')
  const principals = new RouterJobPrincipals(store, { accessKey: () => 'fixture-access' })
  const matter = store.ledger.createMatter('router-owner', '核验安装资料', '以实际检出为准', [
    '核对原文',
  ])
  const other = store.ledger.createMatter('router-owner', '其他事项', '单独处理', ['独立交付'])
  const revoked = new Set<number>()
  const jobs = new RouterJobs(store.jobs, {
    authorized: principals.authorized.bind(principals),
    handoffAuthorized: (job) => handoffAuthorized(store, job, (source) => !revoked.has(source.id)),
    execute: async () => ({ result: '接收完毕' }),
    completed: async () => 'delivered',
  })
  const signal = new AbortController().signal
  const actions = (id: number) =>
    createRouterWorkTurn(
      {
        delegatedJobs: jobs,
        principals,
        principalFor: () => 'router-owner',
        checkout: async () => '/fixture',
      },
      store,
      'general',
      'web',
      {
        id,
        requestId: `turn-${id}`,
        question: '核验',
        status: 'pending',
        answer: null,
        error: null,
        createdAt: '',
        updatedAt: '',
      },
      [],
      () => true,
    ).actions
  try {
    const audience = principals.capture('web', false)
    const source = store.jobs.submit(
      'general',
      'source',
      { executor: 'zero', instruction: '查资料', audience },
      (job) =>
        store.ledger.bindWorker({
          jobId: job.id,
          principal: 'router-owner',
          matterId: matter.id,
          scope: 'general',
          audience,
          eventIds: [],
          authority: 'user',
        }),
    )
    store.jobs.claimNext()
    const run = store.ledger.begin(`router-job-${source.id}`, 'Worker 办理', {})
    const long = `${'资料'.repeat(10000)}核验标记 W73`
    store.ledger.append(run, 'model_request', { history: 'unrelated model input' })
    store.ledger.append(run, 'tool_result', { result: { output: long } })
    store.ledger.end(run, 'completed')
    store.jobs.finish(source.id, 1, {
      status: 'completed',
      result: '已排除远端镜像。剩余步骤是读取本地文件。',
      threadId: 'zero-thread',
    })
    for (let attempt = 2; attempt <= 11; attempt++) {
      store.jobs.continue('general', source.id, `step-${attempt}`, `继续核查 ${attempt}`)
      store.jobs.claimNext()
      store.jobs.finish(source.id, attempt, { status: 'completed', result: `本轮证据 ${attempt}` })
    }
    const otherRun = store.ledger.begin('router-job-999', 'other', {})
    store.ledger.append(otherRun, 'tool_result', { result: { output: 'unrelated private result' } })
    const target = {
      executor: 'codex' as const,
      repository: 'sample/repo',
      matterId: matter.id,
      instruction: '读取已有证据并核对本地文件',
      handoffFromJobId: source.id,
    }
    jobs.start()
    expect(await actions(2).getTaskStatus?.(source.id, signal, 2)).toMatchObject({
      attempt: 2,
      result: '本轮证据 2',
    })
    expect(await actions(2).getTaskStatus?.(source.id, signal)).toMatchObject({
      attempt: 11,
      result: '本轮证据 11',
    })
    const receipt = await actions(2).delegateTask?.(target, signal)
    if (!receipt) throw Error('Missing handoff receipt')
    expect(await actions(2).delegateTask?.(target, signal)).toMatchObject({
      id: receipt.id,
      handoff: receipt.handoff,
    })
    expect(receipt.handoff).toMatchObject({
      fromJobId: source.id,
      fromAttempt: 11,
      fromStatus: 'completed',
    })
    const job = store.jobs.get('general', receipt.id)
    if (!job) throw Error('Missing target Worker')
    const context = readWorkerHandoff(store, job, () => true)
    if (!context) throw Error('Missing transferred evidence')
    expect(context.currentStatus).toBe('completed')
    expect(context.steps[0]).toMatchObject({
      threadId: 'zero-thread',
      result: '已排除远端镜像。剩余步骤是读取本地文件。',
    })
    expect(context.evidence).toMatchObject([{ runId: run, data: { result: { output: long } } }])
    expect(JSON.stringify(context)).not.toContain('unrelated')
    expect(() => readWorkerHandoff(store, job, () => false)).toThrow('授权')
    await expect(
      actions(3).delegateTask?.({ ...target, matterId: other.id }, signal),
    ).rejects.toThrow('原事项')
    expect(store.ledger.workerSessions('router-owner', other.id)).toHaveLength(0)
    store.jobs.continue('general', source.id, 'later-attempt', '移交后新增的待办')
    const restored = readWorkerHandoff(store, job, () => true)
    expect(restored).toMatchObject({
      fromStatus: 'completed',
      fromAttempt: 11,
      currentAttempt: 12,
      currentStatus: 'queued',
    })
    expect(restored?.steps).toHaveLength(11)
    const third = await actions(4).delegateTask?.(
      { ...target, executor: 'zero', handoffFromJobId: receipt.id },
      signal,
    )
    if (!third) throw Error('Missing second transfer')
    revoked.add(source.id)
    await expect(actions(5).getTaskStatus?.(third.id, signal)).rejects.toThrow(
      '原 Worker 的资料授权已变更',
    )
  } finally {
    await jobs.close()
    store.close()
  }
})
