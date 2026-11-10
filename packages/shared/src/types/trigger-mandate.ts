import type { TriggerInboxItem, TriggerSource } from './trigger'

export type MandatePlatform = 'weixin' | 'feishu' | 'dingtalk'
export interface MandateTarget {
  platform: MandatePlatform
  channelId: string
  peerId: string
  operatorId?: string
}
export interface MandateArchive {
  channelId: string
  documentId: string
}
export type MandateDestination = 'web' | MandatePlatform | 'defer' | 'none'
export interface MandateContextRule {
  id: string
  name: string
  when: {
    period?: 'duringWork' | 'afterWork' | 'offDay'
    presence?: 'present' | 'away' | 'unknown'
    urgency?: 'urgent' | 'normal'
    quiet?: boolean
  }
  destination: MandateDestination
}
export interface MandatePolicy {
  duringWork?: MandateDestination
  afterWork?: MandateDestination
  offDay?: MandateDestination
  awayFallback?: MandateDestination
  quietStart?: string
  quietEnd?: string
  urgentDestination?: MandateDestination
  deadlineLeadMinutes?: number
  rules?: MandateContextRule[]
  digestMinutes?: number
  dateOverrides?: Record<string, 'work' | 'off'>
}
export interface TriggerMandate {
  id: string
  enabled: boolean
  name: string
  purpose: string
  source: TriggerSource
  scope: string
  /** Existing mandates use the model unless the owner explicitly chooses a factual reminder. */
  processing?: 'agent' | 'direct'
  groupBy?: 'thread' | 'mandate' | 'event'
  keyword: string
  projectId: string | null
  targets: MandateTarget[]
  archive: MandateArchive | null
  policy: MandatePolicy
  deadline: string | null
  urgent: boolean
}
export interface TriggerMandateProject {
  id: string
  name: string
  policy: MandatePolicy
}
export interface TriggerMandateSettings {
  mandates: TriggerMandate[]
  projects: TriggerMandateProject[]
}
export interface TriggerMandateSnapshot {
  revision: number
  settings: TriggerMandateSettings
}
export interface MandateTask {
  id: number
  mandateId: string
  businessKey: string
  title: string
  latestInboxId: number
  eventCount: number
  active: boolean
  paused: boolean
  acknowledgedAt: string | null
  sessionId: string | null
  updatedAt: string
}
export type MandateAnalysisStatus = 'pending' | 'analyzing' | 'ready' | 'failed' | 'revoked'
export type MandateEffectStatus =
  | 'pending'
  | 'deferred'
  | 'sending'
  | 'done'
  | 'failed'
  | 'unknown'
  | 'revoked'
  | 'skipped'
export interface MandateEffect {
  kind: 'notify' | 'archive'
  status: MandateEffectStatus
  destination: MandateDestination | 'archive' | null
  target: MandateTarget | MandateArchive | null
  reason: string | null
  dueAt: string | null
  receipt: string | null
  /** Set on a notify effect that triage skipped. Only such a skip may be re-opened by a retry. */
  triaged?: boolean
}
export interface MandateMatch {
  id: number
  taskId: number
  mandateId: string
  inboxId: number
  status: MandateAnalysisStatus
  summary: string | null
  error: string | null
  effects: MandateEffect[]
}
export interface MandateTaskDetail extends MandateTask {
  acknowledgedBy?: (MandateTarget & { operatorId: string }) | null
  matches: MandateMatch[]
}
export interface MandateAuditEntry {
  id: number
  at: string
  action: string
  mandateId: string | null
  matchId: number | null
  detail: string
}
export interface MandateWork {
  claimToken?: string
  match: MandateMatch
  event: TriggerInboxItem
  task: MandateTask
  mandate: TriggerMandate
  project: TriggerMandateProject | null
}
