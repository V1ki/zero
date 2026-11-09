import type { Database } from 'bun:sqlite'
import type { RouterPublication, RouterPublicationChannel } from '@zero-os/shared'

export class RouterPublicationConflict extends Error {}
type Prepared = Omit<RouterPublication, 'createdAt' | 'deliveries'> & {
  deliveries: Array<{
    channel: RouterPublicationChannel
    presentation: RouterPublication['deliveries'][number]['presentation']
    target: string | null
    reason?: string
  }>
}
export class RouterPublicationStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS router_publications (
      id TEXT PRIMARY KEY,principal TEXT NOT NULL,matter_id TEXT NOT NULL,matter_version INTEGER NOT NULL,scope TEXT NOT NULL,created_at TEXT NOT NULL,request TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS router_publication_deliveries (
      publication_id TEXT NOT NULL,channel TEXT NOT NULL,presentation TEXT NOT NULL,target TEXT,
      status TEXT NOT NULL,receipt TEXT,reason TEXT,attempt INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(publication_id,channel)
    );`)
  }
  prepare(input: Prepared) {
    return this.db
      .transaction(() => {
        const request = JSON.stringify(input)
        const old = this.db
          .query<{ request: string }, [string]>(
            'SELECT request FROM router_publications WHERE id=?',
          )
          .get(input.id)
        if (old && old.request !== request)
          throw new RouterPublicationConflict('同一交付编号的内容发生变化。')
        if (!old) {
          this.db.run('INSERT INTO router_publications VALUES(?,?,?,?,?,?,?)', [
            input.id,
            input.principal,
            input.matterId,
            input.matterVersion,
            input.scope,
            new Date().toISOString(),
            request,
          ])
          for (const delivery of input.deliveries)
            this.db.run(
              'INSERT INTO router_publication_deliveries(publication_id,channel,presentation,target,status,reason) VALUES(?,?,?,?,?,?)',
              [
                input.id,
                delivery.channel,
                JSON.stringify(delivery.presentation),
                delivery.target,
                delivery.reason ? 'rejected' : 'pending',
                delivery.reason ?? null,
              ],
            )
        }
        const saved = this.get(input.principal, input.id)
        if (!saved) throw new RouterPublicationConflict('交付保存失败。')
        return saved
      })
      .immediate()
  }
  get(principal: string, id: string): RouterPublication | null {
    const row = this.db
      .query<Omit<RouterPublication, 'deliveries'>, [string, string]>(
        'SELECT id,principal,matter_id AS matterId,matter_version AS matterVersion,scope,created_at AS createdAt FROM router_publications WHERE principal=? AND id=?',
      )
      .get(principal, id)
    if (!row) return null
    const deliveries = this.db
      .query<
        Omit<RouterPublication['deliveries'][number], 'presentation'> & { presentation: string },
        [string]
      >(
        'SELECT channel,presentation,status,receipt,reason,attempt FROM router_publication_deliveries WHERE publication_id=? ORDER BY channel',
      )
      .all(id)
      .map((r) => ({ ...r, presentation: JSON.parse(r.presentation) }))
    return { ...row, deliveries }
  }
  list(principal: string, matterId?: string, limit = 30): RouterPublication[] {
    return this.db
      .query<{ id: string }, [string, string, string, number]>(
        "SELECT id FROM router_publications WHERE principal=? AND (?='' OR matter_id=?) ORDER BY created_at DESC,id DESC LIMIT ?",
      )
      .all(principal, matterId ?? '', matterId ?? '', Math.max(1, Math.min(100, limit)))
      .flatMap((r) => this.get(principal, r.id) ?? [])
  }
  target(principal: string, id: string, channel: RouterPublicationChannel): string | null {
    return (
      this.db
        .query<{ target: string | null }, [string, RouterPublicationChannel, string]>(
          'SELECT d.target FROM router_publication_deliveries d JOIN router_publications p ON p.id=d.publication_id WHERE p.id=? AND d.channel=? AND p.principal=?',
        )
        .get(id, channel, principal)?.target ?? null
    )
  }
  recentDeliveredTo(
    principal: string,
    channel: RouterPublicationChannel,
    audienceKey: string,
    receipt?: string,
  ) {
    return this.db
      .query<
        {
          publicationId: string
          matterId: string
          matterVersion: number
          title: string
          createdAt: string
        },
        (string | number)[]
      >(
        `SELECT p.id AS publicationId,p.matter_id AS matterId,p.matter_version AS matterVersion,
          json_extract(d.presentation,'$.title') AS title,p.created_at AS createdAt
        FROM router_publication_deliveries d JOIN router_publications p ON p.id=d.publication_id
        WHERE p.principal=? AND d.channel=? AND d.status='accepted' AND json_extract(d.target,'$.audienceKey')=?
        ${receipt === undefined ? '' : 'AND d.receipt=?'}
        ORDER BY p.created_at DESC,p.id DESC LIMIT ?`,
      )
      .all(principal, channel, audienceKey, ...(receipt === undefined ? [10] : [receipt, 1]))
  }
  searchDeliveredTo(
    principal: string,
    channel: RouterPublicationChannel,
    audienceKey: string | null,
    query: string,
    before: string | null,
    limit: number,
  ) {
    return this.db
      .query<
        {
          publicationId: string
          matterId: string
          title: string
          createdAt: string
          cursor: string
        },
        [string, RouterPublicationChannel, string | null, string, string | null, number]
      >(
        `SELECT p.id AS publicationId,p.matter_id AS matterId,p.created_at AS createdAt,
          json_extract(d.presentation,'$.title') AS title,p.created_at || '/' || p.id AS cursor
        FROM router_publications p JOIN router_publication_deliveries d ON d.publication_id=p.id
        WHERE p.principal=?1 AND d.channel=?2 AND d.status='accepted'
          AND (?2='web' OR (?3 IS NOT NULL AND json_extract(d.target,'$.audienceKey')=?3))
          AND (instr(lower(json_extract(d.presentation,'$.title')),lower(?4))>0
            OR instr(lower(json_extract(d.presentation,'$.text')),lower(?4))>0)
          AND (?5 IS NULL OR p.created_at || '/' || p.id < ?5)
        ORDER BY p.created_at DESC,p.id DESC LIMIT ?6`,
      )
      .all(principal, channel, audienceKey, query, before, limit)
  }
  pending() {
    return this.db
      .query<{ principal: string; id: string }, []>(
        "SELECT DISTINCT p.principal,p.id FROM router_publications p JOIN router_publication_deliveries d ON d.publication_id=p.id WHERE d.status='pending' ORDER BY p.created_at LIMIT 100",
      )
      .all()
  }
  claim(
    principal: string,
    id: string,
    channel: RouterPublicationChannel,
  ): { target: string | null; attempt: number } | null {
    return this.db
      .query<
        { target: string | null; attempt: number },
        [string, RouterPublicationChannel, string]
      >(
        `UPDATE router_publication_deliveries SET status='sending',attempt=attempt+1 WHERE publication_id=? AND channel=? AND status='pending' AND EXISTS(SELECT 1 FROM router_publications p WHERE p.id=publication_id AND p.principal=?) RETURNING target,attempt`,
      )
      .get(id, channel, principal)
  }
  finish(
    principal: string,
    id: string,
    channel: RouterPublicationChannel,
    attempt: number,
    result: Pick<RouterPublication['deliveries'][number], 'status' | 'receipt' | 'reason'>,
  ) {
    if (!['accepted', 'rejected', 'unknown'].includes(result.status))
      throw new RouterPublicationConflict('无效投递结果。')
    if (
      !this.db.run(
        `UPDATE router_publication_deliveries SET status=?,receipt=?,reason=? WHERE publication_id=? AND channel=? AND attempt=? AND status='sending' AND EXISTS(SELECT 1 FROM router_publications p WHERE p.id=publication_id AND p.principal=?)`,
        [result.status, result.receipt, result.reason, id, channel, attempt, principal],
      ).changes
    )
      throw new RouterPublicationConflict('投递执行权已变更。')
  }
  retry(principal: string, id: string, channel: RouterPublicationChannel, target: string | null) {
    if (
      !this.db.run(
        `UPDATE router_publication_deliveries SET status='pending',target=?,reason=NULL WHERE publication_id=? AND channel=? AND status='rejected' AND EXISTS(SELECT 1 FROM router_publications p WHERE p.id=publication_id AND p.principal=?)`,
        [target, id, channel, principal],
      ).changes
    )
      throw new RouterPublicationConflict(
        '仅能重试明确未发送的投递。成功和结果未知的投递不会重复发送。',
      )
  }
  unknownDeliveries() {
    return this.db
      .query<
        {
          id: string
          principal: string
          matterId: string
          channel: Exclude<RouterPublicationChannel, 'web'>
          attempt: number
          target: string
        },
        []
      >(
        "SELECT p.id,p.principal,p.matter_id AS matterId,d.channel,d.attempt,d.target FROM router_publications p JOIN router_publication_deliveries d ON p.id=d.publication_id WHERE d.status='unknown' AND d.channel!='web' AND d.target IS NOT NULL",
      )
      .all()
  }
  confirmReceipt(id: string, channel: RouterPublicationChannel, attempt: number, receipt: string) {
    this.db.run(
      "UPDATE router_publication_deliveries SET status='accepted',receipt=?,reason=NULL WHERE publication_id=? AND channel=? AND attempt=? AND status='unknown'",
      [receipt, id, channel, attempt],
    )
  }
  recoverInterrupted() {
    return this.db.run(
      "UPDATE router_publication_deliveries SET status='unknown',reason='发送期间进程退出，需先核对平台记录。' WHERE status='sending'",
    ).changes
  }
}
