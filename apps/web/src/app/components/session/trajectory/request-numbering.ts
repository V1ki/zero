/**
 * Session-global request numbering shared by the trajectory view and ledger.
 *
 * Numbers are positions in the full ordered request list (assistant requests,
 * compaction requests, and represented assistant steps), so every request view
 * keeps its own number even when several land in the same ledger (turn, group)
 * cell. The by-seq index lets request-only rows recover their own number; the
 * (turn, group) boundary map in TrajectoryTable collapses same-group requests
 * to the last number and cannot distinguish them.
 */

import type { TrajectoryRequestNumber, TrajectoryUsage } from './TrajectoryTable'
import type { AssistantMessageNode, ConversationNode, RequestView } from './types'

interface UsageLike {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

function requestUsage(value: unknown): TrajectoryUsage | undefined {
  const usage = value as UsageLike | undefined
  if (usage === undefined) return undefined
  return {
    ...(usage.inputTokens === undefined ? {} : { input: usage.inputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheRead: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWrite: usage.cacheWriteTokens }),
    ...(usage.outputTokens === undefined ? {} : { output: usage.outputTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoning: usage.reasoningTokens }),
  }
}

function addUsage(
  total: TrajectoryUsage | undefined,
  usage: TrajectoryUsage | undefined,
): TrajectoryUsage | undefined {
  if (usage === undefined) return total
  return {
    ...(total?.input === undefined && usage.input === undefined
      ? {}
      : { input: (total?.input ?? 0) + (usage.input ?? 0) }),
    ...(total?.cacheRead === undefined && usage.cacheRead === undefined
      ? {}
      : { cacheRead: (total?.cacheRead ?? 0) + (usage.cacheRead ?? 0) }),
    ...(total?.cacheWrite === undefined && usage.cacheWrite === undefined
      ? {}
      : { cacheWrite: (total?.cacheWrite ?? 0) + (usage.cacheWrite ?? 0) }),
    ...(total?.output === undefined && usage.output === undefined
      ? {}
      : { output: (total?.output ?? 0) + (usage.output ?? 0) }),
    ...(total?.reasoning === undefined && usage.reasoning === undefined
      ? {}
      : { reasoning: (total?.reasoning ?? 0) + (usage.reasoning ?? 0) }),
  }
}

/**
 * Number every request view in session order. Unpaired assistant requests
 * (no assistant node at their turn/step) still receive consecutive numbers,
 * matching their later request-only ledger rows.
 * @param nodes - Conversation event nodes from the trajectory snapshot.
 * @param requests - Assistant and compaction request views from the snapshot.
 * @returns Purpose-discriminated request identities with their numbers.
 */
export function deriveTrajectoryRequestNumbers(
  nodes: readonly ConversationNode[],
  requests: readonly RequestView[],
): readonly TrajectoryRequestNumber[] {
  const assistantsByStep = new Map<string, AssistantMessageNode>()
  for (const node of nodes) {
    if (node.kind !== 'assistant' || node.step <= 0) continue
    assistantsByStep.set(`${node.turn}\u0000${node.step}`, node)
  }
  const requestsByStep = new Map(
    requests
      .filter((request) => request.purpose === 'assistant')
      .map((request) => [`${request.turn}\u0000${request.step}`, request]),
  )
  const orderedRequests = [
    ...requests.map((request) => ({
      seq: request.startSeq,
      request,
      node:
        request.purpose === 'assistant'
          ? assistantsByStep.get(`${request.turn}\u0000${request.step}`)
          : undefined,
    })),
    ...[...assistantsByStep.entries()].flatMap(([key, node]) =>
      requestsByStep.has(key) ? [] : [{ seq: node.seq, request: undefined, node }],
    ),
  ].sort((left, right) => left.seq - right.seq)
  const numbered: TrajectoryRequestNumber[] = []
  let cumulativeUsage: TrajectoryUsage | undefined
  for (const [index, entry] of orderedRequests.entries()) {
    const usage = requestUsage(entry.request?.usage ?? entry.node?.usage)
    cumulativeUsage = addUsage(cumulativeUsage, usage)
    if (entry.request?.purpose !== 'compaction') {
      const request = entry.request
      const node = entry.node
      const turn = request?.turn ?? node?.turn
      const step = request?.step ?? node?.step
      if (turn === undefined || step === undefined) continue
      const provider = request?.provenance?.provider ?? node?.provenance?.provider
      const model = request?.provenance?.model ?? node?.provenance?.model
      const requestConfig = request?.requestConfig ?? node?.requestConfig
      numbered.push({
        seq: entry.seq,
        turn,
        step,
        group: `Step ${step}`,
        number: index + 1,
        ...(request?.status === undefined ? {} : { status: request.status }),
        ...(request?.startedAt === undefined ? {} : { startedAt: request.startedAt }),
        ...(request?.completedAt === undefined ? {} : { completedAt: request.completedAt }),
        ...(request?.error === undefined ? {} : { error: request.error }),
        ...(request?.resultSeq === undefined ? {} : { resultSeq: request.resultSeq }),
        ...(request?.retry === undefined ? {} : { retry: request.retry }),
        ...(request?.maxRetries === undefined ? {} : { maxRetries: request.maxRetries }),
        ...(request?.retryDelayMs === undefined ? {} : { retryDelayMs: request.retryDelayMs }),
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
        ...(requestConfig === undefined ? {} : { requestConfig }),
        ...(usage === undefined ? {} : { usage }),
        ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
      })
      continue
    }
    const request = entry.request
    numbered.push({
      seq: request.startSeq,
      turn: request.turn,
      step: 0,
      group: `Compaction ${request.startSeq}`,
      number: index + 1,
      purpose: 'compaction',
      status: request.status,
      startedAt: request.startedAt,
      completedAt: request.completedAt,
      ...(request.error === undefined ? {} : { error: request.error }),
      resultSeq: request.startSeq,
      ...(request.provenance?.provider === undefined
        ? {}
        : { provider: request.provenance.provider }),
      ...(request.provenance?.model === undefined ? {} : { model: request.provenance.model }),
      ...(request.requestConfig === undefined ? {} : { requestConfig: request.requestConfig }),
      ...(usage === undefined ? {} : { usage }),
      ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
    })
  }

  return numbered
}

/**
 * Index numbered requests by their anchor event sequence so request-only
 * ledger rows (keyed by cell sourceSeq) resolve their own request identity
 * instead of the (turn, group) boundary number shared with sibling rows.
 * @param sessionNumbers - Numbered requests produced by the trajectory view.
 * @returns Anchor-seq to request identity map; seq-less entries are skipped.
 */
export function indexSessionRequestsBySeq(
  sessionNumbers: readonly TrajectoryRequestNumber[] | undefined,
): ReadonlyMap<number, TrajectoryRequestNumber> {
  const bySeq = new Map<number, TrajectoryRequestNumber>()
  for (const request of sessionNumbers ?? []) {
    if (request.seq === undefined) continue
    bySeq.set(request.seq, request)
  }
  return bySeq
}
