import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { EpisodeBanner, type DatasetEpisode } from '../components/dataset/EpisodeBanner'
import { SessionDetailScreen } from '../components/session/SessionDetailScreen'
import { apiFetch } from '../lib/api'
import { compactDatasetSearch, type DatasetRouteSearch } from './dataset-helpers'

type DatasetEpisodeResponse = DatasetEpisode | { episode: DatasetEpisode }

export function unwrapDatasetEpisodeResponse(response: DatasetEpisodeResponse): DatasetEpisode {
  return 'episode' in response ? response.episode : response
}

export function DatasetDetailPage() {
  const navigate = useNavigate()
  const { id } = useParams({ from: '/dataset/$id' })
  const search = useSearch({ from: '/dataset/$id' }) as DatasetRouteSearch
  const [episode, setEpisode] = useState<DatasetEpisode | null>(null)

  useEffect(() => {
    let cancelled = false

    void apiFetch<DatasetEpisodeResponse>(`/api/dataset/episodes/${id}`)
      .then((response) => {
        if (!cancelled) {
          setEpisode(unwrapDatasetEpisodeResponse(response))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEpisode(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [id])

  return (
    <SessionDetailScreen
      sessionId={id}
      backLabel="Dataset"
      onBack={() =>
        navigate({
          to: '/dataset',
          search: compactDatasetSearch(search),
        })
      }
      hideSessionActions
      allowJudgeActions={false}
      topContent={
        episode ? (
          <EpisodeBanner episode={episode} />
        ) : (
          <div className="card p-5 text-[12px] text-[var(--color-text-muted)]">Loading episode…</div>
        )
      }
    />
  )
}
