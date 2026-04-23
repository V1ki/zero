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
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[10px] text-[var(--color-text-disabled)] uppercase tracking-wide">
        Source
      </span>
      <span className="text-[11px] font-mono text-[var(--color-text-secondary)]">
        {selectedCandidate?.source ?? activeSource ?? '—'}
      </span>
      <span className="text-[10px] text-[var(--color-text-disabled)] uppercase tracking-wide ml-2">
        Channel
      </span>
      <span className="text-[11px] font-mono text-[var(--color-text-secondary)]">
        {selectedCandidate?.channelName ?? '—'}
      </span>
      <span className="text-[10px] text-[var(--color-text-disabled)] uppercase tracking-wide ml-2">
        Channel ID
      </span>
      <select
        className="input-field py-1.5 px-2.5 min-w-[220px]"
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
