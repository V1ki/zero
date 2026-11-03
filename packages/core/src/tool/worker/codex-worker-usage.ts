import type { TokenUsage, ToolContext } from '@zero-os/shared'
import { toErrorMessage } from '@zero-os/shared'
import { readCodexTurnUsage } from './codex-worker-rollout-usage'

type Counts = Required<TokenUsage>
type UsageStatus = 'reported' | 'partial' | 'unreported'

export interface CodexWorkerUsageRecord {
  sessionId: string
  toolUseId?: string
  threadId: string
  turnId: string
  model: string
  provider: string
  usage: Counts
  usageStatus: UsageStatus
  durationMs: number
  createdAt: string
}

const empty: Counts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }

function field(value: unknown, key: string): unknown {
  if (typeof value === 'object' && value !== null && key in value) {
    return (value as Record<string, unknown>)[key]
  }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

// Codex includes cache reads and writes in input, and reasoning in output.
function normalize(value: unknown): Counts | undefined {
  const input = field(value, 'inputTokens')
  const output = field(value, 'outputTokens')
  const cacheRead = field(value, 'cachedInputTokens') ?? 0
  const cacheWrite = field(value, 'cacheWriteInputTokens') ?? 0
  const reasoning = field(value, 'reasoningOutputTokens') ?? 0
  if (
    !isCount(input) ||
    !isCount(output) ||
    !isCount(cacheRead) ||
    !isCount(cacheWrite) ||
    !isCount(reasoning) ||
    cacheRead + cacheWrite > input ||
    reasoning > output
  )
    return
  return { input: input - cacheRead - cacheWrite, output, cacheRead, cacheWrite, reasoning }
}

function difference(total: Counts, baseline: Counts): Counts | undefined {
  const delta = {
    input: total.input - baseline.input,
    output: total.output - baseline.output,
    cacheRead: total.cacheRead - baseline.cacheRead,
    cacheWrite: total.cacheWrite - baseline.cacheWrite,
    reasoning: total.reasoning - baseline.reasoning,
  }
  if (Object.values(delta).every(isCount) && delta.reasoning <= delta.output) return delta
}

export class CodexTurnUsage {
  private baseline?: Counts
  private knownBaseline: boolean
  private latest?: Counts
  private counts?: Counts
  private status: UsageStatus = 'unreported'
  private turnId?: string
  private finishing = Promise.resolve()
  private writeFailed = false
  private readonly sessionId: string
  private readonly toolUseId?: string
  private readonly logger: ToolContext['logger']

  constructor(
    ctx: ToolContext,
    private readonly thread: {
      id: string
      model?: string
      provider?: string
      path?: string
      resumed: boolean
    },
    private readonly startedAt: number,
    private readonly record?: (entry: CodexWorkerUsageRecord) => void,
  ) {
    this.sessionId = ctx.sessionId
    this.toolUseId = ctx.currentToolUseId
    this.logger = ctx.logger
    this.knownBaseline = !thread.resumed
    if (!thread.resumed) this.baseline = empty
  }

  setBaseline(tokenUsage: unknown): void {
    const total = normalize(field(tokenUsage, 'total'))
    if (!this.turnId && total) {
      this.baseline = total
      this.knownBaseline = true
    }
  }

  start(turnId: string): void {
    if (this.turnId) return
    this.turnId = turnId
    this.persist()
  }

  update(tokenUsage: unknown): void {
    const total = normalize(field(tokenUsage, 'total'))
    if (!this.turnId || !total) return
    // A resume may repeat historical totals with the *current* turn ID. Its first
    // snapshot is only a reference point until a trusted prior-turn total is found.
    this.baseline ??= total
    const increase = difference(total, this.latest ?? this.baseline)
    if (!increase) return
    this.latest = total
    if (!Object.values(increase).some(Boolean)) return
    this.counts = difference(total, this.baseline)
    this.status = this.knownBaseline ? 'reported' : 'partial'
    this.persist()
  }

  finish(): Promise<void> {
    const turnId = this.turnId
    if (!turnId) return this.finishing
    // An unknown outcome can later become terminal. Serialize those two reads so an
    // older rollout snapshot cannot overwrite the final turn usage.
    this.finishing = this.finishing.then(async () => {
      if (this.thread.path && (this.thread.resumed || this.status !== 'reported')) {
        try {
          const exact = normalize(
            await readCodexTurnUsage(this.thread.path, this.thread.id, turnId),
          )
          if (exact) {
            this.counts = exact
            this.status = 'reported'
          }
        } catch (error) {
          this.logger.warn('worker_turn_usage_read_failed', {
            threadId: this.thread.id,
            turnId,
            error: toErrorMessage(error),
          })
        }
      }
      this.persist()
    })
    return this.finishing
  }

  private persist(): void {
    if (!this.record || !this.turnId) return
    try {
      this.record({
        threadId: this.thread.id,
        turnId: this.turnId,
        model: this.thread.model ?? 'unknown',
        provider: this.thread.provider ?? 'unknown',
        sessionId: this.sessionId,
        toolUseId: this.toolUseId,
        usage: this.counts ?? empty,
        usageStatus: this.status,
        durationMs: Math.max(0, Date.now() - this.startedAt),
        createdAt: new Date(this.startedAt).toISOString(),
      })
      this.writeFailed = false
    } catch (error) {
      this.writeFailed = true
      this.logger.warn('worker_usage_record_failed', {
        threadId: this.thread.id,
        turnId: this.turnId,
        error: toErrorMessage(error),
      })
    }
  }

  summary(): string | undefined {
    if (!this.turnId) return
    const counts = this.counts
    const text = counts
      ? `Input: ${counts.input + counts.cacheRead + counts.cacheWrite} (cached: ${counts.cacheRead}, cache write: ${counts.cacheWrite}), Output: ${counts.output} (reasoning: ${counts.reasoning})`
      : 'No verifiable token usage reported for this turn.'
    return (
      text +
      (this.status === 'partial' ? ' (partial)' : '') +
      (this.writeFailed ? '\nSession usage could not be saved.' : '')
    )
  }
}
