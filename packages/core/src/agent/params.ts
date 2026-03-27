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
    task: 2000,
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
