/**
 * Vendored structural types for the trajectory view, originally from
 * DeepSeek Harness `dsh-client-runtime` / `dsh-llm` (MIT). Field names are kept
 * identical so the ported view sources compile unchanged; DSH-only concepts are
 * narrowed to structural equivalents. The adapter (adapt-trajectory.ts) is the
 * only producer of these values in this app.
 */

/** Model-visible content block as classified by the trajectory view. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; attachment: unknown }
  | { type: 'tool-call'; id: string | number; name: string; arguments: string }

/** Assistant content blocks sorted by what the UI cares about. */
export type AssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'image'; attachment: unknown }
  | { kind: 'tool-call'; callId: string; name: string; argsRaw: string }
  | { kind: 'other'; block: unknown }

/** Request configuration recorded for one provider call. */
export interface AssistantRequestConfig {
  provider: string
  model: string
  purpose?: string
  thinking?: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
}

/** Stable provider/model identity reported for one completed request. */
export interface AssistantProvenanceView {
  provider: string
  model: string
}

/** Producer role and name projected onto a context injection. */
export interface ContextProvenanceView {
  role: string
  name?: string
}

/** A finalized user message. */
export interface UserMessageNode {
  kind: 'user'
  seq: number
  time: number
  content: readonly ContentBlock[]
  source: unknown
}

/** Recorded boundaries used to derive assistant latency and throughput. */
export interface AssistantTiming {
  stepStartTime: number | null
  firstTokenTime: number | null
  completedTime: number
}

/** A finalized assistant message. */
export interface AssistantMessageNode {
  kind: 'assistant'
  seq: number
  messageId?: string
  time: number
  turn: number
  step: number
  blocks: readonly AssistantBlock[]
  usage?: unknown
  provenance?: AssistantProvenanceView
  requestConfig?: AssistantRequestConfig
  timing?: AssistantTiming
  interrupted?: true
}

/** A human message admitted while a turn was running. */
export interface SteeringMessageNode {
  kind: 'steering'
  messageId: string
  seq: number
  time: number
  content: readonly ContentBlock[]
  source: unknown
}

/** Token usage reported for one gate (classifier) call. */
export interface ContextGateUsage {
  input?: number
  cacheRead?: number
  cacheWrite?: number
  output?: number
  reasoning?: number
}

/**
 * Gate question/answer pair captured for a control-gate projection (ZeRo
 * adapter extension): rendered tool-style with separate Payload/Result detail.
 */
export interface ContextGateQa {
  /** The full prompt the gate asked (task-closure classifier question). */
  question: string
  /** The gate's full output (classifier answer, reasoning, failure detail). */
  answer: string
  /** Gate call start in epoch ms, when the trace span is known. */
  startedAt?: number
  /** Gate call duration in ms, when the trace span is known. */
  durationMs?: number
  /** Token usage reported for the gate (classifier) call. */
  usage?: ContextGateUsage
}

/** A context/system injection surfaced in the flow. */
export interface ContextMessageNode {
  kind: 'context'
  seq: number
  time: number
  content: readonly ContentBlock[]
  source: unknown
  provenance: ContextProvenanceView
  form: string | null
  /** Present when the gate captured a question/answer pair (task closure). */
  gateQa?: ContextGateQa
}

/** Durable notice that a failed step is waiting for a model-request retry. */
export interface ModelRetryNode {
  kind: 'model-retry'
  seq: number
  time: number
  reason?: string
  attempt?: number
  delayMs?: number
  retryState: 'scheduled' | 'started' | 'cancelled'
}

/** Durable terminal failure for a turn that ended with an error reason. */
export interface TurnErrorNode {
  kind: 'turn-error'
  seq: number
  time: number
  turn: number
  step: number
  message: string
  code?: string
}

/** Durable notice for a turn ended by the per-request output-token cap. */
export interface TurnMaxTokensNode {
  kind: 'turn-max-tokens'
  seq: number
  time: number
  turn: number
  step: number
}

/** Persisted evidence pointer captured from a tool_use/tool_result block. */
export interface ToolEvidenceView {
  kind: string
  path: string
  chars?: number
  sha256?: string
}

/** A tool result paired (when known) with its call head. */
export interface ToolResultNode {
  kind: 'tool-result'
  seq: number
  time: number
  callId: string
  call: { name: string; argsRaw: string } | null
  callTime: number | null
  content: readonly ContentBlock[]
  isError: boolean
  evidence: ToolEvidenceView | null
  error?: { name: string; code: string }
  meta?: unknown
  callView: null
  resultView: null
  subCalls: readonly ToolCallBlock[]
}

/** One landed compaction marked at the checkpoint's own log position. */
export interface CompactionSummaryNode {
  kind: 'compaction'
  seq: number
  time: number
  summary: string | null
  summaryEventSeq: number | null
  shadowedItemCount: number | null
  shadowedTokenCount: number | null
}

/** Fallback for surface events the projection does not know. */
export interface UnknownSurfaceNode {
  kind: 'unknown'
  seq: number
  time: number
  type: string
  data: unknown
}

/** One slash-command lifecycle folded from its run/done pair. */
export interface CommandNode {
  kind: 'command'
  seq: number
  time: number
  commandId: string
  name: string | null
  args: string | null
  outcome: {
    kind: 'success' | 'error'
    text?: string
    sourceEventSeq?: number
  } | null
}

/** Finalized conversation node union (kind discriminates; seq is the React key). */
export type ConversationNode =
  | UserMessageNode
  | AssistantMessageNode
  | SteeringMessageNode
  | ContextMessageNode
  | ModelRetryNode
  | TurnErrorNode
  | TurnMaxTokensNode
  | ToolResultNode
  | CommandNode
  | CompactionSummaryNode
  | UnknownSurfaceNode

/** In-flight tool card material: call seen, result not yet. */
export interface RunningToolCall {
  callId: string
  name: string
  argsRaw: string
  turn: number
  step: number
  time: number
  callView: null
  subCalls: readonly ToolCallBlock[]
}

/** One running or settled call, recursively owning its child calls. */
export type ToolCallBlock = RunningToolCall | ToolResultNode

/** In-progress assistant output. */
export interface PartialAssistant {
  turn: number
  step: number
  blocks: readonly AssistantBlock[]
}

/** Step-scoped location used for Turn/Step grouping. */
export interface StepLocation {
  kind: 'step'
  turn: { turn: number }
  step: { step: number }
}

/** Turn-scoped location used for between-turn placement. */
export interface TurnLocation {
  kind: 'turn'
  turn: { turn: number }
}

export type ConversationLocation = StepLocation | TurnLocation

/** Model-visible tool schema sent with a request (rendered as JSON detail). */
export interface ToolSchema {
  name: string
  description?: string
  /** Set when the definition was filled in from the current tool registry. */
  source?: 'registry'
  [key: string]: unknown
}

/** Complete model-visible request header in force for a generation. */
export interface ConversationPromptSnapshot {
  config: AssistantRequestConfig
  system: string
  tools: readonly ToolSchema[]
}

/** System/tool change introduced while preparing one request. */
export interface RequestPromptChange {
  seq: number
  time: number
  kind: 'initial' | 'system' | 'tools' | 'system-and-tools'
  previous?: ConversationPromptSnapshot
}

/** Lifecycle fields shared by ordinary generation and compaction requests. */
interface RequestViewBase {
  startSeq: number
  startedAt: number
  completedAt: number | null
  status: 'running' | 'complete' | 'error'
  error?: string
  provenance?: AssistantProvenanceView
  requestConfig?: AssistantRequestConfig
  usage?: unknown
  resultSeq?: number
}

/** One ordinary assistant generation. */
export interface AssistantRequestView extends RequestViewBase {
  purpose: 'assistant'
  turn: number
  step: number
  prompt?: ConversationPromptSnapshot
  promptChange?: RequestPromptChange
  retry?: number
  maxRetries?: number
  retryDelayMs?: number
}

/** One compaction provider request, turn-owned or standalone between turns. */
export interface CompactionRequestView extends RequestViewBase {
  purpose: 'compaction'
  turn: number | null
  step: 0
  replacementSeq?: number
  summary?: readonly ContentBlock[]
  rawOutput?: readonly ContentBlock[]
}

export type RequestView = AssistantRequestView | CompactionRequestView

/** Request projection consumed by the trajectory layout. */
export interface RequestInspectionSnapshot {
  requests: readonly RequestView[]
  callSchemas: ReadonlyMap<string, ToolSchema>
}

/** Minimal conversation-window slice the trajectory layout reads. */
export interface ConversationSnapshot {
  nodes: readonly ConversationNode[]
  partial: PartialAssistant | null
  runningCalls: readonly RunningToolCall[]
}

/** Trajectory data contract consumed by the ported view components. */
export interface TrajectorySnapshot {
  readonly eventNodes: readonly ConversationNode[]
  readonly eventLocations: ReadonlyMap<number, ConversationLocation>
  readonly requests: readonly RequestView[]
  readonly callSchemas: ReadonlyMap<string, ToolSchema>
  readonly partial: PartialAssistant | null
  readonly runningCalls: readonly RunningToolCall[]
}

const EMPTY_LIST: readonly never[] = []

/** Stable empty target used before a session has assembled trajectory data. */
export const EMPTY_TRAJECTORY_SNAPSHOT: TrajectorySnapshot = {
  eventNodes: EMPTY_LIST,
  eventLocations: new Map(),
  requests: EMPTY_LIST,
  callSchemas: new Map(),
  partial: null,
  runningCalls: EMPTY_LIST,
}

/** Minimal persisted observable value used for the duration preference. */
export interface SnapshotStore<T> {
  get(): T
  set(value: T): void
  subscribe(listener: (value: T) => void): () => void
}
