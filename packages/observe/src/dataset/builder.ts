import type { Message } from '@zero-os/shared'
import { MetricsDB } from '../metrics'
import { ObservabilityStore } from '../observability-store'
import { SessionDB, type SessionRow } from '../session-db'
import {
  countAssistantTurns,
  countUserTurns,
  deriveTraits,
  type TraitDerivationInput,
} from './traits'
import {
  EPISODE_SCHEMA_VERSION,
  type DatasetFilter,
  type Episode,
  type EpisodeRecordedContext,
  type EpisodeTrace,
  type EpisodeTraceCounts,
} from './types'

function applyOffsetAndLimit<T>(values: T[], offset = 0, limit?: number): T[] {
  const sliced = values.slice(Math.max(offset, 0))
  return limit === undefined ? sliced : sliced.slice(0, Math.max(limit, 0))
}

export class DatasetBuilder {
  constructor(
    private readonly sessionDB: SessionDB,
    private readonly metricsDB: MetricsDB,
    private readonly observability: ObservabilityStore,
  ) {}

  extractEpisode(sessionId: string): Episode | null {
    const session = this.sessionDB.getSession(sessionId)
    if (!session) return null

    return this.buildEpisodeFromSession(session)
  }

  extractEpisodes(filter?: DatasetFilter): Episode[] {
    const episodes = this.loadCandidateSessions(filter)
      .filter((session) => this.matchesSessionFilters(session, filter))
      .map((session) => this.buildEpisodeFromSession(session))
      .filter((episode) => this.matchesEpisodeFilters(episode, filter))

    return applyOffsetAndLimit(episodes, filter?.offset, filter?.limit)
  }

  listMatchingSessionIds(filter?: DatasetFilter): string[] {
    const candidateRows = this.loadCandidateSessions(filter)
    const matchedIds: string[] = []

    for (const row of candidateRows) {
      if (!this.matchesSessionFilters(row, filter)) continue
      if (!this.matchesDerivedFilters(row.id, filter)) continue
      matchedIds.push(row.id)
    }

    return applyOffsetAndLimit(matchedIds, filter?.offset, filter?.limit)
  }

  getUpdatedSessionIds(sinceTimestamp: string): string[] {
    return this.sessionDB.loadSessionsByDateRange(sinceTimestamp).map((session) => session.id)
  }

  private buildEpisodeFromSession(session: SessionRow): Episode {
    const sessionId = session.id

    const messages = this.sessionDB.loadSessionMessages(sessionId)
    const requests = this.observability.readSessionRequests(sessionId)
    const closures = this.observability.readSessionClosures(sessionId)
    const decisions = this.observability.readSessionDecisions(sessionId)
    const snapshots = this.observability.readSessionSnapshots(sessionId)
    const evaluations = this.metricsDB.evaluationsBySession(sessionId)

    const userTurnCount = countUserTurns(messages)
    const assistantTurnCount = countAssistantTurns(messages)
    const trace = this.buildTrace(requests, closures, decisions, snapshots)

    return {
      schemaVersion: EPISODE_SCHEMA_VERSION,
      id: session.id,
      sessionId: session.id,
      extractedAt: new Date().toISOString(),
      metadata: {
        source: session.source,
        status: session.status,
        currentModel: session.currentModel,
        modelHistory: session.modelHistory,
        summary: session.summary,
        tags: session.tags,
        channelName: session.channelName,
        channelId: session.channelId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
      conversation: {
        messages,
        messageCount: messages.length,
        userTurnCount,
        assistantTurnCount,
      },
      recordedContext: this.buildRecordedContext(session, snapshots),
      trace,
      usage: {
        ...this.metricsDB.sessionStats(sessionId),
        byPurpose: this.metricsDB.sessionUsageByPurpose(sessionId),
      },
      evaluations,
      traits: deriveTraits(this.toTraitInput(messages, userTurnCount, requests, closures, decisions, snapshots)),
    }
  }

  private loadCandidateSessions(filter?: DatasetFilter): SessionRow[] {
    return this.sessionDB.loadSessionsByDateRange(filter?.since, filter?.until)
  }

  private matchesSessionFilters(session: SessionRow, filter?: DatasetFilter): boolean {
    if (filter?.statuses?.length && !filter.statuses.includes(session.status)) {
      return false
    }

    if (filter?.sources?.length && !filter.sources.includes(session.source)) {
      return false
    }

    if (filter?.tags?.length && !filter.tags.every((tag) => session.tags.includes(tag))) {
      return false
    }

    return true
  }

  private matchesDerivedFilters(sessionId: string, filter?: DatasetFilter): boolean {
    const evaluations = filter?.hasEvaluation !== undefined ? this.metricsDB.evaluationsBySession(sessionId) : null

    if (filter?.hasEvaluation !== undefined) {
      const hasEvaluation = evaluations !== null && evaluations.length > 0
      if (hasEvaluation !== filter.hasEvaluation) {
        return false
      }
    }

    if (!filter?.traits?.length) {
      return true
    }

    const messages = this.sessionDB.loadSessionMessages(sessionId)
    const requests = this.observability.readSessionRequests(sessionId)
    const closures = this.observability.readSessionClosures(sessionId)
    const decisions = this.observability.readSessionDecisions(sessionId)
    const snapshots = this.observability.readSessionSnapshots(sessionId)
    const userTurnCount = countUserTurns(messages)
    const traits = deriveTraits(
      this.toTraitInput(messages, userTurnCount, requests, closures, decisions, snapshots),
    )

    return filter.traits.every((trait) => traits.includes(trait))
  }

  private matchesEpisodeFilters(episode: Episode, filter?: DatasetFilter): boolean {
    if (filter?.hasEvaluation !== undefined) {
      const hasEvaluation = episode.evaluations.length > 0
      if (hasEvaluation !== filter.hasEvaluation) {
        return false
      }
    }

    if (filter?.traits?.length) {
      return filter.traits.every((trait) => episode.traits.includes(trait))
    }

    return true
  }

  private buildRecordedContext(
    session: SessionRow,
    snapshots: EpisodeTrace['snapshots'],
  ): EpisodeRecordedContext {
    const latestSnapshot = snapshots.at(-1)

    return {
      systemPrompt: session.systemPrompt,
      agentConfigJson: session.agentConfigJson,
      tools: latestSnapshot?.tools ?? [],
      toolsSource: latestSnapshot?.tools ? 'snapshot' : 'none',
      identityMemory: latestSnapshot?.identityMemory,
      snapshotId: latestSnapshot?.id,
    }
  }

  private buildTrace(
    requests: EpisodeTrace['requests'],
    closures: EpisodeTrace['closures'],
    decisions: EpisodeTrace['decisions'],
    snapshots: EpisodeTrace['snapshots'],
  ): EpisodeTrace {
    return {
      requests,
      closures,
      decisions,
      snapshots,
      counts: this.buildTraceCounts(requests, closures, decisions, snapshots),
    }
  }

  private buildTraceCounts(
    requests: EpisodeTrace['requests'],
    closures: EpisodeTrace['closures'],
    decisions: EpisodeTrace['decisions'],
    snapshots: EpisodeTrace['snapshots'],
  ): EpisodeTraceCounts {
    return {
      requestCount: requests.length,
      closureCount: closures.length,
      decisionCount: decisions.length,
      snapshotCount: snapshots.length,
      toolCallCount: requests.reduce((total, request) => total + request.toolCalls.length, 0),
      memoryDecisionCount: decisions.filter(
        (decision) => decision.decisionType === 'memory_retrieval',
      ).length,
      compressionCount: snapshots.filter((snapshot) => snapshot.trigger === 'context_compression')
        .length,
      toolErrorCount: requests.reduce(
        (total, request) => total + request.toolResults.filter((result) => result.isError).length,
        0,
      ),
    }
  }

  private toTraitInput(
    messages: Message[],
    userTurnCount: number,
    requests: EpisodeTrace['requests'],
    closures: EpisodeTrace['closures'],
    decisions: EpisodeTrace['decisions'],
    snapshots: EpisodeTrace['snapshots'],
  ): TraitDerivationInput {
    return {
      messages,
      userTurnCount,
      requests,
      closures,
      decisions,
      snapshots,
    }
  }
}
