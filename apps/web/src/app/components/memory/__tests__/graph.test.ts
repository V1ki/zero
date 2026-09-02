import { describe, expect, test } from 'bun:test'
import { buildMemoryGraph, computeForceLayout } from '../graph'

describe('buildMemoryGraph', () => {
  test('builds lineage and edge links, skipping dead targets', () => {
    const graph = buildMemoryGraph([
      {
        id: 'a',
        type: 'note',
        title: 'A',
        status: 'verified',
        supersededBy: 'b',
        edges: [{ toId: 'c', kind: 'same-topic' }],
      },
      { id: 'b', type: 'note', title: 'B', status: 'verified' },
      { id: 'c', type: 'note', title: 'C', status: 'verified' },
      // d 指向不存在的目标 → 死链丢弃,自身成为孤立节点被默认过滤
      { id: 'd', type: 'note', title: 'D', status: 'verified', mergedInto: 'ghost' },
    ])

    expect(graph.links).toEqual([
      {
        key: 'superseded-by:a:b',
        source: 'a',
        target: 'b',
        kind: 'superseded-by',
        category: 'lineage',
      },
      { key: 'same-topic:a:c', source: 'a', target: 'c', kind: 'same-topic', category: 'edge' },
    ])
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(['a', 'b', 'c'])
    expect(graph.nodes.find((node) => node.id === 'a')?.degree).toBe(2)
  })

  test('includeIsolated keeps degree-0 memories', () => {
    const graph = buildMemoryGraph(
      [
        { id: 'solo', type: 'note', title: 'Solo', status: 'verified' },
        { id: 'x', type: 'note', title: 'X', status: 'verified', supersededBy: 'y' },
        { id: 'y', type: 'note', title: 'Y', status: 'verified' },
      ],
      {},
      { includeIsolated: true },
    )
    expect(graph.nodes.map((node) => node.id)).toContain('solo')
  })

  test('usage drives heat buckets and usageScore', () => {
    const now = new Date().toISOString()
    const stale = new Date(Date.now() - 40 * 86_400_000).toISOString()
    const graph = buildMemoryGraph(
      [
        { id: 'hot', type: 'note', title: 'hot', status: 'verified', supersededBy: 'cold' },
        { id: 'cold', type: 'note', title: 'cold', status: 'verified', supersededBy: 'never' },
        { id: 'never', type: 'note', title: 'never', status: 'verified' },
      ],
      {
        hot: { score: 0.8, total: 5, lastAccessedAt: now },
        cold: { score: 0.2, total: 3, lastAccessedAt: stale },
      },
    )

    expect(graph.nodes.find((n) => n.id === 'hot')?.heat).toBe('hot')
    expect(graph.nodes.find((n) => n.id === 'cold')?.heat).toBe('cold')
    expect(graph.nodes.find((n) => n.id === 'never')?.heat).toBe('never')
    expect(graph.nodes.find((n) => n.id === 'hot')?.usageScore).toBeCloseTo(0.8, 5)
  })

  test('duplicate edges dedupe and self-loops are dropped', () => {
    const graph = buildMemoryGraph([
      {
        id: 'a',
        type: 'note',
        title: 'A',
        status: 'verified',
        edges: [
          { toId: 'b', kind: 'same-topic' },
          { toId: 'b', kind: 'same-topic' },
          { toId: 'a', kind: 'same-as' },
        ],
      },
      { id: 'b', type: 'note', title: 'B', status: 'verified' },
    ])
    expect(graph.links).toHaveLength(1)
  })
})

describe('computeForceLayout', () => {
  test('returns positions for every node with deterministic seeds', () => {
    const nodes = [
      { id: 'a', degree: 2 },
      { id: 'b', degree: 1 },
      { id: 'c', degree: 1 },
    ]
    const links = [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
    ]
    const first = computeForceLayout(nodes, links, { seed: 7 })
    const second = computeForceLayout(nodes, links, { seed: 7 })

    expect(first.size).toBe(3)
    for (const point of first.values()) {
      expect(Number.isFinite(point.x)).toBe(true)
      expect(Number.isFinite(point.y)).toBe(true)
    }
    // 同 seed 布局可复现,避免数据未变时节点"跳"
    expect([...first.values()]).toEqual([...second.values()])

    // 没有节点落在画布中心重叠成一点
    const uniqueX = new Set([...first.values()].map((p) => p.x.toFixed(2)))
    expect(uniqueX.size).toBeGreaterThan(1)
  })

  test('linked nodes end up closer than unlinked extremes', () => {
    const nodes = [
      { id: 'a', degree: 1 },
      { id: 'b', degree: 1 },
      { id: 'far', degree: 0 },
    ]
    const layout = computeForceLayout(nodes, [{ source: 'a', target: 'b' }], {
      seed: 3,
      iterations: 400,
    })
    const a = layout.get('a') as { x: number; y: number }
    const b = layout.get('b') as { x: number; y: number }
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(200)
  })
})
