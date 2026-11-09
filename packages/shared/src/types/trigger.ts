import type { CommissionOperator } from './trigger-commission'

export type TriggerSource = 'github' | 'wxarc'

export function githubLifecycleKind(eventId: string): 'issue' | 'pr' | undefined {
  const match = /^[1-9]\d*:(issue|pr):[1-9]\d*:(opened|reopened|closed|merged):\d+$/.exec(eventId)
  if (match?.[1] === 'pr') return 'pr'
  if (match?.[1] === 'issue' && match[2] !== 'merged') return 'issue'
}

export const triggerWebhookSecretPatterns = {
  github: /^github_webhook(?:_[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?$/,
  ci: /^ci_webhook(?:_[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?$/,
} as const

export const triggerGithubAppRefPattern = /^github_app_[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

export interface TriggerRepositoryOption {
  name: string
}

export interface TriggerGithubPermissionSelection {
  workflowFailures: boolean
  prComments: boolean
  prBase: boolean
  issues?: boolean
  pullRequests?: boolean
  issueComments?: boolean
  pullRequestComments?: boolean
}

export interface TriggerGithubPermissionReport {
  access: 'anonymous' | 'credential'
  checks: {
    resource:
      | 'actions'
      | 'prComments'
      | 'prBase'
      | 'issues'
      | 'pullRequests'
      | 'issueComments'
      | 'pullRequestComments'
    status: 'readable' | 'denied' | 'not_found' | 'rate_limited' | 'unavailable'
    retryAfterMs?: number
  }[]
}

export interface TriggerGithubRepository extends TriggerRepositoryOption {
  enabled: boolean
  /** Vault reference for the GitHub App installation bound to this repository. */
  githubAppRef?: string
  /** Publish verified work requested by the repository owner in an @mention to this App. */
  ownerMentionReplies?: boolean
  /** Effective time set by the server. A grant never applies to an earlier comment. */
  ownerMentionRepliesSince?: string
  /** Let the bound App close new Issue events only after a resolved duplicate is verified. */
  closeResolvedDuplicates?: boolean
  /** Server-assigned start of the current grant; never a request to backfill older events. */
  closeResolvedDuplicatesSince?: string
  /** Allow the verified repository owner to request closure of this Issue by mentioning the bound App. */
  allowOwnerIssueClose?: boolean
  /** Server-assigned opt-in time for this App and this permission. */
  allowOwnerIssueCloseSince?: string
  issues?: boolean
  pullRequests?: boolean
  issueComments?: boolean
  pullRequestComments?: boolean
  branch: string
  workflow: string
  workflowFailures: boolean
  mention: string
  deliveryMode?: 'poll' | 'webhook'
  webhookSecretRef?: string
  ciWebhookSecretRef?: string
}

export interface TriggerWxarcOption {
  id: string
  name: string
}

export interface TriggerWxarcSession extends TriggerWxarcOption {
  enabled: boolean
  keyword: string
}

export interface TriggerSettings {
  github: {
    credentialRef: string
    repositories: TriggerGithubRepository[]
    /** Private Router operators explicitly allowed to read this GitHub connection. */
    routerOperators?: CommissionOperator[]
    /** Shared by the Web Router and private IM operators who may use this connection. */
    routerTrackingEnabled?: boolean
  }
  wxarc: { sessions: TriggerWxarcSession[] }
}

export interface TriggerSettingsSnapshot {
  revision: number
  settings: TriggerSettings
}

export class TriggerSettingsConflictError extends Error {
  constructor() {
    super('Subscriptions were updated. Reload the settings before saving again.')
    this.name = 'TriggerSettingsConflictError'
  }
}

export interface TriggerEvent {
  eventId: string
  scope: string
  title: string
  summary: string
  occurredAt: string
  /** Optional grouping key from authenticated adapter metadata, never message text. */
  businessKey?: string
  /** WXARC event-stream ID, only when the local source verified a same-session reply edge. */
  wxarcReplyToEventId?: string
  /** Set by the GitHub adapter when the ordinary discussion rule matches. */
  githubCommentKind?: 'issue-comment' | 'pr-comment'
  /** This ordinary comment also satisfies the separate configured PR mention rule. */
  githubCommentMention?: true
  /** Verified bound App identity or a matching sent receipt; persisted across restarts. */
  githubOwnComment?: true
  url?: string
}

export interface TriggerInboxItem extends TriggerEvent {
  id: number
  source: TriggerSource
  receivedAt: string
}

export interface TriggerIgnoredComment {
  eventId: string
  url: string
  occurredAt: string
  reason: string
}
export interface TriggerIgnoredDiscussion extends TriggerIgnoredComment {
  kind: 'issue-comment' | 'pr-comment'
  mentioned: boolean
}

export interface TriggerStatus {
  source: TriggerSource
  scope: string
  state: 'idle' | 'watching' | 'error'
  lastCheckedAt: string | null
  lastIgnoredComment?: TriggerIgnoredComment
  error?: string
}
