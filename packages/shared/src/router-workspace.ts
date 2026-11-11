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
