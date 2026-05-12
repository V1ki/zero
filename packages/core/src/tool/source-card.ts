import type { SourceCard, ToolContext, ToolResult } from '@zero-os/shared'
import type {
  SessionSourceMiner,
  SourceCardDraft,
  SourceCardDraftCandidateRequest,
  SourceCardDraftDedupeDecision,
  SourceCardPromoteRequest,
  SourceCardService,
} from '../source-card'
import { BaseTool } from './base'

type SourceCardToolAction =
  | 'list'
  | 'get'
  | 'validate'
  | 'generate_draft'
  | 'validate_draft'
  | 'create_candidate_from_draft'
  | 'promote'
  | 'retire'

interface SourceCardToolInput {
  action: SourceCardToolAction
  sourceCardId?: string
  sourceSessionId?: string
  useCurrentSession?: boolean
  reason?: string
  reviewedCapabilityIds?: string[]
  privateScopeConfirmation?: SourceCardPromoteRequest['privateScopeConfirmation']
  card?: SourceCard
  draft?: SourceCardDraft
  confirm?: boolean
  dedupeDecision?: SourceCardDraftDedupeDecision
}

export class SourceCardTool extends BaseTool {
  name = 'source_card'
  description =
    'Manage Source Cards and mine Source Card drafts from existing session evidence without executing data source adapters. It never reads new mail, fetches market data, sends messages, or runs source health adapters.'

  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'list',
          'get',
          'validate',
          'generate_draft',
          'validate_draft',
          'create_candidate_from_draft',
          'promote',
          'retire',
        ],
        description:
          'Management action. Draft mining only reads persisted session evidence and cannot execute the underlying data source or access credentials.',
      },
      sourceCardId: {
        type: 'string',
        description: 'Source Card id for get/validate/promote/retire.',
      },
      sourceSessionId: {
        type: 'string',
        description:
          'Historical session id for generate_draft. If omitted with useCurrentSession=true, the current tool context session id is used.',
      },
      useCurrentSession: {
        type: 'boolean',
        description:
          'For generate_draft, resolve the current tool context session id and snapshot it at trigger time.',
      },
      reason: {
        type: 'string',
        description: 'Required reason for promote/retire.',
      },
      reviewedCapabilityIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Required for promote. Capability ids the reviewer has checked, including every watchable capability.',
      },
      privateScopeConfirmation: {
        type: 'object',
        description:
          'Required for private/restricted promote. Must confirm metadata-only access and cannot approve body or attachment access.',
        properties: {
          metadataOnly: { type: 'boolean' },
          bodyAccessApproved: { type: 'boolean', const: false },
          attachmentAccessApproved: { type: 'boolean', const: false },
        },
      },
      card: {
        type: 'object',
        description: 'Optional unsaved Source Card object to validate without persisting it.',
      },
      draft: {
        type: 'object',
        description: 'Unsaved Source Card Draft for validate_draft or create_candidate_from_draft.',
      },
      confirm: {
        type: 'boolean',
        description:
          'Required true for create_candidate_from_draft. Draft generation and validation ignore this.',
      },
      dedupeDecision: {
        type: 'string',
        enum: ['new_card', 'append_adapter_revision', 'append_evidence'],
        description:
          'Required when a draft has dedupeCandidates. This MVP only persists new_card; append modes are reported as not implemented.',
      },
    },
    required: ['action'],
  }

  constructor(
    private readonly sourceCards: SourceCardService,
    private readonly sourceMiner?: SessionSourceMiner,
  ) {
    super()
  }

  protected async execute(_ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const parsed = parseSourceCardToolInput(input)

    switch (parsed.action) {
      case 'list':
        return this.jsonResult(this.sourceCards.list(), 'Listed Source Cards')
      case 'get':
        return this.jsonResult(
          this.sourceCards.get(requireSourceCardId(parsed)),
          'Loaded Source Card',
        )
      case 'validate':
        return this.jsonResult(
          parsed.card
            ? this.sourceCards.validate(parsed.card)
            : this.sourceCards.validateStored(requireSourceCardId(parsed)),
          'Validated Source Card',
        )
      case 'generate_draft':
        return this.jsonResult(
          requireSourceMiner(this.sourceMiner).generateDraft(resolveDraftSessionId(parsed, _ctx), {
            currentSession: !parsed.sourceSessionId && parsed.useCurrentSession === true,
            artifactSearchRoots: [_ctx.workDir],
          }),
          'Generated Source Card Draft',
        )
      case 'validate_draft':
        return this.jsonResult(
          this.sourceCards.validateDraft(requireDraft(parsed)),
          'Validated Source Card Draft',
        )
      case 'create_candidate_from_draft':
        return this.jsonResult(
          this.sourceCards.createCandidateFromDraft(requireCandidateDraftRequest(parsed), {
            sessionId: _ctx.sessionId,
          }),
          'Created candidate Source Card from draft',
        )
      case 'promote':
        return this.jsonResult(
          this.sourceCards.promote(requireSourceCardId(parsed), requirePromoteRequest(parsed)),
          'Promoted Source Card',
        )
      case 'retire':
        return this.jsonResult(
          this.sourceCards.retire(requireSourceCardId(parsed), requireReason(parsed)),
          'Retired Source Card',
        )
      default:
        throw new Error(`Unsupported source_card action: ${(parsed as { action?: string }).action}`)
    }
  }

  private jsonResult(value: unknown, summary: string): ToolResult {
    return {
      success: true,
      output: JSON.stringify(value, null, 2),
      outputSummary: summary,
    }
  }
}

function parseSourceCardToolInput(input: unknown): SourceCardToolInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('source_card input must be an object')
  }
  const record = input as Record<string, unknown>
  if (typeof record.action !== 'string') {
    throw new Error('source_card action is required')
  }
  if (
    ![
      'list',
      'get',
      'validate',
      'generate_draft',
      'validate_draft',
      'create_candidate_from_draft',
      'promote',
      'retire',
    ].includes(record.action)
  ) {
    throw new Error(`Unsupported source_card action: ${record.action}`)
  }
  return {
    action: record.action as SourceCardToolAction,
    sourceCardId: typeof record.sourceCardId === 'string' ? record.sourceCardId : undefined,
    sourceSessionId:
      typeof record.sourceSessionId === 'string' ? record.sourceSessionId : undefined,
    useCurrentSession:
      typeof record.useCurrentSession === 'boolean' ? record.useCurrentSession : undefined,
    reason: typeof record.reason === 'string' ? record.reason : undefined,
    reviewedCapabilityIds: Array.isArray(record.reviewedCapabilityIds)
      ? record.reviewedCapabilityIds.filter((id): id is string => typeof id === 'string')
      : undefined,
    privateScopeConfirmation:
      record.privateScopeConfirmation &&
      typeof record.privateScopeConfirmation === 'object' &&
      !Array.isArray(record.privateScopeConfirmation)
        ? (record.privateScopeConfirmation as SourceCardToolInput['privateScopeConfirmation'])
        : undefined,
    card: record.card as SourceCard | undefined,
    draft: record.draft as SourceCardDraft | undefined,
    confirm: typeof record.confirm === 'boolean' ? record.confirm : undefined,
    dedupeDecision:
      typeof record.dedupeDecision === 'string'
        ? (record.dedupeDecision as SourceCardDraftDedupeDecision)
        : undefined,
  }
}

function requireSourceCardId(input: SourceCardToolInput): string {
  if (!input.sourceCardId) throw new Error('sourceCardId is required')
  return input.sourceCardId
}

function requireReason(input: SourceCardToolInput): string {
  if (!input.reason?.trim()) throw new Error('reason is required')
  return input.reason
}

function requirePromoteRequest(input: SourceCardToolInput): SourceCardPromoteRequest {
  return {
    reason: requireReason(input),
    reviewedCapabilityIds: input.reviewedCapabilityIds ?? [],
    privateScopeConfirmation: input.privateScopeConfirmation,
  }
}

function requireSourceMiner(sourceMiner: SessionSourceMiner | undefined): SessionSourceMiner {
  if (!sourceMiner) throw new Error('Session Source Miner is not configured')
  return sourceMiner
}

function resolveDraftSessionId(input: SourceCardToolInput, ctx: ToolContext): string {
  if (input.sourceSessionId?.trim()) return input.sourceSessionId
  if (input.useCurrentSession === true) return ctx.sessionId
  throw new Error('sourceSessionId is required unless useCurrentSession=true')
}

function requireDraft(input: SourceCardToolInput): SourceCardDraft {
  if (!input.draft) throw new Error('draft is required')
  return input.draft
}

function requireCandidateDraftRequest(input: SourceCardToolInput): SourceCardDraftCandidateRequest {
  return {
    draft: requireDraft(input),
    confirm: input.confirm === true,
    dedupeDecision: input.dedupeDecision,
  }
}
