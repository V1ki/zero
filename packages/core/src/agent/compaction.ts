import { type ProviderAdapter, computeCost } from '@zero-os/model'
import type { Tracer } from '@zero-os/observe'
import type {
  ContextCheckpoint,
  Message,
  ModelPricing,
  ReasoningEffort,
  SecretFilter,
  TokenUsage,
} from '@zero-os/shared'
import { generateId, now, toErrorMessage } from '@zero-os/shared'
import { estimateConversationTokens, extractRetainedHandles } from './context'
import { CONTEXT_PARAMS } from './params'

/**
 * 检查点式上下文压缩，见 docs/context-compaction.md。
 * 状态只有 canonical 消息和至多一个 ContextCheckpoint；发给模型的消息由 projectMessages 投影得到。
 */

const P = CONTEXT_PARAMS.compaction

export const CONTEXT_CHECKPOINT_PROMPT_VERSION = 'context_checkpoint_zh_md_v1'

const CHECKPOINT_PREAMBLE =
  '本会话较早的部分已从上下文中移除，下面是那部分的摘要。之后的消息接着摘要里的工作继续。'

const SUMMARY_SYSTEM_PROMPT = '你为 ZeRo OS 的 agent 整理会话检查点。只输出要求的 Markdown。'

const SUMMARY_INSTRUCTION = `<transcript> 是一段会话的早期记录。它会从 agent 的上下文中移除，由你写的摘要代替。之后接手的 agent 只看得到这份摘要和最近的几条消息，看不到原始记录，摘要要让它不回头翻记录也能把工作接着做下去。

如果给了 <previous_summary>，那是更早记录的摘要。把它和新记录合并成一份：仍然成立的保留，过时或被推翻的去掉，不要原样照抄。

按下面八个小节输出 Markdown，标题和顺序不变，小节不能省，没有内容的写「（无）」：

## 用户请求与意图
## 关键概念
## 文件与代码
## 错误与修复
## 未完成事项
## 当前工作
## 下一步
## 关键上下文

确切保留路径、命令、错误原文、标识符和数值；如实保留用户的纠正和明确指示。不要提及摘要或压缩这件事。`

export interface CompactionBudget {
  /** 压力达到该值时压缩 */
  thresholdTokens: number
  /** 原文保留尾部的预算 */
  retainTokens: number
}

export function computeCompactionBudget(maxContext: number, maxOutput: number): CompactionBudget {
  const usable = maxContext - maxOutput
  return {
    thresholdTokens: Math.floor(usable * P.thresholdRatio),
    retainTokens: Math.floor(usable * P.retainRatio),
  }
}

function clip(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars) return text
  const omitted = text.length - headChars - tailChars
  return `${text.slice(0, headChars)}\n…[省略 ${omitted} 字符]…\n${text.slice(-tailChars)}`
}

/** 检查点水位在 messages 中的下标（没有该水位为 -1）；水位指向的消息不存在时返回 undefined。 */
function locateCheckpoint(
  messages: Message[],
  checkpoint: ContextCheckpoint,
): { summarized: number; pruned: number } | undefined {
  const { summarizedThroughMessageId, prunedThroughMessageId } = checkpoint
  const summarized = messages.findIndex((message) => message.id === summarizedThroughMessageId)
  const pruned = messages.findIndex((message) => message.id === prunedThroughMessageId)
  if (summarizedThroughMessageId !== undefined && summarized < 0) return undefined
  if (prunedThroughMessageId !== undefined && pruned < 0) return undefined
  return { summarized, pruned }
}

export function isCheckpointValid(messages: Message[], checkpoint: ContextCheckpoint): boolean {
  return locateCheckpoint(messages, checkpoint) !== undefined
}

function pruneToolResults(message: Message): Message {
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type !== 'tool_result' || block.content.length <= P.prunedToolResultMaxChars) {
        return block
      }
      const kept = clip(block.content, P.prunedToolResultHeadChars, P.prunedToolResultTailChars)
      const handles: string[] = []
      let handleChars = 0
      for (const handle of extractRetainedHandles(block.content)) {
        if (kept.includes(handle)) continue
        if (
          handles.length >= P.retainedHandlesMaxCount ||
          handleChars + handle.length > P.retainedHandlesMaxChars
        ) {
          break
        }
        handles.push(handle)
        handleChars += handle.length + 2
      }
      const content = handles.length > 0 ? `${kept}\nretained_handles: ${handles.join(', ')}` : kept
      return { ...block, content }
    }),
  }
}

/**
 * 发给模型的消息：summary 取代被覆盖的前缀，裁剪水位之前的超大 tool_result 只留头尾，其余原样。
 * 纯函数；无效检查点按没有检查点处理。
 */
export function projectMessages(
  messages: Message[],
  checkpoint: ContextCheckpoint | undefined,
): Message[] {
  const at = checkpoint && locateCheckpoint(messages, checkpoint)
  if (!checkpoint || !at) return [...messages]

  const rest = messages
    .slice(at.summarized + 1)
    .map((message, offset) =>
      at.summarized + 1 + offset <= at.pruned ? pruneToolResults(message) : message,
    )
  if (at.summarized < 0) return rest

  const summaryMessage: Message = {
    id: checkpoint.id,
    sessionId: checkpoint.sessionId,
    role: 'user',
    messageType: 'message',
    content: [
      {
        type: 'text',
        text: `${CHECKPOINT_PREAMBLE}\n\n<context_checkpoint>\n${checkpoint.summary ?? ''}\n</context_checkpoint>`,
      },
    ],
    createdAt: checkpoint.createdAt,
  }
  return [summaryMessage, ...rest]
}

export interface CheckpointSummaryInput {
  sessionId: string
  /** 上一份检查点的摘要 */
  previousSummary?: string
  /** 新进入摘要范围的原始消息 */
  messages: Message[]
}

export interface CheckpointSummary {
  text: string
  model: NonNullable<ContextCheckpoint['model']>
  usage: TokenUsage
}

/** 失败（请求出错、超时、空文本）时抛出。 */
export type CheckpointSummarizer = (input: CheckpointSummaryInput) => Promise<CheckpointSummary>

export interface CompactContextInput {
  /** canonical 消息 */
  messages: Message[]
  checkpoint: ContextCheckpoint | undefined
  sessionId: string
  budget: CompactionBudget
  /** 系统提示词 + 工具定义的估算 token */
  fixedTokens: number
  summarize: CheckpointSummarizer
}

export type CompactContextResult =
  | { status: 'not_needed'; tokens: number }
  | { status: 'pruned'; checkpoint: ContextCheckpoint; tokensBefore: number; tokensAfter: number }
  | {
      status: 'summarized'
      checkpoint: ContextCheckpoint
      tokensBefore: number
      tokensAfter: number
      usage: TokenUsage
    }
  | {
      status: 'failed'
      /** 只带裁剪水位的推进；裁剪水位没有前进时不产生新检查点 */
      checkpoint?: ContextCheckpoint
      tokensBefore: number
      tokensAfter: number
      error: string
    }

/**
 * 压力达到阈值时：划定保留尾部 → 推进裁剪水位 → 仍超阈值则把尾部之前的内容滚动摘要。
 */
export async function compactContext(input: CompactContextInput): Promise<CompactContextResult> {
  const { messages, sessionId, budget, fixedTokens } = input
  const located = input.checkpoint && locateCheckpoint(messages, input.checkpoint)
  const previous = located ? input.checkpoint : undefined
  const { summarized, pruned } = located || { summarized: -1, pruned: -1 }
  const pressure = (checkpoint: ContextCheckpoint | undefined) =>
    fixedTokens + estimateConversationTokens(projectMessages(messages, checkpoint))

  const tokensBefore = pressure(previous)
  if (tokensBefore < budget.thresholdTokens) return { status: 'not_needed', tokens: tokensBefore }

  // 保留尾部：从最新消息往回累计到保留预算；尾部不能以 tool_result 开头，否则会和它的 tool_use 分开。
  let cut = messages.length
  let tailTokens = 0
  while (cut > 0) {
    const tokens = estimateConversationTokens([messages[cut - 1]])
    if (tailTokens + tokens > budget.retainTokens) break
    tailTokens += tokens
    cut--
  }
  while (cut < messages.length && messages[cut].content.some((b) => b.type === 'tool_result')) {
    cut++
  }
  const through = cut - 1
  if (through <= summarized) return { status: 'not_needed', tokens: tokensBefore }

  const prunedThrough = Math.max(pruned, through)
  const nextCheckpoint = (
    fields: Pick<
      ContextCheckpoint,
      'summarizedThroughMessageId' | 'summary' | 'coveredMessageCount' | 'model'
    >,
  ): ContextCheckpoint => {
    const checkpoint: ContextCheckpoint = {
      id: generateId(),
      sessionId,
      generation: (previous?.generation ?? 0) + 1,
      prunedThroughMessageId: messages[prunedThrough].id,
      ...fields,
      tokensBefore,
      tokensAfter: 0,
      createdAt: now(),
    }
    checkpoint.tokensAfter = pressure(checkpoint)
    return checkpoint
  }

  const prunedCheckpoint =
    prunedThrough > pruned
      ? nextCheckpoint({
          summarizedThroughMessageId: previous?.summarizedThroughMessageId,
          summary: previous?.summary,
          coveredMessageCount: previous?.coveredMessageCount ?? 0,
          model: previous?.model,
        })
      : undefined
  if (prunedCheckpoint && prunedCheckpoint.tokensAfter < budget.thresholdTokens) {
    return {
      status: 'pruned',
      checkpoint: prunedCheckpoint,
      tokensBefore,
      tokensAfter: prunedCheckpoint.tokensAfter,
    }
  }

  let summary: CheckpointSummary
  try {
    summary = await input.summarize({
      sessionId,
      previousSummary: previous?.summary,
      messages: messages.slice(summarized + 1, through + 1),
    })
  } catch (error) {
    return {
      status: 'failed',
      checkpoint: prunedCheckpoint,
      tokensBefore,
      tokensAfter: prunedCheckpoint?.tokensAfter ?? tokensBefore,
      error: toErrorMessage(error),
    }
  }

  const checkpoint = nextCheckpoint({
    summarizedThroughMessageId: messages[through].id,
    summary: summary.text,
    coveredMessageCount: through + 1,
    model: summary.model,
  })
  return {
    status: 'summarized',
    checkpoint,
    tokensBefore,
    tokensAfter: checkpoint.tokensAfter,
    usage: summary.usage,
  }
}

function renderMessage(message: Message): string {
  const parts = message.content.flatMap((block): string[] => {
    switch (block.type) {
      case 'text':
        return [block.text]
      case 'tool_use':
        return [
          `[tool_use ${block.name}] ${clip(
            JSON.stringify(block.input),
            P.transcriptToolInputHeadChars,
            P.transcriptToolInputTailChars,
          )}`,
        ]
      case 'tool_result': {
        const images = block.contentItems?.filter((item) => item.type === 'image').length ?? 0
        const label = `[tool_result${block.isError ? ' error' : ''}${images > 0 ? ` 含 ${images} 张图片` : ''}]`
        return [
          `${label}\n${clip(block.content, P.transcriptToolResultHeadChars, P.transcriptToolResultTailChars)}`,
        ]
      }
      case 'image':
        return ['[图片]']
      case 'thinking':
        return []
    }
  })
  return `[${message.role}]\n${parts.join('\n')}`
}

export interface CheckpointSummarizerOptions {
  adapter: ProviderAdapter
  /** 记入检查点和 trace 的模型名，缺省用响应里的 model */
  modelLabel?: string
  providerName?: string
  pricing?: ModelPricing
  reasoningEffort?: ReasoningEffort
  parentSessionId?: string
  agentName?: string
  parentSpanId?: string
  tracer?: Pick<Tracer, 'startSpan' | 'updateSpan' | 'endSpan'>
  secretFilter?: SecretFilter
}

/**
 * 摘要请求：转写稿超过上限时按顺序分段，每段的摘要作为下一段的 previous_summary。
 * 每段一次有界的非流式请求。
 */
export function createCheckpointSummarizer(
  options: CheckpointSummarizerOptions,
): CheckpointSummarizer {
  return async ({ sessionId, previousSummary, messages }) => {
    const chunks: string[] = []
    let current = ''
    for (const rendered of messages.map(renderMessage)) {
      if (current && current.length + rendered.length + 2 > P.transcriptMaxChars) {
        chunks.push(current)
        current = ''
      }
      current = current ? `${current}\n\n${rendered}` : rendered
    }
    chunks.push(current)

    const span = options.tracer?.startSpan(sessionId, 'context_checkpoint', options.parentSpanId, {
      kind: 'context_compaction',
      agentName: options.agentName,
      metadata: {
        purpose: 'compression',
        promptVersion: CONTEXT_CHECKPOINT_PROMPT_VERSION,
        coveredMessageCount: messages.length,
        requestCount: chunks.length,
      },
    })
    const startedAt = Date.now()
    const usage: TokenUsage = { input: 0, output: 0 }
    let model = options.modelLabel
    let carried = previousSummary
    let text = ''

    try {
      for (const chunk of chunks) {
        const prompt = [
          SUMMARY_INSTRUCTION,
          carried === undefined ? undefined : `<previous_summary>\n${carried}\n</previous_summary>`,
          `<transcript>\n${chunk}\n</transcript>`,
        ]
          .filter((part) => part !== undefined)
          .join('\n\n')
        let timer: ReturnType<typeof setTimeout> | undefined
        const response = await Promise.race([
          options.adapter.complete({
            messages: [
              {
                id: generateId(),
                sessionId,
                role: 'user',
                messageType: 'message',
                content: [{ type: 'text', text: prompt }],
                createdAt: now(),
              },
            ],
            system: SUMMARY_SYSTEM_PROMPT,
            stream: false,
            maxTokens: P.summaryMaxTokens,
            reasoningEffort: options.reasoningEffort,
            meta: {
              sessionId,
              purpose: 'compression',
              ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
            },
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(`context checkpoint summary timed out after ${P.summaryTimeoutMs}ms`),
                ),
              P.summaryTimeoutMs,
            )
          }),
        ]).finally(() => clearTimeout(timer))

        usage.input += response.usage.input
        usage.output += response.usage.output
        usage.cacheRead = (usage.cacheRead ?? 0) + (response.usage.cacheRead ?? 0)
        usage.cacheWrite = (usage.cacheWrite ?? 0) + (response.usage.cacheWrite ?? 0)
        usage.reasoning = (usage.reasoning ?? 0) + (response.usage.reasoning ?? 0)
        model ??= response.model
        text = response.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n')
          .trim()
        if (!text) throw new Error('context checkpoint summary returned empty text')
        carried = text
      }
    } catch (error) {
      if (span) {
        options.tracer?.endSpan(span.id, 'error', {
          error: toErrorMessage(error),
          durationMs: Date.now() - startedAt,
          usage,
          cost: computeCost(usage, options.pricing),
        })
      }
      throw error
    }

    const filtered = options.secretFilter ? options.secretFilter.filter(text) : text
    const result: CheckpointSummary = {
      text: filtered,
      model: {
        model: model ?? 'unknown',
        provider: options.providerName ?? 'unknown',
        promptVersion: CONTEXT_CHECKPOINT_PROMPT_VERSION,
      },
      usage,
    }
    if (span) {
      const durationMs = Date.now() - startedAt
      options.tracer?.updateSpan(span.id, {
        data: {
          compaction: {
            ...result.model,
            coveredMessageCount: messages.length,
            requestCount: chunks.length,
            summaryChars: filtered.length,
            usage,
            cost: computeCost(usage, options.pricing),
            durationMs,
          },
        },
      })
      options.tracer?.endSpan(span.id, 'success', { durationMs })
    }
    return result
  }
}
