/**
 * Centralized tuning parameters for the context engineering system.
 * All magic numbers are collected here for easy experimentation.
 */
export const CONTEXT_PARAMS = {
  /** P3a 会话内活文档折叠（同主题 create→update 合并），默认关：先影子标定折叠率再开 */
  memory: {
    // 2026-06-10 经真实数据回放标定后开启（会话内去重 40%，ComfyUI 24→4、ADB 7→1）。
    liveDocEnabled: true,
    liveDocMaxChars: 8000,
    // 真实数据回放实测：tag 键折叠仅消除 1%（tag 漂移是常态），向量路径才是主力；
    // 阈值 0.90（与聚类入簇阈值一致）会话内重复消除 40%，0.92 只有 29%。折叠是 append 不丢内容，0.90 风险可控。
    liveDocVectorEnabled: true,
    liveDocSimThreshold: 0.9,
  },
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
    timelineRecompactBlockCountThreshold: 16,
    /** Recompact existing blocks from raw messages when projected history remains large. */
    timelineRecompactCharsThreshold: 280000,
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
    compactionPromptToolResultMaxChars: 8000,
    /** Max covered_messages chars sent to the compaction model. */
    compactionPromptTranscriptMaxChars: 60000,
    /** Timeout for a single context compaction model request; on timeout the deterministic fallback is used. */
    compactionModelTimeoutMs: 60000,
    /** Turns N+1..M: tool output truncated to summary */
    summaryRetainTurns: 8,
    /** Summary truncation length (chars) */
    summaryMaxChars: 200,
    /** When truncating tool results, retain up to N exact handles (paths/URLs/filenames). */
    handleRetentionMaxHandles: 8,
    /** Char budget for the retained-handle line appended to truncated tool results. */
    handleRetentionMaxChars: 400,
    /** Handle-trail cap for a timeline compaction block; blocks cover many messages. */
    blockHandleRetentionMaxHandles: 64,
    /** Char budget for the handle trail embedded in a timeline compaction block summary. */
    blockHandleRetentionMaxChars: 3200,
  },

  /** Memory retrieval */
  retrieval: {
    topN: 8,
    confidenceThreshold: 0.5,
    perMemoryMaxTokens: 400,
    // 打分规则 v2(2026-09-03):门槛分 gate = 0.75*校准向量 + 0.25*词面重叠,只看相关性;
    // recency/usage 降级为排序偏置(+0.1/+0.05),不再参与 minScore 判定。
    // 背景:旧混合分 0.7*vec+0.2*recency+0.1*usage 中 30% 与相关性无关,历史 trace 实证
    // 真实命中 0.45~0.61 与噪声 0.31~0.45 区间重叠——0.7 门槛全灭(5347efbc 事故,
    // memory_search 全量 0 结果、usage 无注入永无法积累的死锁),0.3 门槛噪声全过,无法两全。
    relevanceVectorWeight: 0.75,
    relevanceLexicalWeight: 0.25,
    rankRecencyBias: 0.1,
    rankUsageBias: 0.05,
    // 向量 cosine 仿射校准锚点:cosine∈[floor,ceiling] → [0,1]。text-embedding-v4 实测
    // 同一记忆因查询措辞不同 cosine 在 0.55~0.79 摆动,原始值不校准则门槛随模型漂移。
    vectorFloor: 0.35,
    vectorCeiling: 0.75,
    recencyHalfLifeDays: 30,
    // minScore 语义随 v2 变为"只判门槛分(纯相关性)"。2026-09-03 历史会话回放实证
    // (10 个会话跨 0.15/0.3/0.7 三个时期, 54 组 selector 选中正例/148 组未选负例):
    // gate@0.5 保留正例 85%,拦截返回候选的 31% 弱尾;近重复任务(X视频ASR) gate 0.61~0.87
    // 全部通过。对照:旧公式 0.3 拦截率 0%(噪声全过),0.7 正例全灭(0/54)。门槛不做精确
    // 筛选——layer1 的 LLM selector 负责精筛,门槛只负责拦噪声+控量。
    minScore: 0.5,
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
