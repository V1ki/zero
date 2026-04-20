import type { TimelineItem, TraceSpan } from './timeline'

interface LlmRequestLike {
  durationMs?: number
}

export interface SessionDetailInsights {
  timelineCount: number
  userCount: number
  assistantCount: number
  toolCallCount: number
  decisionCount: number
  taskClosureCount: number
  systemEventCount: number
  subAgentCount: number
  runningTraceCount: number
  errorTraceCount: number
  successfulTraceCount: number
  dominantTool?: {
    name: string
    count: number
  }
  slowestTool?: {
    name: string
    durationMs: number
  }
  lastDecision?: {
    decisionType: string
    outcome: string
    createdAt: string
  }
  lastTaskClosure?: {
    event: string
    action?: string
    createdAt: string
  }
  averageRequestDurationMs?: number
}

export function buildSessionDetailInsights(
  items: TimelineItem[],
  traces: TraceSpan[],
  llmRequests: LlmRequestLike[] = [],
): SessionDetailInsights {
  const toolDistribution = new Map<string, number>()

  let userCount = 0
  let assistantCount = 0
  let toolCallCount = 0
  let decisionCount = 0
  let taskClosureCount = 0
  let systemEventCount = 0
  let subAgentCount = 0
  let slowestTool: SessionDetailInsights['slowestTool']
  let lastDecision: SessionDetailInsights['lastDecision']
  let lastTaskClosure: SessionDetailInsights['lastTaskClosure']

  for (const item of items) {
    switch (item.type) {
      case 'user-message':
        userCount += 1
        break
      case 'agent-text':
        assistantCount += 1
        break
      case 'tool-call':
        toolCallCount += 1
        toolDistribution.set(item.name, (toolDistribution.get(item.name) ?? 0) + 1)
        if (
          item.durationMs !== undefined &&
          (!slowestTool || item.durationMs > slowestTool.durationMs)
        ) {
          slowestTool = { name: item.name, durationMs: item.durationMs }
        }
        break
      case 'decision':
        decisionCount += 1
        lastDecision = {
          decisionType: item.decisionType,
          outcome: item.outcome,
          createdAt: item.createdAt,
        }
        break
      case 'task-closure':
        taskClosureCount += 1
        lastTaskClosure = {
          event: item.event,
          action: item.action,
          createdAt: item.createdAt,
        }
        break
      case 'memory-nudge':
        for (const toolCall of item.relatedToolCalls) {
          toolCallCount += 1
          toolDistribution.set(toolCall.name, (toolDistribution.get(toolCall.name) ?? 0) + 1)
          if (
            toolCall.durationMs !== undefined &&
            (!slowestTool || toolCall.durationMs > slowestTool.durationMs)
          ) {
            slowestTool = { name: toolCall.name, durationMs: toolCall.durationMs }
          }
        }
        break
      case 'system-event':
        systemEventCount += 1
        break
      case 'sub-agent':
        subAgentCount += 1
        break
    }
  }

  let dominantTool: SessionDetailInsights['dominantTool']
  for (const [name, count] of toolDistribution.entries()) {
    if (!dominantTool || count > dominantTool.count) {
      dominantTool = { name, count }
    }
  }

  let runningTraceCount = 0
  let errorTraceCount = 0
  let successfulTraceCount = 0

  for (const span of traces) {
    const counts = countTraceStatuses(span)
    runningTraceCount += counts.runningTraceCount
    errorTraceCount += counts.errorTraceCount
    successfulTraceCount += counts.successfulTraceCount
  }

  const requestDurations = llmRequests
    .map((request) => request.durationMs)
    .filter((durationMs): durationMs is number => typeof durationMs === 'number')

  return {
    timelineCount: items.length,
    userCount,
    assistantCount,
    toolCallCount,
    decisionCount,
    taskClosureCount,
    systemEventCount,
    subAgentCount,
    runningTraceCount,
    errorTraceCount,
    successfulTraceCount,
    dominantTool,
    slowestTool,
    lastDecision,
    lastTaskClosure,
    averageRequestDurationMs:
      requestDurations.length > 0
        ? Math.round(
            requestDurations.reduce((sum, durationMs) => sum + durationMs, 0) /
              requestDurations.length,
          )
        : undefined,
  }
}

function countTraceStatuses(span: TraceSpan): Pick<
  SessionDetailInsights,
  'runningTraceCount' | 'errorTraceCount' | 'successfulTraceCount'
> {
  let runningTraceCount = span.status === 'running' ? 1 : 0
  let errorTraceCount = span.status === 'error' ? 1 : 0
  let successfulTraceCount = span.status === 'success' ? 1 : 0

  for (const child of span.children) {
    const childCounts = countTraceStatuses(child)
    runningTraceCount += childCounts.runningTraceCount
    errorTraceCount += childCounts.errorTraceCount
    successfulTraceCount += childCounts.successfulTraceCount
  }

  return {
    runningTraceCount,
    errorTraceCount,
    successfulTraceCount,
  }
}
