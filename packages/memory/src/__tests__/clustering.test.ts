import { describe, expect, test } from 'bun:test'
import { getMemoryClusters, invalidateClusterCache } from '../clustering'

// listAll 项与 store 成员的最小 fake，匹配 VectorIndexLike / ClusterMemoryStore 形态。
function meta(id: string) {
  return { memoryId: id, type: 'note', title: id, updatedAt: '2026-01-01T00:00:00.000Z' }
}
function member() {
  return { title: 'm', status: 'verified', confidence: 0.8, updatedAt: '2026-01-01T00:00:00.000Z' }
}
const A = { memoryId: 'a', vector: [1, 0, 0], norm: 1, meta: meta('a') }
const B = { memoryId: 'b', vector: [0.99, 0.141, 0], norm: 1, meta: meta('b') } // cos(A,B)=0.99 → 同簇

// 对抗R12回归：缓存复活竞态——compute 期间 invalidate 不应被陈旧结果回写覆盖。
describe('getMemoryClusters cache epoch guard (R12)', () => {
  test('invalidate during in-flight compute is not clobbered by the stale write-back', async () => {
    invalidateClusterCache() // 干净起点
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    let calls = 0
    const index = {
      async listAll() {
        calls++
        if (calls === 1) {
          await gate
          return [A] // 旧快照只有 A → 0 簇
        }
        return [A, B] // 新状态 A+B 近重复 → 1 簇
      },
    }
    const store = { get: () => member() }
    // 启动 in-flight compute（卡在 listAll #1，快照仅 A）
    const inflight = getMemoryClusters(index as never, store as never, { force: true })
    // compute 期间并发 mutation 失效缓存（epoch++）
    invalidateClusterCache()
    release?.()
    const stale = await inflight
    expect(stale.total).toBe(0) // in-flight 用旧快照算出 0（交付给它自己的调用者，可接受）
    // 关键：缓存未被陈旧结果复活 → 后续非 fresh GET 重算，见到新增的 B → 1 簇
    const after = await getMemoryClusters(index as never, store as never, {})
    expect(after.total).toBe(1)
  })

  test('without a concurrent invalidate the result is cached and reused', async () => {
    invalidateClusterCache()
    const index = {
      async listAll() {
        return [A, B]
      },
    }
    const store = { get: () => member() }
    const first = await getMemoryClusters(index as never, store as never, { force: true })
    expect(first.total).toBe(1)
    const cached = await getMemoryClusters(index as never, store as never, {})
    expect(cached).toBe(first) // 同引用 = 命中缓存
    invalidateClusterCache() // 清理，避免污染其它套件
  })
})
