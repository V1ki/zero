import { expect, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import type { TriggerConversationTurn } from '@zero-os/shared'
import { RouterJobPrincipals } from '../router-job-principal'
import { RouterJobs } from '../router-jobs'
import { createRouterWorkTurn } from '../router-work-turn'

test('automatic followups continue the same worker beyond the old hourly limits and still honor an explicit pause', async () => {
  const store = new TriggerStore(':memory:')
  const principals = new RouterJobPrincipals(store, { accessKey: () => null })
  const matter = store.ledger.createMatter('router-owner', '持续核查', '核实全部证据', ['核查完毕'])
  const jobs = new RouterJobs(store.jobs, {
    authorized: principals.authorized.bind(principals),
    execute: async (job) => ({ result: `新证据 ${job.attempt}`, threadId: 'same-worker' }),
    completed: async () => 'delivered',
  })
  const signal = new AbortController().signal
  const actions = (id: number, workerResult?: { jobId: number; attempt: number }) => {
    const turn: TriggerConversationTurn = {
      id,
      requestId: `turn-${id}`,
      question: '继续核查',
      answer: null,
      status: 'pending',
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    return createRouterWorkTurn(
      { delegatedJobs: jobs, principals, principalFor: () => 'router-owner' },
      store,
      'general',
      'web',
      turn,
      [],
      () => true,
      { authority: 'source', workerResult },
    ).actions
  }
  const completed = async (id: number, attempt: number) => {
    const deadline = Date.now() + 2000
    while (store.jobs.get('general', id)?.status !== 'completed') {
      if (Date.now() > deadline) throw Error('Worker did not finish')
      await Bun.sleep(1)
    }
    expect(store.jobs.get('general', id)?.attempt).toBe(attempt)
  }
  try {
    jobs.start()
    const first = await actions(1).delegateTask?.(
      { executor: 'zero', matterId: matter.id, instruction: '核查第一份证据' },
      signal,
    )
    if (!first) throw Error('Missing worker')
    await completed(first.id, 1)
    for (let attempt = 2; attempt <= 40; attempt++) {
      const next = await actions(attempt).continueTask?.(
        first.id,
        signal,
        `核查第 ${attempt} 份证据`,
      )
      expect(next?.id).toBe(first.id)
      await completed(first.id, attempt)
    }
    expect(store.ledger.workerLink(first.id)?.matterId).toBe(matter.id)
    expect(store.jobs.get('general', first.id, 1)?.result).toBe('新证据 1')
    expect(store.jobs.get('general', first.id, 40)?.result).toBe('新证据 40')
    await expect(
      actions(100, { jobId: first.id, attempt: 39 }).continueTask?.(
        first.id,
        signal,
        '再查同一份证据',
      ),
    ).rejects.toThrow('已经续办到第 40 轮')
    expect(store.jobs.get('general', first.id)?.attempt).toBe(40)
    store.ledger.updateMatter('router-owner', matter.id, 1, {
      state: 'paused',
      context: { reason: '用户暂停' },
    })
    await expect(actions(41).continueTask?.(first.id, signal, '继续')).rejects.toThrow('未开放')
    expect(store.jobs.get('general', first.id)?.attempt).toBe(40)
  } finally {
    await jobs.close()
    store.close()
  }
})
