import { afterEach, expect, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import {
  type MandateArchive,
  type TriggerMandateSnapshot,
  TriggerSettingsConflictError,
} from '@zero-os/shared'
import { MandateInputError } from '../mandate-input'
import { createMandateService } from '../mandate-service'

const stores: TriggerStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
const target = {
  platform: 'dingtalk',
  channelId: 'work',
  peerId: 'group',
  operatorId: 'employee-1',
} as const
const archive = { channelId: 'research', documentId: 'A123' }
function snapshot(): TriggerMandateSnapshot {
  return {
    revision: 0,
    settings: {
      projects: [{ id: 'p', name: '发布', policy: { offDay: 'defer' } }],
      mandates: [
        {
          id: 'release',
          name: '发布进度',
          purpose: '分析发布受阻的原因',
          enabled: true,
          source: 'wxarc',
          scope: 'selected',
          keyword: '',
          projectId: 'p',
          targets: [target],
          archive,
          policy: {
            quietStart: '22:00',
            quietEnd: '07:00',
            digestMinutes: 30,
            dateOverrides: { '2028-02-29': 'work' },
          },
          deadline: '2026-05-08T17:00:00+08:00',
          urgent: false,
          groupBy: 'thread',
        },
      ],
    },
  }
}
function fixture(probe?: (archive: MandateArchive) => Promise<{ ok: boolean; reason: string }>) {
  const store = new TriggerStore(':memory:')
  stores.push(store)
  store.saveSettings(
    {
      github: { credentialRef: '', repositories: [] },
      wxarc: { sessions: [{ id: 'selected', name: '项目组', enabled: true, keyword: '' }] },
    },
    0,
  )
  let available = true
  let writable = true
  let wakes = 0
  let checks = 0
  const service = createMandateService({
    store,
    listTargets: () => (available ? [{ ...target, label: '项目组', secret: 'upstream data' }] : []),
    listArchiveChannels: () => ['research'],
    probeArchive: async (doc) => {
      checks++
      return probe ? probe(doc) : { ok: writable, reason: 'provider secret' }
    },
    runtime: {
      wakeDeferred() {
        wakes++
      },
      retry() {
        return false
      },
      preview() {
        return { decision: { destination: 'web', reason: '模拟' }, archive }
      },
    },
  })
  return {
    store,
    service,
    wakes: () => wakes,
    checks: () => checks,
    revoke() {
      available = false
      writable = false
    },
  }
}

test('saves one versioned configuration with independent recipient and document grants; exposes only public target fields', async () => {
  const f = fixture()
  expect(await f.service.targets()).toEqual({
    targets: [{ ...target, label: '项目组' }],
    archiveChannels: [{ channelId: 'research', label: 'research' }],
  })
  const saved = await f.service.saveConfig(snapshot())
  expect(saved.revision).toBe(1)
  expect(saved.settings.mandates[0].deadline).toBe('2026-05-08T09:00:00.000Z')
  expect(f.service.listAudit()).toHaveLength(1)
  expect(f.wakes()).toBe(1)
  await expect(f.service.saveConfig(snapshot())).rejects.toBeInstanceOf(
    TriggerSettingsConflictError,
  )
  expect(f.checks()).toBe(1)
  f.revoke()
  expect(await f.service.verifyDocument(archive)).toEqual({ writable: false })
  const paused = structuredClone(saved)
  paused.settings.mandates[0].enabled = false
  expect((await f.service.saveConfig(paused)).revision).toBe(2)
  paused.settings.mandates[0].enabled = true
  await expect(f.service.saveConfig({ ...paused, revision: 2 })).rejects.toBeInstanceOf(
    MandateInputError,
  )
  expect(f.service.getConfig().settings.mandates[0].enabled).toBe(false)
})

test('processing remains optional for older clients and both explicit modes round-trip through config', async () => {
  const { service } = fixture()
  let saved = await service.saveConfig(snapshot())
  expect(saved.settings.mandates[0].processing).toBeUndefined()
  for (const processing of ['direct', 'agent'] as const) {
    saved.settings.mandates[0].processing = processing
    saved = await service.saveConfig(saved)
    expect(service.getConfig().settings.mandates[0].processing).toBe(processing)
  }
})

test('rejects a target forged for another operator, platform, or chat, and denies arbitrary sources or archive capabilities', async () => {
  const f = fixture()
  for (const patch of [
    { scope: 'other' },
    { source: 'github', scope: 'acme/repo' },
    { projectId: 'other' },
    { targets: [{ ...target, operatorId: 'other' }] },
    { targets: [{ ...target, operatorId: undefined }] },
    { targets: [{ ...target, platform: 'feishu' }] },
    { targets: [{ ...target, peerId: 'different' }] },
    { targets: [target, target] },
    { archive: { ...archive, channelId: 'unbound' } },
    { archive: { ...archive, documentId: 'https://private.example/doc' } },
    { deadline: '2027-02-29T12:00:00Z' },
    { deadline: '2028-02-29T12:00:00' },
    { urgent: 'true' },
    { policy: { quietStart: '21:00' } },
    { policy: { digestMinutes: -1 } },
    { policy: { offDay: 'email' } },
    { policy: { dateOverrides: { '2027-02-29': 'work' } } },
    { policy: { dateOverrides: { '2028-02-29': 'holiday' } } },
    { policy: { unsafe: true } },
    { groupBy: 'room' },
    { processing: 'execute' },
    { processing: null },
  ]) {
    const data = snapshot()
    Object.assign(data.settings.mandates[0], patch)
    await expect(f.service.saveConfig(data)).rejects.toBeInstanceOf(MandateInputError)
  }
  const data = snapshot()
  data.settings.projects.push(data.settings.projects[0])
  await expect(f.service.saveConfig(data)).rejects.toBeInstanceOf(MandateInputError)
  expect(f.service.getConfig().revision).toBe(0)
  expect(f.service.listAudit()).toEqual([])
})

test('a scope or mandate edit during the remote capability check cannot authorize an outdated write', async () => {
  for (const changeScope of [true, false]) {
    const checking = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const f = fixture(async () => {
      checking.resolve()
      await release.promise
      return { ok: true, reason: '' }
    })
    const saving = f.service.saveConfig(snapshot())
    await checking.promise
    if (changeScope)
      f.store.saveSettings(
        { github: { credentialRef: '', repositories: [] }, wxarc: { sessions: [] } },
        1,
      )
    else
      await f.service.saveConfig({
        revision: 0,
        settings: { projects: [{ id: 'new', name: '另一个项目', policy: {} }], mandates: [] },
      })
    release.resolve()
    await expect(saving).rejects.toBeInstanceOf(TriggerSettingsConflictError)
    expect(f.service.getConfig().settings.mandates).toEqual([])
  }
})

test('confirmation hook failure rolls back the whole authorization; no optimistic success or wake', async () => {
  const f = fixture()
  await expect(
    f.service.saveConfig(snapshot(), {
      before() {},
      after() {
        throw new Error('grant expired')
      },
    }),
  ).rejects.toThrow('grant expired')
  expect(f.service.getConfig().revision).toBe(0)
  expect(f.service.listAudit()).toEqual([])
  expect(f.wakes()).toBe(0)
})

test('offline grants do not block revocation or an unrelated mandate edit; expanding project rules rechecks affected grants', async () => {
  const f = fixture()
  const saved = await f.service.saveConfig(snapshot())
  f.revoke()
  const projectEdit = structuredClone(saved)
  projectEdit.settings.projects[0].policy = { urgentDestination: 'dingtalk' }
  await expect(f.service.saveConfig(projectEdit)).rejects.toBeInstanceOf(MandateInputError)
  const independent = structuredClone(saved)
  independent.settings.projects.push({ id: 'other', name: '其他项目', policy: {} })
  const updated = await f.service.saveConfig(independent)
  const revocation = structuredClone(updated)
  revocation.settings.mandates[0].targets = []
  expect((await f.service.saveConfig(revocation)).settings.mandates[0].targets).toEqual([])
  // One initial check and one rejected policy expansion. Neither later save touched the unrelated doc.
  expect(f.checks()).toBe(2)
})

test('preserves multiline mandate purposes while identifiers and other text fields stay single-line', async () => {
  const { service } = fixture()
  const draft = snapshot()
  const purpose = '跟踪发布阻塞。\r\n\t同时整理修复进度。'
  draft.settings.mandates[0].purpose = purpose
  const saved = await service.saveConfig(draft)
  expect(saved.settings.mandates[0].purpose).toBe(purpose)
  for (const patch of [{ purpose: '不允许\u0000控制符' }, { name: '不允许\n换行' }]) {
    const invalid = structuredClone(saved)
    Object.assign(invalid.settings.mandates[0], patch)
    await expect(service.saveConfig(invalid)).rejects.toBeInstanceOf(MandateInputError)
  }
})

test('ordered rule configuration preserves both layer orders, validates conditions and only selects a granted audience', async () => {
  const { service } = fixture()
  const original = snapshot()
  const work = {
    id: 'work',
    name: '工作在场',
    when: { presence: 'present' as const, period: 'duringWork' as const },
    destination: 'dingtalk' as const,
  }
  const normal = {
    id: 'normal',
    name: '普通',
    when: { urgency: 'normal' as const },
    destination: 'web' as const,
  }
  original.settings.projects[0].policy = { rules: [normal, work], deadlineLeadMinutes: 180 }
  original.settings.mandates[0].policy = { rules: [work, normal], deadlineLeadMinutes: 0 }
  const saved = await service.saveConfig(original)
  expect(saved.settings.projects[0].policy).toEqual(original.settings.projects[0].policy)
  expect(saved.settings.mandates[0].policy).toEqual(original.settings.mandates[0].policy)
  for (const invalid of [
    { deadlineLeadMinutes: -1 },
    { deadlineLeadMinutes: 10081 },
    { deadlineLeadMinutes: 2.5 },
    { rules: [work, work] },
    { rules: [{ ...work, when: {} }] },
    { rules: [{ ...work, when: { run: 'command' } }] },
    { rules: [{ ...work, when: { quiet: 1 } }] },
    { rules: [{ ...work, when: { presence: 'near' } }] },
    { rules: [{ ...work, destination: 'feishu' }] },
    { rules: [{ ...work, destination: 'other' }] },
    { rules: [{ ...work, recipient: 'other' }] },
    { rules: Array.from({ length: 13 }, (_, i) => ({ ...work, id: `r${i}` })) },
    { rules: [{ ...work, name: 'a'.repeat(81) }] },
  ]) {
    const draft = structuredClone(saved)
    Object.assign(draft.settings.projects[0], { policy: invalid })
    await expect(service.saveConfig(draft)).rejects.toBeInstanceOf(MandateInputError)
  }
  expect(service.getConfig().revision).toBe(saved.revision)
  const revoke = structuredClone(saved)
  revoke.settings.mandates[0].targets = []
  await service.saveConfig(revoke)
  expect(service.getConfig().settings.mandates[0].targets).toEqual([])
})
