import {
  type SourceCard,
  type SourceCardAdapter,
  type SourceCardAdapterRevision,
  type SourceCardCredential,
  type SourceCardHealth,
  type SourceCardHealthEvidence,
  type SourceCardHealthResult,
  type SourceCardValidationResult,
  type SourceObservation,
  assertValidSourceCard,
  canTransitionSourceCardState,
  now,
  validateSourceCard,
} from '@zero-os/shared'
import type { SourceCardAuditContext, SourceCardManager } from './store'

export type SourceCardPublicView = Omit<SourceCard, 'credentials' | 'adapter' | 'health'> & {
  adapter: SourceCardPublicAdapter
  health: SourceCardPublicHealth
  credentialBindings: SourceCredentialBindingView[]
}

export interface SourceCardPublicAdapter {
  mode: SourceCardAdapter['mode']
  activeRevision: string
  revisions: SourceCardPublicAdapterRevision[]
}

export interface SourceCardPublicAdapterRevision {
  id: SourceCardAdapterRevision['id']
  status: SourceCardAdapterRevision['status']
  mode: SourceCardAdapterRevision['mode']
  entrypointSummary: string
  parser: SourceCardAdapterRevision['parser']
  timeoutMs: number
  rateLimit?: SourceCardAdapterRevision['rateLimit']
  templateCounts: {
    commands: number
    endpoints: number
    samples: number
  }
}

export type SourceCardPublicHealthEvidence = Omit<
  SourceCardHealthEvidence,
  'credentialRef' | 'credentialLeaseId' | 'message' | 'details'
>

export type SourceCardPublicHealthResult = Omit<SourceCardHealthResult, 'evidence'> & {
  evidence: SourceCardPublicHealthEvidence
}

export type SourceCardPublicHealth = Omit<SourceCardHealth, 'lastResult'> & {
  lastResult?: SourceCardPublicHealthResult
}

export interface SourceCredentialBindingView {
  id: string
  required: boolean
  bindingType: SourceCardCredential['binding']['type']
  injectAs: SourceCardCredential['injectAs']
  scopes: string[]
  hasReference: boolean
}

export interface SourceCardPrivateScopeConfirmation {
  metadataOnly: boolean
  bodyAccessApproved: boolean
  attachmentAccessApproved: boolean
}

export interface SourceCardPromoteRequest {
  reason: string
  reviewedCapabilityIds: string[]
  privateScopeConfirmation?: SourceCardPrivateScopeConfirmation
}

interface ValidatedPromoteRequest {
  reason: string
  reviewedCapabilityIds: string[]
  privateScopeConfirmation?: SourceCard['promotion']['privateScopeConfirmation']
}

export class SourceCardService {
  constructor(private readonly manager: SourceCardManager) {}

  list(): SourceCardPublicView[] {
    return this.manager.list().map((card) => toPublicSourceCard(card))
  }

  get(id: string): SourceCardPublicView | undefined {
    const card = this.manager.get(id)
    return card ? toPublicSourceCard(card) : undefined
  }

  validate(card: unknown): SourceCardValidationResult {
    return validateSourceCard(card)
  }

  validateStored(id: string): SourceCardValidationResult {
    const card = this.manager.get(id)
    if (!card) return { ok: false, errors: [`Source card "${id}" not found`] }
    return validateSourceCard(card)
  }

  promote(
    id: string,
    request: SourceCardPromoteRequest,
    context: SourceCardAuditContext = {},
  ): SourceCardPublicView {
    const current = this.requireCard(id)
    assertValidSourceCard(current)
    if (current.state !== 'verified' && current.state !== 'degraded') {
      throw new Error(`Source card "${id}" must be verified or degraded before promotion`)
    }
    if (!canTransitionSourceCardState(current.state, 'active')) {
      throw new Error(`Invalid SourceCard state transition: ${current.state} -> active`)
    }
    const payload = validatePromoteRequest(current, request)

    return toPublicSourceCard(
      this.manager.update(
        id,
        (card) => ({
          ...card,
          state: 'active',
          promotion: {
            ...card.promotion,
            reviewedCapabilityIds: payload.reviewedCapabilityIds,
            privateScopeConfirmation: payload.privateScopeConfirmation,
            lastDecisionAt: now(),
            lastDecision: 'accepted',
            decisionReason: payload.reason,
          },
        }),
        context,
      ),
    )
  }

  retire(id: string, reason: string, context: SourceCardAuditContext = {}): SourceCardPublicView {
    const trimmedReason = reason.trim()
    if (!trimmedReason) throw new Error('Retire reason is required')
    return toPublicSourceCard(this.manager.transitionState(id, 'retired', trimmedReason, context))
  }

  recordHealthResult(
    sourceCardId: string,
    result: SourceCardHealthResult,
    context: SourceCardAuditContext = {},
  ): SourceCardPublicView {
    return toPublicSourceCard(this.manager.recordHealthResult(sourceCardId, result, context))
  }

  listObservations(sourceCardId: string): SourceObservation[] {
    return this.manager.listObservations(sourceCardId)
  }

  private requireCard(id: string): SourceCard {
    const card = this.manager.get(id)
    if (!card) throw new Error(`Source card "${id}" not found`)
    return card
  }
}

function validatePromoteRequest(
  card: SourceCard,
  request: SourceCardPromoteRequest,
): ValidatedPromoteRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Promotion approval payload is required')
  }

  const reason = typeof request.reason === 'string' ? request.reason.trim() : ''
  if (!reason) throw new Error('Promotion reason is required')

  if (!Array.isArray(request.reviewedCapabilityIds)) {
    throw new Error('reviewedCapabilityIds must be an array')
  }
  const knownCapabilityIds = new Set(card.capabilities.map((capability) => capability.id))
  const reviewedCapabilityIds = Array.from(
    new Set(
      request.reviewedCapabilityIds
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  )
  if (reviewedCapabilityIds.length === 0) {
    throw new Error('At least one capability must be reviewed before promotion')
  }
  const unknownCapability = reviewedCapabilityIds.find((id) => !knownCapabilityIds.has(id))
  if (unknownCapability) {
    throw new Error(`Reviewed capability "${unknownCapability}" is not declared by Source Card`)
  }
  const unreviewedWatchable = card.capabilities.find(
    (capability) => capability.watchable && !reviewedCapabilityIds.includes(capability.id),
  )
  if (unreviewedWatchable) {
    throw new Error(`Watchable capability "${unreviewedWatchable.id}" must be reviewed`)
  }

  const privateScopeConfirmation = validatePrivateScopeConfirmation(card, request)
  return {
    reason,
    reviewedCapabilityIds,
    privateScopeConfirmation,
  }
}

function validatePrivateScopeConfirmation(
  card: SourceCard,
  request: SourceCardPromoteRequest,
): SourceCard['promotion']['privateScopeConfirmation'] {
  if (card.sensitivity !== 'private' && card.sensitivity !== 'restricted') return undefined

  const confirmation = request.privateScopeConfirmation
  if (!confirmation) {
    throw new Error('privateScopeConfirmation is required for private or restricted Source Cards')
  }
  if (confirmation.metadataOnly !== true) {
    throw new Error('Private Source Card promotion requires metadataOnly confirmation')
  }
  if (confirmation.bodyAccessApproved !== false) {
    throw new Error('Private Source Card promotion cannot approve body access')
  }
  if (confirmation.attachmentAccessApproved !== false) {
    throw new Error('Private Source Card promotion cannot approve attachment access')
  }
  return {
    metadataOnly: true,
    bodyAccessApproved: false,
    attachmentAccessApproved: false,
  }
}

export function toPublicSourceCard(card: SourceCard): SourceCardPublicView {
  const { credentials: _credentials, ...rest } = card
  return {
    ...rest,
    adapter: toPublicAdapter(rest.adapter),
    health: toPublicHealth(rest.health),
    credentialBindings: card.credentials.map((credential) => ({
      id: credential.id,
      required: credential.required,
      bindingType: credential.binding.type,
      injectAs: credential.injectAs,
      scopes: [...credential.scopes],
      hasReference: 'ref' in credential.binding,
    })),
  }
}

function toPublicAdapter(adapter: SourceCardAdapter): SourceCardPublicAdapter {
  return {
    mode: adapter.mode,
    activeRevision: adapter.activeRevision,
    revisions: adapter.revisions.map((revision) => ({
      id: revision.id,
      status: revision.status,
      mode: revision.mode,
      entrypointSummary: summarizeEntrypoint(revision.entrypoint),
      parser: {
        type: revision.parser.type,
        schemaKeys: [...revision.parser.schemaKeys],
      },
      timeoutMs: revision.timeoutMs,
      rateLimit: revision.rateLimit ? { ...revision.rateLimit } : undefined,
      templateCounts: {
        commands: revision.commandTemplate ? 1 : 0,
        endpoints: revision.endpointTemplates?.length ?? 0,
        samples: revision.validation.sampleQueries.length,
      },
    })),
  }
}

function summarizeEntrypoint(entrypoint: string): string {
  try {
    const url = new URL(entrypoint)
    return url.origin
  } catch {
    const normalized = entrypoint.replaceAll('\\', '/')
    const parts = normalized.split('/').filter(Boolean)
    return parts[parts.length - 1] ?? entrypoint
  }
}

function toPublicHealth(cardHealth: SourceCardHealth): SourceCardPublicHealth {
  if (!cardHealth.lastResult) return cardHealth
  const {
    credentialRef: _credentialRef,
    credentialLeaseId: _credentialLeaseId,
    message: _message,
    details: _details,
    ...evidence
  } = cardHealth.lastResult.evidence
  return {
    ...cardHealth,
    lastResult: {
      ...cardHealth.lastResult,
      evidence,
    },
  }
}
