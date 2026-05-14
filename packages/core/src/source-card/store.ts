import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tracer } from '@zero-os/observe'
import {
  type SecretFilter,
  type SourceCard,
  type SourceCardState,
  assertSafeSourceEntityId,
  assertValidSourceCard,
  canTransitionSourceCardState,
  now,
  sanitizeSourceCardTraceEvidence,
} from '@zero-os/shared'

export interface SourceCardAuditContext {
  sessionId?: string
  tracer?: Tracer
  auditData?: Record<string, unknown>
}

export interface SourceCardAuditEvent {
  ts: string
  event: string
  sourceCardId?: string
  data?: Record<string, unknown>
}

export interface SourceCardManagerOptions {
  secretFilter?: SecretFilter
  audit?: (entry: SourceCardAuditEvent) => void
}

export class SourceCardStore {
  private readonly cardsDir: string

  constructor(private readonly baseDir: string) {
    this.cardsDir = join(baseDir, 'cards')
    mkdirSync(this.cardsDir, { recursive: true })
  }

  save(card: SourceCard): SourceCard {
    assertValidSourceCard(card)
    assertSafeSourceEntityId(card.id, 'sourceCard.id')
    mkdirSync(this.cardsDir, { recursive: true })
    writeFileSync(this.cardPath(card.id), `${JSON.stringify(card, null, 2)}\n`)
    return card
  }

  get(id: string): SourceCard | undefined {
    assertSafeSourceEntityId(id, 'sourceCardId')
    const path = this.cardPath(id)
    if (!existsSync(path)) return undefined
    const card = JSON.parse(readFileSync(path, 'utf8')) as SourceCard
    assertValidSourceCard(card)
    if (card.id !== id) {
      throw new Error(`Source card file id mismatch: ${id} != ${card.id}`)
    }
    return card
  }

  list(): SourceCard[] {
    if (!existsSync(this.cardsDir)) return []
    return readdirSync(this.cardsDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -5))
      .filter((id) => {
        try {
          assertSafeSourceEntityId(id, 'sourceCardId')
          return true
        } catch {
          return false
        }
      })
      .map((id) => this.get(id))
      .filter((card): card is SourceCard => Boolean(card))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  delete(id: string): boolean {
    assertSafeSourceEntityId(id, 'sourceCardId')
    const path = this.cardPath(id)
    if (!existsSync(path)) return false
    rmSync(path)
    return true
  }

  private cardPath(id: string): string {
    return join(this.cardsDir, `${id}.json`)
  }
}

export class SourceCardManager {
  private readonly store: SourceCardStore

  constructor(
    baseDir: string,
    private readonly options: SourceCardManagerOptions = {},
  ) {
    this.store = new SourceCardStore(baseDir)
  }

  create(card: SourceCard, context: SourceCardAuditContext = {}): SourceCard {
    const stamped = this.stamp(card, true)
    const saved = this.store.save(stamped)
    this.audit('source_card.created', saved.id, { state: saved.state }, context)
    return saved
  }

  get(id: string): SourceCard | undefined {
    return this.store.get(id)
  }

  list(): SourceCard[] {
    return this.store.list()
  }

  update(
    id: string,
    updater: (card: SourceCard) => SourceCard,
    context: SourceCardAuditContext = {},
  ): SourceCard {
    const current = this.requireCard(id)
    const updated = this.stamp(updater(current), false)
    if (updated.id !== id) {
      throw new Error('Source card update cannot change id')
    }
    const saved = this.store.save(updated)
    this.audit(
      'source_card.updated',
      saved.id,
      { state: saved.state, ...context.auditData },
      context,
    )
    return saved
  }

  transitionState(
    id: string,
    state: SourceCardState,
    reason: string,
    context: SourceCardAuditContext = {},
  ): SourceCard {
    const current = this.requireCard(id)
    if (!canTransitionSourceCardState(current.state, state)) {
      throw new Error(`Invalid SourceCard state transition: ${current.state} -> ${state}`)
    }
    return this.update(id, (card) => ({ ...card, state }), {
      ...context,
      auditData: { ...context.auditData, reason },
    })
  }

  delete(id: string, context: SourceCardAuditContext = {}): boolean {
    const deleted = this.store.delete(id)
    if (deleted) this.audit('source_card.deleted', id, undefined, context)
    return deleted
  }

  private requireCard(id: string): SourceCard {
    const card = this.get(id)
    if (!card) throw new Error(`Source card "${id}" not found`)
    return card
  }

  private stamp(card: SourceCard, create: boolean): SourceCard {
    const ts = now()
    return {
      ...card,
      createdAt: create ? (card.createdAt ?? ts) : card.createdAt,
      updatedAt: ts,
    }
  }

  private audit(
    event: string,
    sourceCardId: string | undefined,
    data: Record<string, unknown> | undefined,
    context: SourceCardAuditContext,
  ): void {
    const sanitized = data
      ? sanitizeSourceCardTraceEvidence(data, this.options.secretFilter)
      : undefined
    const entry: SourceCardAuditEvent = {
      ts: now(),
      event,
      sourceCardId,
      data: sanitized,
    }
    this.options.audit?.(entry)
    if (context.sessionId && context.tracer) {
      context.tracer.logSession(context.sessionId, 'info', event, sanitized)
    }
  }
}
