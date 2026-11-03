import { resolve } from 'node:path'
import type { ToolContext, ToolResult } from '@zero-os/shared'
import { now, toErrorMessage } from '@zero-os/shared'
import { BACKGROUND_TOOL_PROGRESS_TAIL_CHARS } from '../../session/background-tool-tasks'
import { buildToolContextEnv } from '../process-env'
import { CodexAppServerRequestError } from './app-server-client'
import type { CodexWorkerConnection, CodexWorkerServer } from './codex-worker-server'

interface CodexWorkerInput {
  instruction: string
  workingDirectory?: string
  additionalDirectories?: string[]
  model?: string
  resumeThreadId?: string
}

type Fields = Record<string, unknown>
const INTERRUPT_TIMEOUT_MS = 5_000

function fields(value: unknown, name: string): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Codex app-server ${name}`)
  }
  return value as Fields
}

function stringField(object: Fields, key: string): string {
  if (typeof object[key] !== 'string') throw new Error(`Invalid Codex app-server ${key}`)
  return object[key]
}

function idField(object: Fields): string {
  const id = stringField(object, 'id')
  if (!id) throw new Error('Missing Codex app-server id')
  return id
}

function extendedSandbox(sandbox: unknown, cwd: string, directories: string[]): Fields {
  const policy = fields(sandbox, 'sandbox policy')
  if (
    policy.type !== 'workspaceWrite' ||
    !Array.isArray(policy.writableRoots) ||
    !policy.writableRoots.every((path) => typeof path === 'string') ||
    typeof policy.networkAccess !== 'boolean' ||
    typeof policy.excludeSlashTmp !== 'boolean' ||
    typeof policy.excludeTmpdirEnvVar !== 'boolean'
  ) {
    throw new Error('Cannot extend the Codex workspace sandbox returned by app-server')
  }
  const roots = [...policy.writableRoots, ...directories.map((path) => resolve(cwd, path))]
  return { ...policy, writableRoots: [...new Set(roots)] }
}

class TurnOutput {
  response = ''
  readonly files: Array<{ path: string; kind: string; destination?: string }> = []
  readonly commands: string[] = []
  readonly errors = new Set<string>()
  usage?: string
  private readonly completedItems = new Set<string>()
  private readonly commandStreams = new Map<string, { preview: string; length: number }>()
  private progressChars = 0
  private progressTail = ''

  constructor(private readonly ctx: ToolContext) {}

  private progress(delta: string): void {
    if (!delta || !this.ctx.currentToolUseId) return
    this.progressChars += delta.length
    this.progressTail = (this.progressTail + delta).slice(-BACKGROUND_TOOL_PROGRESS_TAIL_CHARS)
    this.ctx.backgroundToolTasks?.reportProgress?.({
      toolUseId: this.ctx.currentToolUseId,
      totalOutputChars: this.progressChars,
      outputTail: this.progressTail,
    })
  }

  notification(method: string, params: Fields): void {
    switch (method) {
      case 'item/commandExecution/outputDelta': {
        const id = stringField(params, 'itemId')
        const delta = stringField(params, 'delta')
        const stream = this.commandStreams.get(id) ?? { preview: '', length: 0 }
        stream.preview = (stream.preview + delta).slice(0, 500)
        stream.length += delta.length
        this.commandStreams.set(id, stream)
        this.progress(delta)
        break
      }
      case 'item/agentMessage/delta':
        this.progress(stringField(params, 'delta'))
        break
      case 'item/completed':
        this.item(fields(params.item, 'completed item'))
        break
      case 'thread/tokenUsage/updated': {
        const usage = fields(fields(params.tokenUsage, 'usage').total, 'total usage')
        if (
          typeof usage.inputTokens !== 'number' ||
          typeof usage.cachedInputTokens !== 'number' ||
          typeof usage.outputTokens !== 'number'
        ) {
          throw new Error('Invalid Codex app-server token usage')
        }
        this.usage = `Input: ${usage.inputTokens} (cached: ${usage.cachedInputTokens}), Output: ${usage.outputTokens}`
        break
      }
      case 'error':
        if (params.willRetry !== true) {
          this.errors.add(stringField(fields(params.error, 'error'), 'message'))
        }
        break
    }
  }

  item(item: Fields): void {
    const id = idField(item)
    if (this.completedItems.has(id)) return
    this.completedItems.add(id)
    switch (item.type) {
      case 'agentMessage':
        this.response = stringField(item, 'text')
        break
      case 'fileChange':
        if (item.status !== 'completed') break
        if (!Array.isArray(item.changes)) throw new Error('Invalid Codex app-server file changes')
        for (const value of item.changes) {
          const change = fields(value, 'file change')
          const kind = fields(change.kind, 'change kind')
          const path = stringField(change, 'path')
          const type = stringField(kind, 'type')
          const destination =
            type === 'update' && kind.move_path != null ? stringField(kind, 'move_path') : undefined
          this.files.push({ path, kind: type, destination })
        }
        break
      case 'commandExecution': {
        const stream = this.commandStreams.get(id)
        this.commandStreams.delete(id)
        const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : undefined
        if (output) this.progress(output.slice(stream?.length ?? 0))
        const preview = output?.slice(0, 500) || stream?.preview
        const status =
          typeof item.exitCode === 'number' ? `exit ${item.exitCode}` : stringField(item, 'status')
        this.commands.push(
          `- [${status}] ${stringField(item, 'command')}${preview ? `\n${preview}` : ''}`,
        )
        break
      }
    }
  }

  result(
    threadId: string | undefined,
    turnId: string | undefined,
    outcomeUnknown: boolean,
  ): ToolResult {
    const sections: string[] = []
    if (threadId)
      sections.push(`## Thread\nthreadId: ${threadId}${turnId ? `\nturnId: ${turnId}` : ''}`)
    if (outcomeUnknown) {
      sections.push('Codex turn outcome unknown. Check the thread and workspace before retrying.')
    }
    if (this.errors.size) sections.push(`## Errors\n${[...this.errors].join('\n')}`)
    if (this.response) sections.push(`## Response\n${this.response}`)
    const artifacts = new Set<string>()
    if (this.files.length) {
      const lines: string[] = []
      for (const { kind, path, destination } of this.files) {
        if (kind === 'delete' || destination) artifacts.delete(path)
        if (kind !== 'delete') artifacts.add(destination ?? path)
        lines.push(`- [${kind}] ${path}${destination ? ` → ${destination}` : ''}`)
      }
      sections.push(`## File Changes\n${lines.join('\n')}`)
    }
    if (this.commands.length) sections.push(`## Commands\n${this.commands.join('\n')}`)
    if (this.usage) sections.push(`## Token Usage\n${this.usage}`)
    return {
      success: this.errors.size === 0,
      output: sections.join('\n\n'),
      outputSummary: this.errors.size
        ? `Codex worker ${outcomeUnknown ? 'outcome unknown' : 'failed'}: ${[...this.errors][0].slice(0, 160)}`
        : `Codex worker completed: ${this.files.length} file(s) changed, ${this.commands.length} command(s) run`,
      ...(artifacts.size ? { artifacts: [...artifacts] } : {}),
    }
  }
}

function isTerminalStatus(value: unknown): value is 'completed' | 'failed' | 'interrupted' {
  return value === 'completed' || value === 'failed' || value === 'interrupted'
}

// The reservation outlives the tool call when Codex may still have a turn or a
// subscription with this session's environment. Drop the tool's handlers in that case.
class ThreadSubscription {
  readonly release: () => void
  private lateResume?: boolean
  private handleLateResume?: (accepted: boolean) => void

  constructor(
    private readonly connection: CodexWorkerConnection,
    readonly id: string,
    private readonly logger: ToolContext['logger'],
    public notify: (method: string, params: Fields) => void,
    private fail: (error: Error) => void,
  ) {
    this.release = connection.listen(
      id,
      (method, params) => this.notify(method, params),
      (error) => this.fail(error),
      (accepted) => {
        this.lateResume = accepted
        this.handleLateResume?.(accepted)
      },
    )
  }

  async unsubscribe(): Promise<void> {
    this.handleLateResume = undefined
    this.fail = this.release
    this.notify = (method) => {
      if (method === 'thread/closed') this.release()
    }
    await this.connection.unsubscribe(this.id)
    this.release()
  }

  private detachAfterReturn(): void {
    void this.unsubscribe().catch((error: unknown) => {
      this.logger.warn('worker_thread_cleanup_failed', {
        threadId: this.id,
        error: toErrorMessage(error),
      })
    })
  }

  guardUnconfirmedResume(): void {
    this.fail = this.release
    this.notify = () => {}
    this.handleLateResume = (accepted) => {
      if (accepted) this.detachAfterReturn()
      else this.release()
    }
    if (this.lateResume !== undefined) this.handleLateResume(this.lateResume)
  }

  guardUnconfirmedTurn(expectedTurnId: string | undefined, alreadyInterrupted: boolean): void {
    let turnId = expectedTurnId
    let interruptSent = alreadyInterrupted
    const interrupt = () => {
      if (!turnId || interruptSent) return
      interruptSent = true
      void this.connection
        .request('turn/interrupt', { threadId: this.id, turnId })
        .catch((error: unknown) => {
          this.logger.warn('worker_turn_cleanup_failed', {
            threadId: this.id,
            turnId,
            error: toErrorMessage(error),
          })
        })
    }
    this.fail = this.release
    this.notify = (method, params) => {
      if (method === 'thread/closed') {
        this.release()
        return
      }
      if (method !== 'turn/started' && method !== 'turn/completed') return
      const turn = params.turn as Fields | undefined
      if (!turn || typeof turn.id !== 'string' || !turn.id || (turnId && turn.id !== turnId)) return
      turnId = turn.id
      if (method === 'turn/started') interrupt()
      else if (isTerminalStatus(turn.status)) this.detachAfterReturn()
    }
    interrupt()
  }
}

export async function runCodexWorker(
  ctx: ToolContext,
  input: CodexWorkerInput,
  server: CodexWorkerServer,
): Promise<ToolResult> {
  const cwd = resolve(ctx.projectRoot ?? ctx.workDir, input.workingDirectory ?? '.')
  const handle = ctx.currentToolUseId
    ? ctx.runningToolRegistry?.get(ctx.currentToolUseId)
    : undefined
  const output = new TurnOutput(ctx)
  const turnReady = Promise.withResolvers<void>()
  const completed = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<Error>()
  let connection: CodexWorkerConnection | undefined
  let subscription: ThreadSubscription | undefined
  let resumeUnconfirmed = false
  let threadId: string | undefined
  let turnId: string | undefined
  let observedTurnId: string | undefined
  let submitting = false
  let closing = false
  let unavailable = false
  let terminalStatus: string | undefined
  let abortReason: string | undefined
  let interruptFailure: string | undefined
  let abortTimer: ReturnType<typeof setTimeout> | undefined
  const earlyEvents: Array<{ method: string; params: Fields }> = []

  function onNotification(method: string, params: Fields): void {
    if (method === 'thread/closed') {
      // A resume is reserved before its RPC. A prior unload can still notify us here.
      if (!threadId) return
      unavailable = true
      if (!terminalStatus)
        stopped.resolve(new Error('Codex thread closed before the worker received its turn result'))
      return
    }
    if (closing || !submitting || terminalStatus || params.threadId !== threadId) return
    // Items and completion can arrive before the turn/start continuation installs the ID.
    if (!turnId) {
      if (method === 'turn/started') {
        observedTurnId = idField(fields(params.turn, 'started turn'))
        if (abortReason) interrupt()
      }
      earlyEvents.push({ method, params })
      return
    }
    if (method === 'turn/completed') {
      const turn = fields(params.turn, 'completed turn')
      if (idField(turn) !== turnId) return
      const status = stringField(turn, 'status')
      if (!isTerminalStatus(status)) throw new Error(`Invalid Codex terminal status: ${status}`)
      // Even if the final items cannot be decoded, this turn no longer needs interrupting.
      terminalStatus = status
      if (Array.isArray(turn.items)) {
        for (const item of turn.items) output.item(fields(item, 'turn item'))
      }
      if (status === 'failed') {
        output.errors.add(
          turn.error
            ? stringField(fields(turn.error, 'turn error'), 'message')
            : 'Codex turn failed',
        )
      } else if (status === 'interrupted') {
        output.errors.add(abortReason ?? 'Codex turn interrupted')
      }
      completed.resolve()
    } else if (params.turnId === turnId) {
      output.notification(method, params)
    }
  }

  function subscribe(connection: CodexWorkerConnection, id: string): ThreadSubscription {
    return new ThreadSubscription(
      connection,
      id,
      ctx.logger,
      (method, params) => {
        try {
          onNotification(method, params)
        } catch (error) {
          output.errors.add(toErrorMessage(error))
          stopped.resolve(error instanceof Error ? error : new Error(toErrorMessage(error)))
        }
      },
      (error) => {
        unavailable = true
        stopped.resolve(error)
      },
    )
  }

  function interrupt(): void {
    const id = turnId ?? observedTurnId
    if (!connection || !threadId || !id || terminalStatus || abortTimer) return
    abortTimer = setTimeout(() => {
      stopped.resolve(
        new Error(`Codex interrupt was not confirmed: ${interruptFailure ?? abortReason}`),
      )
    }, INTERRUPT_TIMEOUT_MS)
    void connection.request('turn/interrupt', { threadId, turnId: id }).catch((error: unknown) => {
      // Completion can race with interrupt. The turn's terminal notification wins.
      interruptFailure = toErrorMessage(error)
    })
  }

  async function steer(instruction: string): Promise<void> {
    await turnReady.promise
    if (
      !connection ||
      !threadId ||
      !turnId ||
      closing ||
      unavailable ||
      terminalStatus ||
      abortReason
    ) {
      throw new Error('This Codex worker turn is no longer available for new instructions.')
    }
    const reply = await connection
      .request('turn/steer', {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: 'text', text: instruction, text_elements: [] }],
      })
      .catch((error: unknown) => {
        if (error instanceof CodexAppServerRequestError) throw error
        throw new Error(`Codex adjustment delivery is unknown: ${toErrorMessage(error)}`)
      })
    if (reply.turnId !== turnId) {
      throw new Error('Codex acknowledged a different turn; adjustment delivery is unknown.')
    }
  }

  try {
    handle?.setSteerHandler?.(steer)
    handle?.setAbortHandler((reason) => {
      if (terminalStatus || abortReason) return
      abortReason = reason?.trim() || 'Codex worker interrupted by user'
      turnReady.resolve()
      if (!submitting) stopped.resolve(new Error(abortReason))
      interrupt()
    })
    if (abortReason) throw new Error(abortReason)
    const acquired = await Promise.race([server.acquire(), stopped.promise])
    if (acquired instanceof Error) throw acquired
    connection = acquired
    if (abortReason) throw new Error(abortReason)
    if (input.resumeThreadId) {
      subscription = subscribe(connection, input.resumeThreadId)
      resumeUnconfirmed = true
    }
    const thread = await connection
      .request(input.resumeThreadId ? 'thread/resume' : 'thread/start', {
        ...(input.resumeThreadId ? { threadId: input.resumeThreadId, excludeTurns: true } : {}),
        cwd,
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        config: { shell_environment_policy: { set: buildToolContextEnv(ctx) } },
        ...(input.model ? { model: input.model } : {}),
      })
      .catch((error: unknown) => {
        if (error instanceof CodexAppServerRequestError) resumeUnconfirmed = false
        throw error
      })
    const state = fields(thread.thread, 'thread')
    const id = idField(state)
    if (input.resumeThreadId && id !== input.resumeThreadId) {
      throw new Error('Codex resumed a different thread than requested')
    }
    resumeUnconfirmed = false
    subscription ??= subscribe(connection, id)
    threadId = id
    if (unavailable) throw await stopped.promise
    if (abortReason) throw new Error(abortReason)
    if (
      input.resumeThreadId &&
      state.status &&
      fields(state.status, 'thread status').type === 'active'
    ) {
      throw new Error(`Codex thread already has an active turn: ${threadId}`)
    }
    const turnParams = {
      threadId,
      input: [{ type: 'text', text: input.instruction, text_elements: [] }],
      ...(input.additionalDirectories?.length
        ? { sandboxPolicy: extendedSandbox(thread.sandbox, cwd, input.additionalDirectories) }
        : {}),
    }
    submitting = true
    const started = await Promise.race([
      connection.request('turn/start', turnParams),
      stopped.promise,
    ]).catch((error: unknown) => {
      if (error instanceof CodexAppServerRequestError) submitting = false
      throw error
    })
    if (started instanceof Error) throw started
    turnId = idField(fields(started.turn, 'started turn'))
    ctx.logger.info('worker_turn_started', {
      type: 'codex',
      toolUseId: ctx.currentToolUseId,
      threadId,
      turnId,
    })
    for (const event of earlyEvents.splice(0)) subscription.notify(event.method, event.params)
    turnReady.resolve()
    if (abortReason && !unavailable) interrupt()
    const problem = await Promise.race([completed.promise, stopped.promise])
    if (problem) throw problem
  } catch (error) {
    output.errors.add(toErrorMessage(error))
  } finally {
    closing = true
    turnReady.resolve()
    clearTimeout(abortTimer)
    handle?.setAbortHandler(() => {})
    handle?.setSteerHandler?.(undefined)
    if (subscription) {
      if (unavailable) {
        subscription.release()
      } else if (resumeUnconfirmed) {
        subscription.guardUnconfirmedResume()
      } else if (submitting && !terminalStatus) {
        subscription.guardUnconfirmedTurn(turnId ?? observedTurnId, !!abortTimer)
        for (const event of earlyEvents) subscription.notify(event.method, event.params)
      } else if (threadId) {
        try {
          await subscription.unsubscribe()
        } catch (error) {
          output.errors.add(`Codex thread cleanup failed: ${toErrorMessage(error)}`)
        }
      } else {
        subscription.release()
      }
    }
  }

  const result = output.result(threadId, turnId ?? observedTurnId, submitting && !terminalStatus)
  if (terminalStatus === 'interrupted' || (abortReason && !submitting)) {
    handle?.markFinished({
      cause: 'abort',
      success: false,
      finishedAt: now(),
      outputSummary: ctx.secretFilter?.filter(result.outputSummary) ?? result.outputSummary,
    })
  }
  return result
}
