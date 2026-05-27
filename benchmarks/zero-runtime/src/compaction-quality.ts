import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  type ContextCompactionModelInput,
  type ContextCompactionModelOutput,
  estimateConversationTokens,
  prepareConversationHistoryWithCompaction,
} from '@zero-os/core'
import type { ContentBlock, Message, TimelineCompactionBlock } from '@zero-os/shared'

export interface CompactionQualityOptions {
  dbPath: string
  outDir: string
  sessionIds?: string[]
  sessionLimit: number
  checkpointsPerSession: number
  minCheckpointsPerSession: number
  keepArtifacts: boolean
}

export interface CompactionQualityReport {
  generatedAt: string
  dbPath: string
  options: {
    sessionLimit: number
    checkpointsPerSession: number
    minCheckpointsPerSession: number
  }
  note: string
  sessions: SessionQualityResult[]
  checkpoints: CheckpointQualityResult[]
}

export interface SessionQualityResult {
  sessionId: string
  messageCount: number
  messageJsonChars: number
  checkpointCount: number
  avgPromptSavingPercent: number
  avgCompactQualityScore: number | null
  avgAccuracyLossPercent: number | null
  weakCheckpointCount: number
  dominantCause: string
  activeBlockCountAvg: number
  compactedMessageCountAvg: number
}

export interface CheckpointQualityResult {
  sessionId: string
  checkpointId: string
  turnOrdinal: number
  messageIndex: number
  nextUserPreview: string
  rawPromptChars: number
  compactPromptChars: number
  promptSavingPercent: number
  rawTokens: number
  compactTokens: number
  tokenSavingPercent: number
  baselineScore: number | null
  compactScore: number | null
  accuracyLossPercent: number | null
  oracleTermCount: number
  compactedMessageCount: number
  activeBlockCount: number
  evidenceCount: number
  topMissingTerms: string[]
  categoryScores: Record<string, number | null>
  cause: string
}

interface SessionRow {
  sessionId: string
  messageCount: number
  messageJsonChars: number
  messagesJson: string
}

interface CheckpointCandidate {
  turnOrdinal: number
  messageIndex: number
  nextMessageIndex: number
}

interface WeightedTerm {
  term: string
  normalized: string
  weight: number
  category: string
}

interface ScoreResult {
  score: number | null
  hitWeight: number
  totalWeight: number
  missingTerms: WeightedTerm[]
  categoryScores: Record<string, number | null>
}

interface CompactionStats {
  compactedMessageCount: number
  activeBlockCount: number
  evidenceCount: number
}

const qualityNote =
  'This is an offline compaction quality proxy. It does not replay the main agent model. It compares terms that the next real turn later reused against the compacted prompt projection, so loss means the compacted context no longer exposes evidence the historical task path needed.'

const stopTerms = new Set([
  'assistant',
  'message',
  'session',
  'system',
  'notice',
  'tool',
  'tool_use',
  'tool_result',
  'result',
  'content',
  'createdat',
  'created',
  'input',
  'output',
  'summary',
  '用户',
  '这个',
  '一下',
  '已经',
  '现在',
  '需要',
  '可以',
  '没有',
  '不是',
  '如果',
  '因为',
  '所以',
  '进行',
  '查看',
  '确认',
  '当前',
  '输出',
])

export function parseCompactionQualityArgs(argv: string[]): CompactionQualityOptions {
  const cwd = process.cwd()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const options: CompactionQualityOptions = {
    dbPath: join(cwd, '.zero', 'logs', 'sessions.db'),
    outDir: join(cwd, 'benchmarks', 'zero-runtime', 'results', `compaction-quality-${timestamp}`),
    sessionLimit: 10,
    checkpointsPerSession: 5,
    minCheckpointsPerSession: 3,
    keepArtifacts: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--db' && next) {
      options.dbPath = next
      index++
    } else if (arg === '--out' && next) {
      options.outDir = next
      index++
    } else if (arg === '--sessions' && next) {
      options.sessionIds = next
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
      index++
    } else if (arg === '--limit' && next) {
      options.sessionLimit = parsePositiveInt(next, options.sessionLimit)
      index++
    } else if (arg === '--checkpoints' && next) {
      options.checkpointsPerSession = parsePositiveInt(next, options.checkpointsPerSession)
      index++
    } else if (arg === '--min-checkpoints' && next) {
      options.minCheckpointsPerSession = parsePositiveInt(next, options.minCheckpointsPerSession)
      index++
    } else if (arg === '--keep-artifacts') {
      options.keepArtifacts = true
    } else if (arg === '--help' || arg === '-h') {
      printCompactionQualityHelp()
      process.exit(0)
    }
  }

  return options
}

export function printCompactionQualityHelp(): void {
  console.log(`Usage: bun run compaction:quality [options]

Options:
  --db <path>               sessions.db path (default .zero/logs/sessions.db)
  --out <dir>               output directory
  --sessions <ids>          comma-separated session ids; defaults to top sessions by JSON size
  --limit <n>               number of long sessions to select (default 10)
  --checkpoints <n>         checkpoints per session, sampled across turns (default 5)
  --min-checkpoints <n>     preferred minimum checkpoints per session (default 3)
  --keep-artifacts          keep temporary evidence artifacts instead of deleting them
`)
}

export async function runCompactionQualityEval(
  options: CompactionQualityOptions,
): Promise<CompactionQualityReport> {
  const db = new Database(options.dbPath, { readonly: true })
  try {
    const rows = loadSessionRows(db, options)
    const artifactRoot = mkdtempSync(join(tmpdir(), 'zero-compaction-quality-'))
    const checkpoints: CheckpointQualityResult[] = []

    try {
      for (const row of rows) {
        const messages = parseMessages(row.messagesJson)
        const selected = selectCheckpointCandidates(
          messages,
          options.checkpointsPerSession,
          options.minCheckpointsPerSession,
        )
        for (const candidate of selected) {
          checkpoints.push(
            await evaluateCheckpoint({
              row,
              messages,
              candidate,
              artifactRoot,
            }),
          )
        }
      }
    } finally {
      if (!options.keepArtifacts) {
        rmSync(artifactRoot, { recursive: true, force: true })
      }
    }

    const report: CompactionQualityReport = {
      generatedAt: new Date().toISOString(),
      dbPath: options.dbPath,
      options: {
        sessionLimit: options.sessionLimit,
        checkpointsPerSession: options.checkpointsPerSession,
        minCheckpointsPerSession: options.minCheckpointsPerSession,
      },
      note: qualityNote,
      sessions: summarizeSessions(rows, checkpoints),
      checkpoints,
    }

    mkdirSync(options.outDir, { recursive: true })
    writeFileSync(join(options.outDir, 'summary.json'), JSON.stringify(report, null, 2), 'utf-8')
    writeFileSync(
      join(options.outDir, 'report.md'),
      renderCompactionQualityMarkdown(report),
      'utf-8',
    )
    return report
  } finally {
    db.close()
  }
}

export function renderCompactionQualityMarkdown(report: CompactionQualityReport): string {
  const lines = [
    '# Compaction Quality Eval',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `DB: \`${report.dbPath}\``,
    '',
    `Note: ${report.note}`,
    '',
    '## Session Summary',
    '',
    [
      '| session | checkpoints | raw MB | avg prompt saving | avg compact score | avg accuracy loss | weak checkpoints | dominant cause |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
      ...report.sessions.map((session) =>
        markdownRow([
          `\`${session.sessionId}\``,
          session.checkpointCount,
          formatMb(session.messageJsonChars),
          formatPercent(session.avgPromptSavingPercent),
          formatNullablePercent(session.avgCompactQualityScore),
          formatNullablePercent(session.avgAccuracyLossPercent),
          session.weakCheckpointCount,
          session.dominantCause,
        ]),
      ),
    ].join('\n'),
    '',
    '## Checkpoint Details',
    '',
    [
      '| session | turn | saving | score | loss | terms | blocks | missing examples | cause | next user |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |',
      ...report.checkpoints.map((checkpoint) =>
        markdownRow([
          `\`${checkpoint.sessionId}\``,
          checkpoint.turnOrdinal,
          formatPercent(checkpoint.promptSavingPercent),
          formatNullablePercent(checkpoint.compactScore),
          formatNullablePercent(checkpoint.accuracyLossPercent),
          checkpoint.oracleTermCount,
          checkpoint.activeBlockCount,
          checkpoint.topMissingTerms.map((term) => `\`${escapeMarkdown(term)}\``).join(', ') || '-',
          checkpoint.cause,
          escapeMarkdown(checkpoint.nextUserPreview),
        ]),
      ),
    ].join('\n'),
    '',
  ]
  return `${lines.join('\n')}\n`
}

export function selectCheckpointCandidates(
  messages: Message[],
  targetCount: number,
  minCount: number,
): CheckpointCandidate[] {
  const turnStarts = findTurnStarts(messages)
  const allCandidates = turnStarts
    .map((messageIndex, turnOrdinal) => ({
      messageIndex,
      turnOrdinal,
      nextMessageIndex: turnStarts[turnOrdinal + 1] ?? messages.length,
    }))
    .filter((candidate) => candidate.messageIndex > 0)

  const meaningful = allCandidates.filter((candidate) => {
    const message = messages[candidate.messageIndex]
    const text = extractMessageUserText(message)
    if (isSystemNotice(text)) return false
    const futureWindow = messages.slice(candidate.messageIndex, candidate.nextMessageIndex)
    return futureWindow.some(
      (item) =>
        item.role === 'assistant' || item.content.some((block) => block.type === 'tool_use'),
    )
  })

  const source =
    meaningful.length >= Math.min(minCount, targetCount)
      ? meaningful
      : allCandidates.filter((candidate) => {
          const message = messages[candidate.messageIndex]
          return extractMessageUserText(message).trim().length > 0
        })

  return pickEvenly(source, targetCount)
}

export function scoreCompactedContext(params: {
  prefixMessages: Message[]
  compactedMessages: Message[]
  futureWindow: Message[]
}): {
  baseline: ScoreResult
  compact: ScoreResult
  terms: WeightedTerm[]
} {
  const prefixCorpus = collectMessagesSignalText(params.prefixMessages)
  const compactCorpus = collectMessagesSignalText(params.compactedMessages)
  const terms = buildOracleTerms(prefixCorpus, params.futureWindow)
  return {
    terms,
    baseline: scoreTerms(terms, prefixCorpus),
    compact: scoreTerms(terms, compactCorpus),
  }
}

async function evaluateCheckpoint(params: {
  row: SessionRow
  messages: Message[]
  candidate: CheckpointCandidate
  artifactRoot: string
}): Promise<CheckpointQualityResult> {
  const prefixMessages = cloneMessages(params.messages.slice(0, params.candidate.messageIndex))
  const futureWindow = cloneMessages(
    params.messages.slice(params.candidate.messageIndex, params.candidate.nextMessageIndex),
  )
  const blockSnapshots: TimelineCompactionBlock[][] = []
  const compactedMessages = await prepareConversationHistoryWithCompaction(
    cloneMessages(prefixMessages),
    {
      enableEpisodeCompaction: true,
      evidenceWorkDir: params.artifactRoot,
      sessionId: params.row.sessionId,
      onTimelineCompactionBlocksChanged: (blocks) => blockSnapshots.push(blocks),
      contextCompactor: deterministicCompactor,
    },
  )

  const scoring = scoreCompactedContext({
    prefixMessages,
    compactedMessages,
    futureWindow,
  })
  const rawPromptChars = stableJsonLength(prefixMessages)
  const compactPromptChars = stableJsonLength(compactedMessages)
  const rawTokens = estimateConversationTokens(prefixMessages)
  const compactTokens = estimateConversationTokens(compactedMessages)
  const compactionStats = summarizeCompactionStats(blockSnapshots.at(-1) ?? [])
  const compactScore = scoring.compact.score
  const baselineScore = scoring.baseline.score
  const accuracyLossPercent =
    baselineScore === null || compactScore === null
      ? null
      : roundOne(Math.max(0, baselineScore - compactScore))

  return {
    sessionId: params.row.sessionId,
    checkpointId: `${params.row.sessionId}:turn_${params.candidate.turnOrdinal}`,
    turnOrdinal: params.candidate.turnOrdinal,
    messageIndex: params.candidate.messageIndex,
    nextUserPreview: preview(extractMessageUserText(futureWindow[0]), 120),
    rawPromptChars,
    compactPromptChars,
    promptSavingPercent: percentReduction(rawPromptChars, compactPromptChars),
    rawTokens,
    compactTokens,
    tokenSavingPercent: percentReduction(rawTokens, compactTokens),
    baselineScore,
    compactScore,
    accuracyLossPercent,
    oracleTermCount: scoring.terms.length,
    compactedMessageCount: compactionStats.compactedMessageCount,
    activeBlockCount: compactionStats.activeBlockCount,
    evidenceCount: compactionStats.evidenceCount,
    topMissingTerms: scoring.compact.missingTerms.slice(0, 6).map((term) => term.term),
    categoryScores: scoring.compact.categoryScores,
    cause: inferLossCause({
      rawPromptChars,
      compactPromptChars,
      score: compactScore,
      loss: accuracyLossPercent,
      terms: scoring.terms,
      missingTerms: scoring.compact.missingTerms,
      compactedMessages,
      compactionStats,
    }),
  }
}

async function deterministicCompactor(
  input: ContextCompactionModelInput,
): Promise<ContextCompactionModelOutput> {
  const signalText = collectMessagesSignalText(input.segment)
  const terms = extractTerms(signalText)
    .filter((term) => !isLikelyGenericTerm(term.normalized))
    .slice(0, 60)
  const evidence = input.episode.evidence.slice(0, 12)
  const summary = [
    `覆盖 ${input.segment.length} 条历史消息，当前目标：${input.currentGoal}`,
    preview(input.episode.summary, 1200),
    terms.length > 0 ? `关键实体/路径/约束：${terms.map((term) => term.term).join(', ')}` : '',
    evidence.length > 0
      ? `原始工具证据：${evidence
          .map((item) => `${item.toolName}:${basename(item.path)}:${item.sha256.slice(0, 8)}`)
          .join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')

  return {
    summary,
    topics: [
      {
        id: 'T1',
        title: preview(input.currentGoal, 80) || '历史任务状态',
        status: input.episode.status === 'blocked' ? 'blocked' : 'in_progress',
        summary,
        sourceMessageRefs: input.segment.map((_message, index) => `E${index + 1}`).slice(0, 30),
        sourceMessageIds: input.segment.map((message) => message.id),
        toolRefs: input.episode.toolUseIds.map((_toolUseId, index) => `K${index + 1}`).slice(0, 30),
        toolUseIds: input.episode.toolUseIds,
        confirmedFacts: input.episode.confirmedFacts,
        decisions: [],
        currentState: [preview(input.workingStateSummary, 240)],
        openQuestions: input.episode.blockers,
        nextActions: [],
        evidence: evidence.map((item) => `${item.toolName}:${item.path}`),
        needsRawReview: input.episode.needsRawReview.length > 0,
      },
    ],
    confirmedFacts: [
      ...input.episode.confirmedFacts,
      ...terms.slice(0, 16).map((term) => term.term),
    ],
    userConstraints: terms
      .map((term) => term.term)
      .filter((term) => /不要|不能|必须|需要|保留|禁止|only|must|never/i.test(term))
      .slice(0, 12),
    decisions: [],
    currentState: [preview(input.workingStateSummary, 300)],
    openQuestions: input.episode.blockers,
    nextActions: [],
    doNotInfer: ['不要把 evidence pointer 等同于已读完全文；需要时回看原始证据。'],
    keyEvidence: evidence.map((item) => `${item.toolName}:${item.path}`),
    validation: {
      status: 'passed',
      promptVersion: 'offline_compaction_quality_proxy_v1',
      topicCount: 1,
      expectedToolRefs: input.episode.toolUseIds.map((_toolUseId, index) => `K${index + 1}`),
      coveredToolRefs: input.episode.toolUseIds.map((_toolUseId, index) => `K${index + 1}`),
      invalidToolRefs: [],
      missingToolRefs: [],
      expectedMessageRefs: input.segment.map((_message, index) => `E${index + 1}`),
      coveredMessageRefs: input.segment.map((_message, index) => `E${index + 1}`),
      invalidMessageRefs: [],
      errors: [],
      warnings: [],
    },
    model: {
      promptVersion: 'offline_compaction_quality_proxy_v1',
      usedModel: 'deterministic-offline-proxy',
      usedProvider: 'local',
      attempts: 1,
    },
  }
}

function loadSessionRows(db: Database, options: CompactionQualityOptions): SessionRow[] {
  if (options.sessionIds && options.sessionIds.length > 0) {
    const statement = db.prepare(`
      select session_id as sessionId,
             message_count as messageCount,
             length(messages_json) as messageJsonChars,
             messages_json as messagesJson
      from session_messages
      where session_id = ?
    `)
    return options.sessionIds.flatMap((sessionId) => {
      const row = statement.get(sessionId) as SessionRow | null
      return row ? [row] : []
    })
  }

  return db
    .query(
      `
        select session_id as sessionId,
               message_count as messageCount,
               length(messages_json) as messageJsonChars,
               messages_json as messagesJson
        from session_messages
        order by length(messages_json) desc
        limit $limit
      `,
    )
    .all({ $limit: options.sessionLimit }) as SessionRow[]
}

function summarizeSessions(
  rows: SessionRow[],
  checkpoints: CheckpointQualityResult[],
): SessionQualityResult[] {
  return rows.map((row) => {
    const items = checkpoints.filter((checkpoint) => checkpoint.sessionId === row.sessionId)
    const materialLossItems = items.filter((item) => (item.accuracyLossPercent ?? 0) > 5)
    const causeSource = materialLossItems.length > 0 ? materialLossItems : items
    const causes = countBy(causeSource.map((item) => item.cause))
    const dominantCause =
      [...causes.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 'no_checkpoints'
    return {
      sessionId: row.sessionId,
      messageCount: row.messageCount,
      messageJsonChars: row.messageJsonChars,
      checkpointCount: items.length,
      avgPromptSavingPercent: avg(items.map((item) => item.promptSavingPercent)),
      avgCompactQualityScore: nullableAvg(items.map((item) => item.compactScore)),
      avgAccuracyLossPercent: nullableAvg(items.map((item) => item.accuracyLossPercent)),
      weakCheckpointCount: items.filter((item) => (item.compactScore ?? 100) < 80).length,
      dominantCause,
      activeBlockCountAvg: avg(items.map((item) => item.activeBlockCount)),
      compactedMessageCountAvg: avg(items.map((item) => item.compactedMessageCount)),
    }
  })
}

function summarizeCompactionStats(blocks: TimelineCompactionBlock[]): CompactionStats {
  const activeBlocks = blocks.filter((block) => block.status === 'active')
  return {
    compactedMessageCount: activeBlocks.reduce((sum, block) => sum + block.coveredMessageCount, 0),
    activeBlockCount: activeBlocks.length,
    evidenceCount: activeBlocks.reduce((sum, block) => sum + block.evidenceCount, 0),
  }
}

function buildOracleTerms(prefixCorpus: string, futureWindow: Message[]): WeightedTerm[] {
  const prefixNorm = normalizeForMatch(prefixCorpus)
  const termMap = new Map<string, WeightedTerm>()
  for (const message of futureWindow) {
    for (const block of message.content) {
      const category = oracleCategory(message, block)
      const weight = categoryWeight(category)
      const text = blockToSignalText(block)
      for (const candidate of extractTerms(text)) {
        if (isLikelyGenericTerm(candidate.normalized)) continue
        if (!prefixNorm.includes(candidate.normalized)) continue
        const previous = termMap.get(candidate.normalized)
        if (!previous || previous.weight < weight) {
          termMap.set(candidate.normalized, {
            ...candidate,
            category,
            weight,
          })
        }
      }
    }
  }

  return [...termMap.values()]
    .sort((left, right) => right.weight - left.weight || right.term.length - left.term.length)
    .slice(0, 120)
}

function scoreTerms(terms: WeightedTerm[], corpus: string): ScoreResult {
  if (terms.length === 0) {
    return {
      score: null,
      hitWeight: 0,
      totalWeight: 0,
      missingTerms: [],
      categoryScores: {},
    }
  }
  const corpusNorm = normalizeForMatch(corpus)
  let hitWeight = 0
  let totalWeight = 0
  const missingTerms: WeightedTerm[] = []
  const byCategory = new Map<string, { hit: number; total: number }>()

  for (const term of terms) {
    totalWeight += term.weight
    const category = byCategory.get(term.category) ?? { hit: 0, total: 0 }
    category.total += term.weight
    if (corpusNorm.includes(term.normalized)) {
      hitWeight += term.weight
      category.hit += term.weight
    } else {
      missingTerms.push(term)
    }
    byCategory.set(term.category, category)
  }

  return {
    score: roundOne((hitWeight / totalWeight) * 100),
    hitWeight,
    totalWeight,
    missingTerms: missingTerms.sort(
      (left, right) => right.weight - left.weight || right.term.length - left.term.length,
    ),
    categoryScores: Object.fromEntries(
      [...byCategory.entries()].map(([category, item]) => [
        category,
        item.total > 0 ? roundOne((item.hit / item.total) * 100) : null,
      ]),
    ),
  }
}

function inferLossCause(params: {
  rawPromptChars: number
  compactPromptChars: number
  score: number | null
  loss: number | null
  terms: WeightedTerm[]
  missingTerms: WeightedTerm[]
  compactedMessages: Message[]
  compactionStats: CompactionStats
}): string {
  if (params.terms.length === 0) return 'oracle_terms_insufficient'
  if ((params.loss ?? 0) <= 5) return 'no_material_loss'
  const promptSaving = percentReduction(params.rawPromptChars, params.compactPromptChars)
  if (params.compactionStats.activeBlockCount === 0 || promptSaving < 5) {
    return 'compaction_not_triggered_or_recent_window_retained'
  }
  if (params.missingTerms.some((term) => term.category === 'future_tool_arg')) {
    return 'future_tool_argument_terms_missing'
  }
  if (params.missingTerms.some((term) => isPathLike(term.term) || isUrlLike(term.term))) {
    return 'precise_path_or_url_missing'
  }
  const compactCorpus = collectMessagesSignalText(params.compactedMessages)
  if (compactCorpus.includes('evidence_manifest') || compactCorpus.includes('.artifacts')) {
    return 'evidence_pointer_present_but_exact_terms_missing'
  }
  if ((params.score ?? 100) < 70) return 'semantic_summary_dropped_required_context'
  return 'minor_exact_term_loss'
}

function parseMessages(raw: string): Message[] {
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isMessage)
}

function cloneMessages(messages: Message[]): Message[] {
  return JSON.parse(JSON.stringify(messages)) as Message[]
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<Message>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.sessionId === 'string' &&
    typeof candidate.role === 'string' &&
    Array.isArray(candidate.content)
  )
}

function findTurnStarts(messages: Message[]): number[] {
  const starts: number[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (
      message.role === 'user' &&
      message.messageType === 'message' &&
      message.content.some((block) => block.type === 'text' && block.text.trim().length > 0)
    ) {
      starts.push(index)
    }
  }
  return starts
}

function pickEvenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items
  if (count <= 1) return [items[0]]
  const selected: T[] = []
  const used = new Set<number>()
  for (let index = 0; index < count; index++) {
    const position = Math.round((index * (items.length - 1)) / (count - 1))
    if (!used.has(position)) {
      selected.push(items[position])
      used.add(position)
    }
  }
  return selected
}

function collectMessagesSignalText(messages: Message[]): string {
  return messages.map(messageToSignalText).join('\n')
}

function messageToSignalText(message: Message): string {
  return message.content.map(blockToSignalText).filter(Boolean).join('\n')
}

function blockToSignalText(block: ContentBlock): string {
  if (block.type === 'text') return block.text
  if (block.type === 'tool_use') {
    return [
      `tool_use ${block.name}`,
      boundedStableStringify(block.input),
      block.evidence?.summary,
    ].join('\n')
  }
  if (block.type === 'tool_result') {
    const itemText = block.contentItems?.map(blockToSignalText).join('\n') ?? ''
    return [
      'tool_result',
      block.outputSummary,
      preview(stripLargeEncodedPayloads(block.content), 8000),
      itemText,
      block.evidence?.summary,
      block.evidence?.path,
    ]
      .filter(Boolean)
      .join('\n')
  }
  if (block.type === 'image') {
    return ['image', block.mediaType, block.imageRef?.path, block.imageRef?.relativePath]
      .filter(Boolean)
      .join(' ')
  }
  if (block.type === 'thinking') return preview(block.thinking, 1200)
  return ''
}

function extractMessageUserText(message: Message | undefined): string {
  if (!message) return ''
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function extractTerms(text: string): WeightedTerm[] {
  const normalizedText = text.replace(/\s+/g, ' ')
  const candidates = [
    ...matchAll(normalizedText, /https?:\/\/[^\s"'<>）)]+/giu),
    ...matchAll(normalizedText, /(?:\/Users|\.zero|\.\/|\/tmp|\/private)\/[^\s"'<>）)]+/giu),
    ...matchAll(normalizedText, /[A-Za-z0-9_@.-]{4,}/g),
    ...matchAll(normalizedText, /[\p{Script=Han}][\p{Script=Han}A-Za-z0-9_《》「」“”·-]{1,23}/gu),
  ]
  const terms = new Map<string, WeightedTerm>()
  for (const raw of candidates) {
    const term = cleanTerm(raw)
    const normalized = normalizeForMatch(term)
    if (normalized.length < 2 || isLikelyGenericTerm(normalized)) continue
    if (!terms.has(normalized)) {
      terms.set(normalized, {
        term,
        normalized,
        category: 'generic',
        weight: defaultTermWeight(term),
      })
    }
  }
  return [...terms.values()].sort(
    (left, right) => right.weight - left.weight || right.term.length - left.term.length,
  )
}

function oracleCategory(message: Message, block: ContentBlock): string {
  if (block.type === 'tool_use') return 'future_tool_arg'
  if (message.role === 'user') return 'next_user_reference'
  if (message.role === 'assistant') return 'future_assistant_answer'
  return 'future_context'
}

function categoryWeight(category: string): number {
  if (category === 'future_tool_arg') return 3
  if (category === 'next_user_reference') return 2
  if (category === 'future_assistant_answer') return 1.5
  return 1
}

function defaultTermWeight(term: string): number {
  if (isUrlLike(term) || isPathLike(term)) return 3
  if (/[A-Z][A-Za-z0-9_-]{3,}/.test(term)) return 1.5
  return 1
}

function isLikelyGenericTerm(normalized: string): boolean {
  if (stopTerms.has(normalized)) return true
  if (/^[0-9]{4,}$/.test(normalized)) return true
  if (/^[a-f0-9]{12,}$/i.test(normalized)) return true
  if (/^(true|false|null|undefined|content|message|session|createdat)$/i.test(normalized)) {
    return true
  }
  return normalized.length > 160
}

function isUrlLike(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function isPathLike(value: string): boolean {
  return (
    /^(?:\/Users|\.zero|\.\/|\/tmp|\/private)\//.test(value) || /\.[A-Za-z0-9]{1,8}$/.test(value)
  )
}

function matchAll(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[0])
}

function cleanTerm(value: string): string {
  return value
    .replace(/^[`"'“”‘’([{<]+/, '')
    .replace(/[`"'“”‘’)\]}>,，。；;:：]+$/, '')
    .trim()
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function boundedStableStringify(value: unknown): string {
  return preview(JSON.stringify(value, stableReplacer), 8000)
}

function stableReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'string') return stripLargeEncodedPayloads(value)
  return value
}

function stripLargeEncodedPayloads(value: string): string {
  return value
    .replace(/data:[^"'\s]+;base64,[A-Za-z0-9+/=]{200,}/g, '[base64-data]')
    .replace(/[A-Za-z0-9+/=]{800,}/g, '[encoded-payload]')
}

function isSystemNotice(text: string): boolean {
  return text.includes('<system_notice>') || text.includes('<system-reminder>')
}

function preview(value: string | undefined, maxChars: number): string {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`
}

function stableJsonLength(value: unknown): number {
  return JSON.stringify(value).length
}

function percentReduction(before: number, after: number): number {
  if (before <= 0) return 0
  return roundOne(Math.max(0, ((before - after) / before) * 100))
}

function avg(values: number[]): number {
  if (values.length === 0) return 0
  return roundOne(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function nullableAvg(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null)
  return present.length > 0 ? avg(present) : null
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`
}

function formatNullablePercent(value: number | null): string {
  return value === null ? 'n/a' : formatPercent(value)
}

function formatMb(chars: number): string {
  return (chars / 1024 / 1024).toFixed(1)
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function markdownRow(values: Array<string | number>): string {
  return `| ${values.join(' | ')} |`
}

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
