import type { Database } from 'bun:sqlite'
import type { TriggerWebNotification, TriggerWebNotificationQuery } from '@zero-os/shared'

/** Only receipt pointers are persisted. Bodies follow the inbox/task retention and access rules. */
export class TriggerWebNotificationStore {
  constructor(private readonly db: Database) {
    db.transaction(() => {
      const installed = db
        .query(
          "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='trigger_web_notifications'",
        )
        .get()
      db.exec(`
        CREATE TABLE IF NOT EXISTS trigger_web_notifications(
          id INTEGER PRIMARY KEY AUTOINCREMENT, inbox_id INTEGER NOT NULL, match_id INTEGER UNIQUE,
          created_at TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS trigger_web_notifications_legacy_event
          ON trigger_web_notifications(inbox_id) WHERE match_id IS NULL;
        CREATE TRIGGER IF NOT EXISTS trigger_web_notification_legacy AFTER UPDATE OF status ON trigger_routes
          WHEN NEW.status='web' AND OLD.status!='web' AND NEW.web_id IS NOT NULL BEGIN
          INSERT OR IGNORE INTO trigger_web_notifications(inbox_id,created_at) VALUES(NEW.inbox_id,NEW.updated_at);
        END;
        CREATE TRIGGER IF NOT EXISTS trigger_web_notification_mandate AFTER UPDATE OF status ON mandate_effects
          WHEN NEW.kind='notify' AND NEW.status='done' AND OLD.status!='done' AND NEW.destination='web' AND NEW.target IS NULL BEGIN
          INSERT OR IGNORE INTO trigger_web_notifications(inbox_id,match_id,created_at)
          SELECT inbox_id,id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM mandate_matches WHERE id=NEW.match_id;
        END;
      `)
      if (!installed) {
        db.exec(`INSERT INTO trigger_web_notifications(inbox_id,match_id,created_at)
          SELECT inbox_id,match_id,at FROM (
            SELECT inbox_id,NULL AS match_id,updated_at AS at FROM trigger_routes WHERE web_id IS NOT NULL
            UNION ALL
            SELECT m.inbox_id,m.id,COALESCE((
              SELECT MAX(a.at) FROM mandate_audit a WHERE a.match_id=m.id AND a.action='notify' AND a.detail='done · web'
            ), i.received_at) AS at FROM mandate_effects e
            JOIN mandate_matches m ON e.match_id=m.id JOIN trigger_inbox i ON i.id=m.inbox_id
            WHERE e.kind='notify' AND e.status='done' AND e.destination='web' AND e.target IS NULL
          ) ORDER BY at,inbox_id,match_id`)
      }
    }).immediate()
  }

  latestId(): number {
    return (
      this.db
        .query<{ id: number }, []>(
          'SELECT COALESCE(MAX(id),0) AS id FROM trigger_web_notifications',
        )
        .get()?.id ?? 0
    )
  }

  list({ after, before, limit = 50, brief = false }: TriggerWebNotificationQuery = {}) {
    const forward = after !== undefined
    const filter = forward ? 'n.id>?' : before === undefined ? '1=1' : 'n.id<?'
    const cursor = after ?? before
    const body = brief
      ? ''
      : `, i.title,
      CASE WHEN n.match_id IS NOT NULL THEN m.summary ELSE json_extract(r.agent,'$.summary') END AS summary`
    // Read the page and its high water mark from the same SQLite snapshot.
    return this.db
      .transaction(() => ({
        items: this.db
          .query<TriggerWebNotification, number[]>(`
        SELECT n.id,n.inbox_id AS inboxId,m.task_id AS taskId,n.created_at AS createdAt ${body}
        FROM trigger_web_notifications n JOIN trigger_visible_inbox i ON i.id=n.inbox_id
        LEFT JOIN mandate_matches m ON m.id=n.match_id
        ${brief ? '' : 'LEFT JOIN trigger_routes r ON r.inbox_id=n.inbox_id AND n.match_id IS NULL'}
        WHERE ${filter} AND (n.match_id IS NULL OR (m.id IS NOT NULL AND
          NOT EXISTS(SELECT 1 FROM trigger_retired_task_threads t WHERE t.id=m.task_id)))
        ORDER BY n.id ${forward ? 'ASC' : 'DESC'} LIMIT ?`)
          .all(...(cursor === undefined ? [] : [cursor]), Math.max(1, Math.min(100, limit))),
        latestId: this.latestId(),
      }))
      .deferred()
  }

  private readonly changes = new EventTarget()

  subscribe(listener: () => void): () => void {
    this.changes.addEventListener('change', listener)
    return () => this.changes.removeEventListener('change', listener)
  }

  changed() {
    this.changes.dispatchEvent(new Event('change'))
  }
}
