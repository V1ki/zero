import type { Database } from 'bun:sqlite'

export type GithubReplyOutcome =
  | { state: 'sent'; id: number; url: string; author: string }
  | { state: 'unknown' }
  | { state: 'rejected'; error: string }

type Stored = GithubReplyOutcome | { state: 'pending' }
export type GithubReplyClaim = Stored | { state: 'conflict' } | { state: 'new' }
type Receipt = Stored & { fingerprint: string; owner: string }
const fields = 'r.fingerprint, r.owner, r.state, r.comment_id AS id, r.url, r.author, r.error'

function replay(row: Receipt): Stored {
  if (row.state === 'sent')
    return { state: row.state, id: row.id, url: row.url, author: row.author }
  if (row.state === 'rejected') return { state: row.state, error: row.error }
  return { state: row.state }
}

/** Reserve before posting. A crash or an uncertain remote outcome must never re-arm a public comment. */
export class GithubReplyStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS router_github_replies (
      inbox_id INTEGER NOT NULL, owner TEXT NOT NULL, fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','sent','unknown','rejected')),
      comment_id INTEGER, url TEXT, author TEXT, error TEXT,
      touched_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY(inbox_id,owner));
      CREATE UNIQUE INDEX IF NOT EXISTS router_github_replies_active
        ON router_github_replies(inbox_id,fingerprint) WHERE state <> 'rejected';
      CREATE TABLE IF NOT EXISTS router_github_reply_requests (
        inbox_id INTEGER NOT NULL, request_id TEXT NOT NULL, owner TEXT NOT NULL,
        PRIMARY KEY(inbox_id,request_id));`)
  }

  latest(inboxId: number) {
    const row = this.db
      .query<Receipt, [number]>(
        `SELECT ${fields} FROM router_github_replies r JOIN trigger_visible_inbox i ON i.id=r.inbox_id
         WHERE r.inbox_id=? ORDER BY r.touched_at DESC,r.rowid DESC LIMIT 1`,
      )
      .get(inboxId)
    if (!row) return undefined
    return {
      ...replay(row),
      origin: row.owner.startsWith('worker:') ? ('worker' as const) : ('manual' as const),
    }
  }

  /** fingerprint is SHA-256 of the server-resolved target, App and exact outbound text. */
  claim(inboxId: number, requestId: string, fingerprint: string): GithubReplyClaim {
    if (!requestId.trim() || requestId.length > 256 || !/^[a-f0-9]{64}$/.test(fingerprint))
      return { state: 'conflict' }
    return this.db
      .transaction((): GithubReplyClaim => {
        if (
          !this.db
            .query("SELECT 1 FROM trigger_visible_inbox WHERE id=? AND source='github'")
            .get(inboxId)
        )
          return { state: 'conflict' }
        const existing = this.db
          .query<Receipt, [number, string]>(
            `SELECT ${fields} FROM router_github_reply_requests q JOIN router_github_replies r
             ON r.inbox_id=q.inbox_id AND r.owner=q.owner WHERE q.inbox_id=? AND q.request_id=?`,
          )
          .get(inboxId, requestId)
        if (existing)
          return existing.fingerprint === fingerprint ? replay(existing) : { state: 'conflict' }
        // A reload can generate a fresh request ID for a submission that already reached GitHub.
        const prior = this.db
          .query<Receipt, [number, string]>(
            `SELECT ${fields} FROM router_github_replies r
             WHERE inbox_id=? AND fingerprint=? AND state <> 'rejected'`,
          )
          .get(inboxId, fingerprint)
        if (!prior) {
          this.db.run(
            "INSERT INTO router_github_replies(inbox_id,owner,fingerprint,state) VALUES(?,?,?,'pending')",
            [inboxId, requestId, fingerprint],
          )
        }
        this.db.run(
          'INSERT INTO router_github_reply_requests(inbox_id, request_id, owner) VALUES(?,?,?)',
          [inboxId, requestId, prior?.owner ?? requestId],
        )
        return prior ? replay(prior) : { state: 'new' }
      })
      .immediate()
  }

  /** Only the handler holding the new claim may finish it. error is a safe, user-facing rejection reason. */
  finish(inboxId: number, requestId: string, result: GithubReplyOutcome): void {
    const sent = result.state === 'sent' ? result : undefined
    const changed = this.db.run(
      `UPDATE router_github_replies SET state=?,comment_id=?,url=?,author=?,error=?,
        touched_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE inbox_id=? AND owner=? AND state='pending'`,
      [
        result.state,
        sent?.id ?? null,
        sent?.url ?? null,
        sent?.author ?? null,
        result.state === 'rejected' ? result.error : null,
        inboxId,
        requestId,
      ],
    ).changes
    if (!changed) throw new Error('GitHub 回复没有可完成的发送记录。')
  }
}
