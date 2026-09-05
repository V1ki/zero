import { describe, expect, test } from 'bun:test'
import {
  buildMemoryFieldTokens,
  calibrateVectorScore,
  computeLexicalScores,
  tokenizeForLexical,
} from '../scoring'

describe('tokenizeForLexical', () => {
  test('CJK runs become bigrams', () => {
    expect(tokenizeForLexical('视频下载')).toEqual(['视频', '频下', '下载'])
  })

  test('single CJK char run is kept as-is', () => {
    expect(tokenizeForLexical('好')).toEqual(['好'])
  })

  test('latin tokens keep composites and add dot/hyphen sub-tokens', () => {
    expect(tokenizeForLexical('yt-dlp')).toEqual(['yt-dlp', 'yt', 'dlp'])
    expect(tokenizeForLexical('api.fxtwitter.com')).toContain('fxtwitter')
    expect(tokenizeForLexical('api.fxtwitter.com')).toContain('api.fxtwitter.com')
  })

  test('case-insensitive and deduped; length-1 latin tokens dropped', () => {
    expect(tokenizeForLexical('ASR asr a')).toEqual(['asr'])
  })
})

describe('computeLexicalScores', () => {
  test('empty query tokens or empty candidates score zero', () => {
    expect(computeLexicalScores([], [{ strong: new Set(['x']), content: new Set() }])).toEqual([0])
    expect(computeLexicalScores(['x'], [])).toEqual([])
  })

  test('strong-field hit counts full, content-only hit discounted to 0.6', () => {
    const scores = computeLexicalScores(
      ['asr'],
      [
        { strong: new Set(['asr']), content: new Set() },
        { strong: new Set(), content: new Set(['asr']) },
      ],
    )
    // 池内两条都含 asr → idf 相同;strong=1.0,content=0.6*idf/(idf)=0.6
    expect(scores[0]).toBeCloseTo(1, 3)
    expect(scores[1]).toBeCloseTo(0.6, 3)
  })

  test('rare tokens outweigh common tokens within the pool', () => {
    const query = tokenizeForLexical('yt-dlp video')
    const scores = computeLexicalScores(query, [
      { strong: new Set(['video', 'download']), content: new Set() }, // 只有常见 token
      { strong: new Set(['video', 'yt-dlp', 'yt', 'dlp']), content: new Set() }, // 持有稀有 token
      { strong: new Set(['cooking']), content: new Set() },
    ])
    expect(scores[1]).toBeCloseTo(1, 3)
    expect(scores[0]).toBeGreaterThan(0)
    expect(scores[0]).toBeLessThan(scores[1])
    expect(scores[2]).toBe(0)
  })

  test('memory field tokens include title/tags/type in strong set', () => {
    const tokens = buildMemoryFieldTokens({
      title: 'Deploy API gateway',
      tags: ['nginx', 'deploy'],
      content: 'connection pool exhausted',
      type: 'note',
    })
    expect(tokens.strong.has('deploy')).toBe(true)
    expect(tokens.strong.has('nginx')).toBe(true)
    expect(tokens.strong.has('note')).toBe(true)
    expect(tokens.content.has('exhausted')).toBe(true)
    expect(tokens.strong.has('exhausted')).toBe(false)
  })
})

describe('calibrateVectorScore', () => {
  test('maps [floor, ceiling] onto [0, 1] and clamps outside', () => {
    expect(calibrateVectorScore(0.35, 0.35, 0.75)).toBe(0)
    expect(calibrateVectorScore(0.55, 0.35, 0.75)).toBeCloseTo(0.5, 3)
    expect(calibrateVectorScore(0.75, 0.35, 0.75)).toBe(1)
    expect(calibrateVectorScore(0.95, 0.35, 0.75)).toBe(1)
    expect(calibrateVectorScore(0.1, 0.35, 0.75)).toBe(0)
  })

  test('degenerate anchor range degrades to a hard cutoff', () => {
    expect(calibrateVectorScore(0.75, 0.75, 0.75)).toBe(1)
    expect(calibrateVectorScore(0.74, 0.75, 0.75)).toBe(0)
  })
})
