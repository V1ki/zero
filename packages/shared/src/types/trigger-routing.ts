import type { TriggerInboxItem } from './trigger'

/** ISO wall-clock times use HH:mm. Workdays follow JavaScript's Sunday=0 convention. */
export type TriggerRouteDestination = 'web' | 'weixin' | 'defer'
export type TriggerPresence = 'auto' | 'present' | 'away'

export interface TriggerWeixinTarget {
  channelId: string
  peerId: string
}

export interface TriggerRoutingSettings {
  enabled: boolean
  timeZone: string
  workdays: number[]
  workStart: string
  workEnd: string
  presence: TriggerPresence
  awayFallback: 'weixin' | 'defer'
  duringWork: TriggerRouteDestination
  afterWork: TriggerRouteDestination
  offDay: TriggerRouteDestination
  weixinTarget: TriggerWeixinTarget | null
}

export interface TriggerRoutingSettingsSnapshot {
  revision: number
  settings: TriggerRoutingSettings
}

export interface TriggerAgentResult {
  summary: string
  sessionId?: string
}

export type TriggerRouteDecision =
  | { destination: 'web' | 'weixin'; reason: string }
  | { destination: 'defer'; reason: string; recheckAt: string }

export type TriggerRouteStatus =
  | 'pending'
  | 'analyzing'
  | 'ready'
  | 'web'
  | 'deferred'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'uncertain'
  | 'cancelled'

export interface TriggerRouteRecord {
  inboxId: number
  origin: 'manual' | 'subscription'
  status: TriggerRouteStatus
  sessionId: string | null
  agent: TriggerAgentResult | null
  decision: TriggerRouteDecision | null
  firstDeferred: { at: string; reason: string } | null
  settingsRevision: number | null
  weixinTarget: TriggerWeixinTarget | null
  error: string | null
  updatedAt: string
}

export interface TriggerRouteWork {
  event: TriggerInboxItem
  route: TriggerRouteRecord
}
