import { formatTimeAgo } from '../../lib/format'
import {
  type ChannelSessionCandidate,
  getChannelSessionCandidateKey,
} from '../../routes/session-detail-helpers'

interface ChannelSessionSelectorProps {
  sources: string[]
  candidates: ChannelSessionCandidate[]
  selectedCandidate: ChannelSessionCandidate | null
  activeSource?: string | null
  loading: boolean
  sourceLoading?: boolean
  onSourceSelect: (source: string) => void
  onSelect: (candidate: ChannelSessionCandidate | null) => void
}

export function ChannelSessionSelector({
  sources,
  candidates,
  selectedCandidate,
  activeSource,
  loading,
  sourceLoading = false,
  onSourceSelect,
  onSelect,
}: ChannelSessionSelectorProps) {
  const getChannelLabel = (candidate: ChannelSessionCandidate) =>
    candidate.channelName ?? `${candidate.source} channel`

  const selectedSource = activeSource ?? selectedCandidate?.source ?? ''

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
      <label className="flex min-w-[132px] items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--color-text-disabled)]">
        Source
        <select
          aria-label="Source"
          className="input-field h-8 min-w-[104px] px-2.5 py-1 text-[12px] normal-case tracking-normal"
          value={selectedSource}
          disabled={sourceLoading || sources.length === 0}
          onChange={(e) => onSourceSelect(e.target.value)}
        >
          {sources.map((source) => (
            <option key={source} value={source}>
              {source}
            </option>
          ))}
        </select>
      </label>

      <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--color-text-disabled)] lg:max-w-[640px] xl:flex-none xl:w-[520px]">
        Channel
        <select
          aria-label="Channel"
          className="input-field h-8 min-w-[220px] max-w-full flex-1 px-2.5 py-1 text-[12px] normal-case tracking-normal"
          value={selectedCandidate ? getChannelSessionCandidateKey(selectedCandidate) : ''}
          disabled={loading || candidates.length === 0}
          onChange={(e) => {
            const next = candidates.find(
              (candidate) => getChannelSessionCandidateKey(candidate) === e.target.value,
            )
            onSelect(next ?? null)
          }}
        >
          {candidates.map((candidate) => (
            <option
              key={getChannelSessionCandidateKey(candidate)}
              value={getChannelSessionCandidateKey(candidate)}
            >
              {getChannelLabel(candidate)} · {formatTimeAgo(candidate.updatedAt)}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
