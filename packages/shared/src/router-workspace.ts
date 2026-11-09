import type { RouterEventActivity } from './router-event-activity'
import type { RouterSurfaceMessages } from './router-surface'
import type { RouterTrackingResult } from './types/router-tracking-result'
import type { TriggerInboxItem, TriggerSource } from './types/trigger'
import type {
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
  eventActivity?: RouterEventActivity
  previousTurnId?: number
  task?: RouterWorkspaceTask
  /** A local user's request to route this event; legacy submissions have no recorded timestamp. */
  notificationRequest?: { submittedAt: string | null }
  /** Background analysis of this selected event, visible under the current repository grant. */
  trackingResult?: RouterTrackingResult
  scope: TriggerConversationScope
  event: TriggerInboxItem | null
  route: TriggerRouteRecord | null
  settings: TriggerRoutingSettingsSnapshot
  surface: RouterSurfaceMessages
  turns: (TriggerConversationTurn & {
    surface: RouterSurfaceMessages | null
    traceRunIds?: string[]
    publications?: { id: string; title: string }[]
  })[]
}
