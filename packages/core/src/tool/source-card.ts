import type { SourceCard, ToolContext, ToolResult } from '@zero-os/shared'
import type { SourceCardService } from '../source-card'
import { BaseTool } from './base'

type SourceCardToolAction = 'list' | 'get' | 'validate' | 'promote' | 'retire'

interface SourceCardToolInput {
  action: SourceCardToolAction
  sourceCardId?: string
  reason?: string
  card?: SourceCard
}

export class SourceCardTool extends BaseTool {
  name = 'source_card'
  description =
    'Manage Source Cards without executing data source adapters. Supports list/get/validate/promote/retire only; it never reads mail, fetches market data, sends messages, or runs source health adapters.'

  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'validate', 'promote', 'retire'],
        description:
          'Management action. This tool cannot execute the underlying data source or access credentials.',
      },
      sourceCardId: {
        type: 'string',
        description: 'Source Card id for get/validate/promote/retire.',
      },
      reason: {
        type: 'string',
        description: 'Required reason for promote/retire.',
      },
      card: {
        type: 'object',
        description: 'Optional unsaved Source Card object to validate without persisting it.',
      },
    },
    required: ['action'],
  }

  constructor(private readonly sourceCards: SourceCardService) {
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
      case 'promote':
        return this.jsonResult(
          this.sourceCards.promote(requireSourceCardId(parsed), requireReason(parsed)),
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
  if (!['list', 'get', 'validate', 'promote', 'retire'].includes(record.action)) {
    throw new Error(`Unsupported source_card action: ${record.action}`)
  }
  return {
    action: record.action as SourceCardToolAction,
    sourceCardId: typeof record.sourceCardId === 'string' ? record.sourceCardId : undefined,
    reason: typeof record.reason === 'string' ? record.reason : undefined,
    card: record.card as SourceCard | undefined,
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
