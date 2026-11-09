import { expect, mock, test } from 'bun:test'
import { type RouterJob, TriggerStore } from '@zero-os/observe'
import { RouterJobExecutionUncertainError, RouterJobs } from '../router-jobs'

const scope = `im-${'a'.repeat(64)}` as const
const privateInput = {
  executor: 'zero' as const,
  instruction: '查这个仓库的发布失败原因',
  repository: 'example/repo',
  audience: 'original-pinned-binding',
}

async function until(predicate: () => boolean) {
  const end = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Timed out waiting for Router job')
    await Bun.sleep(5)
  }
}

test('a queued job is scoped, resumable by the same owner, and delivered once per attempt', async () => {
  const store = new TriggerStore(':memory:')
  const gate = Promise.withResolvers<void>()
  const execute = mock(async (job: RouterJob) => {
    await gate.promise
    return { result: `attempt-${job.attempt}: token`, threadId: 'private-worker-thread' }
  })
  const completed = mock(async () => 'delivered' as const)
  const jobs = new RouterJobs(store.jobs, {
    authorized: () => true,
    execute,
    completed,
    filter: (s) => s.replace('token', 'filtered'),
  })
  try {
    jobs.start()
    const receipt = jobs.submit(scope, 'initial', privateInput)
    expect(receipt.status).toBe('queued')
    expect(jobs.submit(scope, 'initial', privateInput)).toEqual(receipt)
    expect(() => jobs.get('general', receipt.id)).toThrow('找不到')
    expect(() => jobs.get(scope, receipt.id, 'another-binding')).toThrow('找不到')
    expect(() => jobs.continue(scope, receipt.id, 'foreign', 'follow', 'another-binding')).toThrow(
      '找不到',
    )
    await until(() => execute.mock.calls.length === 1)
    expect(jobs.get(scope, receipt.id, privateInput.audience).status).toBe('running')
    expect(() =>
      jobs.continue(scope, receipt.id, 'concurrent', 'follow', privateInput.audience),
    ).toThrow()
    gate.resolve()
    await until(() => completed.mock.calls.length === 1)
    const finished = jobs.get(scope, receipt.id, privateInput.audience)
    expect(finished).toEqual({ ...receipt, status: 'completed', result: 'attempt-1: filtered' })
    const continued = jobs.continue(
      scope,
      receipt.id,
      'followup',
      '继续看作业日志',
      privateInput.audience,
    )
    expect(continued.id).toBe(receipt.id)
    expect(continued.attempt).toBe(2)
    jobs.continue(scope, receipt.id, 'followup', '继续看作业日志', privateInput.audience)
    await until(() => completed.mock.calls.length === 2)
    expect(execute.mock.calls.map(([job]) => job.threadId)).toEqual([null, 'private-worker-thread'])
    expect(jobs.get(scope, receipt.id, privateInput.audience, 1)).toEqual(finished)
    expect(jobs.get(scope, receipt.id, privateInput.audience, 2).result).toBe('attempt-2: filtered')
    expect(jobs.get(scope, receipt.id, privateInput.audience).attempt).toBe(2)
    expect(jobs.findAttempts(scope, receipt.id, privateInput.audience, 'ATTEMPT-1')).toEqual([
      { attempt: 1, status: 'completed' },
    ])
    expect(jobs.findAttempts(scope, receipt.id, privateInput.audience, '作业日志')).toEqual([
      { attempt: 2, status: 'completed' },
    ])
    expect(jobs.findAttempts(scope, receipt.id, privateInput.audience, '%')).toEqual([])
    expect(() => jobs.findAttempts(scope, receipt.id, 'another-binding', 'filtered')).toThrow(
      '找不到',
    )
    expect(() =>
      jobs.findAttempts('general', receipt.id, privateInput.audience, 'filtered'),
    ).toThrow('找不到')
    expect(() => jobs.get(scope, receipt.id, privateInput.audience, 3)).toThrow('找不到')
    expect(() => jobs.get(scope, receipt.id, 'another-binding', 1)).toThrow('找不到')
    expect(() => jobs.get('general', receipt.id, privateInput.audience, 1)).toThrow('找不到')
  } finally {
    gate.resolve()
    await jobs.close()
    store.close()
  }
})

test('revoked origin is denied at queue claim, read, continuation and completion', async () => {
  const store = new TriggerStore(':memory:')
  let authorized = true
  const execute = mock(async () => ({ result: 'private' }))
  const completed = mock(async () => 'delivered' as const)
  const jobs = new RouterJobs(store.jobs, { authorized: () => authorized, execute, completed })
  try {
    jobs.start()
    const receipt = jobs.submit(scope, 'first', privateInput)
    authorized = false
    await until(() => store.jobs.get(scope, receipt.id)?.status === 'failed')
    expect(execute).not.toHaveBeenCalled()
    expect(completed).not.toHaveBeenCalled()
    expect(() => jobs.get(scope, receipt.id, privateInput.audience)).toThrow('授权')
    expect(() => jobs.get(scope, receipt.id, privateInput.audience, 1)).toThrow('授权')
    expect(() => jobs.findAttempts(scope, receipt.id, privateInput.audience, 'private')).toThrow(
      '授权',
    )
    expect(() =>
      jobs.continue(scope, receipt.id, 'follow', 'follow', privateInput.audience),
    ).toThrow('授权')
    expect(() => jobs.submit(scope, 'another', privateInput)).toThrow('授权')
  } finally {
    await jobs.close()
    store.close()
  }
})

test('revocation during an execution discards its output before storing or delivering', async () => {
  const store = new TriggerStore(':memory:')
  let authorized = true
  const gate = Promise.withResolvers<void>()
  const execute = mock(async () => {
    await gate.promise
    return { result: 'secret payload' }
  })
  const completed = mock(async () => 'delivered' as const)
  const jobs = new RouterJobs(store.jobs, { authorized: () => authorized, execute, completed })
  try {
    jobs.start()
    const receipt = jobs.submit(scope, 'first', { ...privateInput, executor: 'codex' })
    await until(() => execute.mock.calls.length > 0)
    authorized = false
    gate.resolve()
    await until(() => store.jobs.get(scope, receipt.id)?.status === 'unknown')
    expect(store.jobs.get(scope, receipt.id)?.result).not.toContain('secret')
    expect(completed).not.toHaveBeenCalled()
  } finally {
    gate.resolve()
    await jobs.close()
    store.close()
  }
})

test('restart returns a finished attempt and flags interrupted writes without dispatching again', async () => {
  const store = new TriggerStore(':memory:')
  const first = store.jobs.submit('general', 'wrote', {
    executor: 'codex',
    instruction: '修改文件',
  })
  store.jobs.claimNext()
  const second = store.jobs.submit('general', 'done', { executor: 'zero', instruction: '分析' })
  store.jobs.claimNext()
  store.jobs.finish(second.id, second.attempt, { status: 'completed', result: 'restored' })
  const execute = mock(async () => ({ result: 'should not run' }))
  const completed = mock(async (_job: RouterJob) => 'delivered' as const)
  const jobs = new RouterJobs(store.jobs, { authorized: () => true, execute, completed })
  try {
    jobs.start()
    await until(() => completed.mock.calls.length === 2)
    expect(jobs.get('general', first.id).status).toBe('unknown')
    expect(jobs.get('general', second.id).result).toBe('restored')
    expect(execute).not.toHaveBeenCalled()
  } finally {
    await jobs.close()
    store.close()
  }
})

test('policy defer persists a future return and execution is not repeated on restart', async () => {
  const store = new TriggerStore(':memory:')
  const execute = mock(async () => ({ result: 'done' }))
  const completed = mock(async () => ({
    recheckAt: new Date(Date.now() + 86400_000).toISOString(),
  }))
  const first = new RouterJobs(store.jobs, { authorized: () => true, execute, completed })
  const second = new RouterJobs(store.jobs, { authorized: () => true, execute, completed })
  try {
    first.start()
    const job = first.submit('general', 'first', { executor: 'zero', instruction: '分析' })
    await until(() => Boolean(store.jobs.nextReturnAt()))
    await first.close()
    second.start()
    expect(second.get('general', job.id).result).toBe('done')
    await Bun.sleep(10)
    expect(completed).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
  } finally {
    await Promise.all([first.close(), second.close()])
    store.close()
  }
})

test('ambiguous Codex failure and lost platform receipt are never retried automatically', async () => {
  const store = new TriggerStore(':memory:')
  const execute = mock(async () => {
    throw new RouterJobExecutionUncertainError('回执丢失。')
  })
  const completed = mock(async () => {
    throw new Error('platform timeout')
  })
  const first = new RouterJobs(store.jobs, { authorized: () => true, execute, completed })
  const second = new RouterJobs(store.jobs, { authorized: () => true, execute, completed })
  try {
    first.start()
    const job = first.submit('general', 'first', { executor: 'codex', instruction: '修复测试' })
    await until(() => completed.mock.calls.length === 1)
    await first.close()
    second.start()
    expect(second.get('general', job.id)).toMatchObject({ status: 'unknown' })
    await Bun.sleep(10)
    expect(completed).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
  } finally {
    await Promise.all([first.close(), second.close()])
    store.close()
  }
})

test('pending returns proceed while another worker is waiting', async () => {
  const store = new TriggerStore(':memory:')
  const prior = store.jobs.submit('general', 'prior', { executor: 'zero', instruction: '上一条' })
  store.jobs.claimNext()
  store.jobs.finish(prior.id, prior.attempt, { status: 'completed', result: '前项已完成' })
  const next = store.jobs.submit('general', 'new', { executor: 'zero', instruction: '长任务' })
  const gate = Promise.withResolvers<void>()
  const execute = mock(async () => {
    await gate.promise
    return { result: 'finished' }
  })
  const completed = mock(async (_job: RouterJob) => 'delivered' as const)
  const jobs = new RouterJobs(store.jobs, { authorized: () => true, execute, completed })
  try {
    jobs.start()
    await until(() => completed.mock.calls.length > 0)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(completed.mock.calls[0][0].id).toBe(prior.id)
    expect(jobs.get('general', next.id).status).toBe('running')
  } finally {
    gate.resolve()
    await jobs.close()
    store.close()
  }
})

test('event completion keeps verified same-repository evidence; missing evidence or a foreign source cannot resolve work', async () => {
  const store = new TriggerStore(':memory:')
  const submit = (id: string) =>
    store.jobs.submit('general', id, { ...privateInput, kind: 'github-watch' })
  const ok = submit('evidence')
  const foreign = submit('foreign')
  const missing = submit('missing')
  const jobs = new RouterJobs(store.jobs, {
    authorized: () => true,
    execute: async () => {
      throw new Error('unexpected generic executor')
    },
    filter: (s) => s.replaceAll('sensitive', '[filtered]'),
    tracking: {
      authorized: () => true,
      execute: async (job) => ({
        result: 'sensitive result',
        attentionQuestion: 'sensitive detail',
        work: {
          outcome: 'resolved',
          steps: [{ tool: 'inspect_github', ok: true }],
          sources:
            job.id === missing.id
              ? []
              : [
                  {
                    label: 'sensitive label',
                    url: `https://github.com/${job.id === ok.id ? 'example' : 'someone'}/repo/issues/2`,
                  },
                ],
        },
      }),
    },
  })
  try {
    jobs.start()
    await until(() => store.jobs.get('general', missing.id)?.status === 'failed')
    expect(store.jobs.get('general', ok.id)).toMatchObject({
      status: 'completed',
      result: '[filtered] result',
      attentionQuestion: '[filtered] detail',
      work: {
        outcome: 'resolved',
        sources: [{ label: '[filtered] label', url: 'https://github.com/example/repo/issues/2' }],
      },
    })
    expect(store.jobs.get('general', foreign.id)?.status).toBe('failed')
    expect(store.jobs.get('general', missing.id)?.work).toBeUndefined()
  } finally {
    await jobs.close()
    store.close()
  }
})

test('event work retains every verified step, evidence label, fact and full follow-up reason', async () => {
  const store = new TriggerStore(':memory:')
  const job = store.jobs.submit('general', 'long-evidence', {
    ...privateInput,
    kind: 'github-watch',
  })
  const sources = Array.from({ length: 42 }, (_, i) => ({
    label: '依据'.repeat(240) + i,
    url: `https://github.com/example/repo/issues/${i + 1}`,
  }))
  const steps = sources.map(() => ({ tool: 'inspect_github' as const, ok: true }))
  const publicFacts = sources.map((_, i) => ({
    label: '评论时间' as const,
    value: new Date(2026, 0, i + 1).toISOString(),
  }))
  const reason = '尚待独立回执'.repeat(180)
  const jobs = new RouterJobs(store.jobs, {
    authorized: () => true,
    execute: async () => {
      throw Error('unexpected executor')
    },
    tracking: {
      authorized: () => true,
      execute: async () => ({
        result: '完成核验',
        work: {
          outcome: 'resolved',
          steps,
          sources,
          publicFacts,
          followup: { kind: 'continue', decision: 'act', reason },
        },
      }),
    },
  })
  try {
    jobs.start()
    await until(() => store.jobs.get('general', job.id)?.status === 'completed')
    const work = store.jobs.get('general', job.id)?.work
    expect(work).toMatchObject({ steps, sources, publicFacts, followup: { reason } })
  } finally {
    await jobs.close()
    store.close()
  }
})

test('a failed executor keeps the thread saved before execution for the next attempt', async () => {
  const store = new TriggerStore(':memory:')
  const jobs = new RouterJobs(store.jobs, {
    authorized: () => true,
    async execute(job, _history, _signal, onThreadReady) {
      if (job.attempt === 1) {
        onThreadReady?.('durable-codex-thread')
        expect(store.jobs.get(job.scope, job.id)?.threadId).toBe('durable-codex-thread')
        throw new RouterJobExecutionUncertainError('执行连接中断')
      }
      expect(job.threadId).toBe('durable-codex-thread')
      return { result: '核对原线程后完成', threadId: job.threadId ?? undefined }
    },
    completed: async () => 'delivered',
  })
  try {
    jobs.start()
    const job = jobs.submit('general', 'persist-before-failure', {
      executor: 'codex',
      instruction: '执行任务',
    })
    await until(() => store.jobs.get('general', job.id)?.status === 'unknown')
    jobs.continue('general', job.id, 'resume-after-check', '继续原线程')
    await until(() => store.jobs.get('general', job.id)?.status === 'completed')
    expect(store.jobs.get('general', job.id)?.threadId).toBe('durable-codex-thread')
  } finally {
    await jobs.close()
    store.close()
  }
})
