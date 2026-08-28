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
import type { BackgroundToolCompletionEvent } from './background-tool-tasks'
import type { SessionImageAttachment } from './session-messages'

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

export type BackgroundToolCompletionRunner = (options?: HandleMessageOptions) => Promise<Message[]>

export type BackgroundToolCompletionHandler = (
  event: BackgroundToolCompletionEvent,
  run: BackgroundToolCompletionRunner,
) => Promise<boolean> | boolean

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
  /** 使用反馈统计(MemoryUsageTracker);缺省时检索 usage 项为 0、埋点静默跳过 */
  memoryUsage?: ToolContext['memoryUsage']
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
  backgroundToolCompletionHandler?: BackgroundToolCompletionHandler
}

export interface ReasoningEffortUpdateResult {
  changed: boolean
  message: string
}
