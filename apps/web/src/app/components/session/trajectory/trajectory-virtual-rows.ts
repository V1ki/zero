/** Pure projection from trajectory records to measurable virtual ledger rows. */

import type { TrajectoryCellProps } from './trajectory-record'
import { trajectoryRecordId } from './trajectory-record'

const CONTENT_ROW_HEIGHT = 30
const COLLAPSED_SUMMARY_HEIGHT = 20
/** Matches the request-only marker row height in TrajectoryTable.module.css. */
const REQUEST_ONLY_ROW_HEIGHT = 18

/** Minimal record shape required by the trajectory virtual-row projection. */
export interface VirtualizableTrajectoryRecord {
  cell: TrajectoryCellProps
  collapsedSummaryKind?: 'turn' | 'assistant'
}

/** One logical record retained inside a measurable virtual row. */
export interface TrajectoryVirtualRowEntry<T extends VirtualizableTrajectoryRecord> {
  logicalIndex: number
  record: T
}

/** One virtualizer item, which may carry zero-height request boundaries. */
export interface TrajectoryVirtualRow<T extends VirtualizableTrajectoryRecord> {
  entries: readonly TrajectoryVirtualRowEntry<T>[]
  height: number
  key: string
}

/**
 * Derive the DOM-safe row identity shared by React, the virtualizer, and
 * browser scroll contracts.
 * @param record - Display record whose identity is required.
 * @returns Stable record identity with a suffix for synthetic fold summaries.
 */
export function trajectoryVirtualRecordKey(record: VirtualizableTrajectoryRecord): string {
  const identity = encodeURIComponent(trajectoryRecordId(record.cell))
  return record.collapsedSummaryKind === undefined
    ? identity
    : `${identity}\u0000summary\u0000${record.collapsedSummaryKind}`
}

/**
 * Project every record onto its own measurable virtual row. Request-only
 * marker rows own a compact height so each boundary chip stacks visibly
 * instead of overlapping on the following content row.
 * @param records - Final search/fold projection in ledger order.
 * @returns Measurable virtual rows with original logical positions retained.
 */
export function groupTrajectoryVirtualRows<T extends VirtualizableTrajectoryRecord>(
  records: readonly T[],
): readonly TrajectoryVirtualRow<T>[] {
  const rows: TrajectoryVirtualRow<T>[] = []

  for (const [logicalIndex, record] of records.entries()) {
    const requestOnly = record.cell.requestOnly === true
    rows.push({
      entries: [{ logicalIndex, record }],
      height: requestOnly
        ? REQUEST_ONLY_ROW_HEIGHT
        : record.collapsedSummaryKind === undefined
          ? CONTENT_ROW_HEIGHT
          : COLLAPSED_SUMMARY_HEIGHT,
      key: trajectoryVirtualRecordKey(record),
    })
  }

  return rows
}
