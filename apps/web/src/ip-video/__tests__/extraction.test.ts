import { describe, expect, test } from 'bun:test'
import {
  CHUNK_LIMIT,
  ValidationError,
  mergeAssets,
  partitionSource,
  validateExtraction,
} from '../extraction'

describe('IP video lossless chapters and evidence', () => {
  test('reports every invalid asset and each quote failure without returning a valid subset', () => {
    const source = '第1章\n陈实牵着白马走进侯府的庭院。'
    const { chunks, chapters } = partitionSource(source)
    const valid = {
      kind: 'character',
      name: '陈实',
      aliases: [],
      description: '牵马',
      quote: '陈实牵着白马走进侯府的庭院。',
    }
    const invalid = [
      { ...valid, quote: '假引用', aliases: ['大将军'] },
      { ...valid, quote: '陈实'.repeat(81) },
      { ...valid, name: '张三' },
      { ...valid, aliases: ['白马', '大将军', '陈大'] },
      { ...valid, aliases: '错误字段' },
    ]
    try {
      validateExtraction(
        JSON.stringify({ assets: [valid, ...invalid] }),
        source,
        chunks[0],
        chapters[0],
      )
      throw new Error('Expected whole-chunk rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError)
      if (!(error instanceof ValidationError)) throw error
      expect(error.rejectedQuotes).toBe(4)
      expect(error.issues.map((issue) => issue.asset)).toEqual(invalid)
      expect(error.issues.map((issue) => issue.index)).toEqual([1, 2, 3, 4, 5])
      expect(error.issues[0].reasons).toHaveLength(4)
      expect(error.issues[0].reasons.join(' ')).toContain('实际3个UTF-16')
      expect(error.issues[0].reasons.join(' ')).toContain('quote不存在')
      expect(error.issues[0].reasons.join(' ')).toContain('name不在quote')
      expect(error.issues[0].reasons.join(' ')).toContain('aliases未在同一个quote')
      expect(error.issues[1].reasons.join(' ')).toContain('实际162个UTF-16')
      expect(error.issues[2].reasons).toHaveLength(1)
      expect(error.issues[3].reasons).toEqual([
        'aliases未在同一个quote中：["大将军","陈大"]；不满足请留空[]',
      ])
      expect(error.issues[4].reasons).toEqual(['资产字段格式无效'])
      for (const asset of invalid) expect(error.message).toContain(JSON.stringify(asset))
    }
  })

  test('retains preface, CRLF, Chinese numerals, long paragraphs and astral characters', () => {
    const source = `书名\r\n作者\r\n第1章 开始\r\n${'陈实骑马😀。'.repeat(700)}\n第二章 后续\n不截断结尾。`
    const { chapters, chunks } = partitionSource(source)
    expect(chapters.map((c) => c.number)).toEqual([null, 1, 2])
    expect(chunks.map((c) => source.slice(c.start, c.end)).join('')).toBe(source)
    expect(chunks.every((c) => c.end - c.start <= CHUNK_LIMIT)).toBe(true)
    expect(chunks.every((c) => !/[\uD800-\uDBFF]$/.test(source.slice(c.start, c.end)))).toBe(true)
    expect(partitionSource('没有标题的完整小说').chapters.length).toBe(1)
    expect(() => partitionSource('   ')).toThrow()
  })

  test('rejects changed punctuation, fabricated names and out-of-chunk quotes', () => {
    const source =
      '第1章 初见\n陈实牵着白马走进侯府的庭院。\n第2章 离开\n陈实拿起佩刀离开侯府的庭院。'
    const { chapters, chunks } = partitionSource(source)
    const asset = {
      kind: 'character',
      name: '陈实',
      aliases: [],
      description: '牵马',
      quote: '陈实牵着白马走进侯府的庭院。',
    }
    const content = (patch = {}) => JSON.stringify({ assets: [{ ...asset, ...patch }] })
    const mentions = validateExtraction(content(), source, chunks[0], chapters[0])
    expect(source.slice(mentions[0].evidence.start, mentions[0].evidence.end)).toBe(asset.quote)
    expect(mentions[0].evidence.chapterOffset).toBe(source.indexOf('陈实'))
    expect(() =>
      validateExtraction(
        content({ quote: '陈实牵着白马走进侯府的庭院!' }),
        source,
        chunks[0],
        chapters[0],
      ),
    ).toThrow('引用')
    expect(() =>
      validateExtraction(content({ name: '张三' }), source, chunks[0], chapters[0]),
    ).toThrow('引用')
    expect(() =>
      validateExtraction(content({ aliases: ['大将军'] }), source, chunks[0], chapters[0]),
    ).toThrow('引用')
    expect(() =>
      validateExtraction(
        content({ quote: '陈实拿起佩刀离开侯府的庭院。' }),
        source,
        chunks[0],
        chapters[0],
      ),
    ).toThrow('引用')
    expect(() => validateExtraction('```json\n{}\n```', source, chunks[0], chapters[0])).toThrow(
      'JSON',
    )
  })

  test('stable exact-name IDs are independent of completion order and alias co-occurrence is not merged', () => {
    const source = '第1章\n陈实与陈大，在庭院里牵着白马。\n第2章\n陈大将军拿着佩刀走进了屋子。'
    const { chapters, chunks } = partitionSource(source)
    for (let i = 0; i < chunks.length; i++) {
      chunks[i].mentions = validateExtraction(
        JSON.stringify({
          assets: [
            {
              kind: 'character',
              name: i ? '陈大' : '陈实',
              aliases: i ? [] : ['陈大'],
              description: '人物',
              quote: i ? '陈大将军拿着佩刀走进了屋子。' : '陈实与陈大，在庭院里牵着白马。',
            },
          ],
        }),
        source,
        chunks[i],
        chapters[i],
      )
      chunks[i].status = 'succeeded'
    }
    expect(mergeAssets(chunks)).toEqual(mergeAssets([...chunks].reverse()))
    expect(mergeAssets(chunks)).toHaveLength(2)
    const first = mergeAssets(chunks)[0].id
    chunks[1].mentions = chunks[0].mentions
    const assets = mergeAssets(chunks)
    expect(assets).toHaveLength(1)
    expect(assets[0].id).toBe(first)
    expect(assets[0].evidence).toHaveLength(1)
  })
})

test('quote IDs expand only exact source options and keep legacy name/alias/length checks', async () => {
  const { extractionQuoteOptions } = await import('../extraction')
  const source = '甲'.repeat(80) + '玄铁刀放在案上，记录当日发生的事情。' + '乙'.repeat(180)
  const { chapters, chunks } = partitionSource(source)
  const option = extractionQuoteOptions(source).find((o) => o.start === 80)!
  const asset = {
    kind: 'prop',
    name: '玄铁刀',
    aliases: [],
    description: 'fixture',
    quoteId: option.id,
  }
  const parse = (value: unknown) =>
    validateExtraction(JSON.stringify({ assets: [value] }), source, chunks[0], chapters[0])
  expect(parse(asset)[0].evidence.start).toBe(80)
  expect(parse(asset)[0].evidence.quote).toBe(option.quote)
  for (const patch of [
    { quoteId: 'foreign-id' },
    { quote: option.quote + '。' },
    { name: '不存在的刀' },
    { aliases: ['虚构别名'] },
  ])
    expect(() => parse({ ...asset, ...patch })).toThrow()
})
