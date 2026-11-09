import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIPVideoRoutes } from '../api'
import {
  entityBase,
  entityEvidenceOptions,
  entityFrames,
  rebuildEntityAssets,
  runEntityResolution,
  validateEntityVerdict,
} from '../entity-resolution'
import { MODEL, assetId, evidenceKey, hash, resolveAssetId, resolveAssets } from '../extraction'
import { localAssetId, mentionAddress } from '../identity-ledger'
import { appendCorrection, verifyCorrectionSource } from '../quality-corrections'
import { ProjectStore, atomicJson } from '../store'
import type { AssetKind, QualityCorrection } from '../types'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function seed() {
  const root = mkdtempSync(join(tmpdir(), 'ip-quality-'))
  roots.push(root)
  const store = new ProjectStore(root)
  const names = ['护卫', '护卫', '阿青', '山庄', '金币', '碎金', '女子']
  const lines = [
    '护卫奉命守护少年，后来揭名阿青。',
    '护卫拦路袭击，阿青出剑，两人交手。',
    '阿青就是当初指导少年练剑的女子。',
    '山庄表示拒绝，将来不再提供资助。',
    '金币作为报酬，交给了城里的工匠。',
    '碎金作为饭钱，交给了路边的店家。',
    '女子耐心指导少年练剑，传授诀窍。',
  ]
  const source = lines.map((s, i) => `第${i + 1}章\n${s}\n`).join('')
  const { progress: _, ...project } = store.import('fixture', source)
  project.chunks.forEach((c, i) => {
    c.status = 'succeeded'
    if (i === 6) return
    const start = source.indexOf(lines[i])
    const kind: AssetKind = i >= 4 ? 'prop' : 'character'
    c.mentions = [
      {
        kind,
        name: names[i],
        aliases: [],
        description: lines[i],
        evidence: {
          chapterId: c.chapterId,
          chunkId: c.id,
          start,
          end: start + lines[i].length,
          chapterOffset: start - project.chapters[i].start,
          quote: lines[i],
        },
      },
    ]
  })
  Object.assign(project, resolveAssets(project.chunks))
  const role = assetId('character', '护卫')
  const target = assetId('character', '阿青')
  const from = entityBase(project).assets.find((a) => a.id === role)!
  const to = project.assets.find((a) => a.id === target)!
  project.identityResolution!.commits = [
    {
      id: 'bad-old',
      fromId: role,
      canonicalId: target,
      sourceSha256: hash(source),
      subjectKeys: from.evidence.map(evidenceKey),
      targetKeys: to.evidence.map(evidenceKey),
      reason: 'fixture deliberately wrong',
      evidence: from.evidence,
      confirmedAt: project.createdAt,
    },
  ]
  Object.assign(project, rebuildEntityAssets(project))
  const add = (operation: QualityCorrection['operation'], evidence = from.evidence) =>
    appendCorrection(project, source, {
      at: project.createdAt,
      reviewer: 'test-source-review',
      provenance: 'source-review',
      reason: 'fixture source review',
      evidence,
      operation,
    })
  return { store, source, project, role, target, from, to, add, lines }
}
test('retraction survives JSON persistence and legacy completed-run recovery; split preserves each old-ID reference', async () => {
  const { project, source, role, target, from, add, store } = seed()
  const raw = JSON.stringify(project.chunks)
  const old = structuredClone(project.identityResolution!.commits!)
  project.identityResolution!.ai = {
    version: 'ai-entity-v2',
    snapshot: 'old',
    subjectIds: [role],
    status: 'completed',
    attempts: [
      {
        id: 'v',
        key: 'k',
        subjectId: role,
        page: 0,
        phase: 'verify',
        status: 'succeeded',
        responseFile: 'fixture',
        verdict: {
          outcome: 'match',
          canonicalId: target,
          candidateIds: [target],
          reason: 'wrong historical',
          evidence: [],
        },
      },
    ],
    decisions: [
      {
        fromId: role,
        canonicalId: target,
        outcome: 'match',
        reason: 'wrong historical',
        evidence: from.evidence,
      },
    ],
  }
  add({ type: 'retract', commitId: 'bad-old' })
  add({ type: 'localize', fromId: role, evidenceKeys: from.evidence.map(evidenceKey) })
  const first = localAssetId(role, evidenceKey(from.evidence[0]))
  const enemy = localAssetId(role, evidenceKey(from.evidence[1]))
  add({ type: 'distinct', leftId: enemy, rightId: target }, [from.evidence[1]])
  add(
    {
      type: 'assign',
      fromId: first,
      canonicalId: target,
      evidenceKeys: [evidenceKey(from.evidence[0])],
    },
    [from.evidence[0]],
  )
  for (let i = 0; i < 3; i++) {
    Object.assign(project, rebuildEntityAssets(JSON.parse(JSON.stringify(project))))
  }
  expect(project.identityResolution!.commits).toEqual(old)
  expect(JSON.stringify(project.chunks)).toBe(raw)
  expect(project.assets.find((a) => a.id === target)!.evidence.length).toBe(2)
  expect(project.assets.find((a) => a.id === enemy)!.evidence).toEqual([from.evidence[1]])
  expect(resolveAssetId(project, role)).toBeUndefined()
  expect(resolveAssetId(project, role, evidenceKey(from.evidence[1]))!.id).toBe(enemy)
  expect(
    project.identityResolution!.mentionRedirects![
      mentionAddress(role, evidenceKey(from.evidence[0]))
    ],
  ).toBe(target)
  atomicJson(join(store.directory(project.id), 'project.json'), project)
  expect(rebuildEntityAssets(store.read(project.id)).assets).toEqual(project.assets)
  const api = createIPVideoRoutes(store)
  expect((await api.request(`/projects/${project.id}/assets/${role}`)).status).toBe(409)
  const response = await api.request(
    `/projects/${project.id}/assets/${role}?evidenceKey=${encodeURIComponent(evidenceKey(from.evidence[1]))}`,
  )
  expect((await response.json()).id).toBe(enemy)
  verifyCorrectionSource(project, source)
  const frame = entityFrames(project, source, enemy)[0]
  expect(() =>
    validateEntityVerdict(
      JSON.stringify({
        outcome: 'match',
        canonicalId: target,
        candidateIds: [target],
        reason: 'must refuse combat',
        evidence: [{ evidenceId: 'subject:0:original' }],
      }),
      frame,
    ),
  ).toThrow('不同人')
})
test('supplement/retype retain raw provenance, exact source, old IDs and reviewed reveal contexts', () => {
  const { project, source, lines, add, store } = seed()
  const raw = JSON.stringify(project.chunks)
  const house = project.chunks[3].mentions[0]
  const ch = project.chapters[6]
  const chunk = project.chunks[6]
  const start = source.indexOf(lines[6])
  add(
    {
      type: 'retype',
      fromId: assetId('character', '山庄'),
      evidenceKey: evidenceKey(house.evidence),
      kind: 'location',
      interpretation: '以所在地转喻势力，不是自然人',
    },
    [house.evidence],
  )
  const mention = {
    kind: 'character' as const,
    name: '女子',
    aliases: [],
    description: 'source review supplement',
    evidence: {
      chapterId: ch.id,
      chunkId: chunk.id,
      start,
      end: start + lines[6].length,
      chapterOffset: start - ch.start,
      quote: lines[6],
    },
  }
  add({ type: 'supplement', mention }, [mention.evidence, project.chunks[2].mentions[0].evidence])
  Object.assign(project, rebuildEntityAssets(project))
  expect(JSON.stringify(project.chunks)).toBe(raw)
  expect(resolveAssetId(project, assetId('character', '山庄'))!.kind).toBe('location')
  const woman = entityBase(project).assets.find((a) => a.name === '女子')!
  expect(
    entityFrames(project, source, woman.id)[0].contexts.some(
      (c) => c.id.startsWith('review:') && c.text === lines[2],
    ),
  ).toBe(true)
  expect(project.assets.reduce((n, a) => n + a.evidence.length, 0)).toBe(7)
  atomicJson(join(store.directory(project.id), 'project.json'), project)
  expect(rebuildEntityAssets(store.read(project.id)).assets).toEqual(project.assets)
  expect(project.qualityCorrections![1].provenance).toBe('source-review')
  expect(() => add({ type: 'supplement', mention }, [mention.evidence])).toThrow('重复')
  const corrupted = structuredClone(project)
  corrupted.qualityCorrections![0].reason = 'tampered'
  expect(() => rebuildEntityAssets(corrupted)).toThrow('审计链')
  expect(() => verifyCorrectionSource(project, `${source}changed`)).toThrow('hash')
})
test('category projection changes neither identity nor references and rejects cross-kind groups', () => {
  const { project, add } = seed()
  const before = JSON.stringify(project.assets)
  add(
    {
      type: 'category',
      label: '金质货币',
      memberIds: [assetId('prop', '金币'), assetId('prop', '碎金')],
    },
    project.chunks.slice(4, 6).flatMap((c) => c.mentions.map((m) => m.evidence)),
  )
  Object.assign(project, rebuildEntityAssets(project))
  expect(JSON.stringify(project.assets)).toBe(before)
  expect(project.categoryGroups?.[0].memberIds.length).toBe(2)
  add({
    type: 'category',
    label: 'invalid',
    memberIds: [assetId('character', '阿青'), assetId('prop', '金币')],
  })
  expect(() => rebuildEntityAssets(project)).toThrow('类别')
})
test('narrative options are precomputed exact bounded windows; invented IDs and changed quotes remain rejected', () => {
  const { project, source, target } = seed()
  const f = entityFrames(project, source, target)[0]
  f.contexts.push({
    ...f.contexts[0],
    id: 'narrative:fixture',
    originalQuote: '',
    text: `🐎${source.repeat(15)}`,
    start: 0,
    originalStart: 0,
  })
  const options = entityEvidenceOptions(f).filter((o) => o.contextId === 'narrative:fixture')
  expect(options.length).toBeGreaterThan(2)
  const v = (e: unknown) =>
    JSON.stringify({
      outcome: 'new',
      canonicalId: null,
      candidateIds: [],
      reason: 'fixture evidence',
      evidence: [e],
    })
  for (const o of options) {
    expect(o.quote.length).toBeGreaterThanOrEqual(10)
    expect(o.quote.length).toBeLessThanOrEqual(400)
    expect(validateEntityVerdict(v({ evidenceId: o.evidenceId }), f).evidence[0].quote).toBe(
      o.quote,
    )
  }
  expect(() => validateEntityVerdict(v({ evidenceId: 'narrative:fixture:original' }), f)).toThrow(
    '存在=false',
  )
  expect(() =>
    validateEntityVerdict(v({ evidenceId: options[0].evidenceId, quote: 'changed' }), f),
  ).toThrow('不一致')
})
test('targeted model run and subsequent rebuild retain correction chain, history and known distinct boundary', async () => {
  const { project, source, role, from, target, add } = seed()
  add({ type: 'retract', commitId: 'bad-old' })
  add({ type: 'localize', fromId: role, evidenceKeys: from.evidence.map(evidenceKey) })
  const enemy = localAssetId(role, evidenceKey(from.evidence[1]))
  add({ type: 'distinct', leftId: enemy, rightId: target }, [from.evidence[1]])
  const corrections = JSON.stringify(project.qualityCorrections)
  let calls = 0
  await runEntityResolution(project, source, [enemy], {
    transport: async (_url, init) => {
      calls++
      const f = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
      expect(f.excludedCandidateIds).toContain(target)
      return new Response(
        JSON.stringify({
          model: MODEL,
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  outcome: 'new',
                  canonicalId: null,
                  candidateIds: [],
                  reason: 'fixture distinct combat',
                  evidence: [{ evidenceId: 'subject:0:original' }],
                }),
              },
            },
          ],
        }),
      )
    },
    save: () => {},
    artifact: () => {},
  })
  expect(calls).toBe(1)
  expect(JSON.stringify(project.qualityCorrections)).toBe(corrections)
  Object.assign(project, rebuildEntityAssets(project))
  expect(project.assets.find((a) => a.id === enemy)?.evidence).toEqual([from.evidence[1]])
})

test('reviewed different people cannot both merge through a third canonical identity', () => {
  const { project, role, target, from, add } = seed()
  add({ type: 'retract', commitId: 'bad-old' })
  add({ type: 'localize', fromId: role, evidenceKeys: from.evidence.map(evidenceKey) })
  const first = localAssetId(role, evidenceKey(from.evidence[0]))
  const enemy = localAssetId(role, evidenceKey(from.evidence[1]))
  add({ type: 'distinct', leftId: first, rightId: enemy }, [from.evidence[1]])
  const old = project.identityResolution?.commits?.[0]
  if (!old || !project.identityResolution?.commits) throw new Error('missing fixture')
  project.identityResolution.commits.push(
    {
      ...old,
      id: 'first',
      fromId: first,
      canonicalId: target,
      subjectKeys: [evidenceKey(from.evidence[0])],
    },
    {
      ...old,
      id: 'enemy',
      fromId: enemy,
      canonicalId: target,
      subjectKeys: [evidenceKey(from.evidence[1])],
    },
  )
  const result = rebuildEntityAssets(project)
  expect(result.identityResolution.conflicts).toContainEqual({
    commitId: 'enemy',
    reason: 'reviewed-distinct-entities',
  })
  expect(result.assets.find((a) => a.id === enemy)?.evidence).toEqual([from.evidence[1]])
})
