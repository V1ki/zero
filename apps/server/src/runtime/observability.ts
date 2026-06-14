import { join } from 'node:path'
import { LiteLLMPricing, type UsageRecorder, computeCost } from '@zero-os/model'
import { MetricsDB, ObservabilityStore, SessionDB, Tracer, isUsagePurpose } from '@zero-os/observe'
import { generateId, now } from '@zero-os/shared'
import { HeartbeatWriter } from '@zero-os/supervisor'

export interface ObservabilityRuntime {
  logsDir: string
  observability: ObservabilityStore
  metrics: MetricsDB
  sessionDb: SessionDB
  sessionsDbPath: string
  tracer: Tracer
  heartbeat: HeartbeatWriter
}

export function createObservabilityRuntime(zeroDir: string): ObservabilityRuntime {
  const logsDir = join(zeroDir, 'logs')
  const observability = new ObservabilityStore(logsDir)
  const metrics = new MetricsDB(join(logsDir, 'metrics.db'))
  const sessionsDbPath = join(logsDir, 'sessions.db')
  const sessionDb = new SessionDB(sessionsDbPath)
  metrics.attachSessionsDb(sessionsDbPath)
  const tracer = new Tracer(logsDir)
  const heartbeat = new HeartbeatWriter(join(zeroDir, 'heartbeat.json'))
  heartbeat.setReady(false, 'booting')
  heartbeat.start()
  console.log('[ZeRo OS] Logging initialized')
  console.log('[ZeRo OS] Heartbeat writer started')

  return {
    logsDir,
    observability,
    metrics,
    sessionDb,
    sessionsDbPath,
    tracer,
    heartbeat,
  }
}

export function createUsageRecorder(metrics: MetricsDB): UsageRecorder {
  return {
    record(entry) {
      if (!isUsagePurpose(entry.purpose)) {
        console.warn('[ZeRo OS] Skipping usage record with invalid purpose', {
          purpose: entry.purpose,
          sessionId: entry.sessionId,
          model: entry.model,
        })
        return
      }

      metrics.recordUsage({
        id: generateId(),
        sessionId: entry.sessionId,
        category: 'completion',
        purpose: entry.purpose,
        parentSessionId: entry.parentSessionId,
        model: entry.model,
        provider: entry.provider,
        inputTokens: entry.usage.input,
        outputTokens: entry.usage.output,
        cacheWriteTokens: entry.usage.cacheWrite,
        cacheReadTokens: entry.usage.cacheRead,
        reasoningTokens: entry.usage.reasoning,
        cost: entry.cost,
        durationMs: entry.durationMs,
        createdAt: now(),
      })
    },
  }
}

interface EmbeddingUsage {
  sessionId: string | null
  promptTokens: number
  totalTokens: number
  durationMs: number
  batchSize: number
}

export function createEmbeddingUsageRecorder(options: {
  model: string
  metrics: MetricsDB
}): (usage: EmbeddingUsage) => void {
  const { model, metrics } = options
  const embeddingPricing = LiteLLMPricing.getInstance()?.lookup(model) ?? undefined

  return (usage) => {
    const outputTokens = Math.max(usage.totalTokens - usage.promptTokens, 0)
    metrics.recordUsage({
      id: generateId(),
      sessionId: usage.sessionId,
      category: 'embedding',
      purpose: 'embedding',
      model,
      provider: 'embedding',
      inputTokens: usage.promptTokens,
      outputTokens,
      reasoningTokens: 0,
      cost: computeCost(
        {
          input: usage.promptTokens,
          output: outputTokens,
        },
        embeddingPricing,
      ),
      durationMs: usage.durationMs,
      metadata: JSON.stringify({ batchSize: usage.batchSize }),
      createdAt: now(),
    })
  }
}
