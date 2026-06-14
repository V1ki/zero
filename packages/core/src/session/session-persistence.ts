import type { SessionDB } from '@zero-os/observe'
import type { Message, Session as SessionData, TimelineCompactionBlock } from '@zero-os/shared'
import type { AgentConfig } from '../agent/agent'

export interface PersistSessionMetadataOptions {
  sessionDb?: SessionDB
  data: SessionData
  agentConfig?: AgentConfig | null
  systemPrompt?: string
}

export interface PersistSessionStateOptions extends PersistSessionMetadataOptions {
  messages: Message[]
  timelineCompactionBlocks: TimelineCompactionBlock[]
}

export interface PersistableSessionSnapshot {
  readonly data: SessionData
  getAgentConfig(): AgentConfig | null
  getSystemPrompt(): string
  getMessages(): Message[]
  getTimelineCompactionBlocks(): TimelineCompactionBlock[]
}

export function persistSessionMetadata(options: PersistSessionMetadataOptions): void {
  const { sessionDb, data, agentConfig, systemPrompt } = options
  sessionDb?.saveSession(data, serializeAgentConfig(agentConfig), systemPrompt)
}

export function persistSessionState(options: PersistSessionStateOptions): void {
  const { sessionDb, data, messages, timelineCompactionBlocks } = options
  sessionDb?.saveMessages(data.id, messages)
  sessionDb?.saveCompactionBlocks(data.id, timelineCompactionBlocks)
  persistSessionMetadata(options)
}

export function persistSessionSnapshot(
  sessionDb: SessionDB,
  session: PersistableSessionSnapshot,
): void {
  persistSessionState({
    sessionDb,
    data: session.data,
    agentConfig: session.getAgentConfig(),
    systemPrompt: session.getSystemPrompt() || undefined,
    messages: session.getMessages(),
    timelineCompactionBlocks: session.getTimelineCompactionBlocks(),
  })
}

function serializeAgentConfig(agentConfig?: AgentConfig | null): string | undefined {
  return agentConfig ? JSON.stringify(agentConfig) : undefined
}
