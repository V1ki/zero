export type TriggerSource = 'github' | 'wxarc'

export interface TriggerRepositoryOption {
  name: string
}

export interface TriggerGithubRepository extends TriggerRepositoryOption {
  enabled: boolean
  branch: string
  workflow: string
  workflowFailures: boolean
  mention: string
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
  github: { credentialRef: string; repositories: TriggerGithubRepository[] }
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
