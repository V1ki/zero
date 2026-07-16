import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import {
  type CompactionActivity,
  type CompactionRunResult,
  type CompactionSessionBinding,
  runCompactionHarness,
  stableDigest,
  stableJson,
} from '@zero-os/compaction'
import { getSessionLogRelativeDir } from '@zero-os/shared'

export interface CompactionHarnessEvalOptions {
  sessionId: string
  tracePath: string
  logsRoot: string
  dbPath?: string
  outDir: string
  repeat: number
  maxCandidateChars?: number
  maxLedgerChars?: number
  maxLedgerBytes?: number
  maxPublishedPayloadBytes?: number
}

export interface CompactionHarnessDbBaseline {
  messageCount: number | null
  messagesJsonChars: number | null
  messagesJsonBytes: number | null
  compactionBlockCount: number | null
  compactionBlocksJsonChars: number | null
  compactionBlocksJsonBytes: number | null
}

export interface CompactionHarnessDiagnosticSummary {
  semanticCandidatesPassed: number
  semanticCandidatesValidationFailed: number
  fallbackBlocksCreated: number
  semanticBlocksCreated: number
  successfulCandidateInstallRate: number | null
  compactionModelDurationMs: number
  maxCompactionPromptChars: number
}

export interface CompactionHarnessEvalReport {
  generatedAt: string
  sessionId: string
  tracePath: string
  semanticReplacementEvaluated: false
  sessionBindingPresent: boolean
  sessionBindingStable: boolean | null
  repeat: number
  deterministic: boolean | null
  sourceDigestStable: boolean | null
  checkpointDigests: string[]
  sourceDigests: string[]
  baseline?: CompactionHarnessDbBaseline
  diagnostics?: CompactionHarnessDiagnosticSummary
  runs: CompactionRunResult[]
}

export function parseCompactionHarnessEvalArgs(argv: string[]): CompactionHarnessEvalOptions {
  const cwd = process.cwd()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  let sessionId = ''
  let tracePath = ''
  let logsRoot = join(cwd, '.zero', 'logs')
  let dbPath: string | undefined = join(logsRoot, 'sessions.db')
  let outDir = join(cwd, 'benchmarks', 'zero-runtime', 'results', `compaction-harness-${timestamp}`)
  let repeat = 2
  let maxCandidateChars: number | undefined
  let maxLedgerChars: number | undefined
  let maxLedgerBytes: number | undefined
  let maxPublishedPayloadBytes: number | undefined

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--session' && next) {
      sessionId = next
      index++
    } else if (arg === '--trace' && next) {
      tracePath = resolve(next)
      index++
    } else if (arg === '--logs' && next) {
      logsRoot = resolve(next)
      index++
    } else if (arg === '--db' && next) {
      dbPath = resolve(next)
      index++
    } else if (arg === '--no-db') {
      dbPath = undefined
    } else if (arg === '--out' && next) {
      outDir = resolve(next)
      index++
    } else if (arg === '--repeat' && next) {
      repeat = parsePositiveInteger(next, repeat)
      index++
    } else if (arg === '--max-candidate-chars' && next) {
      maxCandidateChars = parsePositiveInteger(next, 100_000)
      index++
    } else if (arg === '--max-ledger-chars' && next) {
      maxLedgerChars = parsePositiveInteger(next, 1_000_000)
      index++
    } else if (arg === '--max-ledger-bytes' && next) {
      maxLedgerBytes = parsePositiveInteger(next, 1_500_000)
      index++
    } else if (arg === '--max-published-bytes' && next) {
      maxPublishedPayloadBytes = parsePositiveInteger(next, 2_000_000)
      index++
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }

  if (!sessionId) throw new Error('--session is required')
  if (!tracePath) tracePath = join(logsRoot, getSessionLogRelativeDir(sessionId), 'trace.jsonl')
  return {
    sessionId,
    tracePath,
    logsRoot,
    ...(dbPath ? { dbPath } : {}),
    outDir,
    repeat,
    ...(maxCandidateChars ? { maxCandidateChars } : {}),
    ...(maxLedgerChars ? { maxLedgerChars } : {}),
    ...(maxLedgerBytes ? { maxLedgerBytes } : {}),
    ...(maxPublishedPayloadBytes ? { maxPublishedPayloadBytes } : {}),
  }
}

export async function runCompactionHarnessEval(
  options: CompactionHarnessEvalOptions,
): Promise<CompactionHarnessEvalReport> {
  const initialDbSnapshot = options.dbPath
    ? readDbSnapshot(options.dbPath, options.sessionId)
    : undefined
  const limits = {
    ...(options.maxCandidateChars ? { maxCandidateChars: options.maxCandidateChars } : {}),
    ...(options.maxLedgerChars ? { maxLedgerChars: options.maxLedgerChars } : {}),
    ...(options.maxLedgerBytes ? { maxLedgerBytes: options.maxLedgerBytes } : {}),
    ...(options.maxPublishedPayloadBytes
      ? { maxPublishedPayloadBytes: options.maxPublishedPayloadBytes }
      : {}),
  }
  const runs: CompactionRunResult[] = []
  for (let index = 0; index < options.repeat; index++) {
    runs.push(
      await runCompactionHarness({
        runId: `trace_eval_${index + 1}`,
        sourceSessionId: options.sessionId,
        tracePath: options.tracePath,
        allowedTraceRoot: options.logsRoot,
        mode: 'dry_run',
        strategyVersion: 'trace_compaction_loop_v1',
        schemaVersion: 'trace_checkpoint_v1',
        ...(initialDbSnapshot?.binding ? { sessionBinding: initialDbSnapshot.binding } : {}),
        ...(Object.keys(limits).length > 0 ? { limits } : {}),
      }),
    )
  }

  const checkpointDigests = runs.flatMap((run) =>
    run.candidate ? [run.candidate.checkpointDigest] : [],
  )
  const sourceDigests = runs.flatMap((run) => (run.source ? [run.source.sourceDigest] : []))
  const finalDbSnapshot = options.dbPath
    ? readDbSnapshot(options.dbPath, options.sessionId)
    : undefined
  const sessionBindingStable = initialDbSnapshot?.binding
    ? stableJson(initialDbSnapshot.binding) === stableJson(finalDbSnapshot?.binding)
    : null
  const reportRuns = runs.map((run) =>
    sanitizeRunForReport(run, options.logsRoot, options.tracePath),
  )
  const report: CompactionHarnessEvalReport = {
    generatedAt: new Date().toISOString(),
    sessionId: options.sessionId,
    tracePath: displayPath(options.tracePath, options.logsRoot),
    semanticReplacementEvaluated: false,
    sessionBindingPresent: Boolean(initialDbSnapshot?.binding),
    sessionBindingStable,
    repeat: options.repeat,
    deterministic:
      options.repeat >= 2
        ? checkpointDigests.length === options.repeat && new Set(checkpointDigests).size === 1
        : null,
    sourceDigestStable:
      options.repeat >= 2
        ? sourceDigests.length === options.repeat && new Set(sourceDigests).size === 1
        : null,
    checkpointDigests,
    sourceDigests,
    ...(initialDbSnapshot ? { baseline: initialDbSnapshot.baseline } : {}),
    ...(runs[0]?.candidate
      ? { diagnostics: summarizeDiagnostics(runs[0].diagnosticActivities ?? []) }
      : {}),
    runs: reportRuns,
  }

  mkdirSync(options.outDir, { recursive: true })
  writeFileSync(join(options.outDir, 'summary.json'), JSON.stringify(report, null, 2), 'utf-8')
  writeFileSync(
    join(options.outDir, 'report.md'),
    renderCompactionHarnessEvalMarkdown(report),
    'utf-8',
  )
  return report
}

export function renderCompactionHarnessEvalMarkdown(report: CompactionHarnessEvalReport): string {
  const run = report.runs[0]
  const source = run?.source
  const candidate = run?.candidate
  const validation = run?.validation
  const baseline = report.baseline
  const diagnostics = report.diagnostics
  const incidentRows = [...(candidate?.incidents ?? []), ...(run?.diagnosticIncidents ?? [])]
    .sort((left, right) => right.count - left.count)
    .slice(0, 12)

  return `${[
    '# Trace-sidecar Compaction Harness Eval',
    '',
    `Session: \`${report.sessionId}\``,
    '',
    `Trace: \`${report.tracePath}\``,
    '',
    '> Scope: this report evaluates deterministic trace-fact reduction, entity-state isolation, potential-side-effect retention, and payload budgets. It does not evaluate replacement of canonical session history or downstream answer quality.',
    '',
    '## Outcome',
    '',
    `- Candidate kind: \`${candidate?.candidateKind ?? 'not_run'}\``,
    `- Semantic replacement evaluated: **${report.semanticReplacementEvaluated}**`,
    `- Canonical session binding captured: **${report.sessionBindingPresent}**`,
    `- Canonical session binding stable during replay: **${report.sessionBindingStable ?? 'not_available'}**`,
    `- Validation: **${validation?.status ?? 'not_run'}**`,
    `- Deterministic checkpoint: **${report.deterministic ?? 'not_evaluated'}**`,
    `- Source digest stable across replay: **${report.sourceDigestStable ?? 'not_evaluated'}**`,
    `- Phase: \`${run?.phase ?? 'not_run'}\``,
    `- Work items / merge depth: ${run?.workItems ?? 0} / ${run?.mergeDepth ?? 0}`,
    `- Sidecar replay duration: ${report.runs.map((item) => `${item.durationMs.toFixed(2)} ms`).join(' / ') || 'not_run'}`,
    '',
    '## Size and Coverage',
    '',
    '| metric | value |',
    '| --- | ---: |',
    `| trace bytes | ${source?.sourceBytes ?? 0} |`,
    `| trace lines | ${source?.sourceLines ?? 0} |`,
    `| unique spans | ${source?.uniqueSpans ?? 0} |`,
    `| projected observation chars | ${source?.projectedObservationChars ?? 0} |`,
    `| candidate chars | ${validation?.candidateChars ?? 0} |`,
    `| candidate bytes | ${validation?.candidateBytes ?? 0} |`,
    `| full ledger chars | ${validation?.ledgerChars ?? 0} |`,
    `| full ledger bytes | ${validation?.ledgerBytes ?? 0} |`,
    `| candidate + ledger bytes | ${validation?.publishedPayloadBytes ?? 0} |`,
    `| checkpoint-only trace shrink | ${formatPercent(validation?.checkpointOnlyTraceShrinkPercent)} |`,
    `| full published-payload trace shrink | ${formatPercent(validation?.publishedPayloadTraceShrinkPercent)} |`,
    `| lifecycle snapshot collapse | ${formatPercent(candidate?.metrics.lifecycleCollapsePercent)} |`,
    `| terminal errors covered | ${(candidate?.coverage.incidentErrorObservations ?? 0) + (candidate?.coverage.diagnosticIncidentErrorObservations ?? 0)} / ${(candidate?.coverage.errorObservations ?? 0) + (candidate?.coverage.diagnosticErrorObservations ?? 0)} |`,
    `| classified potential side effects retained | ${candidate?.coverage.retainedSideEffects ?? 0} / ${candidate?.coverage.sideEffectObservations ?? 0} |`,
    `| classified potential side effects selected inline | ${candidate?.coverage.selectedSideEffects ?? 0} |`,
    `| full ledger intervals | ${run?.ledger?.intervals.length ?? 0} |`,
    `| selected change points | ${candidate?.changePoints.length ?? 0} |`,
    ...(baseline
      ? [
          `| canonical messages JSON chars | ${baseline.messagesJsonChars ?? 0} |`,
          `| canonical messages JSON bytes | ${baseline.messagesJsonBytes ?? 0} |`,
          `| legacy blocks JSON chars | ${baseline.compactionBlocksJsonChars ?? 0} |`,
          `| legacy blocks JSON bytes | ${baseline.compactionBlocksJsonBytes ?? 0} |`,
          `| legacy block count | ${baseline.compactionBlockCount ?? 0} |`,
        ]
      : []),
    '',
    '## Legacy Compaction Diagnostics (existing trace only)',
    '',
    '- These counters describe the existing compaction path captured in the trace; they are not semantic-quality results from this new sidecar module.',
    ...(diagnostics
      ? [
          `- Semantic candidates passed: ${diagnostics.semanticCandidatesPassed}`,
          `- Semantic validation failures: ${diagnostics.semanticCandidatesValidationFailed}`,
          `- Created deterministic fallback blocks: ${diagnostics.fallbackBlocksCreated}`,
          `- Created semantic blocks: ${diagnostics.semanticBlocksCreated}`,
          `- Successful candidate install rate: ${formatNullablePercent(diagnostics.successfulCandidateInstallRate)}`,
          `- Compaction model time: ${Math.round(diagnostics.compactionModelDurationMs / 1000)} seconds`,
          `- Maximum compaction prompt: ${diagnostics.maxCompactionPromptChars} chars`,
        ]
      : ['- No diagnostic summary available.']),
    '',
    '## Top Error Intervals',
    '',
    '| operation | class | count | first | last | recovered |',
    '| --- | --- | ---: | --- | --- | --- |',
    ...incidentRows.map(
      (incident) =>
        `| \`${incident.operation}\` | \`${incident.errorClass}\` | ${incident.count} | ${incident.firstAt} | ${incident.lastAt} | ${incident.recoveredAt ?? '-'} |`,
    ),
    '',
    ...(validation?.errors.length
      ? ['## Validation Errors', '', ...validation.errors.map((error) => `- \`${error}\``), '']
      : []),
    ...(validation?.warnings.length
      ? [
          '## Validation Warnings',
          '',
          ...validation.warnings.map((warning) => `- \`${warning}\``),
          '',
        ]
      : []),
  ].join('\n')}\n`
}

function summarizeDiagnostics(
  activities: CompactionActivity[],
): CompactionHarnessDiagnosticSummary {
  const compactionModel = activities.filter((item) => item.operation === 'context_compaction_model')
  const blockEvents = activities.filter((item) => item.operation === 'timeline_compaction_block')
  const semanticCandidatesPassed = metricSum(compactionModel, 'validationPassed')
  const semanticCandidatesValidationFailed = metricSum(compactionModel, 'validationFailed')
  const fallbackBlocksCreated = metricSum(blockEvents, 'deterministicFallbackBlock')
  const semanticBlocksCreated = metricSum(blockEvents, 'semanticBlockCreated')
  return {
    semanticCandidatesPassed,
    semanticCandidatesValidationFailed,
    fallbackBlocksCreated,
    semanticBlocksCreated,
    successfulCandidateInstallRate:
      semanticCandidatesPassed > 0
        ? (semanticBlocksCreated / semanticCandidatesPassed) * 100
        : null,
    compactionModelDurationMs: metricSum(compactionModel, 'durationMs'),
    maxCompactionPromptChars: metricMax(compactionModel, 'promptChars'),
  }
}

function metricSum(activities: CompactionActivity[], key: string): number {
  return activities.reduce((total, activity) => total + (activity.metrics[key]?.sum ?? 0), 0)
}

function metricMax(activities: CompactionActivity[], key: string): number {
  return activities.reduce(
    (maximum, activity) => Math.max(maximum, activity.metrics[key]?.max ?? 0),
    0,
  )
}

function readDbSnapshot(
  dbPath: string,
  sessionId: string,
): { baseline: CompactionHarnessDbBaseline; binding?: CompactionSessionBinding } {
  const db = new Database(dbPath, { readonly: true })
  let transactionOpen = false
  try {
    db.exec('begin')
    transactionOpen = true
    const result = readDbSnapshotTransaction(db, sessionId)
    db.exec('commit')
    transactionOpen = false
    return result
  } catch (error) {
    if (transactionOpen) db.exec('rollback')
    throw error
  } finally {
    db.close()
  }
}

function readDbSnapshotTransaction(
  db: Database,
  sessionId: string,
): { baseline: CompactionHarnessDbBaseline; binding?: CompactionSessionBinding } {
  const message = db
    .query(
      `select messages_json as messagesJson,
                message_count as messageCount,
                updated_at as updatedAt,
                length(messages_json) as messagesJsonChars,
                length(cast(messages_json as blob)) as messagesJsonBytes
         from session_messages where session_id = ?`,
    )
    .get(sessionId) as {
    messagesJson: string
    messageCount: number
    updatedAt: string
    messagesJsonChars: number
    messagesJsonBytes: number
  } | null
  const blocks = db
    .query(
      `select block_count as compactionBlockCount,
                updated_at as updatedAt,
                length(blocks_json) as compactionBlocksJsonChars,
                length(cast(blocks_json as blob)) as compactionBlocksJsonBytes
         from session_compaction_blocks where session_id = ?`,
    )
    .get(sessionId) as {
    compactionBlockCount: number
    updatedAt: string
    compactionBlocksJsonChars: number
    compactionBlocksJsonBytes: number
  } | null
  const baseline: CompactionHarnessDbBaseline = {
    messageCount: message?.messageCount ?? null,
    messagesJsonChars: message?.messagesJsonChars ?? null,
    messagesJsonBytes: message?.messagesJsonBytes ?? null,
    compactionBlockCount: blocks?.compactionBlockCount ?? null,
    compactionBlocksJsonChars: blocks?.compactionBlocksJsonChars ?? null,
    compactionBlocksJsonBytes: blocks?.compactionBlocksJsonBytes ?? null,
  }
  if (!message || !blocks) return { baseline }

  const activeHeads = db
    .query(
      `select json_extract(value, '$.id') as id,
                coalesce(json_extract(value, '$.generation'), 0) as generation
         from session_compaction_blocks, json_each(blocks_json)
         where session_id = ? and json_extract(value, '$.status') = 'active'`,
    )
    .all(sessionId) as Array<{ id: string | null; generation: number }>
  const normalizedHeads = activeHeads
    .filter((item): item is { id: string; generation: number } => typeof item.id === 'string')
    .sort(
      (left, right) => right.generation - left.generation || compareCodeUnits(left.id, right.id),
    )
  const parsedMessages = parseMessageIds(message.messagesJson)
  const messagesDigest = sha256(message.messagesJson)
  const binding: CompactionSessionBinding = {
    messagesRevision: `${message.updatedAt}:${message.messageCount}:${message.messagesJsonBytes}`,
    messagesDigest,
    compactionBlocksRevision: `${blocks.updatedAt}:${blocks.compactionBlockCount}:${blocks.compactionBlocksJsonBytes}`,
    compactionBlocksDigest: digestCompactionBlocks(db, sessionId, blocks.compactionBlocksJsonBytes),
    activeBlockHeadsDigest: stableDigest(normalizedHeads),
    ...(normalizedHeads[0]?.id ? { previousCheckpointHead: normalizedHeads[0].id } : {}),
    rollbackGeneration: normalizedHeads.reduce(
      (maximum, item) => Math.max(maximum, item.generation),
      0,
    ),
    coveredMessageDigest: messagesDigest,
    coveredMessageRange: {
      ...(parsedMessages.fromMessageId ? { fromMessageId: parsedMessages.fromMessageId } : {}),
      ...(parsedMessages.toMessageId ? { toMessageId: parsedMessages.toMessageId } : {}),
      messageCount: message.messageCount,
    },
  }
  return { baseline, binding }
}

function digestCompactionBlocks(db: Database, sessionId: string, byteLength: number): string {
  const hasher = createHash('sha256')
  const chunkSize = 1024 * 1024
  const query = db.query(
    `select substr(cast(blocks_json as blob), ?, ?) as chunk
     from session_compaction_blocks where session_id = ?`,
  )
  for (let offset = 1; offset <= byteLength; offset += chunkSize) {
    const row = query.get(offset, chunkSize, sessionId) as { chunk: unknown } | null
    const chunk = row?.chunk
    if (typeof chunk === 'string') hasher.update(chunk)
    else if (chunk instanceof Uint8Array) hasher.update(chunk)
    else throw new Error('compaction_blocks_digest_chunk_missing')
  }
  return hasher.digest('hex')
}

function parseMessageIds(messagesJson: string): {
  fromMessageId?: string
  toMessageId?: string
} {
  try {
    const messages = JSON.parse(messagesJson) as unknown
    if (!Array.isArray(messages)) return {}
    const first = asMessageId(messages[0])
    const last = asMessageId(messages.at(-1))
    return {
      ...(first ? { fromMessageId: first } : {}),
      ...(last ? { toMessageId: last } : {}),
    }
  } catch {
    return {}
  }
}

function asMessageId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = (value as Record<string, unknown>).id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sanitizeRunForReport(
  run: CompactionRunResult,
  logsRoot: string,
  tracePath: string,
): CompactionRunResult {
  const redact = (value: string) => redactKnownPaths(value, [tracePath, logsRoot])
  return {
    ...run,
    events: run.events.map((event) =>
      event.detail ? { ...event, detail: redact(event.detail) } : event,
    ),
    ...(run.error ? { error: redact(run.error) } : {}),
    ...(run.source
      ? { source: { ...run.source, sourcePath: displayPath(run.source.sourcePath, logsRoot) } }
      : {}),
  }
}

function redactKnownPaths(value: string, paths: string[]): string {
  const candidates = new Set<string>()
  for (const path of paths) {
    candidates.add(resolve(path))
    candidates.add(realpathOrResolve(path))
  }
  let result = value
  for (const path of [...candidates].sort((left, right) => right.length - left.length)) {
    if (path.length > 1) result = result.split(path).join('<redacted-path>')
  }
  return result
}

function displayPath(path: string, root: string): string {
  const canonicalPath = realpathOrResolve(path)
  const canonicalRoot = realpathOrResolve(root)
  const relativePath = relative(canonicalRoot, canonicalPath)
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    resolve(canonicalRoot, relativePath) !== canonicalPath
  ) {
    return basename(canonicalPath)
  }
  return relativePath
}

function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function formatPercent(value: number | undefined): string {
  return `${(value ?? 0).toFixed(2)}%`
}

function formatNullablePercent(value: number | null): string {
  return value === null ? '-' : `${value.toFixed(2)}%`
}

function printHelp(): void {
  console.log(`Usage: bun run compaction:harness-eval --session <id> [options]

Options:
  --trace <path>                 Explicit trace.jsonl path
  --logs <path>                  Logs root (default .zero/logs)
  --db <path>                    sessions.db for size baseline
  --no-db                        Skip sessions.db baseline
  --out <dir>                    Output directory
  --repeat <n>                   Replay count for determinism (default 2)
  --max-candidate-chars <n>      Candidate hard cap (default 100000)
  --max-ledger-chars <n>         Full ledger char cap (default 1000000)
  --max-ledger-bytes <n>         Full ledger byte cap (default 1500000)
  --max-published-bytes <n>      Candidate + ledger byte cap (default 2000000)
`)
}
