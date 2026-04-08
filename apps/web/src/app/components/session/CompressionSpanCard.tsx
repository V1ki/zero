import { useState } from 'react'
import { formatCost, formatNumber } from '../../lib/format'
import type { TraceSpan } from './timeline'

export interface CompressionSpanCardProps {
  span: TraceSpan
  depth?: number
}

export function CompressionSpanCard({ span, depth = 0 }: CompressionSpanCardProps) {
  const [promptOpen, setPromptOpen] = useState(false)
  const [responseOpen, setResponseOpen] = useState(false)

  const compression = (span.data?.compression as Record<string, unknown> | undefined) ?? {}
  const model = typeof compression.model === 'string' ? compression.model : undefined
  const provider = typeof compression.provider === 'string' ? compression.provider : undefined
  const prompt = typeof compression.prompt === 'string' ? compression.prompt : undefined
  const response = typeof compression.response === 'string' ? compression.response : undefined
  const durationMs =
    (compression.durationMs as number | undefined) ?? (span.durationMs as number | undefined)
  const cost = typeof compression.cost === 'number' ? compression.cost : undefined
  const tokens = (compression.tokens as Record<string, unknown> | undefined) ?? {}

  const tokenBadges = (
    [
      ['in', tokens.input],
      ['out', tokens.output],
      ['cw', tokens.cacheWrite],
      ['cr', tokens.cacheRead],
      ['rs', tokens.reasoning],
    ] as const
  ).flatMap(([label, value]) =>
    typeof value === 'number'
      ? [
          <span
            key={label}
            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#F59E0B]/10 text-[#FBBF24]"
          >
            {label} {formatNumber(value)}
          </span>,
        ]
      : [],
  )

  const statusIcon = span.status === 'success' ? '✅' : span.status === 'error' ? '❌' : '⏳'

  return (
    <div
      className="rounded-lg border border-[#F59E0B]/20 bg-[#F59E0B]/[0.04]"
      style={{ marginLeft: `${depth * 14}px` }}
      data-trace-card="compression"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-[12px] font-mono font-semibold text-[#FBBF24]">{span.name}</span>
        <span className="flex-1" />
        <span className="text-[12px]" title={span.status}>
          {statusIcon}
        </span>
        {durationMs !== undefined && (
          <span className="text-[10px] font-mono text-[var(--color-text-disabled)]">
            {durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
      </div>

      <div className="px-3 pb-2 flex flex-wrap gap-1.5">
        {model && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#F59E0B]/10 text-[#FBBF24]">
            {model}
          </span>
        )}
        {provider && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#F59E0B]/10 text-[#FBBF24]">
            {provider}
          </span>
        )}
        {tokenBadges}
        {cost !== undefined && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#F59E0B]/10 text-[#FBBF24]">
            ${formatCost(cost)}
          </span>
        )}
      </div>

      {prompt && (
        <CollapsibleSection
          label="Prompt"
          open={promptOpen}
          onToggle={() => setPromptOpen(!promptOpen)}
        >
          <pre className="text-[11px] font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap break-all">
            {prompt}
          </pre>
        </CollapsibleSection>
      )}

      {response && (
        <CollapsibleSection
          label="Response"
          open={responseOpen}
          onToggle={() => setResponseOpen(!responseOpen)}
        >
          <pre className="text-[11px] font-mono text-[var(--color-text-secondary)] whitespace-pre-wrap break-all">
            {response}
          </pre>
        </CollapsibleSection>
      )}
    </div>
  )
}

function CollapsibleSection({
  label,
  open,
  onToggle,
  children,
}: {
  label: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="px-3 pb-2">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
        className="flex items-center gap-1 text-[11px] font-mono text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
      >
        <span className="text-[10px]">{open ? '▾' : '▸'}</span>
        {label}
      </button>
      {open && <div className="mt-1 px-1">{children}</div>}
    </div>
  )
}
