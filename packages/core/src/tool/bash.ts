import type {
  FuseRule,
  RunningToolHandle,
  RunningToolTerminationCause,
  ToolContext,
  ToolResult,
} from '@zero-os/shared'
import { now } from '@zero-os/shared'
import { Effect, Fiber } from 'effect'
import { FuseListChecker } from '../config/fuse-list'
import { BaseTool } from './base'
import { buildToolProcessEnv } from './process-env'

const PIPE_GRACE_MS = 1000
const FORCE_KILL_GRACE_MS = 750
const DEFAULT_ABORT_MESSAGE = 'Command aborted by user from Session Detail.'
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
// Unbounded subprocess output has taken the whole runtime down before (a broad
// `rg` over multi-GB logs produced an OOM while the result was serialized into
// the session). Keep the head plus a rolling tail and drop the middle.
const MAX_CAPTURE_CHARS = 100_000
const TAIL_CAPTURE_CHARS = 10_000

interface BashInput {
  command: string
  description?: string
  timeout?: number
  envSecrets?: Record<string, string>
  stdinSecretRef?: string
  stdinAppendNewline?: boolean
}

interface ResolvedBashSecret {
  ref: string
  value: string
  envName?: string
}

type BashSecretResolution =
  | { success: true; env: Record<string, string>; stdin?: string; secrets: ResolvedBashSecret[] }
  | { success: false; result: ToolResult }

function formatExitCode(exitCode: number): string {
  return `Exit code: ${exitCode}`
}

function commandLabel(command: string, usesSecretRefs: boolean): string {
  return usesSecretRefs ? 'command with secret references' : command.slice(0, 80)
}

function resolveBashSecretInputs(ctx: ToolContext, input: BashInput): BashSecretResolution {
  if (!hasSecretInput(input)) {
    return { success: true, env: {}, secrets: [] }
  }

  if (!ctx.secretResolver) {
    return {
      success: false,
      result: {
        success: false,
        output: 'Secret references require a secretResolver in the tool context',
        outputSummary: 'No secret resolver',
      },
    }
  }

  if (!ctx.secretFilter) {
    return {
      success: false,
      result: {
        success: false,
        output: 'Secret references require a secretFilter in the tool context',
        outputSummary: 'No secret filter',
      },
    }
  }

  const env: Record<string, string> = {}
  const secrets: ResolvedBashSecret[] = []

  for (const [envName, ref] of Object.entries(input.envSecrets ?? {})) {
    if (!ENV_NAME_PATTERN.test(envName)) {
      return {
        success: false,
        result: {
          success: false,
          output: `Invalid environment variable name for envSecrets: ${envName}`,
          outputSummary: 'Invalid secret env name',
        },
      }
    }
    if (typeof ref !== 'string') {
      return {
        success: false,
        result: {
          success: false,
          output: `Secret reference for ${envName} must be a string`,
          outputSummary: 'Invalid secret reference',
        },
      }
    }

    const resolved = resolveBashSecret(ctx, ref)
    if (!resolved.success) return resolved

    env[envName] = resolved.value
    secrets.push({ ref: ref.trim(), value: resolved.value, envName })
  }

  let stdin: string | undefined
  if (input.stdinSecretRef) {
    const resolved = resolveBashSecret(ctx, input.stdinSecretRef)
    if (!resolved.success) return resolved

    stdin = input.stdinAppendNewline === false ? resolved.value : `${resolved.value}\n`
    secrets.push({ ref: input.stdinSecretRef.trim(), value: resolved.value })
  }

  return { success: true, env, stdin, secrets }
}

function hasSecretInput(input: BashInput): boolean {
  return (
    (input.envSecrets && Object.keys(input.envSecrets).length > 0) || Boolean(input.stdinSecretRef)
  )
}

function resolveBashSecret(
  ctx: ToolContext,
  ref: string,
): { success: true; value: string } | { success: false; result: ToolResult } {
  const trimmedRef = ref.trim()
  if (!trimmedRef) {
    return {
      success: false,
      result: {
        success: false,
        output: 'Secret reference cannot be empty',
        outputSummary: 'Empty secret reference',
      },
    }
  }

  const value = ctx.secretResolver?.(trimmedRef)
  if (!value) {
    return {
      success: false,
      result: {
        success: false,
        output: `Secret reference "${trimmedRef}" not found in vault`,
        outputSummary: 'Secret reference not found',
      },
    }
  }

  ctx.secretFilter?.addSecret(trimmedRef, value)
  return { success: true, value }
}

function buildBashOutput(stdout: string, stderr: string, abortMessage?: string): string {
  const trimmedStdout = stdout.trimEnd()
  const trimmedStderr = stderr.trimEnd()

  let output = trimmedStdout
  if (trimmedStderr) {
    output = output ? `${output}\n[stderr]\n${trimmedStderr}` : `[stderr]\n${trimmedStderr}`
  }
  if (!output) {
    output = '(no output)'
  }

  if (abortMessage) {
    output = `${output}\n\n[abort]\n${abortMessage}`
  }

  return output
}

function createStreamCapture(stream?: ReadableStream<Uint8Array> | number | null) {
  if (!stream || typeof stream === 'number') {
    return {
      done: Promise.resolve(),
      cancel: async () => {},
      getText: () => '',
    }
  }

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const headChunks: string[] = []
  let headChars = 0
  let tail = ''
  let totalChars = 0
  let flushed = false

  const capture = (text: string) => {
    if (!text) return
    totalChars += text.length
    let overflow = text
    if (headChars < MAX_CAPTURE_CHARS) {
      const piece = text.slice(0, MAX_CAPTURE_CHARS - headChars)
      headChunks.push(piece)
      headChars += piece.length
      overflow = text.slice(piece.length)
    }
    if (overflow) {
      tail = (tail + overflow).slice(-TAIL_CAPTURE_CHARS)
    }
  }

  const flushDecoder = () => {
    if (flushed) return
    const remainder = decoder.decode()
    if (remainder) capture(remainder)
    flushed = true
  }

  const done = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) {
          capture(decoder.decode(value, { stream: true }))
        }
      }
    } catch {
      // Best effort: cancellation and subprocess teardown can end the stream abruptly.
    } finally {
      flushDecoder()
    }
  })()

  return {
    done,
    cancel: async () => {
      try {
        await reader.cancel()
      } catch {
        // Ignore cancellation races.
      } finally {
        flushDecoder()
      }
    },
    getText: () => {
      flushDecoder()
      const head = headChunks.join('')
      const omittedChars = totalChars - head.length - tail.length
      if (omittedChars <= 0) {
        return tail ? head + tail : head
      }
      return `${head}\n\n[... output truncated: ${omittedChars} characters omitted, showing the first ${head.length} and last ${tail.length} ...]\n\n${tail}`
    },
  }
}

function tryKillProcess(proc: ReturnType<typeof Bun.spawn>, signal?: NodeJS.Signals) {
  try {
    signal ? proc.kill(signal) : proc.kill()
  } catch {
    // Ignore cases where the process already exited.
  }
}

function isWebWritableStream(stream: unknown): stream is WritableStream<Uint8Array> {
  return (
    typeof stream === 'object' &&
    stream !== null &&
    'getWriter' in stream &&
    typeof stream.getWriter === 'function'
  )
}

function isFileSinkLike(
  stream: unknown,
): stream is { write(data: string): unknown; flush?: () => unknown; end(): unknown } {
  return (
    typeof stream === 'object' &&
    stream !== null &&
    'write' in stream &&
    typeof stream.write === 'function' &&
    'end' in stream &&
    typeof stream.end === 'function'
  )
}

async function writeProcessStdin(proc: ReturnType<typeof Bun.spawn>, text: string): Promise<void> {
  const stdin: unknown = proc.stdin
  if (!stdin || typeof stdin === 'number') {
    throw new Error('Subprocess stdin is unavailable')
  }

  if (isWebWritableStream(stdin)) {
    const writer = stdin.getWriter()
    try {
      await writer.write(new TextEncoder().encode(text))
    } finally {
      await writer.close()
    }
    return
  }

  if (isFileSinkLike(stdin)) {
    stdin.write(text)
    if (stdin.flush) await Promise.resolve(stdin.flush())
    stdin.end()
    return
  }

  throw new Error('Subprocess stdin does not support writing')
}

export class BashTool extends BaseTool {
  kind = 'built-in' as const
  name = 'bash'
  description =
    'Execute a shell command and return output. Very large output is truncated to the first 100,000 and last 10,000 characters; narrow results with rg/head/tail when you expect large output.'
  parameters = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      description: { type: 'string', description: 'Brief description of what this command does' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000)' },
      envSecrets: {
        type: 'object',
        description:
          'Map environment variable names to secret vault references. Values are resolved at runtime and are never placed in the command string.',
        additionalProperties: { type: 'string' },
      },
      stdinSecretRef: {
        type: 'string',
        description:
          'Secret vault reference to write once to subprocess stdin. The secret value is never logged.',
      },
      stdinAppendNewline: {
        type: 'boolean',
        description: 'Append a newline after stdinSecretRef when writing to stdin (default true).',
      },
    },
    required: ['command'],
  }

  private fuseChecker: FuseListChecker

  constructor(fuseRules: FuseRule[]) {
    super()
    this.fuseChecker = new FuseListChecker(fuseRules)
  }

  protected async fuseCheck(input: unknown): Promise<void> {
    const { command } = input as BashInput
    this.fuseChecker.check(command)
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const bashInput = input as BashInput
    const { command, timeout = 120_000 } = bashInput
    const resolvedSecrets = resolveBashSecretInputs(ctx, bashInput)
    if (!resolvedSecrets.success) return resolvedSecrets.result

    const usesSecretRefs = resolvedSecrets.secrets.length > 0
    const summaryCommand = commandLabel(command, usesSecretRefs)
    const leakedSecret = resolvedSecrets.secrets.find(
      (secret) => secret.value.length >= 4 && command.includes(secret.value),
    )
    if (leakedSecret) {
      return {
        success: false,
        output:
          'Command contains a resolved secret value. Use envSecrets variables or stdinSecretRef instead.',
        outputSummary: 'Command rejected: secret value in command',
      }
    }

    const runningHandle =
      ctx.currentToolUseId && ctx.runningToolRegistry
        ? ctx.runningToolRegistry.get(ctx.currentToolUseId)
        : undefined

    return await Effect.runPromise(
      this.runCommand({
        ctx,
        command,
        timeout,
        env: resolvedSecrets.env,
        stdin: resolvedSecrets.stdin,
        summaryCommand,
        runningHandle,
      }),
    )
  }

  /**
   * Native Effect execution path. The subprocess is owned by acquireRelease
   * (any exit path leaves no live process behind), and the timeout / abort
   * kill sequences run as racing fibers: the losing fiber's pending sleeps
   * are cleared by interruption, which is what the old manual clearTimeout
   * bookkeeping did.
   */
  private runCommand(options: {
    ctx: ToolContext
    command: string
    timeout: number
    env: Record<string, string>
    stdin?: string
    summaryCommand: string
    runningHandle?: RunningToolHandle
  }): Effect.Effect<ToolResult> {
    const { ctx, command, timeout, env, stdin, summaryCommand, runningHandle } = options

    let terminationCause: RunningToolTerminationCause | undefined
    let abortMessage: string | undefined
    let abortKillFiber: Fiber.RuntimeFiber<void> | undefined

    const latchTerminationCause = (cause: RunningToolTerminationCause) => {
      if (terminationCause) return false
      terminationCause = cause
      return true
    }

    const markFinished = (
      cause: RunningToolTerminationCause,
      success: boolean,
      outputSummary?: string,
    ) => {
      runningHandle?.markFinished({ finishedAt: now(), cause, success, outputSummary })
    }

    return Effect.gen(function* () {
      const proc = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            Bun.spawn(['bash', '-c', command], {
              cwd: ctx.workDir,
              stdin: stdin === undefined ? 'ignore' : 'pipe',
              stdout: 'pipe',
              stderr: 'pipe',
              env: { ...buildToolProcessEnv(ctx), ...env },
            }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
        // Last-resort cleanup on any exit path; tryKillProcess no-ops once the
        // process has exited, so normal completion is unaffected.
        (proc) => Effect.sync(() => tryKillProcess(proc, 'SIGKILL')),
      )

      const stdoutCapture = createStreamCapture(proc.stdout)
      const stderrCapture = createStreamCapture(proc.stderr)
      let stdinWriteError: string | undefined
      const stdinWrite =
        stdin === undefined
          ? undefined
          : writeProcessStdin(proc, stdin).catch((error) => {
              stdinWriteError = error instanceof Error ? error.message : String(error)
              tryKillProcess(proc, 'SIGTERM')
            })

      runningHandle?.setAbortHandler((reason) => {
        abortMessage = reason?.trim() || DEFAULT_ABORT_MESSAGE
        if (!latchTerminationCause('abort')) return
        abortKillFiber = Effect.runFork(
          Effect.gen(function* () {
            tryKillProcess(proc, 'SIGTERM')
            yield* Effect.sleep(FORCE_KILL_GRACE_MS)
            tryKillProcess(proc, 'SIGKILL')
          }),
        )
      })

      const exitCode = yield* Effect.raceFirst(
        Effect.promise(() => proc.exited),
        Effect.gen(function* () {
          yield* Effect.sleep(timeout)
          if (!latchTerminationCause('timeout')) return yield* Effect.never
          markFinished('timeout', false, `Command timed out: ${summaryCommand}`)
          tryKillProcess(proc, 'SIGTERM')
          yield* Effect.sleep(FORCE_KILL_GRACE_MS)
          tryKillProcess(proc, 'SIGKILL')
          // The SIGKILL makes proc.exited resolve; that side wins the race.
          return yield* Effect.never
        }),
      )
      if (abortKillFiber) yield* Fiber.interrupt(abortKillFiber)

      if (stdinWrite) yield* Effect.promise(() => stdinWrite)

      const finalCause = terminationCause ?? 'completed'
      if (finalCause === 'abort') {
        markFinished('abort', false, `Command aborted: ${summaryCommand}`)
      } else if (finalCause === 'completed') {
        markFinished('completed', exitCode === 0, undefined)
      }

      const streamDrain = Promise.allSettled([stdoutCapture.done, stderrCapture.done])
      const drainResult = yield* Effect.raceFirst(
        Effect.promise(async () => {
          await streamDrain
          return 'drained' as const
        }),
        Effect.sleep(PIPE_GRACE_MS).pipe(Effect.as('timeout' as const)),
      )
      if (drainResult === 'timeout') {
        yield* Effect.promise(() =>
          Promise.allSettled([stdoutCapture.cancel(), stderrCapture.cancel()]),
        )
      }

      const output = buildBashOutput(
        stdoutCapture.getText(),
        stderrCapture.getText(),
        finalCause === 'abort' ? (abortMessage ?? DEFAULT_ABORT_MESSAGE) : undefined,
      )

      if (finalCause === 'abort') {
        return {
          success: false,
          output,
          outputSummary: `Command aborted: ${summaryCommand}`,
        }
      }

      if (stdinWriteError) {
        return {
          success: false,
          output: `Failed to write stdin secret: ${stdinWriteError}\n\n${output}`,
          outputSummary: 'Failed to write stdin secret',
        }
      }

      if (exitCode !== 0 || finalCause === 'timeout') {
        return {
          success: false,
          output: output || formatExitCode(exitCode),
          outputSummary: `Command failed (exit ${exitCode}): ${summaryCommand}`,
        }
      }

      return {
        success: true,
        output,
        outputSummary: `Executed: ${summaryCommand}`,
      }
    }).pipe(
      // Only the spawn can fail with a typed error; everything downstream is
      // success-shaped (parity with the old spawn try/catch).
      Effect.catchAll((error) =>
        Effect.sync(() => {
          const message = error.message
          runningHandle?.markFinished({
            finishedAt: now(),
            cause: 'spawn_error',
            success: false,
            outputSummary: `Spawn failed: ${message.slice(0, 80)}`,
          })
          return {
            success: false,
            output: message,
            outputSummary: `Spawn failed: ${message.slice(0, 80)}`,
          }
        }),
      ),
      // Provides the Scope acquireRelease runs its release in; closes (kills
      // any leftover process) on completion of the workflow.
      Effect.scoped,
    )
  }
}
