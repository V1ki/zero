import { writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BenchmarkSummary, CaseRunResult } from './types'

export function writeMarkdownReport(path: string, summary: BenchmarkSummary): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, renderMarkdownReport(summary), 'utf8')
}

function renderMarkdownReport(summary: BenchmarkSummary): string {
  const lines: string[] = []
  lines.push('# Zero Runtime Benchmark Report')
  lines.push('')
  lines.push(`Run ID: \`${summary.runId}\``)
  lines.push(`Generated: ${summary.generatedAt}`)
  lines.push('')
  lines.push('## Matrix')
  lines.push('')
  lines.push('| case | phase | model | status | validation | llm | tools | errors | cost |')
  lines.push('| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |')

  for (const result of summary.results) {
    lines.push(
      [
        result.caseId,
        summary.plan.find((entry) => entry.caseId === result.caseId)?.phase ?? '',
        result.model.label,
        result.status,
        result.validation.ok ? 'pass' : 'fail',
        String(result.trace.llmRequestCount),
        String(result.trace.toolCallCount),
        String(result.trace.toolErrorCount),
        result.trace.cost.toFixed(6),
      ]
        .map((value) => escapeCell(value))
        .join(' | ')
        .replace(/^/, '| ')
        .replace(/$/, ' |'),
    )
  }

  lines.push('')
  lines.push('## Case Details')
  lines.push('')

  for (const result of summary.results) {
    appendCaseResult(lines, result)
  }

  return `${lines.join('\n')}\n`
}

function appendCaseResult(lines: string[], result: CaseRunResult): void {
  lines.push(`### ${result.caseId} / ${result.model.label}`)
  lines.push('')
  lines.push(`- status: \`${result.status}\``)
  lines.push(`- validation: \`${result.validation.ok ? 'pass' : 'fail'}\``)
  lines.push(`- duration: \`${result.durationMs}ms\``)
  if (result.sessionId) lines.push(`- session: \`${result.sessionId}\``)
  if (result.tracePath) lines.push(`- trace: \`${result.tracePath}\``)
  if (result.runLogPath) lines.push(`- run log: \`${result.runLogPath}\``)
  if (result.error) lines.push(`- error: \`${result.error}\``)
  lines.push('')
  lines.push('Validation checks:')
  for (const check of result.validation.checks) {
    lines.push(
      `- ${check.passed ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` (${check.detail})` : ''}`,
    )
  }
  lines.push('')
  lines.push('Final text preview:')
  lines.push('')
  lines.push('```text')
  lines.push(result.finalText.slice(0, 1600))
  lines.push('```')
  lines.push('')
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|')
}
