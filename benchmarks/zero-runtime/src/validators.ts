import { existsSync, readFileSync } from 'node:fs'
import type { TraceEntry } from '@zero-os/observe'
import type { Message } from '@zero-os/shared'
import { interpolateTemplate } from './cases'
import type { BenchmarkCase, TraceMetrics, ValidationCheck, ValidationResult } from './types'
import type { PromptVars } from './types'

export function collectTraceMetrics(rawEntries: TraceEntry[]): TraceMetrics {
  const collapsed = collapseTraceEntries(rawEntries)
  const stopReasons: Record<string, number> = {}
  const toolNames: Record<string, number> = {}

  let inputTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let cacheReadTokens = 0
  let cost = 0

  for (const entry of collapsed) {
    const request = getRequestData(entry)
    if (request) {
      const stopReason = getString(request.stopReason) ?? 'unknown'
      stopReasons[stopReason] = (stopReasons[stopReason] ?? 0) + 1
      const tokens = isRecord(request.tokens) ? request.tokens : {}
      inputTokens += getNumber(tokens.input)
      outputTokens += getNumber(tokens.output)
      reasoningTokens += getNumber(tokens.reasoning)
      cacheReadTokens += getNumber(tokens.cacheRead)
      cost += getNumber(request.cost)
    }

    if (entry.kind === 'tool_call') {
      const tool = getString(entry.data?.tool) ?? getToolNameFromEntryName(entry.name) ?? 'unknown'
      toolNames[tool] = (toolNames[tool] ?? 0) + 1
    }
  }

  return {
    rawEntryCount: rawEntries.length,
    collapsedEntryCount: collapsed.length,
    llmRequestCount: collapsed.filter((entry) => entry.kind === 'llm_request').length,
    toolCallCount: collapsed.filter((entry) => entry.kind === 'tool_call').length,
    toolErrorCount: collapsed.filter(
      (entry) => entry.kind === 'tool_call' && entry.status === 'error',
    ).length,
    closureFailedCount: collapsed.filter((entry) => entry.kind === 'closure_failed').length,
    turnSuccessCount: collapsed.filter(
      (entry) => entry.kind === 'turn' && entry.status === 'success',
    ).length,
    stopReasons,
    toolNames,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cost,
  }
}

export function validateCase(
  benchCase: BenchmarkCase,
  finalText: string,
  messages: Message[],
  rawEntries: TraceEntry[],
  vars: PromptVars,
): ValidationResult {
  const checks: ValidationCheck[] = []
  const collapsed = collapseTraceEntries(rawEntries)
  const toolNames = new Set(
    collapsed
      .filter((entry) => entry.kind === 'tool_call')
      .map((entry) => getString(entry.data?.tool) ?? getToolNameFromEntryName(entry.name))
      .filter((name): name is string => Boolean(name)),
  )
  const toolCallCount = collapsed.filter((entry) => entry.kind === 'tool_call').length

  for (const expected of benchCase.validation.finalTextIncludes ?? []) {
    checks.push({
      name: `final_text_includes:${expected}`,
      passed: finalText.includes(expected),
    })
  }

  for (const forbidden of benchCase.validation.finalTextExcludes ?? []) {
    checks.push({
      name: `final_text_excludes:${forbidden}`,
      passed: !finalText.includes(forbidden),
    })
  }

  if (benchCase.validation.disallowTools) {
    checks.push({
      name: 'no_tool_calls',
      passed: toolCallCount === 0,
      detail: `${toolCallCount} tool calls`,
    })
  }

  if (benchCase.validation.minToolCalls !== undefined) {
    checks.push({
      name: 'min_tool_calls',
      passed: toolCallCount >= benchCase.validation.minToolCalls,
      detail: `${toolCallCount}/${benchCase.validation.minToolCalls}`,
    })
  }

  for (const toolName of benchCase.validation.requiredToolNames ?? []) {
    checks.push({
      name: `required_tool:${toolName}`,
      passed: toolNames.has(toolName),
    })
  }

  for (const kind of benchCase.validation.requiredTraceKinds ?? []) {
    checks.push({
      name: `required_trace_kind:${kind}`,
      passed: collapsed.some((entry) => entry.kind === kind),
    })
  }

  for (const artifact of benchCase.validation.expectedArtifacts ?? []) {
    const path = interpolateTemplate(artifact.path, vars)
    const exists = existsSync(path)
    checks.push({
      name: `artifact_exists:${path}`,
      passed: exists,
    })

    if (!exists) continue

    const content = readFileSync(path, 'utf8')
    if (artifact.minBytes !== undefined) {
      checks.push({
        name: `artifact_min_bytes:${path}`,
        passed: Buffer.byteLength(content) >= artifact.minBytes,
        detail: `${Buffer.byteLength(content)}/${artifact.minBytes}`,
      })
    }
    for (const needle of artifact.contains ?? []) {
      checks.push({
        name: `artifact_contains:${needle}`,
        passed: content.includes(needle),
      })
    }
  }

  checks.push({
    name: 'assistant_final_text_non_empty',
    passed: finalText.trim().length > 0 || messages.some((message) => message.role === 'assistant'),
    detail: `${finalText.trim().length} chars`,
  })

  return {
    ok: checks.every((check) => check.passed),
    checks,
  }
}

function getRequestData(entry: TraceEntry): Record<string, unknown> | undefined {
  const request = entry.data?.request
  return isRecord(request) ? request : undefined
}

function getToolNameFromEntryName(name: string): string | undefined {
  if (!name.startsWith('tool:')) return undefined
  return name.slice('tool:'.length)
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function getNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collapseTraceEntries(entries: TraceEntry[]): TraceEntry[] {
  const latest = new Map<string, TraceEntry>()
  for (const entry of entries) {
    latest.set(`${entry.sessionId}:${entry.spanId}`, entry)
  }
  return Array.from(latest.values()).sort((left, right) =>
    left.startTime.localeCompare(right.startTime),
  )
}
