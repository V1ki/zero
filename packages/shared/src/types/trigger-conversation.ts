import type { TriggerSource } from './trigger'
import type { CommissionPreview } from './trigger-commission'
import type { TriggerRouteStatus } from './trigger-routing'

/** Event IDs and task IDs have separate durable namespaces. */
export type TriggerConversationScope = 'general' | number | `task-${number}`
export type TriggerConversationIntent = 'route' | 'event' | 'next'

export type GithubInvestigationAction = 'inspect_github' | 'compare_runs'

export interface GithubInvestigation {
  kind: 'pull' | 'jobs' | 'history'
  observedAt: string
  sourceUrl: string
  facts: { label: string; value: string; url?: string }[]
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
  job?: RouterJobReceipt
  /** Server-only authorization snapshot for redacting work history after access changes. */
  workAccess?: { github: boolean; key: string }
  text: string
  intent?: TriggerConversationIntent
  points?: string[]
  /** IM mandate command drafts only. Router conversation turns no longer store it. */
  commission?: CommissionPreview
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
