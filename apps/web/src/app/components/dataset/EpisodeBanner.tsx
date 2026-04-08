import { TraitPill } from './TraitPill'

export interface DatasetEpisode {
  sessionId: string
  metadata: {
    source: string
    status: string
    currentModel: string
  }
  recordedContext: {
    systemPrompt?: string
    tools: string[]
    toolsSource: 'snapshot' | 'none'
    identityMemory?: string
  }
  evaluations: Array<{
    overallScore: number
    verdict: string
    confidence: string
    createdAt: string
  }>
  traits: string[]
}

export function EpisodeBanner({ episode }: { episode: DatasetEpisode }) {
  const latestEvaluation = episode.evaluations[0]

  return (
    <div className="card p-5 animate-fade-up">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-text-disabled)] mb-2">
            Traits
          </div>
          <div className="flex flex-wrap gap-2">
            {episode.traits.length > 0 ? (
              episode.traits.map((trait) => <TraitPill key={trait} trait={trait} />)
            ) : (
              <span className="text-[12px] text-[var(--color-text-muted)]">No traits</span>
            )}
          </div>
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-text-disabled)] mb-2">
            Evaluation
          </div>
          {latestEvaluation ? (
            <div className="space-y-1 text-[12px] text-[var(--color-text-secondary)]">
              <div>Score: {latestEvaluation.overallScore}/100</div>
              <div>Verdict: {latestEvaluation.verdict.toUpperCase()}</div>
              <div>Confidence: {latestEvaluation.confidence}</div>
            </div>
          ) : (
            <div className="text-[12px] text-[var(--color-text-muted)]">No evaluation</div>
          )}
        </div>

        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--color-text-disabled)] mb-2">
            Recorded Context
          </div>
          <div className="space-y-1 text-[12px] text-[var(--color-text-secondary)]">
            <div>
              Tools: {episode.recordedContext.tools.length} recorded ({episode.recordedContext.toolsSource})
            </div>
            <div>SystemPrompt: {episode.recordedContext.systemPrompt ? 'present' : 'missing'}</div>
            <div>Identity: {episode.recordedContext.identityMemory ? 'present' : 'missing'}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
