import { type SourceCardHealthResult, now } from '@zero-os/shared'
import type { SourceCardService } from './service'
import type { SourceCardAuditContext } from './store'

export interface SourceCardHealthRunInput {
  sourceCardId: string
  results: SourceCardHealthResult[]
}

export interface SourceCardHealthRunSummary {
  sourceCardId: string
  recorded: number
  results: SourceCardHealthResult[]
}

export class SourceCardHealthRunner {
  constructor(private readonly service: SourceCardService) {}

  run(
    input: SourceCardHealthRunInput,
    context: SourceCardAuditContext = {},
  ): SourceCardHealthRunSummary {
    const card = this.service.get(input.sourceCardId)
    if (!card) throw new Error(`Source card "${input.sourceCardId}" not found`)
    const knownChecks = new Set(card.health.checks.map((check) => check.id))
    const results = input.results.map((result) => {
      if (!knownChecks.has(result.checkId)) {
        throw new Error(
          `Health check "${result.checkId}" is not declared by Source Card "${card.id}"`,
        )
      }
      return {
        ...result,
        checkedAt: result.checkedAt || now(),
        evidence: {
          sourceCardId: card.id,
          capabilityId: result.checkId,
          adapterRevision: card.adapter.activeRevision,
          ...result.evidence,
        },
      }
    })

    for (const result of results) {
      this.service.recordHealthResult(card.id, result, context)
    }

    return {
      sourceCardId: card.id,
      recorded: results.length,
      results,
    }
  }
}
