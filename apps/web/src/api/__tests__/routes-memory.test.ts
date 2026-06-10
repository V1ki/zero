// 记忆图改造(P0-P2)新增端点的运行时验证 + 回归测试。
// 用最小 zero stub（真实 MemoryStore + VectorIndex on 临时目录）驱动 createRoutes，
// 通过 app.request 实打实跑端点逻辑，不依赖 embedding，也不碰真实数据。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, VectorIndex, invalidateClusterCache } from '@zero-os/memory'
import type { ZeroOS } from '../../../../server/src/main'
import { createRoutes } from '../routes'

let dir: string
let store: MemoryStore
let vectorIndex: VectorIndex
let app: ReturnType<typeof createRoutes>
const ids: Record<string, string> = {}

beforeAll(async () => {
  invalidateClusterCache() // 模块级单例缓存，先清掉避免跨测试套污染
  dir = mkdtempSync(join(tmpdir(), 'zero-routes-memory-'))
  store = new MemoryStore(dir)
  vectorIndex = new VectorIndex(join(dir, 'vectors'))
  await vectorIndex.ensureIndex()

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

  const zero = { memoryStore: store, vectorIndex } as unknown as ZeroOS
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
