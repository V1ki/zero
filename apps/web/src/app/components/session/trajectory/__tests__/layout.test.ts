import { describe, expect, it } from 'bun:test'
import { type TrajectoryTurnModel, deriveTrajectoryLayout } from '../layout'
import type { TrajectoryCellProps } from '../trajectory-record'
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

function stepCells(
  turns: readonly TrajectoryTurnModel[],
  title: string,
): readonly TrajectoryCellProps[] {
  return turns.flatMap((turn) =>
    turn.groups.filter((group) => group.title === title).flatMap((group) => group.cells),
  )
}

describe('deriveTrajectoryLayout request-only rows', () => {
  it('keeps anchored requests row-less so their content row carries the number', () => {
    const turns = deriveTrajectoryLayout({
      nodes: [assistantNode(1, 1, 30)],
      partial: null,
      runningCalls: [],
      requests: [assistantRequest(1, 1, 30)],
    })
    const cells = stepCells(turns, 'Step 1')
    expect(cells.filter((cell) => cell.requestOnly === true)).toHaveLength(0)
    expect(cells.some((cell) => cell.kind === 'message' && cell.requestOnly !== true)).toBe(true)
  })

  it('keeps every pass of a replayed step row-less when each anchors a node', () => {
    const turns = deriveTrajectoryLayout({
      nodes: [assistantNode(1, 1, 6), assistantNode(1, 1, 34)],
      partial: null,
      runningCalls: [],
      requests: [assistantRequest(1, 1, 6), assistantRequest(1, 1, 34)],
    })
    expect(stepCells(turns, 'Step 1').filter((cell) => cell.requestOnly === true)).toHaveLength(0)
  })

  it('gives anchor-less retries of a represented step their own rows', () => {
    const turns = deriveTrajectoryLayout({
      nodes: [assistantNode(1, 1, 30)],
      partial: null,
      runningCalls: [],
      requests: [assistantRequest(1, 1, 6), assistantRequest(1, 1, 30)],
    })
    const requestOnly = stepCells(turns, 'Step 1').filter((cell) => cell.requestOnly === true)
    expect(requestOnly.map((cell) => cell.sourceSeq)).toEqual([6])
  })

  it('keeps anchored step-0 requests on their Message-group content row', () => {
    const turns = deriveTrajectoryLayout({
      nodes: [assistantNode(1, 0, 2)],
      partial: null,
      runningCalls: [],
      requests: [assistantRequest(1, 0, 2)],
    })
    const allCells = turns.flatMap((turn) => turn.groups.flatMap((group) => group.cells))
    expect(allCells.filter((cell) => cell.requestOnly === true)).toHaveLength(0)
    expect(allCells.some((cell) => cell.kind === 'message' && cell.sourceSeq === 2)).toBe(true)
  })

  it('renders every request when the step has no assistant node', () => {
    const turns = deriveTrajectoryLayout({
      nodes: [],
      partial: null,
      runningCalls: [],
      requests: [assistantRequest(1, 0, 2), assistantRequest(1, 0, 10)],
    })
    const cells = stepCells(turns, 'Step 0')
    expect(cells.filter((cell) => cell.requestOnly === true).map((cell) => cell.sourceSeq)).toEqual(
      [2, 10],
    )
  })
})
