import type { Database } from 'bun:sqlite'
import { isTriggerRetentionDays } from '@zero-os/shared'

const batchSize = 100
const taskStillOpen = `(t.active=1 OR t.updated_at > ?1 OR (t.acknowledged_at IS NOT NULL AND t.acknowledged_at > ?1)
  OR EXISTS(SELECT 1 FROM mandate_matches s WHERE s.task_id=t.id AND
    (s.status NOT IN ('ready','revoked')
    OR EXISTS(SELECT 1 FROM mandate_effects e WHERE e.match_id=s.id AND e.status NOT IN ('done','skipped','revoked'))
    OR EXISTS(SELECT 1 FROM mandate_audit a WHERE a.match_id=s.id AND a.at > ?1))))`
// Failed turns can still be retried.
const openTurn = `(c.status != 'completed')`

export class TriggerRetentionStore {
  constructor(private readonly db: Database) {
    db.exec(`
      PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS trigger_retention_state (
        id INTEGER PRIMARY KEY CHECK(id=1), enabled_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trigger_retired_inbox (id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS trigger_retired_task_threads (id INTEGER PRIMARY KEY);
      CREATE VIEW IF NOT EXISTS trigger_visible_inbox AS SELECT i.* FROM trigger_inbox i
        WHERE i.id NOT IN (SELECT id FROM trigger_retired_inbox);
      CREATE INDEX IF NOT EXISTS trigger_inbox_retention ON trigger_inbox(received_at);
      CREATE INDEX IF NOT EXISTS mandate_inbox_retention ON mandate_matches(inbox_id);
      CREATE INDEX IF NOT EXISTS mandate_audit_retention ON mandate_audit(match_id,at);
      CREATE TEMP TABLE IF NOT EXISTS retention_events (id INTEGER PRIMARY KEY);
      CREATE TEMP TABLE IF NOT EXISTS retention_tasks (id INTEGER PRIMARY KEY);
      CREATE TEMP TABLE IF NOT EXISTS retention_turns (id INTEGER PRIMARY KEY);
      CREATE TRIGGER IF NOT EXISTS trigger_retention_reset AFTER UPDATE OF json ON trigger_route_settings
      WHEN json_extract(NEW.json,'$.retentionDays') IS NOT json_extract(OLD.json,'$.retentionDays') BEGIN
        DELETE FROM trigger_retention_state WHERE json_extract(NEW.json,'$.retentionDays') IS NULL;
        INSERT OR IGNORE INTO trigger_retention_state(id,enabled_at)
          SELECT 1,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE json_extract(NEW.json,'$.retentionDays') IS NOT NULL;
      END;
      INSERT OR IGNORE INTO trigger_retention_state(id,enabled_at)
        SELECT 1,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM trigger_route_settings
        WHERE id=1 AND json_extract(json,'$.retentionDays') IS NOT NULL;
    `)
  }

  /** One bounded write transaction. De-duplication and monotonically allocated ids outlive the body. */
  sweep(now = new Date()): { events: number; turns: number; more: boolean } {
    return this.db
      .transaction(() => {
        const policy = this.db
          .query<{ days: number; enabledAt: string }, []>(
            `SELECT json_extract(r.json,'$.retentionDays') AS days, s.enabled_at AS enabledAt
         FROM trigger_route_settings r JOIN trigger_retention_state s ON s.id=r.id WHERE r.id=1`,
          )
          .get()
        if (!policy || !isTriggerRetentionDays(policy.days))
          return { events: 0, turns: 0, more: false }
        const cutoff = new Date(now.getTime() - policy.days * 86_400_000).toISOString()
        if (policy.enabledAt > cutoff) return { events: 0, turns: 0, more: false }

        this.db.exec(
          'DELETE FROM retention_events; DELETE FROM retention_turns; DELETE FROM retention_tasks;',
        )
        this.db.run(
          `INSERT INTO retention_events
        SELECT i.id FROM trigger_visible_inbox i WHERE i.received_at <= ?1
        AND (EXISTS(SELECT 1 FROM trigger_routes r WHERE r.inbox_id=i.id)
          OR EXISTS(SELECT 1 FROM mandate_matches m WHERE m.inbox_id=i.id))
        AND NOT EXISTS(SELECT 1 FROM trigger_routes r WHERE r.inbox_id=i.id
          AND (r.status NOT IN ('web','sent','cancelled') OR r.updated_at > ?1))
        AND NOT EXISTS(SELECT 1 FROM mandate_matches m JOIN mandate_tasks t ON t.id=m.task_id
          WHERE m.inbox_id=i.id AND (${taskStillOpen}
            OR EXISTS(SELECT 1 FROM trigger_visible_turns c WHERE c.thread='task-' || t.id
              AND (c.updated_at > ?1 OR ${openTurn}))))
        AND NOT EXISTS(SELECT 1 FROM trigger_visible_turns c WHERE c.thread=i.id
          AND (c.updated_at > ?1 OR ${openTurn}))
        ORDER BY i.received_at,i.id LIMIT ?2`,
          [cutoff, batchSize],
        )

        // Each retired mandate owns its conversation, even when a sibling still uses the same inbox event.
        const expiredTasks = this.db.run(
          `INSERT INTO retention_tasks SELECT t.id FROM mandate_tasks t
          WHERE t.id NOT IN (SELECT id FROM trigger_retired_task_threads) AND NOT ${taskStillOpen}
          AND NOT EXISTS(SELECT 1 FROM trigger_visible_turns c WHERE c.thread='task-' || t.id
            AND (c.updated_at > ?1 OR ${openTurn}))
          ORDER BY t.id LIMIT ?2`,
          [cutoff, batchSize],
        ).changes
        this.db.exec(`INSERT INTO retention_turns SELECT c.id FROM trigger_visible_turns c
          JOIN retention_events e ON c.thread=CAST(e.id AS TEXT);
          INSERT INTO retention_turns SELECT c.id FROM trigger_visible_turns c
          JOIN retention_tasks t ON c.thread='task-' || t.id;`)
        // A general conversation can run for years. Finished historical turns expire individually.
        this.db.run(
          `INSERT INTO retention_turns SELECT c.id FROM trigger_visible_turns c
        WHERE (c.thread='0' OR c.thread GLOB 'im-*') AND c.updated_at <= ?1 AND NOT ${openTurn}
        AND NOT EXISTS (SELECT 1 FROM trigger_conversation_turns pending
          WHERE pending.thread=c.thread AND pending.status='pending')
        ORDER BY c.id LIMIT ?2`,
          [cutoff, batchSize],
        )
        const counts = this.db
          .query<{ events: number; turns: number }, []>(`SELECT
        (SELECT count(*) FROM retention_events) AS events, (SELECT count(*) FROM retention_turns) AS turns`)
          .get()
        if (!counts) throw new Error('Missing retention counts')
        if (counts.events || counts.turns || expiredTasks) {
          this.db.exec(`
          INSERT INTO trigger_retired_inbox SELECT id FROM retention_events;
          INSERT INTO trigger_retired_task_threads SELECT id FROM retention_tasks;
          INSERT INTO trigger_retired_turns SELECT id FROM retention_turns;
          INSERT OR IGNORE INTO trigger_conversation_actions(thread,request_id,identity)
            SELECT thread,request_id,'expired' FROM trigger_conversation_turns WHERE id IN retention_turns;
          UPDATE trigger_conversation_turns SET question='',answer=NULL,error=NULL WHERE id IN retention_turns;
          UPDATE trigger_conversation_actions SET identity='expired' WHERE thread IN (SELECT CAST(id AS TEXT) FROM retention_events)
            OR thread IN (SELECT 'task-' || id FROM retention_tasks);
          UPDATE trigger_inbox SET title='',summary='',url=NULL WHERE id IN retention_events;
          UPDATE trigger_routes SET agent=NULL,session_id=NULL,decision=NULL,first_deferred=NULL,
            weixin_target=NULL,delivery_target=NULL,error=NULL WHERE inbox_id IN retention_events;
          UPDATE mandate_tasks SET title='正文已到期',session_id=NULL WHERE id IN retention_tasks;
          UPDATE mandate_matches SET summary=NULL,error=NULL WHERE task_id IN retention_tasks;
          UPDATE mandate_effects SET target=NULL,reason=NULL,receipt=NULL WHERE match_id IN
            (SELECT id FROM mandate_matches WHERE task_id IN retention_tasks);
        `)
        }
        const drafts = this.db.run(
          `UPDATE trigger_commission_drafts SET draft=''
        WHERE code IN (SELECT code FROM trigger_commission_drafts WHERE expires_at > 0 AND expires_at <= ?
        AND draft != '' ORDER BY expires_at LIMIT ?)`,
          [Date.parse(cutoff), batchSize],
        )
        // Keep request IDs for at-most-once execution after the private job body expires.
        const jobSteps = this.db.run(
          `UPDATE router_job_steps SET instruction='',result=NULL,thread_id=NULL,audience=NULL,
            repository=NULL,retired=1 WHERE job_id IN (
            SELECT job_id FROM router_job_steps WHERE retired=0 GROUP BY job_id
            HAVING max(updated_at)<=? AND max(CASE WHEN status IN ('queued','running')
              OR return_state IN ('pending','sending') THEN 1 ELSE 0 END)=0
            ORDER BY job_id LIMIT ?)`,
          [cutoff, batchSize],
        ).changes
        return {
          ...counts,
          more:
            jobSteps >= batchSize ||
            expiredTasks >= batchSize ||
            drafts.changes >= batchSize ||
            counts.events === batchSize ||
            counts.turns >= batchSize,
        }
      })
      .immediate()
  }
}
