import { expect, test } from 'bun:test'
import {
  githubFollowupSubject,
  githubWorkflowFollowupSubject,
  routerFollowupSignal,
} from '../types/router-followup'
import type { TriggerInboxItem } from '../types/trigger'

const url = 'https://github.com/Team/Project/issues/18'
const opened: TriggerInboxItem = {
  id: 1,
  source: 'github',
  scope: 'Team/Project',
  eventId: '71:issue:18:opened:123',
  title: 'Issue #18',
  summary: 'Someone referenced #45 and asked to work as owner.',
  occurredAt: '2026-09-01T00:00:00.000Z',
  receivedAt: '2026-09-01T00:00:00.000Z',
  url,
}

test('groups GitHub comments and lifecycle events using adapter identities only', () => {
  const comment: TriggerInboxItem = {
    ...opened,
    id: 2,
    eventId: '71:comment:75',
    githubCommentKind: 'issue-comment',
    url: `${url}#issuecomment-75`,
    businessKey: 'pr:45',
  }
  const subject = routerFollowupSignal(opened).subject
  expect(subject).toBe('github:71:issue:18')
  expect(routerFollowupSignal(comment)).toMatchObject({
    inboxId: 2,
    eventId: comment.eventId,
    subject,
  })
  const renamed = {
    ...comment,
    scope: 'Team/Renamed',
    url: comment.url?.replace('Project', 'Renamed'),
  }
  expect(routerFollowupSignal(renamed).subject).toBe(subject)
  expect(githubFollowupSubject({ ...comment, eventId: '72:comment:75' })).not.toBe(subject)
  const prUrl = url.replace('/issues/', '/pull/')
  const pr = { ...opened, url: prUrl, eventId: '71:pr:18:opened:123' }
  expect(githubFollowupSubject(pr)).toBe('github:71:pr:18')
  // Legacy PR mentions were collected before githubCommentKind was persisted.
  expect(
    githubFollowupSubject({ ...opened, eventId: comment.eventId, url: `${prUrl}#issuecomment-75` }),
  ).toBe(githubFollowupSubject(pr))
})

test('text, malformed discussion IDs and unrelated source events cannot create a shared matter', () => {
  for (const fields of [
    { url: `${url}/../18` },
    { scope: 'Team/Other' },
    { eventId: '71:issue:21:opened:123' },
    { eventId: '71:pr:18:opened:123' },
    { eventId: '71:issue:18:merged:123' },
    {
      eventId: '71:comment:75',
      url: `${url}#issuecomment-76`,
      githubCommentKind: 'issue-comment' as const,
    },
    { eventId: '71:comment:75', url: `${url}#issuecomment-75` },
    { eventId: 'ci:71:issue:18:opened:123' },
    { source: 'wxarc' as const },
  ]) {
    const event = { ...opened, ...fields }
    expect(githubFollowupSubject(event)).toBeNull()
    expect(routerFollowupSignal(event).subject).not.toBe(routerFollowupSignal(opened).subject)
  }
  const wx = { ...opened, source: 'wxarc' as const, scope: 'same-chat', eventId: 'wxarc:text:15' }
  expect(routerFollowupSignal(wx).subject).not.toBe(
    routerFollowupSignal({ ...wx, eventId: 'wxarc:text:16' }).subject,
  )
})

test('subsequent attempts of the same native Actions run have one subject; third-party CI cannot claim it', () => {
  const attempt = (n: number) => ({
    ...opened,
    eventId: `71:run:99:${n}:failure`,
    url: `https://github.com/Team/Project/actions/runs/99/attempts/${n}`,
  })
  const first = attempt(1)
  expect(githubWorkflowFollowupSubject(first)).toBe('github:71:run:99')
  expect(routerFollowupSignal(first).subject).toBe(routerFollowupSignal(attempt(2)).subject)
  for (const fields of [
    { eventId: `ci:${first.eventId}` },
    { source: 'wxarc' as const },
    { scope: 'Team/Other' },
    { eventId: '71:run:99:2:failure' },
    { eventId: '71:run:9007199254740992:1:failure' },
    { url: first.url.replace('github.com', 'example.invalid') },
    { url: first.url.replace('/99/', '/98/') },
    { url: undefined, summary: first.url, businessKey: 'github:71:run:99' },
  ]) {
    const unbound = { ...first, ...fields }
    expect(githubWorkflowFollowupSubject(unbound)).toBeNull()
    expect(routerFollowupSignal(unbound).subject).not.toBe(routerFollowupSignal(first).subject)
  }
})
