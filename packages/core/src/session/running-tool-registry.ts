import type {
  Message,
  RunningToolAbortRequestStatus,
  RunningToolHandle,
  RunningToolRegistry,
  RunningToolState,
  RunningToolTerminalMetadata,
} from '@zero-os/shared'
import { findToolNameByUseId } from './session-messages'

class SessionRunningToolHandle implements RunningToolHandle {
  readonly toolUseId: string
  readonly toolName: string
  readonly abortable: boolean

  private state: RunningToolState = 'running'
  private abortReason?: string
  private terminalMetadata?: RunningToolTerminalMetadata
  private abortHandler?: (reason?: string) => void

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

  markFinished(metadata: RunningToolTerminalMetadata): boolean {
    if (this.state === 'finished') return false
    this.state = 'finished'
    this.terminalMetadata = metadata
    return true
  }
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

  const toolName = findToolNameByUseId(options.messages, options.toolUseId)
  return toolName === 'bash' ? 'already_finished' : 'not_abortable'
}
