import { describe, expect, mock, test } from 'bun:test'
import type { TriggerGithubRepository } from '@zero-os/shared'
import { GithubWebhookPayloadError, normalizeGithubWebhook, pollGithub } from '../github'

const repo: TriggerGithubRepository = {
  name: 'Sample/Project',
  branch: 'main',
  workflow: '.github/workflows/release.yml',
  mention: 'zero[bot]',
  enabled: true,
  workflowFailures: true,
}
const repository = { id: 15, full_name: 'sample/project' }
const time = new Date().toISOString()
const signal = new AbortController().signal
const run = {
  id: 203,
  repository,
  run_attempt: 2,
  name: 'Release',
  path: repo.workflow,
  status: 'completed',
  conclusion: 'failure',
  head_branch: 'main',
  created_at: time,
  updated_at: time,
}
const completed = { repository, action: 'completed', workflow_run: run }
const comment = {
  id: 405,
  body: '请 @ZERO[bot] 看一下',
  user: { login: 'reviewer' },
  created_at: time,
  html_url: 'https://github.com/sample/project/pull/72#issuecomment-405',
}
const mentioned = {
  repository,
  action: 'created',
  issue: {
    number: 72,
    pull_request: { url: 'https://api.github.com/repos/sample/project/pulls/72' },
  },
  comment,
}
function unexpected(): never {
  throw new Error('Unexpected token lookup or network request')
}
const map = (event: string, body: unknown, settings = repo) =>
  normalizeGithubWebhook(settings, event, body, unexpected, signal, unexpected)

describe('GitHub native push event mapping', () => {
  test('webhook and polling yield identical distinct IDs, content and scope', async () => {
    const fetcher = mock(async (url: URL, init: RequestInit) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer local-fixture')
      expect(url.origin).toBe('https://api.github.com')
      switch (url.pathname) {
        case '/repos/Sample/Project':
          return Response.json(repository)
        case '/repos/Sample/Project/actions/runs':
          return Response.json({ workflow_runs: [run] })
        case '/repos/Sample/Project/issues/comments':
          return Response.json([comment])
        case '/repos/Sample/Project/pulls/72':
          return Response.json({ base: { ref: 'main', repo: repository } })
        default:
          return unexpected()
      }
    })
    const pushedFailure = await map('workflow_run', completed)
    const pushedMention = await normalizeGithubWebhook(
      repo,
      'issue_comment',
      mentioned,
      async () => 'local-fixture',
      signal,
      fetcher,
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
    const polled = await pollGithub(repo, null, 'local-fixture', signal, time, fetcher)
    expect([...pushedFailure, ...pushedMention]).toEqual(polled.events)
    expect(polled.events.map((e) => e.eventId)).toEqual(['15:run:203:2:failure', '15:comment:405'])
  })

  test('repository identity, path, attempt and timestamp validations fail closed', async () => {
    for (const payload of [
      { ...completed, repository: { ...repository, full_name: 'elsewhere/project' } },
      { ...completed, repository: { ...repository, id: '15' } },
      { ...completed, workflow_run: { ...run, repository: { id: 99 } } },
      { ...completed, workflow_run: { ...run, path: null } },
      { ...completed, workflow_run: { ...run, run_attempt: -1 } },
      { ...completed, workflow_run: { ...run, updated_at: 'yesterday' } },
      { ...completed, workflow_run: { ...run, updated_at: '1' } },
    ]) {
      await expect(map('workflow_run', payload)).rejects.toBeInstanceOf(GithubWebhookPayloadError)
    }
  })

  test('filters action, workflow, branch, conclusion, disabled listeners and native ping', async () => {
    expect(await map('ping', { repository })).toEqual([])
    expect(await map('pull_request_review_comment', { repository })).toEqual([])
    expect(await map('workflow_run', { ...completed, action: 'requested' })).toEqual([])
    for (const patch of [
      { head_branch: 'other' },
      { status: 'queued' },
      { conclusion: 'success' },
      { conclusion: null },
      { path: '.github/workflows/other.yml' },
    ])
      expect(
        await map('workflow_run', { ...completed, workflow_run: { ...run, ...patch } }),
      ).toEqual([])
    expect(await map('workflow_run', completed, { ...repo, enabled: false })).toEqual([])
    expect(await map('workflow_run', completed, { ...repo, workflowFailures: false })).toEqual([])
    const [unnamed] = await map('workflow_run', {
      ...completed,
      workflow_run: { ...run, name: null },
    })
    expect(unnamed.title).toContain(run.path)
  })

  test('only PR discussions containing the exact mention can trigger a branch lookup', async () => {
    expect(await map('issue_comment', { ...mentioned, issue: { number: 72 } })).toEqual([])
    expect(await map('issue_comment', { ...mentioned, action: 'edited' })).toEqual([])
    expect(await map('issue_comment', mentioned, { ...repo, mention: '' })).toEqual([])
    for (const body of ['x@zero[bot]', 'hello @zero[bot]-copy', 'hello @zero']) {
      expect(await map('issue_comment', { ...mentioned, comment: { ...comment, body } })).toEqual(
        [],
      )
    }
    expect(await map('issue_comment', mentioned, { ...repo, mention: 'zero' })).toEqual([])
    const [event] = await map('issue_comment', mentioned, { ...repo, branch: '' })
    expect(event.url).toBe('https://github.com/Sample/Project/pull/72#issuecomment-405')
    for (const [branch, repositoryId, expected] of [
      ['other', 15, 'filtered'],
      ['main', 99, 'changed'],
    ] as const) {
      const result = normalizeGithubWebhook(
        repo,
        'issue_comment',
        mentioned,
        () => undefined,
        signal,
        async () => Response.json({ base: { ref: branch, repo: { id: repositoryId } } }),
      )
      if (expected === 'filtered') expect(await result).toEqual([])
      else await expect(result).rejects.toThrow('identity changed')
    }
    await expect(
      normalizeGithubWebhook(
        repo,
        'issue_comment',
        mentioned,
        () => undefined,
        signal,
        async () => new Response(null, { status: 503 }),
      ),
    ).rejects.toThrow('GitHub HTTP 503')
  })
})
