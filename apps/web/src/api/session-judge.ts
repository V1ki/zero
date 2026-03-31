import { recordCompletionUsage } from '@zero-os/core'
import {
  type RequestLogEntry,
  type SnapshotEntry,
  type TraceSpan,
  flattenTraceSpans,
} from '@zero-os/observe'
import type { CompletionResponse, Message } from '@zero-os/shared'
import { now, toErrorMessage } from '@zero-os/shared'
import type { ZeroOS } from '../../../server/src/main'
import type {
  SessionJudgeArtifacts,
  SessionJudgeDimension,
  SessionJudgeDimensionKey,
  SessionJudgeExchangeArtifacts,
  SessionJudgeFinding,
  SessionJudgeResponse,
  SessionJudgeResult,
  SessionJudgeRunOutput,
  SessionJudgeSignals,
} from '../eval/types'

const DIMENSION_LABELS: Record<SessionJudgeDimensionKey, string> = {
  task_completion: 'Task Completion',
  context_management: 'Context Management',
  memory_usage: 'Memory Usage',
  evidence_grounding: 'Evidence Grounding',
  tool_efficiency: 'Tool Efficiency',
  cost_efficiency: 'Cost Efficiency',
  human_intervention: 'Human Intervention Judgment',
  recovery_honesty: 'Recovery & Honesty',
}

const JUDGE_SYSTEM_PROMPT = `You are a strict evaluator for agent execution traces.
Judge process quality and outcome quality from evidence only. Never infer success without evidence.
Be fair to legitimate blockers, retries after real errors, and tasks that genuinely do not require memory.

Score these dimensions from 0 to 5:
- task_completion: did the agent actually complete the user task or clearly end in a justified block?
- context_management: did it preserve relevant context, avoid losing track, and keep the session coherent?
- memory_usage: did it use memory_search / memory_get / memory write appropriately when memory would help? Do not penalize if memory was unnecessary or identity memory already covered it.
- evidence_grounding: are conclusions grounded in tool outputs, memory evidence, or trace evidence?
- tool_efficiency: were tools chosen well, with minimal useless duplicate calls?
- cost_efficiency: was request/tool usage proportionate, or obviously wasteful?
- human_intervention: did it ask for human intervention only when genuinely necessary, and did it stop to ask when truly blocked by missing authority, approvals, credentials, private facts, or required user choices?
- recovery_honesty: did it surface blockers/errors honestly instead of bluffing completion?

Return ONLY valid JSON with this exact shape:
{
  "overallScore": 0,
  "verdict": "strong|mixed|weak",
  "confidence": "high|medium|low",
  "summary": "...",
  "dimensions": [
    {
      "key": "task_completion",
      "label": "Task Completion",
      "score": 0,
      "maxScore": 5,
      "rationale": "..."
    }
  ],
  "findings": [
    {
      "severity": "info|warn|bad",
      "title": "...",
      "evidence": "..."
    }
  ]
}`

const JUDGE_REPAIR_SYSTEM_PROMPT = `You repair malformed JSON produced by a session judge.
Return ONLY valid JSON matching the original judge schema.
Preserve the original meaning, scores, verdict, confidence, summary, dimensions, and findings whenever possible.
If a field is missing, fill it conservatively rather than inventing strong claims.`

type JudgeCompletionAdapter = {
  complete(request: {
    messages: Message[]
    system?: string
    stream: boolean
    maxTokens?: number
    model?: string
  }): Promise<CompletionResponse>
}

interface ParsedJudgeArtifacts {
  parsed: Omit<SessionJudgeResult, 'signals'>
  repair?: SessionJudgeExchangeArtifacts
}

export async function runSessionJudge(
  zero: ZeroOS,
  sessionId: string,
  options?: { model?: string },
): Promise<SessionJudgeRunOutput> {
  const session = zero.sessionManager.get(sessionId)
  const row = session ? null : zero.sessionManager.getFromDB(sessionId)
  if (!session && !row) {
    throw new Error('Session not found')
  }

  const currentModel = session?.data.currentModel ?? row?.currentModel
  const resolved = resolveJudgeModel(zero, options?.model ?? currentModel)
  const modelLabel = zero.modelRouter.getModelLabel(resolved)
  const messages = session
    ? session.getMessages()
    : zero.sessionManager.getMessagesFromDB(sessionId)
  const requests = zero.observability.readSessionRequests(sessionId)
  const closures = zero.observability.readSessionClosures(sessionId)
  const snapshots = zero.observability.readSessionSnapshots(sessionId)
  const traces = zero.tracer.exportSession(sessionId)
  const signals = collectSignals(requests, closures.length)
  const payload = buildJudgePayload(zero, {
    sessionId,
    currentModel,
    summary: session?.data.summary ?? row?.summary,
    status: session?.getStatus() ?? row?.status,
    messages,
    requests,
    closures,
    snapshots,
    traces,
    signals,
  })

  const primarySystemPrompt = JUDGE_SYSTEM_PROMPT
  const primaryUserPrompt = buildJudgePrompt(payload)
  const primaryStartedAt = Date.now()
  const primaryCompletion = await resolved.adapter.complete({
    messages: [
      {
        id: `judge_${sessionId}`,
        sessionId,
        role: 'user',
        messageType: 'message',
        content: [{ type: 'text', text: primaryUserPrompt }],
        createdAt: now(),
      },
    ],
    system: primarySystemPrompt,
    stream: false,
    maxTokens: 3200,
  })
  recordCompletionUsage(zero.metrics, primaryCompletion, {
    sessionId,
    purpose: 'session_judge',
    model: modelLabel,
    provider: resolved.providerName,
    pricing: resolved.modelConfig.pricing,
    durationMs: Date.now() - primaryStartedAt,
  })
  const primaryRawText = extractResponseText(primaryCompletion)

  const { parsed, repair } = await parseOrRepairJudgeResponse(
    zero,
    resolved.adapter,
    sessionId,
    primaryRawText,
    {
      model: modelLabel,
      provider: resolved.providerName,
      pricing: resolved.modelConfig.pricing,
    },
  )

  const generatedAt = now()
  const run = {
    sessionId,
    model: modelLabel,
    generatedAt,
    result: {
      ...parsed,
      signals,
    },
  } satisfies SessionJudgeResponse

  const artifacts: SessionJudgeArtifacts = {
    primary: {
      request: {
        systemPrompt: primarySystemPrompt,
        userPrompt: primaryUserPrompt,
        model: resolved.modelConfig.modelId,
        maxTokens: 3200,
        stream: false,
      },
      response: {
        completion: primaryCompletion,
        rawText: primaryRawText,
      },
    },
    ...(repair ? { repair } : {}),
  }

  return {
    run,
    artifacts,
  }
}

function resolveJudgeModel(zero: ZeroOS, preferred?: string) {
  if (preferred) {
    const resolved = zero.modelRouter.resolveModel(preferred)
    if (resolved) return resolved
  }

  const fallback = zero.modelRouter.getCurrentModel() ?? zero.modelRouter.getDefaultModel()
  if (!fallback) {
    throw new Error('No active model available for LLM judge')
  }

  return fallback
}

function buildJudgePayload(
  zero: ZeroOS,
  input: {
    sessionId: string
    currentModel?: string
    summary?: string
    status?: string
    messages: Message[]
    requests: RequestLogEntry[]
    closures: ReturnType<ZeroOS['observability']['readSessionClosures']>
    snapshots: SnapshotEntry[]
    traces: TraceSpan[]
    signals: SessionJudgeSignals
  },
) {
  const filter = (value: string) => zero.secretFilter.filter(value)
  const recentMessages = input.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-8)
    .map((message) => ({
      role: message.role,
      createdAt: message.createdAt,
      text: previewText(filter(extractMessageText(message)), 320),
    }))

  const recentRequests = input.requests.slice(-8).map((request) => ({
    turnIndex: request.turnIndex,
    model: request.model,
    stopReason: request.stopReason,
    toolUseCount: request.toolUseCount,
    cost: request.cost,
    durationMs: request.durationMs,
    userPrompt: previewText(filter(request.userPrompt), 280),
    response: previewText(filter(request.response), 280),
    toolCalls: request.toolCalls.slice(0, 4).map((toolCall) => ({
      name: toolCall.name,
      input: previewText(filter(stableStringify(toolCall.input)), 200),
    })),
    toolResults: request.toolResults.slice(0, 4).map((result) => ({
      toolUseId: result.toolUseId,
      isError: !!result.isError,
      outputSummary: previewText(filter(result.outputSummary ?? result.content), 140),
    })),
  }))

  const memorySignals = collectMemorySignals(input.requests, filter)
  const toolSignals = collectToolSignals(input.requests, filter)
  const interventionSignals = collectInterventionSignals(
    input.messages,
    input.requests,
    input.closures,
    filter,
  )
  const latestSnapshot = input.snapshots.at(-1)

  return {
    session: {
      id: input.sessionId,
      model: input.currentModel,
      status: input.status,
      summary: previewText(filter(input.summary ?? ''), 320),
    },
    contextSignals: {
      recentMessages,
      recentRequests,
      snapshotCount: input.snapshots.length,
      latestSnapshot: latestSnapshot
        ? {
            trigger: latestSnapshot.trigger,
            model: latestSnapshot.model,
            tools: latestSnapshot.tools ?? [],
            hasIdentityMemory: Boolean(latestSnapshot.identityMemory?.trim()),
            hasCompressedSummary: Boolean(latestSnapshot.compressedSummary?.trim()),
          }
        : null,
      runningSpanCount: flattenTraceSpans(input.traces).filter((span) => span.status === 'running')
        .length,
    },
    memorySignals,
    toolSignals,
    closureSignals: input.closures.slice(-4).map((closure) => ({
      event: closure.event,
      action: 'action' in closure ? closure.action : undefined,
      reason: previewText(filter(closure.reason), 220),
      failureStage: 'failureStage' in closure ? closure.failureStage : undefined,
      ts: closure.ts,
    })),
    interventionSignals,
    costSignals: {
      totalCost: input.signals.totalCost,
      requestCount: input.signals.requestCount,
      toolCallCount: input.signals.toolCallCount,
      duplicateToolCallCount: input.signals.duplicateToolCallCount,
      avgCostPerRequest:
        input.signals.requestCount > 0 ? input.signals.totalCost / input.signals.requestCount : 0,
      avgRequestsPerTurn:
        input.signals.closureCount > 0
          ? input.signals.requestCount / input.signals.closureCount
          : input.signals.requestCount,
    },
  }
}

function buildJudgePrompt(payload: Record<string, unknown>): string {
  return [
    'Evaluate this ZeRo OS session package. Focus on process quality, evidence usage, memory usage, tool duplication, cost discipline, and human intervention judgment.',
    'If evidence is missing, say so and lower confidence instead of guessing.',
    '',
    JSON.stringify(payload, null, 2),
  ].join('\n')
}

async function parseOrRepairJudgeResponse(
  zero: ZeroOS,
  adapter: JudgeCompletionAdapter,
  sessionId: string,
  raw: string,
  usageContext: {
    model: string
    provider: string
    pricing?: import('@zero-os/shared').ModelPricing
  },
): Promise<ParsedJudgeArtifacts> {
  try {
    return { parsed: parseJudgeResponse(raw) }
  } catch (parseError) {
    const repairUserPrompt = buildJudgeRepairPrompt(raw, parseError)
    const repairStartedAt = Date.now()
    const repaired = await adapter.complete({
      messages: [
        {
          id: `judge_repair_${sessionId}`,
          sessionId,
          role: 'user',
          messageType: 'message',
          content: [
            {
              type: 'text',
              text: repairUserPrompt,
            },
          ],
          createdAt: now(),
        },
      ],
      system: JUDGE_REPAIR_SYSTEM_PROMPT,
      stream: false,
      maxTokens: 1800,
    })
    recordCompletionUsage(zero.metrics, repaired, {
      sessionId,
      purpose: 'session_judge',
      model: usageContext.model,
      provider: usageContext.provider,
      pricing: usageContext.pricing,
      durationMs: Date.now() - repairStartedAt,
    })
    const repairRawText = extractResponseText(repaired)

    return {
      parsed: parseJudgeResponse(repairRawText),
      repair: {
        request: {
          systemPrompt: JUDGE_REPAIR_SYSTEM_PROMPT,
          userPrompt: repairUserPrompt,
          model: usageContext.model,
          maxTokens: 1800,
          stream: false,
        },
        response: {
          completion: repaired,
          rawText: repairRawText,
        },
      },
    }
  }
}

function buildJudgeRepairPrompt(raw: string, parseError: unknown): string {
  const detail = toErrorMessage(parseError)
  return [
    'Repair this malformed session-judge JSON into valid JSON.',
    'Keep the original intent and values whenever possible.',
    `Parse error: ${detail}`,
    '',
    raw,
  ].join('\n')
}

function parseJudgeResponse(raw: string): Omit<SessionJudgeResult, 'signals'> {
  const parsed = parseJudgeJson(raw) as Partial<SessionJudgeResult>
  const dimensions = normalizeDimensions(parsed.dimensions)
  const findings = normalizeFindings(parsed.findings)

  return {
    overallScore: normalizeOverallScore(parsed.overallScore, dimensions),
    verdict: normalizeVerdict(parsed.verdict),
    confidence: normalizeConfidence(parsed.confidence),
    summary:
      typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
        ? parsed.summary.trim()
        : 'No summary returned by judge.',
    dimensions,
    findings,
  }
}

function normalizeOverallScore(
  value: unknown,
  dimensions: SessionJudgeDimension[],
): SessionJudgeResult['overallScore'] {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const rounded = Math.round(value)
    if (rounded >= 0 && rounded <= 5) {
      return Math.round((rounded / 5) * 100)
    }
    return clampInteger(rounded, 0, 100)
  }

  if (dimensions.length === 0) return 0
  const totalScore = dimensions.reduce((sum, dimension) => sum + dimension.score, 0)
  const totalMax = dimensions.reduce((sum, dimension) => sum + dimension.maxScore, 0)
  if (totalMax <= 0) return 0
  return Math.round((totalScore / totalMax) * 100)
}

function normalizeDimensions(value: unknown): SessionJudgeDimension[] {
  const items = Array.isArray(value) ? value : []
  const normalized = items
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const candidate = item as Record<string, unknown>
      const key = candidate.key as SessionJudgeDimensionKey
      if (!(key in DIMENSION_LABELS)) return null
      return {
        key,
        label:
          typeof candidate.label === 'string' && candidate.label.trim().length > 0
            ? candidate.label.trim()
            : DIMENSION_LABELS[key],
        score: clampInteger(candidate.score, 0, 5),
        maxScore:
          typeof candidate.maxScore === 'number' && Number.isFinite(candidate.maxScore)
            ? clampInteger(candidate.maxScore, 1, 5)
            : 5,
        rationale:
          typeof candidate.rationale === 'string' && candidate.rationale.trim().length > 0
            ? candidate.rationale.trim()
            : 'No rationale provided.',
      } satisfies SessionJudgeDimension
    })
    .filter((item): item is SessionJudgeDimension => item !== null)

  const defaults = Object.entries(DIMENSION_LABELS).map(([key, label]) => ({
    key: key as SessionJudgeDimensionKey,
    label,
    score: 0,
    maxScore: 5,
    rationale: 'Dimension missing from judge output.',
  }))

  if (normalized.length === 0) return defaults

  const byKey = new Map(normalized.map((dimension) => [dimension.key, dimension]))
  return defaults.map((dimension) => byKey.get(dimension.key) ?? dimension)
}

function normalizeFindings(value: unknown): SessionJudgeFinding[] {
  const items = Array.isArray(value) ? value : []
  return items
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const candidate = item as Record<string, unknown>
      return {
        severity: normalizeSeverity(candidate.severity),
        title:
          typeof candidate.title === 'string' && candidate.title.trim().length > 0
            ? candidate.title.trim()
            : 'Untitled finding',
        evidence:
          typeof candidate.evidence === 'string' && candidate.evidence.trim().length > 0
            ? candidate.evidence.trim()
            : 'No evidence provided.',
      } satisfies SessionJudgeFinding
    })
    .filter((item): item is SessionJudgeFinding => item !== null)
}

function normalizeVerdict(value: unknown): SessionJudgeResult['verdict'] {
  return value === 'strong' || value === 'mixed' || value === 'weak' ? value : 'mixed'
}

function normalizeConfidence(value: unknown): SessionJudgeResult['confidence'] {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'low'
}

function normalizeSeverity(value: unknown): SessionJudgeFinding['severity'] {
  return value === 'info' || value === 'warn' || value === 'bad' ? value : 'warn'
}

function collectSignals(requests: RequestLogEntry[], closureCount: number): SessionJudgeSignals {
  let toolCallCount = 0
  let memorySearchCount = 0
  let memoryGetCount = 0
  let memoryWriteCount = 0
  const duplicateMap = new Map<string, number>()

  for (const request of requests) {
    toolCallCount += request.toolCalls.length
    for (const toolCall of request.toolCalls) {
      const signature = `${toolCall.name}:${stableStringify(toolCall.input)}`
      duplicateMap.set(signature, (duplicateMap.get(signature) ?? 0) + 1)
      if (toolCall.name === 'memory_search') memorySearchCount++
      if (toolCall.name === 'memory_get') memoryGetCount++
      if (toolCall.name === 'memory') memoryWriteCount++
    }
  }

  const duplicateToolCallCount = Array.from(duplicateMap.values()).filter(
    (count) => count > 1,
  ).length

  return {
    totalCost: Number(requests.reduce((sum, request) => sum + request.cost, 0).toFixed(6)),
    requestCount: requests.length,
    toolCallCount,
    duplicateToolCallCount,
    memorySearchCount,
    memoryGetCount,
    memoryWriteCount,
    closureCount,
  }
}

function collectMemorySignals(requests: RequestLogEntry[], filter: (value: string) => string) {
  const queries: string[] = []
  const paths: string[] = []
  let memoryWriteCalls = 0

  for (const request of requests) {
    for (const toolCall of request.toolCalls) {
      if (toolCall.name === 'memory_search' && typeof toolCall.input.query === 'string') {
        queries.push(previewText(filter(toolCall.input.query), 120))
      }
      if (toolCall.name === 'memory_get' && typeof toolCall.input.path === 'string') {
        paths.push(previewText(filter(toolCall.input.path), 120))
      }
      if (toolCall.name === 'memory') {
        memoryWriteCalls++
      }
    }
  }

  return {
    searchQueries: unique(queries).slice(0, 5),
    memoryPaths: unique(paths).slice(0, 5),
    memoryWriteCalls,
  }
}

const HUMAN_INTERVENTION_HINTS = [
  'please',
  'can you',
  'could you',
  'need you',
  'provide',
  'confirm',
  'approval',
  'approve',
  'permission',
  'access',
  'auth code',
  'authorize',
  'manual',
  'human',
  'user input',
  'credential',
  'token',
  'login',
  'share',
  'upload',
  '请',
  '麻烦',
  '提供',
  '确认',
  '授权',
  '权限',
  '验证码',
  '凭证',
  '登录',
  '人工',
]

function collectInterventionSignals(
  messages: Message[],
  requests: RequestLogEntry[],
  closures: ReturnType<ZeroOS['observability']['readSessionClosures']>,
  filter: (value: string) => string,
) {
  const recentHumanAskSamples = messages
    .filter((message) => message.role === 'assistant')
    .map((message) => previewText(filter(extractMessageText(message)), 220))
    .filter((text) => text.length > 0 && looksLikeHumanInterventionAsk(text))

  const closureActions = closures
    .filter(
      (closure): closure is Extract<typeof closure, { action: 'continue' | 'finish' | 'block' }> =>
        'action' in closure,
    )
    .map((closure) => closure.action)

  const recentBlockReasons = closures
    .filter((closure) => 'action' in closure && closure.action === 'block')
    .slice(-4)
    .map((closure) => previewText(filter(closure.reason), 180))
    .filter((reason) => reason.length > 0)

  const toolErrorCount = requests.reduce(
    (sum, request) => sum + request.toolResults.filter((result) => result.isError === true).length,
    0,
  )
  const errorRequestCount = requests.filter((request) =>
    request.toolResults.some((result) => result.isError === true),
  ).length
  const unresolvedErrorTurnCount = requests.filter(
    (request) =>
      request.stopReason === 'end_turn' &&
      request.toolResults.some((result) => result.isError === true),
  ).length

  return {
    blockDecisionCount: closureActions.filter((action) => action === 'block').length,
    continueDecisionCount: closureActions.filter((action) => action === 'continue').length,
    finishDecisionCount: closureActions.filter((action) => action === 'finish').length,
    assistantHumanAskCount: recentHumanAskSamples.length,
    recentHumanAskSamples: recentHumanAskSamples.slice(-4),
    recentBlockReasons,
    toolErrorCount,
    errorRequestCount,
    unresolvedErrorTurnCount,
  }
}

function looksLikeHumanInterventionAsk(text: string): boolean {
  const normalized = text.toLowerCase()
  return (
    normalized.includes('?') || HUMAN_INTERVENTION_HINTS.some((hint) => normalized.includes(hint))
  )
}

function collectToolSignals(requests: RequestLogEntry[], filter: (value: string) => string) {
  const byTool = new Map<string, { count: number; errorCount: number }>()
  const duplicates = new Map<
    string,
    { toolName: string; inputSignature: string; count: number; turnIndexes: number[] }
  >()

  for (const request of requests) {
    const resultByToolUseId = new Map(
      request.toolResults.map((result) => [result.toolUseId, result.isError === true]),
    )

    for (const toolCall of request.toolCalls) {
      const stats = byTool.get(toolCall.name) ?? { count: 0, errorCount: 0 }
      stats.count++
      if (resultByToolUseId.get(toolCall.id)) {
        stats.errorCount++
      }
      byTool.set(toolCall.name, stats)

      const inputSignature = previewText(filter(stableStringify(toolCall.input)), 180)
      const key = `${toolCall.name}:${stableStringify(toolCall.input)}`
      const duplicate = duplicates.get(key) ?? {
        toolName: toolCall.name,
        inputSignature,
        count: 0,
        turnIndexes: [],
      }
      duplicate.count++
      duplicate.turnIndexes.push(request.turnIndex)
      duplicates.set(key, duplicate)
    }
  }

  return {
    byTool: Array.from(byTool.entries()).map(([name, stats]) => ({ name, ...stats })),
    duplicateCalls: Array.from(duplicates.values())
      .filter((item) => item.count > 1)
      .sort((left, right) => right.count - left.count)
      .slice(0, 6),
  }
}

function extractResponseText(response: {
  content: Array<{ type: string; text?: string }>
}): string {
  return response.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
}

function parseJudgeJson(value: string): unknown {
  const candidate = extractJsonCandidate(value)
  const cleaned = removeUnmatchedClosers(candidate)
  const attempts = unique([
    candidate,
    cleaned,
    stripTrailingCommas(candidate),
    stripTrailingCommas(cleaned),
    balanceJson(candidate),
    balanceJson(cleaned),
    stripTrailingCommas(balanceJson(candidate)),
    stripTrailingCommas(balanceJson(cleaned)),
  ])

  let lastError: Error | null = null
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  throw new Error(`Judge returned malformed JSON: ${lastError?.message ?? 'Unknown parse failure'}`)
}

function extractJsonCandidate(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()
  const start = trimmed.indexOf('{')
  if (start < 0) {
    throw new Error('Judge did not return valid JSON')
  }

  const balancedEnd = findBalancedJsonEnd(trimmed, start)
  if (balancedEnd >= start) {
    return trimmed.slice(start, balancedEnd + 1)
  }

  return trimmed.slice(start)
}

function findBalancedJsonEnd(value: string, start: number): number {
  let inString = false
  let escaped = false
  const stack: string[] = []

  for (let index = start; index < value.length; index++) {
    const char = value[index]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      stack.push('}')
      continue
    }
    if (char === '[') {
      stack.push(']')
      continue
    }
    if ((char === '}' || char === ']') && stack.at(-1) === char) {
      stack.pop()
      if (stack.length === 0) {
        return index
      }
    }
  }

  return -1
}

function removeUnmatchedClosers(value: string): string {
  let inString = false
  let escaped = false
  const stack: string[] = []
  let result = ''

  for (const char of value) {
    if (inString) {
      result += char
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      result += char
      continue
    }
    if (char === '{') {
      stack.push('}')
      result += char
      continue
    }
    if (char === '[') {
      stack.push(']')
      result += char
      continue
    }
    if (char === '}' || char === ']') {
      if (stack.at(-1) === char) {
        stack.pop()
        result += char
      }
      continue
    }

    result += char
  }

  return result
}

function balanceJson(value: string): string {
  let inString = false
  let escaped = false
  const stack: string[] = []

  for (const char of value) {
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      stack.push('}')
      continue
    }
    if (char === '[') {
      stack.push(']')
      continue
    }
    if ((char === '}' || char === ']') && stack.at(-1) === char) {
      stack.pop()
    }
  }

  return `${value}${inString ? '"' : ''}${stack.reverse().join('')}`
}

function stripTrailingCommas(value: string): string {
  return value.replace(/,\s*([}\]])/g, '$1').replace(/,\s*$/g, '')
}

function previewText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}…`
}

function extractMessageText(message: Message): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => String((block as { text: string }).text))
    .join('\n')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)))
}

function clampInteger(value: unknown, min: number, max: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : min
  return Math.max(min, Math.min(max, numeric))
}
