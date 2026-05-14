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
                tokenUsage={item.tokenUsage}
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
                tokenUsage={item.tokenUsage}
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
                evidence={item.evidence}
                isError={item.isError}
                status={item.status}
                durationMs={item.durationMs}
                createdAt={item.createdAt}
                tokenUsage={item.tokenUsage}
                resultTokenUsage={item.resultTokenUsage}
                selected={selectedToolId === item.id}
                onSelect={(id) => onSelectTool(selectedToolId === id ? null : id)}
              />
            )
          case 'compaction-block':
            return <CompactionBlock key={item.id} item={item} />
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
    case 'compaction-block':
      return `compaction-${item.id}`
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

function CompactionBlock({ item }: { item: Extract<TimelineItem, { type: 'compaction-block' }> }) {
  return (
    <div
      data-testid="timeline-compaction-block"
      className="rounded-[18px] border border-sky-300/20 bg-sky-300/[0.06] px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ArrowsClockwise size={14} weight="bold" className="text-sky-300" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-sky-300">
          Compaction Block
        </span>
        <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
          {item.coveredMessageCount} messages
        </span>
        <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
          gen {item.generation}
        </span>
        <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
          {formatTime(item.updatedAt)}
        </span>
      </div>
      <div className="mt-2 grid gap-2 text-[11px] font-mono text-[var(--color-text-disabled)] md:grid-cols-2">
        <div>
          range {item.coveredRange.startMessageId}..{item.coveredRange.endMessageId}
        </div>
        <div>strategy {item.strategyVersion}</div>
        <div>trace context_compaction block_id={item.id}</div>
        <div>
          evidence {item.evidenceCount} refs / {item.evidenceChars.toLocaleString()} chars
        </div>
      </div>
      <div className="mt-3 rounded-lg border border-white/10 bg-black/15 p-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-disabled)]">
          Summary
        </div>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-[var(--color-text-secondary)]">
          {item.summary}
        </pre>
      </div>
      <div className="mt-3 rounded-lg border border-white/10 bg-black/15 p-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-disabled)]">
          Working State
        </div>
        <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-[var(--color-text-secondary)]">
          {item.workingStateSummary}
        </pre>
      </div>
      <details className="mt-3 rounded-lg border border-white/10 bg-black/10 p-3">
        <summary className="cursor-pointer text-[11px] font-semibold text-[var(--color-text-secondary)]">
          Covered Messages ({item.coveredMessages.length})
        </summary>
        <div className="mt-3 space-y-2">
          {item.coveredMessages.map((message) => (
            <CoveredMessage key={message.id} message={message} />
          ))}
        </div>
      </details>
    </div>
  )
}

function CoveredMessage({
  message,
}: {
  message: Extract<TimelineItem, { type: 'compaction-block' }>['coveredMessages'][number]
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2">
      <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono text-[var(--color-text-disabled)]">
        <span>{message.role}</span>
        <span>{message.messageType}</span>
        <span>{formatTime(message.createdAt)}</span>
        <span>{message.id}</span>
      </div>
      <div className="mt-2 space-y-1 text-[11px] leading-5 text-[var(--color-text-secondary)]">
        {message.content.map((block, index) => (
          <div key={`${message.id}-${index}`}>{formatCoveredBlock(block)}</div>
        ))}
      </div>
    </div>
  )
}

function formatCoveredBlock(block: Record<string, unknown>): string {
  if (block.type === 'text') return String(block.text ?? '')
  if (block.type === 'tool_use') {
    return `tool_use ${String(block.name ?? 'tool')} id=${String(block.id ?? 'unknown')}`
  }
  if (block.type === 'tool_result') {
    const evidence = block.evidence as { path?: unknown } | undefined
    const summary = String(block.outputSummary ?? block.content ?? '').slice(0, 240)
    return `tool_result id=${String(block.toolUseId ?? 'unknown')} ${summary}${
      evidence?.path ? ` evidence=${String(evidence.path)}` : ''
    }`
  }
  if (block.type === 'image') return `image ${String(block.mediaType ?? 'unknown')}`
  if (block.type === 'thinking') return 'thinking block'
  return String(block.type ?? 'content')
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
