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

/**
 * A model-written reading of one completed job step for its owner. Every field is untrusted
 * display text derived from executor output; an option is only ever sent back to the same job.
 */
export interface RouterJobReport {
  /** One or two sentences answering what the owner originally asked. */
  verdict: string
  /** Present only when the owner has to choose. */
  decision?: { question: string; options: string[]; recommended: number }
  /** What was actually changed or produced. May be empty. */
  done: string[]
}

/** Receipt for a one-off worker job. Private execution and delivery identifiers stay server-side. */
export interface RouterJobReceipt {
  id: number
  executor: 'zero' | 'codex'
  status: 'queued' | 'running' | 'completed' | 'failed' | 'unknown'
  attempt: number
  repository?: string
  /** The executor's full, filtered result. */
  result?: string
  /** Absent for steps without a report, including those finished before reports existed. */
  report?: RouterJobReport
  /** The step completed and its report is still being written. */
  reportPending?: true
  /** A newer step of the same job exists, so this step's decision is no longer open. */
  continued?: true
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
