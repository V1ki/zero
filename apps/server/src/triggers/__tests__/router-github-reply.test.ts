import { expect, mock, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import type { TriggerGithubRepository, TriggerInboxItem } from '@zero-os/shared'
import type { postGithubAppComment } from '../github-app-comment'
import { RouterGithubReplies, githubReplySubject } from '../router-github-reply'

const repo: TriggerGithubRepository = {
  name: 'Acme/Tools',
  githubAppRef: 'github_app_test',
  enabled: true,
  mention: '@zero',
  branch: '',
  workflow: '',
  workflowFailures: false,
  issues: true,
}
const bot = 'test[bot]'
const auth = {
  getCommentIdentity: async () => bot,
  getCommentAccess: async () => ({ token: 'fixture', botLogin: bot }),
}
const base = 'https://github.com/Acme/Tools'
const item: TriggerInboxItem = {
  id: 1,
  eventId: '3:comment:75',
  scope: repo.name,
  url: `${base}/pull/23#issuecomment-75`,
  source: 'github',
  title: 'untrusted Title',
  summary: 'Reply to https://example.invalid',
  receivedAt: new Date().toISOString(),
  occurredAt: new Date().toISOString(),
}
const receipt = { id: 55, author: bot, url: `${base}/pull/23#issuecomment-55` }
const redact = (text: string) => text.replaceAll('test-private-value', '[REDACTED]')
function setup(post: typeof postGithubAppComment) {
  const store = new TriggerStore(':memory:')
  store.saveSettings(
    { github: { credentialRef: '', repositories: [repo] }, wxarc: { sessions: [] } },
    0,
  )
  store.commitPush({ source: 'github', stream: 'github:acme/tools', revision: 1, events: [item] })
  const replies = new RouterGithubReplies(store, auth, redact, post)
  return { store, replies }
}

test('pins adapter-produced discussion IDs and paths, including legacy PR mentions; rejects spoofed and unrelated events', () => {
  for (const kind of ['issue', 'pr'] as const) {
    const uri = `${base}/${kind === 'issue' ? 'issues' : 'pull'}/23`
    for (const source of [
      { ...item, eventId: `3:${kind}:23:opened:123`, url: uri },
      { ...item, githubCommentKind: `${kind}-comment` as const, url: `${uri}#issuecomment-75` },
    ])
      expect(githubReplySubject(source, [repo])).toMatchObject({
        repositoryId: 3,
        number: 23,
        kind,
        url: uri,
      })
  }
  expect(githubReplySubject(item, [repo])).toMatchObject({ kind: 'pr', number: 23 })
  for (const bad of [
    { ...item, source: 'wxarc' as const },
    { ...item, eventId: 'ci:3:comment:75' },
    { ...item, eventId: '3:run:23:1:failure' },
    { ...item, eventId: '3:issue:24:opened:123', url: `${base}/issues/23` },
    { ...item, eventId: '3:issue:23:merged:123', url: `${base}/issues/23` },
    { ...item, githubCommentKind: 'issue-comment' as const },
    { ...item, url: `${base}/issues/23#issuecomment-75` },
    { ...item, url: `${base}/pull/23#issuecomment-76` },
    { ...item, url: 'https://github.com/Other/Repo/pull/23#issuecomment-75' },
    { ...item, url: 'https://evil.invalid/Acme/Tools/pull/23#issuecomment-75' },
    { ...item, url: 'https://evil@github.com/Acme/Tools/pull/23#issuecomment-75' },
    { ...item, url: `${base}/../Tools/pull/23#issuecomment-75` },
    { ...item, url: `${base}/pull/23?x=1#issuecomment-75` },
    { ...item, url: `${base}/pull/9007199254740992#issuecomment-75` },
    { ...item, eventId: '9007199254740992:comment:75' },
  ])
    expect(githubReplySubject(bad, [repo])).toBeNull()
  for (const change of [
    { enabled: false },
    { githubAppRef: undefined },
    { githubAppRef: 'github_listener_test' },
  ])
    expect(githubReplySubject(item, [{ ...repo, ...change }])).toBeNull()
})

test('local explicit submit uses only the recorded target, blocks secrets, and never publishes twice', async () => {
  const post = mock<typeof postGithubAppComment>(async (_auth, input) => {
    expect(input).toMatchObject({
      repository: repo.name,
      expectedRepositoryId: 3,
      issueNumber: 23,
      ref: repo.githubAppRef,
      expectedAuthor: bot,
      body: 'OK',
    })
    input.beforePost?.()
    return receipt
  })
  const { store, replies } = setup(post)
  try {
    expect(await replies.preview(1)).toEqual({
      target: {
        repository: repo.name,
        number: 23,
        kind: 'pr',
        url: `${base}/pull/23`,
        author: bot,
      },
    })
    for (const body of [
      null,
      '  ',
      'a'.repeat(4001),
      'null\x00byte',
      'see test-private-value',
      '-----BEGIN RSA PRIVATE KEY-----',
    ])
      await expect(replies.send(1, 'invalid', body, bot)).rejects.toMatchObject({ httpStatus: 400 })
    await expect(replies.send(1, 'stale', 'OK', 'other[bot]')).rejects.toMatchObject({
      httpStatus: 412,
    })
    expect(post).not.toHaveBeenCalled()
    expect(await replies.send(1, 'one', 'OK', bot)).toEqual({ status: 'sent', ...receipt })
    expect(await replies.send(1, 'two', 'OK', bot)).toEqual({ status: 'sent', ...receipt })
    await expect(replies.send(1, 'one', 'Changed', bot)).rejects.toMatchObject({ httpStatus: 409 })
    expect(post).toHaveBeenCalledTimes(1)
  } finally {
    await replies.close()
    store.close()
  }
})

test('ambiguous POST is never replayed under a new request ID; explicit pre-send rejection may be retried', async () => {
  let mode: 'unavailable' | 'lost' = 'unavailable'
  const post = mock<typeof postGithubAppComment>(async (_auth, input) => {
    if (mode === 'unavailable') throw new Error('private Diagnostic')
    input.beforePost?.()
    throw new Error('response lost')
  })
  const { store, replies } = setup(post)
  try {
    await expect(replies.send(1, 'one', 'text', bot)).rejects.toMatchObject({
      httpStatus: 502,
      unknown: false,
    })
    mode = 'lost'
    await expect(replies.send(1, 'one', 'text', bot)).rejects.toMatchObject({ httpStatus: 502 })
    await expect(replies.send(1, 'two', 'text', bot)).rejects.toMatchObject({
      httpStatus: 409,
      unknown: true,
    })
    await expect(replies.send(1, 'three', 'text', bot)).rejects.toMatchObject({
      httpStatus: 409,
      unknown: true,
    })
    expect(post).toHaveBeenCalledTimes(2)
  } finally {
    await replies.close()
    store.close()
  }
})

test('revoking a tracked repository during the asynchronous credential check prevents publication', async () => {
  let sent = false
  const { store, replies } = setup(async (_auth, input) => {
    const { settings, revision } = store.getSettings()
    settings.github.repositories[0].enabled = false
    store.saveSettings(settings, revision)
    input.beforePost?.()
    sent = true
    return receipt
  })
  try {
    await expect(replies.send(1, 'changing', 'text', bot)).rejects.toMatchObject({
      httpStatus: 412,
    })
    expect(sent).toBe(false)
  } finally {
    await replies.close()
    store.close()
  }
})
