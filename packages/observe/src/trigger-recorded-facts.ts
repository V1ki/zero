import type { Database } from 'bun:sqlite'

/** Facts the Router summary counts that older rows never recorded. */
export type RecordedFact = 'mandate_triage_restored' | 'job_answered_option'

/**
 * Notes when a store first started recording a fact, so a summary can say which of its rows
 * predate it. Called inside the transaction that adds the column; later calls keep the first date.
 */
export function noteRecordedSince(db: Database, fact: RecordedFact): void {
  db.exec(`CREATE TABLE IF NOT EXISTS trigger_recorded_facts (
    fact TEXT PRIMARY KEY, since TEXT NOT NULL)`)
  db.run(
    "INSERT OR IGNORE INTO trigger_recorded_facts(fact,since) VALUES(?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    [fact],
  )
}
