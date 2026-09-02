import { describe, expect, it } from 'bun:test'
import { type TrajectoryTurnModel, deriveTrajectoryLayout } from '../layout'
import type { TrajectoryCellProps } from '../trajectory-record'
import type {
  AssistantMessageNode,
  AssistantRequestView,
  ContextMessageNode,
  ConversationLocation,
  RequestView,
} from '../types'

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

function assistantRequest(turn: number, step: number, startSeq: number): AssistantRequestView {
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

describe('deriveTrajectoryLayout request-only activity rows', () => {
  it('renders compacted-era tool calls and the response inside the step', () => {
    const view: RequestView = {
      purpose: 'assistant',
      turn: 2,
      step: 0,
      startSeq: 4,
      startedAt: 900,
      completedAt: 1400,
      status: 'complete',
      usage: { inputTokens: 12, outputTokens: 3 },
      activity: {
        response: '第一行\n第二行',
        toolCalls: [
          {
            id: 'call_x',
            name: 'fetch',
            argsRaw: '{"url":"https://a"}',
            result: 'html body',
            resultPreviewMarkdown: 'html body',
            startedAt: 1000,
            completedAt: 1200,
          },
        ],
      },
    }
    const turns = deriveTrajectoryLayout({
      nodes: [],
      partial: null,
      runningCalls: [],
      requests: [view],
    })
    const cells = stepCells(turns, 'Step 0')
    expect(cells.map((cell) => [cell.kind, cell.requestOnly === true])).toEqual([
      ['tool', false],
      ['message', true],
    ])
    const [tool, response] = cells
    expect(tool?.callId).toBe('call_x')
    expect(tool?.inputDetail).toBe('{"url":"https://a"}')
    expect(tool?.outputDetail).toBe('html body')
    expect(tool?.timeSeconds).toBe(0.2)
    expect(response?.text).toBe('第一行')
    expect(response?.input).toBe(12)
    expect(response?.output).toBe(3)
  })

  it('falls back to a tool-count label when the era response is empty', () => {
    const view: RequestView = {
      purpose: 'assistant',
      turn: 3,
      step: 0,
      startSeq: 2,
      startedAt: 500,
      completedAt: 900,
      status: 'complete',
      activity: {
        response: '',
        toolCalls: [{ id: 'call_y', name: 'bash', argsRaw: '{}', result: 'No output' }],
      },
    }
    const turns = deriveTrajectoryLayout({
      nodes: [],
      partial: null,
      runningCalls: [],
      requests: [view],
    })
    const cells = stepCells(turns, 'Step 0')
    expect(cells.at(-1)?.text).toBe('1 tool call')
  })

  it('opens the turn with the era user input and the initial SYSTEM record', () => {
    const eraView: RequestView = {
      ...assistantRequest(2, 0, 4),
      activity: { response: 'r', toolCalls: [], turnPrompt: '去下载漫画' },
    }
    const windowView: RequestView = {
      ...assistantRequest(5, 0, 30),
      prompt: { config: { provider: 'p', model: 'm' }, system: 'sys', tools: [] },
      promptChange: { seq: -1, time: 0, kind: 'initial' },
    }
    const turns = deriveTrajectoryLayout({
      nodes: [assistantNode(5, 0, 30)],
      partial: null,
      runningCalls: [],
      requests: [windowView, eraView],
    })
    const kinds = turns
      .find((turn) => turn.turn === 2)
      ?.groups.flatMap((group) => group.cells.map((cell) => cell.kind))
    expect(kinds?.slice(0, 3)).toEqual(['system', 'user', 'message'])
    const userCell = turns
      .find((turn) => turn.turn === 2)
      ?.groups.flatMap((group) => group.cells)
      .find((cell) => cell.kind === 'user')
    expect(userCell).toMatchObject({ text: '去下载漫画', opensTurn: true })
  })
})

describe('deriveTrajectoryLayout pre-window gate records', () => {
  it('places compaction-era context records in their located turn', () => {
    // Gate events that predate every assistant carry a turn location derived
    // from the request timeline; the layout must honor it instead of folding
    // them all into the first assistant's turn.
    const context: ContextMessageNode = {
      kind: 'context',
      seq: 1,
      time: 1000,
      content: [{ type: 'text', text: 'memory nudge' }],
      source: { kind: 'memory nudge' },
      provenance: { role: 'system', name: 'memory nudge' },
      form: 'memory-nudge',
    }
    const eventLocations = new Map<number, ConversationLocation>([
      [1, { kind: 'turn', turn: { turn: 2 } }],
    ])
    const turns = deriveTrajectoryLayout({
      nodes: [context, assistantNode(5, 0, 30)],
      eventLocations,
      partial: null,
      runningCalls: [],
      requests: [],
    })

    expect(turns.map((turn) => turn.turn)).toContain(2)
    const locatedCells = turns
      .find((turn) => turn.turn === 2)
      ?.groups.flatMap((group) => group.cells)
    expect(locatedCells?.some((cell) => cell.kind === 'context')).toBe(true)
    const assistantCells = turns
      .find((turn) => turn.turn === 5)
      ?.groups.flatMap((group) => group.cells)
    expect(assistantCells?.some((cell) => cell.kind === 'context')).toBe(false)
  })

  it('slots floating compaction markers between turns by start time', () => {
    const contextAt = (seq: number, time: number): ContextMessageNode => ({
      kind: 'context',
      seq,
      time,
      content: [{ type: 'text', text: `gate ${seq}` }],
      source: { kind: 'memory nudge' },
      provenance: { role: 'system', name: 'memory nudge' },
      form: 'memory-nudge',
    })
    const nodes = [contextAt(1, 1000), contextAt(2, 5000), contextAt(3, 9000)]
    const eventLocations = new Map<number, ConversationLocation>([
      [1, { kind: 'turn', turn: { turn: 2 } }],
      [2, { kind: 'turn', turn: { turn: 4 } }],
      [3, { kind: 'turn', turn: { turn: 6 } }],
    ])
    const compactionAt = (startSeq: number, startedAt: number): RequestView => ({
      purpose: 'compaction',
      turn: null,
      step: 0,
      startSeq,
      startedAt,
      completedAt: startedAt + 100,
      status: 'complete',
    })
    const turns = deriveTrajectoryLayout({
      nodes,
      eventLocations,
      partial: null,
      runningCalls: [],
      requests: [compactionAt(10, 3000), compactionAt(11, 500), compactionAt(12, 7000)],
    })

    expect(turns.map((turn) => turn.turn)).toEqual([null, 2, null, 4, null, 6])
  })
})
