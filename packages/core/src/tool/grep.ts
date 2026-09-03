import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { ToolContext, ToolResult } from '@zero-os/shared'
import { Effect, Fiber } from 'effect'
import { BaseTool } from './base'

const DEFAULT_MAX_RESULTS = 50
const MAX_RESULTS_LIMIT = 200
const MAX_LINE_COLUMNS = 240
const GREP_TIMEOUT_MS = 30_000
const STDERR_CAPTURE_CHARS = 4_000

type GrepMode = 'content' | 'files' | 'count'

interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  ignoreCase?: boolean
  includeIgnored?: boolean
  mode?: GrepMode
  maxResults?: number
}

export class GrepTool extends BaseTool {
  kind = 'built-in' as const
  name = 'grep'
  description =
    'Search file contents with a ripgrep regex. Results are bounded (default 50, max 200) and long lines are clipped, so it is always safe on huge files — prefer this over running grep/rg through bash. Respects .gitignore unless includeIgnored is set (needed for ignored paths such as .zero).'
  parameters = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for (ripgrep syntax)' },
      path: {
        type: 'string',
        description: 'File or directory to search. Defaults to the session workspace.',
      },
      glob: {
        type: 'string',
        description: 'Filter files with a glob pattern, e.g. "*.ts" or "**/*.jsonl"',
      },
      ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default false)' },
      includeIgnored: {
        type: 'boolean',
        description: 'Also search gitignored and hidden files (default false)',
      },
      mode: {
        type: 'string',
        enum: ['content', 'files', 'count'],
        description:
          '"content" shows matching lines (default), "files" lists files with matches, "count" shows per-file match counts',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum result lines to return (default 50, max 200)',
      },
    },
    required: ['pattern'],
  }

  private readonly grepTimeoutMs: number

  constructor(grepTimeoutMs: number = GREP_TIMEOUT_MS) {
    super()
    this.grepTimeoutMs = grepTimeoutMs
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const grepInput = input as GrepInput
    const pattern = grepInput.pattern
    if (typeof pattern !== 'string' || !pattern.trim()) {
      return { success: false, output: 'Pattern cannot be empty', outputSummary: 'Empty pattern' }
    }

    const mode: GrepMode = grepInput.mode ?? 'content'
    if (!['content', 'files', 'count'].includes(mode)) {
      return {
        success: false,
        output: `Invalid mode "${grepInput.mode}". Use "content", "files" or "count".`,
        outputSummary: 'Invalid mode',
      }
    }

    const maxResults = clampMaxResults(grepInput.maxResults)
    const searchPath = grepInput.path
      ? isAbsolute(grepInput.path)
        ? grepInput.path
        : resolve(ctx.workDir, grepInput.path)
      : ctx.workDir
    if (!existsSync(searchPath)) {
      return {
        success: false,
        output: `Search path not found: ${searchPath}`,
        outputSummary: 'Search path not found',
      }
    }

    const rgPath = Bun.which('rg')
    if (!rgPath) {
      return {
        success: false,
        output: 'ripgrep (rg) is not installed or not on PATH',
        outputSummary: 'ripgrep not available',
      }
    }

    const args = ['--color', 'never', '--regexp', pattern]
    if (grepInput.ignoreCase) args.push('-i')
    if (grepInput.includeIgnored) args.push('--no-ignore', '--hidden')
    if (grepInput.glob) args.push('--glob', grepInput.glob)
    switch (mode) {
      case 'content':
        args.push(
          '--line-number',
          '--no-heading',
          '--with-filename',
          '--max-columns',
          String(MAX_LINE_COLUMNS),
          '--max-columns-preview',
        )
        break
      case 'files':
        args.push('--files-with-matches')
        break
      case 'count':
        args.push('--count', '--with-filename')
        break
    }
    args.push(searchPath)

    return await Effect.runPromise(
      this.searchEffect({ rgPath, args, ctx, maxResults, mode, timeoutMs: this.grepTimeoutMs }),
    )
  }

  /**
   * Native Effect execution path. rg is owned by acquireRelease (no exit path
   * leaves it alive) and the timeout is a delayed-kill fiber, not a race: rg
   * is SIGTERMed on timeout and the reads below finish with whatever arrived
   * before the kill, which is what preserves partial-results semantics.
   */
  private searchEffect(options: {
    rgPath: string
    args: string[]
    ctx: ToolContext
    maxResults: number
    mode: GrepMode
    timeoutMs: number
  }): Effect.Effect<ToolResult> {
    const { rgPath, args, ctx, maxResults, mode, timeoutMs } = options

    return Effect.gen(function* () {
      const proc = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn([rgPath, ...args], {
            cwd: ctx.workDir,
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
          }),
        ),
        // Last-resort cleanup; no-op once rg has exited on its own.
        (proc) =>
          Effect.sync(() => {
            try {
              proc.kill('SIGKILL')
            } catch {}
          }),
      )

      let timedOut = false
      const timeoutFiber = yield* Effect.fork(
        Effect.gen(function* () {
          yield* Effect.sleep(timeoutMs)
          timedOut = true
          try {
            proc.kill('SIGTERM')
          } catch {}
        }),
      )

      const stderrPromise = drainStreamCapped(proc.stderr, STDERR_CAPTURE_CHARS)
      const { lines, cappedByLimit } = yield* Effect.promise(() =>
        readLinesWithCap(proc.stdout, maxResults),
      )
      if (cappedByLimit) {
        try {
          proc.kill('SIGTERM')
        } catch {}
      }
      const exitCode = yield* Effect.promise(() => proc.exited)
      yield* Fiber.interrupt(timeoutFiber)
      const stderrText = (yield* Effect.promise(() => stderrPromise)).trim()

      if (timedOut) {
        const partial = lines.length > 0 ? `${lines.join('\n')}\n\n` : ''
        return {
          success: false,
          output: `${partial}[search timed out after ${timeoutMs / 1000}s; results may be incomplete — narrow the path, glob or pattern]`,
          outputSummary: `Search timed out (${lines.length} partial results)`,
        }
      }

      // rg exit codes: 0 = matches found, 1 = no matches, 2+ = error.
      if (exitCode >= 2 && !cappedByLimit) {
        return {
          success: false,
          output: stderrText || `ripgrep failed with exit code ${exitCode}`,
          outputSummary: `Search failed (exit ${exitCode})`,
        }
      }

      if (lines.length === 0) {
        return { success: true, output: 'No matches found.', outputSummary: 'No matches' }
      }

      let output = lines.join('\n')
      if (cappedByLimit) {
        output += `\n\n[... results capped at ${maxResults} lines; refine the pattern/glob/path or raise maxResults ...]`
      }

      return {
        success: true,
        output,
        outputSummary: buildGrepSummary(mode, lines, cappedByLimit),
      }
    }).pipe(
      // Provides the Scope acquireRelease runs its release in; closes (kills
      // any leftover rg) on completion of the workflow.
      Effect.scoped,
    )
  }
}

function clampMaxResults(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_RESULTS
  return Math.max(1, Math.min(MAX_RESULTS_LIMIT, Math.floor(value)))
}

function buildGrepSummary(mode: GrepMode, lines: string[], capped: boolean): string {
  const suffix = capped ? ' (capped)' : ''
  if (mode === 'files') return `Found ${lines.length} files with matches${suffix}`
  if (mode === 'count') {
    const total = lines.reduce((sum, line) => {
      const parsed = Number(line.slice(line.lastIndexOf(':') + 1))
      return Number.isFinite(parsed) ? sum + parsed : sum
    }, 0)
    return `Found ${total} matches across ${lines.length} files${suffix}`
  }
  return `Found ${lines.length} matching lines${suffix}`
}

async function readLinesWithCap(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  cap: number,
): Promise<{ lines: string[]; cappedByLimit: boolean }> {
  if (!stream || typeof stream === 'number') return { lines: [], cappedByLimit: false }

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const lines: string[] = []
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        if (line) {
          lines.push(line)
          if (lines.length >= cap) {
            return { lines, cappedByLimit: true }
          }
        }
        newlineIndex = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer) lines.push(buffer)
  } catch {
    // Best effort: the subprocess may be killed while we read.
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }

  return { lines, cappedByLimit: false }
}

async function drainStreamCapped(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  cap: number,
): Promise<string> {
  if (!stream || typeof stream === 'number') return ''

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    // Keep reading past the cap so a chatty stream cannot block the process
    // on a full pipe; just stop accumulating.
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value && text.length < cap) {
        text = (text + decoder.decode(value, { stream: true })).slice(0, cap)
      }
    }
  } catch {
    // Ignore teardown races.
  }
  return text
}
