import type { Database } from 'bun:sqlite'

export interface RouterOperation {
  key: string
  principal: string
  kind: string
  resource: string
  state: 'running' | 'accepted' | 'rejected' | 'unknown'
  result: unknown
  createdAt: string
  updatedAt: string
}
export class RouterOperationConflict extends Error {}
/** Durable effect journal. Unknown operations require reconciliation, never a new blind attempt. */
export class RouterOperationStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS router_operations (
      key TEXT PRIMARY KEY,principal TEXT NOT NULL,kind TEXT NOT NULL,resource TEXT NOT NULL,
      request TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );`)
  }
  get(principal: string, key: string): RouterOperation | null {
    const row = this.db
      .query<Omit<RouterOperation, 'result'> & { result: string | null }, [string, string]>(
        'SELECT key,principal,kind,resource,state,result,created_at AS createdAt,updated_at AS updatedAt FROM router_operations WHERE principal=? AND key=?',
      )
      .get(principal, key)
    return row ? { ...row, result: row.result === null ? null : JSON.parse(row.result) } : null
  }
  documentReceipts(principal: string, matterId: string) {
    return this.db
      .query<
        {
          key: string
          title: string
          state: RouterOperation['state']
          url: string | null
          reason: string | null
        },
        [string, string]
      >(`SELECT o.key,json_extract(o.request,'$.title') AS title,o.state,d.url,json_extract(o.result,'$.reason') AS reason
      FROM router_operations o LEFT JOIN router_documents d
        ON d.id=o.resource AND d.principal=o.principal AND d.version=json_extract(o.request,'$.targetVersion')
      WHERE o.principal=? AND o.kind='archive-document' AND json_extract(o.request,'$.matterId')=?
      ORDER BY o.created_at DESC`)
      .all(principal, matterId)
  }
  claim(input: {
    key: string
    principal: string
    kind: string
    resource: string
    request: unknown
  }): { claimed: boolean; operation: RouterOperation } {
    return this.db
      .transaction(() => {
        const request = JSON.stringify(input.request)
        const now = new Date().toISOString()
        const existing = this.db
          .query<{ principal: string; kind: string; resource: string; request: string }, [string]>(
            'SELECT principal,kind,resource,request FROM router_operations WHERE key=?',
          )
          .get(input.key)
        if (
          existing &&
          (existing.principal !== input.principal ||
            existing.kind !== input.kind ||
            existing.resource !== input.resource ||
            existing.request !== request)
        )
          throw new RouterOperationConflict('操作编号对应的身份、资源或内容已变化。')
        if (
          !existing &&
          this.db
            .query(
              "SELECT 1 FROM router_operations WHERE principal=? AND kind=? AND resource=? AND state IN ('running','unknown')",
            )
            .get(input.principal, input.kind, input.resource)
        )
          throw new RouterOperationConflict(
            '这个资源仍有执行中或结果待核实的操作。请先核对已有回执，不会创建另一次写入。',
          )
        if (!existing)
          this.db.run("INSERT INTO router_operations VALUES(?,?,?,?,?,'running',NULL,?,?)", [
            input.key,
            input.principal,
            input.kind,
            input.resource,
            request,
            now,
            now,
          ])
        const operation = this.get(input.principal, input.key)
        if (!operation) throw new RouterOperationConflict('无法读取已保存的操作。')
        return { claimed: !existing, operation }
      })
      .immediate()
  }
  finish(
    principal: string,
    key: string,
    state: 'accepted' | 'rejected' | 'unknown',
    result: unknown,
  ) {
    if (
      !this.db.run(
        "UPDATE router_operations SET state=?,result=?,updated_at=? WHERE principal=? AND key=? AND state='running'",
        [state, JSON.stringify(result), new Date().toISOString(), principal, key],
      ).changes
    )
      throw new RouterOperationConflict('该操作已结束或没有执行权。')
    return this.get(principal, key)
  }
  recoverInterrupted() {
    return this.db.run(
      "UPDATE router_operations SET state='unknown',updated_at=? WHERE state='running'",
      [new Date().toISOString()],
    ).changes
  }
}
