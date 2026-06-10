/**
 * Centralized tuning parameters for the context engineering system.
 * All magic numbers are collected here for easy experimentation.
 */
export const CONTEXT_PARAMS = {
  /** System Prompt fixed budget allocations (tokens) — static, built once per session */
  budget: {
    role: 500,
    toolRules: 800,
    constraints: 300,
    executionMode: 500,
    safety: 300,
    toolCallStyle: 200,
    identity: 3000,
    skillCatalog: 2000,
    runtime: 400,
    bootstrapContext: 8000,
  },

  /** Conversation compression */
  compression: {
    /** Trigger compression when conversation tokens reach this ratio of budget */
    threshold: 0.85,
    /** After compression, retained section gets this ratio of conversation budget */
    retainRatio: 0.7,
    /** Minimum recent turns to retain after compression */
    minRetainTurns: 4,
    /** Maximum tokens for the compression summary */
    summaryMaxTokens: 800,
  },

  /** Per-tool output token limits */
  toolOutput: {
    read: 8000,
    write: 500,
    edit: 1000,
    bash: 4000,
    fetch: 6000,
    /** Threshold (chars) above which tool output is saved as artifact file */
    artifactThresholdChars: 65536,
    /** Default limit for unknown tools */
    default: 4000,
    /** Head portion ratio when truncating */
    headRatio: 0.6,
    /** Tail portion ratio when truncating */
    tailRatio: 0.2,
  },

  /** Historical tool output progressive reduction */
  history: {
    /** Turns 0..N: full tool output preserved */
    fullRetainTurns: 3,
    /** Episode compaction keeps the latest active/current turns fully expanded */
    episodeFullRetainTurns: 3,
    /** Do not compact tiny newly-aged tails; wait until a meaningful episode is formed. */
    episodeMinCompactTurns: 3,
    /** Large tool-heavy tails may compact earlier even when they have fewer turns. */
    episodeMinCompactChars: 12000,
    /** Single-turn tails compact only when they are too large to keep waiting for a batch. */
    episodeUrgentCompactChars: 65536,
    /** Recompact many existing blocks from raw messages when the prompt lane becomes block-heavy. */
    timelineRecompactBlockCountThreshold: 8,
    /** Recompact existing blocks from raw messages when projected history remains large. */
    timelineRecompactCharsThreshold: 140000,
    /** Apply tool-result recency reduction when even the current projected prompt is oversized. */
    promptPressureCharsThreshold: 180000,
    /** Under prompt pressure, keep only the most recent N tool_result payloads fully expanded. */
    promptPressureFullToolResults: 4,
    /** Under prompt pressure, keep the next N tool_result payloads as short summaries. */
    promptPressureSummaryToolResults: 16,
    /** Prompt manifest cap; full evidence remains in artifact files and trace metadata. */
    episodePromptEvidenceLimit: 12,
    /** Prompt tool-observation cap; prevents deterministic fallback from becoming an IO dump. */
    episodePromptObservationLimit: 16,
    /** Max raw tool_result chars included per tool in the compaction model prompt. */
    compactionPromptToolResultMaxChars: 24000,
    /** Max covered_messages chars sent to the compaction model. */
    compactionPromptTranscriptMaxChars: 180000,
    /** Minimum raw tool IO chars before a single tool gets environment-digested. */
    toolDigestMinRawChars: 12000,
    /** Minimum combined raw tool IO chars before a local tool chain gets environment-digested. */
    toolDigestGroupMinRawChars: 16000,
    /** Max tool_use/tool_result pairs sent to one environment digest request. */
    toolDigestMaxPairs: 4,
    /** Max raw tool_result chars included per tool in the digest request. */
    toolDigestMaxRawCharsPerTool: 24000,
    /** Max output tokens for a tool environment digest request. */
    toolDigestMaxOutputTokens: 2048,
    /** Turns N+1..M: tool output truncated to summary */
    summaryRetainTurns: 8,
    /** Summary truncation length (chars) */
    summaryMaxChars: 200,
  },

  /** Memory retrieval */
  retrieval: {
    topN: 8,
    confidenceThreshold: 0.5,
    perMemoryMaxTokens: 400,
    vectorWeight: 0.8,
    recencyWeight: 0.2,
    recencyHalfLifeDays: 30,
    minScore: 0.3,
    agentMaxIterations: 3,
    agentMaxOutputTokens: 512,
    agentMaxSelectedMemories: 3,
  },

  /** SubAgent context */
  subAgent: {
    upstreamMaxTokens: 2000,
  },

  /** Queued message injection */
  queue: {
    maxContinuationRetries: 2,
    maxRetainMessages: 5,
  },

  /** Ordinary end_turn task closure */
  completion: {
    maxTaskClosureRetries: 5,
    maxEmptyResponseRetries: 1,
  },

  /** Prompt the agent to evaluate non-session memory writes at turn end */
  memoryNudge: {
    minIterations: 2,
    maxNudgesPerTurn: 1,
  },
} as const
