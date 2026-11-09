import { describe, expect, test } from 'bun:test'
import type { Asset, Evidence, ProjectView } from '../../../ip-video/types'
import {
  assetExcerpt,
  coveragePercent,
  evidenceRange,
  filterAssets,
  selectedCanonicalAsset,
} from '../ip-video-view'

const evidence: Evidence = {
  chapterId: 'chapter-1',
  chunkId: 'chunk-1',
  start: 7,
  end: 11,
  chapterOffset: 7,
  quote: '陈实牵马',
}
const asset: Asset = {
  id: 'canonical',
  name: '陈实',
  kind: 'character',
  aliases: ['骑奴', 'CHEN'],
  descriptions: ['  少年牵马。  ', '后续描述不并入摘要'],
  evidence: [evidence],
}

describe('IP video presentation contracts', () => {
  test('summary excerpts one source description, keeps full data and Unicode intact', () => {
    const before = structuredClone(asset)
    expect(assetExcerpt(asset)).toBe('少年牵马。')
    expect(assetExcerpt({ ...asset, descriptions: ['', '🐎骑奴牵马。'] }, 2)).toBe('🐎骑…')
    expect(assetExcerpt({ ...asset, descriptions: [] })).toBe('暂无描述')
    expect(asset).toEqual(before)
  })
  test('type and normalized alias search preserve canonical asset object and evidence', () => {
    const prop = { ...asset, id: 'horse', kind: 'prop' as const, name: '马', aliases: [] }
    expect(filterAssets([asset, prop], 'character', '  ｃｈｅｎ  ')).toEqual([asset])
    expect(filterAssets([asset, prop], 'all', '骑奴')[0]).toBe(asset)
    expect(filterAssets([asset, prop], 'prop', '骑奴')).toEqual([])
  })
  test('backend redirects resolve selected IDs without combining same-name entities', () => {
    const other = { ...asset, id: 'another-person' }
    const project = {
      assets: [asset, other],
      identityResolution: {
        version: 'character-alias-v1' as const,
        confirmations: [],
        decisions: [],
        redirects: { old: 'canonical' },
      },
    }
    expect(selectedCanonicalAsset(project, 'old')).toBe(asset)
    expect(selectedCanonicalAsset(project, 'another-person')).toBe(other)
    expect(selectedCanonicalAsset(project, 'missing')).toBeUndefined()
    expect(project.assets).toHaveLength(2)
  })
  test('quote navigation uses exact UTF-16 offset including astral characters and repeated quotes', () => {
    const text = '🐎\r\n陈实牵马\n陈实牵马\n'
    const quote = { ...evidence, chapterOffset: 9 }
    expect(evidenceRange(text, quote)).toEqual({ start: 9, end: 13 })
    const range = evidenceRange(text, quote)
    expect(range && text.slice(range.start, range.end)).toBe(quote.quote)
    expect(evidenceRange(text, { ...quote, chapterOffset: 8 })).toBeNull()
    expect(evidenceRange(text, { ...quote, chapterOffset: -1 })).toBeNull()
    expect(evidenceRange(text, null)).toBeNull()
  })
  test('zero source and invalid counters cannot produce NaN or an overflowing bar', () => {
    const project = { sourceUtf16Length: 0, progress: { coveredUtf16: 0 } } as ProjectView
    expect(coveragePercent(project)).toBe(0)
    expect(
      coveragePercent({
        ...project,
        sourceUtf16Length: 3,
        progress: { ...project.progress, coveredUtf16: 2 },
      }),
    ).toBe(66)
    expect(
      coveragePercent({
        ...project,
        sourceUtf16Length: 3,
        progress: { ...project.progress, coveredUtf16: 4 },
      }),
    ).toBe(100)
  })
})
