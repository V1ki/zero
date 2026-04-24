import { formatCost, formatNumber } from '../../lib/format'
import type { TokenUsageSummary } from './context-tokens'

interface Props {
  usage?: TokenUsageSummary
  label?: string
  tone?: 'muted' | 'accent'
}

export function TokenUsagePill({ usage, label = 'Tokens', tone = 'muted' }: Props) {
  if (!usage || usage.total <= 0) return null

  const parts =
    usage.source === 'request'
      ? [
          `${formatNumber(usage.total)} total`,
          usage.input !== undefined ? `${formatNumber(usage.input)} in` : null,
          usage.output !== undefined ? `${formatNumber(usage.output)} out` : null,
          usage.cacheRead ? `${formatNumber(usage.cacheRead)} cache` : null,
          usage.reasoning ? `${formatNumber(usage.reasoning)} reasoning` : null,
          usage.cost !== undefined ? `$${formatCost(usage.cost)}` : null,
        ]
      : [`${formatNumber(usage.total)} est.`]

  const className =
    tone === 'accent'
      ? 'border-cyan-400/25 bg-cyan-400/8 text-cyan-100'
      : 'border-white/10 bg-white/[0.04] text-[var(--color-text-muted)]'

  return (
    <span
      data-testid="token-usage-pill"
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-mono ${className}`}
      title={parts.filter(Boolean).join(' · ')}
    >
      <span className="text-[var(--color-text-disabled)]">{label}</span>
      <span className="truncate">{parts.filter(Boolean).join(' · ')}</span>
    </span>
  )
}
