import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  ImageBlock,
  StreamEvent,
  TokenUsage,
  ToolResultBlock,
} from '@zero-os/shared'
import OpenAI from 'openai'
import type { AdapterConfig, ProviderAdapter } from './base'
import { resolveImageBlock } from './image'

/**
 * OpenAI Chat Completions API adapter.
 * Supports GPT models, DeepSeek, and all OpenAI-compatible services.
 */
export class OpenAIChatAdapter implements ProviderAdapter {
  readonly apiType = 'openai_chat_completions'
  private client: OpenAI
  private modelId: string
  private extraBody?: Record<string, unknown>

  constructor(config: AdapterConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey ?? 'dummy',
      baseURL: config.baseUrl.endsWith('/v1') ? config.baseUrl : `${config.baseUrl}/v1`,
    })
    this.modelId = config.modelConfig.modelId
    this.extraBody = config.modelConfig.extraBody
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const messages = convertOpenAIChatMessages(req)
    const tools = convertOpenAIChatTools(req.tools)

    const response = await this.client.chat.completions.create({
      ...this.extraBody,
      model: req.model ?? this.modelId,
      messages,
      tools,
      ...(req.reasoningEffort
        ? {
            reasoning_effort:
              req.reasoningEffort as OpenAI.Chat.Completions.ChatCompletionReasoningEffort,
          }
        : {}),
      max_tokens: req.maxTokens,
      stream: false,
    })

    const choice = response.choices[0]
    const content = parseOpenAIChatContent(choice)

    // Some APIs return finish_reason 'stop' even when tool_calls are present.
    // Detect tool_use blocks and correct the stopReason.
    const hasToolUse = content.some((b) => b.type === 'tool_use')
    const stopReason = hasToolUse ? 'tool_use' : mapOpenAIChatStopReason(choice.finish_reason)

    return {
      id: response.id,
      content,
      stopReason,
      usage: parseOpenAIChatUsage(response.usage),
      model: response.model,
    }
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const messages = convertOpenAIChatMessages(req)
    const tools = convertOpenAIChatTools(req.tools)

    const stream = await this.client.chat.completions.create({
      ...this.extraBody,
      model: req.model ?? this.modelId,
      messages,
      tools,
      ...(req.reasoningEffort
        ? {
            reasoning_effort:
              req.reasoningEffort as OpenAI.Chat.Completions.ChatCompletionReasoningEffort,
          }
        : {}),
      max_tokens: req.maxTokens,
      stream: true,
    })

    let currentToolCall: { id: string; name: string; arguments: string } | null = null
    let hadToolCalls = false

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta
      if (!delta) continue

      // Text delta
      if (delta.content) {
        yield { type: 'text_delta', data: { text: delta.content } }
      }

      // Tool call handling
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.id) {
            const isNewToolCall = !currentToolCall || currentToolCall.id !== tc.id
            if (isNewToolCall && currentToolCall) {
              yield { type: 'tool_use_end', data: { id: currentToolCall.id } }
            }
            if (isNewToolCall) {
              hadToolCalls = true
              currentToolCall = { id: tc.id, name: tc.function?.name ?? '', arguments: '' }
              yield {
                type: 'tool_use_start',
                data: { id: tc.id, name: tc.function?.name ?? '' },
              }
            } else if (tc.function?.name && currentToolCall && !currentToolCall.name) {
              currentToolCall.name = tc.function.name
            }
          }
          if (tc.function?.arguments) {
            if (currentToolCall) {
              currentToolCall.arguments += tc.function.arguments
            }
            yield {
              type: 'tool_use_delta',
              data: { arguments: tc.function.arguments },
            }
          }
        }
      }

      // Check if done
      if (chunk.choices[0]?.finish_reason) {
        if (currentToolCall) {
          yield { type: 'tool_use_end', data: { id: currentToolCall.id } }
        }
        // Correct finish_reason if tool calls were seen but API said 'stop'
        const finishReason =
          hadToolCalls && chunk.choices[0].finish_reason === 'stop'
            ? 'tool_calls'
            : chunk.choices[0].finish_reason
        yield {
          type: 'done',
          data: {
            finishReason,
            model: chunk.model,
            usage: chunk.usage ? parseOpenAIChatUsage(chunk.usage) : undefined,
          },
        }
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.chat.completions.create({
        ...this.extraBody,
        model: this.modelId,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
      })
      return response.choices.length > 0
    } catch {
      return false
    }
  }
}

export function convertOpenAIChatMessages(
  req: CompletionRequest,
): OpenAI.ChatCompletionMessageParam[] {
  const messages: OpenAI.ChatCompletionMessageParam[] = []
  const pairedCallIds = collectPairedToolCallIds(req)

  if (req.system) {
    messages.push({ role: 'system', content: req.system })
  }

  for (const msg of req.messages) {
    if (msg.role === 'user') {
      const textParts = msg.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      const imageParts = msg.content.filter(isImageBlock)
      const toolResults = msg.content.filter(isToolResultBlock)

      for (const result of toolResults) {
        if (!pairedCallIds.has(result.toolUseId)) continue
        messages.push({
          role: 'tool',
          tool_call_id: result.toolUseId,
          content: normalizeOpenAIChatToolOutput(result.content, result.outputSummary),
        })
      }

      const toolImageParts = toolResults
        .filter((result) => pairedCallIds.has(result.toolUseId))
        .flatMap(toolResultImages)
      const resolvedImages = [...imageParts, ...toolImageParts].flatMap((image) => {
        const resolved = resolveImageBlock(image)
        return resolved ? [resolved] : []
      })

      if (textParts || resolvedImages.length > 0) {
        if (resolvedImages.length > 0) {
          const parts: OpenAI.ChatCompletionContentPart[] = []
          if (textParts) parts.push({ type: 'text', text: textParts })
          for (const image of resolvedImages) {
            parts.push({
              type: 'image_url',
              image_url: { url: `data:${image.mediaType};base64,${image.data}` },
            })
          }
          messages.push({ role: 'user', content: parts })
        } else {
          messages.push({ role: 'user', content: textParts })
        }
      }
    } else if (msg.role === 'assistant') {
      const textParts = msg.content.filter((block) => block.type === 'text')
      const toolUses = msg.content
        .filter((block) => block.type === 'tool_use')
        .filter((block) => pairedCallIds.has(block.id))

      if (toolUses.length > 0) {
        messages.push({
          role: 'assistant',
          content: textParts.map((block) => block.text).join('') || null,
          tool_calls: toolUses.map((toolUse) => ({
            id: toolUse.id,
            type: 'function',
            function: { name: toolUse.name, arguments: JSON.stringify(toolUse.input) },
          })),
        })
      } else {
        messages.push({
          role: 'assistant',
          content: textParts.map((block) => block.text).join('\n'),
        })
      }
    }
  }

  return messages
}

export function convertOpenAIChatTools(
  tools: CompletionRequest['tools'],
): OpenAI.ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  }))
}

export function parseOpenAIChatContent(choice: OpenAI.ChatCompletion.Choice): ContentBlock[] {
  const blocks: ContentBlock[] = []

  if (choice.message.content) {
    blocks.push({ type: 'text', text: choice.message.content })
  }

  if (choice.message.tool_calls) {
    for (const toolCall of choice.message.tool_calls) {
      blocks.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input: JSON.parse(toolCall.function.arguments || '{}'),
      })
    }
  }

  return blocks
}

export function mapOpenAIChatStopReason(reason: string | null): CompletionResponse['stopReason'] {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    default:
      return 'end_turn'
  }
}

export function parseOpenAIChatUsage(
  usage?: OpenAI.CompletionUsage | Record<string, unknown> | null,
): TokenUsage {
  const raw = usage as Record<string, unknown> | undefined | null
  const details = raw?.prompt_tokens_details as Record<string, number> | undefined
  const cacheWrite = details?.cache_creation_input_tokens
  const cacheRead = details?.cached_tokens
  const totalInput = typeof raw?.prompt_tokens === 'number' ? raw.prompt_tokens : 0
  const output = typeof raw?.completion_tokens === 'number' ? raw.completion_tokens : 0
  return {
    input: Math.max(totalInput - (cacheWrite ?? 0) - (cacheRead ?? 0), 0),
    output,
    cacheWrite,
    cacheRead,
    reasoning: (raw?.completion_tokens_details as Record<string, number> | undefined)
      ?.reasoning_tokens,
  }
}

function isImageBlock(block: ContentBlock): block is ImageBlock {
  return block.type === 'image'
}

function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result'
}

function toolResultImages(block: ToolResultBlock): ImageBlock[] {
  return (block.contentItems ?? []).filter((item): item is ImageBlock => item.type === 'image')
}

function collectPairedToolCallIds(req: CompletionRequest): Set<string> {
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()

  for (const msg of req.messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        toolUseIds.add(block.id)
      } else if (block.type === 'tool_result') {
        toolResultIds.add(block.toolUseId)
      }
    }
  }

  const paired = new Set<string>()
  for (const id of toolUseIds) {
    if (toolResultIds.has(id)) {
      paired.add(id)
    }
  }
  return paired
}

function normalizeOpenAIChatToolOutput(output: string, outputSummary?: string): string {
  if (output.trim().length > 0) return output
  if (outputSummary && outputSummary.trim().length > 0) return outputSummary
  return '[tool completed with empty output]'
}
