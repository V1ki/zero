import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createIPVideoRoutes } from '../api'
import {
  checkpointVerifiedMatches,
  entityFrames,
  rebuildEntityAssets,
  runEntityResolution,
  validateEntityVerdict,
} from '../entity-resolution'
import type { EntityFrame } from '../entity-resolution'
import { MODEL, assetId, resolveAssetId, resolveAssets, validateExtraction } from '../extraction'
import { fileManifest, verifyAliasMigration } from '../migrate-aliases'
import { resolveExistingEntities } from '../resolve-entities'
import { ProjectStore, atomicJson } from '../store'
import type { AssetKind, EntityVerdict, Project } from '../types'

const roots: string[] = []
function root() {
  const path = mkdtempSync(join(resolve('.zero/workspace/zero-feishu'), 'entity-test-'))
  roots.push(path)
  return path
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})
function seed(kind: AssetKind, names: string[], lines?: string[]) {
  const store = new ProjectStore(join(root(), 'projects'))
  const source = names
    .map((name, i) => `第${i + 1}章\n${lines?.[i] ?? `${name}出现在庭院之中，记录了此次相遇。`}\n`)
    .join('')
  const p = store.import('test', source)
  for (const [i, chunk] of p.chunks.entries()) {
    chunk.mentions = validateExtraction(
      JSON.stringify({
        assets: [
          {
            kind,
            name: names[i],
            aliases: [],
            description: `描述-${i}`,
            quote: source.slice(chunk.start, chunk.end).split('\n')[1],
          },
        ],
      }),
      source,
      chunk,
      p.chapters[i],
    )
    chunk.status = 'succeeded'
  }
  p.status = 'completed'
  Object.assign(p, resolveAssets(p.chunks))
  // Store Project rather than its API-only progress field.
  const { progress: _progress, ...project } = p
  atomicJson(join(store.directory(p.id), 'project.json'), project)
  return { store, source, project }
}
function verdict(
  frame: EntityFrame,
  target?: string,
  outcome: EntityVerdict['outcome'] = target ? 'match' : 'new',
): EntityVerdict {
  return {
    outcome,
    canonicalId: outcome === 'match' ? (target ?? null) : null,
    candidateIds: target ? [target] : [],
    reason: 'fixture identity reasoning, not real AI evidence',
    evidence: frame.contexts
      .filter((c) => frame.subjectContextIds.includes(c.id) || c.assetId === target)
      .map((c) => ({ contextId: c.id, quote: c.text.slice(0, 400) })),
  }
}
function reply(v: EntityVerdict) {
  return Response.json({
    model: MODEL,
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(v) } }],
  })
}
async function run(
  project: Project,
  source: string,
  ids: string[],
  choose: (frame: EntityFrame & { phase: string }) => EntityVerdict,
) {
  let calls = 0
  const artifacts: unknown[] = []
  await runEntityResolution(project, source, ids, {
    transport: async (_url, init) => {
      calls++
      const body = JSON.parse(String(init?.body))
      return reply(choose(JSON.parse(body.messages[1].content)))
    },
    save: () => {},
    artifact: (_relative, value) => {
      artifacts.push(structuredClone(value))
    },
  })
  Object.assign(project, rebuildEntityAssets(project))
  return { calls, artifacts }
}

test('same person, location abbreviation and prop alias; both chapter orders retain canonical and old IDs', async () => {
  for (const [kind, alias, full] of [
    ['character', '阿青', '沈青'],
    ['location', '侯府', '靖安侯府'],
    ['prop', '黑刃', '玄铁刀'],
  ] as const) {
    for (const names of [
      [alias, full],
      [full, alias],
    ]) {
      const { project, source } = seed(kind, names)
      const before = structuredClone(project)
      const target = assetId(kind, full)
      const from = assetId(kind, alias)
      const result = await run(project, source, [from], (f) => verdict(f, target))
      expect(result.calls).toBe(2) // proposal plus independent verify
      expect(project.assets).toHaveLength(1)
      expect(project.assets[0].id).toBe(target)
      expect(resolveAssetId(project, from)?.id).toBe(target)
      expect(project.assets[0].descriptions).toHaveLength(2)
      expect(project.chunks).toEqual(before.chunks)
      expect(verifyAliasMigration(before, project).afterReferences).toBe(2)
      expect((await run(project, source, [from], (f) => verdict(f, target))).calls).toBe(0)
      expect(rebuildEntityAssets({ ...project, chunks: [...project.chunks].reverse() })).toEqual(
        rebuildEntityAssets(project),
      )
    }
  }
})

test('frames contain canonical IDs, aliases and bounded source context, full same-kind competition, no foreign project', () => {
  const { project, source } = seed('location', ['侯府', '靖安侯府', '定远侯府', '赵府'])
  const [frame] = entityFrames(project, source, assetId('location', '侯府'))
  expect(frame.catalog.map((a) => a.name).sort()).toEqual(['定远侯府', '赵府', '靖安侯府'].sort())
  expect(frame.catalog.every((a) => a.canonicalId.startsWith('asset-') && a.evidence.length)).toBe(
    true,
  )
  expect(
    frame.contexts.every((c) => source.slice(c.start, c.start + c.text.length) === c.text),
  ).toBe(true)
  expect(() => entityFrames(project, source, assetId('location', '外部项目'))).toThrow('当前项目')
})

test('structured output rejects invented/foreign IDs, wrong kind, no evidence, changed quotes and multiple matches', () => {
  const { project, source } = seed('location', ['侯府', '靖安侯府', '定远侯府'])
  const [frame] = entityFrames(project, source, assetId('location', '侯府'))
  const target = assetId('location', '靖安侯府')
  const valid = verdict(frame, target)
  expect(validateEntityVerdict(JSON.stringify(valid), frame)).toEqual(valid)
  for (const patch of [
    { canonicalId: 'model-invented', candidateIds: ['model-invented'] },
    {
      canonicalId: assetId('character', '靖安侯府'),
      candidateIds: [assetId('character', '靖安侯府')],
    },
    { evidence: [] },
    { candidateIds: [target, assetId('location', '定远侯府')] },
    {
      evidence: [
        { contextId: frame.subjectContextIds[0], quote: '侯府这里是模型编造的不存在引用。' },
      ],
    },
    { evidence: valid.evidence.filter((e) => !e.contextId.startsWith('subject:')) },
    { evidence: valid.evidence.filter((e) => e.contextId.startsWith('subject:')) },
    { outcome: 'new' },
  ])
    expect(() => validateEntityVerdict(JSON.stringify({ ...valid, ...patch }), frame)).toThrow()
  expect(() =>
    validateEntityVerdict(JSON.stringify(valid), { ...frame, catalogComplete: false }),
  ).toThrow('截断')
})

test('ambiguous candidates, reviewer disagreement and mixed page identities never merge', async () => {
  for (const mode of ['ambiguous', 'disagree', 'pages']) {
    const { project, source } = seed('location', [
      ...Array.from({ length: mode === 'pages' ? 9 : 1 }, () => '侯府'),
      '靖安侯府',
      '定远侯府',
    ])
    const from = assetId('location', '侯府')
    const target = assetId('location', '靖安侯府')
    await run(project, source, [from], (f) => {
      if (mode === 'ambiguous')
        return {
          ...verdict(f, undefined, 'unresolved'),
          candidateIds: f.catalog.map((c) => c.canonicalId),
        }
      if ((mode === 'disagree' && f.phase === 'verify') || (mode === 'pages' && f.page === 1))
        return verdict(f, undefined, 'unresolved')
      return verdict(f, target)
    })
    expect(project.assets).toHaveLength(3)
    expect(project.identityResolution?.ai?.decisions[0].outcome).toBe('unresolved')
  }
})

test('later chapter evidence retains confirmed merges while new evaluation keeps its audit', async () => {
  const { project, source } = seed('location', ['侯府', '靖安侯府', '定远侯府'])
  const later = structuredClone(project.chunks[2])
  project.chunks[2].status = 'pending'
  project.chunks[2].mentions = []
  const from = assetId('location', '侯府')
  await run(project, source, [from], (f) => verdict(f, assetId('location', '靖安侯府')))
  expect(project.assets).toHaveLength(1)
  project.chunks[2] = later
  Object.assign(project, rebuildEntityAssets(project))
  expect(project.assets).toHaveLength(2)
  expect(project.identityResolution?.commits).toHaveLength(1)
  expect(project.identityResolution?.ai?.status).toBe('stale')
  await run(project, source, [from], (f) => verdict(f, undefined, 'unresolved'))
  expect(project.assets).toHaveLength(2)
  expect(project.identityResolution?.aiHistory).toHaveLength(1)
})

test('chains and cycles remain unresolved regardless of decision ordering', async () => {
  const { project, source } = seed('prop', ['甲刀', '乙刀', '丙刀'])
  const ids = project.assets.map((a) => a.id).sort()
  await run(project, source, ids, (f) =>
    verdict(f, ids[(ids.indexOf(f.subject.id) + 1) % ids.length]),
  )
  expect(project.assets).toHaveLength(3)
  expect(project.identityResolution?.ai?.decisions.every((d) => d.outcome === 'unresolved')).toBe(
    true,
  )
})

test('migration backs up before model call; retries resume cached pages, preserve original bytes and old-ID API', async () => {
  const { store, source, project } = seed('location', ['侯府', '靖安侯府', '定远侯府'])
  const dir = store.directory(project.id)
  writeFileSync(join(dir, 'attempts', 'original.json'), '{"rawResponse":"immutable"}\n')
  const manifest = fileManifest(dir)
  const workRoot = root()
  const from = assetId('location', '侯府')
  const target = assetId('location', '靖安侯府')
  let broken = true
  let proposals = 0
  let verifications = 0
  const transport = async (_url: string, init?: RequestInit) => {
    const f = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
    if (f.phase === 'propose') proposals++
    else verifications++
    if (broken && f.phase === 'verify') throw new Error('fixture transport outage')
    return reply(verdict(f, target))
  }
  await expect(
    resolveExistingEntities(store, project.id, [from], { apply: true, workRoot, transport }),
  ).rejects.toThrow('outage')
  expect(fileManifest(dir)).toEqual(manifest)
  expect(existsSync(join(dir, 'run.lock'))).toBe(false)
  broken = false
  const result = await resolveExistingEntities(store, project.id, [from], {
    apply: true,
    workRoot,
    transport,
  })
  expect(proposals).toBe(1)
  expect(verifications).toBe(4)
  if (!('backup' in result) || !result.backup) throw new Error('backup missing')
  expect(fileManifest(result.backup)).toEqual(manifest)
  const after = store.read(project.id)
  expect(verifyAliasMigration(project, after).afterReferences).toBe(3)
  expect(after.assets.find((a) => a.name === '定远侯府')).toEqual(
    project.assets.find((a) => a.name === '定远侯府'),
  )
  expect(
    await resolveExistingEntities(store, project.id, [from], { apply: true, workRoot, transport }),
  ).toMatchObject({ changed: false })
  const app = createIPVideoRoutes(store)
  const old = await (await app.request(`/projects/${project.id}/assets/${from}`)).json()
  const canonical = await (await app.request(`/projects/${project.id}/assets/${target}`)).json()
  expect(old).toEqual(canonical)
  await new ProjectStore(store.root, async () => {
    throw new Error('unexpected request')
  }).start(project.id)
  expect(store.read(project.id).assets).toEqual(after.assets)
  expect(store.source(project.id)).toBe(source)
  writeFileSync(join(dir, 'run.lock'), '{"pid":123}')
  await expect(
    resolveExistingEntities(store, project.id, [from], { workRoot, transport }),
  ).rejects.toThrow()
})

test('extraction injects existing canonical catalog and automatically invokes structured post-extraction AI', async () => {
  const { store: initial, project, source } = seed('prop', ['黑刃', '玄铁刀'])
  project.chunks[1].status = 'pending'
  project.chunks[1].mentions = []
  Object.assign(project, resolveAssets(project.chunks))
  atomicJson(join(initial.directory(project.id), 'project.json'), project)
  let injected = false
  let identityCalls = 0
  const store = new ProjectStore(
    initial.root,
    async (url, init) => {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: MODEL }] })
      const body = JSON.parse(String(init?.body))
      const f = JSON.parse(body.messages[1].content)
      if (f.phase) {
        identityCalls++
        return reply(f.subject.name === '黑刃' ? verdict(f, assetId('prop', '玄铁刀')) : verdict(f))
      }
      expect(f.identityContext.candidates[0].canonicalId).toBe(assetId('prop', '黑刃'))
      expect(f.identityContext.candidates[0].evidence).toHaveLength(1)
      expect(f.identityContext.projectId).toBe(project.id)
      injected = true
      return Response.json({
        model: MODEL,
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                assets: [
                  {
                    kind: 'prop',
                    name: '玄铁刀',
                    aliases: [],
                    description: '刀',
                    quote: f.text.split('\n')[1],
                  },
                ],
              }),
            },
          },
        ],
      })
    },
    1000,
    0,
  )
  await store.start(project.id)
  expect(injected).toBe(true)
  expect(identityCalls).toBe(3)
  expect(store.read(project.id).assets).toHaveLength(1)
  expect(store.read(project.id).status).toBe('completed')
  expect(readFileSync(join(store.directory(project.id), 'source.txt'), 'utf8')).toBe(source)
})

test('no-evidence output, wrong model, truncated response and body timeout cannot commit a decision', async () => {
  for (const mode of ['empty', 'wrong-model', 'truncated', 'timeout']) {
    const { project, source } = seed('prop', ['黑刃', '玄铁刀'])
    const before = structuredClone(project)
    let calls = 0
    await expect(
      runEntityResolution(project, source, [assetId('prop', '黑刃')], {
        transport: async (_url, init) => {
          calls++
          if (mode === 'timeout') return new Promise<Response>(() => {})
          const f = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
          const v = verdict(f, assetId('prop', '玄铁刀'))
          return Response.json({
            model: mode === 'wrong-model' ? 'different' : MODEL,
            choices: [
              {
                finish_reason: mode === 'truncated' ? 'length' : 'stop',
                message: { content: JSON.stringify(mode === 'empty' ? { ...v, evidence: [] } : v) },
              },
            ],
          })
        },
        save: () => {},
        artifact: () => {},
        timeoutMs: 5,
      }),
    ).rejects.toThrow('消歧失败')
    expect(calls).toBe(3)
    expect(rebuildEntityAssets(project).assets).toEqual(before.assets)
    expect(project.identityResolution?.ai?.status).toBe('failed')
  }
})

test('interrupted verification resumes the saved proposal and records interrupted request separately', async () => {
  const { project, source } = seed('prop', ['黑刃', '玄铁刀'])
  const from = assetId('prop', '黑刃')
  const target = assetId('prop', '玄铁刀')
  await run(project, source, [from], (f) => verdict(f, target))
  const ai = project.identityResolution?.ai
  if (!ai) throw new Error('missing run')
  ai.status = 'running'
  const verify = ai.attempts.find((a) => a.phase === 'verify')
  if (!verify) throw new Error('missing verification')
  verify.status = 'running'
  verify.verdict = undefined
  ai.decisions = []
  // Simulate a crash before any confirmation was committed.
  project.identityResolution!.commits = []
  project.identityResolution!.aiHistory = []
  const result = await run(project, source, [from], (f) => verdict(f, target))
  expect(result.calls).toBe(1)
  expect(ai.attempts.find((a) => a.id === verify.id)?.status).toBe('interrupted')
  expect(project.assets).toHaveLength(1)
})

test('AI cannot expand a human-confirmed group and source tampering is rejected before calls', async () => {
  const { project, source } = seed('character', ['阿青', '沈青', '青爷'])
  const from = assetId('character', '阿青')
  const canonical = assetId('character', '沈青')
  Object.assign(
    project,
    resolveAssets(project.chunks, [
      {
        fromId: from,
        canonicalId: canonical,
        confirmedBy: 'user',
        confirmedAt: '2026-09-17T00:00:00Z',
        reason: '历史人工确认',
      },
    ]),
  )
  const before = structuredClone(project)
  const extra = assetId('character', '青爷')
  await run(project, source, [extra], (f) => verdict(f, canonical))
  expect(project.assets).toHaveLength(2)
  expect(project.identityResolution?.confirmations).toEqual(
    before.identityResolution?.confirmations,
  )
  expect(project.identityResolution?.ai?.decisions[0].outcome).toBe('unresolved')
  expect(resolveAssetId(project, from)?.id).toBe(canonical)
  let calls = 0
  await expect(
    runEntityResolution(project, `${source}篡改`, [extra], {
      transport: async () => {
        calls++
        throw new Error('unexpected')
      },
      save: () => {},
      artifact: () => {},
    }),
  ).rejects.toThrow('hash')
  expect(calls).toBe(0)
})

test('self ID stays forbidden, failed subject does not block others, reopen only retries failed pages', async () => {
  const { project, source } = seed('prop', ['甲刀', '乙刀', '丙刀'])
  const ids = project.assets.map((a) => a.id).sort()
  const calls: string[] = []
  const artifacts: unknown[] = []
  let broken = true
  const io = {
    transport: async (_url: string, init?: RequestInit) => {
      const f = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
      calls.push(f.subject.id)
      if (broken && f.subject.id === ids[0]) {
        if (calls.length > 1) expect(f.previousError).toContain('subject自身')
        return reply({
          ...verdict(f),
          outcome: 'match',
          canonicalId: f.subject.id,
          candidateIds: [f.subject.id],
        })
      }
      return reply(verdict(f))
    },
    save: () => {},
    artifact: (_path: string, value: unknown) => {
      artifacts.push(structuredClone(value))
    },
  }
  await expect(runEntityResolution(project, source, ids, io)).rejects.toThrow('未完整完成')
  expect(calls).toEqual([ids[0], ids[0], ids[0], ids[1], ids[2]])
  expect(project.identityResolution?.ai?.failures?.map((f) => f.subjectId)).toEqual([ids[0]])
  expect(project.identityResolution?.ai?.decisions).toHaveLength(2)
  expect(project.identityResolution?.ai?.status).toBe('failed')
  expect(artifacts).toHaveLength(10)
  broken = false
  const reopened = structuredClone(project)
  await runEntityResolution(reopened, source, ids, io)
  expect(calls).toHaveLength(6)
  expect(reopened.identityResolution?.ai?.status).toBe('completed')
  expect(reopened.identityResolution?.ai?.failures).toEqual([])
  expect(reopened.identityResolution?.ai?.decisions).toHaveLength(3)
})

test('verified match survives failed full scope and new extraction snapshot without another model call', async () => {
  const { project, source } = seed('prop', ['甲刀', '乙刀', '丙刀', '丁刀'])
  const later = structuredClone(project.chunks[3])
  project.chunks[3].status = 'pending'
  project.chunks[3].mentions = []
  Object.assign(project, resolveAssets(project.chunks))
  const from = assetId('prop', '甲刀')
  const target = assetId('prop', '乙刀')
  const bad = assetId('prop', '丙刀')
  await expect(
    run(project, source, [from, bad], (f) =>
      f.subject.id === bad
        ? { ...verdict(f), canonicalId: 'invalid', candidateIds: ['invalid'], outcome: 'match' }
        : verdict(f, target),
    ),
  ).rejects.toThrow('未完整完成')
  expect(project.identityResolution?.commits).toHaveLength(1)
  expect(project.identityResolution?.ai?.status).toBe('failed')
  project.chunks[3] = later
  Object.assign(project, rebuildEntityAssets(project))
  const calls: string[] = []
  await run(project, source, [from, bad], (f) => {
    calls.push(f.subject.id)
    return verdict(f)
  })
  expect(calls).toEqual([bad])
  expect(project.identityResolution?.commits).toHaveLength(1)
  expect(resolveAssetId(project, from)?.id).toBe(target)
})

test('legacy failed run recovery requires every proposal and verification page, and rejects cycles', async () => {
  const { project, source } = seed('prop', [...Array.from({ length: 9 }, () => '甲刀'), '乙刀'])
  const from = assetId('prop', '甲刀')
  const target = assetId('prop', '乙刀')
  await run(project, source, [from], (f) => verdict(f, target))
  const runState = project.identityResolution!.ai!
  runState.status = 'failed'
  project.identityResolution!.commits = []
  project.identityResolution!.aiHistory = []
  const incomplete = structuredClone(project)
  incomplete.identityResolution!.ai!.attempts = runState.attempts.filter((a) => a.page !== 1)
  checkpointVerifiedMatches(incomplete, source)
  expect(incomplete.identityResolution?.commits).toHaveLength(0)
  checkpointVerifiedMatches(project, source)
  expect(project.identityResolution?.commits).toHaveLength(1)
  checkpointVerifiedMatches(project, source)
  expect(project.identityResolution?.commits).toHaveLength(1)
  const cyclic = structuredClone(incomplete)
  cyclic.identityResolution!.ai!.attempts = runState.attempts
  cyclic.identityResolution!.ai!.decisions.push({
    ...runState.decisions[0],
    fromId: target,
    canonicalId: from,
  })
  checkpointVerifiedMatches(cyclic, source)
  expect(cyclic.identityResolution?.commits).toHaveLength(0)
})

test('no-queue store resume covers remaining subjects and persists failed identity state', async () => {
  const { store: seeded, project } = seed('prop', ['甲刀', '乙刀', '丙刀'])
  const ids = project.assets.map((a) => a.id).sort()
  const seen: string[] = []
  let broken = true
  const store = new ProjectStore(seeded.root, async (_url, init) => {
    const f = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
    seen.push(f.subject.id)
    return reply(
      broken && f.subject.id === ids[0] ? { ...verdict(f), candidateIds: ['invalid'] } : verdict(f),
    )
  })
  const before = structuredClone(project.chunks)
  await expect(store.start(project.id)).rejects.toThrow('未完整完成')
  expect(store.read(project.id).status).toBe('failed')
  expect(store.read(project.id).identityResolution?.ai?.failures).toHaveLength(1)
  expect(new Set(seen)).toEqual(new Set(ids))
  broken = false
  await store.start(project.id)
  expect(seen).toHaveLength(6)
  expect(store.read(project.id).status).toBe('completed')
  expect(store.read(project.id).chunks).toEqual(before)
})

test('store retries only three failed chunks, checkpoints legacy matches before snapshot changes', async () => {
  const { store: seeded, project, source } = seed('prop', ['甲刀', '乙刀', '丙刀', '丁刀', '戊刀'])
  const originals = structuredClone(project.chunks)
  for (const chunk of project.chunks.slice(2)) {
    chunk.status = 'failed'
    chunk.mentions = []
    chunk.error = 'fixture extraction failure'
  }
  Object.assign(project, resolveAssets(project.chunks))
  const from = assetId('prop', '甲刀')
  const target = assetId('prop', '乙刀')
  await run(project, source, [from], (f) => verdict(f, target))
  // On-disk legacy crash: validated decisions/pages exist, but no durable commit yet.
  const identity = project.identityResolution
  if (!identity?.ai) throw new Error('Missing fixture identity journal')
  identity.ai.status = 'failed'
  identity.commits = []
  identity.aiHistory = []
  project.status = 'failed'
  atomicJson(join(seeded.directory(project.id), 'project.json'), project)
  const extracted: string[] = []
  const reviewed: string[] = []
  const store = new ProjectStore(
    seeded.root,
    async (url, init) => {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: MODEL }] })
      const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
      if (input.phase) {
        reviewed.push(input.subject.id)
        return reply(verdict(input))
      }
      const chunk = originals.find((c) => c.start === input.start && c.end === input.end)!
      extracted.push(chunk.id)
      expect(project.identityResolution!.ai!.snapshot).toBeDefined()
      const saved = store.read(project.id)
      expect(saved.identityResolution?.commits).toHaveLength(1)
      return Response.json({
        model: MODEL,
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                assets: chunk.mentions.map((m) => ({
                  kind: m.kind,
                  name: m.name,
                  aliases: m.aliases,
                  description: m.description,
                  quote: m.evidence.quote,
                })),
              }),
            },
          },
        ],
      })
    },
    1000,
    0,
  )
  await store.start(project.id, { retryFailed: true })
  const saved = store.read(project.id)
  expect(extracted.sort()).toEqual(
    originals
      .slice(2)
      .map((c) => c.id)
      .sort(),
  )
  expect(saved.chunks.slice(0, 2)).toEqual(originals.slice(0, 2))
  expect(reviewed).not.toContain(from)
  expect(
    saved.identityResolution?.aiHistory?.some(
      (r) => r.status === 'failed' && r.decisions.some((d) => d.fromId === from),
    ),
  ).toBe(true)
  expect(saved.identityResolution?.commits).toHaveLength(1)
  expect(resolveAssetId(saved, from)?.id).toBe(target)
  expect(saved.status).toBe('completed')
})

test('store does not trust completed status with a stale snapshot or recorded subject failure', async () => {
  for (const corruption of ['snapshot', 'failures'] as const) {
    const { store: seeded, project, source } = seed('prop', ['甲刀', '乙刀'])
    const ids = project.assets.map((a) => a.id)
    await run(project, source, ids, (f) => verdict(f))
    const ai = project.identityResolution?.ai
    if (!ai) throw new Error('Missing fixture identity journal')
    if (corruption === 'snapshot') ai.snapshot = 'older-extraction'
    else {
      ai.failures = [{ subjectId: ids[0], error: 'previous failure', at: 'fixture' }]
      ai.attempts = ai.attempts.filter((a) => a.subjectId !== ids[0])
      ai.decisions = ai.decisions.filter((d) => d.fromId !== ids[0])
    }
    atomicJson(join(seeded.directory(project.id), 'project.json'), project)
    let calls = 0
    const store = new ProjectStore(seeded.root, async (_url, init) => {
      calls++
      const f = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
      return reply({ ...verdict(f), candidateIds: ['outside-whitelist'] })
    })
    await expect(store.start(project.id)).rejects.toThrow('未完整完成')
    expect(calls).toBeGreaterThan(0)
    expect(store.read(project.id).status).toBe('failed')
    expect(store.read(project.id).identityResolution?.ai?.status).toBe('failed')
  }
})

test('persistence failures abort rather than becoming isolated model failures', async () => {
  const { project, source } = seed('prop', ['甲刀', '乙刀'])
  let calls = 0
  await expect(
    runEntityResolution(
      project,
      source,
      project.assets.map((a) => a.id),
      {
        transport: async (_url, init) => {
          calls++
          return reply(verdict(JSON.parse(JSON.parse(String(init?.body)).messages[1].content)))
        },
        save: () => {},
        artifact: () => {
          throw new Error('fixture disk full')
        },
      },
    ),
  ).rejects.toThrow('fixture disk full')
  expect(calls).toBe(0)
  expect(project.identityResolution?.ai?.status).toBe('failed')
  expect(project.identityResolution?.ai?.failures).toEqual([])
})

test('store cannot report completed while a failed identity journal remains without competitors', async () => {
  const { store: seeded, project, source } = seed('prop', ['甲刀'])
  await run(
    project,
    source,
    project.assets.map((a) => a.id),
    (f) => verdict(f),
  )
  const ai = project.identityResolution?.ai
  if (!ai) throw new Error('Missing fixture identity journal')
  ai.status = 'failed'
  ai.failures = [{ subjectId: project.assets[0].id, error: 'fixture failure', at: 'fixture' }]
  atomicJson(join(seeded.directory(project.id), 'project.json'), project)
  const store = new ProjectStore(seeded.root, async () => {
    throw new Error('Unexpected call')
  })
  await store.start(project.id)
  expect(store.read(project.id).status).toBe('failed')
  expect(store.read(project.id).error).toContain('身份审查未完整完成')
})

test('evidence IDs preserve exact occurrence, coverage and target checks without repairing quotes', () => {
  const { project, source } = seed('location', ['西坡', '十里坡'])
  const frame = entityFrames(project, source, assetId('location', '西坡'))[0]
  const target = assetId('location', '十里坡')
  const own = frame.contexts.find((c) => c.id === 'subject:0')!
  // A repeated sentence earlier in the same context must not steal the offset.
  own.text = `${own.originalQuote}\n${own.originalQuote}`
  own.originalStart = own.start + own.originalQuote.length + 1
  const input = {
    ...verdict(frame, target),
    evidence: [{ evidenceId: 'subject:0:original' }, { evidenceId: `${target}:0:original` }],
  }
  const expanded = validateEntityVerdict(JSON.stringify(input), frame)
  expect(expanded.evidence[0].quote).toBe(own.originalQuote)
  expect(expanded.evidence[0].contextId).toBe('subject:0')
  for (const evidence of [
    [{ evidenceId: 'nonexistent' }],
    [{ evidenceId: 'subject:0:original', quote: '自动改写不能通过校验' }],
    [{ evidenceId: 'subject:0:original', contextId: `${target}:0` }],
    [{ evidenceId: 'subject:0:original' }], // target evidence still mandatory
    [{ evidenceId: `${target}:0:original` }], // all subject mentions still mandatory
  ])
    expect(() => validateEntityVerdict(JSON.stringify({ ...input, evidence }), frame)).toThrow()
})

test('targeted chunk changes snapshot but never reruns successful out-of-scope decisions', async () => {
  const { store: initialStore, project, source } = seed('prop', ['青石', '红石', '白石', '黑石'])
  await run(
    project,
    source,
    project.assets.map((a) => a.id),
    (f) => verdict(f),
  )
  const originalRun = structuredClone(project.identityResolution!.ai!)
  project.chunks[3].status = 'failed'
  project.chunks[3].mentions = []
  project.status = 'failed'
  atomicJson(join(initialStore.directory(project.id), 'project.json'), project)
  const successfulChunks = structuredClone(project.chunks.slice(0, 3))
  const subjectIds = [assetId('prop', '青石')]
  const requests: string[] = []
  const store = new ProjectStore(
    initialStore.root,
    async (url, init) => {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: MODEL }] })
      const q = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
      if (!q.phase) {
        requests.push('extract')
        expect(q.start).toBe(project.chunks[3].start)
        const option = q.quoteOptions[0]
        return Response.json({
          model: MODEL,
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  assets: [
                    {
                      kind: 'prop',
                      name: '黑石',
                      aliases: [],
                      description: 'fixture',
                      quoteId: option.id,
                    },
                  ],
                }),
              },
            },
          ],
        })
      }
      requests.push(q.subject.id)
      expect(subjectIds).toContain(q.subject.id)
      return reply(verdict(q))
    },
    100,
    0,
  )
  await store.start(project.id, {
    retryFailed: true,
    targeted: { chunkIds: [project.chunks[3].id], subjectIds },
  })
  const after = store.read(project.id)
  expect(requests).toEqual(['extract', subjectIds[0]])
  expect(after.chunks.slice(0, 3)).toEqual(successfulChunks)
  expect(after.identityResolution!.aiHistory).toContainEqual(originalRun)
  expect(after.identityResolution!.ai!.subjectIds).toEqual(subjectIds)
  expect(after.status).toBe('interrupted') // explicit scope is not full-book acceptance
  requests.length = 0
  await store.start(project.id, {
    retryFailed: true,
    targeted: { chunkIds: [project.chunks[3].id], subjectIds },
  })
  expect(requests).toEqual([])
  const bytes = readFileSync(join(store.directory(project.id), 'project.json'), 'utf8')
  await expect(
    store.start(project.id, { targeted: { chunkIds: ['outside'], subjectIds } }),
  ).rejects.toThrow('范围')
  expect(readFileSync(join(store.directory(project.id), 'project.json'), 'utf8')).toBe(bytes)
  await expect(
    store.start(project.id, {
      targeted: { chunkIds: [], subjectIds, expectedProjectSha256: 'changed-after-backup' },
    }),
  ).rejects.toThrow('备份快照不一致')
  expect(readFileSync(join(store.directory(project.id), 'project.json'), 'utf8')).toBe(bytes)
})

test('explicit committed review calls the model on a copy and does not alter the source commit', async () => {
  const { project, source } = seed('character', ['护卫', '沈青'])
  const from = project.assets.find((a) => a.name === '护卫')!.id
  const target = assetId('character', '沈青')
  await run(project, source, [from], (f) => verdict(f, target))
  const before = structuredClone(project)
  const review = structuredClone(project)
  let calls = 0
  await runEntityResolution(review, source, [from], {
    reviewCommitted: true,
    transport: async (_url, init) => {
      calls++
      return reply(
        verdict(
          JSON.parse(JSON.parse(String(init?.body)).messages[1].content),
          undefined,
          'unresolved',
        ),
      )
    },
    save: () => {},
    artifact: () => {},
  })
  expect(calls).toBe(1)
  expect(review.identityResolution!.ai!.decisions[0].outcome).toBe('unresolved')
  expect(project).toEqual(before)
})
