export type AssetKind = 'character' | 'location' | 'prop'
export type WorkStatus = 'pending' | 'running' | 'succeeded' | 'failed'
export type JobStatus = 'ready' | 'running' | 'completed' | 'failed' | 'blocked' | 'interrupted'

export interface Chapter {
  id: string
  number: number | null
  title: string
  start: number
  end: number
  chunkIds: string[]
}

export interface Evidence {
  chapterId: string
  chunkId: string
  quote: string
  start: number
  end: number
  chapterOffset: number
}

export interface Mention {
  kind: AssetKind
  name: string
  aliases: string[]
  description: string
  evidence: Evidence
}

export interface Asset {
  id: string
  kind: AssetKind
  name: string
  aliases: string[]
  descriptions: string[]
  evidence: Evidence[]
  /** Local reference identity; never a book-wide alias. */
  localIdentity?: { legacyId: string }
}

export interface EntityCommit {
  id: string
  fromId: string
  canonicalId: string
  sourceSha256: string
  subjectKeys: string[]
  targetKeys: string[]
  reason: string
  evidence: Evidence[]
  confirmedAt: string
}

export interface IdentityConfirmation {
  fromId: string
  canonicalId: string
  confirmedBy: string
  confirmedAt: string
  reason: string
}

export interface IdentityDecision {
  fromId: string
  candidateIds: string[]
  canonicalId?: string
  outcome: 'automatic' | 'confirmed' | 'blocked'
  reason: string
  evidence: Evidence[]
}

export interface IdentityResolution {
  version: 'character-alias-v1'
  confirmations: IdentityConfirmation[]
  redirects: Record<string, string>
  decisions: IdentityDecision[]
  ai?: EntityResolutionRun
  aiHistory?: EntityResolutionRun[]
  commits?: EntityCommit[]
  conflicts?: { commitId: string; reason: string }[]
  mentionRedirects?: Record<string, string>
}

export interface EntityCitation {
  contextId: string
  quote: string
  evidenceId?: string
}

export interface EntityVerdict {
  outcome: 'match' | 'new' | 'unresolved'
  canonicalId: string | null
  candidateIds: string[]
  reason: string
  evidence: EntityCitation[]
}

export interface EntityResolutionAttempt {
  id: string
  key: string
  subjectId: string
  page: number
  phase: 'propose' | 'verify'
  status: 'running' | 'succeeded' | 'failed' | 'interrupted'
  responseFile: string
  verdict?: EntityVerdict
  error?: string
}

export interface EntityResolutionRun {
  version: 'ai-entity-v1' | 'ai-entity-v2'
  completedAt?: string
  snapshot: string
  subjectIds: string[]
  status: 'running' | 'completed' | 'failed' | 'stale' | 'interrupted'
  attempts: EntityResolutionAttempt[]
  failures?: { subjectId: string; error: string; at: string }[]
  decisions: {
    fromId: string
    canonicalId?: string
    outcome: 'match' | 'new' | 'unresolved'
    reason: string
    evidence: Evidence[]
  }[]
}

export interface Attempt {
  id: string
  startedAt: string
  endedAt?: string
  status: WorkStatus | 'interrupted'
  httpStatus?: number
  responseModel?: string
  usage?: Record<string, unknown>
  error?: string
  rejectedQuotes?: number
  responseFile?: string
}

export interface Chunk {
  id: string
  chapterId: string
  start: number
  end: number
  status: WorkStatus
  attempts: Attempt[]
  mentions: Mention[]
  error?: string
}

export interface Project {
  qualityCorrections?: QualityCorrection[]
  categoryGroups?: CategoryGroup[]
  schemaVersion: 1
  id: string
  title: string
  createdAt: string
  updatedAt: string
  sourceSha256: string
  sourceUtf16Length: number
  sourceCodePoints: number
  sourceBytes: number
  model: string
  endpoint: string
  promptVersion: string
  promptSha256: string
  chunkLimit: number
  status: JobStatus
  error?: string
  chapters: Chapter[]
  chunks: Chunk[]
  assets: Asset[]
  identityResolution?: IdentityResolution
  probes: { at: string; models?: unknown; error?: string }[]
}

export interface Progress {
  total: number
  succeeded: number
  failed: number
  running: number
  pending: number
  coveredUtf16: number
  chapters: (Chapter & { status: WorkStatus })[]
}

export interface ProjectSummary {
  id: string
  title: string
  status: JobStatus
  updatedAt: string
}

export interface ProjectView extends Project {
  progress: Progress
}

/** Append-only operator review; never represented as a model extraction. */
export interface QualityCorrection {
  id: string
  previous: string | null
  sourceSha256: string
  at: string
  reviewer: string
  provenance: 'source-review'
  reason: string
  evidence: Evidence[]
  operation:
    | { type: 'retract'; commitId: string }
    | { type: 'supplement'; mention: Mention }
    | {
        type: 'retype'
        fromId: string
        evidenceKey: string
        kind: AssetKind
        interpretation: string
      }
    | { type: 'localize'; fromId: string; evidenceKeys: string[] }
    | { type: 'assign'; fromId: string; canonicalId: string; evidenceKeys: string[] }
    | { type: 'distinct'; leftId: string; rightId: string }
    | { type: 'category'; label: string; memberIds: string[] }
}
export interface CategoryGroup {
  id: string
  label: string
  memberIds: string[]
  correctionId: string
}
