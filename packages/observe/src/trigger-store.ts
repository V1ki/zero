import { Database } from 'bun:sqlite'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  type TriggerEvent,
  type TriggerInboxItem,
  type TriggerSettings,
  TriggerSettingsConflictError,
  type TriggerSettingsSnapshot,
  type TriggerSource,
} from '@zero-os/shared'

import { TriggerRoutingStore } from './trigger-routing-store'

export { TriggerSettingsConflictError }

export interface TriggerBatch {
  source: TriggerSource
  stream: string
  revision: number
  previousCursor: string | null
  cursor: string
  events: readonly TriggerEvent[]
}

function streamKey(source: TriggerSource, scope: string): string {
  return `${source}:${source === 'github' ? scope.toLowerCase() : scope}`
}

/** Only settings that change the event filter should reset its baseline. */
function activeFilters(settings: TriggerSettings): Map<string, string> {
  const filters = new Map<string, string>()
  for (const repo of settings.github.repositories) {
    if (repo.enabled) {
      filters.set(
        streamKey('github', repo.name),
        JSON.stringify([repo.branch, repo.workflow, repo.workflowFailures, repo.mention]),
      )
    }
  }
  for (const session of settings.wxarc.sessions) {
    if (session.enabled) filters.set(streamKey('wxarc', session.id), session.keyword)
  }
  return filters
}

export class TriggerStore {
  readonly routing: TriggerRoutingStore
  private readonly db: Database

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
      // SQLite inherits the database's permissions for WAL and shared-memory files.
      closeSync(openSync(dbPath, 'a', 0o600))
    }
    this.db = new Database(dbPath, { create: true })
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS trigger_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trigger_streams (
        stream TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        cursor TEXT
      );
      CREATE TABLE IF NOT EXISTS trigger_inbox (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        stream TEXT NOT NULL,
        event_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        url TEXT,
        UNIQUE (stream, event_id)
      );
    `)
    this.routing = new TriggerRoutingStore(this.db)
    const defaults: TriggerSettings = {
      github: { credentialRef: '', repositories: [] },
      wxarc: { sessions: [] },
    }
    this.db.run(
      'INSERT INTO trigger_settings (id, revision, json) VALUES (1, 0, ?) ON CONFLICT(id) DO NOTHING',
      [JSON.stringify(defaults)],
    )
  }

  getSettings(): TriggerSettingsSnapshot {
    const row = this.db
      .query<{ revision: number; json: string }, []>(
        'SELECT revision, json FROM trigger_settings WHERE id = 1',
      )
      .get()
    if (!row) throw new Error('Trigger settings are missing')
    return { revision: row.revision, settings: JSON.parse(row.json) as TriggerSettings }
  }

  saveSettings(
    settings: TriggerSettings,
    expectedRevision: number,
    githubLookbackHours?: 1 | 24,
  ): number {
    return this.db
      .transaction(() => {
        const current = this.getSettings()
        if (current.revision !== expectedRevision) throw new TriggerSettingsConflictError()
        const json = JSON.stringify(settings)
        if (JSON.stringify(current.settings) === json) return current.revision

        const before = activeFilters(current.settings)
        const after = activeFilters(settings)
        for (const stream of before.keys()) {
          if (!after.has(stream))
            this.db.run('DELETE FROM trigger_streams WHERE stream = ?', [stream])
        }
        const now = new Date()
        const githubStart = new Date(now.getTime() - (githubLookbackHours ?? 0) * 3_600_000)
        for (const [stream, filter] of after) {
          if (before.get(stream) !== filter) {
            this.db.run(
              `INSERT INTO trigger_streams (stream, started_at, cursor) VALUES (?, ?, NULL)
             ON CONFLICT(stream) DO UPDATE SET started_at = excluded.started_at, cursor = NULL`,
              [stream, (stream.startsWith('github:') ? githubStart : now).toISOString()],
            )
          }
        }
        const revision = current.revision + 1
        this.db.run('UPDATE trigger_settings SET revision = ?, json = ? WHERE id = 1', [
          revision,
          json,
        ])
        return revision
      })
      .immediate()
  }

  getStreamStartedAt(stream: string): string | null {
    return (
      this.db
        .query<{ startedAt: string }, [string]>(
          'SELECT started_at AS startedAt FROM trigger_streams WHERE stream = ?',
        )
        .get(stream)?.startedAt ?? null
    )
  }

  readCursor(stream: string): string | null {
    return (
      this.db
        .query<{ cursor: string | null }, [string]>(
          'SELECT cursor FROM trigger_streams WHERE stream = ?',
        )
        .get(stream)?.cursor ?? null
    )
  }

  /** A stale poll cannot write an event or advance the cursor of a newer subscription. */
  commitBatch(batch: TriggerBatch): boolean {
    return this.db
      .transaction(() => {
        const changed = this.db.run(
          `UPDATE trigger_streams SET cursor = ? WHERE stream = ? AND cursor IS ?
         AND (SELECT revision FROM trigger_settings WHERE id = 1) = ?`,
          [batch.cursor, batch.stream, batch.previousCursor, batch.revision],
        )
        if (changed.changes === 0) return false

        const insert = this.db.query(
          `INSERT INTO trigger_inbox (source, stream, event_id, scope, title, summary, occurred_at, received_at, url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(stream, event_id) DO NOTHING`,
        )
        const now = new Date().toISOString()
        for (const event of batch.events) {
          if (streamKey(batch.source, event.scope) !== batch.stream) {
            throw new Error('Trigger event scope does not match its subscription')
          }
          insert.run(
            batch.source,
            batch.stream,
            event.eventId,
            event.scope,
            event.title,
            event.summary,
            event.occurredAt,
            now,
            event.url ?? null,
          )
        }
        return true
      })
      .immediate()
  }

  listInbox(limit = 50, beforeId = Number.MAX_SAFE_INTEGER): TriggerInboxItem[] {
    type InboxRow = Omit<TriggerInboxItem, 'url'> & { url: string | null }
    const rows = this.db
      .query<InboxRow, [number, number]>(
        `SELECT id, source, event_id AS eventId, scope, title, summary,
              occurred_at AS occurredAt, received_at AS receivedAt, url
       FROM trigger_inbox WHERE id < ? ORDER BY id DESC LIMIT ?`,
      )
      .all(beforeId, Math.max(1, Math.min(200, limit)))
    return rows.map(({ url, ...row }) => (url === null ? row : { ...row, url }))
  }

  close(): void {
    this.db.close()
  }
}
