import type { ContentBlock, Message, SessionEvent } from '@zero-os/shared'
import type {
  RequestLogEntry,
  RequestMemoryInjectionEntry,
  RequestQueuedInjectionEntry,
  RequestToolResultEntry,
} from './observability-store'

/** 一份事件文件:主会话的 `session.jsonl`,或 `spawn_agent` 子代理的 `sub-<id>.jsonl` */
export interface SessionRequestSource {
  events: SessionEvent[]
  /** 子代理文件:请求的 agentName 取 header 的 name,turnIndex 恒为 1(trace 里子代理的请求也是这样记的) */
  subagent: boolean
}

/**
 * 从事件流算出请求列表,形状与 trace 的 `llm_request` span 算出的相同。
 *
 * 只取带 `cost` 的 `step/end`:这个字段和 `step/start.provider`、`reasoningContent`、排队消息摘要是同一版加进事件的,
 * 更早的请求在事件里缺这些,由调用方沿用 trace 算出的条目。没有等到响应的请求(没有 `step/end`)不产生条目。
 * `filter` 作用于展示用的文本(用户输入、回复、工具输入、注入),与 trace 写入时的密钥过滤一致。
 */
export function projectSessionRequestsFromEvents(
  sessionId: string,
  sources: SessionRequestSource[],
  filter: (text: string) => string,
): RequestLogEntry[] {
  return sources
    .flatMap((source) => projectSource(sessionId, source, filter))
    .sort((left, right) => left.ts.localeCompare(right.ts))
}

function projectSource(
  sessionId: string,
  { events, subagent }: SessionRequestSource,
  filter: (text: string) => string,
): RequestLogEntry[] {
  const header = events[0]?.type === 'session' ? events[0].data : undefined
  const requests: RequestLogEntry[] = []
  let turnIndex = 1
  let agentName = subagent ? header?.name : undefined
  let toolNames: string[] | undefined

  // 一次 loop 内的状态
  let userPrompt: string | undefined
  let parentId: string | undefined
  let toolResults: RequestToolResultEntry[] = []
  let queuedInjection: RequestQueuedInjectionEntry | undefined
  let memoryInjections: RequestMemoryInjectionEntry[] | undefined
  let drained: { count?: number; messages?: RequestQueuedInjectionEntry['messages'] } | undefined
  let step:
    | {
        stepIndex: number
        requestSpanId?: string
        model?: string
        provider?: string
        messageCount?: number
      }
    | undefined
  /** 最近一次 `step/end` 的条目,等它后面的 assistant 消息补上回复 */
  let awaiting: RequestLogEntry | undefined

  const onMessage = (message: Message) => {
    if (message.role === 'assistant') {
      if (!awaiting) return
      awaiting.response = filter(joinText(message.content, ''))
      awaiting.toolCalls = message.content.flatMap((block) =>
        block.type === 'tool_use'
          ? [
              {
                id: block.id,
                name: block.name,
                input: filterValue(block.input, filter) as Record<string, unknown>,
                evidence: block.evidence,
              },
            ]
          : [],
      )
      awaiting.toolUseCount = awaiting.toolCalls.length
      // 没有模型标签的调用方,请求的 model 取回复消息上的
      if (awaiting.model === 'unknown' && message.model) awaiting.model = message.model
      awaiting = undefined
      return
    }
    userPrompt ??= filter(joinText(message.content, ''))
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue
      toolResults.push({
        type: 'tool_result',
        toolUseId: block.toolUseId,
        content: block.content,
        isError: block.isError,
        outputSummary: block.outputSummary,
        evidence: block.evidence,
      })
    }
    if (message.messageType === 'notification')
      memoryInjections = [
        {
          layer: 'layer2',
          source: 'memory_hint',
          formattedText: filter(joinText(message.content, '\n')),
        },
      ]
    if (message.controlKind === 'queued_injection' && drained)
      queuedInjection = queued(drained, joinText(message.content, ''), filter)
  }

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        if (!subagent) {
          turnIndex = event.data.turnIndex
          agentName = event.data.agentName
        }
        break
      case 'tools/set':
        toolNames = event.data.toolNames
        break
      case 'loop/start':
        userPrompt = undefined
        parentId = undefined
        toolResults = []
        queuedInjection = undefined
        memoryInjections = undefined
        drained = undefined
        step = undefined
        awaiting = undefined
        break
      case 'user/message':
      case 'assistant/message':
      case 'request/message':
        onMessage(event.data.message)
        break
      case 'agent/inbox/drained':
        drained = event.data
        break
      case 'injection/context':
        if (event.data.kind === 'dynamic') {
          const memories = /<retrieved_memories>[\s\S]*?<\/retrieved_memories>/.exec(
            event.data.content,
          )?.[0]
          if (memories)
            memoryInjections = [
              {
                layer: 'layer1',
                source: 'retrieved_memories',
                formattedText: filter(
                  `<memory_inject layer="layer1">\n${memories}\n</memory_inject>`,
                ),
              },
            ]
        } else if (event.data.kind === 'queued_merge') {
          queuedInjection = queued(drained ?? {}, event.data.content, filter)
        }
        break
      case 'step/start':
        step = event.data
        awaiting = undefined
        break
      case 'step/end': {
        const { requestId, usage, cost } = event.data
        if (!step || step.stepIndex !== event.data.stepIndex) break
        if (requestId && usage && cost !== undefined) {
          awaiting = {
            id: requestId,
            traceSpanId: step.requestSpanId,
            turnIndex,
            parentId,
            sessionId,
            agentName,
            spawnedByRequestId: subagent ? header?.spawnedByRequestId : undefined,
            model: step.model ?? 'unknown',
            provider: step.provider ?? 'unknown',
            userPrompt: userPrompt ?? '',
            response: '',
            reasoningContent: event.data.reasoningContent,
            // `step/end` 把 max_tokens 记成 error;adapter 只会给出这三种
            stopReason:
              event.data.stopReason === 'tool_use'
                ? 'tool_use'
                : event.data.stopReason === 'error'
                  ? 'max_tokens'
                  : 'end_turn',
            toolUseCount: 0,
            toolCalls: [],
            toolResults,
            queuedInjection,
            memoryInjections,
            toolNames,
            messageCount: step.messageCount,
            tokens: {
              input: usage.input,
              output: usage.output,
              cacheWrite: usage.cacheWrite,
              cacheRead: usage.cacheRead,
              reasoning: usage.reasoning,
            },
            cost,
            durationMs: event.data.durationMs,
            ts: event.ts,
          }
          requests.push(awaiting)
        }
        parentId = event.data.stopReason === 'tool_use' ? requestId : undefined
        toolResults = []
        queuedInjection = undefined
        memoryInjections = undefined
        step = undefined
        break
      }
      default:
        break
    }
  }
  return requests
}

function queued(
  drained: { count?: number; messages?: RequestQueuedInjectionEntry['messages'] },
  formattedText: string,
  filter: (text: string) => string,
): RequestQueuedInjectionEntry {
  const messages = (drained.messages ?? []).map((message) => ({
    ...message,
    content: filter(message.content),
  }))
  return { count: drained.count ?? messages.length, formattedText: filter(formattedText), messages }
}

function joinText(content: ContentBlock[], separator: string): string {
  return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(separator)
}

function filterValue(value: unknown, filter: (text: string) => string): unknown {
  if (typeof value === 'string') return filter(value)
  if (Array.isArray(value)) return value.map((item) => filterValue(item, filter))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, filterValue(nested, filter)]),
    )
  return value
}
