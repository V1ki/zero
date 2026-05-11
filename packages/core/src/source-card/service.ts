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
