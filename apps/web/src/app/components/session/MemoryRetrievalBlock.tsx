import * as React from 'react'
import { CaretDown, CaretRight, Database } from '@phosphor-icons/react'
import { formatCost, formatTime } from '../../lib/format'
import {
  type MemoryRetrievalRequestLike,
  type MemoryRetrievalSelectedMemory,
  getMemoryRetrievalSearchCount,
  getMemoryRetrievalSelectedCount,
  pickMemoryInjectionPreview,
  readMemoryRetrievalDetail,
} from './memory-retrieval'
import { MemoryDetailDialog } from './MemoryDetailDialog'

interface Props {
  id: string
  outcome: string
  detail?: Record<string, unknown>
  rationale?: string
  durationMs?: number
  createdAt?: string
  selected?: boolean
  llmRequests?: MemoryRetrievalRequestLike[]
  onSelect?: (id: string) => void
}

export function MemoryRetrievalBlock({
  id,
  outcome,
  detail,
  rationale,
  durationMs,
  createdAt,
  selected,
  llmRequests = [],
  onSelect,
}: Props) {
  const [viewingMemory, setViewingMemory] = React.useState<MemoryRetrievalSelectedMemory | null>(
    null,
  )
  const retrieval = readMemoryRetrievalDetail(detail)
  const injectionPreview = pickMemoryInjectionPreview(
    {
      outcome,
      createdAt: createdAt ?? '',
    },
    retrieval,
    llmRequests,
  )
  const preview = getPreviewText(outcome, retrieval)
  const searchCount = getMemoryRetrievalSearchCount(retrieval)
  const selectedCount = getMemoryRetrievalSelectedCount(retrieval)
  const handleSelect = () => onSelect?.(id)

  return (
    <div
      data-memory-retrieval-id={id}
      className={`overflow-hidden rounded-[20px] border ${
        selected
          ? 'border-[var(--color-accent)]/35 bg-emerald-400/8 ring-1 ring-emerald-400/20'
          : 'border-white/[0.06] bg-[linear-gradient(135deg,rgba(13,28,29,0.92),rgba(10,16,22,0.84))] hover:border-white/12 hover:bg-white/[0.04]'
      }`}
    >
      <button
        type="button"
        onClick={handleSelect}
        aria-expanded={selected}
        className="w-full text-left"
      >
        <div className="flex items-center gap-2 px-4 py-3">
          <Database size={14} weight="bold" className="text-emerald-300" />
          <span className="text-[11px] font-mono font-semibold uppercase tracking-[0.16em] text-emerald-300">
            memory_retrieval
          </span>
          {createdAt && (
            <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
              {formatTime(createdAt)}
            </span>
          )}
          {retrieval.layer === 'layer2' && (
            <span className="rounded-full border border-amber-400/20 bg-amber-400/8 px-2 py-0.5 text-[10px] font-mono text-amber-200">
              memory_hint
            </span>
          )}
          <span className="flex-1" />
          <OutcomeBadge outcome={outcome} />
          <span className="text-[var(--color-text-disabled)]">
            {selected ? <CaretDown size={12} /> : <CaretRight size={12} />}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
          <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-secondary)]">
            {searchCount} search{searchCount === 1 ? '' : 'es'}
          </span>
          <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-secondary)]">
            {selectedCount} selected
          </span>
          {durationMs !== undefined && (
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-secondary)]">
              {formatDuration(durationMs)}
            </span>
          )}
        </div>

        <div className="px-4 pb-3">
          <p className="text-[12px] font-mono text-[var(--color-text-muted)] truncate">{preview}</p>
        </div>
      </button>

      {selected && (
        <div className="space-y-3 border-t border-white/[0.06] px-4 py-3">
          {retrieval.queries.length > 0 && (
            <InlineSection label="Queries">
              <div className="flex flex-wrap gap-1.5">
                {retrieval.queries.map((query) => (
                  <code
                    key={query}
                    className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]"
                  >
                    {query}
                  </code>
                ))}
              </div>
            </InlineSection>
          )}

          {retrieval.selectedMemories.length > 0 && (
            <InlineSection label="Selected Memories">
              <div className="space-y-2">
                {retrieval.selectedMemories.map((memory) => (
                  <button
                    key={memory.id}
                    type="button"
                    data-memory-entry-id={memory.id}
                    onClick={() => setViewingMemory(memory)}
                    className="w-full rounded-xl border border-emerald-400/12 bg-emerald-400/[0.05] px-3 py-2 text-left transition-colors hover:border-emerald-300/25 hover:bg-emerald-400/[0.09]"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="text-[11px] text-emerald-200">{memory.id}</code>
                      <span className="text-[11px] text-[var(--color-text-secondary)]">
                        {memory.title}
                      </span>
                    </div>
                    <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                      {memory.type}
                      {memory.score !== undefined ? ` · score ${memory.score.toFixed(2)}` : ''}
                    </p>
                  </button>
                ))}
              </div>
            </InlineSection>
          )}

          {injectionPreview.length > 0 && (
            <InlineSection label="Injected Context">
              <div className="space-y-2">
                {injectionPreview.map((memoryInjection, index) => (
                  <div
                    key={`${memoryInjection.layer}-${memoryInjection.source}-${index}`}
                    className="rounded-2xl border border-emerald-400/15 bg-[linear-gradient(180deg,rgba(6,78,59,0.16),rgba(10,14,20,0.72))] px-3 py-2"
                  >
                    <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-secondary)]">
                      <span className="rounded bg-white/5 px-1.5 py-0.5">{memoryInjection.layer}</span>
                      <span>{memoryInjection.source}</span>
                    </div>
                    <div className="mt-2">
                      <ExpandableInlineText value={memoryInjection.formattedText} />
                    </div>
                  </div>
                ))}
              </div>
            </InlineSection>
          )}

          {retrieval.searches.length > 0 && (
            <InlineSection label="Searches">
              <div className="space-y-2">
                {retrieval.searches.map((search, index) => (
                  <div
                    key={`${search.query}-${index}`}
                    className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2"
                  >
                    <p className="text-[11px] font-mono text-[var(--color-text-secondary)]">
                      {search.query}
                    </p>
                    <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                      {search.resultCount} result{search.resultCount === 1 ? '' : 's'}
                      {search.topResultTitle ? ` · top: ${search.topResultTitle}` : ''}
                    </p>
                  </div>
                ))}
              </div>
            </InlineSection>
          )}

          {retrieval.usedFallbackSelection && (
            <InlineSection label="Fallback">
              <p className="text-[11px] text-amber-200">
                Agent output could not be parsed cleanly, so fallback selection was used.
              </p>
            </InlineSection>
          )}

          <InlineSection label="Cost">
            <p className="text-[11px] font-mono text-[var(--color-text-secondary)]">
              {durationMs !== undefined ? formatDuration(durationMs) : 'n/a'}
              {' · '}
              {retrieval.tokens
                ? `${retrieval.tokens.input}+${retrieval.tokens.output} tokens`
                : '0+0 tokens'}
              {' · '}
              {retrieval.cost !== undefined ? `$${formatCost(retrieval.cost)}` : '$0.0000'}
            </p>
          </InlineSection>

          {rationale && (
            <InlineSection label="Agent Reasoning">
              <ExpandableInlineText value={rationale} />
            </InlineSection>
          )}
        </div>
      )}

      <MemoryDetailDialog memory={viewingMemory} onClose={() => setViewingMemory(null)} />
    </div>
  )
}

function getPreviewText(outcome: string, detail: ReturnType<typeof readMemoryRetrievalDetail>): string {
  if (detail.queries.length > 0) return detail.queries.join(' | ')
  if (detail.selectedMemories.length > 0) {
    return detail.selectedMemories.map((memory) => memory.title).join(' | ')
  }
  if (detail.selectedMemoryIds.length > 0) return detail.selectedMemoryIds.join(' | ')
  return outcome
}

function InlineSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-disabled)]">
        {label}
      </div>
      {children}
    </div>
  )
}

function ExpandableInlineText({ value }: { value: string }) {
  const [expanded, setExpanded] = React.useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="text-[11px] text-[var(--color-accent)] hover:underline"
      >
        {expanded ? 'Collapse' : 'Expand'} ({value.length.toLocaleString()} chars)
      </button>
      {expanded && (
        <pre className="mt-1 max-h-[320px] overflow-y-auto whitespace-pre-wrap break-all rounded-xl bg-black/20 p-2 text-[10px] text-[var(--color-text-muted)]">
          {value}
        </pre>
      )}
    </>
  )
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const cls =
    outcome === 'injected'
      ? 'bg-emerald-400/12 text-emerald-200'
      : outcome === 'empty'
        ? 'bg-slate-400/12 text-slate-200'
        : outcome === 'skipped'
          ? 'bg-white/8 text-[var(--color-text-muted)]'
          : 'bg-cyan-400/12 text-cyan-200'

  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${cls}`}>{outcome}</span>
}

function formatDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`
}
