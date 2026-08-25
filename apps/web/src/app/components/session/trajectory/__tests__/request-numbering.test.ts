import { describe, expect, it } from 'bun:test'
import { deriveTrajectoryRequestNumbers, indexSessionRequestsBySeq } from '../request-numbering'
import type { AssistantMessageNode, RequestView } from '../types'

function assistantNode(turn: number, step: number, seq: number): AssistantMessageNode {
  return {
    kind: 'assistant',
    seq,
    time: seq * 1000,
    turn,
    step,
    blocks: [],
  }
}

function assistantRequest(turn: number, step: number, startSeq: number): RequestView {
  return {
    purpose: 'assistant',
    turn,
    step,
    startSeq,
    startedAt: startSeq * 1000,
    completedAt: startSeq * 1000 + 500,
    status: 'complete',
  }
}

function compactionRequest(startSeq: number): RequestView {
  return {
    purpose: 'compaction',
    turn: null,
    step: 0,
    startSeq,
    startedAt: startSeq * 1000,
    completedAt: startSeq * 1000 + 500,
    status: 'complete',
  }
}

describe('deriveTrajectoryRequestNumbers', () => {
  it('numbers unpaired requests in one (turn, step) group distinctly', () => {
    const numbered = deriveTrajectoryRequestNumbers(
      [assistantNode(1, 1, 30)],
      [assistantRequest(1, 0, 2), assistantRequest(1, 0, 10), assistantRequest(1, 1, 30)],
    )
    expect(numbered).toHaveLength(3)
    expect(numbered.map((entry) => entry.number)).toEqual([1, 2, 3])
    const stepZero = numbered.filter((entry) => entry.group === 'Step 0')
    expect(stepZero.map((entry) => entry.number)).toEqual([1, 2])
  })

  it('keeps its own number per request-only row via the seq index', () => {
    const numbered = deriveTrajectoryRequestNumbers(
      [assistantNode(1, 1, 30)],
      [assistantRequest(1, 0, 2), assistantRequest(1, 0, 10), assistantRequest(1, 1, 30)],
    )
    const bySeq = indexSessionRequestsBySeq(numbered)
    expect(bySeq.get(2)?.number).toBe(1)
    expect(bySeq.get(10)?.number).toBe(2)
    expect(bySeq.get(30)?.number).toBe(3)
  })

  it('numbers compaction views into their own groups', () => {
    const numbered = deriveTrajectoryRequestNumbers(
      [assistantNode(1, 1, 30)],
      [assistantRequest(1, 1, 30), compactionRequest(50)],
    )
    const compaction = numbered.find((entry) => entry.purpose === 'compaction')
    expect(compaction).toBeDefined()
    expect(compaction?.group).toBe('Compaction 50')
    expect(compaction?.number).toBe(2)
    expect(compaction?.turn).toBeNull()
  })

  it('numbers represented assistant steps whose request is absent', () => {
    const numbered = deriveTrajectoryRequestNumbers([assistantNode(2, 1, 60)], [])
    expect(numbered).toHaveLength(1)
    expect(numbered[0]).toMatchObject({ seq: 60, turn: 2, step: 1, group: 'Step 1', number: 1 })
  })
})

describe('indexSessionRequestsBySeq', () => {
  it('skips entries without an anchor seq', () => {
    const bySeq = indexSessionRequestsBySeq([
      {
        turn: 1,
        step: 1,
        group: 'Step 1',
        number: 7,
        status: 'running',
      },
    ])
    expect(bySeq.size).toBe(0)
  })

  it('returns an empty index for missing session numbers', () => {
    expect(indexSessionRequestsBySeq(undefined).size).toBe(0)
  })
})
