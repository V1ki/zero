import { createHash } from 'node:crypto'
import type { SessionDB, SessionEventStore } from '@zero-os/observe'
import type {
  ContextCheckpoint,
  Message,
  Session as SessionData,
  TimelineCompactionBlock,
} from '@zero-os/shared'
import { SESSION_EVENT_SCHEMA_VERSION } from '@zero-os/shared'
import type { AgentConfig } from '../agent/agent'

export interface PersistSessionMetadataOptions {
  sessionDb?: SessionDB
  sessionEvents?: SessionEventStore
  sessionEventsOnly?: boolean
  data: SessionData
  agentConfig?: AgentConfig | null
  systemPrompt?: string
}

export interface PersistSessionStateOptions extends PersistSessionMetadataOptions {
  messages: Message[]
  timelineCompactionBlocks: TimelineCompactionBlock[]
  /** 事件流里的 compaction/checkpoint 由 agent 在压缩时写入;这里只同步 DB 行 */
  checkpoint: ContextCheckpoint | undefined
}

export interface PersistableSessionSnapshot {
  readonly data: SessionData
  getAgentConfig(): AgentConfig | null
  getSystemPrompt(): string
  getMessages(): Message[]
  getTimelineCompactionBlocks(): TimelineCompactionBlock[]
  getContextCheckpoint(): ContextCheckpoint | undefined
}

export function persistSessionMetadata(options: PersistSessionMetadataOptions): void {
  const { sessionDb, sessionEvents, data } = options
  ensureSessionEventHeader(sessionEvents, data)
  sessionDb?.saveSession(data, serializeAgentConfig(options.agentConfig), options.systemPrompt)
}

export function persistSessionState(options: PersistSessionStateOptions): void {
  const { sessionDb, sessionEvents, sessionEventsOnly, data, messages, timelineCompactionBlocks } =
    options
  ensureSessionEventHeader(sessionEvents, data)
  ensureSessionPromptEvent(sessionEvents, data.id, options.systemPrompt)
  // 事件流先写:崩溃窗口内事件流最多比 DB 新,恢复优先读事件流不会读到旧数据
  sessionEvents?.syncCanonical(data.id, { messages, blocks: timelineCompactionBlocks })
  // file-only 模式:DB 大字段是可重建的派生索引,不再写入
  if (sessionEventsOnly && sessionEvents) {
    persistSessionMetadata(options)
    return
  }
  sessionDb?.saveMessages(data.id, messages)
  sessionDb?.saveCompactionBlocks(data.id, timelineCompactionBlocks)
  sessionDb?.saveContextCheckpoint(data.id, options.checkpoint)
  persistSessionMetadata(options)
}

export function persistSessionSnapshot(
  sessionDb: SessionDB,
  session: PersistableSessionSnapshot,
  sessionEvents?: SessionEventStore,
  sessionEventsOnly?: boolean,
): void {
  persistSessionState({
    sessionDb,
    sessionEvents,
    sessionEventsOnly,
    data: session.data,
    agentConfig: session.getAgentConfig(),
    systemPrompt: session.getSystemPrompt() || undefined,
    messages: session.getMessages(),
    timelineCompactionBlocks: session.getTimelineCompactionBlocks(),
    checkpoint: session.getContextCheckpoint(),
  })
}

function ensureSessionEventHeader(
  sessionEvents: SessionEventStore | undefined,
  data: SessionData,
): void {
  sessionEvents?.ensureSession({
    v: 1,
    sessionId: data.id,
    schemaVersion: SESSION_EVENT_SCHEMA_VERSION,
    source: data.source,
    channelId: data.channelId,
    channelName: data.channelName,
  })
}

/**
 * 系统提示词是 model-visible 输入的一部分:内容变化时落一条 system/prompt 事件,
 * 事件流由此拥有完整的 prompt 谱系(DB 的 system_prompt 列只存最新一份)。
 */
function ensureSessionPromptEvent(
  sessionEvents: SessionEventStore | undefined,
  sessionId: string,
  systemPrompt: string | undefined,
): void {
  const content = systemPrompt?.trim()
  if (!sessionEvents || !content) return

  const hash = `sha256:${createHash('sha256').update(content).digest('hex')}`
  if (sessionEvents.getSystemPrompt(sessionId)?.hash === hash) return

  sessionEvents.append(sessionId, [
    {
      type: 'system/prompt',
      data: { hash, chars: content.length, content },
    },
  ])
}

function serializeAgentConfig(agentConfig?: AgentConfig | null): string | undefined {
  return agentConfig ? JSON.stringify(agentConfig) : undefined
}
