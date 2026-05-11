import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Tracer } from '@zero-os/observe'
import {
  type SecretFilter,
  type SourceCard,
  type SourceCardCapability,
  type SourceCardCredential,
  type SourceCardHealthResult,
  type SourceCardState,
  type SourceCredentialLease,
  type SourceObservation,
  type SourceWatchBinding,
  assertValidSourceCard,
  assertValidSourceWatchBinding,
  canTransitionSourceCardState,
  generatePrefixedId,
  now,
  sanitizeSourceCardTraceEvidence,
} from '@zero-os/shared'

export interface SourceCardAuditContext {
  sessionId?: string
  tracer?: Tracer
}

export interface SourceCardAuditEvent {
  ts: string
  event: string
  sourceCardId?: string
  data?: Record<string, unknown>
}

export interface SourceCardManagerOptions {
  secretFilter?: SecretFilter
  secretResolver?: (ref: string) => string | undefined
  audit?: (entry: SourceCardAuditEvent) => void
}

export interface ResolvedSourceWatch {
  sourceCardId: string
  title: string
  adapter: {
    mode: SourceCard['adapter']['mode']
    activeRevision: string
  }
  capability: SourceCardCapability
  binding: SourceWatchBinding
}

export class SourceCardStore {
  private readonly cardsDir: string
  private readonly observationsDir: string

  constructor(private readonly baseDir: string) {
    this.cardsDir = join(baseDir, 'cards')
    this.observationsDir = join(baseDir, 'observations')
    mkdirSync(this.cardsDir, { recursive: true })
    mkdirSync(this.observationsDir, { recursive: true })
  }

  save(card: SourceCard): SourceCard {
    assertValidSourceCard(card)
    mkdirSync(this.cardsDir, { recursive: true })
    writeFileSync(this.cardPath(card.id), `${JSON.stringify(card, null, 2)}\n`)
    return card
  }

  get(id: string): SourceCard | undefined {
    const path = this.cardPath(id)
    if (!existsSync(path)) return undefined
    const card = JSON.parse(readFileSync(path, 'utf8')) as SourceCard
    assertValidSourceCard(card)
    return card
  }

  list(): SourceCard[] {
    if (!existsSync(this.cardsDir)) return []
    return readdirSync(this.cardsDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => this.get(file.slice(0, -5)))
      .filter((card): card is SourceCard => Boolean(card))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  delete(id: string): boolean {
    const path = this.cardPath(id)
    if (!existsSync(path)) return false
    rmSync(path)
    return true
  }

  appendObservation(observation: SourceObservation): SourceObservation {
    this.validateObservationShape(observation)
    mkdirSync(this.observationDir(observation.sourceCardId), { recursive: true })
    const path = join(this.observationDir(observation.sourceCardId), `${observation.id}.json`)
    writeFileSync(path, `${JSON.stringify(observation, null, 2)}\n`)
    return observation
  }

  listObservations(sourceCardId: string): SourceObservation[] {
    const dir = this.observationDir(sourceCardId)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as SourceObservation)
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
  }

  private cardPath(id: string): string {
    return join(this.cardsDir, `${id}.json`)
  }

  private observationDir(sourceCardId: string): string {
    return join(this.observationsDir, sourceCardId)
  }

  private validateObservationShape(observation: SourceObservation): void {
    if (!observation.id || !observation.sourceCardId || !observation.capabilityId) {
      throw new Error('Source observation requires id, sourceCardId, and capabilityId')
    }
    if (!observation.observedAt) {
      throw new Error('Source observation requires observedAt')
    }
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

  ensure(card: SourceCard, context: SourceCardAuditContext = {}): SourceCard {
    const existing = this.get(card.id)
    if (existing) return existing
    return this.create(card, context)
  }

  ensureAll(cards: SourceCard[], context: SourceCardAuditContext = {}): SourceCard[] {
    return cards.map((card) => this.ensure(card, context))
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
    this.audit('source_card.updated', saved.id, { state: saved.state }, context)
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
    return this.update(
      id,
      (card) => ({
        ...card,
        state,
        promotion: {
          ...card.promotion,
          lastDecisionAt: now(),
          lastDecision: state === 'retired' ? 'rejected' : 'accepted',
          decisionReason: reason,
        },
      }),
      context,
    )
  }

  recordHealthResult(
    sourceCardId: string,
    result: SourceCardHealthResult,
    context: SourceCardAuditContext = {},
  ): SourceCard {
    const card = this.requireCard(sourceCardId)
    const sanitizedResult: SourceCardHealthResult = {
      ...result,
      evidence: sanitizeSourceCardTraceEvidence(result.evidence, this.options.secretFilter),
    }
    const observedAt = sanitizedResult.checkedAt || now()
    const observation = this.buildObservation(
      card,
      sanitizedResult.checkId,
      'health_check',
      { ...sanitizedResult },
      sanitizedResult.evidence,
      observedAt,
    )
    this.store.appendObservation(observation)

    const nextState = this.nextStateAfterHealth(card.state, sanitizedResult)
    const updated = this.store.save(
      this.stamp(
        {
          ...card,
          state: nextState,
          health: {
            ...card.health,
            lastCheckedAt: observedAt,
            lastStatus: this.healthStatus(sanitizedResult),
            failureClass: sanitizedResult.failureClass,
            lastResult: sanitizedResult,
          },
        },
        false,
      ),
    )
    this.audit(
      'source_card.health_checked',
      sourceCardId,
      {
        status: sanitizedResult.status,
        failureClass: sanitizedResult.failureClass,
        evidence: sanitizedResult.evidence,
      },
      context,
    )
    return updated
  }

  recordObservation(
    observation: Omit<SourceObservation, 'id' | 'observedAt'> & {
      id?: string
      observedAt?: string
    },
    context: SourceCardAuditContext = {},
  ): SourceObservation {
    const card = this.requireCard(observation.sourceCardId)
    this.requireCapability(card, observation.capabilityId)
    const sanitizedObservation: SourceObservation = {
      ...observation,
      id: observation.id ?? generatePrefixedId('obs'),
      observedAt: observation.observedAt ?? now(),
      data:
        typeof observation.data === 'object' && observation.data
          ? sanitizeSourceCardTraceEvidence(observation.data, this.options.secretFilter)
          : observation.data,
      evidence: observation.evidence
        ? sanitizeSourceCardTraceEvidence(observation.evidence, this.options.secretFilter)
        : undefined,
    }
    const saved = this.store.appendObservation(sanitizedObservation)
    this.audit(
      'source_card.observation_recorded',
      saved.sourceCardId,
      { capabilityId: saved.capabilityId, kind: saved.kind, evidence: saved.evidence },
      context,
    )
    return saved
  }

  listObservations(sourceCardId: string): SourceObservation[] {
    this.requireCard(sourceCardId)
    return this.store.listObservations(sourceCardId)
  }

  validateWatchBinding(binding: SourceWatchBinding): void {
    const card = this.requireCard(binding.sourceCardId)
    assertValidSourceWatchBinding(binding, card)
  }

  resolveWatch(binding: SourceWatchBinding): ResolvedSourceWatch {
    this.validateWatchBinding(binding)
    const sourceCard = this.requireCard(binding.sourceCardId)
    const capability = this.requireCapability(sourceCard, binding.capabilityId)
    return {
      sourceCardId: sourceCard.id,
      title: sourceCard.title,
      adapter: {
        mode: sourceCard.adapter.mode,
        activeRevision: sourceCard.adapter.activeRevision,
      },
      capability,
      binding,
    }
  }

  createCredentialLease(
    sourceCardId: string,
    credentialId?: string,
    context: SourceCardAuditContext = {},
  ): SourceCredentialLease {
    const card = this.requireCard(sourceCardId)
    const credential = credentialId
      ? this.requireCredential(card, credentialId)
      : card.credentials[0]
    if (!credential) {
      throw new Error(`Source card "${sourceCardId}" has no credential binding`)
    }
    if (credential.binding.type === 'vaultRef') {
      const ref = credential.binding.ref
      if (!this.options.secretResolver?.(ref)) {
        throw new Error(`Source card credential "${credential.id}" is unavailable`)
      }
    }

    const lease: SourceCredentialLease = {
      id: generatePrefixedId('lease'),
      sourceCardId,
      credentialId: credential.id,
      credentialRef: 'ref' in credential.binding ? credential.binding.ref : 'none',
      issuedAt: now(),
      expiresAt:
        credential.leasePolicy.ttlSeconds > 0
          ? new Date(Date.now() + credential.leasePolicy.ttlSeconds * 1000).toISOString()
          : undefined,
      injectAs: credential.injectAs,
      scopes: credential.scopes,
      renewable: credential.leasePolicy.renewable,
    }
    this.audit(
      'source_card.credential_lease_issued',
      sourceCardId,
      {
        credentialId: credential.id,
        credentialRef: lease.credentialRef,
        injectAs: lease.injectAs,
        expiresAt: lease.expiresAt,
      },
      context,
    )
    return lease
  }

  private requireCard(id: string): SourceCard {
    const card = this.get(id)
    if (!card) throw new Error(`Source card "${id}" not found`)
    return card
  }

  private requireCapability(card: SourceCard, capabilityId: string): SourceCardCapability {
    const capability = card.capabilities.find((candidate) => candidate.id === capabilityId)
    if (!capability) {
      throw new Error(`Source card "${card.id}" does not expose capability "${capabilityId}"`)
    }
    return capability
  }

  private requireCredential(card: SourceCard, credentialId: string): SourceCardCredential {
    const credential = card.credentials.find((candidate) => candidate.id === credentialId)
    if (!credential) {
      throw new Error(`Source card "${card.id}" does not define credential "${credentialId}"`)
    }
    return credential
  }

  private buildObservation(
    card: SourceCard,
    capabilityId: string,
    kind: SourceObservation['kind'],
    data: SourceObservation['data'],
    evidence: SourceObservation['evidence'],
    observedAt: string,
  ): SourceObservation {
    return {
      id: generatePrefixedId('obs'),
      sourceCardId: card.id,
      capabilityId,
      kind,
      observedAt,
      data,
      evidence,
    }
  }

  private nextStateAfterHealth(
    current: SourceCardState,
    result: SourceCardHealthResult,
  ): SourceCardState {
    if (result.status === 'passed') {
      return current === 'degraded' || current === 'broken' ? 'verified' : current
    }
    if (result.failureClass === 'auth' || result.failureClass === 'privacy_blocked') {
      return 'broken'
    }
    if (current === 'active' || current === 'verified') return 'degraded'
    return current
  }

  private healthStatus(result: SourceCardHealthResult): SourceCard['health']['lastStatus'] {
    if (result.status === 'passed') return 'healthy'
    if (result.failureClass === 'auth' || result.failureClass === 'privacy_blocked') return 'broken'
    return 'degraded'
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
