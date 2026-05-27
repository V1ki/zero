import type { ToolDefinition } from './message'

export interface SkillDefinition {
  name: string
  description: string
  allowedTools: string[]
  content: string
  sourcePath: string
}

/**
 * Controls which hardcoded sections are included in the system prompt.
 * - "full": All sections (default, for main agent)
 * - "minimal": Reduced sections (role + toolRules + constraints) — used for subagents
 * - "none": Just basic identity line, no sections
 */
export type PromptMode = 'full' | 'minimal' | 'none'

/**
 * A workspace bootstrap file loaded from .zero/ directory.
 * Injected into system prompt tail as Project Context.
 */
export interface BootstrapFile {
  /** File name, e.g. "SOUL.md" */
  name: string
  /** Absolute file path */
  path: string
  /** File content (may be truncated by size limits) */
  content: string
}

/**
 * Channel capability hints — tells agents what the channel supports.
 */
export interface ChannelCapabilities {
  /** Channel supports streaming output (e.g. typing effect) */
  streaming?: boolean
  /** Channel supports inline images in text messages */
  inlineImages?: boolean
  /** Channel supports sending standalone image messages */
  imageMessages?: boolean
  /** Channel supports sending file attachments */
  fileMessages?: boolean
  /** Channel supports interactive cards / rich messages */
  interactiveCards?: boolean
  /** Channel supports @mention syntax */
  mentions?: boolean
  /** Channel supports emoji reactions on messages */
  reactions?: boolean
  /** Channel supports reply/quote to specific messages */
  threadReply?: boolean
  /** Markdown dialect notes for the channel */
  markdownNotes?: string
  /** Max message length in characters (if limited) */
  maxMessageLength?: number
}

/**
 * Compact runtime information injected as a single key=value line.
 */
export interface RuntimeInfo {
  agentId?: string
  sessionId?: string
  host?: string
  os?: string
  arch?: string
  model?: string
  shell?: string
  channel?: string
  projectRoot?: string
  /** Channel capability hints — auto-injected into system prompt */
  channelCapabilities?: ChannelCapabilities
}

/**
 * Static components for System Prompt — built once per session for prompt cache stability.
 */
export interface PromptComponents {
  agentName: string
  agentDescription: string
  tools: ToolDefinition[]
  skills?: SkillDefinition[]
  globalIdentity: string
  agentIdentity: string
  workspacePath?: string
  projectRoot?: string
  /** Controls which sections are included. Defaults to "full". */
  promptMode?: PromptMode
  /** Workspace bootstrap files (SOUL.md, USER.md, TOOLS.md) */
  bootstrapFiles?: BootstrapFile[]
  /** Compact runtime info for the Runtime line */
  runtimeInfo?: RuntimeInfo
}

/**
 * Dynamic context injected into user message as <system-reminder>.
 * Includes runtime-discovered skill notifications and retrieved memories.
 */
export interface DynamicContext {
  newSkills?: SkillDefinition[]
  retrievedMemories?: string
}

export interface ContextBudget {
  role: number
  toolRules: number
  constraints: number
  executionMode: number
  safety: number
  toolCallStyle: number
  identity: number
  skillCatalog: number
  runtime: number
  bootstrapContext: number
  conversation: number
  reserved: number
}

export interface CompressionResult {
  summary: string
  retainedMessages: import('./message').Message[]
  stats: {
    messagesBefore: number
    messagesAfter: number
    tokensBefore: number
    tokensAfter: number
    compressedRange?: string
  }
}

export interface EpisodeCompaction {
  id: string
  sessionId: string
  status: 'confirmed' | 'inferred' | 'blocked'
  boundaryStrategy: string
  boundaryReason: string
  goal: string
  scope: string[]
  toolUseIds: string[]
  confirmedFacts: string[]
  inferredFacts: string[]
  blockers: string[]
  needsRawReview: string[]
  evidence: import('./message').ToolEvidence[]
  summary: string
  messageIds: string[]
}

export interface WorkingStateCompaction {
  currentGoal: string
  scope: string[]
  confirmedFacts: string[]
  nextAction: string
  blockers: string[]
  doNot: string[]
  evidencePointers: import('./message').ToolEvidence[]
  sourceEpisodeIds: string[]
}

export type TimelineCompactionBlockStatus = 'active' | 'superseded'

export type TimelineCompactionBlockLifecycle = 'created' | 'updated' | 'reused' | 'superseded'

export interface TimelineCompactionBlockRange {
  startMessageId: string
  endMessageId: string
  startCreatedAt: string
  endCreatedAt: string
}

export interface TimelineCompactionTopic {
  id: string
  title: string
  status: 'completed' | 'in_progress' | 'blocked' | 'unknown'
  summary: string
  sourceMessageRefs: string[]
  sourceMessageIds: string[]
  toolRefs: string[]
  toolUseIds: string[]
  confirmedFacts?: string[]
  decisions?: string[]
  currentState?: string[]
  openQuestions?: string[]
  nextActions?: string[]
  evidence?: string[]
  needsRawReview?: boolean
}

export interface TimelineCompactionValidation {
  status: 'passed' | 'failed' | 'legacy'
  promptVersion?: string
  topicCount: number
  expectedToolRefs: string[]
  coveredToolRefs: string[]
  invalidToolRefs: string[]
  missingToolRefs: string[]
  expectedMessageRefs?: string[]
  coveredMessageRefs?: string[]
  invalidMessageRefs?: string[]
  errors: string[]
  warnings: string[]
}

export interface TimelineCompactionModelInfo {
  promptVersion: string
  primaryModel?: string
  primaryProvider?: string
  usedModel?: string
  usedProvider?: string
  attempts: number
}

export interface TimelineCompactionBlock {
  id: string
  sessionId: string
  status: TimelineCompactionBlockStatus
  strategy: string
  strategyVersion: string
  boundaryReason: string
  summary: string
  workingStateSummary: string
  coveredMessageIds: string[]
  coveredRange: TimelineCompactionBlockRange
  coveredMessageCount: number
  toolUseIds: string[]
  evidence: import('./message').ToolEvidence[]
  evidenceCount: number
  evidenceChars: number
  evidenceBytes: number
  rawCharsMovedToEvidence: number
  skippedUnfinishedToolUseIds: string[]
  episodeFullRetainTurns: number
  promptCharsBefore: number
  promptCharsAfter: number
  tokensBefore: number
  tokensAfter: number
  createdAt: string
  updatedAt: string
  supersededAt?: string
  generation: number
  episodes: EpisodeCompaction[]
  topics?: TimelineCompactionTopic[]
  validation?: TimelineCompactionValidation
  model?: TimelineCompactionModelInfo
  supersedesBlockIds?: string[]
  supersededByBlockId?: string
}
