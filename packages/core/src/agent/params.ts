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
    executionMode: 500,
    safety: 300,
    toolCallStyle: 200,
    skillCatalog: 2000,
    runtime: 400,
    bootstrapContext: 8000,
  },

  /** 检查点式上下文压缩（docs/context-compaction.md），比例都相对可用窗口 U = maxContext − maxOutput */
  compaction: {
    /** 压力（系统提示词 + 工具定义 + 投影后消息）达到 U × 该比例时压缩 */
    thresholdRatio: 0.8,
    /** 原文保留尾部的预算 = U × 该比例 */
    retainRatio: 0.2,
    /** 裁剪区内超过该字符数的 tool_result 只保留头尾 */
    prunedToolResultMaxChars: 2000,
    prunedToolResultHeadChars: 1200,
    prunedToolResultTailChars: 400,
    /** 裁剪后附带的 retained_handles 上限 */
    retainedHandlesMaxCount: 8,
    retainedHandlesMaxChars: 400,
    /** 摘要转写稿中 tool_use 输入和 tool_result 的头尾字符数 */
    transcriptToolInputHeadChars: 600,
    transcriptToolInputTailChars: 200,
    transcriptToolResultHeadChars: 3000,
    transcriptToolResultTailChars: 1000,
    /** 单次摘要请求的转写稿上限，超过后分段滚动 */
    transcriptMaxChars: 240_000,
    summaryMaxTokens: 4096,
    summaryTimeoutMs: 120_000,
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
  },

  /** Short previews of tool output (memory retrieval, tool evidence summaries) */
  history: {
    /** Summary truncation length (chars) */
    summaryMaxChars: 200,
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
