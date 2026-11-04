import { expect, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import type { RouterJob } from '@zero-os/observe'
import type { CompletionResponse } from '@zero-os/shared'
import { readRouterLatestFailure } from '../github'
import { createRouterJobExecutor } from '../router-job-executors'
import { RouterJobExecutionUncertainError } from '../router-jobs'

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
          ['instruction', 'resumeThreadId', 'sessionId', 'signal', 'workingDirectory'].sort(),
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
