import type { Database } from 'bun:sqlite'
import type { RouterSummaryCounts } from '@zero-os/shared'

/** The fixed notes a mandate investigation appends when its reading did not back the summary. */
export interface RouterSummaryNotes {
  unread: string
  unfinished: string
}
export interface RouterSummaryBounds {
  from: string
  to: string
}

type Row = Record<string, number | null>
const n = (value: number | null | undefined) => value ?? 0
/** True when the summary ends with the fixed note. Retention-cleared summaries are NULL. */
const endsWith = (param: string) =>
  `(m.summary IS NOT NULL AND substr(m.summary, -length(${param})) = ${param})`
const investigateMode = `(i.source = 'github' AND CASE WHEN json_valid(d.definition)
  THEN json_extract(d.definition, '$.processing') END = 'investigate')`
const report = (path: string) =>
  `CASE WHEN json_valid(report) THEN json_extract(report, '${path}') END`
const decided = `report_state = 'ready' AND retired = 0 AND ${report('$.decision')} IS NOT NULL`

/**
 * One statement per figure group. Each starts from an index range on the window's own timestamp,
 * with the join order pinned (CROSS JOIN) so that SQLite cannot start from a whole table instead.
 */
export const routerSummaryQueries = {
  // A personal route reaches web or sent once; neither status is ever left, so updated_at stays
  // the delivery time. Uncertain sends are not counted as delivered.
  personal: `SELECT count(*) AS n FROM trigger_routes
    WHERE status IN ('web', 'sent') AND updated_at >= $from AND updated_at < $to`,
  // A mandate notification has no timestamp of its own; its audit row records the moment it
  // became done. Done is final, and a digest marks each of its events done.
  mandate: `SELECT count(*) AS notified,
      sum(investigated) AS investigated,
      sum(investigated AND unread) AS unread,
      sum(investigated AND unfinished) AS unfinished,
      sum(investigated AND expired) AS expired
    FROM (
      SELECT (${investigateMode} OR ${endsWith('$unread')} OR ${endsWith('$unfinished')}) AS investigated,
        ${endsWith('$unread')} AS unread, ${endsWith('$unfinished')} AS unfinished,
        (m.summary IS NULL) AS expired
      FROM (SELECT DISTINCT match_id FROM mandate_audit
        WHERE action = 'notify' AND at >= $from AND at < $to AND detail GLOB 'done*') a
      CROSS JOIN mandate_effects e ON e.match_id = a.match_id AND e.kind = 'notify' AND e.status = 'done'
      CROSS JOIN mandate_matches m ON m.id = a.match_id
      LEFT JOIN trigger_inbox i ON i.id = m.inbox_id
      LEFT JOIN mandates d ON d.id = m.mandate_id
    )`,
  // Triage runs right after an event arrives, and filtered rows keep no filter time of their
  // own, so both pipelines are windowed by when the event was received.
  routeTriage: `SELECT
      sum(r.status = 'filtered' AND r.triage_restored = 0) AS filtered,
      sum(r.triage_restored = 1) AS restored
    FROM trigger_inbox i CROSS JOIN trigger_routes r ON r.inbox_id = i.id
    WHERE i.received_at >= $from AND i.received_at < $to`,
  mandateTriage: `SELECT
      sum(e.status = 'skipped' AND e.triage = 1 AND e.triage_restored = 0) AS filtered,
      sum(e.triage_restored = 1) AS restored
    FROM trigger_inbox i CROSS JOIN mandate_matches m ON m.inbox_id = i.id
    CROSS JOIN mandate_effects e ON e.match_id = m.id AND e.kind = 'notify'
    WHERE i.received_at >= $from AND i.received_at < $to`,
  // A completed step's updated_at is when it finished, or later when its result was returned.
  jobs: `SELECT count(*) AS completed,
      sum(report_state = 'ready') AS ready,
      sum(report_state = 'none') AS raw,
      sum(report_state = 'pending') AS pending,
      sum(report_state IS NULL) AS unrequested,
      sum(report_state = 'ready' AND retired = 1) AS expired,
      sum(${decided}) AS decisions,
      sum(${decided} AND answered_option IS NOT NULL) AS answered,
      sum(${decided} AND answered_option = ${report('$.decision.recommended')}) AS recommended
    FROM router_job_steps
    WHERE status = 'completed' AND updated_at >= $from AND updated_at < $to`,
} as const

/** Read-only counts over a window [from, to) for the Router summary view. */
export class RouterSummaryStore {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS trigger_routes_delivered ON trigger_routes(status, updated_at);
      CREATE INDEX IF NOT EXISTS mandate_audit_time ON mandate_audit(action, at);
      CREATE INDEX IF NOT EXISTS router_jobs_completed ON router_job_steps(updated_at)
        WHERE status = 'completed';
    `)
  }

  /** All windows come from one read snapshot. */
  read(windows: readonly RouterSummaryBounds[], notes: RouterSummaryNotes): RouterSummaryCounts[] {
    return this.db.transaction(() => windows.map((bounds) => this.counts(bounds, notes))).deferred()
  }

  /** The later of the dates the restore mark and the answered option began to be recorded. */
  recordedSince(): string | null {
    if (
      !this.db
        .query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='trigger_recorded_facts'")
        .get()
    )
      return null
    return (
      this.db
        .query<{ since: string | null }, []>(
          `SELECT max(since) AS since FROM trigger_recorded_facts
          WHERE fact IN ('mandate_triage_restored', 'job_answered_option')`,
        )
        .get()?.since ?? null
    )
  }

  private counts({ from, to }: RouterSummaryBounds, notes: RouterSummaryNotes) {
    const window = { $from: from, $to: to }
    const get = (sql: string, params: Record<string, string> = window) =>
      this.db.query<Row, [Record<string, string>]>(sql).get(params)
    const personal = get(routerSummaryQueries.personal)
    const mandate = get(routerSummaryQueries.mandate, {
      ...window,
      $unread: notes.unread,
      $unfinished: notes.unfinished,
    })
    const routeTriage = get(routerSummaryQueries.routeTriage)
    const mandateTriage = get(routerSummaryQueries.mandateTriage)
    const jobs = get(routerSummaryQueries.jobs)
    return {
      notifications: { personal: n(personal?.n), mandate: n(mandate?.notified) },
      triage: {
        filtered: n(routeTriage?.filtered) + n(mandateTriage?.filtered),
        restored: n(routeTriage?.restored) + n(mandateTriage?.restored),
      },
      investigation: {
        notified: n(mandate?.investigated),
        unread: n(mandate?.unread),
        unfinished: n(mandate?.unfinished),
        expired: n(mandate?.expired),
      },
      reports: {
        completed: n(jobs?.completed),
        ready: n(jobs?.ready),
        raw: n(jobs?.raw),
        pending: n(jobs?.pending),
        unrequested: n(jobs?.unrequested),
        expired: n(jobs?.expired),
        decisions: n(jobs?.decisions),
        answered: n(jobs?.answered),
        recommended: n(jobs?.recommended),
      },
    } satisfies RouterSummaryCounts
  }
}
