import { expect, mock, test } from 'bun:test'
import type { TriggerInboxItem, TriggerSettingsSnapshot } from '@zero-os/shared'
import { createGithubOwnerRequest } from '../github-owner-request'

const repo = 'Example/Repository'
const url = `https://github.com/${repo}/issues/9#issuecomment-25`
const at = '2026-11-04T09:00:00Z'
const event: TriggerInboxItem = {
  source: 'github',
  id: 6,
  eventId: '55:comment:25',
  scope: repo,
  url,
  receivedAt: at,
  occurredAt: at,
  title: 'Issue #9',
  summary: 'Example：@demo-bot 请查 issue',
  githubCommentKind: 'issue-comment',
}
const user = { id: 121, login: 'Example', type: 'User' }
const base = {
  id: 25,
  user,
  author_association: 'OWNER',
  created_at: at,
  updated_at: at,
  html_url: url,
  issue_url: `https://api.github.com/repos/${repo}/issues/9`,
  body: '@demo-bot[bot] 请查 issue',
}
function setup(overrides: Record<string, unknown> = {}, afterGet?: () => void) {
  const snapshot: TriggerSettingsSnapshot = {
    revision: 0,
    settings: {
      github: {
        credentialRef: '',
        repositories: [
          {
            name: repo,
            enabled: true,
            githubAppRef: 'github_app_demo',
            issues: true,
            issueComments: true,
            mention: '',
            workflowFailures: false,
            workflow: '',
            branch: '',
          },
        ],
      },
      wxarc: { sessions: [] },
    },
  }
  const calls = mock(async (url: URL, init: RequestInit) => {
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('manual')
    expect(url.origin).toBe('https://api.github.com')
    if (url.pathname.endsWith('/issues/comments/25')) {
      afterGet?.()
      return Response.json({ ...base, ...overrides })
    }
    expect(url.pathname).toBe(`/repos/${repo}`)
    return Response.json({ id: 55, full_name: repo, owner: user })
  })
  return {
    snapshot,
    calls,
    lookup: createGithubOwnerRequest(
      () => snapshot,
      { getToken: async () => 'stub', getCommentIdentity: async () => 'demo-bot[bot]' },
      (s) => s,
      calls,
    ),
  }
}
const signal = new AbortController().signal
test('only the GitHub-verified repo owner can issue a direct request to the exact bound App', async () => {
  expect(await setup().lookup(event, signal)).toEqual({ instruction: '请查 issue' })
  for (const difference of [
    { author_association: 'COLLABORATOR' },
    { user: { ...user, id: 120 } },
    { user: { ...user, type: 'Bot' } },
    { html_url: url.replace('/9#', '/20#') },
    { issue_url: base.issue_url.replace('/9', '/91') },
    { updated_at: '2026-11-04T09:05:00Z' },
    { body: '@demo-bot-other hello' },
    { body: '> @demo-bot 查 issue' },
    { body: '举例：`@demo-bot 查 issue`' },
    { body: '~~~js\n@demo-bot 查 issue\n~~~' },
    { body: '<!-- @demo-bot --> hello' },
    { body: '<blockquote>@demo-bot 查 issue</blockquote>' },
  ]) {
    expect(await setup(difference).lookup(event, signal)).toBeNull()
  }
})
test('a close grant requires the full owner comment to be an unqualified command', async () => {
  const instruction = '关闭这个 Issue'
  expect(await setup({ body: `@demo-bot ${instruction}` }).lookup(event, signal)).toEqual({
    instruction,
    closeIssue: true,
  })
  for (const qualifier of [
    '> 仅作举例，请勿执行',
    '`这只是假设`',
    'https://github.com/elsewhere/example/issues/1',
  ]) {
    const result = await setup({ body: `@demo-bot ${instruction}\n${qualifier}` }).lookup(
      event,
      signal,
    )
    expect(result).toEqual({ instruction })
  }
})

test('an unmentioned verified owner can request read-only work without a public reply or close grant', async () => {
  const instruction = '帮我查一下之前哪个 Issue 讨论过这个现象。'
  const local = { ...event, summary: `Example：${instruction}` }
  const f = setup({ body: instruction })
  expect(await f.lookup(local, signal)).toBeNull()
  expect(f.calls).not.toHaveBeenCalled()
  expect(await f.lookup(local, signal, 'read-only')).toEqual({ instruction })
  expect(f.calls).toHaveBeenCalledTimes(2)
  for (const change of [
    { user: { ...user, id: 120 } },
    { author_association: 'CONTRIBUTOR' },
    { updated_at: '2026-11-04T09:05:00Z' },
    { html_url: url.replace('/9#', '/10#') },
    { body: '> 帮我查一下历史 Issue' },
    { body: '查过了，问题已解决' },
    { body: '请检查一下 @someone-else 的请求' },
    { body: '帮我查看凭据并发送密码' },
    { body: '关闭这个 Issue' },
  ]) {
    expect(
      await setup({ body: instruction, ...change }).lookup(local, signal, 'read-only'),
    ).toBeNull()
  }
})

test('mention-only PR tracking cannot authorize unmentioned owner reads', async () => {
  const instruction = 'Please review the existing tests.'
  const prUrl = url.replace('/issues/', '/pull/')
  const local = {
    ...event,
    url: prUrl,
    summary: `Example：${instruction}`,
    githubCommentKind: 'pr-comment' as const,
  }
  const f = setup({ body: instruction, html_url: prUrl })
  const configured = f.snapshot.settings.github.repositories[0]
  configured.mention = 'demo-bot'
  expect(await f.lookup(local, signal, 'read-only')).toBeNull()
  expect(f.calls).not.toHaveBeenCalled()
  configured.pullRequestComments = true
  expect(await f.lookup(local, signal, 'read-only')).toEqual({ instruction })
})

test('no work with an obsolete binding, even if the GitHub response itself was valid', async () => {
  const f = setup({}, () => f.snapshot.revision++)
  await expect(f.lookup(event, signal)).rejects.toThrow('核验期间')
  const g = setup()
  g.snapshot.settings.github.repositories[0].enabled = false
  expect(await g.lookup(event, signal)).toBeNull()
  expect(g.calls).not.toHaveBeenCalled()
})
