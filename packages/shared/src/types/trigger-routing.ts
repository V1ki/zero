import type { TriggerInboxItem } from './trigger'
import type { MandatePlatform, MandateTarget } from './trigger-mandate'

/** ISO wall-clock times use HH:mm. Workdays follow JavaScript's Sunday=0 convention. */
export const triggerRetentionPeriods = [7, 30, 90, 365] as const
export type TriggerRetentionDays = (typeof triggerRetentionPeriods)[number]
export function isTriggerRetentionDays(days: unknown): days is TriggerRetentionDays {
  return triggerRetentionPeriods.some((period) => period === days)
}
export type TriggerRouteDestination = 'web' | MandatePlatform | 'defer'
export const triggerRoutePlatforms = ['weixin', 'dingtalk', 'feishu'] as const
export function isTriggerRoutePlatform(value: unknown): value is MandatePlatform {
  return triggerRoutePlatforms.some((platform) => platform === value)
}
export type TriggerPresence = 'auto' | 'present' | 'away'

export type TriggerDateOverrides = Record<string, 'work' | 'off'>

export interface TriggerNativePresenceSettings {
  /** The macOS host running ZeRo must be the computer whose presence is relevant. */
  enabled: boolean
  idleMinutes: number
  bluetooth: boolean
}

/** No identifiers or device names leave the optional local probe. */
export interface TriggerNativePresence {
  observedAt: string
  locked: boolean | null
  idleSeconds: number | null
  bluetoothConnected: boolean | null
}

export interface TriggerWeixinTarget {
  channelId: string
  peerId: string
}

/** Public bot directory entry. The channel keeps the recipient identity private. */
export interface TriggerRoutingBot {
  platform: MandatePlatform
  channelId: string
  label: string
  online: boolean
  ready: boolean
  deliveryState: 'ready' | 'offline' | 'awaiting_private' | 'ambiguous' | 'unavailable'
}

export interface TriggerRoutingSettings {
  retentionDays?: TriggerRetentionDays | null
  enabled: boolean
  timeZone: string
  workdays: number[]
  workStart: string
  workEnd: string
  dateOverrides?: TriggerDateOverrides
  nativePresence?: TriggerNativePresenceSettings
  presence: TriggerPresence
  awayFallback: MandatePlatform | 'defer'
  duringWork: TriggerRouteDestination
  afterWork: TriggerRouteDestination
  offDay: TriggerRouteDestination
  /** Router preferences select only the bot. Its channel resolves the recipient. */
  personalBots?: Partial<Record<MandatePlatform, string | null>>
  /** Original Weixin API field retained for older configuration clients. */
  weixinTarget: TriggerWeixinTarget | null
}

export interface TriggerBotBindingsSnapshot {
  revision: number
  targets: MandateTarget[]
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
  | { destination: 'web' | MandatePlatform; reason: string }
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
  /** Recipient selected at dispatch, including for historical Weixin deliveries. */
  deliveryTarget?: MandateTarget | null
  error: string | null
  updatedAt: string
}

export interface TriggerRouteWork {
  event: TriggerInboxItem
  route: TriggerRouteRecord
}

export interface TriggerWebNotification {
  id: number
  inboxId: number
  taskId: number | null
  createdAt: string
  /** Omitted in pointer-only responses. */
  title?: string
  summary?: string | null
}

export interface TriggerWebNotificationQuery {
  after?: number
  before?: number
  limit?: number
  brief?: boolean
}
