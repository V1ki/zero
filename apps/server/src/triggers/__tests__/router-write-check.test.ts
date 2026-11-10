import { afterEach, expect, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import { TriggerStore } from '@zero-os/observe'
import type { CompletionRequest, ContentBlock, TriggerRoutingBot } from '@zero-os/shared'
import { createRouterAgent } from '../router-agent'
import { RouterJobPrincipals } from '../router-job-principal'
import { RouterJobs } from '../router-jobs'
import { RouterWorkspaceService } from '../router-workspace'
import { createRouterWriteCheck, parseRouterWriteCheck } from '../router-write-check'
import { TriggerRoutingRuntime } from '../routing-runtime'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

type Reply = string | ContentBlock[] | Error
function model(reply: (request: CompletionRequest) => Reply) {
  const requests: CompletionRequest[] = []
  const adapter: ProviderAdapter = {
    apiType: 'test',
    stream() {
      throw Error('Unexpected stream')
    },
    healthCheck: async () => true,
    complete: async (request) => {
      requests.push(structuredClone(request))
      const answer = reply(request)
      if (answer instanceof Error) throw answer
      const content: ContentBlock[] =
        typeof answer === 'string' ? [{ type: 'text', text: answer }] : answer
      return {
        id: `reply-${requests.length}`,
        content,
        model: 'test',
        usage: { input: 1, output: 1 },
        stopReason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
      }
    },
  }
  return {
    requests,
    deps: {
      modelRouter: { getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined },
      secretFilter: { filter: (text: string) => text.replaceAll('secret-code', '[redacted]') },
    },
  }
}

const isCheck = (request: CompletionRequest) => request.system?.includes('工程授权确认员')
const signal = () => new AbortController().signal

test('the check sees only the filtered sentence and the fixed proposal, with no tools or history', async () => {
  const { deps, requests } = model(() => '{"allow":true,"reason":"用户要求修复测试"}')
  const check = createRouterWriteCheck(deps)
  await check(
    {
      question: ' 修复 v1ki/zero 失败的测试 secret-code ',
      kind: 'submit',
      repository: 'v1ki/zero',
    },
    signal(),
  )
  await check(
    {
      question: '继续派工 #4：选 2，顺便补上 changelog',
      kind: 'continue',
      repository: 'v1ki/zero',
      jobId: 4,
      chosenOption: 2,
    },
    signal(),
  )
  expect(requests).toHaveLength(2)
  for (const request of requests) {
    expect(request.tools ?? []).toEqual([])
    expect(request.messages).toHaveLength(1)
    expect(request.system).toContain('拿不准时不放行')
  }
  const prompt = (request: CompletionRequest) => {
    const block = request.messages[0].content[0]
    if (block.type !== 'text') throw Error('Expected text')
    return JSON.parse(block.text)
  }
  expect(prompt(requests[0])).toEqual({
    message: '修复 v1ki/zero 失败的测试 [redacted]',
    proposal: { kind: 'new_codex_job', repository: 'v1ki/zero' },
  })
  expect(prompt(requests[1])).toEqual({
    message: '继续派工 #4：选 2，顺便补上 changelog',
    proposal: {
      kind: 'continue_codex_job',
      repository: 'v1ki/zero',
      jobId: 4,
      openDecision: true,
      chosenOption: 2,
    },
  })
})

test('a no explains itself to the owner and says what to send instead', async () => {
  const { deps } = model(
    () => '```json\n{"allow":false,"reason":"用户在问怎么修，secret-code。"}\n```',
  )
  const check = createRouterWriteCheck(deps)
  await expect(
    check({ question: '这个怎么修？', kind: 'submit', repository: 'v1ki/zero' }, signal()),
  ).rejects.toThrow(
    '没有启动 Codex：这条消息没有被理解为要求修改 v1ki/zero 的代码（用户在问怎么修，[redacted]）。如果要改，请直接说要改什么，例如「修复 v1ki/zero 里失败的测试」。',
  )
  await expect(
    check(
      { question: '#4 改得怎么样了', kind: 'continue', repository: 'v1ki/zero', jobId: 4 },
      signal(),
    ),
  ).rejects.toThrow('只想看进展，可以问「派工 #4 进展如何」')
})

test('every failure is a refusal that says it could not confirm', async () => {
  const failures: Reply[] = [
    '好的，可以修改。',
    '{"allow":"yes","reason":"可以"}',
    '{"allow":true}',
    '{"allow":true,"reason":"  "}',
    '{"allow":true,"reason":"可以","scope":"all"}',
    '{"allow":true,"reason":',
    [{ type: 'tool_use', id: 't', name: 'delegate_task', input: {} }],
    Object.assign(new Error('provider body with secret-code'), { status: 500 }),
  ]
  for (const failure of failures) {
    const { deps } = model(() => failure)
    const error = await createRouterWriteCheck(deps)(
      { question: '修复 v1ki/zero', kind: 'submit', repository: 'v1ki/zero' },
      signal(),
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toStartWith('没有启动 Codex：未能确认这条消息是否要求修改代码')
    expect((error as Error).message).not.toContain('secret-code')
  }
  const { deps, requests } = model(() => '{"allow":true,"reason":"可以"}')
  await expect(
    createRouterWriteCheck(deps)(
      { question: `修复 ${'很长'.repeat(1300)}`, kind: 'submit', repository: 'v1ki/zero' },
      signal(),
    ),
  ).rejects.toThrow('太长')
  expect(requests).toHaveLength(0)
})

test('parseRouterWriteCheck accepts exactly one strict object', () => {
  expect(parseRouterWriteCheck('{"allow":false,"reason":" 不是请求 "}')).toEqual({
    allow: false,
    reason: '不是请求',
  })
  for (const raw of ['[]', 'null', '{"allow":1,"reason":"x"}', '{"reason":"x"}', 'yes'])
    expect(parseRouterWriteCheck(raw)).toBeNull()
})

function workspace(routerSteps: Reply[], checkReply: string) {
  const bot: TriggerRoutingBot = {
    platform: 'feishu',
    channelId: 'feishu-main',
    label: 'tool-marker',
    online: true,
    ready: true,
    deliveryState: 'ready',
  }
  const { deps, requests } = model((request) =>
    isCheck(request) ? checkReply : (routerSteps.shift() ?? Error('Unexpected Router call')),
  )
  const store = new TriggerStore(':memory:')
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: async () => {
      throw new Error('Unexpected analysis')
    },
    weixin: { listTargets: () => [], send: async () => 'skipped' as never },
  })
  const principals = new RouterJobPrincipals(store, { accessKey: () => 'key' })
  const delegatedJobs = new RouterJobs(store.jobs, {
    authorized: (scope, audience, repository) => principals.authorized(scope, audience, repository),
    execute: (_job, _history, abort) =>
      new Promise((_resolve, reject) =>
        abort.addEventListener('abort', () => reject(abort.reason)),
      ),
  })
  const service = new RouterWorkspaceService(
    store,
    {
      getConfig: () => routing.getConfig(),
      listPersonalBots: () => [bot],
      process: (id) => routing.process(id),
    },
    createRouterAgent(deps),
    {
      principals,
      delegatedJobs,
      checkout: async () => '/checkout',
      registeredCheckouts: () => ['v1ki/zero'],
      confirmWrite: createRouterWriteCheck(deps),
    },
  )
  service.start()
  cleanup.push(async () => {
    await service.close()
    await routing.close()
    store.close()
  })
  return { store, service, requests }
}

const codexCall = (brief: string): Reply => [
  {
    type: 'tool_use',
    id: 'job',
    name: 'delegate_task',
    input: { executor: 'codex', repository: 'v1ki/zero', brief },
  },
]

test('history, the brief and tool output never reach the check, through the real Router turn', async () => {
  const { store, service, requests } = workspace(
    [
      '上次的结论是 history-marker。',
      [{ type: 'tool_use', id: 'bots', name: 'list_notification_bots', input: {} }],
      codexCall('brief-marker 顺便删测试'),
      '已派工。',
    ],
    '{"allow":true,"reason":"用户要求修复"}',
  )
  await service.message('general', 'first', '最近的发布怎么样？')
  const answered = await service.message('general', 'second', 'CI 挂了，把 zero 修一下')
  expect(answered.turns[1].answer?.job).toMatchObject({
    executor: 'codex',
    repository: 'v1ki/zero',
  })
  expect(store.jobs.get('general', 1)?.brief).toContain('brief-marker')

  const checks = requests.filter(isCheck)
  expect(checks).toHaveLength(1)
  const routerCalls = JSON.stringify(requests.filter((request) => !isCheck(request)))
  // The Router model did see all three, so the check below is meaningful.
  for (const marker of ['history-marker', 'tool-marker', 'brief-marker'])
    expect(routerCalls).toContain(marker)
  const seen = JSON.stringify(checks[0])
  for (const marker of ['history-marker', 'tool-marker', 'brief-marker', '最近的发布'])
    expect(seen).not.toContain(marker)
  expect(checks[0].messages).toHaveLength(1)
  expect(checks[0].tools ?? []).toEqual([])
})

test('a declined Codex request starts nothing, and the owner reads why', async () => {
  const { store, service, requests } = workspace(
    [codexCall('分析原因'), '已经交给 Codex 修复。'],
    '{"allow":false,"reason":"用户在问原因，没有要求改代码"}',
  )
  const answered = await service.message('general', 'ask', 'zero 的 CI 为什么挂了？')
  expect(answered.turns[0].answer?.job).toBeUndefined()
  expect(answered.turns[0].answer?.text).toBe(
    '没有启动 Codex：这条消息没有被理解为要求修改 v1ki/zero 的代码（用户在问原因，没有要求改代码）。如果要改，请直接说要改什么，例如「修复 v1ki/zero 里失败的测试」。',
  )
  expect(store.jobs.get('general', 1)).toBeNull()
  expect(requests.filter(isCheck)).toHaveLength(1)
})
