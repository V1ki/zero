import type { RouterSurfaceMessages } from './router-surface'
import type { TriggerInboxItem, TriggerSource } from './types/trigger'
import type {
  RouterJobReceipt,
  TriggerConversationScope,
  TriggerConversationTurn,
} from './types/trigger-conversation'
import type { MandateMatch, MandatePlatform, MandatePolicy } from './types/trigger-mandate'
import type { TriggerRouteRecord, TriggerRoutingSettingsSnapshot } from './types/trigger-routing'

export interface RouterWorkspaceTask {
  id: number
  mandateId: string
  name: string
  purpose: string
  source: TriggerSource | null
  sourceScope: string
  eventCount: number
  active: boolean
  /** Platform names only. Receiver IDs and document credentials are excluded. */
  authorizedDestinations?: MandatePlatform[]
  archiveAuthorized?: boolean
  paused: boolean
  policy: MandatePolicy
  deadline: string | null
  urgent: boolean
  matches: (Pick<MandateMatch, 'inboxId' | 'status' | 'summary'> & {
    effects: Pick<
      MandateMatch['effects'][number],
      'kind' | 'status' | 'destination' | 'reason' | 'dueAt'
    >[]
  })[]
}

export interface RouterWorkspaceSnapshot {
  task?: RouterWorkspaceTask
  scope: TriggerConversationScope
  event: TriggerInboxItem | null
  route: TriggerRouteRecord | null
  settings: TriggerRoutingSettingsSnapshot
  surface: RouterSurfaceMessages
  turns: (TriggerConversationTurn & { surface: RouterSurfaceMessages | null })[]
  /**
   * Preset owner sentences the server offers in this conversation, sent as the owner's message
   * when clicked. Present only where the server allows the work they ask for.
   */
  quickQuestions?: { label: string; question: string }[]
}

/** A delegated job created from a task conversation, as listed on the task page. */
export interface RouterTaskJob {
  id: number
  executor: RouterJobReceipt['executor']
  status: RouterJobReceipt['status']
  updatedAt: string
  /** The report's verdict, once the latest step has one. */
  verdict?: string
  reportPending?: true
  /** The job's authorization changed since it was created; only its number and state are shown. */
  unavailable?: true
}

/** The windows the Router summary offers, in days. */
export const routerSummaryWindows = [7, 30] as const
export type RouterSummaryWindow = (typeof routerSummaryWindows)[number]

/** Counts only. No record of the summary carries titles, summaries, instructions or results. */
export interface RouterSummaryCounts {
  /** Events delivered to the owner: the Web, or an IM platform that accepted the send. */
  notifications: { personal: number; mandate: number }
  /** Events received in the window that triage filtered: still filtered, or brought back. */
  triage: { filtered: number; restored: number }
  /** Delivered notifications of "read GitHub details first" mandates. */
  investigation: {
    notified: number
    /** Went out with the fixed "could not read GitHub details" note. */
    unread: number
    /** Went out with the fixed "investigation did not finish" note. */
    unfinished: number
    /** The summary has expired under retention; whether it carried a note is unknown. */
    expired: number
  }
  /** Completed job steps and their reports. Decision figures leave out expired reports. */
  reports: {
    completed: number
    ready: number
    /** The report could not be produced; the owner got the raw result. */
    raw: number
    pending: number
    /** Steps that never asked for a report. */
    unrequested: number
    /** Reports whose body has expired under retention; whether they raised a decision is unknown. */
    expired: number
    decisions: number
    answered: number
    recommended: number
  }
}

export interface RouterSummaryPeriod {
  from: string
  to: string
  counts: RouterSummaryCounts
}

export interface RouterSummary {
  days: RouterSummaryWindow
  current: RouterSummaryPeriod
  previous: RouterSummaryPeriod
  /** When restored mandate notifications and answered options began to be recorded. */
  recordedSince: string | null
  /** The body retention setting in days; null keeps records indefinitely. */
  retentionDays: number | null
}
