import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIPVideoRoutes } from '../api'
import {
  assetId,
  mergeAssets,
  partitionSource,
  resolveAssetId,
  resolveAssets,
  validateExtraction,
} from '../extraction'
import { fileManifest, migrateAliases } from '../migrate-aliases'
import { ProjectStore, atomicJson } from '../store'
import type { Chunk, IdentityConfirmation, Mention } from '../types'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function mention(
  name: string,
  aliases: string[] = [],
  quote = `${name}走进院子站在树下。`,
  start = 0,
): Mention {
  return {
    kind: 'character',
    name,
    aliases,
    description: name,
    evidence: {
      chapterId: `chapter-${start}`,
      chunkId: `chunk-${start}`,
      quote,
      start,
      end: start + quote.length,
      chapterOffset: 0,
    },
  }
}
function chunks(...mentions: Mention[]): Chunk[] {
  return mentions.map((m) => ({
    id: m.evidence.chunkId,
    chapterId: m.evidence.chapterId,
    start: m.evidence.start,
    end: m.evidence.end,
    status: 'succeeded',
    attempts: [],
    mentions: [m],
  }))
}
function confirmation(from: string, to: string): IdentityConfirmation {
  return {
    fromId: assetId('character', from),
    canonicalId: assetId('character', to),
    confirmedBy: 'user',
    confirmedAt: '2026-09-17T00:00:00.000Z',
    reason: `用户确认${from}与${to}为同人`,
  }
}

describe('conservative character alias resolution', () => {
  test('alias before real name, reverse completion order and repeated rebuild retain canonical ID', () => {
    const input = chunks(
      mention('阿青', [], undefined, 0),
      mention('沈青', ['阿青'], '沈青又名阿青，走进院子。', 100),
    )
    const result = resolveAssets(input)
    expect(result.assets).toHaveLength(1)
    expect(result.assets[0].name).toBe('沈青')
    expect(result.assets[0].id).toBe(assetId('character', '沈青'))
    expect(result.assets[0].aliases).toContain('阿青')
    expect(result.assets[0].evidence).toHaveLength(2)
    expect(resolveAssets([...input].reverse())).toEqual(result)
    expect(resolveAssets(input)).toEqual(result)
    expect(resolveAssetId(result, assetId('character', '阿青'))).toEqual(result.assets[0])
  })
  test('real name before alias has the same identity; aliases alone do not need separate entries', () => {
    const input = chunks(
      mention('沈青', ['阿青'], '沈青又名阿青，走进院子。'),
      mention('阿青', [], undefined, 100),
    )
    expect(mergeAssets(input)[0].id).toBe(assetId('character', '沈青'))
    expect(mergeAssets(input)).toHaveLength(1)
    expect(mergeAssets(input.slice(0, 1))[0].aliases).toContain('阿青')
  })
  test('deduplicates identical evidence while retaining distinct offsets and sources, and raw mentions', () => {
    const m = mention('阿青', [], '沈青又名阿青，走进院子。')
    const real = { ...m, name: '沈青', aliases: ['阿青'], description: '不同描述' }
    const input = chunks(m, real, structuredClone(m), mention('阿青', [], m.evidence.quote, 100))
    input.push({
      ...input[0],
      id: 'other-chunk',
      mentions: [{ ...m, evidence: { ...m.evidence, chunkId: 'other-chunk' } }],
    })
    const before = structuredClone(input)
    const [asset] = mergeAssets(input)
    expect(asset.evidence).toHaveLength(3)
    expect(asset.descriptions).toEqual(['阿青', '不同描述'])
    expect(input).toEqual(before)
  })
  test('all candidates are considered, including weak competing claims; no completion-order guess', () => {
    const first = chunks(
      mention('阿青'),
      mention('沈青', ['阿青'], '沈青又名阿青，走进院子。', 100),
    )
    expect(mergeAssets(first)).toHaveLength(1)
    const input = [...first, ...chunks(mention('柳青', ['阿青'], '柳青看见阿青走进院子。', 200))]
    const result = resolveAssets(input)
    expect(result.assets).toHaveLength(3)
    expect(result.identityResolution.redirects).toEqual({})
    expect(result.identityResolution.decisions[0].reason).toBe('ambiguous-alias')
  })
  test('common and qualified titles never auto merge even with explicit wording', () => {
    for (const alias of [
      '二爷',
      '夫人',
      '二奶奶',
      '四小姐',
      '侯爷',
      '骑奴',
      '泽二爷',
      '李夫人',
      '孙总管',
      '二嫂',
      '老二',
      '太子',
      '公主',
      '师兄',
    ]) {
      const result = resolveAssets(
        chunks(mention(alias), mention('沈青', [alias], `沈青人称${alias}，走进院子。`, 100)),
      )
      expect(result.assets).toHaveLength(2)
      expect(result.identityResolution.decisions[0].reason).toBe('generic-title')
    }
  })
  test('co-occurrence, negations, uncertain identity and unasserted prose are insufficient', () => {
    for (const quote of [
      '沈青遇见阿青，走进院子。',
      '沈青不是阿青，却说自己又名阿青。',
      '沈青又名阿青吗？',
      '据说沈青又名阿青。',
      '沈青又名阿青山，走进院子。',
      '柳沈青又名阿青，走进院子。',
    ]) {
      const result = resolveAssets(chunks(mention('阿青'), mention('沈青', ['阿青'], quote, 100)))
      expect(result.assets).toHaveLength(2)
      expect(result.identityResolution.decisions[0].reason).toBe('no-explicit-identity')
    }
  })
  test('chains, cycles and alias-only intersections do not propagate identity', () => {
    for (const input of [
      chunks(
        mention('阿青'),
        mention('小青', ['阿青'], '小青又名阿青。', 100),
        mention('沈青', ['小青'], '沈青又名小青。', 200),
      ),
      chunks(
        mention('阿青', ['沈青'], '阿青又名沈青。'),
        mention('沈青', ['阿青'], '沈青又名阿青。', 100),
      ),
      chunks(
        mention('柳青', ['阿青'], '柳青又名阿青。'),
        mention('沈青', ['阿青'], '沈青又名阿青。', 100),
      ),
    ])
      expect(mergeAssets(input)).toHaveLength(input.length)
  })
  test('locations and props keep exact-name behavior', () => {
    const input = chunks(mention('青山'), mention('苍山', ['青山'], '苍山又名青山。', 100))
    for (const chunk of input) chunk.mentions[0].kind = 'location'
    expect(mergeAssets(input)).toHaveLength(2)
  })
  test('confirmed reported pairs keep existing real-name IDs, both old IDs and all quotes', () => {
    const input = chunks(
      mention('泽二爷'),
      mention('泽二奶奶', [], undefined, 100),
      mention('顾承泽', ['泽二爷'], '顾承泽看见泽二爷的名字。', 200),
      mention('萧凤箫', ['泽二奶奶'], '萧凤箫看见泽二奶奶的名字。', 300),
    )
    const confirmations = [confirmation('泽二爷', '顾承泽'), confirmation('泽二奶奶', '萧凤箫')]
    const result = resolveAssets(input, confirmations)
    expect(result.assets.map((a) => a.name)).toEqual(['顾承泽', '萧凤箫'])
    for (const c of confirmations) {
      const asset = resolveAssetId(result, c.fromId)
      expect(asset?.id).toBe(c.canonicalId)
      expect(asset?.evidence).toHaveLength(2)
    }
    expect(result.identityResolution.confirmations).toEqual(confirmations)
    expect(result.identityResolution.decisions.every((d) => d.outcome === 'confirmed')).toBe(true)
    expect(() =>
      resolveAssets(input, [confirmations[0], confirmation('顾承泽', '泽二爷')]),
    ).toThrow('链或循环')
    expect(() =>
      resolveAssets(input, [confirmations[0], confirmation('泽二爷', '萧凤箫')]),
    ).toThrow('多个目标')
  })
})

test('migration backs up all files, preserves raw records, is idempotent and survives store saves/API old IDs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'alias-migration-'))
  directories.push(directory)
  let calls = 0
  const store = new ProjectStore(join(directory, 'projects'), async () => {
    calls++
    throw new Error('no model calls')
  })
  const source = '第1章\n泽二爷走进院子站在树下。\n第2章\n顾承泽看见泽二爷的名字写在纸上。'
  const project = store.import('测试', source)
  const parts = partitionSource(source)
  project.chunks = parts.chunks
  for (const [i, chunk] of project.chunks.entries()) {
    chunk.mentions = validateExtraction(
      JSON.stringify({
        assets: [
          {
            kind: 'character',
            name: i ? '顾承泽' : '泽二爷',
            aliases: i ? ['泽二爷'] : [],
            description: `description-${i}`,
            quote: source.slice(chunk.start, chunk.end).split('\n')[1],
          },
        ],
      }),
      source,
      chunk,
      project.chapters[i],
    )
    chunk.status = 'succeeded'
  }
  project.status = 'completed'
  project.assets = mergeAssets(project.chunks)
  atomicJson(join(store.directory(project.id), 'project.json'), project)
  const attemptPath = join(store.directory(project.id), 'attempts', 'untouched.json')
  writeFileSync(attemptPath, '{"request":{"messages":[]},"rawResponse":"original bytes"}\n')
  const raw = readFileSync(attemptPath, 'utf8')
  const before = fileManifest(store.directory(project.id))
  const confirmations = [confirmation('泽二爷', '顾承泽')]
  expect(migrateAliases(store, project.id, confirmations).applied).toBe(false)
  expect(fileManifest(store.directory(project.id))).toEqual(before)
  const migration = migrateAliases(store, project.id, confirmations, true)
  expect(migration.applied).toBe(true)
  if (!('backup' in migration) || !migration.backup) throw new Error('backup missing')
  expect(fileManifest(migration.backup)).toEqual(before)
  expect(migration.counts.beforeReferences).toBe(migration.counts.afterReferences)
  expect(readFileSync(attemptPath, 'utf8')).toBe(raw)
  const migrated = store.read(project.id)
  expect(migrated.chunks).toEqual(project.chunks)
  expect(migrated.assets).toHaveLength(1)
  expect(migrateAliases(store, project.id, confirmations, true).changed).toBe(false)
  await new ProjectStore(store.root).start(project.id)
  expect(store.read(project.id).assets).toEqual(migrated.assets)
  expect(store.read(project.id).identityResolution).toEqual(migrated.identityResolution)
  const app = createIPVideoRoutes(store)
  const reply = await app.request(`/projects/${project.id}/assets/${confirmations[0].fromId}`)
  expect(reply.status).toBe(200)
  expect((await reply.json()).id).toBe(confirmations[0].canonicalId)
  expect((await app.request(`/projects/${project.id}/assets/missing`)).status).toBe(404)
  writeFileSync(join(store.directory(project.id), 'run.lock'), JSON.stringify({ pid: process.pid }))
  expect(() => migrateAliases(store, project.id, confirmations, true)).toThrow()
  expect(readFileSync(join(store.directory(project.id), 'run.lock'), 'utf8')).toContain(
    String(process.pid),
  )
  expect(calls).toBe(0)
})
