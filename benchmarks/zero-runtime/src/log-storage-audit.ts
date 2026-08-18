import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

export type LogStorageSource = 'both' | 'run' | 'trace'
export type LogStorageFormat = 'text' | 'json'

export interface LogStorageProgress {
  analyzedBytes: number
  discoveredSelectedBytes: number
  completedFiles: number
  selectedFiles: number
  currentFile: string
}

export interface LogStorageAuditOptions {
  logsDir: string
  source: LogStorageSource
  session?: string
  percentile: number
  format: LogStorageFormat
  top: number
  help: boolean
  onProgress?: (progress: LogStorageProgress) => void
}

export interface StorageBucketRow {
  key: string
  lines: number
  bytes: number
  sharePercent: number
}

export interface LogFileSelectionReport {
  candidateFiles: number
  nonEmptyFiles: number
  emptyFiles: number
  candidateBytes: number
  percentile: number
  cutoffBytes?: number
  selectedFiles: number
  discoveredSelectedBytes: number
}

interface SourceReportBase {
  selection: LogFileSelectionReport
  snapshotBytes: number
  scannedBytes: number
  lines: number
  completeLines: number
  partialTailLines: number
  partialTailBytes: number
  blankLines: number
  blankBytes: number
  unclassifiedLines: number
  unclassifiedBytes: number
  discoverySnapshotDriftBytes: number
  maxClassifierBufferedBytes: number
}

export interface RunLogStorageReport extends SourceReportBase {
  source: 'run.log'
  byCategory: StorageBucketRow[]
  byEvent: StorageBucketRow[]
  traceMirrorByKind: StorageBucketRow[]
}

export interface TraceLogStorageReport extends SourceReportBase {
  source: 'trace.jsonl'
  byKind: StorageBucketRow[]
  byKindStatus: StorageBucketRow[]
}

export interface LogStorageAuditReport {
  generatedAt: string
  logsDir: string
  sessionsRoot: string
  session?: string
  percentile: number
  run?: RunLogStorageReport
  trace?: TraceLogStorageReport
  totalSnapshotBytes: number
  totalScannedBytes: number
}

export const DEFAULT_LOG_STORAGE_AUDIT_OPTIONS: LogStorageAuditOptions = {
  logsDir: '.zero/logs',
  source: 'both',
  percentile: 0,
  format: 'text',
  top: 30,
  help: false,
}

const STREAM_CHUNK_BYTES = 256 * 1024
const MAX_CAPTURE_BYTES = 256
const MAX_BUCKETS = 10_000
const OVERFLOW_BUCKET = '<category-overflow>'
const BLANK_BUCKET = '<blank>'
const MISSING_EVENT_BUCKET = '<missing-event>'
const MISSING_KIND_BUCKET = '<missing-kind>'
const MISSING_STATUS_BUCKET = '<missing-status>'

interface LogFileCandidate {
  path: string
  relativePath: string
  source: 'run' | 'trace'
  size: number
}

interface SelectedFiles {
  report: LogFileSelectionReport
  files: LogFileCandidate[]
}

interface MutableBucket {
  lines: number
  bytes: number
}

interface MutableSourceStats {
  snapshotBytes: number
  scannedBytes: number
  lines: number
  completeLines: number
  partialTailLines: number
  partialTailBytes: number
  blankLines: number
  blankBytes: number
  unclassifiedLines: number
  unclassifiedBytes: number
  discoverySnapshotDriftBytes: number
  maxClassifierBufferedBytes: number
}

interface MutableRunStats extends MutableSourceStats {
  byCategory: Map<string, MutableBucket>
  byEvent: Map<string, MutableBucket>
  traceMirrorByKind: Map<string, MutableBucket>
}

interface MutableTraceStats extends MutableSourceStats {
  byKind: Map<string, MutableBucket>
  byKindStatus: Map<string, MutableBucket>
}

type TopLevelState = 'before-root' | 'key' | 'colon' | 'value' | 'after-value'
type StringRole = 'key' | 'target-value' | 'top-value' | 'ignored'

class TopLevelStringFieldScanner {
  readonly fields: Record<string, string | undefined> = {}
  hasNonWhitespace = false
  maxBufferedBytes = 0

  private readonly targets: Set<string>
  private readonly capture = Buffer.allocUnsafe(MAX_CAPTURE_BYTES)
  private depth = 0
  private state: TopLevelState = 'before-root'
  private inString = false
  private escaped = false
  private stringRole: StringRole = 'ignored'
  private captureLength = 0
  private captureOverflow = false
  private currentKey?: string
  private foundTargets = 0

  constructor(targets: string[]) {
    this.targets = new Set(targets)
  }

  get complete(): boolean {
    return this.foundTargets === this.targets.size
  }

  reset(): void {
    for (const key of this.targets) this.fields[key] = undefined
    this.hasNonWhitespace = false
    this.maxBufferedBytes = 0
    this.depth = 0
    this.state = 'before-root'
    this.inString = false
    this.escaped = false
    this.stringRole = 'ignored'
    this.captureLength = 0
    this.captureOverflow = false
    this.currentKey = undefined
    this.foundTargets = 0
  }

  feed(chunk: Buffer, start: number, end: number): void {
    if (this.complete) return

    for (let index = start; index < end; index += 1) {
      const byte = chunk[index]

      if (this.inString) {
        if (this.escaped) {
          this.captureByte(byte)
          this.escaped = false
          continue
        }
        if (byte === 0x5c) {
          this.captureByte(byte)
          this.escaped = true
          continue
        }
        if (byte === 0x22) {
          this.finishString()
          if (this.complete) return
          continue
        }
        this.captureByte(byte)
        continue
      }

      if (!isJsonWhitespace(byte)) this.hasNonWhitespace = true

      if (byte === 0x22) {
        this.startString()
        continue
      }

      if (byte === 0x7b || byte === 0x5b) {
        if (this.depth === 0) {
          this.depth = 1
          this.state = byte === 0x7b ? 'key' : 'after-value'
        } else {
          if (this.depth === 1 && this.state === 'value') this.state = 'after-value'
          this.depth += 1
        }
        continue
      }

      if (byte === 0x7d || byte === 0x5d) {
        if (this.depth > 0) this.depth -= 1
        if (this.depth === 1) this.state = 'after-value'
        continue
      }

      if (this.depth !== 1) continue
      if (byte === 0x3a && this.state === 'colon') {
        this.state = 'value'
        continue
      }
      if (byte === 0x2c) {
        this.currentKey = undefined
        this.state = 'key'
        continue
      }
      if (!isJsonWhitespace(byte) && this.state === 'value') {
        this.state = 'after-value'
      }
    }
  }

  private startString(): void {
    this.inString = true
    this.escaped = false
    this.captureLength = 0
    this.captureOverflow = false

    if (this.depth === 1 && this.state === 'key') {
      this.stringRole = 'key'
      return
    }
    if (this.depth === 1 && this.state === 'value') {
      this.stringRole =
        this.currentKey && this.targets.has(this.currentKey) ? 'target-value' : 'top-value'
      return
    }
    this.stringRole = 'ignored'
  }

  private captureByte(byte: number): void {
    if (this.stringRole === 'ignored' || this.stringRole === 'top-value') return
    if (this.captureLength >= this.capture.length) {
      this.captureOverflow = true
      return
    }
    this.capture[this.captureLength] = byte
    this.captureLength += 1
    this.maxBufferedBytes = Math.max(this.maxBufferedBytes, this.captureLength)
  }

  private finishString(): void {
    this.inString = false
    const decoded = this.captureOverflow
      ? undefined
      : decodeJsonString(this.capture, this.captureLength)

    if (this.stringRole === 'key') {
      this.currentKey = decoded
      this.state = 'colon'
    } else if (this.stringRole === 'target-value') {
      if (this.currentKey && decoded !== undefined && this.fields[this.currentKey] === undefined) {
        this.fields[this.currentKey] = sanitizeBucketKey(decoded)
        this.foundTargets += 1
      }
      this.state = 'after-value'
    } else if (this.stringRole === 'top-value') {
      this.state = 'after-value'
    }

    this.stringRole = 'ignored'
    this.captureLength = 0
    this.captureOverflow = false
  }
}

export function parseLogStorageAuditArgs(argv: string[]): LogStorageAuditOptions {
  const options: LogStorageAuditOptions = { ...DEFAULT_LOG_STORAGE_AUDIT_OPTIONS }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    if (arg === '--json') {
      options.format = 'json'
      continue
    }

    const next = argv[index + 1]
    if (arg === '--logs-dir') {
      options.logsDir = requiredArgValue(arg, next)
      index += 1
    } else if (arg === '--source') {
      const value = requiredArgValue(arg, next)
      if (value !== 'both' && value !== 'run' && value !== 'trace') {
        throw new Error('--source must be one of: both, run, trace')
      }
      options.source = value
      index += 1
    } else if (arg === '--session') {
      options.session = requiredArgValue(arg, next)
      index += 1
    } else if (arg === '--percentile' || arg === '--file-percentile') {
      options.percentile = Number(requiredArgValue(arg, next))
      index += 1
    } else if (arg === '--format') {
      const value = requiredArgValue(arg, next)
      if (value !== 'text' && value !== 'json') {
        throw new Error('--format must be one of: text, json')
      }
      options.format = value
      index += 1
    } else if (arg === '--top') {
      options.top = Number(requiredArgValue(arg, next))
      index += 1
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  if (!Number.isFinite(options.percentile) || options.percentile < 0 || options.percentile > 100) {
    throw new Error('--percentile must be a number from 0 to 100')
  }
  if (!Number.isInteger(options.top) || options.top < 1) {
    throw new Error('--top must be a positive integer')
  }

  return options
}

export function renderLogStorageAuditHelp(): string {
  return `Usage: bun run logs:storage-audit -- [options]

Measure physical JSONL bytes by run.log event and trace.jsonl span kind.
Payload contents are never printed.

Options:
  --logs-dir <dir>       Logs root containing sessions/ (default: .zero/logs)
  --source <source>      both, run, or trace (default: both)
  --session <id>         Analyze one exact session directory name
  --percentile <0-100>   Keep files at or above the per-source nearest-rank percentile
                         (default: 0, meaning every non-empty file)
  --top <n>              Maximum rows per text table (default: 30)
  --format <format>      text or json (default: text)
  --json                 Alias for --format json
  -h, --help             Show this help

Examples:
  bun run logs:storage-audit
  bun run logs:storage-audit -- --percentile 90
  bun run logs:storage-audit -- --session sess_20260707_0009_fei_55b4
  bun run logs:storage-audit -- --source run --format json`
}

export function nearestRankPercentileThreshold(
  sizes: number[],
  percentile: number,
): number | undefined {
  if (sizes.length === 0) return undefined
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    throw new Error('percentile must be greater than 0 and at most 100')
  }
  const sorted = [...sizes].sort((left, right) => left - right)
  const rank = Math.ceil((percentile / 100) * sorted.length)
  return sorted[Math.max(0, rank - 1)]
}

export async function analyzeLogStorage(
  options: LogStorageAuditOptions,
): Promise<LogStorageAuditReport> {
  const logsDir = resolve(options.logsDir)
  const sessionsRoot = resolveSessionsRoot(logsDir)
  const candidates = discoverLogFiles(sessionsRoot, options.session)
  const requestedSources: Array<'run' | 'trace'> =
    options.source === 'both' ? ['run', 'trace'] : [options.source]

  if (
    !requestedSources.some((source) => candidates.some((candidate) => candidate.source === source))
  ) {
    const qualifier = options.session ? ` for session ${options.session}` : ''
    throw new Error(`No requested session log files found under ${sessionsRoot}${qualifier}`)
  }

  const runSelection = selectFiles(
    candidates.filter((candidate) => candidate.source === 'run'),
    options.percentile,
  )
  const traceSelection = selectFiles(
    candidates.filter((candidate) => candidate.source === 'trace'),
    options.percentile,
  )
  const selected = requestedSources.flatMap((source) =>
    source === 'run' ? runSelection.files : traceSelection.files,
  )
  const discoveredSelectedBytes = selected.reduce((sum, file) => sum + file.size, 0)
  const runStats = createMutableRunStats()
  const traceStats = createMutableTraceStats()
  let analyzedProgressBytes = 0
  let completedFiles = 0

  for (const file of selected) {
    const stats = file.source === 'run' ? runStats : traceStats
    const result = await scanLogFile(file, stats, (bytes) => {
      analyzedProgressBytes += bytes
      options.onProgress?.({
        analyzedBytes: analyzedProgressBytes,
        discoveredSelectedBytes,
        completedFiles,
        selectedFiles: selected.length,
        currentFile: file.relativePath,
      })
    })
    stats.snapshotBytes += result.snapshotBytes
    stats.discoverySnapshotDriftBytes += result.snapshotBytes - file.size
    completedFiles += 1
    options.onProgress?.({
      analyzedBytes: analyzedProgressBytes,
      discoveredSelectedBytes,
      completedFiles,
      selectedFiles: selected.length,
      currentFile: file.relativePath,
    })
  }

  const includeRun = requestedSources.includes('run')
  const includeTrace = requestedSources.includes('trace')
  const run = includeRun ? finalizeRunReport(runSelection.report, runStats) : undefined
  const trace = includeTrace ? finalizeTraceReport(traceSelection.report, traceStats) : undefined

  return {
    generatedAt: new Date().toISOString(),
    logsDir,
    sessionsRoot,
    session: options.session,
    percentile: options.percentile,
    run,
    trace,
    totalSnapshotBytes: (run?.snapshotBytes ?? 0) + (trace?.snapshotBytes ?? 0),
    totalScannedBytes: (run?.scannedBytes ?? 0) + (trace?.scannedBytes ?? 0),
  }
}

export function renderLogStorageAudit(
  report: LogStorageAuditReport,
  top = DEFAULT_LOG_STORAGE_AUDIT_OPTIONS.top,
): string {
  const lines = [
    '# ZeRo session log storage audit',
    '',
    `Logs root: ${report.logsDir}`,
    `Sessions root: ${report.sessionsRoot}`,
    `Session filter: ${report.session ?? 'all'}`,
    `File percentile: ${report.percentile === 0 ? 'all non-empty files' : `P${formatNumber(report.percentile)}+ per source (nearest-rank, ties included)`}`,
    `Snapshot bytes: ${formatBytes(report.totalSnapshotBytes)}`,
    '',
  ]

  if (report.run) {
    renderSourceSummary(lines, report.run)
    lines.push('## run.log normalized categories', '')
    renderBucketTable(lines, report.run.byCategory, top)
    lines.push('', '## run.log exact events', '')
    renderBucketTable(lines, report.run.byEvent, top)
    if (report.run.traceMirrorByKind.length > 0) {
      lines.push('', '## run.log trace.* mirror by span kind', '')
      renderBucketTable(lines, report.run.traceMirrorByKind, top)
    }
    lines.push(
      '',
      'Note: llm_request.raw_request is the complete event-line size, not the isolated nested request field size.',
      '',
    )
  }

  if (report.trace) {
    renderSourceSummary(lines, report.trace)
    lines.push('## trace.jsonl by span kind', '')
    renderBucketTable(lines, report.trace.byKind, top)
    lines.push('', '## trace.jsonl by span kind/status', '')
    renderBucketTable(lines, report.trace.byKindStatus, top)
    lines.push(
      '',
      'Note: these are physical lifecycle records. running/update/terminal snapshots are not collapsed.',
      '',
    )
  }

  return lines.join('\n').trimEnd()
}

export function renderLogStorageAuditJson(report: LogStorageAuditReport): string {
  return JSON.stringify(report, null, 2)
}

function resolveSessionsRoot(logsDir: string): string {
  const direct = basename(logsDir) === 'sessions' ? logsDir : join(logsDir, 'sessions')
  if (!existsSync(direct)) throw new Error(`Sessions log directory does not exist: ${direct}`)
  return direct
}

function discoverLogFiles(sessionsRoot: string, session?: string): LogFileCandidate[] {
  const candidates: LogFileCandidate[] = []
  const stack = [sessionsRoot]
  const seenInodes: Record<'run' | 'trace', Set<string>> = {
    run: new Set(),
    trace: new Set(),
  }

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
        continue
      }
      if (!entry.isFile() || (entry.name !== 'run.log' && entry.name !== 'trace.jsonl')) continue
      if (session && basename(dirname(path)) !== session) continue

      const source = entry.name === 'run.log' ? 'run' : 'trace'
      const stats = statSync(path)
      const inodeKey = `${stats.dev}:${stats.ino}`
      if (seenInodes[source].has(inodeKey)) continue
      seenInodes[source].add(inodeKey)
      candidates.push({
        path,
        relativePath: relative(sessionsRoot, path),
        source,
        size: stats.size,
      })
    }
  }

  return candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

function selectFiles(candidates: LogFileCandidate[], percentile: number): SelectedFiles {
  const nonEmpty = candidates.filter((candidate) => candidate.size > 0)
  const cutoffBytes =
    percentile > 0
      ? nearestRankPercentileThreshold(
          nonEmpty.map((candidate) => candidate.size),
          percentile,
        )
      : undefined
  const files =
    cutoffBytes === undefined
      ? nonEmpty
      : nonEmpty.filter((candidate) => candidate.size >= cutoffBytes)

  return {
    files,
    report: {
      candidateFiles: candidates.length,
      nonEmptyFiles: nonEmpty.length,
      emptyFiles: candidates.length - nonEmpty.length,
      candidateBytes: candidates.reduce((sum, candidate) => sum + candidate.size, 0),
      percentile,
      cutoffBytes,
      selectedFiles: files.length,
      discoveredSelectedBytes: files.reduce((sum, file) => sum + file.size, 0),
    },
  }
}

async function scanLogFile(
  file: LogFileCandidate,
  stats: MutableRunStats | MutableTraceStats,
  onBytes: (bytes: number) => void,
): Promise<{ snapshotBytes: number }> {
  const handle = await open(file.path, 'r')
  let snapshotBytes = 0
  try {
    snapshotBytes = (await handle.stat()).size
    if (snapshotBytes === 0) return { snapshotBytes }

    const scanner = new TopLevelStringFieldScanner(
      file.source === 'run' ? ['event'] : ['kind', 'status'],
    )
    let lineBytes = 0
    const stream = createReadStream(file.path, {
      fd: handle.fd,
      autoClose: false,
      start: 0,
      end: snapshotBytes - 1,
      highWaterMark: STREAM_CHUNK_BYTES,
    })

    const finishLine = (complete: boolean): void => {
      if (lineBytes === 0) return
      stats.lines += 1
      stats.scannedBytes += lineBytes
      stats.maxClassifierBufferedBytes = Math.max(
        stats.maxClassifierBufferedBytes,
        scanner.maxBufferedBytes,
      )
      if (complete) {
        stats.completeLines += 1
      } else {
        stats.partialTailLines += 1
        stats.partialTailBytes += lineBytes
      }

      if (!scanner.hasNonWhitespace) {
        stats.blankLines += 1
        stats.blankBytes += lineBytes
      }

      if (file.source === 'run') {
        attributeRunLine(stats as MutableRunStats, scanner, lineBytes)
      } else {
        attributeTraceLine(stats as MutableTraceStats, scanner, lineBytes)
      }

      lineBytes = 0
      scanner.reset()
    }

    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      onBytes(chunk.length)
      let cursor = 0
      while (cursor < chunk.length) {
        const newline = chunk.indexOf(0x0a, cursor)
        const segmentEnd = newline >= 0 ? newline + 1 : chunk.length
        lineBytes += segmentEnd - cursor
        const classifierEnd = newline >= 0 ? newline : segmentEnd
        scanner.feed(chunk, cursor, classifierEnd)
        cursor = segmentEnd
        if (newline >= 0) finishLine(true)
      }
    }

    finishLine(false)
    return { snapshotBytes }
  } finally {
    await handle.close()
  }
}

function attributeRunLine(
  stats: MutableRunStats,
  scanner: TopLevelStringFieldScanner,
  bytes: number,
): void {
  const event = scanner.fields.event
  const eventKey = scanner.hasNonWhitespace ? (event ?? MISSING_EVENT_BUCKET) : BLANK_BUCKET
  addBucket(stats.byEvent, eventKey, bytes)

  if (!scanner.hasNonWhitespace) {
    addBucket(stats.byCategory, 'other', bytes)
    return
  }
  if (!event) {
    stats.unclassifiedLines += 1
    stats.unclassifiedBytes += bytes
    addBucket(stats.byCategory, 'other', bytes)
    return
  }

  const category = classifyRunCategory(event)
  addBucket(stats.byCategory, category, bytes)
  if (event.startsWith('trace.')) {
    const mirror = parseTraceMirrorEvent(event)
    addBucket(stats.traceMirrorByKind, mirror?.kind ?? '<unknown-trace-kind>', bytes)
  }
}

function attributeTraceLine(
  stats: MutableTraceStats,
  scanner: TopLevelStringFieldScanner,
  bytes: number,
): void {
  const blank = !scanner.hasNonWhitespace
  const kind = blank ? BLANK_BUCKET : (scanner.fields.kind ?? MISSING_KIND_BUCKET)
  const status = blank ? BLANK_BUCKET : (scanner.fields.status ?? MISSING_STATUS_BUCKET)
  addBucket(stats.byKind, kind, bytes)
  addBucket(stats.byKindStatus, blank ? BLANK_BUCKET : `${kind}/${status}`, bytes)

  if (!blank && (!scanner.fields.kind || !scanner.fields.status)) {
    stats.unclassifiedLines += 1
    stats.unclassifiedBytes += bytes
  }
}

function classifyRunCategory(event: string): string {
  if (event === 'llm_request.raw_request') return 'llm_request.raw_request'
  if (event.startsWith('trace.')) return 'trace.* mirror'
  if (event === 'tool_call.raw_result') return 'tool_call.raw_result'
  if (event.includes('compaction') || event.startsWith('tool_environment_digest.')) {
    return 'compaction diagnostics'
  }
  return 'other'
}

function parseTraceMirrorEvent(event: string): { kind: string; status: string } | undefined {
  const parts = event.split('.')
  if (parts.length < 3 || parts[0] !== 'trace') return undefined
  return {
    kind: parts.slice(1, -1).join('.') || '<unknown-trace-kind>',
    status: parts.at(-1) ?? '<unknown-trace-status>',
  }
}

function createMutableSourceStats(): MutableSourceStats {
  return {
    snapshotBytes: 0,
    scannedBytes: 0,
    lines: 0,
    completeLines: 0,
    partialTailLines: 0,
    partialTailBytes: 0,
    blankLines: 0,
    blankBytes: 0,
    unclassifiedLines: 0,
    unclassifiedBytes: 0,
    discoverySnapshotDriftBytes: 0,
    maxClassifierBufferedBytes: 0,
  }
}

function createMutableRunStats(): MutableRunStats {
  return {
    ...createMutableSourceStats(),
    byCategory: new Map(),
    byEvent: new Map(),
    traceMirrorByKind: new Map(),
  }
}

function createMutableTraceStats(): MutableTraceStats {
  return {
    ...createMutableSourceStats(),
    byKind: new Map(),
    byKindStatus: new Map(),
  }
}

function finalizeRunReport(
  selection: LogFileSelectionReport,
  stats: MutableRunStats,
): RunLogStorageReport {
  return {
    source: 'run.log',
    selection,
    ...sourceStatsFields(stats),
    byCategory: finalizeBuckets(stats.byCategory, stats.scannedBytes),
    byEvent: finalizeBuckets(stats.byEvent, stats.scannedBytes),
    traceMirrorByKind: finalizeBuckets(stats.traceMirrorByKind, stats.scannedBytes),
  }
}

function finalizeTraceReport(
  selection: LogFileSelectionReport,
  stats: MutableTraceStats,
): TraceLogStorageReport {
  return {
    source: 'trace.jsonl',
    selection,
    ...sourceStatsFields(stats),
    byKind: finalizeBuckets(stats.byKind, stats.scannedBytes),
    byKindStatus: finalizeBuckets(stats.byKindStatus, stats.scannedBytes),
  }
}

function sourceStatsFields(stats: MutableSourceStats): Omit<SourceReportBase, 'selection'> {
  return {
    snapshotBytes: stats.snapshotBytes,
    scannedBytes: stats.scannedBytes,
    lines: stats.lines,
    completeLines: stats.completeLines,
    partialTailLines: stats.partialTailLines,
    partialTailBytes: stats.partialTailBytes,
    blankLines: stats.blankLines,
    blankBytes: stats.blankBytes,
    unclassifiedLines: stats.unclassifiedLines,
    unclassifiedBytes: stats.unclassifiedBytes,
    discoverySnapshotDriftBytes: stats.discoverySnapshotDriftBytes,
    maxClassifierBufferedBytes: stats.maxClassifierBufferedBytes,
  }
}

function addBucket(map: Map<string, MutableBucket>, rawKey: string, bytes: number): void {
  let key = sanitizeBucketKey(rawKey)
  if (!map.has(key) && map.size >= MAX_BUCKETS) key = OVERFLOW_BUCKET
  const bucket = map.get(key) ?? { lines: 0, bytes: 0 }
  bucket.lines += 1
  bucket.bytes += bytes
  map.set(key, bucket)
}

function finalizeBuckets(
  buckets: Map<string, MutableBucket>,
  denominatorBytes: number,
): StorageBucketRow[] {
  return Array.from(buckets, ([key, value]) => ({
    key,
    lines: value.lines,
    bytes: value.bytes,
    sharePercent: denominatorBytes > 0 ? (value.bytes / denominatorBytes) * 100 : 0,
  })).sort((left, right) => right.bytes - left.bytes || left.key.localeCompare(right.key))
}

function renderSourceSummary(
  lines: string[],
  report: RunLogStorageReport | TraceLogStorageReport,
): void {
  const selection = report.selection
  lines.push(
    `# ${report.source}`,
    '',
    `Candidates: ${formatInteger(selection.candidateFiles)} files (${formatBytes(selection.candidateBytes)}), ${formatInteger(selection.emptyFiles)} empty`,
    `Selected: ${formatInteger(selection.selectedFiles)} files (${formatBytes(selection.discoveredSelectedBytes)} discovered)`,
  )
  if (selection.cutoffBytes !== undefined) {
    lines.push(
      `Cutoff: ${formatBytes(selection.cutoffBytes)} (P${formatNumber(selection.percentile)} nearest-rank)`,
    )
  }
  lines.push(
    `Read snapshot: ${formatBytes(report.snapshotBytes)} across ${formatInteger(report.lines)} physical lines`,
    `Accounting: ${report.scannedBytes === report.snapshotBytes ? 'OK' : 'MISMATCH'} (${formatInteger(report.scannedBytes)} scanned bytes / ${formatInteger(report.snapshotBytes)} snapshot bytes)`,
    `Diagnostics: ${formatInteger(report.unclassifiedLines)} unclassified lines, ${formatInteger(report.partialTailLines)} unterminated EOF lines, ${formatInteger(report.blankLines)} blank lines`,
    '',
  )
  if (report.discoverySnapshotDriftBytes !== 0) {
    lines.push(
      `Discovery drift: ${formatInteger(report.discoverySnapshotDriftBytes)} bytes changed before files were opened`,
      '',
    )
  }
}

function renderBucketTable(lines: string[], rows: StorageBucketRow[], top: number): void {
  lines.push('| Category | Bytes | Share | Lines |', '| --- | ---: | ---: | ---: |')
  for (const row of rows.slice(0, top)) {
    lines.push(
      `| ${escapeTableCell(row.key)} | ${formatBytes(row.bytes)} | ${row.sharePercent.toFixed(2)}% | ${formatInteger(row.lines)} |`,
    )
  }
  if (rows.length === 0) lines.push('| (none) | 0 B | 0.00% | 0 |')
  if (rows.length > top) {
    lines.push(`| … ${formatInteger(rows.length - top)} more categories | | | |`)
  }
}

function decodeJsonString(buffer: Buffer, length: number): string | undefined {
  try {
    return JSON.parse(`"${buffer.subarray(0, length).toString('utf8')}"`) as string
  } catch {
    return undefined
  }
}

function sanitizeBucketKey(value: string): string {
  let safe = ''
  for (const character of value) {
    const code = character.charCodeAt(0)
    safe += code <= 0x1f || code === 0x7f ? '?' : character
  }
  const sanitized = safe.trim()
  if (!sanitized) return '<empty>'
  return sanitized.length <= 160 ? sanitized : `${sanitized.slice(0, 159)}…`
}

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

function requiredArgValue(option: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${formatInteger(bytes)} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unitIndex = -1
  do {
    value /= 1024
    unitIndex += 1
  } while (value >= 1024 && unitIndex < units.length - 1)
  return `${value.toFixed(value >= 100 ? 1 : 2)} ${units[unitIndex]}`
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|')
}
