import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { BenchmarkResult } from './metrics'

const RESULTS_DIR = resolve(import.meta.dir, '..', 'results')

export interface BenchmarkSummaryRow {
  scenario: string
  model: string
  path: 'legacy' | 'async'
  wallTimeMs: number
  success: string
  llmCalls: number | 'N/A'
  totalTokens: number | 'N/A'
  estimatedCost: number | 'N/A'
}

export function reportProgress(
  result: BenchmarkResult,
  progress: { current: number; total: number },
): void {
  console.table([
    {
      Progress: `${progress.current}/${progress.total}`,
      Scenario: result.scenario,
      Model: result.model,
      Path: result.path,
      'Wall Time (ms)': result.wallTimeMs,
      Success: formatSuccess(result),
      'LLM Calls': result.skipped ? 'N/A' : (result.llmCalls ?? 0),
      Tokens: result.skipped ? 'N/A' : (result.totalTokens ?? 0),
      'Est. Cost': result.skipped ? 'N/A' : formatCost(result.estimatedCost),
    },
  ])
}

export function printSummary(results: BenchmarkResult[]): BenchmarkSummaryRow[] {
  const summary = summarizeResults(results)

  console.table(
    summary.map((row) => ({
      Scenario: row.scenario,
      Model: row.model,
      Path: row.path,
      'Wall Time (ms)': row.wallTimeMs,
      Success: row.success,
      'LLM Calls': row.llmCalls,
      Tokens: row.totalTokens,
      'Est. Cost': row.estimatedCost === 'N/A' ? 'N/A' : row.estimatedCost.toFixed(6),
    })),
  )

  return summary
}

export function writeReports(results: BenchmarkResult[], options: Record<string, unknown>): {
  jsonPath: string
  markdownPath: string
} {
  mkdirSync(RESULTS_DIR, { recursive: true })

  const summary = summarizeResults(results)
  const timestamp = new Date().toISOString().replaceAll(':', '-')
  const jsonPath = join(RESULTS_DIR, `benchmark-${timestamp}.json`)
  const markdownPath = join(RESULTS_DIR, `benchmark-${timestamp}.md`)

  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        options,
        results,
        summary,
      },
      null,
      2,
    ),
    'utf-8',
  )

  writeFileSync(markdownPath, buildMarkdown(summary), 'utf-8')

  return { jsonPath, markdownPath }
}

export function summarizeResults(results: BenchmarkResult[]): BenchmarkSummaryRow[] {
  const groups = new Map<string, BenchmarkResult[]>()

  for (const result of results) {
    const key = `${result.scenario}::${result.model}::${result.path}`
    const group = groups.get(key)
    if (group) {
      group.push(result)
    } else {
      groups.set(key, [result])
    }
  }

  return Array.from(groups.entries())
    .map(([key, group]) => {
      const [scenario, model, path] = key.split('::') as [
        string,
        string,
        'legacy' | 'async',
      ]
      const skipped = group.every((entry) => entry.skipped)
      const wallTimeMs = average(group.map((entry) => entry.wallTimeMs))

      if (skipped) {
        return {
          scenario,
          model,
          path,
          wallTimeMs,
          success: 'N/A',
          llmCalls: 'N/A' as const,
          totalTokens: 'N/A' as const,
          estimatedCost: 'N/A' as const,
        }
      }

      const successCount = group.filter((entry) => entry.success).length

      return {
        scenario,
        model,
        path,
        wallTimeMs,
        success: group.length === 1 ? String(group[0]?.success ?? false) : `${successCount}/${group.length}`,
        llmCalls: average(group.map((entry) => entry.llmCalls ?? 0)),
        totalTokens: average(group.map((entry) => entry.totalTokens ?? 0)),
        estimatedCost: roundTo(average(group.map((entry) => entry.estimatedCost ?? 0)), 6),
      }
    })
    .sort((left, right) => {
      if (left.scenario !== right.scenario) return left.scenario.localeCompare(right.scenario)
      if (left.model !== right.model) return left.model.localeCompare(right.model)
      return left.path.localeCompare(right.path)
    })
}

function buildMarkdown(summary: BenchmarkSummaryRow[]): string {
  const lines = [
    '# Sub-Agent Benchmark Summary',
    '',
    '| Scenario | Model | Path | Wall Time (ms) | Success | LLM Calls | Tokens | Est. Cost |',
    '|----------|-------|------|----------------|---------|-----------|--------|-----------|',
  ]

  for (const row of summary) {
    lines.push(
      `| ${row.scenario} | ${row.model} | ${row.path} | ${row.wallTimeMs} | ${row.success} | ${formatMarkdownValue(row.llmCalls)} | ${formatMarkdownValue(row.totalTokens)} | ${formatMarkdownValue(row.estimatedCost)} |`,
    )
  }

  lines.push('')
  return lines.join('\n')
}

function formatSuccess(result: BenchmarkResult): string {
  return result.skipped ? 'N/A' : String(result.success)
}

function formatMarkdownValue(value: number | 'N/A'): string {
  if (value === 'N/A') return value
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? String(value) : value.toFixed(6)
}

function formatCost(value: number | undefined): string {
  if (value === undefined) return '0'
  return value.toFixed(6)
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
