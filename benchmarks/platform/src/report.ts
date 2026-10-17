import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { accepted, hash, validateEvaluation } from './data'
import type { TrialRecord } from './types'

export function validateRecords(rows: TrialRecord[]): void {
  const ids = new Set<string>()
  for (const row of rows) {
    if (
      row.schemaVersion !== 1 ||
      !row.id ||
      !row.comparisonKey ||
      !row.provenance.sha256 ||
      !row.variant.fingerprint ||
      !row.case.inputHash ||
      !row.case.contractHash ||
      !Number.isInteger(row.rep) ||
      row.rep < 1
    )
      throw new Error('Invalid record identity')
    if (ids.has(row.id)) throw new Error('Duplicate trial: refusing to double-count')
    ids.add(row.id)
    if (row.evaluation)
      validateEvaluation(
        row.evaluation,
        row.evidence.map((e) => e.id),
      )
    for (const phase of ['execution', 'evaluation'] as const) {
      const metrics = row.measurements[phase]
      for (const value of [
        metrics.modelCalls,
        metrics.toolCalls,
        metrics.toolErrors,
        metrics.unknownCostOperations,
        ...Object.values(metrics.usage),
      ]) {
        if (value !== null && (!Number.isFinite(value) || value < 0))
          throw new Error('Invalid measurement')
      }
    }
  }
}

export function distribution(values: Array<number | null>) {
  const known = values.filter((v): v is number => v !== null).sort((a, b) => a - b)
  const middle = Math.floor(known.length / 2)
  return {
    known: known.length,
    missing: values.length - known.length,
    knownSum: known.length ? known.reduce((a, b) => a + b, 0) : null,
    median: known.length
      ? known.length % 2
        ? known[middle]
        : (known[middle - 1] + known[middle]) / 2
      : null,
    min: known[0] ?? null,
    max: known[known.length - 1] ?? null,
  }
}

export function summarize(rows: TrialRecord[]) {
  validateRecords(rows)
  const groups = new Map<string, TrialRecord[]>()
  for (const row of rows) {
    const key = hash([
      row.suite,
      row.suiteVersion,
      row.environment,
      row.case.family,
      row.target,
      row.variant,
    ])
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.values()].map((group) => {
    const first = group[0]
    const metricDefinitions = new Map(
      group.flatMap((r) =>
        (r.evaluation?.metrics ?? []).map((m) => [
          hash([r.evaluation?.evaluator, r.evaluation?.version, m.id, m.unit, m.direction]),
          { ...m, evaluator: r.evaluation?.evaluator, version: r.evaluation?.version },
        ]),
      ),
    )
    const phase = (name: 'execution' | 'evaluation') => {
      const values = group.map((r) => r.measurements[name])
      const usage = Object.fromEntries(
        Object.keys(first.measurements[name].usage).map((key) => [
          key,
          distribution(values.map((m) => m.usage[key as keyof typeof m.usage])),
        ]),
      )
      return {
        modelCalls: distribution(values.map((m) => m.modelCalls)),
        toolCalls: distribution(values.map((m) => m.toolCalls)),
        toolErrors: distribution(values.map((m) => m.toolErrors)),
        usage,
        costs: values.flatMap((m, i) => m.costs.map((cost) => ({ trialId: group[i].id, ...cost }))),
        unknownCostOperations: distribution(values.map((m) => m.unknownCostOperations)),
      }
    }
    return {
      suite: first.suite,
      family: first.case.family,
      target: first.target,
      variant: first.variant,
      environment: first.environment,
      trials: group.length,
      cases: new Set(group.map((r) => r.case.id)).size,
      sourceGroups: new Set(group.map((r) => r.case.sourceGroup)).size,
      accepted: group.filter(accepted).length,
      executionErrors: group.filter((r) => r.status !== 'ok').length,
      needsReview: group.filter((r) => !r.evaluation || r.evaluation.verdict === 'needs_review')
        .length,
      durationMs: distribution(group.map((r) => r.durationMs)),
      qualityMetrics: [...metricDefinitions.values()].map((definition) => ({
        id: definition.id,
        unit: definition.unit,
        direction: definition.direction,
        evaluator: definition.evaluator,
        version: definition.version,
        values: distribution(
          group.map((r) =>
            r.evaluation?.evaluator === definition.evaluator &&
            r.evaluation?.version === definition.version
              ? (r.evaluation?.metrics.find(
                  (m) =>
                    m.id === definition.id &&
                    m.unit === definition.unit &&
                    m.direction === definition.direction,
                )?.value ?? null)
              : null,
          ),
        ),
      })),
      execution: phase('execution'),
      evaluation: phase('evaluation'),
    }
  })
}

export function compare(rows: TrialRecord[], baseline: string, candidate: string) {
  validateRecords(rows)
  if (
    baseline === candidate ||
    !rows.some((r) => r.variant.id === baseline) ||
    !rows.some((r) => r.variant.id === candidate)
  )
    throw new Error('Provide two existing distinct variants')
  // A label cannot silently represent two different prompts/configurations.
  for (const label of [baseline, candidate]) {
    if (
      new Set(rows.filter((r) => r.variant.id === label).map((r) => r.variant.fingerprint)).size > 1
    )
      throw new Error('Variant fingerprint drift')
  }
  const pairs = new Map<string, TrialRecord[]>()
  for (const row of rows.filter((r) => [baseline, candidate].includes(r.variant.id))) {
    const key = hash([
      row.suite,
      row.case,
      row.target,
      row.environment,
      row.comparisonKey,
      row.block,
      row.rep,
    ])
    const pair = pairs.get(key) ?? []
    if (pair.some((r) => r.variant.id === row.variant.id))
      throw new Error('Ambiguous duplicate pair')
    pairs.set(key, [...pair, row])
  }
  return [...pairs.values()].map((pair) => {
    const before = pair.find((r) => r.variant.id === baseline)
    const after = pair.find((r) => r.variant.id === candidate)
    const row = pair[0]
    const comparable =
      before &&
      after &&
      before.evaluation &&
      after.evaluation &&
      before.evaluation.verdict !== 'needs_review' &&
      after.evaluation.verdict !== 'needs_review' &&
      before.status === 'ok' &&
      after.status === 'ok' &&
      before.evaluation.evaluator === after.evaluation.evaluator &&
      before.evaluation.version === after.evaluation.version
    const delta = (a: number | null, b: number | null) => (a === null || b === null ? null : b - a)
    const bothAccepted = !!before && !!after && accepted(before) && accepted(after)
    return {
      suite: row.suite,
      caseId: row.case.id,
      target: row.target,
      rep: row.rep,
      before: before?.id ?? null,
      after: after?.id ?? null,
      result: !comparable
        ? 'unresolved'
        : accepted(after) && !accepted(before)
          ? 'win'
          : accepted(before) && !accepted(after)
            ? 'loss'
            : 'tie',
      bothAccepted,
      // This is a delivery-qualified cost comparison, not proof of equal semantic quality.
      efficiency:
        bothAccepted && before && after
          ? {
              durationMs: delta(before.durationMs, after.durationMs),
              modelCalls: delta(
                before.measurements.execution.modelCalls,
                after.measurements.execution.modelCalls,
              ),
              toolCalls: delta(
                before.measurements.execution.toolCalls,
                after.measurements.execution.toolCalls,
              ),
              inputTokens: delta(
                before.measurements.execution.usage.input,
                after.measurements.execution.usage.input,
              ),
              outputTokens: delta(
                before.measurements.execution.usage.output,
                after.measurements.execution.usage.output,
              ),
            }
          : null,
      metrics: comparable
        ? (before?.evaluation?.metrics ?? []).flatMap((metric) => {
            const b = after?.evaluation?.metrics.find(
              (m) =>
                m.id === metric.id && m.unit === metric.unit && m.direction === metric.direction,
            )
            return b
              ? [
                  {
                    id: metric.id,
                    unit: metric.unit,
                    direction: metric.direction,
                    delta: delta(metric.value, b.value),
                  },
                ]
              : []
          })
        : [],
    }
  })
}

const cell = (value: unknown) =>
  String(value ?? '未知')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ')
    .replaceAll('\r', ' ')
export function renderReport(rows: TrialRecord[]) {
  const groups = summarize(rows)
  const sum = (value: ReturnType<typeof distribution>) =>
    `${value.knownSum ?? '未知'}${value.missing ? `（${value.missing} 次未知）` : ''}`
  const lines = [
    '# Benchmark 结果',
    '',
    '按任务族、环境和版本分别统计。所有尝试均进入分母；未知用量不补零。通过只代表该 benchmark 声明的验收范围。',
    '',
    '| 测试 / 任务族 | 环境 | 目标 | 版本 | 通过/尝试 | 执行异常 | 待评审 | 模型请求 | 工具调用 | 未缓存输入 | 输出 | 耗时中位数 ms |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...groups.map(
      (g) =>
        `| ${[`${g.suite} / ${g.family}`, g.environment.mode, g.target, g.variant.id, `${g.accepted}/${g.trials}`, g.executionErrors, g.needsReview, sum(g.execution.modelCalls), sum(g.execution.toolCalls), sum(g.execution.usage.input), sum(g.execution.usage.output), g.durationMs.median].map(cell).join(' | ')} |`,
    ),
    '',
    '## 逐次结果',
    '',
    '| 任务 | 目标 / 版本 | 重复 | 执行状态 | 任务结果 | 评审 | 工具分布（调用/错误） |',
    '|---|---|---:|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${[
          r.case.id,
          `${r.target} / ${r.variant.id}`,
          r.rep,
          r.status,
          r.outcome,
          r.evaluation?.verdict,
          Object.entries(r.measurements.execution.tools)
            .map(([name, t]) => `${name}: ${t.calls}/${t.errors}`)
            .join(', ') || '无记录',
        ]
          .map(cell)
          .join(' | ')} |`,
    ),
    '',
    '## 费用与评审',
    '',
    '| 测试 / 任务族 / 版本 | 阶段 | 缓存读取 | 缓存写入 | 推理（输出子集） | 已知费用条目 | 未知费用调用 |',
    '|---|---|---:|---:|---:|---|---:|',
    ...groups.flatMap((g) =>
      (['execution', 'evaluation'] as const).map((phase) => {
        const m = g[phase]
        const costs = new Map<string, number>()
        for (const cost of m.costs) {
          const key = `${cost.currency} (${cost.basis})`
          costs.set(key, (costs.get(key) ?? 0) + cost.amount)
        }
        return `| ${[`${g.suite} / ${g.family} / ${g.target} / ${g.variant.id}`, phase, sum(m.usage.cacheRead), sum(m.usage.cacheWrite), sum(m.usage.reasoning), [...costs].map(([key, amount]) => `${amount.toFixed(6)} ${key}`).join(', ') || '未提供费用条目', sum(m.unknownCostOperations)].map(cell).join(' | ')} |`
      }),
    ),
    '',
    '## 插件质量指标',
    '',
    '| 测试 / 任务族 / 版本 | 指标 | 单位 | 中位数 | 已知/缺失 |',
    '|---|---|---|---:|---:|',
    ...groups.flatMap((g) =>
      g.qualityMetrics.map(
        (m) =>
          `| ${[`${g.suite} / ${g.family} / ${g.target} / ${g.variant.id}`, `${m.evaluator}@${m.version}: ${m.id}`, m.unit, m.values.median, `${m.values.known}/${m.values.missing}`].map(cell).join(' | ')} |`,
      ),
    ),
    '',
    'summary.json 分开列出执行与评审用量、缓存、推理用量、已知费用及未知项；不同币种、估算和实际计费不混加。推理 token 不额外加进输出 token。重复次数不等于独立任务数。',
    '',
    'results.jsonl 保留评分项、指标、证据引用与逐次工具摘要。事件只保存参数/结果的哈希及字节数，未保存原始参数和返回文本；需要内容核验时由插件显式保存脱敏证据。',
    '',
    '## 限制',
    '',
    ...[...new Set(rows.flatMap((r) => r.limitations))].map((s) => `- ${cell(s)}`),
    '',
  ]
  return lines.join('\n')
}

export function writeReports(out: string, rows: TrialRecord[]) {
  const summary = summarize(rows)
  writeFileSync(
    join(out, 'summary.json'),
    JSON.stringify({ schemaVersion: 1, groups: summary }, null, 2),
    { flag: 'wx' },
  )
  writeFileSync(join(out, 'report.md'), renderReport(rows), { flag: 'wx' })
}

export function exportRecords(out: string, rows: TrialRecord[]) {
  validateRecords(rows)
  mkdirSync(dirname(out), { recursive: true })
  mkdirSync(out)
  writeFileSync(
    join(out, 'results.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''),
    { flag: 'wx' },
  )
  writeReports(out, rows)
}
