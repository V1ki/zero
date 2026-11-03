import { resolve } from 'node:path'
import type { ToolContext, ToolResult } from '@zero-os/shared'
import { now, toErrorMessage } from '@zero-os/shared'
import { BACKGROUND_TOOL_PROGRESS_TAIL_CHARS } from '../../session/background-tool-tasks'
import { buildToolProcessEnv } from '../process-env'
import { CodexAppServerClient, CodexAppServerRequestError } from './app-server-client'

interface CodexWorkerInput {
  instruction: string
  workingDirectory?: string
  additionalDirectories?: string[]
  model?: string
  resumeThreadId?: string
}

type Fields = Record<string, unknown>
const INTERRUPT_TIMEOUT_MS = 5_000
const activeThreads = new Set<string>()

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

export async function runCodexWorker(
  ctx: ToolContext,
  input: CodexWorkerInput,
  codexPath?: string,
): Promise<ToolResult> {
  const cwd = resolve(ctx.projectRoot ?? ctx.workDir, input.workingDirectory ?? '.')
  const handle = ctx.currentToolUseId
    ? ctx.runningToolRegistry?.get(ctx.currentToolUseId)
    : undefined
  const output = new TurnOutput(ctx)
  const completed = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<Error>()
  let ownedThread: string | undefined
  let threadId: string | undefined
  let turnId: string | undefined
  let submitting = false
  let closing = false
  let terminalStatus: string | undefined
  let abortReason: string | undefined
  let interruptFailure: string | undefined
  let abortTimer: ReturnType<typeof setTimeout> | undefined
  let client: CodexAppServerClient | undefined
  const earlyEvents: Array<{ method: string; params: Fields }> = []

  function claimThread(id: string): void {
    if (activeThreads.has(id)) throw new Error(`Codex thread already has an active worker: ${id}`)
    activeThreads.add(id)
    ownedThread = id
  }

  function onNotification(method: string, params: Fields): void {
    if (closing || !submitting || terminalStatus || params.threadId !== threadId) return
    // A server can send items or completion together with the turn/start response,
    // before its awaiting continuation in this process has installed the turn ID.
    if (!turnId) {
      earlyEvents.push({ method, params })
      return
    }
    if (method === 'thread/closed') {
      throw new Error('Codex thread closed before the worker received its turn result')
    }
    if (method === 'turn/completed') {
      const turn = fields(params.turn, 'completed turn')
      if (idField(turn) !== turnId) return
      const status = stringField(turn, 'status')
      if (!['completed', 'failed', 'interrupted'].includes(status)) {
        throw new Error(`Invalid Codex terminal status: ${status}`)
      }
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
      terminalStatus = status
      completed.resolve()
    } else if (params.turnId === turnId) {
      output.notification(method, params)
    }
  }

  function interrupt(): void {
    if (client && threadId && turnId && !terminalStatus) {
      void client.request('turn/interrupt', { threadId, turnId }).catch((error: unknown) => {
        // Completion can race with interrupt. The turn's terminal notification wins.
        interruptFailure = toErrorMessage(error)
      })
    }
  }

  async function run(connection: CodexAppServerClient): Promise<void> {
    await connection.request('initialize', { clientInfo: { name: 'zero_os_worker', version: '1' } })
    connection.notify('initialized', {})
    if (closing || abortReason) throw new Error(abortReason ?? 'Codex worker closed')
    const thread = await connection.request(
      input.resumeThreadId ? 'thread/resume' : 'thread/start',
      {
        ...(input.resumeThreadId ? { threadId: input.resumeThreadId, excludeTurns: true } : {}),
        cwd,
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        ...(input.model ? { model: input.model } : {}),
      },
    )
    if (closing) throw new Error('Codex worker closed')
    const id = idField(fields(thread.thread, 'thread'))
    if (input.resumeThreadId && id !== input.resumeThreadId) {
      throw new Error('Codex resumed a different thread than requested')
    }
    if (!ownedThread) claimThread(id)
    threadId = id
    if (abortReason) throw new Error(abortReason)
    const turnParams = {
      threadId,
      input: [{ type: 'text', text: input.instruction, text_elements: [] }],
      ...(input.additionalDirectories?.length
        ? { sandboxPolicy: extendedSandbox(thread.sandbox, cwd, input.additionalDirectories) }
        : {}),
    }
    submitting = true
    const started = await connection.request('turn/start', turnParams).catch((error: unknown) => {
      if (error instanceof CodexAppServerRequestError) submitting = false
      throw error
    })
    if (closing) return
    turnId = idField(fields(started.turn, 'started turn'))
    ctx.logger.info('worker_turn_started', {
      type: 'codex',
      toolUseId: ctx.currentToolUseId,
      threadId,
      turnId,
    })
    for (const event of earlyEvents.splice(0)) onNotification(event.method, event.params)
    if (abortReason) interrupt()
    await completed.promise
  }

  try {
    if (input.resumeThreadId) claimThread(input.resumeThreadId)
    client = new CodexAppServerClient({
      cwd,
      env: buildToolProcessEnv(ctx),
      codexPath,
      onNotification,
      filterDiagnostic: ctx.secretFilter?.filter.bind(ctx.secretFilter),
    })
    handle?.setAbortHandler((reason) => {
      if (terminalStatus || abortReason) return
      abortReason = reason?.trim() || 'Codex worker interrupted by user'
      if (!submitting) {
        stopped.resolve(new Error(abortReason))
        return
      }
      interrupt()
      abortTimer = setTimeout(() => {
        stopped.resolve(
          new Error(`Codex interrupt was not confirmed: ${interruptFailure ?? abortReason}`),
        )
      }, INTERRUPT_TIMEOUT_MS)
    })
    if (abortReason) throw new Error(abortReason)
    const problem = await Promise.race([run(client), client.closed, stopped.promise])
    if (problem) throw problem
  } catch (error) {
    output.errors.add(toErrorMessage(error))
  } finally {
    closing = true
    clearTimeout(abortTimer)
    // The session registry retains finished handles. Release this turn's process and output.
    handle?.setAbortHandler(() => {})
    try {
      await client?.close()
    } catch (error) {
      output.errors.add(`Codex app-server cleanup failed: ${toErrorMessage(error)}`)
    } finally {
      if (ownedThread) activeThreads.delete(ownedThread)
    }
  }

  const result = output.result(threadId, turnId, submitting && !terminalStatus)
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
