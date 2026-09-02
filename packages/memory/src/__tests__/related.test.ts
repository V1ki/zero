import { describe, expect, test } from 'bun:test'
import type { Memory } from '@zero-os/shared'
import { buildMemoryLineage, computeRelatedMemories } from '../related'

let seq = 0

function makeMemory(overrides: Partial<Memory> & Pick<Memory, 'id' | 'title'>): Memory {
  seq += 1
  const stamp = new Date(2026, 0, seq).toISOString()
  return {
    type: 'note',
    createdAt: stamp,
    updatedAt: stamp,
    status: 'verified',
    confidence: 0.8,
    tags: [],
    related: [],
    content: `content of ${overrides.id}`,
    ...overrides,
  }
}

describe('computeRelatedMemories', () => {
  test('forward edge from anchor is the strongest signal', () => {
    const anchor = makeMemory({
      id: 'a',
      title: 'anchor',
      edges: [{ toId: 'b', kind: 'same-topic' }],
    })
    const other = makeMemory({ id: 'b', title: 'linked' })
    const noisyNeighbor = makeMemory({ id: 'n', title: 'noisy neighbor' })

    const hits = computeRelatedMemories({
      anchor,
      memories: [anchor, other, noisyNeighbor],
      neighbors: [{ id: 'n', similarity: 0.95 }],
    })

    // edge 权重 3 > 近邻 2×0.95=1.9
    expect(hits[0]?.id).toBe('b')
    expect(hits[0]?.reasons).toContain('edge')
    expect(hits[0]?.edgeKinds).toEqual(['same-topic'])
    expect(hits[1]?.id).toBe('n')
  })

  test('backward edge (candidate declares edge to anchor) counts as edge', () => {
    const anchor = makeMemory({ id: 'a', title: 'anchor' })
    const declarer = makeMemory({
      id: 'd',
      title: 'declares back',
      edges: [{ toId: 'a', kind: 'derived-from' }],
    })

    const hits = computeRelatedMemories({ anchor, memories: [anchor, declarer], neighbors: [] })

    expect(hits).toHaveLength(1)
    expect(hits[0]?.reasons).toContain('edge')
    expect(hits[0]?.edgeKinds).toEqual(['derived-from'])
  })

  test('two shared tags qualify, a single shared tag does not', () => {
    const anchor = makeMemory({ id: 'a', title: 'anchor', tags: ['redis', 'deploy', 'cache'] })
    const twoShared = makeMemory({ id: 't', title: 'two', tags: ['redis', 'deploy'] })
    const oneShared = makeMemory({ id: 'o', title: 'one', tags: ['redis'] })

    const hits = computeRelatedMemories({
      anchor,
      memories: [anchor, twoShared, oneShared],
      neighbors: [],
    })

    const ids = hits.map((hit) => hit.id)
    expect(ids).toContain('t')
    expect(ids).not.toContain('o')
  })

  test('same session is a signal and merges with neighbor reasons', () => {
    const anchor = makeMemory({ id: 'a', title: 'anchor', sessionId: 'sess-1' })
    const sibling = makeMemory({ id: 's', title: 'sibling', sessionId: 'sess-1' })

    const hits = computeRelatedMemories({
      anchor,
      memories: [anchor, sibling],
      neighbors: [{ id: 's', similarity: 0.7 }],
    })

    expect(hits).toHaveLength(1)
    expect(hits[0]?.reasons).toEqual(['same-session', 'neighbor'])
    expect(hits[0]?.similarity).toBeCloseTo(0.7)
  })

  test('archived and self are never related candidates', () => {
    const anchor = makeMemory({ id: 'a', title: 'anchor', sessionId: 'sess-1' })
    const archived = makeMemory({
      id: 'x',
      title: 'archived',
      status: 'archived',
      sessionId: 'sess-1',
    })

    const hits = computeRelatedMemories({
      anchor,
      memories: [anchor, archived],
      neighbors: [{ id: 'x', similarity: 0.99 }],
    })

    expect(hits).toHaveLength(0)
  })

  test('limit keeps only the strongest hits', () => {
    const anchor = makeMemory({
      id: 'a',
      title: 'anchor',
      edges: [
        { toId: 'e1', kind: 'same-topic' },
        { toId: 'e2', kind: 'same-topic' },
      ],
    })
    const memories = [
      anchor,
      makeMemory({ id: 'e1', title: 'aaa edge' }),
      makeMemory({ id: 'e2', title: 'bbb edge' }),
      makeMemory({ id: 'w', title: 'weak neighbor' }),
    ]

    const hits = computeRelatedMemories({
      anchor,
      memories,
      neighbors: [{ id: 'w', similarity: 0.6 }],
      limit: 2,
    })

    expect(hits).toHaveLength(2)
    expect(hits.every((hit) => hit.reasons.includes('edge'))).toBe(true)
  })
})

describe('buildMemoryLineage', () => {
  test('walks forward to authority and collects predecessors chain', () => {
    const v1 = makeMemory({ id: 'v1', title: 'v1', status: 'archived', supersededBy: 'v2' })
    const v2 = makeMemory({ id: 'v2', title: 'v2', status: 'archived', mergedInto: 'v3' })
    const v3 = makeMemory({ id: 'v3', title: 'v3' })
    const memories = [v1, v2, v3]

    const lineage = buildMemoryLineage(v1, memories)

    // 向后:v1 → v2(取代)→ v3(并入);向前:无人指向 v1
    expect(lineage).toEqual([
      { id: 'v2', type: 'note', title: 'v2', status: 'archived', relation: 'superseded-by' },
      { id: 'v3', type: 'note', title: 'v3', status: 'verified', relation: 'merged-into' },
    ])

    // 从权威条 v3 视角:向前应看到整条前驱链
    const fromAuthority = buildMemoryLineage(v3, memories)
    expect(fromAuthority.map((entry) => entry.id).sort()).toEqual(['v1', 'v2'])
    const v1Entry = fromAuthority.find((entry) => entry.id === 'v1')
    expect(v1Entry?.relation).toBe('supersedes')
    const v2Entry = fromAuthority.find((entry) => entry.id === 'v2')
    expect(v2Entry?.relation).toBe('merged-from')
  })

  test('cycles terminate via visited set', () => {
    const a = makeMemory({ id: 'a', title: 'a', supersededBy: 'b' })
    const b = makeMemory({ id: 'b', title: 'b', supersededBy: 'a' })

    const lineage = buildMemoryLineage(a, [a, b])

    expect(lineage.map((entry) => entry.id)).toEqual(['b'])
  })
})
