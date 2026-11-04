import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'

/**
 * Historical IM replies lived on a task's first inbox event. The original audience digest
 * also included the task id. An accepted delivery plus that digest uniquely assigns a reply.
 */
export function migrateLegacyTaskTurns(db: Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS trigger_task_thread_upgrade (
      id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL);
      INSERT OR IGNORE INTO trigger_task_thread_upgrade VALUES(1,0);`)
    // A second reader must leave the old writer's pending turn in place until it finishes
    // or the sole dispatcher recovers it. Never revisit unprovable historical requests.
    const range = db
      .query<{ start: number; end: number }, []>(`SELECT cursor AS start,
      COALESCE((SELECT MIN(id)-1 FROM trigger_conversation_turns WHERE id>cursor AND status='pending'
        AND thread GLOB '[1-9]*' AND request_id LIKE 'im-%'),
        (SELECT COALESCE(MAX(id),0) FROM trigger_conversation_turns)) AS end
      FROM trigger_task_thread_upgrade WHERE id=1`)
      .get()
    if (!range || range.end <= range.start) return
    db.run('UPDATE trigger_task_thread_upgrade SET cursor=? WHERE id=1', [range.end])
    const legacy = db
      .query(`SELECT 1 FROM trigger_conversation_turns
      WHERE thread GLOB '[1-9]*' AND request_id LIKE 'im-%'
      AND status!='pending' AND id>? AND id<=? LIMIT 1`)
      .get(range.start, range.end)
    if (!legacy) return
    const bindings = db
      .query<
        {
          taskId: number
          anchor: number
          platform: string
          channelId: string
          peerId: string
          operatorId: string | null
        },
        []
      >(`SELECT DISTINCT m.task_id AS taskId,
      (SELECT inbox_id FROM mandate_matches first WHERE first.task_id=m.task_id ORDER BY first.id LIMIT 1) AS anchor,
      e.destination AS platform, json_extract(e.target,'$.channelId') AS channelId,
      json_extract(e.target,'$.peerId') AS peerId, json_extract(e.target,'$.operatorId') AS operatorId
      FROM mandate_effects e JOIN mandate_matches m ON m.id=e.match_id
      WHERE e.kind='notify' AND e.status='done' AND e.destination IN ('weixin','feishu','dingtalk')
      AND json_extract(e.target,'$.platform')=e.destination`)
      .all()
    const turns = db.query<
      { id: number; requestId: string },
      [string, string, string, number, number]
    >(
      `SELECT id,request_id AS requestId FROM trigger_conversation_turns c
       WHERE id>?4 AND id<=?5 AND thread=?1 AND request_id GLOB ?2 AND status!='pending' AND length(request_id)=132
       AND substr(request_id,69) NOT GLOB '*[^0-9a-f]*'
       AND NOT EXISTS(SELECT 1 FROM trigger_conversation_turns d WHERE d.thread=?3 AND d.request_id=c.request_id)
       AND NOT EXISTS(SELECT 1 FROM trigger_conversation_actions a WHERE a.thread IN (?1,?3) AND a.request_id=c.request_id)`,
    )
    for (const { taskId, anchor, platform, channelId, peerId, operatorId } of bindings) {
      const actor = operatorId ?? (platform === 'weixin' ? peerId : null)
      if (!channelId || !peerId || !actor) continue
      const audience = createHash('sha256')
        .update(JSON.stringify([platform, channelId, peerId, actor, 'true', String(taskId)]))
        .digest('hex')
      const destination = `task-${taskId}`
      for (const row of turns.all(
        String(anchor),
        `im-${audience}-*`,
        destination,
        range.start,
        range.end,
      )) {
        db.run('UPDATE trigger_conversation_turns SET thread=? WHERE id=?', [destination, row.id])
        db.run(
          "INSERT INTO trigger_conversation_actions(thread,request_id,identity) VALUES(?,?,'migrated')",
          [String(anchor), row.requestId],
        )
      }
    }
  }).immediate()
}
