export interface ChannelSessionCandidate {
  id: string
  source: string
  channelName?: string
  channelId: string
  isCurrent: boolean
  placement: 'current'
  updatedAt: string
  summary?: string
}

export function getChannelSessionCandidateKey(
  candidate: Pick<ChannelSessionCandidate, 'id'>,
): string {
  return candidate.id
}

export function resolveChannelSessionCandidate(
  candidates: ChannelSessionCandidate[],
  preferredChannelId?: string,
  preferredChannelName?: string,
  preferredSource?: string,
) {
  const matchesSource = (candidate: ChannelSessionCandidate) =>
    preferredSource === undefined || candidate.source === preferredSource

  const findMatch = (predicate: (candidate: ChannelSessionCandidate) => boolean) =>
    candidates.find((candidate) => matchesSource(candidate) && predicate(candidate))

  if (preferredChannelId && preferredChannelName) {
    const preferred = findMatch(
      (candidate) =>
        candidate.channelId === preferredChannelId &&
        candidate.channelName === preferredChannelName,
    )
    if (preferred) return preferred
  }

  if (preferredChannelId) {
    if (preferredChannelName === undefined) {
      const preferredWithoutName = findMatch(
        (candidate) =>
          candidate.channelId === preferredChannelId && candidate.channelName === undefined,
      )
      if (preferredWithoutName) return preferredWithoutName
    }

    const preferred = findMatch((candidate) => candidate.channelId === preferredChannelId)
    if (preferred) return preferred

    return null
  }

  if (preferredSource) {
    const preferred = candidates.find((candidate) => candidate.source === preferredSource)
    if (preferred) return preferred
  }

  return candidates[0] ?? null
}
