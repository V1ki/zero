import { describe, expect, test } from 'bun:test'
import {
  buildDatasetEpisodesQuery,
  compactDatasetSearch,
  formatTraitsSearch,
  parseTraitsSearch,
  validateDatasetSearch,
} from './dataset-helpers'

describe('dataset route helpers', () => {
  test('validateDatasetSearch normalizes supported query fields', () => {
    expect(
      validateDatasetSearch({
        status: 'completed',
        source: 'web',
        traits: 'uses-tools,multi-turn',
        hasEvaluation: 'true',
        since: '2026-04-01T00:00:00.000Z',
        until: '',
        offset: '10',
        limit: '25',
        noise: 'ignored',
      }),
    ).toEqual({
      status: 'completed',
      source: 'web',
      traits: 'uses-tools,multi-turn',
      hasEvaluation: 'true',
      since: '2026-04-01T00:00:00.000Z',
      offset: 10,
      limit: 25,
    })
  })

  test('trait helpers and query builder keep URL state compact', () => {
    expect(parseTraitsSearch('uses-tools, multi-turn')).toEqual(['uses-tools', 'multi-turn'])
    expect(formatTraitsSearch(['uses-tools', 'multi-turn'])).toBe('uses-tools,multi-turn')
    expect(
      buildDatasetEpisodesQuery(
        compactDatasetSearch({
          status: 'completed',
          source: 'web',
          traits: 'uses-tools,multi-turn',
          hasEvaluation: 'false',
          offset: 5,
        }),
      ),
    ).toBe(
      'statuses=completed&sources=web&traits=uses-tools%2Cmulti-turn&hasEvaluation=false&offset=5',
    )
  })
})
