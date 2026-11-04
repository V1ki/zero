import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import type {
  CommissionChange,
  CommissionGrant,
  CommissionPreview,
  TriggerMandate,
} from '@zero-os/shared'

export interface CommissionDraft {
  principal: string
  requestId: string
  question: string
  preview: CommissionPreview
  change: CommissionChange
  revision: number
  sourceRevision: number
  grantRevision: number
}

function fingerprint(mandate: TriggerMandate) {
  return createHash('sha256').update(JSON.stringify(mandate)).digest('hex')
}

export class TriggerCommissionStore {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS trigger_commission_grants (
        id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, grants TEXT NOT NULL
      );
      INSERT OR IGNORE INTO trigger_commission_grants VALUES(1, 0, '[]');
      CREATE TABLE IF NOT EXISTS trigger_commission_drafts (
        code TEXT PRIMARY KEY, principal TEXT NOT NULL, request_id TEXT NOT NULL,
        draft TEXT NOT NULL, expires_at INTEGER NOT NULL, applied INTEGER NOT NULL DEFAULT 0,
        UNIQUE(principal, request_id)
      );
      CREATE TABLE IF NOT EXISTS trigger_commission_owners (
        mandate_id TEXT PRIMARY KEY, principal TEXT NOT NULL, fingerprint TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS commission_owner_removed AFTER DELETE ON mandates
        BEGIN DELETE FROM trigger_commission_owners WHERE mandate_id=OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS commission_owner_replaced AFTER UPDATE OF definition ON mandates
        WHEN NEW.definition<>OLD.definition
        BEGIN DELETE FROM trigger_commission_owners WHERE mandate_id=OLD.id; END;`)
    if (
      !db
        .query<{ name: string }, []>('PRAGMA table_info(trigger_commission_drafts)')
        .all()
        .some((row) => row.name === 'expires_at')
    ) {
      db.exec(
        'ALTER TABLE trigger_commission_drafts ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0',
      )
      db.exec(
        "UPDATE trigger_commission_drafts SET expires_at=json_extract(draft,'$.preview.expiresAt') WHERE json_valid(draft)",
      )
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS trigger_commission_expiry ON trigger_commission_drafts(expires_at) WHERE draft<>''",
    )
  }

  grants() {
    const row = this.db
      .query<{ revision: number; grants: string }, []>(
        'SELECT revision,grants FROM trigger_commission_grants WHERE id=1',
      )
      .get()
    if (!row) throw new Error('Missing commission grant registry')
    return { revision: row.revision, grants: JSON.parse(row.grants) as CommissionGrant[] }
  }

  setGrants(grants: CommissionGrant[], revision: number) {
    return (
      this.db.run(
        'UPDATE trigger_commission_grants SET grants=?,revision=revision+1 WHERE id=1 AND revision=?',
        [JSON.stringify(grants), revision],
      ).changes === 1
    )
  }

  find(principal: string, requestId: string) {
    return this.decode(
      this.db
        .query<{ draft: string; applied: number }, [string, string]>(
          'SELECT draft,applied FROM trigger_commission_drafts WHERE principal=? AND request_id=?',
        )
        .get(principal, requestId),
    )
  }

  redacted(principal: string, requestId: string) {
    return !!this.db
      .query(
        "SELECT 1 FROM trigger_commission_drafts WHERE principal=? AND request_id=? AND draft=''",
      )
      .get(principal, requestId)
  }

  get(principal: string, code: string) {
    return this.decode(
      this.db
        .query<{ draft: string; applied: number }, [string, string]>(
          'SELECT draft,applied FROM trigger_commission_drafts WHERE principal=? AND code=?',
        )
        .get(principal, code),
    )
  }

  private decode(row: { draft: string; applied: number } | null) {
    return row?.draft
      ? { ...(JSON.parse(row.draft) as CommissionDraft), applied: !!row.applied }
      : null
  }

  save(draft: CommissionDraft) {
    this.db.run(
      'INSERT INTO trigger_commission_drafts(code,principal,request_id,draft,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(principal,request_id) DO NOTHING',
      [
        draft.preview.code,
        draft.principal,
        draft.requestId,
        JSON.stringify(draft),
        draft.preview.expiresAt,
      ],
    )
    const saved = this.find(draft.principal, draft.requestId)
    if (!saved || saved.question !== draft.question) throw new Error('Commission request collision')
    return saved
  }

  owned(principal: string, mandate: TriggerMandate) {
    const row = this.db
      .query<{ fingerprint: string }, [string, string]>(
        'SELECT fingerprint FROM trigger_commission_owners WHERE mandate_id=? AND principal=?',
      )
      .get(mandate.id, principal)
    return row?.fingerprint === fingerprint(mandate)
  }

  /** Called from the mandate configuration transaction on this same SQLite connection. */
  applied(draft: CommissionDraft) {
    const changed = this.db.run(
      'UPDATE trigger_commission_drafts SET applied=1 WHERE code=? AND principal=? AND applied=0',
      [draft.preview.code, draft.principal],
    ).changes
    if (changed !== 1) throw new Error('Commission draft was already claimed')
    if (draft.change.kind === 'project') return
    const mandate = draft.change.mandate
    if (draft.principal === 'web') {
      this.db.run('DELETE FROM trigger_commission_owners WHERE mandate_id=?', [mandate.id])
    } else {
      this.db.run(
        'INSERT INTO trigger_commission_owners(mandate_id,principal,fingerprint) VALUES(?,?,?) ON CONFLICT(mandate_id) DO UPDATE SET principal=excluded.principal, fingerprint=excluded.fingerprint',
        [mandate.id, draft.principal, fingerprint(mandate)],
      )
    }
  }
}
