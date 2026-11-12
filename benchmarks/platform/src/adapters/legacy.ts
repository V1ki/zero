import { readFileSync } from 'node:fs'
import type { Trial } from '../../../zero-runtime/src/prompt-bench/engine'
import type { BenchmarkSummary } from '../../../zero-runtime/src/types'
import { digest, hash, unknownMeasurements } from '../data'
import type { Evaluation, TrialRecord } from '../types'

export type LegacyFormat = 'prompt' | 'runtime' | 'compaction'

/** summary.json written by the retired compaction:prompt-bench; only the fields imported here. */
export interface LegacyCompactionReport {
  variants: Array<{ id: string }>
  results: Array<{
    variantId: string
    rep: number
    sessionId: string
    model: string
    parseOk: boolean
    compactScore: number | null
    accuracyLossPercent: number | null
    exactHandleScore: number | null
    futureToolArgScore: number | null
    inputTokens: number
    outputTokens: number
    durationMs: number
    error?: string
  }>
}
export const legacyFormats: LegacyFormat[] = ['prompt', 'runtime', 'compaction']

function base(
  source: string,
  sourceHash: string,
  suite: string,
  caseId: string,
  target: string,
  variant: string,
  rep: number,
): TrialRecord {
  return {
    schemaVersion: 1,
    id: hash([sourceHash, suite, caseId, target, variant, rep]),
    suite,
    suiteVersion: 'legacy-import-v1',
    case: {
      id: caseId,
      family: suite,
      sourceGroup: `legacy-batch:${sourceHash}`,
      inputHash: hash([sourceHash, caseId]),
      contractHash: hash([suite, 'legacy-import-v1']),
    },
    variant: { id: variant, fingerprint: hash([sourceHash, variant]) },
    target,
    rep,
    block: hash([sourceHash, caseId, target, rep]),
    comparisonKey: hash([suite, sourceHash]),
    environment: { mode: 'offline', fingerprint: sourceHash },
    status: 'ok',
    failureStage: null,
    outcome: null,
    durationMs: null,
    evaluation: null,
    evidence: [{ id: 'legacy-result', kind: 'trace', ref: source, sha256: sourceHash }],
    operations: [],
    measurements: { execution: unknownMeasurements(), evaluation: unknownMeasurements() },
    provenance: { kind: 'import', source, sha256: sourceHash },
    limitations: [
      '历史结果导入，不重新执行或复核证据。只允许同一导入批次内配对；原材料、预算和评分器的跨批次一致性未证明。未记录的缓存、费用及评审用量保持未知。缺失来源关联时整批保守归为同一来源组，不把每道题当独立来源。',
    ],
  }
}

function checks(
  evaluator: string,
  entries: Array<[string, boolean | null]>,
  metrics: Evaluation['metrics'] = [],
): Evaluation {
  return {
    evaluator,
    version: 'legacy-v1',
    verdict: entries.some(([, value]) => value === false)
      ? 'failed'
      : !entries.length || entries.some(([, value]) => value === null)
        ? 'needs_review'
        : 'passed',
    checks: entries.map(([id, passed]) => ({
      id,
      passed,
      evidenceIds: passed === null ? [] : ['legacy-result'],
    })),
    metrics,
  }
}

export function importPrompt(rows: Trial[], source: string, sourceHash: string): TrialRecord[] {
  return rows.map((trial) => {
    const row = base(
      source,
      sourceHash,
      'zero-prompt',
      trial.caseId,
      trial.model,
      trial.variant,
      trial.rep,
    )
    row.variant.fingerprint = trial.snapshotHash
    row.case.family = trial.caseId.startsWith('closure-') ? 'closure-classification' : 'agent-task'
    row.environment.mode = 'simulated'
    row.status = trial.status === 'ok' ? 'ok' : trial.status === 'timeout' ? 'timeout' : 'error'
    row.durationMs = trial.durationMs
    row.outcome = trial.status === 'ok' ? (trial.passed ? 'completed' : 'partial') : null
    const m = row.measurements.execution
    if (trial.status === 'ok') {
      m.modelCalls = trial.requests
      m.usage = {
        input: trial.usage.input,
        output: trial.usage.output,
        cacheRead: trial.usage.cacheRead ?? null,
        cacheWrite: trial.usage.cacheWrite ?? null,
        reasoning: trial.usage.reasoning ?? null,
      }
      m.toolCalls = trial.observations.length
      m.toolErrors = trial.observations.filter((o) => o.error).length
      for (const observation of trial.observations) {
        const entry = m.tools[observation.name] ?? { calls: 0, errors: 0, durationMs: null }
        entry.calls++
        entry.errors += Number(observation.error)
        m.tools[observation.name] = entry
      }
      row.evaluation = checks('legacy-prompt-mechanical', [
        ['legacy-pass', trial.passed],
        ...Object.entries(trial.grade?.checks ?? {}),
      ])
    }
    row.limitations.push(
      '只有模拟工具总次数，无逐步耗时；模型请求数包含空回复重试。旧通过率不是新任务评分卡的语义质量分。',
    )
    return row
  })
}

export function importRuntime(
  summary: BenchmarkSummary,
  source: string,
  sourceHash: string,
): TrialRecord[] {
  return summary.results.map((trial) => {
    const row = base(
      source,
      sourceHash,
      'zero-runtime',
      trial.caseId,
      trial.model.model,
      'runtime-current',
      1,
    )
    row.environment.mode = 'controlled'
    row.case.family = summary.plan.find((p) => p.caseId === trial.caseId)?.category ?? 'runtime'
    row.status = trial.status === 'success' ? 'ok' : 'error'
    row.durationMs = trial.durationMs
    row.outcome =
      trial.status === 'success' ? (trial.validation.ok ? 'completed' : 'partial') : null
    if (trial.status === 'success') {
      const m = row.measurements.execution
      m.modelCalls = trial.trace.llmRequestCount
      m.toolCalls = trial.trace.toolCallCount
      m.toolErrors = trial.trace.toolErrorCount
      m.usage = {
        input: trial.trace.inputTokens,
        output: trial.trace.outputTokens,
        cacheRead: trial.trace.cacheReadTokens,
        cacheWrite: null,
        reasoning: trial.trace.reasoningTokens,
      }
      // Aggregate trace does not provide error counts or duration per tool.
      row.evaluation = checks('legacy-runtime-validation', [
        ['legacy-validation', trial.validation.ok],
        ...trial.validation.checks.map((c, i): [string, boolean] => [`${i}:${c.name}`, c.passed]),
      ])
    }
    row.limitations.push(
      '真实 Session 历史验证；原 cost 缺少币种及计费依据，未当作可比较账单。未重建缺失的逐工具事件或耗时。',
    )
    return row
  })
}

export function importCompaction(
  summary: LegacyCompactionReport,
  source: string,
  sourceHash: string,
): TrialRecord[] {
  return summary.results.map((trial) => {
    const row = base(
      source,
      sourceHash,
      'compaction-prompt',
      trial.sessionId,
      trial.model,
      trial.variantId,
      trial.rep,
    )
    row.variant.fingerprint = hash(
      summary.variants.find((v) => v.id === trial.variantId) ?? [sourceHash, trial.variantId],
    )
    row.case.sourceGroup = trial.sessionId
    row.environment.mode = 'controlled'
    row.status = trial.error ? 'error' : 'ok'
    row.durationMs = trial.durationMs
    row.outcome = trial.error ? null : trial.parseOk ? 'completed' : 'partial'
    if (!trial.error) {
      row.measurements.execution.usage.input = trial.inputTokens
      row.measurements.execution.usage.output = trial.outputTokens
    }
    // Legacy metrics have no frozen semantic acceptance threshold. Do not invent one.
    row.evaluation = checks(
      'legacy-compaction-proxy',
      [
        ['parse', trial.parseOk],
        ['semantic-acceptance', null],
      ],
      [
        { id: 'compact-score', value: trial.compactScore, unit: 'score', direction: 'higher' },
        {
          id: 'exact-handle-score',
          value: trial.exactHandleScore,
          unit: 'score',
          direction: 'higher',
        },
        {
          id: 'future-tool-arg-score',
          value: trial.futureToolArgScore,
          unit: 'score',
          direction: 'higher',
        },
        {
          id: 'accuracy-loss',
          value: trial.accuracyLossPercent,
          unit: 'percent',
          direction: 'lower',
        },
      ],
    )
    row.limitations.push(
      '压缩指标是代理指标；解析成功不自动代表语义验收。调用次数和缓存未保存在旧结果中。',
    )
    return row
  })
}

/** Read source once and bind all imported records to those exact bytes. */
export function importLegacy(format: LegacyFormat, source: string): TrialRecord[] {
  const raw = readFileSync(source, 'utf8')
  const sha256 = digest(raw)
  switch (format) {
    case 'prompt':
      return importPrompt(
        raw
          .split('\n')
          .filter((s) => s.trim())
          .map((s) => JSON.parse(s) as Trial),
        source,
        sha256,
      )
    case 'runtime':
      return importRuntime(JSON.parse(raw) as BenchmarkSummary, source, sha256)
    case 'compaction':
      return importCompaction(JSON.parse(raw) as LegacyCompactionReport, source, sha256)
  }
}
