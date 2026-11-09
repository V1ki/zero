import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import { type RouterJob, RouterLedgerStore } from '@zero-os/observe'
import type { CompletionResponse } from '@zero-os/shared'
import { readRouterLatestFailure } from '../github'
import { createRouterJobExecutor } from '../router-job-executors'
import { RouterJobExecutionUncertainError } from '../router-jobs'
import { createRouterTraceSink } from '../router-trace'

const signal = new AbortController().signal
const job: RouterJob = {
  id: 7,
  scope: 'general',
  requestId: 'question2',
  executor: 'zero',
  instruction: '核对发布失败的原因',
  repository: 'owner/second',
  audience: null,
  status: 'running',
  attempt: 2,
  result: null,
  threadId: null,
  createdAt: '',
  updatedAt: '',
}
const answer = (content: CompletionResponse['content'], tools = false): CompletionResponse => ({
  content,
  id: 'res',
  model: 'test',
  stopReason: tools ? 'tool_use' : 'end_turn',
  usage: { input: 15, output: 12 },
})
function model(complete: ProviderAdapter['complete']) {
  const adapter: ProviderAdapter = {
    apiType: 'test',
    complete,
    stream() {
      throw Error('unexpected')
    },
    healthCheck: async () => true,
  }
  return { getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined }
}
const unreachable = (): never => {
  throw Error('unexpected worker')
}
const filter = { filter: (s: string) => s.replaceAll('private-token', '[redacted]') }

test('task AgentLoop uses only the selected repo and same-task history, retains scoped facts for its reply', async () => {
  let turns = 0
  let lookups = 0
  const execute = createRouterJobExecutor({
    modelRouter: model(async (req) => {
      turns++
      expect(req.meta?.sessionId).toBe('router-job-7')
      expect(req.tools?.map((t) => t.name)).toEqual(['inspect_latest_github_failure'])
      const payload = JSON.stringify(req.messages)
      expect(payload).not.toContain('private-token')
      expect(payload).not.toContain('foreign task')
      expect(payload).toContain('prior result')
      if (turns === 1)
        return answer(
          [
            {
              type: 'tool_use',
              name: 'inspect_latest_github_failure',
              id: 'call1',
              input: { workflowFile: 'release.yml' },
            },
          ],
          true,
        )
      expect(payload).toContain('failure in publish step')
      return answer([{ type: 'text', text: 'publish 步骤失败 private-token' }])
    }),
    secretFilter: filter,
    codex: { runRouterJob: unreachable },
    workspaceForRepository: unreachable,
    latestFailure: async (j, repo, s, file) => {
      expect(j.id).toBe(7)
      expect(repo).toBe('owner/second')
      expect(s.aborted).toBe(false)
      expect(file).toBe('release.yml')
      lookups++
      return { step: 'failure in publish step', diagnostic: 'private-token' }
    },
  })
  expect(
    await execute(
      job,
      [
        { ...job, id: 8, attempt: 1, result: 'foreign task' },
        { ...job, attempt: 1, result: 'prior result' },
      ],
      signal,
    ),
  ).toEqual({ result: 'publish 步骤失败 [redacted]' })
  expect([turns, lookups]).toEqual([2, 1])
})

test('a failed authorized read cannot be reported as a successful investigation', async () => {
  let turns = 0
  const execute = createRouterJobExecutor({
    modelRouter: model(async () =>
      ++turns === 1
        ? answer(
            [{ type: 'tool_use', id: 'call1', name: 'inspect_latest_github_failure', input: {} }],
            true,
          )
        : answer([{ type: 'text', text: 'pretends success' }]),
    ),
    secretFilter: filter,
    workspaceForRepository: unreachable,
    codex: { runRouterJob: unreachable },
    latestFailure: async () => {
      throw Error('secret transport payload')
    },
  })
  await expect(execute(job, [], signal)).rejects.toThrow('Actions 读取权限')
})

test('Codex receives only configured working directory, task prompt and its own resume identity', async () => {
  let cwd = '/trusted/checkout'
  let calls = 0
  const execute = createRouterJobExecutor({
    modelRouter: model(unreachable),
    secretFilter: filter,
    latestFailure: unreachable,
    workspaceForRepository: async (j, repo) => {
      expect(repo).toBe('owner/second')
      expect(j.scope).toBe('general')
      return cwd
    },
    codex: {
      async runRouterJob(input) {
        expect(Object.keys(input).sort()).toEqual(
          [
            'instruction',
            'resumeThreadId',
            'onThreadReady',
            'sessionId',
            'signal',
            'workingDirectory',
          ].sort(),
        )
        expect(input.workingDirectory).toBe(cwd)
        expect(input.resumeThreadId).toBe(calls++ ? 'actual-thread-id' : undefined)
        return { result: 'finished private-token', threadId: 'actual-thread-id' }
      },
    },
  })
  const engineering = { ...job, executor: 'codex' as const }
  const initial = await execute(engineering, [], signal)
  expect(initial.result).toBe('finished [redacted]')
  expect(initial.threadId).toBeString()
  const continued = { ...engineering, threadId: initial.threadId ?? null }
  await execute(continued, [], signal)
  cwd = '/other/checkout'
  await expect(execute(continued, [], signal)).rejects.toThrow('工作区授权已更换')
  await expect(execute({ ...continued, threadId: 'supplied-by-IM' }, [], signal)).rejects.toThrow(
    '工作区授权已更换',
  )
  expect(calls).toBe(2)
})

test('unmapped checkout denies execution; unexpected post-start error is outcome unknown', async () => {
  const dependencies = {
    modelRouter: model(unreachable),
    secretFilter: filter,
    latestFailure: unreachable,
    codex: { runRouterJob: unreachable },
  }
  const codex = { ...job, executor: 'codex' as const }
  await expect(
    createRouterJobExecutor({ ...dependencies, workspaceForRepository: async () => null })(
      codex,
      [],
      signal,
    ),
  ).rejects.toThrow('未授权')
  await expect(
    createRouterJobExecutor({ ...dependencies, workspaceForRepository: async () => '/checkout' })(
      codex,
      [],
      signal,
    ),
  ).rejects.toBeInstanceOf(RouterJobExecutionUncertainError)
})

test('GitHub failure lookup pins repo, run attempt and optional workflow; returns bounded job facts', async () => {
  const paths: string[] = []
  const fetcher = async (url: URL, init: RequestInit) => {
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token')
    paths.push(url.pathname)
    if (url.pathname.endsWith('/runs'))
      return Response.json({
        workflow_runs: [
          {
            id: 55,
            run_attempt: 2,
            repository: { full_name: 'Owner/Second' },
            conclusion: 'failure',
            status: 'completed',
            name: '发布',
            path: '.github/workflows/release.yml',
            head_branch: 'main',
            updated_at: '2026-11-01T01:00:00Z',
          },
        ],
      })
    return Response.json({
      total_count: 1,
      jobs: [
        {
          id: 77,
          run_id: 55,
          run_attempt: 2,
          name: 'npm',
          conclusion: 'failure',
          steps: [{ number: 3, name: 'publish', conclusion: 'failure' }],
        },
      ],
    })
  }
  const result = await readRouterLatestFailure(
    'owner/second',
    'test-token',
    signal,
    fetcher,
    'release.yml',
  )
  expect(result.latestFailure?.url).toBe(
    'https://github.com/owner/second/actions/runs/55/attempts/2',
  )
  expect(result.latestFailure?.facts[1]).toMatchObject({ label: 'npm', value: '步骤 3 · publish' })
  expect(paths).toEqual([
    '/repos/owner/second/actions/workflows/release.yml/runs',
    '/repos/owner/second/actions/runs/55/attempts/2/jobs',
  ])
  await expect(
    readRouterLatestFailure('somewhere/else', 'test-token', signal, fetcher),
  ).rejects.toThrow('授权范围')
  await expect(
    readRouterLatestFailure('owner/second', 'test-token', signal, unreachable, '../foreign.yml'),
  ).rejects.toThrow('无效的工作流')
  await expect(readRouterLatestFailure('owner/second', '', signal, unreachable)).rejects.toThrow(
    '凭据不可用',
  )
})

test('engineering handoff includes current matter and full scoped history before saving its thread', async () => {
  const priorResult = `已排除原因：${'证据'.repeat(9000)}\n下一步验证边界`
  const context = {
    matter: {
      goal: '核查真实性',
      criteria: ['实际验证'],
      version: 4,
      context: { revoked: '不要发布', evidence: ['原始资料 private-token'] },
    },
  }
  let savedThread: string | undefined
  const execute = createRouterJobExecutor({
    modelRouter: model(unreachable),
    secretFilter: filter,
    latestFailure: unreachable,
    workspaceForRepository: async () => '/trusted/checkout',
    capabilitiesFor: async () => ({ context, capabilities: [] }),
    codex: {
      async runRouterJob(input) {
        const payload = JSON.parse(input.instruction.slice(input.instruction.indexOf('\n{') + 1))
        expect(payload.context.matter).toMatchObject({ goal: '核查真实性', version: 4 })
        expect(payload.context.matter.context.revoked).toBe('不要发布')
        expect(payload.earlierSteps).toHaveLength(1)
        expect(payload.earlierSteps[0].result).toBe(priorResult)
        expect(input.instruction).not.toContain('private-token')
        expect(input.instruction).not.toContain('其他人私聊')
        input.onThreadReady?.('durable-thread')
        expect(savedThread).toEndWith('.durable-thread')
        throw new Error('connection lost after thread creation')
      },
    },
  })
  await expect(
    execute(
      { ...job, executor: 'codex' },
      [
        { ...job, attempt: 1, result: priorResult },
        { ...job, attempt: 1, scope: `im-${'b'.repeat(64)}`, result: '其他人私聊' },
      ],
      signal,
      (id) => {
        savedThread = id
      },
    ),
  ).rejects.toBeInstanceOf(RouterJobExecutionUncertainError)
  expect(savedThread).toEndWith('.durable-thread')
})

test('failed native executions retain linked, redacted host requests without fabricating a model request', async () => {
  const db = new Database(':memory:')
  try {
    const ledger = new RouterLedgerStore(db)
    const matter = ledger.createMatter('owner', '核对记录', '查原文', ['给出编号'])
    ledger.bindWorker({
      jobId: job.id,
      principal: 'owner',
      matterId: matter.id,
      scope: 'general',
      audience: 'fixture',
      eventIds: [],
      authority: 'user',
    })
    const execute = createRouterJobExecutor({
      modelRouter: { ...model(unreachable), trace: createRouterTraceSink(ledger, filter.filter) },
      secretFilter: filter,
      workspaceForRepository: async () => '/fixture',
      latestFailure: unreachable,
      codex: {
        async runRouterJob(input) {
          input.onThreadReady?.('native-id')
          input.onPublicEvent?.('turn/start', {
            threadId: 'native-id',
            input: [{ text: input.instruction }],
          })
          input.onPublicEvent?.('item/completed', {
            type: 'commandExecution',
            aggregatedOutput: 'evidence private-token',
          })
          throw Error('fixture failure private-token')
        },
      },
    })
    await expect(execute({ ...job, executor: 'codex' }, [], signal)).rejects.toBeInstanceOf(
      RouterJobExecutionUncertainError,
    )
    const [run] = ledger.listRuns({ matterId: matter.id, workerId: job.id })
    expect(run).toMatchObject({ matterId: matter.id, status: 'failed', sessionId: 'router-job-7' })
    expect(ledger.workerSessions('owner', matter.id)).toEqual([
      { jobId: 7, latestRunId: run.id, handoffFromJobId: null },
    ])
    const entries = ledger.entries(run.id)
    expect(entries.map((e) => e.kind)).toContain('worker_request')
    expect(entries.map((e) => e.kind)).not.toContain('model_request')
    expect(JSON.stringify(entries)).toContain('evidence [redacted]')
    expect(JSON.stringify(entries)).not.toContain('private-token')
  } finally {
    db.close()
  }
})
