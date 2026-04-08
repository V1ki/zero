import type { Message, ModelHistoryEntry, SessionSource, SessionStatus } from '@zero-os/shared'
import type { EvaluationEntry, SessionStatsSummary, SessionUsageByPurposeRow } from '../metrics'
import type {
  ClosureLogEntry,
  DecisionLogEntry,
  RequestLogEntry,
  SnapshotEntry,
} from '../observability-store'

export const EPISODE_SCHEMA_VERSION = 1 as const

export const KNOWN_EPISODE_TRAITS = [
  'uses-tools',
  'uses-memory-retrieval',
  'uses-memory-write',
  'has-closure-finish',
  'has-closure-block',
  'has-compression',
  'has-sub-agent',
  'multi-turn',
  'has-tool-errors',
  'has-queued-injection',
  'has-images',
] as const

export type EpisodeTrait = (typeof KNOWN_EPISODE_TRAITS)[number]

export interface EpisodeMetadata {
  source: SessionSource
  status: SessionStatus
  currentModel: string
  modelHistory: ModelHistoryEntry[]
  summary?: string
  tags: string[]
  channelName?: string
  channelId?: string
  createdAt: string
  updatedAt: string
}

export interface EpisodeConversation {
  messages: Message[]
  messageCount: number
  userTurnCount: number
  assistantTurnCount: number
}

export interface EpisodeRecordedContext {
  systemPrompt?: string
  agentConfigJson?: string
  /**
   * Recorded tool names only. This is not a replay-ready tool contract.
   */
  tools: string[]
  toolsSource: 'snapshot' | 'none'
  identityMemory?: string
  snapshotId?: string
}

export interface EpisodeTraceCounts {
  requestCount: number
  closureCount: number
  decisionCount: number
  snapshotCount: number
  toolCallCount: number
  memoryDecisionCount: number
  compressionCount: number
  toolErrorCount: number
}

export interface EpisodeTrace {
  requests: RequestLogEntry[]
  closures: ClosureLogEntry[]
  decisions: DecisionLogEntry[]
  snapshots: SnapshotEntry[]
  counts: EpisodeTraceCounts
}

export interface EpisodeUsage extends SessionStatsSummary {
  byPurpose: SessionUsageByPurposeRow[]
}

export interface Episode {
  schemaVersion: typeof EPISODE_SCHEMA_VERSION
  id: string
  sessionId: string
  extractedAt: string
  metadata: EpisodeMetadata
  conversation: EpisodeConversation
  recordedContext: EpisodeRecordedContext
  trace: EpisodeTrace
  usage: EpisodeUsage
  evaluations: EvaluationEntry[]
  traits: string[]
}

export interface DatasetFilter {
  statuses?: SessionStatus[]
  since?: string
  until?: string
  sources?: SessionSource[]
  tags?: string[]
  traits?: string[]
  hasEvaluation?: boolean
  limit?: number
  offset?: number
}
