import {
  type SourceCard,
  type SourceCardCredential,
  type SourceCardHealthResult,
  type SourceCardValidationResult,
  type SourceObservation,
  assertValidSourceCard,
  validateSourceCard,
} from '@zero-os/shared'
import type { SourceCardAuditContext, SourceCardManager } from './store'

export type SourceCardPublicView = Omit<SourceCard, 'credentials'> & {
  credentialBindings: SourceCredentialBindingView[]
}

export interface SourceCredentialBindingView {
  id: string
  required: boolean
  bindingType: SourceCardCredential['binding']['type']
  injectAs: SourceCardCredential['injectAs']
  scopes: string[]
  hasReference: boolean
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

  promote(id: string, reason: string, context: SourceCardAuditContext = {}): SourceCardPublicView {
    const current = this.requireCard(id)
    assertValidSourceCard(current)
    if (current.state !== 'verified' && current.state !== 'degraded') {
      throw new Error(`Source card "${id}" must be verified or degraded before promotion`)
    }
    return toPublicSourceCard(this.manager.transitionState(id, 'active', reason, context))
  }

  retire(id: string, reason: string, context: SourceCardAuditContext = {}): SourceCardPublicView {
    return toPublicSourceCard(this.manager.transitionState(id, 'retired', reason, context))
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

export function toPublicSourceCard(card: SourceCard): SourceCardPublicView {
  const { credentials: _credentials, ...rest } = card
  return {
    ...rest,
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

function toPublicHealth(
  cardHealth: SourceCardPublicView['health'],
): SourceCardPublicView['health'] {
  if (!cardHealth.lastResult) return cardHealth
  const {
    credentialRef: _credentialRef,
    credentialLeaseId: _credentialLeaseId,
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
