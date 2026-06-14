import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChannelSessionSelector } from '../components/session/ChannelSessionSelector'
import { SessionDetailScreen } from '../components/session/SessionDetailScreen'
import { useWebSocket } from '../useWebSocket'
import { apiFetch, isAbortError } from '../lib/api'
import {
  type ChannelSessionCandidate,
  resolveChannelSessionCandidate,
} from './session-detail-helpers'

interface ChannelSessionSource {
  source: string
  channelCount: number
  updatedAt: string | null
}

function buildCandidateSearch(candidate: ChannelSessionCandidate) {
  return {
    id: candidate.channelId,
    channelName: candidate.channelName,
  }
}

export function SessionSourceDetailPage() {
  const navigate = useNavigate()
  const { source } = useParams({ from: '/sessions/source/$source/detail' })
  const search = useSearch({ from: '/sessions/source/$source/detail' }) as {
    id?: string
    channelName?: string
  }

  const [selectorCandidates, setSelectorCandidates] = useState<ChannelSessionCandidate[]>([])
  const [sourceOptions, setSourceOptions] = useState<ChannelSessionSource[]>([])
  const [sourceLoading, setSourceLoading] = useState(true)
  const [selectorLoading, setSelectorLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const sourceAbortRef = useRef<AbortController | null>(null)
  const selectorAbortRef = useRef<AbortController | null>(null)
  const sourceRequestIdRef = useRef(0)
  const selectorRequestIdRef = useRef(0)

  const fetchSourceOptions = useCallback((showLoading = true) => {
    const requestId = ++sourceRequestIdRef.current
    sourceAbortRef.current?.abort()
    const controller = new AbortController()
    sourceAbortRef.current = controller

    if (showLoading) setSourceLoading(true)

    return apiFetch<{ sources: ChannelSessionSource[] }>('/api/sessions/sources/current', {
      signal: controller.signal,
    })
      .then((res) => {
        if (requestId !== sourceRequestIdRef.current) return
        setSourceOptions(res.sources ?? [])
      })
      .catch((error) => {
        if (requestId !== sourceRequestIdRef.current || isAbortError(error)) return
        setSourceOptions([])
      })
      .finally(() => {
        if (requestId === sourceRequestIdRef.current) {
          setSourceLoading(false)
        }
      })
  }, [])

  const fetchSelectorCandidates = useCallback((activeSource: string, showLoading = true) => {
    const requestId = ++selectorRequestIdRef.current
    selectorAbortRef.current?.abort()
    const controller = new AbortController()
    selectorAbortRef.current = controller

    if (showLoading) setSelectorLoading(true)

    return apiFetch<{ sessions: ChannelSessionCandidate[] }>(
      `/api/sessions/source/${encodeURIComponent(activeSource)}/current`,
      { signal: controller.signal },
    )
      .then((res) => {
        if (requestId !== selectorRequestIdRef.current) return
        setSelectorCandidates(res.sessions ?? [])
      })
      .catch((error) => {
        if (requestId !== selectorRequestIdRef.current || isAbortError(error)) return
        setSelectorCandidates([])
      })
      .finally(() => {
        if (requestId === selectorRequestIdRef.current) {
          setSelectorLoading(false)
        }
      })
  }, [])

  useEffect(() => {
    void fetchSourceOptions()
  }, [fetchSourceOptions])

  useEffect(() => {
    void fetchSelectorCandidates(source)
  }, [fetchSelectorCandidates, source])

  useEffect(
    () => () => {
      clearTimeout(debounceRef.current)
      sourceAbortRef.current?.abort()
      selectorAbortRef.current?.abort()
    },
    [],
  )

  const onSessionEvent = useCallback(() => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void fetchSourceOptions(false)
      void fetchSelectorCandidates(source, false)
    }, 300)
  }, [fetchSelectorCandidates, fetchSourceOptions, source])

  useWebSocket({
    url: `ws://${window.location.host}/ws`,
    topics: ['session:create', 'session:update'],
    onEvent: onSessionEvent,
  })

  const activeCandidates = useMemo(
    () => selectorCandidates.filter((candidate) => candidate.source === source),
    [selectorCandidates, source],
  )

  const selectedCandidate = useMemo(
    () => resolveChannelSessionCandidate(activeCandidates, search.id, search.channelName, source),
    [activeCandidates, search.channelName, search.id, source],
  )

  const sources = useMemo(() => {
    const names = new Set<string>([source])
    for (const option of sourceOptions) names.add(option.source)
    for (const candidate of selectorCandidates) names.add(candidate.source)
    return Array.from(names)
  }, [selectorCandidates, source, sourceOptions])

  useEffect(() => {
    if (selectorLoading || !selectedCandidate) return

    if (
      search.channelName !== selectedCandidate.channelName ||
      search.id !== selectedCandidate.channelId ||
      source !== selectedCandidate.source
    ) {
      navigate({
        to: '/sessions/source/$source/detail',
        params: { source: selectedCandidate.source },
        search: buildCandidateSearch(selectedCandidate),
        replace: true,
      })
    }
  }, [navigate, search.channelName, search.id, selectedCandidate, selectorLoading, source])

  const selector = (
    <ChannelSessionSelector
      sources={sources}
      candidates={activeCandidates}
      selectedCandidate={selectedCandidate}
      activeSource={source}
      loading={selectorLoading}
      sourceLoading={sourceLoading}
      onSourceSelect={(nextSource) => {
        if (nextSource === source) return

        navigate({
          to: '/sessions/source/$source/detail',
          params: { source: nextSource },
          search: { id: undefined, channelName: undefined },
        })
      }}
      onSelect={(next) => {
        if (!next) return

        navigate({
          to: '/sessions/source/$source/detail',
          params: { source: next.source },
          search: buildCandidateSearch(next),
        })
      }}
    />
  )

  return (
    <SessionDetailScreen
      sessionId={selectedCandidate?.id}
      topContent={selector}
      emptyState={
        <div className="card p-8 text-center text-[13px] text-[var(--color-text-muted)]">
          {selectorLoading
            ? 'Loading active channel session...'
            : `No active or idle channel session found in source ${source}.`}
        </div>
      }
    />
  )
}

export function SessionChannelDetailRedirectPage() {
  const navigate = useNavigate()
  const { channel } = useParams({ from: '/sessions/channel/$channel/detail' })
  const search = useSearch({ from: '/sessions/channel/$channel/detail' }) as {
    source?: string
    channelName?: string
  }
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let canceled = false

    async function redirect() {
      if (search.source) {
        await navigate({
          to: '/sessions/source/$source/detail',
          params: { source: search.source },
          search: { id: channel, channelName: search.channelName },
          replace: true,
        })
        return
      }

      try {
        const res = await apiFetch<{ sessions: ChannelSessionCandidate[] }>(
          `/api/sessions/channel/${encodeURIComponent(channel)}/current`,
        )
        if (canceled) return

        const candidate = resolveChannelSessionCandidate(
          res.sessions ?? [],
          channel,
          search.channelName,
        )
        if (!candidate) {
          setFailed(true)
          return
        }

        await navigate({
          to: '/sessions/source/$source/detail',
          params: { source: candidate.source },
          search: buildCandidateSearch(candidate),
          replace: true,
        })
      } catch (error) {
        if (!canceled && !isAbortError(error)) {
          setFailed(true)
        }
      }
    }

    void redirect()

    return () => {
      canceled = true
    }
  }, [channel, navigate, search.channelName, search.source])

  return (
    <SessionDetailScreen
      emptyState={
        <div className="card p-8 text-center text-[13px] text-[var(--color-text-muted)]">
          {failed
            ? 'No active channel session found for this legacy channel URL.'
            : 'Opening source channel detail...'}
        </div>
      }
    />
  )
}
