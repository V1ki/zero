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
    expect(jobs.get(scope, receipt.id, privateInput.audience, 1)).toEqual({
      ...finished,
      continued: true,
    })
    expect(jobs.get(scope, receipt.id, privateInput.audience, 2).result).toBe('attempt-2: filtered')
    expect(jobs.get(scope, receipt.id, privateInput.audience).attempt).toBe(2)
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

const report = {
  verdict: '发布失败是因为令牌过期。',
  done: ['更新了发布脚本'],
  decision: { question: '现在发布吗？', options: ['发布这份草稿', '先不发布'], recommended: 0 },
}

test('a completed step is delivered only after its report, which belongs to that attempt', async () => {
  const store = new TriggerStore(':memory:')
  const gate = Promise.withResolvers<void>()
  const execute = mock(async (job: RouterJob) => ({ result: `raw work log ${job.attempt}` }))
  const reportCalls: RouterJob[] = []
  const reporter = mock(async (job: RouterJob) => {
    reportCalls.push(job)
    // The executor's result is durable before the report starts.
    expect(store.jobs.get(job.scope, job.id, job.attempt)?.result).toBe(job.result)
    expect(store.jobs.claimReturn()).toBeNull()
    await gate.promise
    return job.attempt === 1 ? report : { verdict: '已发布。', done: [] }
  })
  const completed = mock(async (_job: RouterJob) => 'delivered' as const)
  const jobs = new RouterJobs(store.jobs, {
    authorized: () => true,
    execute,
    report: reporter,
    completed,
  })
  try {
    jobs.start()
    const receipt = jobs.submit('general', 'first', {
      executor: 'zero',
      instruction: '查发布失败',
      brief: '用户想今天发版',
    })
    await until(() => reporter.mock.calls.length === 1)
    expect(jobs.get('general', receipt.id)).toMatchObject({
      status: 'completed',
      result: 'raw work log 1',
      reportPending: true,
    })
    await Bun.sleep(20)
    expect(completed).not.toHaveBeenCalled()
    gate.resolve()
    await until(() => completed.mock.calls.length === 1)
    expect(reportCalls[0]).toMatchObject({ instruction: '查发布失败', brief: '用户想今天发版' })
    const first = jobs.get('general', receipt.id)
    expect(first).toEqual({ ...receipt, status: 'completed', result: 'raw work log 1', report })
    jobs.continue('general', receipt.id, 'second', '发布这份草稿', undefined, {
      brief: '按推荐发布',
    })
    await until(() => completed.mock.calls.length === 2)
    expect(jobs.get('general', receipt.id, undefined, 1)).toEqual({ ...first, continued: true })
    expect(jobs.get('general', receipt.id).report).toEqual({ verdict: '已发布。', done: [] })
    expect(store.jobs.get('general', receipt.id)?.brief).toBe('按推荐发布')
    expect(execute).toHaveBeenCalledTimes(2)
  } finally {
    gate.resolve()
    await jobs.close()
    store.close()
  }
})

test('a failed, invalid or timed-out report leaves status and raw result and still delivers', async () => {
  for (const reporter of [
    async () => {
      throw new Error('provider down')
    },
    async () => null,
    // Ignores its signal entirely; the timeout still releases delivery.
    () => new Promise<null>(() => {}),
  ]) {
    const store = new TriggerStore(':memory:')
    const execute = mock(async () => ({ result: 'raw result' }))
    const completed = mock(async (_job: RouterJob) => 'delivered' as const)
    const jobs = new RouterJobs(store.jobs, {
      authorized: () => true,
      execute,
      report: reporter,
      reportTimeout: 30,
      completed,
    })
    try {
      jobs.start()
      const receipt = jobs.submit('general', 'first', { executor: 'zero', instruction: '分析' })
      await until(() => completed.mock.calls.length === 1)
      expect(jobs.get('general', receipt.id)).toEqual({
        ...receipt,
        status: 'completed',
        result: 'raw result',
      })
      expect(store.jobs.get('general', receipt.id)?.reportState).toBe('none')
      expect(execute).toHaveBeenCalledTimes(1)
    } finally {
      await jobs.close()
      store.close()
    }
  }
})

test('failed steps get no report, and a report cut off by restart is delivered without one', async () => {
  const store = new TriggerStore(':memory:')
  const failed = store.jobs.submit('general', 'failed', { executor: 'zero', instruction: '分析' })
  store.jobs.claimNext()
  store.jobs.finish(failed.id, 1, { status: 'failed', result: '任务超时。', report: true })
  const cut = store.jobs.submit('general', 'cut', { executor: 'zero', instruction: '分析' })
  store.jobs.claimNext()
  store.jobs.finish(cut.id, 1, { status: 'completed', result: 'stored result', report: true })
  expect(store.jobs.get('general', failed.id)?.reportState).toBeNull()
  expect(store.jobs.get('general', cut.id)?.reportState).toBe('pending')
  expect(store.jobs.claimReturn()?.id).toBe(failed.id)
  expect(store.jobs.claimReturn()).toBeNull()
  const execute = mock(async () => ({ result: 'should not run' }))
  const reporter = mock(async () => report)
  const completed = mock(async (_job: RouterJob) => 'delivered' as const)
  const jobs = new RouterJobs(store.jobs, {
    authorized: () => true,
    execute,
    report: reporter,
    completed,
  })
  try {
    jobs.start()
    await until(() => completed.mock.calls.length === 1)
    expect(completed.mock.calls[0][0].id).toBe(cut.id)
    expect(jobs.get('general', cut.id)).toEqual({
      id: cut.id,
      executor: 'zero',
      attempt: 1,
      status: 'completed',
      result: 'stored result',
    })
    expect(store.jobs.get('general', cut.id)?.reportState).toBe('none')
    expect(jobs.get('general', failed.id).report).toBeUndefined()
    expect(reporter).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  } finally {
    await jobs.close()
    store.close()
  }
})
