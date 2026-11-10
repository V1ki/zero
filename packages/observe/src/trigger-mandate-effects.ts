import type { Database } from 'bun:sqlite'
import type { MandateDestination, MandateEffect, MandateWork } from '@zero-os/shared'

type Kind = MandateEffect['kind']
type Destination = Exclude<MandateEffect['destination'], null>
type Target = MandateEffect['target']
type Expected = { mandateRevision: number; routingRevision: number }

const readyEffects = `FROM mandate_effects e JOIN mandate_matches m ON m.id = e.match_id
  JOIN mandate_eligible_matches eligible ON eligible.id = m.id
  WHERE m.status = 'ready' AND e.kind = ?
  AND (e.status = 'pending' OR (e.status = 'deferred' AND e.due_at <= ?))`

function sameTarget(a: Target, b: Target): boolean {
  if (a === null || b === null) return a === b
  if (a.channelId !== b.channelId) return false
  if ('documentId' in a || 'documentId' in b)
    return 'documentId' in a && 'documentId' in b && a.documentId === b.documentId
  return a.platform === b.platform && a.peerId === b.peerId && a.operatorId === b.operatorId
}

function allowed(work: MandateWork, kind: Kind, destination: Destination, target: Target): boolean {
  if (kind === 'archive') {
    return destination === 'archive' && !!target && sameTarget(work.mandate.archive, target)
  }
  if (destination === 'web') return target === null
  return (
    !!target &&
    'platform' in target &&
    target.platform === destination &&
    work.mandate.targets.some((candidate) => sameTarget(candidate, target))
  )
}

export abstract class MandateEffectStore {
  constructor(protected readonly db: Database) {}

  abstract getWork(matchId: number): MandateWork | null

  private current(expected?: Expected): boolean {
    if (!expected) return true
    return !!this.db
      .query(`SELECT 1 FROM trigger_mandate_settings m, trigger_route_settings r
      WHERE m.id = 1 AND r.id = 1 AND m.revision = ? AND r.revision = ?`)
      .get(expected.mandateRevision, expected.routingRevision)
  }

  listReadyEffects(kind: Kind, now: string, limit = 100): MandateWork[] {
    const rows = this.db
      .query<{ id: number }, [string, string, number]>(
        `SELECT e.match_id AS id ${readyEffects} ORDER BY e.match_id LIMIT ?`,
      )
      .all(kind, new Date(now).toISOString(), Math.max(1, Math.min(200, limit)))
    return rows.flatMap(({ id }) => {
      const work = this.getWork(id)
      return work ? [work] : []
    })
  }

  nextEffect(kind: Kind, now: string): MandateWork | null {
    return this.listReadyEffects(kind, now, 1)[0] ?? null
  }

  hasPendingAnalysisBefore(mandateId: string, before: string): boolean {
    return !!this.db
      .query(`SELECT 1 FROM mandate_matches m
      JOIN mandate_eligible_matches eligible ON eligible.id = m.id
      JOIN trigger_inbox i ON i.id = m.inbox_id WHERE m.mandate_id = ?
      AND m.status IN ('pending', 'analyzing') AND i.received_at < ? LIMIT 1`)
      .get(mandateId, new Date(before).toISOString())
  }

  nextDueAt(): string | null {
    return (
      this.db
        .query<{ dueAt: string | null }, []>(`SELECT min(e.due_at) AS dueAt
      FROM mandate_effects e JOIN mandate_matches m ON m.id = e.match_id
      JOIN mandate_eligible_matches eligible ON eligible.id = m.id
      WHERE e.status = 'deferred' AND m.status = 'ready'`)
        .get()?.dueAt ?? null
    )
  }

  recheckDeferred(now: string): void {
    const dueAt = new Date(now).toISOString()
    this.db.run(
      `UPDATE mandate_effects SET due_at = ? WHERE status = 'deferred' AND due_at > ?
      AND match_id IN (SELECT id FROM mandate_eligible_matches)`,
      [dueAt, dueAt],
    )
  }

  deferEffect(
    matchId: number,
    kind: Kind,
    dueAt: string,
    reason: string,
    expected?: Expected,
  ): boolean {
    return this.db
      .transaction(
        () =>
          this.current(expected) &&
          this.db.run(
            `UPDATE mandate_effects SET status = 'deferred', destination = 'defer', target = NULL,
       due_at = ?, reason = ?, receipt = NULL
       WHERE match_id = ? AND kind = ? AND status IN ('pending','deferred')
       AND match_id IN (SELECT id FROM mandate_eligible_matches)
       AND match_id IN (SELECT id FROM mandate_matches WHERE status = 'ready')`,
            [new Date(dueAt).toISOString(), reason, matchId, kind],
          ).changes > 0,
      )
      .immediate()
  }

  skipEffect(matchId: number, kind: Kind, reason: string, expected?: Expected): boolean {
    return this.db
      .transaction(
        () =>
          this.current(expected) &&
          this.db.run(
            `UPDATE mandate_effects SET status = 'skipped', destination = 'none', target = NULL,
       due_at = NULL, reason = ?, receipt = NULL
       WHERE match_id = ? AND kind = ? AND status IN ('pending','deferred')
       AND match_id IN (SELECT id FROM mandate_eligible_matches)
       AND match_id IN (SELECT id FROM mandate_matches WHERE status = 'ready')`,
            [reason, matchId, kind],
          ).changes > 0,
      )
      .immediate()
  }

  /**
   * The dispatcher evaluates the routing policy separately for each candidate. Only the
   * explicitly requested, still eligible group may cross the send boundary together.
   */
  claimEffect(
    matchId: number,
    kind: Kind,
    destination: MandateDestination | 'archive',
    target: Target,
    reason: string,
    now: string,
    otherMatchIds: number[] = [],
    expected?: Expected,
  ): MandateWork[] {
    return this.db
      .transaction(() => {
        if (!this.current(expected)) return []
        const ids = [matchId, ...otherMatchIds]
        if (
          ids.length > 200 ||
          new Set(ids).size !== ids.length ||
          (kind === 'archive' && ids.length !== 1)
        )
          return []
        const ready = this.db.query(`SELECT 1 ${readyEffects} AND e.match_id = ?`)
        const at = new Date(now).toISOString()
        const work: MandateWork[] = []
        for (const id of ids) {
          if (!ready.get(kind, at, id)) return []
          const item = this.getWork(id)
          if (
            !item ||
            !allowed(item, kind, destination, target) ||
            (work[0] && work[0].mandate.id !== item.mandate.id)
          )
            return []
          work.push(item)
        }
        const claim = this.db.query(`UPDATE mandate_effects SET status = 'sending', destination = ?,
        target = ?, due_at = NULL, reason = ?, receipt = NULL WHERE match_id = ? AND kind = ?`)
        for (const item of work) {
          claim.run(
            destination,
            target ? JSON.stringify(target) : null,
            reason,
            item.match.id,
            kind,
          )
          // Return the committed snapshot to the dispatcher, including the claimed recipient.
          item.match.effects = item.match.effects.map((effect) =>
            effect.kind === kind
              ? {
                  ...effect,
                  status: 'sending',
                  destination,
                  target,
                  dueAt: null,
                  reason,
                  receipt: null,
                }
              : effect,
          )
        }
        return work
      })
      .immediate()
  }

  isAuthorizedEffect(matchId: number, kind: Kind, target: Target): boolean {
    return this.areEffectsAuthorized([matchId], kind, target)
  }

  areEffectsAuthorized(
    matchIds: readonly number[],
    kind: Kind,
    target: Target,
    expected?: Expected,
  ): boolean {
    return this.db
      .transaction(() => {
        if (!matchIds.length || !this.current(expected)) return false
        // All entries in a digest must still belong to the recipient in one SQLite snapshot.
        return matchIds.every((matchId) => {
          const work = this.getWork(matchId)
          const effect = work?.match.effects.find((effect) => effect.kind === kind)
          return (
            !!work &&
            effect?.status === 'sending' &&
            !!effect.destination &&
            sameTarget(effect.target, target) &&
            allowed(work, kind, effect.destination, target)
          )
        })
      })
      .deferred()
  }

  /** Called only if the adapter confirmed it never started a write for this claim. */
  releaseUnsentEffects(matchIds: number[], kind: Kind): void {
    this.db
      .transaction(() => {
        const release = this.db.query(`UPDATE mandate_effects SET
        status = CASE WHEN EXISTS (
          SELECT 1 FROM mandate_matches m JOIN mandate_tasks t ON m.task_id=t.id
          WHERE m.id=mandate_effects.match_id AND m.status='ready' AND t.active=1 AND t.paused=0
        ) THEN 'pending' ELSE 'revoked' END,
        destination=NULL, target=NULL, due_at=NULL, receipt=NULL,
        reason='投递前授权或规则已变更，原投递未发出。'
        WHERE match_id=? AND kind=? AND status='sending'`)
        for (const id of matchIds) release.run(id, kind)
      })
      .immediate()
  }

  finishEffect(
    matchId: number,
    kind: Kind,
    status: 'done' | 'failed' | 'unknown',
    receiptOrError: string,
  ): boolean {
    return (
      this.db.run(
        `UPDATE mandate_effects SET status = ?, receipt = ?
      WHERE match_id = ? AND kind = ? AND status = 'sending'`,
        [status, receiptOrError, matchId, kind],
      ).changes > 0
    )
  }

  /** Re-opens a failed effect, or a notification that triage skipped. Policy skips stay final. */
  retryEffect(matchId: number, kind: Kind): boolean {
    return (
      this.db.run(
        `UPDATE mandate_effects SET status = 'pending', destination = NULL, target = NULL,
      reason = NULL, due_at = NULL, receipt = NULL, triage = 0 WHERE match_id = ? AND kind = ?
      AND (status = 'failed' OR (status = 'skipped' AND kind = 'notify' AND triage = 1))
      AND match_id IN (SELECT id FROM mandate_eligible_matches)
      AND match_id IN (SELECT id FROM mandate_matches WHERE status = 'ready')`,
        [matchId, kind],
      ).changes > 0
    )
  }

  /** Only the sole dispatcher calls this during bootstrap. */
  recoverInterrupted(): void {
    this.db
      .transaction(() => {
        this.db.run(
          `UPDATE mandate_matches SET status = 'pending', claim_token = NULL WHERE status = 'analyzing'`,
        )
        // A Web notification is a local record. Only an external write can lose its receipt.
        this.db.run(`UPDATE mandate_effects SET status = 'done', receipt = 'web'
          WHERE kind = 'notify' AND destination = 'web' AND status = 'sending'`)
        this.db.run(
          `UPDATE mandate_effects SET status = 'unknown', receipt = ?
        WHERE status = 'sending'`,
          ['服务在取得回执前中断，请先核对投递结果。'],
        )
      })
      .immediate()
  }
}
