import { describe, expect, it } from 'bun:test'
import type { TrajectoryCellProps } from '../trajectory-record'
import { groupTrajectoryVirtualRows } from '../trajectory-virtual-rows'

function cell(
  partial: Partial<TrajectoryCellProps> & Pick<TrajectoryCellProps, 'index'>,
): TrajectoryCellProps {
  return {
    kind: 'message',
    text: '',
    ...partial,
  } as TrajectoryCellProps
}

describe('groupTrajectoryVirtualRows', () => {
  it('gives each request-only marker row its own compact height', () => {
    const rows = groupTrajectoryVirtualRows([
      { cell: cell({ index: 1 }) },
      { cell: cell({ index: 2, requestOnly: true }) },
      { cell: cell({ index: 3, requestOnly: true }) },
      { cell: cell({ index: 4 }) },
    ])
    expect(rows.map((row) => row.height)).toEqual([30, 18, 18, 30])
    expect(rows[1]?.entries).toHaveLength(1)
    expect(rows[1]?.entries[0]?.record.cell.index).toBe(2)
    expect(rows[2]?.entries[0]?.record.cell.index).toBe(3)
  })

  it('keeps trailing request-only rows measurable without a following content row', () => {
    const rows = groupTrajectoryVirtualRows([
      { cell: cell({ index: 7 }) },
      { cell: cell({ index: 8, requestOnly: true }) },
    ])
    expect(rows.map((row) => row.height)).toEqual([30, 18])
  })

  it('keeps collapsed summary heights for non-marker rows', () => {
    const rows = groupTrajectoryVirtualRows([
      { cell: cell({ index: 5 }), collapsedSummaryKind: 'turn' },
    ])
    expect(rows[0]?.height).toBe(20)
  })
})
