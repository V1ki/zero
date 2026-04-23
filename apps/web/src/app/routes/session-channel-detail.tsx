import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChannelSessionSelector } from '../components/session/ChannelSessionSelector'
import { SessionDetailScreen } from '../components/session/SessionDetailScreen'
import { useWebSocket } from '../hooks/useWebSocket'
import { apiFetch, isAbortError } from '../lib/api'
import {
  type ChannelSessionCandidate,
  resolveChannelSessionCandidate,
} from './session-detail-helpers'

export function SessionChannelDetailPage() {
  const navigate = useNavigate()
  const { channel } = useParams({ from: '/sessions/channel/$channel/detail' })
  const search = useSearch({ from: '/sessions/channel/$channel/detail' }) as {
    source?: string
    channelName?: string
  }

  const [currentCandidates, setCurrentCandidates] = useState<ChannelSessionCandidate[]>([])
  const [selectorCandidates, setSelectorCandidates] = useState<ChannelSessionCandidate[]>([])
  const [currentLoading, setCurrentLoading] = useState(true)
  const [selectorLoading, setSelectorLoading] = useState(false)
  const [inferredSource, setInferredSource] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const currentAbortRef = useRef<AbortController | null>(null)
  const selectorAbortRef = useRef<AbortController | null>(null)
  const currentRequestIdRef = useRef(0)
  const selectorRequestIdRef = useRef(0)

  const activeSource = search.source ?? inferredSource

  const fetchCurrentCandidates = useCallback(
    (showLoading = true) => {
      const requestId = ++currentRequestIdRef.current
      currentAbortRef.current?.abort()
      const controller = new AbortController()
      currentAbortRef.current = controller

      if (showLoading) setCurrentLoading(true)

      return apiFetch<{ sessions: ChannelSessionCandidate[] }>(
        `/api/sessions/channel/${encodeURIComponent(channel)}/current`,
        { signal: controller.signal },
      )
        .then((res) => {
          if (requestId !== currentRequestIdRef.current) return

          const sessions = res.sessions ?? []
          setCurrentCandidates(sessions)

          if (search.source) return

          const preferred = resolveChannelSessionCandidate(sessions, channel, search.channelName)
          setInferredSource(preferred?.source ?? sessions[0]?.source ?? null)
        })
        .catch((error) => {
          if (requestId !== currentRequestIdRef.current || isAbortError(error)) return

          setCurrentCandidates([])
          if (!search.source) {
            setInferredSource(null)
          }
        })
        .finally(() => {
          if (requestId === currentRequestIdRef.current) {
            setCurrentLoading(false)
          }
        })
    },
    [channel, search.channelName, search.source],
  )

  const fetchSelectorCandidates = useCallback((source: string, showLoading = true) => {
    const requestId = ++selectorRequestIdRef.current
    selectorAbortRef.current?.abort()
    const controller = new AbortController()
    selectorAbortRef.current = controller

    if (showLoading) setSelectorLoading(true)

    return apiFetch<{ sessions: ChannelSessionCandidate[] }>(
      `/api/sessions/source/${encodeURIComponent(source)}/current`,
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
    void fetchCurrentCandidates()
  }, [fetchCurrentCandidates])

  useEffect(() => {
    if (search.source) {
      setInferredSource(null)
    }
  }, [search.source])

  useEffect(() => {
    if (!activeSource) {
      selectorAbortRef.current?.abort()
      setSelectorCandidates([])
      setSelectorLoading(false)
      return
    }

    void fetchSelectorCandidates(activeSource)
  }, [activeSource, fetchSelectorCandidates])

  useEffect(
    () => () => {
      clearTimeout(debounceRef.current)
      currentAbortRef.current?.abort()
      selectorAbortRef.current?.abort()
    },
    [],
  )

  const onSessionEvent = useCallback(() => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      void fetchCurrentCandidates(false)
      if (activeSource) {
        void fetchSelectorCandidates(activeSource, false)
      }
    }, 300)
  }, [activeSource, fetchCurrentCandidates, fetchSelectorCandidates])

  useWebSocket({
    url: `ws://${window.location.host}/ws`,
    topics: ['session:create', 'session:update'],
    onEvent: onSessionEvent,
  })

  const selectedCandidate = useMemo(
    () =>
      resolveChannelSessionCandidate(
        currentCandidates,
        channel,
        search.channelName,
        activeSource ?? undefined,
      ),
    [activeSource, channel, currentCandidates, search.channelName],
  )

  const candidates = useMemo(() => {
    const merged = [
      ...currentCandidates.filter((candidate) =>
        activeSource ? candidate.source === activeSource : true,
      ),
      ...selectorCandidates.filter((candidate) =>
        activeSource ? candidate.source === activeSource : true,
      ),
    ]

    const uniqueCandidates: ChannelSessionCandidate[] = []
    const seen = new Set<string>()
    for (const candidate of merged) {
      if (seen.has(candidate.id)) continue
      seen.add(candidate.id)
      uniqueCandidates.push(candidate)
    }

    return uniqueCandidates
  }, [activeSource, currentCandidates, selectorCandidates])

  const loading = currentLoading || (activeSource ? selectorLoading : false)

  const hasRouteMatch = useMemo(
    () =>
      currentCandidates.some(
        (candidate) =>
          candidate.id === selectedCandidate?.id &&
          (!activeSource || candidate.source === activeSource),
      ),
    [activeSource, currentCandidates, selectedCandidate],
  )

  useEffect(() => {
    if (currentLoading || !selectedCandidate || !hasRouteMatch) return

    if (
      search.source !== selectedCandidate.source ||
      search.channelName !== selectedCandidate.channelName ||
      channel !== selectedCandidate.channelId
    ) {
      navigate({
        to: '/sessions/channel/$channel/detail',
        params: { channel: selectedCandidate.channelId },
        search: {
          source: selectedCandidate.source,
          channelName: selectedCandidate.channelName,
        },
        replace: true,
      })
    }
  }, [
    channel,
    currentLoading,
    hasRouteMatch,
    navigate,
    search.channelName,
    search.source,
    selectedCandidate,
  ])

  const selector = (
    <ChannelSessionSelector
      candidates={candidates}
      selectedCandidate={selectedCandidate}
      activeSource={activeSource}
      loading={loading}
      onSelect={(next) => {
        if (!next) return

        navigate({
          to: '/sessions/channel/$channel/detail',
          params: { channel: next.channelId },
          search: {
            source: next.source,
            channelName: next.channelName,
          },
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
          {loading
            ? 'Loading active channel session...'
            : `No active or idle session found for this channel${activeSource ? ` in source ${activeSource}` : ''}.`}
        </div>
      }
    />
  )
}
