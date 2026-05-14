import {
  type SourceCard,
  type SourceCardState,
  type SourceCardValidationResult,
  validateSourceCard,
} from '@zero-os/shared'
import {
  type SourceCardDraft,
  type SourceCardDraftCreateRequest,
  type SourceCardDraftValidationResult,
  findSourceCardDraftDedupeCandidates,
  validateSourceCardDraft,
} from './miner'
import type { SourceCardAuditContext, SourceCardManager } from './store'

export type SourceCardPublicView = SourceCard

export interface SourceCardActivateRequest {
  reason: string
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

  validateDraft(draft: unknown): SourceCardDraftValidationResult {
    return validateSourceCardDraft(draft)
  }

  validateStored(id: string): SourceCardValidationResult {
    const card = this.manager.get(id)
    if (!card) return { ok: false, errors: [`Source card "${id}" not found`] }
    return validateSourceCard(card)
  }

  createFromDraft(
    request: SourceCardDraftCreateRequest,
    context: SourceCardAuditContext = {},
  ): SourceCardPublicView {
    const payload = validateDraftCreateRequest(request)
    const existing = this.manager.get(payload.draft.proposedCard.id)
    if (existing) {
      throw new Error(`Source card "${payload.draft.proposedCard.id}" already exists`)
    }

    const dedupeCandidates = findSourceCardDraftDedupeCandidates(
      payload.draft.proposedCard,
      this.manager.list(),
    )
    if (dedupeCandidates.length > 0) {
      if (!payload.dedupeDecision) {
        throw new Error('dedupeDecision is required when the draft matches existing Source Cards')
      }
      if (payload.dedupeDecision !== 'new_card') {
        throw new Error(
          `${payload.dedupeDecision} is not implemented in the Session Source Miner MVP`,
        )
      }
    }

    return toPublicSourceCard(
      this.manager.create(
        {
          ...payload.draft.proposedCard,
          state: 'draft',
        },
        context,
      ),
    )
  }

  activate(
    id: string,
    request: SourceCardActivateRequest,
    context: SourceCardAuditContext = {},
  ): SourceCardPublicView {
    const reason = typeof request.reason === 'string' ? request.reason.trim() : ''
    if (!reason) throw new Error('Activation reason is required')
    return this.transition(id, 'active', reason, context)
  }

  retire(id: string, reason: string, context: SourceCardAuditContext = {}): SourceCardPublicView {
    const trimmedReason = reason.trim()
    if (!trimmedReason) throw new Error('Retire reason is required')
    return this.transition(id, 'retired', trimmedReason, context)
  }

  private transition(
    id: string,
    state: SourceCardState,
    reason: string,
    context: SourceCardAuditContext,
  ): SourceCardPublicView {
    return toPublicSourceCard(this.manager.transitionState(id, state, reason, context))
  }
}

export function toPublicSourceCard(card: SourceCard): SourceCardPublicView {
  return {
    ...card,
    sourceDoc: {
      format: 'markdown',
      body: sanitizeSourceDocBody(card.sourceDoc.body),
    },
  }
}

function validateDraftCreateRequest(
  request: SourceCardDraftCreateRequest,
): SourceCardDraftCreateRequest & { draft: SourceCardDraft } {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Source Card draft create request is required')
  }
  if (request.confirm !== true) {
    throw new Error('Explicit confirm=true is required to create a Source Card from draft')
  }

  const validation = validateSourceCardDraft(request.draft)
  if (!validation.ok) {
    throw new Error(`Invalid SourceCardDraft: ${validation.errors.join('; ')}`)
  }

  return request as SourceCardDraftCreateRequest & { draft: SourceCardDraft }
}

function sanitizeSourceDocBody(body: string): string {
  return body
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:vault:\/\/|external:)[^\s`"')]+/gi, '[REDACTED_REFERENCE]')
    .replace(
      /\b(?:authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s`"')]+/gi,
      '[REDACTED_SECRET]',
    )
}
