import { ArrowsClockwise, Warning } from '@phosphor-icons/react'
import { formatTime } from '../../lib/format'
import { AgentMessageBlock } from './AgentMessageBlock'
import { DecisionBlock } from './DecisionBlock'
import { MemoryNudgeBlock } from './MemoryNudgeBlock'
import { MemoryRetrievalBlock } from './MemoryRetrievalBlock'
import { SubAgentBlock } from './SubAgentBlock'
import { TaskClosureBlock } from './TaskClosureBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { UserMessageBlock } from './UserMessageBlock'
import type { MemoryRetrievalRequestLike } from './memory-retrieval'
import type { TimelineItem } from './timeline'

interface Props {
  sessionId?: string
  items: TimelineItem[]
  llmRequests?: MemoryRetrievalRequestLike[]
  selectedToolId: string | null
  selectedDecisionId: string | null
  selectedTaskClosureId: string | null
  selectedMemoryNudgeId?: string | null
  selectedSubAgentId?: string | null
  highlightedAssistantMessageId?: string | null
  highlightedSubAgentId?: string | null
  onSelectTool: (id: string | null) => void
  onSelectDecision: (id: string | null) => void
  onSelectTaskClosure: (id: string | null) => void
  onSelectMemoryNudge?: (id: string | null) => void
  onSelectSubAgent?: (id: string | null) => void
}

export function TimelineView({
  sessionId,
  items,
  llmRequests = [],
  selectedToolId,
  selectedDecisionId,
  selectedTaskClosureId,
  selectedMemoryNudgeId,
  selectedSubAgentId,
  highlightedAssistantMessageId,
  highlightedSubAgentId,
  onSelectTool,
  onSelectDecision,
  onSelectTaskClosure,
  onSelectMemoryNudge,
  onSelectSubAgent,
}: Props) {
  return (
    <div data-testid="session-timeline" className="space-y-3">
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
                createdAt={item.createdAt}
                highlighted={highlightedAssistantMessageId === item.messageId}
              />
            )
          case 'tool-call':
            return (
              <ToolCallBlock
                sessionId={sessionId}
                key={item.id}
                id={item.id}
                name={item.name}
                input={item.input}
                result={item.result}
                summary={item.summary}
                contentItems={item.contentItems}
                isError={item.isError}
                status={item.status}
                durationMs={item.durationMs}
                createdAt={item.createdAt}
                selected={selectedToolId === item.id}
                onSelect={(id) => onSelectTool(selectedToolId === id ? null : id)}
              />
            )
          case 'decision':
            if (item.decisionType === 'memory_retrieval') {
              return (
                <MemoryRetrievalBlock
                  key={item.id}
                  id={item.id}
                  outcome={item.outcome}
                  detail={item.detail}
                  rationale={item.rationale}
                  durationMs={item.durationMs}
                  createdAt={item.createdAt}
                  selected={selectedDecisionId === item.id}
                  llmRequests={llmRequests}
                  onSelect={(id) => onSelectDecision(selectedDecisionId === id ? null : id)}
                />
              )
            }
            return (
              <DecisionBlock
                key={item.id}
                id={item.id}
                decisionType={item.decisionType}
                outcome={item.outcome}
                detail={item.detail}
                createdAt={item.createdAt}
                selected={selectedDecisionId === item.id}
                onSelect={(id) => onSelectDecision(selectedDecisionId === id ? null : id)}
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
                createdAt={item.createdAt}
                selected={selectedTaskClosureId === item.id}
                onSelect={(id) => onSelectTaskClosure(selectedTaskClosureId === id ? null : id)}
              />
            )
          case 'memory-nudge':
            return (
              <MemoryNudgeBlock
                key={item.id}
                id={item.id}
                prompt={item.prompt}
                createdAt={item.createdAt}
                source={item.source}
                iteration={item.iteration}
                memoryWritten={item.memoryWritten}
                durationMs={item.durationMs}
                status={item.status}
                relatedToolCalls={item.relatedToolCalls}
                selected={selectedMemoryNudgeId === item.id}
                selectedChildToolId={selectedToolId}
                onSelect={(id) => onSelectMemoryNudge?.(selectedMemoryNudgeId === id ? null : id)}
                onSelectChildTool={(toolId) =>
                  onSelectTool(selectedToolId === toolId ? null : toolId)
                }
              />
            )
          case 'sub-agent':
            return (
              <SubAgentBlock
                key={`sub-agent-${item.agentId}`}
                agentId={item.agentId}
                label={item.label}
                agentRole={item.role}
                model={item.model}
                instruction={item.instruction}
                status={item.status}
                output={item.output}
                durationMs={item.durationMs}
                createdAt={item.createdAt}
                childToolCalls={item.childToolCalls}
                traceSpan={item.traceSpan}
                selected={selectedSubAgentId === item.agentId}
                highlighted={highlightedSubAgentId === item.agentId}
                selectedChildToolId={selectedToolId}
                onSelect={(agentId) =>
                  onSelectSubAgent?.(selectedSubAgentId === agentId ? null : agentId)
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
                createdAt={item.createdAt}
                label={item.label}
                chips={item.chips}
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
    case 'decision':
      return `decision-${item.id}`
    case 'task-closure':
      return `task-closure-${item.id}`
    case 'memory-nudge':
      return `memory-nudge-${item.id}`
    case 'sub-agent':
      return `sub-agent-${item.agentId}`
    case 'system-event':
      return `event-${item.createdAt}-${item.variant}-${item.text.slice(0, 32)}`
  }
}

function SystemEventBanner({
  variant,
  text,
  createdAt,
  label,
  chips = [],
}: {
  variant: 'warning' | 'info'
  text: string
  createdAt: string
  label?: string
  chips?: string[]
}) {
  const isWarning = variant === 'warning'
  const Icon = isWarning ? Warning : ArrowsClockwise
  const accentClass = isWarning ? 'text-amber-300' : 'text-cyan-300'
  const surfaceClass = isWarning
    ? 'border-amber-400/25 bg-amber-400/8'
    : 'border-cyan-400/20 bg-cyan-400/7'

  return (
    <div className={`rounded-[18px] border px-4 py-3 ${surfaceClass}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon size={14} weight="bold" className={accentClass} />
        <span className={`text-[10px] font-semibold uppercase tracking-[0.18em] ${accentClass}`}>
          {label ?? (variant === 'warning' ? 'Runtime Warning' : 'System Event')}
        </span>
        <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
          {formatTime(createdAt)}
        </span>
        {chips.map((chip) => (
          <span
            key={chip}
            className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[9px] font-mono text-[var(--color-text-disabled)]"
          >
            {chip}
          </span>
        ))}
      </div>
      <div className="mt-2 text-[12px] font-mono leading-6 text-[var(--color-text-secondary)]">
        {text}
      </div>
    </div>
  )
}

export type {
  DecisionTimelineItem,
  TimelineItem,
  Message,
  SessionDecisionEvent,
  SessionTaskClosureEvent,
  TaskClosureTimelineItem,
  TraceSpan,
} from './timeline'
export { buildTimeline, extractFilesTouched } from './timeline'
