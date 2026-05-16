import { formatTimeAgo } from '../../lib/format'
import {
  type ChannelSessionCandidate,
  getChannelSessionCandidateKey,
} from '../../routes/session-detail-helpers'

interface ChannelSessionSelectorProps {
  candidates: ChannelSessionCandidate[]
  selectedCandidate: ChannelSessionCandidate | null
  activeSource?: string | null
  loading: boolean
  onSelect: (candidate: ChannelSessionCandidate | null) => void
}

export function ChannelSessionSelector({
  candidates,
  selectedCandidate,
  activeSource,
  loading,
  onSelect,
}: ChannelSessionSelectorProps) {
  const getOptionValue = (candidate: ChannelSessionCandidate) =>
    `${getChannelSessionCandidateKey(candidate)}::${candidate.channelName ?? candidate.source}::${candidate.channelId}`

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 lg:justify-end">
      <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-white/8 bg-white/[0.03] px-2 text-[10px] text-[var(--color-text-disabled)] uppercase tracking-wide">
        Source
        <span className="font-mono text-[var(--color-text-secondary)] normal-case tracking-normal">
          {selectedCandidate?.source ?? activeSource ?? '—'}
        </span>
      </span>
      <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-white/8 bg-white/[0.03] px-2 text-[10px] text-[var(--color-text-disabled)] uppercase tracking-wide">
        Channel
        <span className="font-mono text-[var(--color-text-secondary)] normal-case tracking-normal">
          {selectedCandidate?.channelName ?? '—'}
        </span>
      </span>
      <select
        aria-label="Channel ID"
        className="input-field h-8 min-w-[240px] max-w-full flex-1 px-2.5 py-1 text-[12px] lg:max-w-[640px] xl:flex-none xl:w-[520px]"
        value={selectedCandidate ? getOptionValue(selectedCandidate) : ''}
        disabled={loading || candidates.length === 0}
        onChange={(e) => {
          const next = candidates.find((candidate) => getOptionValue(candidate) === e.target.value)
          onSelect(next ?? null)
        }}
      >
        {candidates.map((candidate) => (
          <option key={getChannelSessionCandidateKey(candidate)} value={getOptionValue(candidate)}>
            {candidate.channelName ?? candidate.source} · {candidate.channelId} ·{' '}
            {candidate.placement} · {formatTimeAgo(candidate.updatedAt)}
          </option>
        ))}
      </select>
    </div>
  )
}
