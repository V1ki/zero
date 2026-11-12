import type { TimelineCompactionBlock } from './context'
import type { Message, TokenUsage, ToolEvidence } from './message'
import type { SessionSource } from './session'

/**
 * Append-only session event log (`session.jsonl`).
 *
 * 权威事件流:文件第一行必须是 `session` 头事件(seq=0),之后 seq 严格递增。
 * 事件分三类:
 * - surface(投影源): user/message | assistant/message | messages/truncate | compaction/block
 * - request-scoped(重建某次请求输入): injection/context、step/start(锚点为其自身 seq)
 * - diagnostics(纯排障,可裁剪): 其余全部
 */
export const SESSION_EVENT_SCHEMA_VERSION = 1
export const SESSION_EVENT_FILE = 'session.jsonl'
export const SUBAGENT_EVENT_FILE_PREFIX = 'sub-'

export type SessionEventOrigin = 'subagent'

export interface SessionEventData {
  v: 1
  sessionId: string
  schemaVersion: number
  source: SessionSource | 'spawn'
  channelId?: string
  channelName?: string
  /** 仅子代理会话填写;缺省即主会话 */
  origin?: SessionEventOrigin
  parentSessionId?: string
  spawnedByRequestId?: string
  name?: string
  role?: string
}

export type SessionTrigger =
  | 'channel'
  | 'queued_drain'
  | 'background_completion'
  | 'restart_recovery'
  | 'scheduler'
  | 'control'

export interface TurnStartEventData {
  turnIndex: number
  trigger: SessionTrigger
  model?: string
  agentName?: string
  /** 本 turn 开始时事件流最后一条 seq:本 turn 的消息事件全部落在 seq > baseSeq */
  baseSeq?: number
}

export type TurnEndStatus = 'completed' | 'failed' | 'aborted'

export interface TurnEndEventData {
  turnIndex: number
  status: TurnEndStatus
  durationMs?: number
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  messageSeqSpan?: [number, number]
}

export interface CheckpointEventData {
  atSeq: number
  messageCount: number
  projectionHash: string
}

export interface SessionArchiveEventData {
  reason: 'channel_unbind' | 'deleted' | 'manual'
}

export interface UserMessageEventData {
  /** canonical 数组下标,追加时确定 */
  messageIndex: number
  message: Message
  source: Message['source']
  hash: string
}

export interface AssistantMessageEventData {
  messageIndex: number
  message: Message
  model?: string
  provider?: string
  requestId?: string
  usage?: Record<string, number>
  hash: string
}

export type MessagesTruncateReason = 'turn_failed' | 'interrupt' | 'admin' | 'restore_repair'

export interface MessagesTruncateEventData {
  /** 投影保留到该下标(不含) */
  toMessageIndex: number
  reason: MessagesTruncateReason
}

export type InjectionContextKind =
  | 'dynamic'
  | 'memory'
  | 'memory_hint'
  | 'queued_merge'
  | 'image_delegation'

export interface InjectionContextEventData {
  kind: InjectionContextKind
  requestId?: string
  content: string
  refs?: Record<string, unknown>
}

export interface InboxEnqueuedEventData {
  messageIndex: number
  reason: string
  interrupt: boolean
}

export interface InboxDrainedEventData {
  /** canonical 下标在排队消息为 'queued' 消息时可知;仅诊断用途,未知时省略 */
  messageIndexes?: number[]
  count?: number
}

export interface InboxSplicedEventData {
  messageIndexes?: number[]
  intoMessageIndex?: number
  strategy: string
  count?: number
}

export interface StepStartEventData {
  stepIndex: number
  requestSpanId?: string
  model?: string
  messageCount?: number
}

export type StepStopReason = 'end_turn' | 'tool_use' | 'error' | 'aborted'

export interface StepEndEventData {
  stepIndex: number
  stopReason: StepStopReason
  requestId?: string
  usage?: TokenUsage
  durationMs?: number
}

export interface ToolCallEventData {
  toolUseId: string
  name: string
  inputHash: string
  inputPreview?: string
  spanId?: string
}

export interface ToolResultEventData {
  toolUseId: string
  name?: string
  status: 'success' | 'error'
  durationMs?: number
  chars?: number
  evidence?: ToolEvidence
  summary?: string
}

export type LlmRetryErrorClass = 'rate_limit' | 'timeout' | 'server_error' | 'auth' | 'network'

export interface LlmRetryEventData {
  requestId?: string
  attempt: number
  errorClass: LlmRetryErrorClass
  retryAfterMs?: number
  member?: string
}

export type ModelSelectionTrigger = 'init' | 'user_command' | 'fallback' | 'reload' | 'route'

export interface ModelSelectionEventData {
  from?: string
  to: {
    label: string
    provider?: string
    modelId?: string
    poolMembers?: string[]
  }
  trigger: ModelSelectionTrigger
  detail?: Record<string, unknown>
  requestId?: string
  turnIndex?: number
}

export interface JobRegisterEventData {
  jobId: string
  toolUseId?: string
  toolName: string
  timeoutMs?: number
  turnIndex?: number
}

export interface JobSettledEventData {
  jobId: string
  status: 'completed' | 'failed' | 'timeout'
  durationMs?: number
  evidence?: ToolEvidence
  deliveredAs?: { messageIndex: number; source: string }
}

export interface SubagentSpawnEventData {
  childSessionId: string
  name?: string
  role?: string
  spawnedByRequestId?: string
  /** 子代理事件文件相对路径(相对 logs 根) */
  logFile: string
}

export type CompactionBlockLifecycle = 'created' | 'reused' | 'superseded'

export interface CompactionBlockEventData {
  /** 权威:全量 blocks 数组(与 DB 快照语义一致) */
  blocks: TimelineCompactionBlock[]
  /** 诊断:本次变化的块与生命周期 */
  changed?: { blockId: string; lifecycle: CompactionBlockLifecycle }
  strategy?: 'episode' | 'deterministic_fallback'
  validation?: { status: 'passed' | 'failed'; errors?: string[] }
}

export interface CompactionPruneEventData {
  toolUseId: string
  from: { chars: number; hash: string }
  to: { chars: number; mode: 'artifact_ref' | 'truncated' }
  evidence?: ToolEvidence
}

export interface CompactionSummaryEventData {
  scope: 'loop_only'
  summary: string
  budgetTokens?: number
}

export type TaskClosureAction = 'finish' | 'continue' | 'block'

/** 任务结束判断开始评估 */
export interface ClosureStartEventData {
  turnIndex?: number
  requestId?: string
  model?: string
  /** 评估开始时事件流最后一条 seq(本 turn 消息尚未持久化,其事件 seq 均大于 baseSeq) */
  baseSeq?: number
  /** 分类器输入的消息数(含注入前缀的 loop 消息) */
  messageCount?: number
}

/** 任务结束判断决策结果(action=discarded 表示决策因排队消息被丢弃,原决策在 detail) */
export interface ClosureEndEventData {
  turnIndex?: number
  requestId?: string
  action: TaskClosureAction | 'discarded'
  reason?: string
  model?: string
  assistantMessageId?: string
  durationMs?: number
  detail?: Record<string, unknown>
}

/** 请求声明的工具集(名字列表+hash;完整定义可由代码版本推导) */
export interface ToolsSetEventData {
  hash: string
  toolNames: string[]
  count: number
}

/** reasoning effort 变更(/think 等入口) */
export interface ParamsReasoningEventData {
  from?: string
  to?: string
}

/** 系统提示词快照:内容变更时发射(model-visible 输入的一部分) */
export interface SystemPromptEventData {
  hash: string
  chars: number
  promptMode?: string
  content: string
}

export type MemoryRetrievalLayer = 'layer1' | 'layer2'

/** memory 检索决策开始(检索 agent 侧循环) */
export interface MemoryRetrievalStartEventData {
  layer: MemoryRetrievalLayer
  turnIndex?: number
}

/** memory 检索决策结束:queries/候选/选中与是否注入 */
export interface MemoryRetrievalEndEventData {
  layer: MemoryRetrievalLayer
  turnIndex?: number
  status: 'injected' | 'skipped' | 'failed'
  queries: string[]
  searchCount?: number
  selected: Array<{ id: string; title?: string; score?: number }>
  durationMs?: number
  usage?: Record<string, number>
  error?: string
}

/** memory 工具写入成功(create/update/fold)的语义化记录 */
export interface MemoryRecordedEventData {
  action: 'create' | 'update'
  memoryId?: string
  memoryType?: string
  title?: string
  toolUseId?: string
}

interface SessionEventBase {
  seq: number
  ts: string
}

export interface SessionHeaderEvent extends SessionEventBase {
  type: 'session'
  data: SessionEventData
}

export interface TurnStartEvent extends SessionEventBase {
  type: 'turn/start'
  data: TurnStartEventData
}

export interface TurnEndEvent extends SessionEventBase {
  type: 'turn/end'
  data: TurnEndEventData
}

export interface CheckpointEvent extends SessionEventBase {
  type: 'checkpoint'
  data: CheckpointEventData
}

export interface SessionArchiveEvent extends SessionEventBase {
  type: 'session/archive'
  data: SessionArchiveEventData
}

export interface UserMessageEvent extends SessionEventBase {
  type: 'user/message'
  data: UserMessageEventData
}

export interface AssistantMessageEvent extends SessionEventBase {
  type: 'assistant/message'
  data: AssistantMessageEventData
}

export interface MessagesTruncateEvent extends SessionEventBase {
  type: 'messages/truncate'
  data: MessagesTruncateEventData
}

export interface InjectionContextEvent extends SessionEventBase {
  type: 'injection/context'
  data: InjectionContextEventData
}

export interface InboxEnqueuedEvent extends SessionEventBase {
  type: 'agent/inbox/enqueued'
  data: InboxEnqueuedEventData
}

export interface InboxDrainedEvent extends SessionEventBase {
  type: 'agent/inbox/drained'
  data: InboxDrainedEventData
}

export interface InboxSplicedEvent extends SessionEventBase {
  type: 'agent/inbox/spliced'
  data: InboxSplicedEventData
}

export interface StepStartEvent extends SessionEventBase {
  type: 'step/start'
  data: StepStartEventData
}

export interface StepEndEvent extends SessionEventBase {
  type: 'step/end'
  data: StepEndEventData
}

export interface ToolCallEvent extends SessionEventBase {
  type: 'tool/call'
  data: ToolCallEventData
}

export interface ToolResultEvent extends SessionEventBase {
  type: 'tool/result'
  data: ToolResultEventData
}

export interface LlmRetryEvent extends SessionEventBase {
  type: 'llm/retry'
  data: LlmRetryEventData
}

export interface ModelSelectionEvent extends SessionEventBase {
  type: 'model/selection'
  data: ModelSelectionEventData
}

export interface JobRegisterEvent extends SessionEventBase {
  type: 'job/register'
  data: JobRegisterEventData
}

export interface JobSettledEvent extends SessionEventBase {
  type: 'job/settled'
  data: JobSettledEventData
}

export interface SubagentSpawnEvent extends SessionEventBase {
  type: 'subagent/spawn'
  data: SubagentSpawnEventData
}

export interface CompactionBlockEvent extends SessionEventBase {
  type: 'compaction/block'
  data: CompactionBlockEventData
}

export interface CompactionPruneEvent extends SessionEventBase {
  type: 'compaction/prune'
  data: CompactionPruneEventData
}

export interface CompactionSummaryEvent extends SessionEventBase {
  type: 'compaction/summary'
  data: CompactionSummaryEventData
}

export interface ClosureStartEvent extends SessionEventBase {
  type: 'closure/start'
  data: ClosureStartEventData
}

export interface ClosureEndEvent extends SessionEventBase {
  type: 'closure/end'
  data: ClosureEndEventData
}

export interface MemoryRetrievalStartEvent extends SessionEventBase {
  type: 'memory/retrieval/start'
  data: MemoryRetrievalStartEventData
}

export interface MemoryRetrievalEndEvent extends SessionEventBase {
  type: 'memory/retrieval/end'
  data: MemoryRetrievalEndEventData
}

export interface MemoryRecordedEvent extends SessionEventBase {
  type: 'memory/recorded'
  data: MemoryRecordedEventData
}

export interface SystemPromptEvent extends SessionEventBase {
  type: 'system/prompt'
  data: SystemPromptEventData
}

export interface ToolsSetEvent extends SessionEventBase {
  type: 'tools/set'
  data: ToolsSetEventData
}

export interface ParamsReasoningEvent extends SessionEventBase {
  type: 'params/reasoning'
  data: ParamsReasoningEventData
}

export type SessionEvent =
  | SessionHeaderEvent
  | TurnStartEvent
  | TurnEndEvent
  | CheckpointEvent
  | SessionArchiveEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | MessagesTruncateEvent
  | InjectionContextEvent
  | InboxEnqueuedEvent
  | InboxDrainedEvent
  | InboxSplicedEvent
  | StepStartEvent
  | StepEndEvent
  | ToolCallEvent
  | ToolResultEvent
  | LlmRetryEvent
  | ModelSelectionEvent
  | JobRegisterEvent
  | JobSettledEvent
  | SubagentSpawnEvent
  | CompactionBlockEvent
  | CompactionPruneEvent
  | CompactionSummaryEvent
  | ClosureStartEvent
  | ClosureEndEvent
  | MemoryRetrievalStartEvent
  | MemoryRetrievalEndEvent
  | MemoryRecordedEvent
  | SystemPromptEvent
  | ToolsSetEvent
  | ParamsReasoningEvent

export type SessionEventType = SessionEvent['type']

/** surface 事件:canonical 投影的折叠源 */
export const SURFACE_EVENT_TYPES = new Set<SessionEventType>([
  'user/message',
  'assistant/message',
  'messages/truncate',
  'compaction/block',
])

/** 追加 canonical 消息的事件 */
export type MessageAppendEvent = UserMessageEvent | AssistantMessageEvent

export function isMessageAppendEvent(event: SessionEvent): event is MessageAppendEvent {
  return event.type === 'user/message' || event.type === 'assistant/message'
}

/** 不带 seq/ts 的事件载荷,写入时由 store 统一分配 */
export type SessionEventInput = Omit<SessionEvent, 'seq' | 'ts'>

export interface SessionEventProjection {
  messages: Message[]
  blocks: TimelineCompactionBlock[]
  /** 最后一条事件 seq;空文件为 -1 */
  lastSeq: number
  header: SessionEventData | null
}

/** 事件文件级不变式校验结果 */
export interface SessionEventFileCheck {
  ok: boolean
  error?: string
  events: SessionEvent[]
}
