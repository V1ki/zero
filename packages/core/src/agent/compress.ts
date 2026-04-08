import { computeCost, type ProviderAdapter } from '@zero-os/model'
import type { Tracer } from '@zero-os/observe'
import type {
  CompressionResult,
  Message,
  ModelPricing,
  SecretFilter,
} from '@zero-os/shared'
import { estimateMessageTokens, generateId, now } from '@zero-os/shared'
import { CONTEXT_PARAMS } from './params'

interface CompressionTraceOptions {
  tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan' | 'getSpan'>
  parentSpanId?: string
  agentName?: string
  providerName?: string
  modelLabel?: string
  pricing?: ModelPricing
  secretFilter?: SecretFilter
}

/**
 * Compress conversation history when it exceeds the budget.
 * Splits into "to summarize" and "retained" sections.
 * Uses an LLM call to generate a summary of the old messages.
 */
export async function compressConversation(
  messages: Message[],
  conversationBudget: number,
  adapter: ProviderAdapter,
  sessionId: string,
  meta?: { parentSessionId?: string },
  trace?: CompressionTraceOptions,
): Promise<CompressionResult> {
  const tokensBefore = messages.reduce((sum, m) => sum + estimateMessageTokens(m.content) + 4, 0)

  // Find split point: retained section gets 70% of budget
  const retainBudget = Math.floor(conversationBudget * CONTEXT_PARAMS.compression.retainRatio)
  let retainedTokens = 0
  let splitIndex = messages.length

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(messages[i].content) + 4
    if (retainedTokens + msgTokens > retainBudget) break
    retainedTokens += msgTokens
    splitIndex = i
  }

  // Ensure minimum recent turns are retained
  const minRetainMessages = CONTEXT_PARAMS.compression.minRetainTurns * 2
  const minRetain = Math.max(0, messages.length - minRetainMessages)
  splitIndex = Math.min(splitIndex, minRetain)

  // Guard: never split between an assistant tool_use and its user tool_result.
  // Walk the split point forward until we're not inside a tool_use → tool_result pair.
  while (
    splitIndex > 0 &&
    splitIndex < messages.length &&
    messages[splitIndex - 1].role === 'assistant' &&
    messages[splitIndex - 1].content.some((b) => b.type === 'tool_use') &&
    messages[splitIndex].role === 'user' &&
    messages[splitIndex].content.some((b) => b.type === 'tool_result')
  ) {
    splitIndex--
  }

  // If nothing to compress, return as-is
  if (splitIndex <= 0) {
    return {
      summary: '',
      retainedMessages: [...messages],
      stats: {
        messagesBefore: messages.length,
        messagesAfter: messages.length,
        tokensBefore,
        tokensAfter: tokensBefore,
        compressedRange: undefined,
      },
    }
  }

  const toSummarize = messages.slice(0, splitIndex)
  const retained = messages.slice(splitIndex)

  // Generate summary via LLM
  const summaryResponse = await generateSummary(toSummarize, adapter, sessionId, meta, trace)
  const summary = summaryResponse.text

  // Create summary message
  const summaryMessage: Message = {
    id: generateId(),
    sessionId,
    role: 'user',
    messageType: 'message',
    content: [
      {
        type: 'text',
        text: `[以下是之前对话的摘要]\n\n${summary}\n\n[摘要结束，以下是最近的对话]`,
      },
    ],
    createdAt: now(),
  }

  const retainedMessages = [summaryMessage, ...retained]
  const tokensAfter = retainedMessages.reduce(
    (sum, m) => sum + estimateMessageTokens(m.content) + 4,
    0,
  )

  return {
    summary,
    retainedMessages,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: retainedMessages.length,
      tokensBefore,
      tokensAfter,
      compressedRange: `0..${splitIndex - 1}`,
    },
  }
}

async function generateSummary(
  messages: Message[],
  adapter: ProviderAdapter,
  sessionId: string,
  meta?: { parentSessionId?: string },
  trace?: CompressionTraceOptions,
): Promise<{ text: string; response: import('@zero-os/shared').CompletionResponse }> {
  const conversationText = messages
    .map((m) => {
      const role = m.role
      const textParts = m.content
        .map((b) => {
          if (b.type === 'text') return b.text
          if (b.type === 'tool_use') return `[调用工具: ${b.name}]`
          if (b.type === 'tool_result') return `[工具结果: ${b.content.slice(0, 200)}]`
          return ''
        })
        .filter(Boolean)
        .join('\n')
      return `${role}: ${textParts}`
    })
    .join('\n\n')

  const prompt = `<instruction>
将以下对话历史压缩为一段简洁的摘要。
摘要必须保留：
1. 用户的原始目标和意图
2. 已完成的关键操作及其结果
3. 当前的进展状态
4. 未解决的问题或待办事项
5. 重要的文件路径、变量名、错误信息等具体细节

摘要不需要保留：
- 工具调用的具体输入输出（保留结论即可）
- 寒暄和确认性对话
- 已被后续操作覆盖的中间状态

输出格式：纯文本，不超过 800 tokens。
</instruction>

<conversation>
${conversationText}
</conversation>`

  const traceSpanId = trace?.tracer?.startSpan(sessionId, 'compression', trace.parentSpanId, {
    kind: 'llm_request',
    agentName: trace.agentName,
    metadata: {
      purpose: 'compression',
    },
  })?.id
  const startTime = Date.now()

  try {
    const response = await adapter.complete({
      messages: [
        {
          id: generateId(),
          sessionId: 'compression',
          role: 'user',
          messageType: 'message',
          content: [{ type: 'text', text: prompt }],
          createdAt: now(),
        },
      ],
      system: '你是一个对话摘要助手。请将提供的对话历史压缩为简洁的摘要。',
      stream: false,
      maxTokens: 1024,
      meta: {
        sessionId: messages[0]?.sessionId ?? 'compression',
        purpose: 'compression',
        ...(meta?.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
      },
    })

    const responseText = response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('\n')
    const durationMs = Date.now() - startTime

    if (traceSpanId) {
      trace.tracer?.updateSpan(traceSpanId, {
        data: {
          compression: {
            model: trace.modelLabel ?? response.model,
            provider: trace.providerName ?? 'unknown',
            prompt: truncateText(sanitizeText(prompt, trace.secretFilter), 500),
            response: truncateText(sanitizeText(responseText, trace.secretFilter), 500),
            compressedMessageCount: messages.length,
            tokens: {
              input: response.usage.input,
              output: response.usage.output,
              cacheWrite: response.usage.cacheWrite,
              cacheRead: response.usage.cacheRead,
              reasoning: response.usage.reasoning,
            },
            cost: computeCost(response.usage, trace.pricing),
            durationMs,
          },
        },
        metadata: {
          compressedMessageCount: messages.length,
        },
      })
    }

    return {
      text: responseText,
      response,
    }
  } catch (error) {
    if (traceSpanId) {
      trace.tracer?.updateSpan(traceSpanId, {
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      })
      trace.tracer?.endSpan(traceSpanId, 'error')
    }
    throw error
  } finally {
    if (traceSpanId) {
      const current = trace.tracer?.getSpan?.(traceSpanId)
      if (current && !current.endTime) {
        trace.tracer?.endSpan(traceSpanId, 'success')
      }
    }
  }
}

function sanitizeText(text: string, secretFilter?: SecretFilter): string {
  return secretFilter ? secretFilter.filter(text) : text
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars - 3)}...`
}
