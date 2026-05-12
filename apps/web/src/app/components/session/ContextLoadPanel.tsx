import { Database, Gauge, Heartbeat } from '@phosphor-icons/react'
import { formatCost, formatNumber, formatTime } from '../../lib/format'
import type { ContextTokenSection, ContextTokenSummary } from './context-tokens'

interface Props {
  summary: ContextTokenSummary
  layout?: 'wide' | 'sidebar'
}

export function ContextLoadPanel({ summary, layout = 'wide' }: Props) {
  const maxSectionTokens = Math.max(...summary.sections.map((section) => section.tokens), 1)
  const latest = summary.latestRequest
  const isSidebar = layout === 'sidebar'

  return (
    <section
      data-testid="session-context-load"
      data-layout={layout}
      className={
        isSidebar
          ? 'border-b border-white/8 pb-4'
          : 'mt-4 overflow-hidden rounded-[22px] border border-white/8 bg-[linear-gradient(135deg,rgba(16,24,32,0.94),rgba(10,12,18,0.92))]'
      }
    >
      <div
        className={
          isSidebar
            ? 'space-y-4'
            : 'grid gap-0 lg:grid-cols-[minmax(260px,0.85fr)_minmax(0,1.45fr)_minmax(240px,0.9fr)]'
        }
      >
        <div
          className={
            isSidebar
              ? 'border-b border-white/8 pb-4'
              : 'border-b border-white/8 p-4 lg:border-r lg:border-b-0'
          }
        >
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-400/10">
              <Gauge size={15} weight="bold" className="text-cyan-200" />
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-100/85">
                Context Load
              </p>
              <p className="mt-0.5 text-[11px] text-[var(--color-text-disabled)]">
                current estimate
              </p>
            </div>
          </div>

          <div className="mt-4">
            <p className="text-[28px] font-semibold leading-none text-[var(--color-text-primary)]">
              {formatNumber(summary.estimatedContextTokens)}
            </p>
            <p className="mt-1 text-[11px] font-mono text-[var(--color-text-muted)]">
              visible context tokens
            </p>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <StatChip label="Ledger" value={formatNumber(summary.cumulative.totalTokens)} />
            <StatChip label="Calls" value={formatNumber(summary.cumulative.requestCount)} />
            <StatChip label="Cache" value={formatNumber(summary.cumulative.cacheReadTokens)} />
            <StatChip label="Spend" value={`$${formatCost(summary.cumulative.totalCost)}`} />
          </div>
        </div>

        <div
          className={
            isSidebar
              ? 'border-b border-white/8 pb-4'
              : 'border-b border-white/8 p-4 lg:border-r lg:border-b-0'
          }
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Heartbeat size={14} className="text-[var(--color-accent)]" />
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-secondary)]">
                Distribution
              </p>
            </div>
            {latest ? (
              <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-mono text-[var(--color-text-disabled)]">
                latest {formatTime(latest.ts)}
              </span>
            ) : null}
          </div>

          <div className="mt-3 space-y-2.5">
            {summary.sections.length === 0 ? (
              <p className="text-[12px] text-[var(--color-text-muted)]">No context tokens yet.</p>
            ) : (
              summary.sections.map((section) => (
                <DistributionRow key={section.key} section={section} maxTokens={maxSectionTokens} />
              ))
            )}
          </div>
        </div>

        <div className={isSidebar ? '' : 'p-4'}>
          <div className="flex items-center gap-2">
            <Database size={14} className="text-emerald-300" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-text-secondary)]">
              Latest Request
            </p>
          </div>

          {latest ? (
            <div className="mt-3 space-y-3">
              <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-3">
                <p className="truncate text-[11px] font-mono text-[var(--color-text-muted)]">
                  {latest.model}
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <StatChip label="Input" value={formatNumber(latest.input ?? 0)} />
                  <StatChip label="Output" value={formatNumber(latest.output ?? 0)} />
                  <StatChip label="Effective" value={formatNumber(latest.effectiveInput ?? 0)} />
                  <StatChip label="Cost" value={`$${formatCost(latest.cost ?? 0)}`} />
                </div>
              </div>

              {summary.hotspots.length > 0 ? (
                <div className="space-y-1.5">
                  {summary.hotspots.map((hotspot) => (
                    <div
                      key={hotspot.id}
                      className="rounded-2xl border border-white/6 bg-black/12 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">
                          {hotspot.label}
                        </span>
                        <span className="font-mono text-[10px] text-[var(--color-text-disabled)]">
                          {formatNumber(hotspot.tokens)}
                        </span>
                      </div>
                      {hotspot.detail ? (
                        <p className="mt-1 truncate text-[10px] text-[var(--color-text-muted)]">
                          {hotspot.detail}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-[12px] text-[var(--color-text-muted)]">
              No persisted LLM request usage yet.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

function DistributionRow({
  section,
  maxTokens,
}: {
  section: ContextTokenSection
  maxTokens: number
}) {
  const width = Math.max(3, (section.tokens / maxTokens) * 100)

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[12px] font-medium text-[var(--color-text-primary)]">
            {section.label}
          </span>
          {section.detail ? (
            <span className="ml-2 text-[10px] text-[var(--color-text-disabled)]">
              {section.detail}
            </span>
          ) : null}
        </div>
        <span className="shrink-0 font-mono text-[11px] text-[var(--color-text-secondary)]">
          {formatNumber(section.tokens)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/[0.05]">
        <div
          className={`h-full rounded-full ${getToneClass(section.tone)}`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  )
}

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-white/8 bg-black/14 px-2.5 py-2">
      <p className="truncate text-[9px] uppercase tracking-[0.16em] text-[var(--color-text-disabled)]">
        {label}
      </p>
      <p className="mt-1 truncate font-mono text-[12px] text-[var(--color-text-secondary)]">
        {value}
      </p>
    </div>
  )
}

function getToneClass(tone: ContextTokenSection['tone']): string {
  switch (tone) {
    case 'system':
      return 'bg-violet-300/80'
    case 'user':
      return 'bg-cyan-300/80'
    case 'assistant':
      return 'bg-emerald-300/80'
    case 'tool':
      return 'bg-amber-300/80'
    case 'memory':
      return 'bg-fuchsia-300/80'
    case 'cache':
      return 'bg-sky-300/80'
    case 'other':
      return 'bg-slate-300/70'
  }
}
