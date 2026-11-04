import type { TriggerSource } from './trigger'
import type { CommissionPreview } from './trigger-commission'
import type { MandatePlatform } from './trigger-mandate'
import type {
  TriggerPresence,
  TriggerRouteDestination,
  TriggerRouteStatus,
  TriggerRoutingSettings,
} from './trigger-routing'

/** Event IDs and task IDs have separate durable namespaces. */
export type TriggerConversationScope = 'general' | number | `task-${number}`
export type TriggerConversationIntent = 'route' | 'event' | 'next'

export type TriggerPreferenceChange =
  | { key: 'personalBot'; platform: MandatePlatform; value: string; label: string }
  | { key: 'presence'; value: TriggerPresence }
  | { key: 'duringWork' | 'afterWork' | 'offDay'; value: TriggerRouteDestination }
  | { key: 'awayFallback'; value: TriggerRoutingSettings['awayFallback'] }

export type GithubInvestigationAction = 'inspect_github' | 'compare_runs'

export interface GithubInvestigation {
  kind: 'pull' | 'jobs' | 'history'
  observedAt: string
  sourceUrl: string
  facts: { label: string; value: string; url?: string }[]
}

export interface RouterDirectReminder {
  platform: MandatePlatform
  channelId: string
  botLabel: string
  text: string
  /** Server-side fingerprint used to verify the recipient again before sending. */
  audienceKey?: string
  status: 'draft' | 'sending' | 'accepted' | 'rejected' | 'unknown'
  reason?: string
}

/** One page of repository names actually returned for the current user's GitHub access. */
export interface RouterRepositoryPage {
  page: number
  repositories: string[]
  nextPage: number | null
}

/** Receipt for a one-off worker job. Private execution and delivery identifiers stay server-side. */
export interface RouterJobReceipt {
  id: number
  executor: 'zero' | 'codex'
  status: 'queued' | 'running' | 'completed' | 'failed' | 'unknown'
  attempt: number
  repository?: string
  result?: string
}

export interface TriggerConversationAnswer {
  /** Completed tool calls in execution order. Inputs, private results and reasoning stay out of this view. */
  toolSteps?: Array<{ name: string; ok: boolean }>
  /** Recorded only by the scoped read-only GitHub integration. */
  investigation?: GithubInvestigation
  repositories?: RouterRepositoryPage
  job?: RouterJobReceipt
  /** Server-only authorization snapshot for redacting work history after access changes. */
  workAccess?: { github: boolean; key: string }
  text: string
  intent?: TriggerConversationIntent
  points?: string[]
  /** Prepared from an explicit request in the main Router chat. */
  reminder?: RouterDirectReminder
  commission?: CommissionPreview
  proposal?: TriggerPreferenceChange
  /** Recorded by the server when the proposed change is first shown for confirmation. */
  proposalRevision?: number
  /** Written by the server in the same transaction as the confirmed settings change. */
  readonly proposalAppliedAt?: string
}

export interface TriggerConversationTurn {
  id: number
  requestId: string
  question: string
  answer: TriggerConversationAnswer | null
  status: 'pending' | 'completed' | 'failed'
  error: string | null
  createdAt: string
  updatedAt: string
}

/** The navigation list omits source excerpts and conversation history. */
export interface TriggerWorkspaceEvent {
  id: number
  source: TriggerSource
  title: string
  receivedAt: string
  status: TriggerRouteStatus | null
}
