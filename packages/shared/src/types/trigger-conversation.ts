import type { TriggerSource } from './trigger'
import type { CommissionPreview } from './trigger-commission'
import type {
  TriggerPresence,
  TriggerRouteDestination,
  TriggerRouteStatus,
} from './trigger-routing'

/** Event IDs and task IDs have separate durable namespaces. */
export type TriggerConversationScope = 'general' | number | `task-${number}`
export type TriggerConversationIntent = 'route' | 'event' | 'next'

export type TriggerPreferenceChange =
  | { key: 'presence'; value: TriggerPresence }
  | { key: 'duringWork' | 'afterWork' | 'offDay'; value: TriggerRouteDestination }
  | { key: 'awayFallback'; value: 'weixin' | 'defer' }

export type GithubInvestigationAction = 'inspect_github' | 'compare_runs'

export interface GithubInvestigation {
  kind: 'pull' | 'jobs' | 'history'
  observedAt: string
  sourceUrl: string
  facts: { label: string; value: string; url?: string }[]
}

export interface TriggerConversationAnswer {
  /** Recorded only by the scoped read-only GitHub integration. */
  investigation?: GithubInvestigation
  text: string
  intent?: TriggerConversationIntent
  points?: string[]
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
