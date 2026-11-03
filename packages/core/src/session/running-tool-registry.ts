import type {
  Message,
  RunningToolAbortRequestStatus,
  RunningToolHandle,
  RunningToolRegistry,
  RunningToolState,
  RunningToolTerminalMetadata,
} from '@zero-os/shared'
import { isAbortableTool } from '@zero-os/shared'
import { findToolUseById } from './session-messages'

class SessionRunningToolHandle implements RunningToolHandle {
  readonly toolUseId: string
  readonly toolName: string
  readonly abortable: boolean

  private state: RunningToolState = 'running'
  private abortReason?: string
  private terminalMetadata?: RunningToolTerminalMetadata
  private abortHandler?: (reason?: string) => void
  private steerHandler?: (instruction: string) => Promise<void>

  constructor(entry: { toolUseId: string; toolName: string; abortable: boolean }) {
    this.toolUseId = entry.toolUseId
    this.toolName = entry.toolName
    this.abortable = entry.abortable
  }

  getState(): RunningToolState {
    return this.state
  }

  getAbortReason(): string | undefined {
    return this.abortReason
  }

  getTerminalMetadata(): RunningToolTerminalMetadata | undefined {
    return this.terminalMetadata
  }

  requestAbort(reason?: string): RunningToolAbortRequestStatus {
    if (!this.abortable) return 'not_abortable'
    if (this.state === 'finished') return 'already_finished'
    if (this.state === 'abort_requested') return 'already_requested'

    this.state = 'abort_requested'
    this.abortReason = reason
    this.abortHandler?.(reason)
    return 'accepted'
  }

  setAbortHandler(handler: (reason?: string) => void): void {
    this.abortHandler = handler
    if (this.state === 'abort_requested') {
      handler(this.abortReason)
    }
  }

  setSteerHandler(handler: ((instruction: string) => Promise<void>) | undefined): void {
    this.steerHandler = handler
  }

  async steer(instruction: string): Promise<void> {
    if (this.state !== 'running' || !this.steerHandler) {
      throw new Error('This Worker is not accepting instructions.')
    }
    await this.steerHandler(instruction)
  }

  markFinished(metadata: RunningToolTerminalMetadata): boolean {
    if (this.state === 'finished') return false
    this.state = 'finished'
    this.steerHandler = undefined
    this.terminalMetadata = metadata
    return true
  }
}

export async function steerRunningWorker(
  registry: RunningToolRegistry | undefined,
  toolUseId: string,
  instruction: string,
): Promise<void> {
  const handle = registry?.get(toolUseId)
  if (handle?.toolName !== 'worker' || !handle.steer) {
    throw new Error('No matching Worker run in this session.')
  }
  await handle.steer(instruction)
}

export class SessionRunningToolRegistry implements RunningToolRegistry {
  private entries = new Map<string, SessionRunningToolHandle>()

  register(entry: {
    toolUseId: string
    toolName: string
    abortable: boolean
  }): RunningToolHandle {
    const handle = new SessionRunningToolHandle(entry)
    this.entries.set(entry.toolUseId, handle)
    return handle
  }

  get(toolUseId: string): RunningToolHandle | undefined {
    return this.entries.get(toolUseId)
  }
}

export function requestSessionRunningToolAbort(options: {
  registry: SessionRunningToolRegistry
  messages: Message[]
  toolUseId: string
  reason?: string
}): RunningToolAbortRequestStatus {
  const liveEntry = options.registry.get(options.toolUseId)
  if (liveEntry) {
    return liveEntry.requestAbort(options.reason)
  }

  const call = findToolUseById(options.messages, options.toolUseId)
  return isAbortableTool(call?.name.toLowerCase(), call?.input?.action)
    ? 'already_finished'
    : 'not_abortable'
}
