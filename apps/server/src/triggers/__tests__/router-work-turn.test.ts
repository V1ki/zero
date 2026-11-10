import { afterEach, expect, mock, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import type { TriggerConversationAnswer } from '@zero-os/shared'
import { TriggerAgentError } from '../event-agent'
import type { RouterAgentInput } from '../router-agent'
import { RouterJobPrincipals } from '../router-job-principal'
import { RouterJobs } from '../router-jobs'
import type { RouterTurnActions } from '../router-loop-tools'
import { resolveCodexRepository } from '../router-work-reply'
import { RouterWorkspaceService } from '../router-workspace'
import type { RouterWriteRequest } from '../router-write-check'
import { TriggerRoutingRuntime } from '../routing-runtime'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

async function until(predicate: () => boolean) {
  const end = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Timed out')
    await Bun.sleep(5)
  }
}

type Script = (
  actions: RouterTurnActions,
  signal: AbortSignal,
  claim: () => void,
) => Promise<TriggerConversationAnswer['job']>

function setup(registered = ['v1ki/zero', 'other/tools']) {
  const store = new TriggerStore(':memory:')
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: async () => {
      throw new Error('Unexpected analysis')
    },
    weixin: {
      listTargets: () => [],
      send: async () => {
        throw new Error('Unexpected delivery')
      },
    },
  })
  const access = { github: 'github-key' as string | null, checkout: '/checkout' as string | null }
  const principals = new RouterJobPrincipals(store, { accessKey: () => access.github })
  const delegatedJobs = new RouterJobs(store.jobs, {
    authorized: (scope, audience, repository) => principals.authorized(scope, audience, repository),
    execute: async (job) => ({ result: `done ${job.attempt}` }),
  })
  const checks: RouterWriteRequest[] = []
  const verdict = { next: async () => {} }
  const confirmWrite = mock(async (request: RouterWriteRequest, _signal: AbortSignal) => {
    checks.push(request)
    await verdict.next()
  })
  const checkouts: string[] = []
  const claims = { count: 0 }
  let script: Script = async () => undefined
  const ask = async (input: RouterAgentInput, signal?: AbortSignal) => {
    if (!input.actions || !signal) throw new Error('Expected actions')
    const job = await script(input.actions, signal, () => claims.count++)
    return { text: '模型的说明。', ...(job && { job }) }
  }
  const service = new RouterWorkspaceService(
    store,
    {
      getConfig: () => routing.getConfig(),
      listPersonalBots: () => [],
      process: (id) => routing.process(id),
    },
    ask,
    {
      principals,
      delegatedJobs,
      checkout: async (repository) => {
        checkouts.push(repository)
        return access.checkout
      },
      registeredCheckouts: () => registered,
      confirmWrite,
    },
  )
  service.start()
  cleanup.push(async () => {
    await service.close()
    await routing.close()
    store.close()
  })
  let id = 0
  const say = (question: string, next: Script) => {
    script = next
    return service.message('general', `request-${++id}`, question)
  }
  const completed = (job: number, attempt = 1) =>
    until(() => {
      const stored = store.jobs.get('general', job)
      return stored?.attempt === attempt && stored.status === 'completed'
    })
  return { store, say, checks, verdict, confirmWrite, access, claims, checkouts, completed }
}

const delegate =
  (target: Parameters<NonNullable<RouterTurnActions['delegateTask']>>[0]): Script =>
  (actions, signal, claim) => {
    if (!actions.delegateTask) throw new Error('Expected delegation')
    return actions.delegateTask(target, signal, claim)
  }
const resume =
  (job: number): Script =>
  (actions, signal, claim) => {
    if (!actions.continueTask) throw new Error('Expected continuation')
    return actions.continueTask(job, signal, claim, '补充背景')
  }

test('read-only delegation, continuation and status make no confirmation call', async () => {
  const { store, say, confirmWrite, claims, completed } = setup()
  // Neither sentence names a full repository or starts with an imperative; the model decides.
  await say(
    '分析 zero 仓库最近的发布失败',
    delegate({ executor: 'zero', repository: 'v1ki/zero', brief: '看发布' }),
  )
  expect(store.jobs.get('general', 1)).toMatchObject({ executor: 'zero', repository: 'v1ki/zero' })
  await completed(1)
  await say('那就接着做吧', resume(1))
  expect(store.jobs.get('general', 1)?.attempt).toBe(2)
  await completed(1, 2)
  const status = await say('#1 怎么样了', (actions, signal) => {
    if (!actions.getTaskStatus) throw new Error('Expected status')
    return actions.getTaskStatus(1, signal)
  })
  expect(status.turns.at(-1)?.answer?.job).toMatchObject({ id: 1, attempt: 2 })
  expect(confirmWrite).not.toHaveBeenCalled()
  expect(claims.count).toBe(2)
})

test('read-only work keeps the GitHub grant and repository format checks', async () => {
  const { store, say, access, confirmWrite } = setup()
  await expect(
    say('分析一下 zero', delegate({ executor: 'zero', repository: 'zero' })),
  ).rejects.toThrow('仓库全名')
  access.github = null
  await expect(
    say('分析 v1ki/zero', delegate({ executor: 'zero', repository: 'v1ki/zero' })),
  ).rejects.toThrow('GitHub')
  expect(store.jobs.get('general', 1)).toBeNull()
  expect(confirmWrite).not.toHaveBeenCalled()
})

test('a Codex job is confirmed once, from the sentence and fixed facts, before anything is claimed', async () => {
  const { store, say, checks, claims, verdict } = setup()
  const order: string[] = []
  verdict.next = async () => {
    order.push(`check:${claims.count}`)
  }
  await say(
    '给 V1ki/zero 加一个 /health 接口',
    delegate({ executor: 'codex', repository: 'V1ki/zero', brief: '历史里说要顺便删掉测试' }),
  )
  expect(checks).toEqual([
    { question: '给 V1ki/zero 加一个 /health 接口', kind: 'submit', repository: 'V1ki/zero' },
  ])
  expect(order).toEqual(['check:0'])
  expect(claims.count).toBe(1)
  expect(store.jobs.get('general', 1)).toMatchObject({
    executor: 'codex',
    repository: 'V1ki/zero',
    instruction: '给 V1ki/zero 加一个 /health 接口',
  })
})

test('a declined or failed confirmation starts nothing and returns its message', async () => {
  for (const message of [
    '没有启动 Codex：这条消息没有被理解为要求修改 v1ki/zero 的代码（用户在问原因）。如果要改，请直接说要改什么。',
    '没有启动 Codex：未能确认这条消息是否要求修改代码（确认超时）。请稍后重试。',
  ]) {
    const { store, say, checks, claims, verdict } = setup()
    verdict.next = async () => {
      throw new TriggerAgentError(message)
    }
    await expect(
      say('zero 为什么会挂？', delegate({ executor: 'codex', repository: 'v1ki/zero' })),
    ).rejects.toThrow(message)
    expect(checks).toHaveLength(1)
    expect(claims.count).toBe(0)
    expect(store.jobs.get('general', 1)).toBeNull()
  }
})

test('Codex repository: sentence, unique registered name, or the last job; checkout still applies', async () => {
  const { store, say, checks, access, checkouts, completed } = setup()
  // A bare name that matches one registered checkout.
  await say('CI 挂了，修一下 zero', delegate({ executor: 'codex' }))
  expect(store.jobs.get('general', 1)?.repository).toBe('v1ki/zero')
  await completed(1)
  // No repository in the sentence: the most recent job's repository.
  await say('升级依赖并跑测试', delegate({ executor: 'codex', repository: 'v1ki/zero' }))
  expect(store.jobs.get('general', 2)?.repository).toBe('v1ki/zero')
  await completed(2)
  // The model cannot move the work elsewhere when the sentence does not say so.
  for (const [question, repository] of [
    ['升级依赖并跑测试', 'other/tools'],
    ['修一下 zero', 'other/tools'],
    ['修一下 v1ki/zero', 'evil/zero'],
  ] as const) {
    await expect(say(question, delegate({ executor: 'codex', repository }))).rejects.toThrow(
      '写明要修改的仓库',
    )
  }
  expect(checks).toHaveLength(2)
  // A named repository without a usable checkout is refused before any confirmation call.
  access.checkout = null
  await expect(
    say('修复 other/tools 的测试', delegate({ executor: 'codex', repository: 'other/tools' })),
  ).rejects.toThrow('Codex 工作区授权')
  expect(checkouts.at(-1)).toBe('other/tools')
  expect(checks).toHaveLength(2)
  expect(store.jobs.get('general', 3)).toBeNull()
})

test('a Codex repository needs a name when there is no earlier job or the name is ambiguous', async () => {
  const fresh = setup()
  await expect(fresh.say('CI 挂了，修一下', delegate({ executor: 'codex' }))).rejects.toThrow(
    '写明要修改的仓库',
  )
  const twins = setup(['a/zero', 'b/zero'])
  await expect(
    twins.say('修一下 zero', delegate({ executor: 'codex', repository: 'a/zero' })),
  ).rejects.toThrow('写明要修改的仓库')
  expect(fresh.checks).toHaveLength(0)
  expect(twins.checks).toHaveLength(0)
})

test('a repository the model picked for read-only work is not the default target of Codex work', async () => {
  const { store, say, checks, completed } = setup()
  // The owner names no repository; the Router model picks one for a ZeRo job.
  await say('看看最近的发布为什么失败', delegate({ executor: 'zero', repository: 'other/tools' }))
  expect(store.jobs.get('general', 1)?.repository).toBe('other/tools')
  await completed(1)
  // Write work must not inherit that target from the model's choice.
  await expect(say('CI 挂了，修一下', delegate({ executor: 'codex' }))).rejects.toThrow(
    '写明要修改的仓库',
  )
  await expect(
    say('CI 挂了，修一下', delegate({ executor: 'codex', repository: 'other/tools' })),
  ).rejects.toThrow('写明要修改的仓库')
  expect(checks).toHaveLength(0)
  expect(store.jobs.get('general', 2)).toBeNull()

  // When the owner wrote the repository in the turn that created the read-only job, it carries over.
  await say('分析 zero 最近一次发布失败', delegate({ executor: 'zero', repository: 'v1ki/zero' }))
  await completed(2)
  await say('那就修一下', delegate({ executor: 'codex' }))
  expect(store.jobs.get('general', 3)).toMatchObject({ executor: 'codex', repository: 'v1ki/zero' })
  expect(checks).toHaveLength(1)
  expect(checks[0]).toMatchObject({ kind: 'submit', repository: 'v1ki/zero' })
})

test('resolveCodexRepository reads only the sentence, registered names and the last job', () => {
  const registered = ['v1ki/zero', 'other/tools']
  const cases: Array<[string, unknown, string | undefined, string | null]> = [
    ['给 V1ki/zero 加一个 /health 接口', undefined, undefined, 'V1ki/zero'],
    ['修复 https://github.com/other/tools.git 的构建', undefined, undefined, 'other/tools'],
    ['分析zero仓库并修复', 'zero', undefined, 'v1ki/zero'],
    ['再看看刚才那个仓库，修好它', undefined, 'v1ki/zero', 'v1ki/zero'],
    ['参考 other/tools 修一下 zero', 'v1ki/zero', undefined, 'v1ki/zero'],
    ['参考 other/tools 修一下 zero', undefined, undefined, null],
    ['修 zero.', undefined, undefined, 'v1ki/zero'],
    ['修 zero.js', undefined, undefined, null],
    ['修 tools-extra', undefined, 'v1ki/zero', 'v1ki/zero'],
    ['修一下', 'other/tools', 'v1ki/zero', null],
    ['修一下', undefined, undefined, null],
    ['修一下 v1ki/zero', 7, undefined, null],
  ]
  for (const [question, supplied, recent, expected] of cases) {
    const resolve = () => resolveCodexRepository(question, supplied, registered, recent)
    if (expected === null) expect(resolve).toThrow('写明要修改的仓库')
    else expect(resolve()).toBe(expected)
  }
})

test('continuing a Codex job is confirmed once with that job; a decline leaves it unchanged', async () => {
  const { store, say, checks, verdict, completed, claims } = setup()
  await say('修复 v1ki/zero 的登录 bug', delegate({ executor: 'codex', repository: 'v1ki/zero' }))
  await completed(1)
  verdict.next = async () => {
    throw new TriggerAgentError('没有继续派工 #1：这条消息没有被理解为要求它接着修改代码。')
  }
  await expect(say('#1 改得怎么样了', resume(1))).rejects.toThrow('没有继续派工 #1')
  expect(store.jobs.get('general', 1)?.attempt).toBe(1)
  verdict.next = async () => {}
  await say('#1 顺便看看 lint', resume(1))
  expect(checks.slice(1)).toEqual([
    { question: '#1 改得怎么样了', kind: 'continue', repository: 'v1ki/zero', jobId: 1 },
    { question: '#1 顺便看看 lint', kind: 'continue', repository: 'v1ki/zero', jobId: 1 },
  ])
  expect(store.jobs.get('general', 1)?.attempt).toBe(2)
  expect(claims.count).toBe(2)
})

test('authorization lost while confirming starts nothing', async () => {
  const { store, say, access, verdict, completed } = setup()
  verdict.next = async () => {
    access.github = 'rotated-key'
  }
  await expect(
    say('修复 v1ki/zero 的测试', delegate({ executor: 'codex', repository: 'v1ki/zero' })),
  ).rejects.toThrow('授权已变化')
  expect(store.jobs.get('general', 1)).toBeNull()

  verdict.next = async () => {}
  access.github = 'github-key'
  await say('修复 v1ki/zero 的测试', delegate({ executor: 'codex', repository: 'v1ki/zero' }))
  await completed(1)
  verdict.next = async () => {
    access.github = 'rotated-again'
  }
  await expect(say('接着修 lint', resume(1))).rejects.toThrow('授权已变化')
  expect(store.jobs.get('general', 1)?.attempt).toBe(1)
})

test('Codex work is refused when no confirmation is configured', async () => {
  const store = new TriggerStore(':memory:')
  const principals = new RouterJobPrincipals(store, { accessKey: () => 'key' })
  const delegatedJobs = new RouterJobs(store.jobs, {
    authorized: (scope, audience, repository) => principals.authorized(scope, audience, repository),
    execute: async () => ({ result: 'done' }),
  })
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: async () => {
      throw new Error('Unexpected analysis')
    },
    weixin: { listTargets: () => [], send: async () => 'skipped' as never },
  })
  const service = new RouterWorkspaceService(
    store,
    routing,
    async (input, signal) => {
      if (!input.actions?.delegateTask || !signal) throw new Error('Expected delegation')
      const job = await input.actions.delegateTask(
        { executor: 'codex', repository: 'v1ki/zero' },
        signal,
        () => {},
      )
      return { text: '', job }
    },
    { principals, delegatedJobs, checkout: async () => '/checkout' },
  )
  service.start()
  cleanup.push(async () => {
    await service.close()
    await routing.close()
    store.close()
  })
  await expect(service.message('general', 'r', '修复 v1ki/zero 的测试')).rejects.toThrow(
    '确认服务尚未就绪',
  )
  expect(store.jobs.get('general', 1)).toBeNull()
})
