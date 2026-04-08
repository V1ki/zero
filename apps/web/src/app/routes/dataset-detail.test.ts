import { describe, expect, test } from 'bun:test'
import type { DatasetEpisode } from '../components/dataset/EpisodeBanner'
import { unwrapDatasetEpisodeResponse } from './dataset-detail'

const episode: DatasetEpisode = {
  sessionId: 'sess_dataset_detail_001',
  metadata: {
    source: 'web',
    status: 'completed',
    currentModel: 'openai-codex/gpt-5.4-medium',
  },
  recordedContext: {
    systemPrompt: 'system prompt',
    tools: ['bash'],
    toolsSource: 'snapshot',
  },
  evaluations: [],
  traits: ['uses-tools'],
}

describe('unwrapDatasetEpisodeResponse', () => {
  test('returns raw episode payloads unchanged', () => {
    expect(unwrapDatasetEpisodeResponse(episode)).toEqual(episode)
  })

  test('unwraps legacy wrapped episode payloads', () => {
    expect(unwrapDatasetEpisodeResponse({ episode })).toEqual(episode)
  })
})
