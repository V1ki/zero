import { githubDiscussionSubject } from './github-reply-subject'
import type { TriggerInboxItem, TriggerSource } from './trigger'

/** The subject correlates evidence. Actor identity, capabilities and audience are resolved separately. */
export interface RouterFollowupSignal {
  source: TriggerSource
  scope: string
  subject: string
  eventId: string
  inboxId: number
  title: string
  summary: string
  occurredAt: string
}

export function githubFollowupSubject(event: TriggerInboxItem): string | null {
  const discussion = githubDiscussionSubject(event)
  return discussion
    ? `github:${discussion.repositoryId}:${discussion.kind}:${discussion.number}`
    : null
}

/** Only the native GitHub receiver and reader produce this repo/run/attempt tuple and permalink.
 * Third-party CI identifiers are namespaced by their receiver and never identify a GitHub run. */
export function githubWorkflowFollowupSubject(event: TriggerInboxItem): string | null {
  if (
    event.source !== 'github' ||
    event.githubCommentKind ||
    !/^[a-z\d-]+\/[a-z\d_.-]+$/iu.test(event.scope) ||
    /\/\.{1,2}$/u.test(event.scope)
  )
    return null
  const run = /^([1-9]\d*):run:([1-9]\d*):([1-9]\d*):failure$/u.exec(event.eventId)
  if (!run || !run.slice(1).every((id) => Number.isSafeInteger(Number(id)))) return null
  const [, repositoryId, runId, attempt] = run
  const url = `https://github.com/${event.scope}/actions/runs/${runId}/attempts/${attempt}`
  return event.url === url ? `github:${repositoryId}:run:${runId}` : null
}

/** Preserve event identity when a source supplies no trustworthy discussion or reply chain. */
export function routerFollowupSignal(event: TriggerInboxItem): RouterFollowupSignal {
  const { source, scope, eventId, title, summary, occurredAt } = event
  const subject =
    githubFollowupSubject(event) ??
    githubWorkflowFollowupSubject(event) ??
    JSON.stringify([source, scope, eventId])
  return { source, scope, subject, eventId, inboxId: event.id, title, summary, occurredAt }
}
