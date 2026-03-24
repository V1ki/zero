import { ArrowsClockwise, Warning } from '@phosphor-icons/react'
import { useMemo } from 'react'
import { AgentMessageBlock } from './AgentMessageBlock'
import { SubAgentBlock } from './SubAgentBlock'
import { TaskClosureBlock } from './TaskClosureBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { UserMessageBlock } from './UserMessageBlock'
import {
  type Message,
  type SessionTaskClosureEvent,
  type TimelineItem,
  type TraceSpan,
  buildTimeline,
} from './timeline'

interface Props {
  messages: Message[]
  traces?: TraceSpan[]
  taskClosureEvents?: SessionTaskClosureEvent[]
  selectedToolId: string | null
  selectedTaskClosureId: string | null
  selectedSubAgentId?: string | null
  highlightedAssistantMessageId?: string | null
  highlightedSubAgentId?: string | null
  onSelectTool: (id: string | null) => void
  onSelectTaskClosure: (id: string | null) => void
  onSelectSubAgent?: (id: string | null) => void
}

export function TimelineView({
  messages,
  traces,
  taskClosureEvents,
  selectedToolId,
  selectedTaskClosureId,
  highlightedAssistantMessageId,
  onSelectTool,
  onSelectTaskClosure,
}: Props) {
  const items = useMemo(
    () => buildTimeline(messages, traces, taskClosureEvents),
    [messages, traces, taskClosureEvents],
  )

  return (
    <div className="space-y-2">
      {items.map((item) => {
        switch (item.type) {
          case 'user-message':
            return (
              <UserMessageBlock
                key={getTimelineItemKey(item)}
                text={item.text}
                queued={item.queued}
                images={item.images}
                createdAt={item.createdAt}
              />
            )
          case 'agent-text':
            return (
              <AgentMessageBlock
                key={getTimelineItemKey(item)}
                messageId={item.messageId}
                text={item.text}
                model={item.model}
                highlighted={highlightedAssistantMessageId === item.messageId}
              />
            )
          case 'tool-call':
            return (
              <ToolCallBlock
                key={item.id}
                id={item.id}
                name={item.name}
                input={item.input}
                result={item.result}
                isError={item.isError}
                durationMs={item.durationMs}
                selected={selectedToolId === item.id}
                onSelect={(id) => onSelectTool(selectedToolId === id ? null : id)}
              />
            )
          case 'task-closure':
            return (
              <TaskClosureBlock
                key={item.id}
                id={item.id}
                event={item.event}
                action={item.action}
                reason={item.reason}
                error={item.error}
                selected={selectedTaskClosureId === item.id}
                onSelect={(id) => onSelectTaskClosure(selectedTaskClosureId === id ? null : id)}
              />
            )
          case 'sub-agent':
            return (
              <SubAgentBlock
                key={`sub-agent-${item.agentId}`}
                agentId={item.agentId}
                label={item.label}
                role={item.role}
                instruction={item.instruction}
                status={item.status}
                output={item.output}
                durationMs={item.durationMs}
                childToolCalls={item.childToolCalls}
                selected={selectedToolId === item.spawnToolCallId}
                selectedChildToolId={selectedToolId}
                onSelect={() =>
                  onSelectTool(
                    selectedToolId === item.spawnToolCallId ? null : item.spawnToolCallId,
                  )
                }
                onSelectChildTool={(toolId) =>
                  onSelectTool(selectedToolId === toolId ? null : toolId)
                }
              />
            )
          case 'system-event':
            return (
              <SystemEventBanner
                key={getTimelineItemKey(item)}
                variant={item.variant}
                text={item.text}
              />
            )
          default:
            return null
        }
      })}
    </div>
  )
}

function getTimelineItemKey(item: TimelineItem): string {
  switch (item.type) {
    case 'user-message':
      return `user-${item.queued ? 'queued' : 'live'}-${item.createdAt}-${item.text.slice(0, 32)}`
    case 'agent-text':
      return `assistant-${item.messageId}`
    case 'tool-call':
      return `tool-${item.id}`
    case 'task-closure':
      return `task-closure-${item.id}`
    case 'sub-agent':
      return `sub-agent-${item.agentId}`
    case 'system-event':
      return `event-${item.createdAt}-${item.variant}-${item.text.slice(0, 32)}`
  }
}

function SystemEventBanner({ variant, text }: { variant: 'warning' | 'info'; text: string }) {
  const isWarning = variant === 'warning'
  const Icon = isWarning ? Warning : ArrowsClockwise
  const borderColor = isWarning ? 'border-l-amber-400' : 'border-l-cyan-400'
  const iconColor = isWarning ? 'text-amber-400' : 'text-cyan-400'
  const textColor = isWarning ? 'text-amber-400' : 'text-cyan-400'

  return (
    <div className={`px-4 py-2 rounded-lg border-l-2 ${borderColor} bg-white/[0.02]`}>
      <div className="flex items-center gap-2">
        <Icon size={14} weight="bold" className={iconColor} />
        <span className={`text-[12px] font-mono ${textColor}`}>{text}</span>
      </div>
    </div>
  )
}

export type {
  TimelineItem,
  Message,
  SessionTaskClosureEvent,
  TaskClosureTimelineItem,
  TraceSpan,
} from './timeline'
export { buildTimeline, extractFilesTouched } from './timeline'
