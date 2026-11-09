import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createIPVideoRoutes } from '../api'
import {
  entityBase,
  entityFrames,
  rebuildEntityAssets,
  runEntityResolution,
} from '../entity-resolution'
import type { EntityFrame } from '../entity-resolution'
import {
  MODEL,
  assetId,
  evidenceKey,
  resolveAssetId,
  resolveAssets,
  validateExtraction,
} from '../extraction'
import { mentionAddress } from '../identity-ledger'
import { fileManifest, verifyAliasMigration } from '../migrate-aliases'
import { resolveExistingEntities } from '../resolve-entities'
import { ProjectStore, atomicJson } from '../store'
import type { EntityVerdict, Project } from '../types'

const roots: string[] = []
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})
function sample(names: string[], lines: string[], descriptions = lines) {
  const parent = resolve('workspace/zero-feishu')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'anonymous-test-'))
  roots.push(root)
  const store = new ProjectStore(join(root, 'projects'))
  const source = lines.map((line, i) => `第${i + 1}章\n${line}\n`).join('')
  const { progress: _, ...project } = store.import('anonymous fixture', source)
  for (const [i, c] of project.chunks.entries()) {
    const line = lines[i].split('\n')[0]
    c.mentions = validateExtraction(
      JSON.stringify({
        assets: [
          {
            kind: 'character',
            name: names[i],
            aliases: [],
            description: descriptions[i],
            quote: line,
          },
        ],
      }),
      source,
      c,
      project.chapters[i],
    )
    c.status = 'succeeded'
  }
  project.status = 'completed'
  Object.assign(project, resolveAssets(project.chunks))
  atomicJson(join(store.directory(project.id), 'project.json'), project)
  return { root, store, source, project }
}
function identity(p: Project) {
  if (!p.identityResolution) throw new Error('missing identity')
  return p.identityResolution
}
function runState(p: Project) {
  const ai = identity(p).ai
  if (!ai) throw new Error('missing ai')
  return ai
}
function answer(f: EntityFrame, target?: string): EntityVerdict {
  const own = f.contexts.filter((c) => f.subjectContextIds.includes(c.id))
  const targetContext = f.contexts.find((c) => c.assetId === target)
  return {
    outcome: target ? 'match' : 'unresolved',
    canonicalId: target ?? null,
    candidateIds: target ? [target] : [],
    reason: 'fixture reasoning only; not real Qwen acceptance',
    evidence: [
      ...own.map((c) => ({ contextId: c.id, quote: c.originalQuote })),
      ...(targetContext
        ? [{ contextId: targetContext.id, quote: targetContext.originalQuote }]
        : []),
    ],
  }
}
function reply(f: EntityFrame, target?: string) {
  return Response.json({
    model: MODEL,
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer(f, target)) } }],
  })
}
async function resolveFixture(
  p: Project,
  source: string,
  ids: string[],
  choose: (f: EntityFrame) => string | undefined,
) {
  await runEntityResolution(p, source, ids, {
    transport: async (_url, init) => {
      const f = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
      return reply(f, choose(f))
    },
    save: () => {
      Object.assign(p, rebuildEntityAssets(p))
    },
    artifact: () => {},
  })
  Object.assign(p, rebuildEntityAssets(p))
}

test('anonymous reveal across chapters retrieves narrative and semantic candidate context beyond extraction quote', () => {
  const { project, source } = sample(
    ['女子', '路人', '沈青'],
    [
      '女子在桥下教林舟练霜剑，左腕有一处月牙伤痕。',
      '路人从桥下走过，他并不认识那位蒙面的剑客。',
      `沈青站在窗旁静静望着河水，迟迟没有说话。\n${'雨落在窗外。'.repeat(60)}\n沈青就是当初在桥下教林舟霜剑的女子，左腕月牙伤痕未变。`,
    ],
  )
  const f = entityFrames(project, source, assetId('character', '女子'))[0]
  expect(f.subject.localIdentity).toBeDefined()
  expect(f.subject.descriptions[0]).toContain('月牙')
  expect(f.contexts.some((c) => c.text.includes('沈青就是当初'))).toBe(true)
  expect(f.contexts.some((c) => c.id.startsWith('neighbor:'))).toBe(true)
  expect(f.catalog.some((c) => c.name === '沈青')).toBe(true)
  for (const c of f.contexts) expect(source.slice(c.start, c.start + c.text.length)).toBe(c.text)
})

test('two women resolve separately, preserve every mention, never register a global woman alias or redirect', async () => {
  const { project, source } = sample(
    ['女子', '女子', '沈青', '陆红'],
    [
      '女子在桥下教林舟练霜剑，左腕有一处月牙伤痕。',
      '女子在市集售卖鲜花，她右手缺指，从不习武。',
      '沈青就是桥下教林舟霜剑的女子，左腕留着月牙伤痕。',
      '陆红就是市集卖花的女子，右手缺指，与沈青毫无关系。',
    ],
  )
  const before = structuredClone(project)
  const generic = assetId('character', '女子')
  const scoped = entityBase(project).assets.filter((a) => a.localIdentity?.legacyId === generic)
  expect(scoped).toHaveLength(2)
  await resolveFixture(project, source, [generic], (f) =>
    assetId('character', f.subject.descriptions[0].includes('桥下') ? '沈青' : '陆红'),
  )
  expect(project.assets).toHaveLength(2)
  expect(project.assets.map((a) => a.evidence.length)).toEqual([2, 2])
  expect(project.assets.every((a) => !a.aliases.includes('女子'))).toBe(true)
  expect(resolveAssetId(project, generic)).toBeUndefined()
  expect(verifyAliasMigration(before, project).afterReferences).toBe(4)
  for (const a of scoped)
    expect(resolveAssetId(project, a.id)?.evidence).toContainEqual(a.evidence[0])
  expect(rebuildEntityAssets({ ...project, chunks: [...project.chunks].reverse() })).toEqual(
    rebuildEntityAssets(project),
  )
})

test('new unrelated generic mention cannot inherit a previously confirmed local identity', async () => {
  const { project, source } = sample(
    ['老人', '沈青', '老人'],
    [
      '老人在桥下打铁，左手有月牙伤痕，一直独居。',
      '沈青正是桥下的老人，他打了一辈子的铁。',
      '老人在异乡卖药，双手完好，与桥下铁匠素未谋面。',
    ],
  )
  const later = structuredClone(project.chunks[2])
  project.chunks[2].status = 'pending'
  project.chunks[2].mentions = []
  await resolveFixture(project, source, [assetId('character', '老人')], () =>
    assetId('character', '沈青'),
  )
  const confirmed = structuredClone(project.identityResolution?.commits)
  project.chunks[2] = later
  Object.assign(project, rebuildEntityAssets(project))
  expect(project.assets).toHaveLength(2)
  expect(project.assets.find((a) => a.name === '沈青')?.evidence).toHaveLength(2)
  expect(project.assets.find((a) => a.name === '老人')?.evidence).toHaveLength(1)
  expect(project.identityResolution?.commits).toEqual(confirmed)
  expect(resolveAssetId(project, assetId('character', '老人'))).toBeUndefined()
})

test('conflicting confirmed targets are audited, previous mapping survives; removed evidence is never silently redirected', async () => {
  const { project, source } = sample(
    ['女刺客', '沈青', '陆红'],
    [
      '女刺客在桥下教林舟练霜剑，左腕有月牙伤痕。',
      '沈青就是桥下的女刺客，左腕留着月牙伤痕。',
      '陆红在城外卖花，从未去过桥下，更不会使剑。',
    ],
  )
  await resolveFixture(project, source, [assetId('character', '女刺客')], () =>
    assetId('character', '沈青'),
  )
  const first = identity(project).commits?.[0]
  if (!first) throw new Error('missing commit')
  identity(project).commits?.push({
    ...first,
    id: 'conflicting',
    canonicalId: assetId('character', '陆红'),
    targetKeys: project.chunks[2].mentions.map((m) => evidenceKey(m.evidence)),
  })
  Object.assign(project, rebuildEntityAssets(project))
  expect(project.identityResolution?.conflicts).toContainEqual({
    commitId: 'conflicting',
    reason: 'conflicting-confirmed-target',
  })
  expect(resolveAssetId(project, first.fromId)?.name).toBe('沈青')
  project.chunks[0].mentions = []
  Object.assign(project, rebuildEntityAssets(project))
  expect(project.identityResolution?.conflicts?.some((c) => c.commitId === first.id)).toBe(true)
})

test('confirmed merges survive interrupted recovery, unrelated failed AI run, repeat rebuild and start without extraction', async () => {
  const { project, source, store } = sample(
    ['女子', '沈青'],
    ['女子在桥下教林舟练剑，左腕留有月牙伤痕。', '沈青就是桥下那名教林舟练剑的女子。'],
  )
  await resolveFixture(project, source, [assetId('character', '女子')], () =>
    assetId('character', '沈青'),
  )
  const expected = structuredClone(project.assets)
  project.status = 'running'
  runState(project).status = 'running'
  atomicJson(join(store.directory(project.id), 'project.json'), project)
  store.recover()
  store.recover()
  expect(store.read(project.id).assets).toEqual(expected)
  const restored = store.read(project.id)
  runState(restored).status = 'failed'
  runState(restored).decisions = []
  Object.assign(restored, rebuildEntityAssets(restored))
  expect(restored.assets).toEqual(expected)
  expect(rebuildEntityAssets(restored).assets).toEqual(expected)
  const app = createIPVideoRoutes(store)
  const response = await app.request(
    `/projects/${project.id}/assets/${assetId('character', '女子')}`,
  )
  expect(response.status).toBe(200)
  expect((await response.json()).name).toBe('沈青')
})

test('migration lock prevents concurrent writer and recovery; staged retries are idempotent with full backup and reference conservation', async () => {
  const { project, source, store, root } = sample(
    ['女子', '沈青'],
    ['女子在桥下教林舟练剑，左腕留有月牙伤痕。', '沈青就是桥下那名教林舟练剑的女子。'],
  )
  const dir = store.directory(project.id)
  const manifest = fileManifest(dir)
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const options = {
    apply: true,
    workRoot: join(root, 'jobs'),
    transport: async (_url: string, init?: RequestInit) => {
      calls++
      await gate
      return reply(
        JSON.parse(JSON.parse(String(init?.body)).messages[1].content),
        assetId('character', '沈青'),
      )
    },
  }
  const pending = resolveExistingEntities(
    store,
    project.id,
    [assetId('character', '女子')],
    options,
  )
  expect(calls).toBe(1)
  await expect(
    resolveExistingEntities(store, project.id, [assetId('character', '女子')], options),
  ).rejects.toThrow()
  expect(() => new ProjectStore(store.root).start(project.id)).toThrow('另一个进程')
  new ProjectStore(store.root).recover()
  expect(fileManifest(dir)).toEqual(manifest)
  release?.()
  const result = await pending
  expect(result.applied).toBe(true)
  if (!('backup' in result) || !result.backup) throw new Error('missing backup')
  expect(fileManifest(result.backup)).toEqual(manifest)
  const after = store.read(project.id)
  expect(verifyAliasMigration(project, after).afterReferences).toBe(2)
  expect(
    after.identityResolution?.mentionRedirects?.[
      mentionAddress(
        assetId('character', '女子'),
        evidenceKey(project.chunks[0].mentions[0].evidence),
      )
    ],
  ).toBe(assetId('character', '沈青'))
  const again = await resolveExistingEntities(
    store,
    project.id,
    [assetId('character', '女子')],
    options,
  )
  expect(again.changed).toBe(false)
  expect(calls).toBe(2)
  expect(readFileSync(join(dir, 'source.txt'), 'utf8')).toBe(source)
  await new ProjectStore(store.root, async () => {
    throw new Error('must not extract')
  }).start(project.id)
  expect(store.read(project.id).assets).toEqual(after.assets)
})

test('legacy complete stale audit can restore confirmed merge; partial failed run made stale cannot be promoted', async () => {
  const { project, source } = sample(
    ['女子', '沈青', '陆红'],
    [
      '女子在桥下教林舟练剑，左腕留有月牙伤痕。',
      '沈青就是桥下那名教林舟练剑的女子。',
      '陆红在城外卖花，从未去过桥下，更不会使剑。',
    ],
  )
  await resolveFixture(project, source, [assetId('character', '女子')], () =>
    assetId('character', '沈青'),
  )
  const expected = structuredClone(project.assets)
  const resolution = identity(project)
  const run = structuredClone(runState(project))
  run.version = 'ai-entity-v1'
  const legacy = assetId('character', '女子')
  run.subjectIds = [legacy]
  run.decisions[0].fromId = legacy
  for (const attempt of run.attempts) attempt.subjectId = legacy
  run.status = 'stale'
  resolution.aiHistory = [run]
  resolution.ai = undefined
  resolution.commits = []
  Object.assign(project, rebuildEntityAssets(project))
  expect(project.assets).toEqual(expected)
  expect(identity(project).commits).toHaveLength(1)
  identity(project).commits = []
  run.subjectIds.push(assetId('character', '陆红'))
  identity(project).aiHistory = [run]
  Object.assign(project, rebuildEntityAssets(project))
  expect(project.assets).toHaveLength(3)
  expect(identity(project).commits).toHaveLength(0)
})

test('a narrow retry never inherits a failed whole-project subject list', async () => {
  const { project, source } = sample(
    ['女子', '沈青', '陆红'],
    [
      '女子在桥下教林舟练剑，左腕留有月牙伤痕。',
      '沈青就是桥下那名教林舟练剑的女子。',
      '陆红在城外卖花，从未去过桥下，更不会使剑。',
    ],
  )
  await resolveFixture(
    project,
    source,
    entityBase(project).assets.map((a) => a.id),
    () => undefined,
  )
  runState(project).status = 'failed'
  const called: string[] = []
  await resolveFixture(project, source, [assetId('character', '女子')], (f) => {
    called.push(f.subject.name)
    return assetId('character', '沈青')
  })
  expect(called).toEqual(['女子', '女子'])
  expect(runState(project).subjectIds).toHaveLength(1)
  expect(identity(project).aiHistory).toHaveLength(1)
})

test('local split retains named aliases on their own mention and conserves descriptions', () => {
  const { project } = sample(
    ['老人', '老人'],
    [
      '老人在寺外敲钟，众人称他韩松，却不知他的来历。',
      '老人在异乡卖药，双手完好，他从未见过那个敲钟人。',
    ],
  )
  project.chunks[0].mentions[0].aliases = ['韩松']
  Object.assign(project, resolveAssets(project.chunks))
  const after = { ...project, ...rebuildEntityAssets(project) }
  expect(verifyAliasMigration(project, after).afterReferences).toBe(2)
  expect(after.assets.filter((a) => a.aliases.includes('韩松'))).toHaveLength(1)
  expect(after.assets.find((a) => a.aliases.includes('韩松'))?.evidence[0].chapterId).toBe(
    project.chapters[0].id,
  )
})

test('replaying a staged preview cannot erase a confirmation committed by another migration', async () => {
  const { store, project, root } = sample(
    ['女子', '沈青', '老人', '韩松'],
    [
      '女子在桥下教林舟练剑，左腕留有月牙伤痕。',
      '沈青就是桥下那名教林舟练剑的女子。',
      '老人在寺外独自敲钟，左手有六根手指。',
      '韩松就是寺外那位六指老人，村长喊出了他的名字。',
    ],
  )
  const options = {
    workRoot: join(root, 'jobs'),
    transport: async (_url: string, init?: RequestInit) => {
      const f = JSON.parse(JSON.parse(String(init?.body)).messages[1].content)
      return reply(f, assetId('character', f.subject.name === '女子' ? '沈青' : '韩松'))
    },
  }
  await resolveExistingEntities(store, project.id, [assetId('character', '女子')], options)
  await resolveExistingEntities(store, project.id, [assetId('character', '老人')], {
    ...options,
    apply: true,
  })
  await resolveExistingEntities(store, project.id, [assetId('character', '女子')], {
    ...options,
    apply: true,
  })
  const after = store.read(project.id)
  expect(after.assets).toHaveLength(2)
  expect(after.identityResolution?.commits).toHaveLength(2)
  expect(after.identityResolution?.conflicts).toHaveLength(0)
  expect(verifyAliasMigration(project, after).afterReferences).toBe(4)
})
