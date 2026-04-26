import type { ReasoningEffort } from './reasoning'

export type SessionSource = 'feishu' | 'telegram' | 'scheduler' | 'web'
export type SessionPlacement = 'current' | 'background'

export interface ModelHistoryEntry {
  model: string
  from: string
  to: string | null
}

export interface ChannelSessionBinding {
  source: SessionSource
  channelName?: string
  channelId: string
  participantId?: string
  sessionId: string
  updatedAt: string
}

export interface Session {
  id: string
  createdAt: string
  updatedAt: string
  source: SessionSource
  currentModel: string
  reasoningEffort?: ReasoningEffort
  modelHistory: ModelHistoryEntry[]
  summary?: string
  tags: string[]
  channelName?: string
  channelId?: string
  participantId?: string
}
