// 记忆图改造(P0-P2)新增端点的运行时验证 + 回归测试。
// 用最小 zero stub（真实 MemoryStore + VectorIndex on 临时目录）驱动 createRoutes，
// 通过 app.request 实打实跑端点逻辑，不依赖 embedding，也不碰真实数据。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryLifecycle,
  MemoryStore,
  MemoryUsageTracker,
  VectorIndex,
  invalidateClusterCache,
} from '@zero-os/memory'
import type { ZeroOS } from '../../../../server/src/main'
import { createRoutes } from '../routes'

let dir: string
let store: MemoryStore
let vectorIndex: VectorIndex
let usageTracker: MemoryUsageTracker
let app: ReturnType<typeof createRoutes>
const ids: Record<string, string> = {}

beforeAll(async () => {
  invalidateClusterCache() // 模块级单例缓存，先清掉避免跨测试套污染
  dir = mkdtempSync(join(tmpdir(), 'zero-routes-memory-'))
  store = new MemoryStore(dir)
  vectorIndex = new VectorIndex(join(dir, 'vectors'))
  await vectorIndex.ensureIndex()
  usageTracker = new MemoryUsageTracker({ statsPath: join(dir, 'usage-stats.json') })
  usageTracker.load()
  usageTracker.record('mem_usage_probe', 'read')
  usageTracker.record('mem_usage_probe', 'used')

  const a = await store.create('runbook', 'Deploy ComfyUI v1', 'steps a', { status: 'verified' })
  const b = await store.create('runbook', 'Deploy ComfyUI v2', 'steps b', { status: 'draft' })
  const c = await store.create('note', 'Unrelated topic', 'xyz', { status: 'verified' })
  ids.a = a.id
  ids.b = b.id
  ids.c = c.id

  // a 与 b 几乎同向（应同簇/互为近邻），c 正交（应不同簇）。
  const meta = (m: { id: string; type: string; title: string; updatedAt: string }) => ({
    memoryId: m.id,
    type: m.type,
    title: m.title,
    updatedAt: m.updatedAt,
  })
  await vectorIndex.upsert(a.id, [1, 0, 0], meta(a))
  await vectorIndex.upsert(b.id, [0.99, 0.141, 0], meta(b))
  await vectorIndex.upsert(c.id, [0, 0, 1], meta(c))

  const zero = {
    memoryStore: store,
    vectorIndex,
    memoryLifecycle: new MemoryLifecycle(store),
    memoryUsage: usageTracker,
  } as unknown as ZeroOS
  app = createRoutes(zero)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function post(path: string, body?: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

describe('Memory redesign endpoints (P0-P2)', () => {
  test('GET /api/memory/clusters groups near-duplicate vectors', async () => {
    const res = await app.request('/api/memory/clusters')
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      clusters: Array<{ size: number; suggestedWinnerId?: string; members: { id: string }[] }>
      total: number
      memoriesInClusters: number
    }
    // a+b 同簇，c 独立 → 恰好 1 个 size>=2 的簇。
    expect(data.total).toBe(1)
    const cluster = data.clusters[0]
    expect(cluster.size).toBe(2)
    const memberIds = cluster.members.map((m) => m.id).sort()
    expect(memberIds).toEqual([ids.a, ids.b].sort())
    // 建议权威条应为 verified 的 a（而非 draft 的 b）。
    expect(cluster.suggestedWinnerId).toBe(ids.a)
  })

  test('GET neighbors returns nearest other memory', async () => {
    const res = await app.request(`/api/memory/runbook/${ids.a}/neighbors`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as { neighbors: Array<{ memoryId: string; score: number }> }
    expect(data.neighbors[0]?.memoryId).toBe(ids.b)
    expect(data.neighbors.some((nb) => nb.memoryId === ids.a)).toBe(false) // 不含自身
  })

  test('POST verify lifts status to verified', async () => {
    const res = await post(`/api/memory/runbook/${ids.b}/verify`)
    expect(res.status).toBe(200)
    expect(store.get('runbook', ids.b)?.status).toBe('verified')
  })

  test('PATCH relations adds edges and dedupes within batch', async () => {
    const res = await app.request(`/api/memory/runbook/${ids.a}/relations`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        add: [
          { toId: ids.b, kind: 'same-topic' },
          { toId: ids.b, kind: 'same-topic' }, // 重复，应被去重
          { toId: ids.c, kind: 'derived-from' },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const edges = store.get('runbook', ids.a)?.edges ?? []
    expect(edges.length).toBe(2)
    expect(edges.filter((e) => e.toId === ids.b).length).toBe(1)
  })

  test('POST supersede sets supersededBy + archives (reversible)', async () => {
    const res = await post(`/api/memory/runbook/${ids.a}/supersede`, { bySupersededId: ids.b })
    expect(res.status).toBe(200)
    const m = store.get('runbook', ids.a)
    expect(m?.supersededBy).toBe(ids.b)
    expect(m?.status).toBe('archived')
  })

  test('POST supersede without bySupersededId returns 400', async () => {
    const res = await post(`/api/memory/note/${ids.c}/supersede`, {})
    expect(res.status).toBe(400)
  })

  test('POST archive marks archived without deleting the file', async () => {
    const res = await post(`/api/memory/note/${ids.c}/archive`)
    expect(res.status).toBe(200)
    expect(store.get('note', ids.c)?.status).toBe('archived') // 仍可读 = 未物理删除
  })

  test('archive on missing memory returns 404', async () => {
    const res = await post('/api/memory/note/mem_does_not_exist/archive')
    expect(res.status).toBe(404)
  })

  test('cluster cache is invalidated by mutations (non-fresh GET reflects new statuses)', async () => {
    // 第一个测试缓存过聚类结果（a=verified,b=draft）；其后 verify(b)、supersede(a) 都应已失效缓存，
    // 非 fresh 的 GET 必须反映当前状态而非陈旧快照。
    const res = await app.request('/api/memory/clusters')
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      clusters: Array<{ suggestedWinnerId?: string; members: { id: string; status: string }[] }>
    }
    const cluster = data.clusters.find((cl) => cl.members.some((m) => m.id === ids.a))
    expect(cluster).toBeDefined()
    const a = cluster?.members.find((m) => m.id === ids.a)
    const b = cluster?.members.find((m) => m.id === ids.b)
    expect(a?.status).toBe('archived') // supersede 后
    expect(b?.status).toBe('verified') // verify 后
    expect(cluster?.suggestedWinnerId).toBe(ids.b) // verified 击败 archived
  })
})

// 对抗评审修复的回归锁（僵尸 verify / 谱系校验 / 粒度 remove / 幽灵向量）。
describe('Adversarial regression locks', () => {
  let d = ''
  let e = ''

  beforeAll(async () => {
    d = (await store.create('note', 'Adv D', 'content d', { status: 'verified' })).id
    e = (await store.create('note', 'Adv E', 'content e', { status: 'verified' })).id
  })

  test('verify clears lineage pointers (no zombie state)', async () => {
    await post(`/api/memory/note/${d}/supersede`, { bySupersededId: e })
    expect(store.get('note', d)?.supersededBy).toBe(e)
    const res = await post(`/api/memory/note/${d}/verify`)
    expect(res.status).toBe(200)
    const m = store.get('note', d)
    expect(m?.status).toBe('verified')
    expect(m?.supersededBy).toBeUndefined()
    expect(m?.mergedInto).toBeUndefined()
  })

  test('supersede validates: self → 400, ghost target → 404, cycle → 409', async () => {
    expect((await post(`/api/memory/note/${d}/supersede`, { bySupersededId: d })).status).toBe(400)
    expect(
      (await post(`/api/memory/note/${d}/supersede`, { bySupersededId: 'mem_ghost_xyz' })).status,
    ).toBe(404)
    // e ← d 已不存在（verify 清掉了）；先建 e supersededBy d，再 d by e 应成环
    expect((await post(`/api/memory/note/${e}/supersede`, { bySupersededId: d })).status).toBe(200)
    expect((await post(`/api/memory/note/${d}/supersede`, { bySupersededId: e })).status).toBe(409)
  })

  test('relations remove is kind-granular and wins over same-request add', async () => {
    await app.request(`/api/memory/note/${d}/relations`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        add: [
          { toId: e, kind: 'same-topic' },
          { toId: e, kind: 'contradicts' },
        ],
      }),
    })
    // 精确删一条 kind，另一条保留
    await app.request(`/api/memory/note/${d}/relations`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ remove: [{ toId: e, kind: 'same-topic' }] }),
    })
    let edges = store.get('note', d)?.edges ?? []
    expect(edges).toEqual([{ toId: e, kind: 'contradicts' }])
    // 同请求 add+remove 同目标：remove 胜出（删除意图不被静默吞掉）
    await app.request(`/api/memory/note/${d}/relations`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ add: [{ toId: e, kind: 'derived-from' }], remove: [e] }),
    })
    edges = store.get('note', d)?.edges ?? []
    expect(edges).toEqual([])
  })

  test('DELETE also removes vector (no ghost members in degraded mode)', async () => {
    const f = (await store.create('note', 'Adv F ghost', 'content f', { status: 'verified' })).id
    await vectorIndex.upsert(f, [0.5, 0.5, 0.5], {
      memoryId: f,
      type: 'note',
      title: 'Adv F ghost',
      updatedAt: 'x',
    })
    expect(await vectorIndex.getVector(f)).toBeDefined()
    const res = await app.request(`/api/memory/note/${f}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(store.get('note', f)).toBeUndefined()
    expect(await vectorIndex.getVector(f)).toBeUndefined()
  })
})

describe('Adversarial regression locks R2', () => {
  test('PUT only edits safe fields (status/supersededBy ignored)', async () => {
    const m = await store.create('note', 'PutGuard', 'body', {
      status: 'verified',
      confidence: 0.9,
    })
    const res = await app.request(`/api/memory/note/${m.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'edited',
        status: 'archived',
        supersededBy: 'mem_evil',
        edges: 'not-an-array',
      }),
    })
    expect(res.status).toBe(200)
    const after = store.get('note', m.id)
    expect(after?.content).toBe('edited') // 安全字段生效
    expect(after?.status).toBe('verified') // status 未被 PUT 改
    expect(after?.supersededBy).toBeUndefined() // 谱系未被 PUT 写
  })

  test('supersede rejects cycle even on deep chains (visited, no fuse)', async () => {
    const ids: string[] = []
    for (let i = 0; i < 105; i++) {
      ids.push((await store.create('note', `Chain ${i}`, `c${i}`, { status: 'verified' })).id)
    }
    for (let i = 0; i < 104; i++) {
      const r = await post(`/api/memory/note/${ids[i]}/supersede`, { bySupersededId: ids[i + 1] })
      expect(r.status).toBe(200)
    }
    // 闭合环：最后一条 supersede 回第一条 → 必须 409（旧实现 >101 会漏过）
    const close = await post(`/api/memory/note/${ids[104]}/supersede`, { bySupersededId: ids[0] })
    expect(close.status).toBe(409)
  })

  test('supersede path-compresses to final authority (chain depth <=1)', async () => {
    const a = (await store.create('note', 'PC a', 'a', { status: 'verified' })).id
    const b = (await store.create('note', 'PC b', 'b', { status: 'verified' })).id
    const cc = (await store.create('note', 'PC c', 'c', { status: 'verified' })).id
    await post(`/api/memory/note/${b}/supersede`, { bySupersededId: cc }) // b -> c
    await post(`/api/memory/note/${a}/supersede`, { bySupersededId: b }) // a -> (compress) c
    expect(store.get('note', a)?.supersededBy).toBe(cc)
  })
})

describe('Adversarial regression locks R3', () => {
  test('create endpoint validates status enum and clamps confidence', async () => {
    const res = await post('/api/memory', {
      type: 'note',
      title: 'R3 create guard',
      content: 'x',
      status: 'PWNED_NOT_A_STATUS',
      confidence: 999,
      tags: ['__e2e__'],
    })
    expect(res.status).toBe(200)
    const id = ((await res.json()) as { memory: { id: string } }).memory.id
    const m = store.get('note', id)
    expect(m?.status).toBe('draft') // 非法 status → 退回默认
    expect(m?.confidence).toBe(1) // 999 → 钳制到 1
    const neg = await post('/api/memory', {
      type: 'note',
      title: 'R3 neg',
      content: 'y',
      confidence: -5,
      tags: ['__e2e__'],
    })
    const id2 = ((await neg.json()) as { memory: { id: string } }).memory.id
    expect(store.get('note', id2)?.confidence).toBe(0) // -5 → 0
  })

  test('PUT clamps confidence to [0,1]', async () => {
    const m = await store.create('note', 'R3 put conf', 'b', {
      status: 'verified',
      confidence: 0.5,
    })
    await app.request(`/api/memory/note/${m.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confidence: 42 }),
    })
    expect(store.get('note', m.id)?.confidence).toBe(1)
  })

  test('supersede compresses to last live node, not an archived tail', async () => {
    const a = (await store.create('note', 'R3 a', 'a', { status: 'verified' })).id
    const mid = (await store.create('note', 'R3 mid', 'm', { status: 'verified' })).id
    const tail = (await store.create('note', 'R3 tail', 't', { status: 'verified' })).id
    await post(`/api/memory/note/${mid}/supersede`, { bySupersededId: tail }) // mid -> tail (mid archived, tail live)
    await post(`/api/memory/note/${tail}/archive`) // tail now archived → chain tail dead
    // a superseded by mid: walk mid->tail, both archived → no live node deeper than... mid is archived,
    // tail archived → lastLive undefined → falls back to immediate target (mid), not the archived tail
    await post(`/api/memory/note/${a}/supersede`, { bySupersededId: mid })
    const sb = store.get('note', a)?.supersededBy
    expect(sb).not.toBe(tail) // 不指向 archived 链尾
    expect(sb).toBe(mid) // 回退到直接 target
  })
})

describe('Adversarial regression locks R4', () => {
  test('clusters endpoint tolerates non-finite threshold (no silent zero-cluster)', async () => {
    // ?threshold=abc → Number('abc')=NaN；归一到默认 0.9，a+b 仍应成 1 簇而非静默消失
    const res = await app.request('/api/memory/clusters?threshold=abc&fresh=1')
    expect(res.status).toBe(200)
    const data = (await res.json()) as { total: number; memoriesInClusters: number }
    expect(data.total).toBe(1)
    expect(data.memoriesInClusters).toBe(2)
  })
})

describe('Adversarial regression locks R5', () => {
  test('neighbors payload carries status/lineage so dead nodes are visible', async () => {
    // 主 describe 已 supersede(a by b)→ a archived & supersededBy=b；a 是 b 的最近邻
    const res = await app.request(`/api/memory/runbook/${ids.b}/neighbors`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      neighbors: Array<{ memoryId: string; status?: string; supersededBy?: string }>
    }
    const aNeighbor = data.neighbors.find((n) => n.memoryId === ids.a)
    expect(aNeighbor).toBeDefined()
    expect(aNeighbor?.status).toBe('archived') // 死节点状态可见
    expect(aNeighbor?.supersededBy).toBe(ids.b) // 携带谱系信号
  })
})

describe('Usage & related views', () => {
  test('GET /api/memory/usage returns tracker snapshot', async () => {
    const res = await app.request('/api/memory/usage')
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      usage: Array<{ id: string; read: number; used: number; score: number }>
    }
    const probe = data.usage.find((entry) => entry.id === 'mem_usage_probe')
    expect(probe).toBeDefined()
    expect(probe?.read).toBeCloseTo(1, 5)
    expect(probe?.used).toBeCloseTo(1, 5)
    // (2*1 + 1)/5 = 0.6
    expect(probe?.score).toBeCloseTo(0.6, 5)
  })

  test('GET related returns lineage and multi-signal related hits', async () => {
    const p = await store.create('runbook', 'Rel P', 'p', {
      status: 'verified',
      tags: ['alpha', 'beta'],
    })
    const q = await store.create('note', 'Rel Q', 'q', {
      status: 'verified',
      tags: ['alpha', 'beta'],
    })
    const r = await store.create('note', 'Rel R', 'r', { status: 'verified' })
    await vectorIndex.upsert(p.id, [1, 0, 0], {
      memoryId: p.id,
      type: 'runbook',
      title: p.title,
      updatedAt: p.updatedAt,
    })
    await vectorIndex.upsert(r.id, [0.99, 0.141, 0], {
      memoryId: r.id,
      type: 'note',
      title: r.title,
      updatedAt: r.updatedAt,
    })
    // p 被 q 取代 → 谱系向后一跳
    const superseded = await post(`/api/memory/runbook/${p.id}/supersede`, { bySupersededId: q.id })
    expect(superseded.status).toBe(200)

    const res = await app.request(`/api/memory/runbook/${p.id}/related`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      related: Array<{ id: string; reasons: string[] }>
      lineage: Array<{ id: string; relation: string }>
    }

    expect(data.lineage).toEqual([
      expect.objectContaining({ id: q.id, relation: 'superseded-by', status: 'verified' }),
    ])

    const qHit = data.related.find((hit) => hit.id === q.id)
    expect(qHit?.reasons).toContain('shared-tags')
    const rHit = data.related.find((hit) => hit.id === r.id)
    expect(rHit?.reasons).toContain('neighbor')
  })

  test('GET related 404 for missing memory', async () => {
    const res = await app.request('/api/memory/note/mem_ghost_related/related')
    expect(res.status).toBe(404)
  })
})

describe('MemoryLifecycle endpoints (wired)', () => {
  test('POST resolve-conflict adjudicates winner and redirects loser', async () => {
    const hi = await store.create('note', 'Hi conf', 'truth', {
      status: 'verified',
      confidence: 0.9,
    })
    const lo = await store.create('note', 'Lo conf', 'stale', {
      status: 'verified',
      confidence: 0.4,
    })
    const res = await post(`/api/memory/note/${hi.id}/resolve-conflict`, { otherId: lo.id })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { winner: { id: string } }
    expect(data.winner.id).toBe(hi.id) // 高 confidence 胜
    const loser = store.get('note', lo.id)
    expect(loser?.status).toBe('archived')
    expect(loser?.supersededBy).toBe(hi.id) // loser 指向 winner，命中可重定向
  })

  test('resolve-conflict requires otherId and rejects self', async () => {
    const m = await store.create('note', 'Solo', 'x', { status: 'verified' })
    expect((await post(`/api/memory/note/${m.id}/resolve-conflict`, {})).status).toBe(400)
    expect(
      (await post(`/api/memory/note/${m.id}/resolve-conflict`, { otherId: m.id })).status,
    ).toBe(400)
  })

  test('resolve-conflict 404 when a memory is missing', async () => {
    const m = await store.create('note', 'Exists', 'x', { status: 'verified' })
    const res = await post(`/api/memory/note/${m.id}/resolve-conflict`, { otherId: 'mem_ghost' })
    expect(res.status).toBe(404)
  })

  test('POST maintenance/archive-old archives aged non-authority memories', async () => {
    const old = await store.create('incident', 'Aged', 'old', { status: 'verified' })
    await store.save({ ...old, updatedAt: '2000-01-01T00:00:00.000Z' })
    const res = await post('/api/memory/maintenance/archive-old', {
      type: 'incident',
      olderThanDays: 30,
    })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { archived: number }
    expect(data.archived).toBeGreaterThanOrEqual(1)
    expect(store.get('incident', old.id)?.status).toBe('archived')
  })

  test('archive-old rejects an invalid type', async () => {
    expect((await post('/api/memory/maintenance/archive-old', { type: 'bogus' })).status).toBe(400)
    expect((await post('/api/memory/maintenance/archive-old', {})).status).toBe(400)
  })
})

describe('MemoryLifecycle endpoints hardening (R9)', () => {
  test('resolve-conflict works cross-type (otherId of a different type)', async () => {
    const rb = await store.create('runbook', 'Kernel rb', 'k', {
      status: 'verified',
      confidence: 0.9,
    })
    const nt = await store.create('note', 'Kernel nt', 'k', { status: 'verified', confidence: 0.4 })
    const res = await post(`/api/memory/runbook/${rb.id}/resolve-conflict`, { otherId: nt.id })
    expect(res.status).toBe(200) // 不再误报 404
    const data = (await res.json()) as { winner: { id: string } }
    expect(data.winner.id).toBe(rb.id) // 高 conf 的 runbook 胜
    expect(store.get('note', nt.id)?.status).toBe('archived') // 跨 type loser 正确归档
    expect(store.get('note', nt.id)?.supersededBy).toBe(rb.id)
  })

  test('archive-old clamps a huge olderThanDays instead of 500ing', async () => {
    const res = await post('/api/memory/maintenance/archive-old', {
      type: 'decision',
      olderThanDays: 1e308,
    })
    expect(res.status).toBe(200) // 不再 RangeError → 500
    const data = (await res.json()) as { archived: number }
    expect(typeof data.archived).toBe('number')
  })
})
