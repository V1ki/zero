import type { Database } from 'bun:sqlite'
import {
  type RouterTrackingResult,
  type TriggerInboxItem,
  routerFollowupSignal,
} from '@zero-os/shared'
import type { RouterJob, RouterJobStore } from './router-job-store'

// Same local Web principal as RouterJobPrincipals.current('web', false).
const audience = JSON.stringify(['web', null, null])

export class RouterArchiveStore {
  constructor(
    private readonly db: Database,
    private readonly host: {
      jobs: RouterJobStore
      getInboxItem(id: number): TriggerInboxItem | null
    },
  ) {
    // Consent for model processing is distinct from consent to collect text. Keep grants
    // stable over unrelated edits, but do not resurrect queued work on a later regrant.
    db.exec(`CREATE TABLE IF NOT EXISTS router_archive_grants (
      generation INTEGER PRIMARY KEY AUTOINCREMENT, stream TEXT NOT NULL UNIQUE);
      INSERT OR IGNORE INTO router_archive_grants(stream)
        SELECT s.stream FROM trigger_streams s WHERE s.stream LIKE 'wxarc:%'
        AND NOT EXISTS(SELECT 1 FROM router_archive_grants g WHERE g.stream=s.stream);
      INSERT OR IGNORE INTO router_archive_grants(stream) SELECT 'model' FROM trigger_route_settings
        WHERE json_extract(json,'$.enabled')=1 AND NOT EXISTS(SELECT 1 FROM router_archive_grants WHERE stream='model');
      CREATE TRIGGER IF NOT EXISTS router_archive_stream_added AFTER INSERT ON trigger_streams
      WHEN NEW.stream LIKE 'wxarc:%' BEGIN INSERT INTO router_archive_grants(stream) VALUES(NEW.stream); END;
      CREATE TRIGGER IF NOT EXISTS router_archive_stream_changed AFTER UPDATE OF started_at ON trigger_streams
      WHEN NEW.stream LIKE 'wxarc:%' BEGIN
        DELETE FROM router_archive_grants WHERE stream=NEW.stream;
        INSERT INTO router_archive_grants(stream) VALUES(NEW.stream);
      END;
      CREATE TRIGGER IF NOT EXISTS router_archive_stream_removed AFTER DELETE ON trigger_streams
      WHEN OLD.stream LIKE 'wxarc:%' BEGIN DELETE FROM router_archive_grants WHERE stream=OLD.stream; END;
      CREATE TRIGGER IF NOT EXISTS router_archive_model_consent AFTER UPDATE OF json ON trigger_route_settings
      WHEN json_extract(NEW.json,'$.enabled') IS NOT json_extract(OLD.json,'$.enabled') BEGIN
        DELETE FROM router_archive_grants WHERE stream='model';
        INSERT INTO router_archive_grants(stream) SELECT 'model' WHERE json_extract(NEW.json,'$.enabled')=1;
      END;`)
  }

  private authority(event: TriggerInboxItem) {
    // The existing routing engine creates a subscription receipt only for events it is
    // authorized to analyze. A custom mandate can instead request direct, model-free delivery.
    const grant = this.db
      .query<{ stream: number; model: number }, [string, number]>(
        `SELECT s.generation AS stream,m.generation AS model FROM router_archive_grants s,router_archive_grants m
       WHERE s.stream=?1 AND m.stream='model'
       AND EXISTS(SELECT 1 FROM trigger_routes WHERE inbox_id=?2 AND origin='subscription' AND status<>'cancelled')
       AND NOT EXISTS(SELECT 1 FROM mandates WHERE stream=?1 AND json_extract(definition,'$.enabled')=1)`,
      )
      .get(`wxarc:${event.scope}`, event.id)
    return (
      grant && {
        scope: 'general' as const,
        audience,
        kind: 'event-followup' as const,
        authority: JSON.stringify([grant.stream, grant.model]),
      }
    )
  }

  modelAuthority(event: TriggerInboxItem) {
    return this.authority(event)?.authority
  }

  hasRouterGrant(event: TriggerInboxItem) {
    const current = this.modelAuthority(event)
    if (!current) return false
    const saved = this.db
      .query<{ grant: string | null }, [string]>(
        "SELECT json_extract(payload,'$.archiveAuthority') AS grant FROM router_signals WHERE key=?",
      )
      .get(`inbox:${event.id}`)
    if (saved?.grant === current) return true
    // A pre-Router Worker retains its original grant and may still be visible after migration.
    const bound = this.host.jobs.followups.latestForKey(`inbox:${event.id}`)
    const job = bound && this.host.jobs.get('general', bound.jobId, bound.attempt ?? undefined)
    return !!job && !!this.eventForJob(job)
  }

  match(event: TriggerInboxItem) {
    if (event.source !== 'wxarc' || !/^wxarc:text:[1-9]\d*$/u.test(event.eventId)) return
    const grant = this.authority(event)
    if (!grant) return
    let subject = routerFollowupSignal(event).subject
    if (event.wxarcReplyToEventId) {
      const parent = this.db
        .query<{ id: number }, [string, string]>(
          'SELECT id FROM trigger_visible_inbox WHERE stream=? AND event_id=?',
        )
        .get(`wxarc:${event.scope}`, event.wxarcReplyToEventId)
      const bound = parent && this.host.jobs.followups.latestForKey(`inbox:${parent.id}`)
      const first = bound && this.host.jobs.get('general', bound.jobId, 1)
      const root = first && this.eventForJob(first)
      if (
        root?.scope === event.scope &&
        first &&
        this.host.jobs.followups.matchesAuthority(first.id, grant)
      )
        subject = routerFollowupSignal(root).subject
    }
    this.host.jobs.followups.receive({
      ...grant,
      subject,
      eventKey: `inbox:${event.id}`,
      instruction: '核对这条已获准分析的归档摘录，在本机事件中交付结果。',
    })
  }

  eventForJob(job: RouterJob) {
    if (
      job.kind !== 'event-followup' ||
      job.scope !== 'general' ||
      job.audience !== audience ||
      job.repository ||
      job.executor !== 'zero'
    )
      return null
    const step = this.host.jobs.followups.step(job.id, job.attempt)
    const match = step && /^inbox:([1-9]\d*)$/u.exec(step.eventKey)
    const event = match && this.host.getInboxItem(Number(match[1]))
    if (!event || event.source !== 'wxarc') return null
    const grant = this.authority(event)
    return grant && this.host.jobs.followups.matchesAuthority(job.id, grant) ? event : null
  }

  recent(scope: string) {
    const candidates = this.db
      .query<{ inboxId: number; eventId: string; occurredAt: string; summary: string }, [string]>(
        `SELECT i.id AS inboxId,i.event_id AS eventId,i.occurred_at AS occurredAt,i.summary FROM trigger_visible_inbox i
       WHERE i.stream=? ORDER BY i.id DESC LIMIT 48`,
      )
      .all(`wxarc:${scope}`)
    return candidates.flatMap((row) => {
      const event = this.host.getInboxItem(row.inboxId)
      return event && this.hasRouterGrant(event)
        ? [
            {
              id: Number(row.eventId.slice('wxarc:text:'.length)),
              occurredAt: row.occurredAt,
              summary: row.summary,
            },
          ]
        : []
    })
  }

  previousForJob(job: RouterJob) {
    if (job.attempt <= 1) return
    const prior = this.host.jobs
      .history('general', job.id)
      .filter((step) => step.attempt < job.attempt && step.work && this.eventForJob(step))
    return prior.findLast((step) => step.work?.followup?.decision === 'act') ?? prior.at(-1)
  }

  resultForEvent(
    inboxId: number,
    allowed: (job: RouterJob) => boolean,
  ): RouterTrackingResult | undefined {
    const bound = this.host.jobs.followups.latestForKey(`inbox:${inboxId}`)
    if (!bound) return
    const job = this.host.jobs.get('general', bound.jobId, bound.attempt ?? undefined)
    if (!job || job.kind !== 'event-followup' || !allowed(job)) return
    const event = this.host.getInboxItem(inboxId)
    const grant = event?.source === 'wxarc' && this.authority(event)
    if (!event || !grant || !this.host.jobs.followups.matchesAuthority(job.id, grant)) return
    const pending = bound.attempt === null
    return {
      id: job.id,
      ...(bound.attempt && { attempt: bound.attempt }),
      inboxId,
      kind: 'archive-message',
      source: 'wxarc',
      repository: '',
      occurredAt: event.occurredAt,
      title: event.title,
      status: pending ? 'queued' : job.status,
      result: pending ? null : job.result,
      ...(!pending && job.work && { work: job.work }),
      needsAttention:
        !pending &&
        (job.work?.outcome === 'needs_input' ||
          job.status === 'failed' ||
          job.status === 'unknown'),
    }
  }

  listResults(limit: number, before: number, allowed: (job: RouterJob) => boolean) {
    const items: RouterTrackingResult[] = []
    const rows = this.db
      .query<{ id: number }, [number]>(`SELECT i.id FROM trigger_visible_inbox i
      JOIN router_followup_inputs f ON f.event_key='inbox:' || i.id
      WHERE i.source='wxarc' AND i.id<? ORDER BY i.id DESC`)
      .iterate(before)
    for (const { id } of rows) {
      const item = this.resultForEvent(id, allowed)
      if (item) items.push(item)
      if (items.length >= limit) break
    }
    return items
  }
}
