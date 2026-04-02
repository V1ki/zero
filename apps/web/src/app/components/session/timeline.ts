import {
  type DecisionLogEntry,
  type DecisionType,
  asRecord,
  asString,
  flattenTraceSpans,
} from '@zero-os/observe'

export interface ContentBlock {
  type: string
  [key: string]: unknown
}

export interface Message {
  id: string
  role: string
  messageType: string
  controlKind?: string
  content: ContentBlock[]
  model?: string
  createdAt: string
}

export interface SessionTaskClosureEvent {
  ts: string
  event: 'task_closure_decision' | 'task_closure_failed'
  sessionId?: string
  action?: 'finish' | 'continue' | 'block'
  reason: string
  classifierRequest: {
    prompt: string
    maxTokens: number
  }
  failureStage?: 'parse_classifier_response' | 'request_classifier'
  classifierResponseRaw?: string
  assistantMessageId?: string
  assistantMessageCreatedAt?: string
  error?: string
}

export interface TaskClosureTimelineItem {
  type: 'task-closure'
  id: string
  event: SessionTaskClosureEvent['event']
  action?: SessionTaskClosureEvent['action']
  reason: string
  failureStage?: SessionTaskClosureEvent['failureStage']
  classifierRequest?: SessionTaskClosureEvent['classifierRequest']
  classifierResponseRaw?: string
  assistantMessageId?: string
  assistantMessageCreatedAt?: string
  error?: string
  createdAt: string
}

export type SessionDecisionType = DecisionType

export type SessionDecisionEvent = Omit<DecisionLogEntry, 'sourceKind'> & {
  sourceKind: string
}

export interface DecisionTimelineItem {
  type: 'decision'
  id: string
  decisionType: SessionDecisionType
  outcome: string
  context?: Record<string, unknown>
  detail?: Record<string, unknown>
  rationale?: string
  durationMs?: number
  sourceKind: string
  createdAt: string
}

export interface TraceSpan {
  id: string
  parentId?: string
  sessionId: string
  name: string
  startTime: string
  endTime?: string
  durationMs?: number
  status: 'running' | 'success' | 'error'
  data?: Record<string, unknown>
  metadata?: Record<string, unknown>
  children: TraceSpan[]
}

interface TaskClosureTraceDetails {
  event?: SessionTaskClosureEvent['event']
  called?: boolean
  action?: SessionTaskClosureEvent['action']
  reason?: string
  failureStage?: SessionTaskClosureEvent['failureStage']
  classifierRequest?: SessionTaskClosureEvent['classifierRequest']
  classifierResponseRaw?: string
  assistantMessageId?: string
  assistantMessageCreatedAt?: string
  error?: string
}

export interface SubAgentChildToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
  durationMs?: number
}

export type TimelineItem =
  | {
      type: 'user-message'
      text: string
      queued: boolean
      images?: Array<{ mediaType: string; data: string }>
      createdAt: string
    }
  | { type: 'agent-text'; messageId: string; text: string; model?: string; createdAt: string }
  | {
      type: 'tool-call'
      id: string
      name: string
      input: Record<string, unknown>
      result?: string
      isError?: boolean
      durationMs?: number
      createdAt: string
    }
  | DecisionTimelineItem
  | TaskClosureTimelineItem
  | { type: 'system-event'; variant: 'warning' | 'info'; text: string; createdAt: string }
  | {
      type: 'sub-agent'
      agentId: string
      label: string
      role?: string
      instruction: string
      status: 'running' | 'waiting' | 'completed' | 'errored' | 'closed'
      output?: string
      durationMs?: number
      spawnToolCallId: string
      childToolCalls: SubAgentChildToolCall[]
      createdAt: string
    }

export function buildTimeline(
  messages: Message[],
  traces: TraceSpan[] = [],
  taskClosureEvents: SessionTaskClosureEvent[] = [],
  decisions: SessionDecisionEvent[] = [],
): TimelineItem[] {
  const items: TimelineItem[] = []
  const toolResults = new Map<string, { content: string; isError: boolean }>()
  const toolDurations = extractToolDurations(traces)
  const handledSubAgentIds = new Set<string>()
  const spawnToolCallIds = new Set<string>()

  for (const msg of messages) {
    if (msg.role === 'user' || msg.role === 'system') {
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          toolResults.set(block.toolUseId as string, {
            content: block.content as string,
            isError: !!block.isError,
          })
        }
      }
    }
  }

  for (const msg of messages) {
    if (msg.messageType === 'control') {
      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text as string)
        .join('\n')
      if (text) {
        items.push({
          type: 'system-event',
          variant: 'info',
          text,
          createdAt: msg.createdAt,
        })
      }
      continue
    }

    if (msg.messageType === 'notification') {
      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text as string)
        .join('\n')
      if (text) {
        const isWarning =
          text.toLowerCase().includes('timeout') ||
          text.toLowerCase().includes('error') ||
          text.toLowerCase().includes('degrad')
        const event: Extract<TimelineItem, { type: 'system-event' }> = {
          type: 'system-event',
          variant: isWarning ? 'warning' : 'info',
          text,
          createdAt: msg.createdAt,
        }
        items.push(event)
      }
      continue
    }

    if (msg.role === 'user') {
      if (msg.messageType === 'queued') {
        continue
      }

      const hasToolResultBlocks = msg.content.some((b) => b.type === 'tool_result')
      if (hasToolResultBlocks) {
        continue
      }

      const textBlocks = msg.content.filter((b) => b.type === 'text')
      const imageBlocks = msg.content
        .filter((b) => b.type === 'image')
        .map((b) => ({
          mediaType: b.mediaType as string,
          data: b.data as string,
        }))

      if (textBlocks.length > 0 || imageBlocks.length > 0) {
        const text = textBlocks.map((b) => b.text as string).join('\n')
        items.push({
          type: 'user-message',
          text,
          queued: false,
          images: imageBlocks.length > 0 ? imageBlocks : undefined,
          createdAt: msg.createdAt,
        })
      }
      continue
    }

    if (msg.role === 'assistant') {
      for (const block of msg.content) {
        if (block.type === 'text') {
          items.push({
            type: 'agent-text',
            messageId: msg.id,
            text: block.text as string,
            model: msg.model,
            createdAt: msg.createdAt,
          })
        } else if (block.type === 'tool_use') {
          const toolName = block.name as string
          const toolId = block.id as string
          const toolInput = (block.input as Record<string, unknown>) ?? {}
          const result = toolResults.get(toolId)

          if (toolName === 'spawn_agent') {
            // Try multiple sources for agentId:
            // 1. Parse from tool result JSON (may be artifactized to non-JSON)
            // 2. Look in trace spans for spawn_agent tool span metadata
            // 3. Fall back to toolId
            const agentIdFromResult =
              (result?.content ? tryParseJsonField(result.content, 'agent_id') : null) ??
              (result?.content ? tryParseJsonField(result.content, 'agentId') : null)
            const agentIdFromTrace = findAgentIdFromTraceSpan(traces, toolId)
            const agentId =
              agentIdFromResult ??
              agentIdFromTrace ??
              (toolInput.agent_id as string | undefined) ??
              (toolInput.agentId as string | undefined) ??
              toolId

            const labelFromResult = result?.content
              ? tryParseJsonField(result.content, 'label')
              : null
            const labelFromTrace = findLabelFromTraceSpan(traces, toolId)
            const label =
              (toolInput.label as string | undefined) ??
              labelFromResult ??
              labelFromTrace ??
              (toolInput.name as string | undefined) ??
              agentId
            const role = toolInput.role as string | undefined
            const instruction = (toolInput.instruction as string | undefined) ?? ''

            const waitInfo = findWaitAgentResult(messages, agentId, toolResults)
            const traceInfo = getSubAgentTraceInfo(traces, agentId, toolId)
            const childToolCalls = extractSubAgentChildToolCalls(traces, agentId, toolId)

            handledSubAgentIds.add(agentId)
            spawnToolCallIds.add(toolId)

            // Prefer trace-based duration (actual agent runtime) over wait_agent or tool span duration
            const resolvedDurationMs = traceInfo?.durationMs ?? waitInfo?.durationMs
            const resolvedStatus = (() => {
              if (waitInfo?.status === 'waiting') return 'waiting' as const
              if (traceInfo?.status && traceInfo.status !== 'running') return traceInfo.status
              if (waitInfo?.status) return waitInfo.status
              if (traceInfo?.status) return traceInfo.status
              return result?.isError ? ('errored' as const) : ('running' as const)
            })()
            const resolvedOutput = waitInfo?.output ?? traceInfo?.output

            items.push({
              type: 'sub-agent',
              agentId,
              label,
              role,
              instruction,
              status: resolvedStatus,
              output: resolvedOutput,
              durationMs: resolvedDurationMs,
              spawnToolCallId: toolId,
              childToolCalls,
              createdAt: msg.createdAt,
            })
          } else if (
            (toolName === 'wait_agent' ||
              toolName === 'close_agent' ||
              toolName === 'send_input') &&
            isHandledSubAgentTool(toolInput, handledSubAgentIds)
          ) {
            // Skip — already represented by the sub-agent block
          } else {
            items.push({
              type: 'tool-call',
              id: toolId,
              name: toolName,
              input: toolInput,
              result: result?.content,
              isError: result?.isError,
              durationMs: toolDurations.get(toolId),
              createdAt: msg.createdAt,
            })
          }
        }
      }
    }
  }

  items.push(...buildDecisionEvents(decisions))
  items.push(...buildTaskClosureEvents(traces, taskClosureEvents))
  return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

function buildTaskClosureEvents(
  traces: TraceSpan[],
  taskClosureEvents: SessionTaskClosureEvent[],
): TimelineItem[] {
  const flattenedTraces = flattenTraceSpans(traces)
  const traceItems = flattenedTraces
    .flatMap((span) => {
      if (span.name === 'task_closure_decision') {
        return [mapTaskClosureDecision(span)]
      }
      if (span.name === 'task_closure_failed') {
        return [mapTaskClosureFailed(span)]
      }
      return []
    })
    .filter((item): item is TaskClosureTimelineItem => item !== null)

  const sessionItems = filterDuplicateTaskClosureEvents(flattenedTraces, taskClosureEvents).map(
    (event, index) => mapSessionTaskClosureEvent(event, index),
  )
  return [...traceItems, ...sessionItems]
}

function buildDecisionEvents(decisions: SessionDecisionEvent[]): DecisionTimelineItem[] {
  return filterDisplayableDecisions(decisions).map((decision) => ({
    type: 'decision',
    id: decision.id,
    decisionType: decision.decisionType,
    outcome: decision.outcome,
    context: decision.context,
    detail: decision.detail,
    rationale: decision.rationale,
    durationMs: decision.durationMs,
    sourceKind: decision.sourceKind,
    createdAt: decision.ts,
  }))
}

export function filterDisplayableDecisions(
  decisions: SessionDecisionEvent[],
): SessionDecisionEvent[] {
  return decisions.filter((decision) => decision.decisionType !== 'task_closure')
}

export function filterDuplicateTaskClosureEvents(
  traces: TraceSpan[],
  taskClosureEvents: SessionTaskClosureEvent[],
): SessionTaskClosureEvent[] {
  const traceKeys = new Set(
    traces.map(getTaskClosureTraceKey).filter((key): key is string => key !== null),
  )

  return taskClosureEvents.filter((event) => {
    const eventKey = getSessionTaskClosureEventKey(event)
    return eventKey === null || !traceKeys.has(eventKey)
  })
}

function mapSessionTaskClosureEvent(
  event: SessionTaskClosureEvent,
  index: number,
): TaskClosureTimelineItem {
  const createdAt = event.assistantMessageCreatedAt ?? event.ts

  return buildTaskClosureTimelineItem({
    id: `tc-sess-${index}`,
    event: event.event,
    action: event.action,
    reason: event.reason,
    failureStage: event.failureStage,
    classifierRequest: event.classifierRequest,
    classifierResponseRaw: event.classifierResponseRaw,
    assistantMessageId: event.assistantMessageId,
    assistantMessageCreatedAt: event.assistantMessageCreatedAt,
    error: event.error,
    createdAt,
  })
}

function mapTaskClosureDecision(span: TraceSpan): TaskClosureTimelineItem | null {
  const details = getTaskClosureTraceDetails(span)
  const createdAt = details.assistantMessageCreatedAt ?? span.endTime ?? span.startTime

  if (details.called === false) return null

  return buildTaskClosureTimelineItem({
    id: `tc-trace-${span.id}`,
    event: details.event ?? 'task_closure_decision',
    action: details.action,
    reason: details.reason ?? '',
    failureStage: details.failureStage,
    classifierRequest: details.classifierRequest,
    classifierResponseRaw: details.classifierResponseRaw,
    assistantMessageId: details.assistantMessageId,
    assistantMessageCreatedAt: details.assistantMessageCreatedAt,
    error: details.error,
    createdAt,
  })
}

function mapTaskClosureFailed(span: TraceSpan): TaskClosureTimelineItem {
  const details = getTaskClosureTraceDetails(span)
  return buildTaskClosureTimelineItem({
    id: `tc-trace-${span.id}`,
    event: details.event ?? 'task_closure_failed',
    action: details.action,
    reason: details.reason ?? 'task closure failed',
    failureStage: details.failureStage,
    classifierRequest: details.classifierRequest,
    classifierResponseRaw: details.classifierResponseRaw,
    assistantMessageId: details.assistantMessageId,
    assistantMessageCreatedAt: details.assistantMessageCreatedAt,
    error: details.error,
    createdAt: details.assistantMessageCreatedAt ?? span.endTime ?? span.startTime,
  })
}

function buildTaskClosureTimelineItem(
  item: Omit<TaskClosureTimelineItem, 'type'>,
): TaskClosureTimelineItem {
  return {
    type: 'task-closure',
    ...item,
  }
}

function extractToolDurations(traces: TraceSpan[]): Map<string, number> {
  const toolDurations = new Map<string, number>()

  for (const span of flattenTraceSpans(traces)) {
    if (!span.name.startsWith('tool:') || typeof span.durationMs !== 'number') continue
    const toolUseId =
      span.metadata && typeof span.metadata.toolUseId === 'string' ? span.metadata.toolUseId : null
    if (!toolUseId) continue
    toolDurations.set(toolUseId, span.durationMs)
  }

  return toolDurations
}

function getTaskClosureTraceKey(span: TraceSpan): string | null {
  const details = getTaskClosureTraceDetails(span)
  const assistantMessageId = details.assistantMessageId ?? ''

  if (span.name === 'task_closure_decision') {
    if (details.called === false) return null

    const action = details.action ?? 'unknown'
    const reason = details.reason ?? ''
    return `decision|${action}|${reason}|${assistantMessageId}`
  }

  if (span.name === 'task_closure_failed') {
    const reason = details.reason ?? 'task_closure_failed'
    const failureStage = details.failureStage ?? 'unknown'
    return `failed|${failureStage}|${reason}|${assistantMessageId}`
  }

  return null
}

function getSessionTaskClosureEventKey(event: SessionTaskClosureEvent): string | null {
  const assistantMessageId = event.assistantMessageId ?? ''

  if (event.event === 'task_closure_decision') {
    return `decision|${event.action ?? 'unknown'}|${event.reason ?? ''}|${assistantMessageId}`
  }

  if (event.event === 'task_closure_failed') {
    return `failed|${event.failureStage ?? 'unknown'}|${event.reason ?? ''}|${assistantMessageId}`
  }

  return null
}

export function extractFilesTouched(items: TimelineItem[]): string[] {
  const files = new Set<string>()
  for (const item of items) {
    if (item.type === 'tool-call') {
      const input = item.input
      if (input.file_path && typeof input.file_path === 'string') {
        files.add(input.file_path)
      }
    }
  }
  return Array.from(files)
}

export function getTaskClosureTraceDetails(span: TraceSpan): TaskClosureTraceDetails {
  const metadata = span.metadata ?? {}
  const closure = asRecord(asRecord(span.data)?.closure)
  const action = asAction(asString(closure?.action)) ?? asAction(asString(metadata.action))
  const reason = asString(closure?.reason) ?? asString(metadata.reason)

  return {
    event:
      asTaskClosureEvent(asString(closure?.event)) ??
      asTaskClosureEvent(
        span.name === 'task_closure_decision' || span.name === 'task_closure_failed'
          ? span.name
          : undefined,
      ),
    called:
      asBoolean(closure?.called) ??
      asBoolean(metadata.called) ??
      (action !== undefined || reason !== undefined ? true : undefined),
    action,
    reason,
    failureStage:
      asFailureStage(asString(closure?.failureStage)) ??
      asFailureStage(asString(metadata.failureStage)),
    classifierRequest: resolveClassifierRequest(
      closure?.classifierRequest,
      metadata.classifierRequest,
    ),
    classifierResponseRaw:
      asString(closure?.classifierResponseRaw) ?? asString(metadata.classifierResponseRaw),
    assistantMessageId:
      asString(closure?.assistantMessageId) ?? asString(metadata.assistantMessageId),
    assistantMessageCreatedAt:
      asString(closure?.assistantMessageCreatedAt) ?? asString(metadata.assistantMessageCreatedAt),
    error: asString(closure?.error) ?? asString(metadata.error),
  }
}

function resolveClassifierRequest(
  value: unknown,
  fallback: unknown,
): SessionTaskClosureEvent['classifierRequest'] | undefined {
  if (isClassifierRequest(value)) return value
  if (isClassifierRequest(fallback)) return fallback
  return undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asTaskClosureEvent(value: unknown): SessionTaskClosureEvent['event'] | undefined {
  return value === 'task_closure_decision' || value === 'task_closure_failed' ? value : undefined
}

function asAction(value: unknown): SessionTaskClosureEvent['action'] | undefined {
  return value === 'finish' || value === 'continue' || value === 'block' ? value : undefined
}

function asFailureStage(value: unknown): SessionTaskClosureEvent['failureStage'] | undefined {
  return value === 'parse_classifier_response' || value === 'request_classifier' ? value : undefined
}

function isClassifierRequest(
  value: unknown,
): value is SessionTaskClosureEvent['classifierRequest'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.prompt === 'string' && typeof candidate.maxTokens === 'number'
}

function tryParseJsonField(json: string, field: string): string | null {
  try {
    const parsed = JSON.parse(json)
    if (parsed && typeof parsed === 'object' && typeof parsed[field] === 'string') {
      return parsed[field]
    }
  } catch {
    // not valid JSON
  }
  return null
}

/**
 * Find agentId from trace spans by matching the spawn_agent tool call ID.
 * The spawn_agent tool span's metadata contains spawnedAgentId.
 * Alternatively, the sub_agent span's data contains spawnedByRequestId or agentId.
 */
function findAgentIdFromTraceSpan(traces: TraceSpan[], toolUseId: string): string | null {
  const allSpans = flattenTraceSpans(traces)

  // Strategy 1: Find spawn_agent tool span with matching toolUseId in metadata
  for (const span of allSpans) {
    const meta = span.metadata ?? {}
    if (
      span.name === 'tool:spawn_agent' &&
      meta.toolUseId === toolUseId &&
      typeof meta.spawnedAgentId === 'string'
    ) {
      return meta.spawnedAgentId
    }
  }

  // Strategy 2: Find sub_agent span that is a child of the spawn_agent tool span
  for (const span of allSpans) {
    if (span.name === 'tool:spawn_agent') {
      const meta = span.metadata ?? {}
      if (meta.toolUseId === toolUseId) {
        // Look at children for sub_agent span
        for (const child of span.children ?? []) {
          if (child.name.startsWith('sub_agent:')) {
            const childData = child.data ?? {}
            const childMeta = child.metadata ?? {}
            return (childData.agentId as string) ?? (childMeta.agentId as string) ?? child.id
          }
        }
      }
    }
  }

  return null
}

/**
 * Find label from trace spans by matching the spawn_agent tool call ID.
 */
function findLabelFromTraceSpan(traces: TraceSpan[], toolUseId: string): string | null {
  const allSpans = flattenTraceSpans(traces)

  for (const span of allSpans) {
    const meta = span.metadata ?? {}
    if (
      span.name === 'tool:spawn_agent' &&
      meta.toolUseId === toolUseId &&
      typeof meta.spawnedAgentLabel === 'string'
    ) {
      return meta.spawnedAgentLabel
    }
  }

  // Try extracting from sub_agent span name: "sub_agent:label"
  for (const span of allSpans) {
    if (span.name === 'tool:spawn_agent') {
      const meta = span.metadata ?? {}
      if (meta.toolUseId === toolUseId) {
        for (const child of span.children ?? []) {
          if (child.name.startsWith('sub_agent:')) {
            return child.name.replace('sub_agent:', '')
          }
        }
      }
    }
  }

  return null
}

function findWaitAgentResult(
  messages: Message[],
  agentId: string,
  toolResults: Map<string, { content: string; isError: boolean }>,
): { status: 'waiting' | 'completed' | 'errored' | 'closed'; output?: string; durationMs?: number } | null {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const block of msg.content) {
      if (block.type !== 'tool_use') continue
      const name = block.name as string
      if (name !== 'wait_agent' && name !== 'close_agent') continue
      const input = (block.input as Record<string, unknown>) ?? {}
      const targetId =
        (input.agentId as string | undefined) ?? (input.agent_id as string | undefined)
      const ids = Array.isArray(input.ids) ? (input.ids as string[]) : undefined
      const isMatch = targetId === agentId || ids?.includes(agentId)
      if (!isMatch) continue
      const result = toolResults.get(block.id as string)
      if (!result) continue

      let status: 'waiting' | 'completed' | 'errored' | 'closed' =
        name === 'close_agent' ? 'closed' : 'completed'
      let output: string | undefined
      let durationMs: number | undefined

      try {
        const parsed = JSON.parse(result.content)
        if (parsed && typeof parsed === 'object') {
          const record = asRecord(parsed)
          const statuses = asRecord(record?.statuses)
          const agentRecord = asRecord(statuses?.[agentId]) ?? record
          const state = asString(agentRecord?.state) ?? asString(agentRecord?.status)
          if (state === 'waiting') status = 'waiting'
          else if (state === 'errored' || state === 'error' || state === 'failed')
            status = 'errored'
          else if (state === 'closed') status = 'closed'
          else if (state === 'completed') status = 'completed'

          output =
            typeof agentRecord?.output === 'string'
              ? agentRecord.output
              : typeof agentRecord?.result === 'string'
                ? agentRecord.result
                : undefined
          if (typeof agentRecord?.durationMs === 'number') durationMs = agentRecord.durationMs
          if (typeof agentRecord?.elapsedMs === 'number') durationMs = agentRecord.elapsedMs
        }
      } catch {
        output = result.content
      }

      if (result.isError) status = 'errored'
      return { status, output, durationMs }
    }
  }
  return null
}

/**
 * Find the sub_agent span associated with a spawn_agent call.
 * Strategy 1: match by agentId in sub_agent span data/metadata
 * Strategy 2: find tool:spawn_agent span by toolUseId, then take its sub_agent child
 */
function findSubAgentSpan(
  traces: TraceSpan[],
  agentId: string,
  spawnToolCallId?: string,
): TraceSpan | null {
  const allSpans = flattenTraceSpans(traces)

  // Strategy 1: match by agentId
  for (const span of allSpans) {
    const metadata = span.metadata ?? {}
    const data = span.data ?? {}
    const isSubAgent =
      span.name === 'sub_agent' ||
      span.name.startsWith('sub_agent:') ||
      metadata.kind === 'sub_agent' ||
      data.kind === 'sub_agent'
    if (isSubAgent && (metadata.agentId === agentId || data.agentId === agentId)) {
      return span
    }
  }

  // Strategy 2: find via spawn_agent tool span → child sub_agent span
  if (spawnToolCallId) {
    for (const span of allSpans) {
      const meta = span.metadata ?? {}
      if (span.name === 'tool:spawn_agent' && meta.toolUseId === spawnToolCallId) {
        for (const child of span.children ?? []) {
          if (
            child.name === 'sub_agent' ||
            child.name.startsWith('sub_agent:') ||
            child.data?.kind === 'sub_agent'
          ) {
            return child
          }
        }
      }
    }
  }

  return null
}

function extractSubAgentChildToolCalls(
  traces: TraceSpan[],
  agentId: string,
  spawnToolCallId?: string,
): SubAgentChildToolCall[] {
  const agentSpan = findSubAgentSpan(traces, agentId, spawnToolCallId)
  if (!agentSpan) return []

  const childCalls: SubAgentChildToolCall[] = []
  for (const child of flattenTraceSpans(agentSpan.children ?? [])) {
    if (!child.name.startsWith('tool:')) continue
    const meta = child.metadata ?? {}
    const data = child.data ?? {}
    childCalls.push({
      id: (meta.toolUseId as string) ?? child.id,
      name: child.name.replace('tool:', ''),
      input: (meta.input as Record<string, unknown>) ?? {},
      result:
        (meta.result as string) ??
        (meta.outputSummary as string) ??
        (data.outputSummary as string) ??
        undefined,
      isError: child.status === 'error' ? true : undefined,
      durationMs: child.durationMs,
    })
  }
  return childCalls
}

/**
 * Extract the real duration and status from the sub_agent trace span.
 * This is the actual agent execution time, not just the spawn call time.
 */
function getSubAgentTraceInfo(
  traces: TraceSpan[],
  agentId: string,
  spawnToolCallId?: string,
): {
  durationMs?: number
  status?: 'completed' | 'errored' | 'running' | 'closed'
  output?: string
} | null {
  const span = findSubAgentSpan(traces, agentId, spawnToolCallId)
  if (!span) return null

  const data = span.data ?? {}
  const status =
    span.status === 'success'
      ? ('completed' as const)
      : span.status === 'error'
        ? ('errored' as const)
        : ('running' as const)

  return {
    durationMs: (data.durationMs as number) ?? span.durationMs ?? undefined,
    status,
    output: (data.output as string) ?? (data.outputSummary as string) ?? undefined,
  }
}

function isHandledSubAgentTool(
  input: Record<string, unknown>,
  handledSubAgentIds: Set<string>,
): boolean {
  const targetId =
    (input.agentId as string | undefined) ??
    (input.agent_id as string | undefined) ??
    (input.id as string | undefined)
  if (targetId !== undefined && handledSubAgentIds.has(targetId)) return true

  if (Array.isArray(input.ids)) {
    return input.ids.some((id) => typeof id === 'string' && handledSubAgentIds.has(id))
  }

  return false
}
