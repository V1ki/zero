import type { MemoryRetriever } from '@zero-os/memory'
import type { MetricsDB, ObservabilityStore, SessionDB, Tracer } from '@zero-os/observe'
import type {
  ControlKind,
  Message,
  MessageChannelSource,
  MessageType,
  SecretFilter,
  ToolContext,
} from '@zero-os/shared'
import type { SessionImageAttachment } from './session-messages'

/**
 * Dependencies injected into Session for observability, memory, and eventing.
 */
export interface SessionDeps {
  observability?: ObservabilityStore
  metrics?: MetricsDB
  tracer?: Tracer
  secretFilter?: SecretFilter
  secretResolver?: (ref: string) => string | undefined
  memoryRetriever?: MemoryRetriever
  memoryStore?: ToolContext['memoryStore']
  identityMemory?: string
  globalIdentity?: string
  agentIdentity?: string
  identityReader?: (agentName: string) => { global: string; agent: string }
  bus?: {
    emit(topic: string, data: Record<string, unknown>): void
  }
  persistModelPreference?: (model: string) => void
  sessionDb?: SessionDB
  schedulerHandle?: ToolContext['schedulerHandle']
  scheduleStore?: ToolContext['scheduleStore']
  taskClosureModel?: string
  contextCompactionModel?: string
  projectRoot?: string
}

/**
 * Options for Session.handleMessage().
 */
export interface HandleMessageOptions {
  /** Called synchronously for every new Message (user, assistant, tool_result). */
  onProgress?: (msg: Message) => void
  /** Called for every assistant text delta when the model supports streaming. */
  onTextDelta?: (delta: string, meta: { role: 'assistant'; turnId: string }) => void
  /** Image attachments (base64) to send alongside the text message. */
  images?: SessionImageAttachment[]
  /** Originating external channel message, used for follow-up events like message recall. */
  source?: MessageChannelSource
  /** Internal message classification for runtime-generated user-role events. */
  messageType?: MessageType
  /** Runtime control event kind when messageType is control. */
  controlKind?: ControlKind
  /** Called after a queued message is injected into a later model request and that request returns. */
  onQueuedMessageApplied?: () => void
}

export interface ReasoningEffortUpdateResult {
  changed: boolean
  message: string
}
