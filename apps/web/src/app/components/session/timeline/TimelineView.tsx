import { ArrowsClockwise, Brain, Robot, User, Warning } from '@phosphor-icons/react'
import { formatTime } from '../../../lib/format'
import { TokenUsagePill } from '../TokenUsagePill'
import { ToolCallBlock } from '../ToolCallBlock'
import type { TokenUsageSummary } from '../context-panel/context-tokens'
import { MemoryNudgeBlock } from '../memory/MemoryNudgeBlock'
import { MemoryRetrievalBlock } from '../memory/MemoryRetrievalBlock'
import type { MemoryRetrievalRequestLike } from '../memory/memory-retrieval'
import { SubAgentBlock } from './SubAgentBlock'
import {
  DecisionThinkingList,
  decisionThinkingChips,
  getDecisionPreviewText,
} from './ThinkingDecisionList'
import type { DecisionTimelineItem, TimelineItem } from './timeline'

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
                thinking={item.thinking}
                selectedDecisionId={selectedDecisionId}
                onSelectDecision={onSelectDecision}
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
            return <TimelineCompactionBlock key={item.id} item={item} />
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
                decisions={item.decisions}
                selectedDecisionId={selectedDecisionId}
                onSelectDecision={onSelectDecision}
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
              <TimelineSystemEventBanner
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

function TimelineCompactionBlock({
  item,
}: {
  item: Extract<TimelineItem, { type: 'compaction-block' }>
}) {
  return (
    <details
      data-testid="timeline-compaction-block"
      className="rounded-[14px] border border-sky-300/20 bg-sky-300/[0.05] px-3 py-2"
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-2">
        <ArrowsClockwise size={14} weight="bold" className="text-sky-300" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-sky-300">
          context_compaction
        </span>
        <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
          messages {item.coveredMessageCount}
        </span>
        <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
          gen {item.generation}
        </span>
        {(item.topics?.length ?? 0) > 0 && (
          <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
            {item.topics?.length ?? 0} topics
          </span>
        )}
        <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
          {item.strategyVersion}
        </span>
        <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
          {formatTime(item.updatedAt)}
        </span>
      </summary>
      <div className="mt-2 space-y-2 text-[11px] font-mono text-[var(--color-text-disabled)]">
        <div>
          range {item.coveredRange.startMessageId}..{item.coveredRange.endMessageId}
        </div>
        <div>
          evidence {item.evidenceCount} refs / {item.evidenceChars.toLocaleString()} chars
        </div>
        {item.model?.usedModel && <div>model {item.model.usedModel}</div>}
      </div>
      <div className="mt-2 rounded-lg border border-white/10 bg-black/15 p-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-disabled)]">
          Summary
        </div>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-[var(--color-text-secondary)]">
          {item.summary}
        </pre>
      </div>
      <div className="mt-2 rounded-lg border border-white/10 bg-black/15 p-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-disabled)]">
          Working State
        </div>
        <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-[var(--color-text-secondary)]">
          {item.workingStateSummary}
        </pre>
      </div>
      {(item.topics?.length ?? 0) > 0 && (
        <details className="mt-2 rounded-lg border border-white/10 bg-black/10 p-3">
          <summary className="cursor-pointer text-[11px] font-semibold text-[var(--color-text-secondary)]">
            Topics ({item.topics?.length ?? 0})
          </summary>
          <div className="mt-2 space-y-2">
            {(item.topics ?? []).map((topic) => (
              <div key={topic.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-2">
                <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono text-[var(--color-text-disabled)]">
                  <span>{topic.id}</span>
                  <span>{topic.status}</span>
                  <span>
                    messages {topic.sourceMessageRefs.join(',') || topic.sourceMessageIds.length}
                  </span>
                  <span>tools {topic.toolRefs.join(',') || topic.toolUseIds.length}</span>
                </div>
                <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
                  {topic.title}
                </div>
                <div className="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">
                  {topic.summary}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </details>
  )
}

interface AgentMessageBlockProps {
  messageId?: string
  text: string
  model?: string
  createdAt?: string
  highlighted?: boolean
  tokenUsage?: TokenUsageSummary
  thinking?: DecisionTimelineItem[]
  selectedDecisionId?: string | null
  onSelectDecision?: (id: string | null) => void
}

function AgentMessageBlock({
  messageId,
  text,
  model,
  createdAt,
  highlighted = false,
  tokenUsage,
  thinking,
  selectedDecisionId = null,
  onSelectDecision,
}: AgentMessageBlockProps) {
  return (
    <div
      data-assistant-message-id={messageId}
      className={`overflow-hidden rounded-[22px] border px-4 py-4 ${
        highlighted
          ? 'border-cyan-400/45 bg-cyan-400/8 ring-1 ring-cyan-400/35'
          : 'border-white/8 bg-[linear-gradient(135deg,rgba(18,24,34,0.92),rgba(12,14,20,0.86))]'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-cyan-400/15 bg-cyan-400/10">
          <Robot size={16} weight="bold" className="text-[var(--color-accent)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200/90">
              Assistant
            </span>
            {model && (
              <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-secondary)]">
                {model}
              </span>
            )}
            {createdAt && (
              <span className="text-[10px] font-mono text-[var(--color-text-disabled)]">
                {formatTime(createdAt)}
              </span>
            )}
            <TokenUsagePill usage={tokenUsage} tone="accent" />
          </div>
          {thinking !== undefined && thinking.length > 0 ? (
            <details
              data-testid="assistant-thinking"
              className="mb-2 rounded-[14px] border border-violet-400/15 bg-violet-400/[0.04]"
            >
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-1.5">
                <Brain size={13} weight="bold" className="text-violet-300" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-300">
                  Thinking
                </span>
                {decisionThinkingChips(thinking).map((chip) => (
                  <span
                    key={chip}
                    className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]"
                  >
                    {chip}
                  </span>
                ))}
              </summary>
              <div className="border-t border-white/[0.06] px-2 py-2">
                <DecisionThinkingList
                  decisions={thinking}
                  selectedDecisionId={selectedDecisionId}
                  onSelectDecision={onSelectDecision}
                />
              </div>
            </details>
          ) : null}
          {text.trim().length > 0 ? (
            <p className="text-[13px] leading-6 text-slate-100 whitespace-pre-wrap">{text}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

interface UserMessageBlockProps {
  text: string
  queued?: boolean
  images?: Array<{ mediaType: string; data?: string; imageRef?: ImageRefPointer }>
  createdAt: string
  tokenUsage?: TokenUsageSummary
}

interface ImageRefPointer {
  path?: string
  relativePath?: string
  sha256?: string
  bytes?: number
}

function UserMessageBlock({
  text,
  queued = false,
  images,
  createdAt,
  tokenUsage,
}: UserMessageBlockProps) {
  const hasImages = Boolean(images && images.length > 0)
  const displayText = hasImages ? stripImagePlaceholders(text) : text
  const showText = displayText.trim().length > 0

  return (
    <div className="overflow-hidden rounded-[22px] border border-cyan-400/18 bg-[linear-gradient(135deg,rgba(34,211,238,0.14),rgba(13,17,24,0.92))] px-4 py-4 shadow-[0_18px_40px_rgba(0,0,0,0.2)]">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-400/12">
          <User size={16} weight="bold" className="text-cyan-200" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-100/90">
              User Prompt
            </span>
            {queued && (
              <span className="inline-flex items-center rounded-full border border-cyan-300/30 bg-cyan-300/10 px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.16em] text-cyan-200">
                Queued
              </span>
            )}
            <span className="text-[10px] font-mono text-cyan-100/55">{formatTime(createdAt)}</span>
            <TokenUsagePill usage={tokenUsage} />
          </div>
          {showText && (
            <p className="text-[13px] leading-6 text-[var(--color-text-primary)] whitespace-pre-wrap">
              {displayText}
            </p>
          )}
          {images?.map((image, index) =>
            image.data ? (
              <img
                key={`${image.mediaType}-${index}`}
                src={`data:${image.mediaType};base64,${image.data}`}
                alt={`User upload ${index + 1}`}
                className="max-h-72 rounded-md border border-white/10 object-contain bg-black/20"
              />
            ) : (
              <div
                key={`${image.mediaType}-${index}-${image.imageRef?.sha256 ?? 'ref'}`}
                className="rounded-md border border-white/10 bg-black/20 px-3 py-2 font-mono text-[11px] text-cyan-100/65"
              >
                {image.imageRef?.relativePath ?? image.imageRef?.path ?? image.mediaType}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  )
}

function stripImagePlaceholders(text: string): string {
  return text
    .replace(/^\s*\[(?:图片|Image(?:\s*#?\d+)?)\]\s*$/gim, '')
    .replace(/(?:\r?\n){3,}/g, '\n\n')
    .trim()
}

interface DecisionBlockProps {
  id: string
  decisionType: DecisionTimelineItem['decisionType']
  outcome: string
  detail?: Record<string, unknown>
  createdAt?: string
  selected?: boolean
  onSelect?: (id: string) => void
}

function DecisionBlock({
  id,
  decisionType,
  outcome,
  detail,
  createdAt,
  selected,
  onSelect,
}: DecisionBlockProps) {
  const previewText = getDecisionPreviewText(decisionType, outcome, detail)

  return (
    <button
      type="button"
      data-decision-id={id}
      aria-pressed={selected}
      onClick={() => onSelect?.(id)}
      className={`w-full rounded-[20px] border px-4 py-3 text-left ${
        selected
          ? 'border-[var(--color-accent)]/35 bg-cyan-400/8 ring-1 ring-cyan-400/20'
          : 'border-white/[0.06] bg-[linear-gradient(135deg,rgba(17,25,36,0.92),rgba(11,15,24,0.82))] hover:border-white/12 hover:bg-white/[0.04]'
      }`}
    >
      <div className="flex items-center gap-2">
        <ArrowsClockwise size={14} weight="bold" className="text-cyan-400" />
        <span className="text-[11px] font-mono font-semibold uppercase tracking-[0.16em] text-cyan-300">
          {decisionType}
        </span>
        {createdAt && (
          <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
            {formatTime(createdAt)}
          </span>
        )}
        <span className="flex-1" />
        <span className="rounded px-1.5 py-0.5 text-[10px] font-mono bg-cyan-400/10 text-cyan-300">
          {outcome}
        </span>
      </div>
      <p className="mt-2 text-[12px] font-mono text-[var(--color-text-muted)] truncate">
        {previewText}
      </p>
    </button>
  )
}

interface TaskClosureBlockProps {
  id: string
  event: 'task_closure_decision' | 'task_closure_failed'
  action?: 'finish' | 'continue' | 'block'
  reason: string
  error?: string
  createdAt?: string
  selected?: boolean
  onSelect?: (id: string) => void
}

function TaskClosureBlock({
  id,
  event,
  action,
  reason,
  error,
  createdAt,
  selected,
  onSelect,
}: TaskClosureBlockProps) {
  const isWarning = event === 'task_closure_failed' || action === 'block'
  const Icon = isWarning ? Warning : ArrowsClockwise
  const accentClass = isWarning ? 'text-amber-400' : 'text-cyan-400'
  const badgeClass = isWarning ? 'bg-amber-400/10 text-amber-300' : 'bg-cyan-400/10 text-cyan-300'
  const previewLabel = event === 'task_closure_failed' ? 'failed' : (action ?? 'decision')
  const previewText = `${previewLabel}: ${reason}`
  const detailText = error ? `${previewText} · ${error}` : previewText

  return (
    <button
      type="button"
      data-task-closure-id={id}
      aria-pressed={selected}
      onClick={() => onSelect?.(id)}
      className={`w-full rounded-[20px] border px-4 py-3 text-left ${
        selected
          ? 'border-[var(--color-accent)]/35 bg-cyan-400/8 ring-1 ring-cyan-400/20'
          : 'border-white/[0.06] bg-[linear-gradient(135deg,rgba(22,20,16,0.92),rgba(11,15,24,0.84))] hover:border-white/12 hover:bg-white/[0.04]'
      }`}
    >
      <div className="flex items-center gap-2">
        <Icon size={14} weight="bold" className={accentClass} />
        <span
          className={`text-[11px] font-mono font-semibold uppercase tracking-[0.16em] ${accentClass}`}
        >
          {event}
        </span>
        {createdAt && (
          <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
            {formatTime(createdAt)}
          </span>
        )}
        <span className="flex-1" />
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${badgeClass}`}>
          {previewLabel}
        </span>
      </div>
      <p className="mt-2 text-[12px] font-mono text-[var(--color-text-muted)] truncate">
        {detailText}
      </p>
    </button>
  )
}

function TimelineSystemEventBanner({
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

export type {
  DecisionTimelineItem,
  Message,
  SessionDecisionEvent,
  SessionTaskClosureEvent,
  TaskClosureTimelineItem,
  TimelineItem,
  TraceSpan,
} from './timeline'
export { buildTimeline, extractFilesTouched } from './timeline'
