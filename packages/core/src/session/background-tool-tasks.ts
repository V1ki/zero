import type {
  BackgroundToolExecutionInput,
  BackgroundToolTaskSink,
  SecretFilter,
  ToolLogger,
  ToolResult,
} from '@zero-os/shared'
import { generateId, now, toErrorMessage } from '@zero-os/shared'

export const BACKGROUND_TOOL_TIMEOUT_MS = 60_000

const MAX_OUTPUT_CHARS = 8_000
const MAX_SUMMARY_CHARS = 500

export type BackgroundToolTaskStatus = 'running' | 'success' | 'error'

export interface BackgroundToolTaskRecord {
  id: string
  sessionId: string
  toolName: string
  toolUseId: string
  inputSummary: string
  status: BackgroundToolTaskStatus
  startedAt: string
  completedAt?: string
  durationMs?: number
  outputSummary?: string
  output?: string
}

export interface BackgroundToolCompletionEvent {
  task: BackgroundToolTaskRecord
  xml: string
}

interface BackgroundToolTaskManagerOptions {
  sessionId: string
  thresholdMs?: number
  logger: ToolLogger
  secretFilter?: SecretFilter
  channelBinding?: {
    channelName: string
    channelId: string
    participantId?: string
    deliveryChannelId?: string
  }
  emitBusEvent?(topic: string, data: Record<string, unknown>): void
  onComplete(event: BackgroundToolCompletionEvent): Promise<void> | void
}

type ToolSettledResult =
  | { type: 'result'; result: ToolResult }
  | { type: 'error'; error: unknown }
  | { type: 'background' }

export class BackgroundToolTaskManager implements BackgroundToolTaskSink {
  readonly thresholdMs: number
  private tasks = new Map<string, BackgroundToolTaskRecord>()

  constructor(private readonly options: BackgroundToolTaskManagerOptions) {
    this.thresholdMs = options.thresholdMs ?? BACKGROUND_TOOL_TIMEOUT_MS
  }

  async run(input: BackgroundToolExecutionInput): Promise<ToolResult> {
    const startedAtMs = Date.now()
    const startedAt = now()
    const execution = input.execute()
    const foreground: Promise<ToolSettledResult> = execution
      .then<ToolSettledResult>((result) => ({ type: 'result', result }))
      .catch((error) => ({ type: 'error', error }))
    const background = new Promise<ToolSettledResult>((resolve) => {
      setTimeout(() => resolve({ type: 'background' }), this.thresholdMs)
    })

    const first = await Promise.race([foreground, background])
    if (first.type === 'result') return first.result
    if (first.type === 'error') throw first.error

    const task = this.startTask({
      toolName: input.toolName,
      toolUseId: input.toolUseId,
      inputSummary: input.inputSummary,
      startedAt,
    })

    void foreground.then((settled) => {
      if (settled.type === 'result') {
        this.completeTask(task.id, {
          status: settled.result.success ? 'success' : 'error',
          output: settled.result.output,
          outputSummary: settled.result.outputSummary,
          completedAtMs: Date.now(),
          startedAtMs,
        })
        return
      }

      if (settled.type === 'error') {
        const message = toErrorMessage(settled.error)
        this.completeTask(task.id, {
          status: 'error',
          output: message,
          outputSummary: `Tool execution failed: ${message.slice(0, 100)}`,
          completedAtMs: Date.now(),
          startedAtMs,
        })
      }
    })

    return {
      success: true,
      output: buildBackgroundStartedOutput(task),
      outputSummary: `Background task started: ${task.toolName} (${task.id})`,
    }
  }

  getTask(id: string): BackgroundToolTaskRecord | undefined {
    return this.tasks.get(id)
  }

  private startTask(input: {
    toolName: string
    toolUseId: string
    inputSummary: string
    startedAt: string
  }): BackgroundToolTaskRecord {
    const task: BackgroundToolTaskRecord = {
      id: generateId(),
      sessionId: this.options.sessionId,
      toolName: input.toolName,
      toolUseId: input.toolUseId,
      inputSummary: this.filterAndTruncate(input.inputSummary, MAX_SUMMARY_CHARS),
      status: 'running',
      startedAt: input.startedAt,
    }
    this.tasks.set(task.id, task)
    this.options.emitBusEvent?.('background_tool:started', {
      sessionId: task.sessionId,
      taskId: task.id,
      tool: task.toolName,
      toolUseId: task.toolUseId,
      inputSummary: task.inputSummary,
      status: task.status,
      startedAt: task.startedAt,
      thresholdMs: this.thresholdMs,
      ...this.getChannelEventData(),
    })
    return task
  }

  private completeTask(
    taskId: string,
    result: {
      status: 'success' | 'error'
      output: string
      outputSummary: string
      completedAtMs: number
      startedAtMs: number
    },
  ): void {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'running') return

    const completedAt = now()
    task.status = result.status
    task.completedAt = completedAt
    task.durationMs = Math.max(0, result.completedAtMs - result.startedAtMs)
    task.outputSummary = this.filterAndTruncate(result.outputSummary, MAX_SUMMARY_CHARS)
    task.output = this.filterAndTruncate(result.output, MAX_OUTPUT_CHARS)

    this.options.emitBusEvent?.('background_tool:completed', {
      sessionId: task.sessionId,
      taskId: task.id,
      tool: task.toolName,
      toolUseId: task.toolUseId,
      status: task.status,
      outputSummary: task.outputSummary,
      durationMs: task.durationMs,
      startedAt: task.startedAt,
      completedAt,
      ...this.getChannelEventData(),
    })

    const xml = buildBackgroundToolCompletionXml(task)
    Promise.resolve(this.options.onComplete({ task: { ...task }, xml })).catch((error) => {
      this.options.logger.warn('background_tool_completion_injection_failed', {
        sessionId: task.sessionId,
        taskId: task.id,
        error: toErrorMessage(error),
      })
    })
  }

  private filterAndTruncate(value: string, maxChars: number): string {
    const filtered = this.options.secretFilter?.filter(value) ?? value
    return truncate(filtered, maxChars)
  }

  private getChannelEventData(): Record<string, unknown> {
    const binding = this.options.channelBinding
    if (!binding) return {}
    return {
      channelName: binding.channelName,
      channelId: binding.channelId,
      deliveryChannelId: binding.deliveryChannelId ?? binding.channelId,
      ...(binding.participantId ? { participantId: binding.participantId } : {}),
    }
  }
}

function buildBackgroundStartedOutput(task: BackgroundToolTaskRecord): string {
  return `<system_event type="background_tool.started">
<background_task id="${escapeXmlAttribute(task.id)}" tool_name="${escapeXmlAttribute(
    task.toolName,
  )}" tool_use_id="${escapeXmlAttribute(task.toolUseId)}" status="running">
<message>Tool execution exceeded the foreground wait threshold and is continuing in the background. You will receive a background_tool.completed system event when it finishes.</message>
</background_task>
</system_event>`
}

export function buildBackgroundToolCompletionXml(task: BackgroundToolTaskRecord): string {
  return `<system_event type="background_tool.completed">
<background_task id="${escapeXmlAttribute(task.id)}" tool_name="${escapeXmlAttribute(
    task.toolName,
  )}" tool_use_id="${escapeXmlAttribute(task.toolUseId)}" status="${task.status}" duration_ms="${
    task.durationMs ?? 0
  }">
<output_summary>${escapeXmlText(task.outputSummary ?? '')}</output_summary>
<output>${escapeXmlText(task.output ?? '')}</output>
</background_task>
</system_event>`
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars - 3).trimEnd()}...`
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;')
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
