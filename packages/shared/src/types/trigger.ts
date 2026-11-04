import type { CommissionOperator } from './trigger-commission'

export type TriggerSource = 'github' | 'wxarc'

export const triggerWebhookSecretPatterns = {
  github: /^github_webhook(?:_[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?$/,
  ci: /^ci_webhook(?:_[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?$/,
} as const

export interface TriggerRepositoryOption {
  name: string
}

export interface TriggerGithubPermissionSelection {
  workflowFailures: boolean
  prComments: boolean
  prBase: boolean
}

export interface TriggerGithubPermissionReport {
  access: 'anonymous' | 'credential'
  checks: {
    resource: 'actions' | 'prComments' | 'prBase'
    status: 'readable' | 'denied' | 'not_found' | 'rate_limited' | 'unavailable'
    retryAfterMs?: number
  }[]
}

export interface TriggerGithubRepository extends TriggerRepositoryOption {
  enabled: boolean
  branch: string
  workflow: string
  workflowFailures: boolean
  mention: string
  deliveryMode?: 'poll' | 'webhook'
  webhookSecretRef?: string
  ciWebhookSecretRef?: string
}

export interface TriggerWxarcOption {
  id: string
  name: string
}

export interface TriggerWxarcSession extends TriggerWxarcOption {
  enabled: boolean
  keyword: string
}

export interface TriggerSettings {
  github: {
    credentialRef: string
    repositories: TriggerGithubRepository[]
    /** Private Router operators explicitly allowed to read this GitHub connection. */
    routerOperators?: CommissionOperator[]
  }
  wxarc: { sessions: TriggerWxarcSession[] }
}

export interface TriggerSettingsSnapshot {
  revision: number
  settings: TriggerSettings
}

export class TriggerSettingsConflictError extends Error {
  constructor() {
    super('Subscriptions were updated. Reload the settings before saving again.')
    this.name = 'TriggerSettingsConflictError'
  }
}

export interface TriggerEvent {
  eventId: string
  scope: string
  title: string
  summary: string
  occurredAt: string
  /** Optional grouping key from authenticated adapter metadata, never message text. */
  businessKey?: string
  url?: string
}

export interface TriggerInboxItem extends TriggerEvent {
  id: number
  source: TriggerSource
  receivedAt: string
}

export interface TriggerStatus {
  source: TriggerSource
  scope: string
  state: 'idle' | 'watching' | 'error'
  lastCheckedAt: string | null
  error?: string
}
