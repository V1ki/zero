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

function isImageBlock(block: ContentBlock): block is ImageBlock {
  return block.type === 'image'
}

function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result'
}

function toolResultImages(block: ToolResultBlock): ImageBlock[] {
  return (block.contentItems ?? []).filter((item): item is ImageBlock => item.type === 'image')
}

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
    const messages = this.convertMessages(req)
    const tools = req.tools ? this.convertTools(req.tools) : undefined

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
    const content = this.parseResponseContent(choice)

    // Some APIs return finish_reason 'stop' even when tool_calls are present.
    // Detect tool_use blocks and correct the stopReason.
    const hasToolUse = content.some((b) => b.type === 'tool_use')
    const stopReason = hasToolUse ? 'tool_use' : this.mapStopReason(choice.finish_reason)

    return {
      id: response.id,
      content,
      stopReason,
      usage: this.parseUsage(response.usage),
      model: response.model,
    }
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const messages = this.convertMessages(req)
    const tools = req.tools ? this.convertTools(req.tools) : undefined

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
            usage: chunk.usage ? this.parseUsage(chunk.usage) : undefined,
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

  private convertMessages(req: CompletionRequest): OpenAI.ChatCompletionMessageParam[] {
    const messages: OpenAI.ChatCompletionMessageParam[] = []
    const pairedCallIds = this.collectPairedToolCallIds(req)

    if (req.system) {
      messages.push({ role: 'system', content: req.system })
    }

    for (const msg of req.messages) {
      if (msg.role === 'user') {
        const textParts = msg.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('\n')
        const imageParts = msg.content.filter(isImageBlock)
        const toolResults = msg.content.filter(isToolResultBlock)

        for (const result of toolResults) {
          if (!pairedCallIds.has(result.toolUseId)) continue
          messages.push({
            role: 'tool',
            tool_call_id: result.toolUseId,
            content: this.normalizeToolOutput(result.content, result.outputSummary),
          })
        }

        const toolImageParts = toolResults
          .filter((result) => pairedCallIds.has(result.toolUseId))
          .flatMap(toolResultImages)
        const allImageParts = [...imageParts, ...toolImageParts]

        if (textParts || allImageParts.length > 0) {
          if (allImageParts.length > 0) {
            // Multimodal: text + images
            const parts: OpenAI.ChatCompletionContentPart[] = []
            if (textParts) parts.push({ type: 'text', text: textParts })
            for (const img of allImageParts) {
              const { mediaType, data } = img
              parts.push({
                type: 'image_url',
                image_url: { url: `data:${mediaType};base64,${data}` },
              })
            }
            messages.push({ role: 'user', content: parts })
          } else {
            messages.push({ role: 'user', content: textParts })
          }
        }
      } else if (msg.role === 'assistant') {
        const textParts = msg.content.filter((b) => b.type === 'text')
        const toolUses = msg.content
          .filter((b) => b.type === 'tool_use')
          .filter((b) => pairedCallIds.has((b as { id: string }).id))

        if (toolUses.length > 0) {
          messages.push({
            role: 'assistant',
            content: textParts.map((b) => (b as { text: string }).text).join('') || null,
            tool_calls: toolUses.map((b) => {
              const tu = b as { id: string; name: string; input: Record<string, unknown> }
              return {
                id: tu.id,
                type: 'function' as const,
                function: { name: tu.name, arguments: JSON.stringify(tu.input) },
              }
            }),
          })
        } else {
          messages.push({
            role: 'assistant',
            content: textParts.map((b) => (b as { text: string }).text).join('\n'),
          })
        }
      }
    }

    return messages
  }

  private convertTools(tools: CompletionRequest['tools']): OpenAI.ChatCompletionTool[] | undefined {
    if (!tools || tools.length === 0) return undefined
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      },
    }))
  }

  private parseResponseContent(choice: OpenAI.ChatCompletion.Choice): ContentBlock[] {
    const blocks: ContentBlock[] = []

    if (choice.message.content) {
      blocks.push({ type: 'text', text: choice.message.content })
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}'),
        })
      }
    }

    return blocks
  }

  private mapStopReason(reason: string | null): CompletionResponse['stopReason'] {
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

  /**
   * Keep only tool calls that have a matching tool result in history.
   * This prevents replaying dangling function calls after interrupted turns.
   */
  private collectPairedToolCallIds(req: CompletionRequest): Set<string> {
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

  /**
   * OpenAI Chat Completions rejects empty tool content.
   */
  private normalizeToolOutput(output: string, outputSummary?: string): string {
    if (output.trim().length > 0) return output
    if (outputSummary && outputSummary.trim().length > 0) return outputSummary
    return '[tool completed with empty output]'
  }

  private parseUsage(usage?: OpenAI.CompletionUsage | null): TokenUsage {
    const raw = usage as Record<string, unknown> | undefined | null
    const details = raw?.prompt_tokens_details as Record<string, number> | undefined
    const cacheWrite = details?.cache_creation_input_tokens
    const cacheRead = details?.cached_tokens
    const totalInput = usage?.prompt_tokens ?? 0
    return {
      // OpenAI reports cached token details as a subset of prompt_tokens.
      // Normalize to the same bucket semantics used elsewhere:
      // input = non-cached tail, cacheWrite = newly cached prefix, cacheRead = reused prefix.
      input: Math.max(totalInput - (cacheWrite ?? 0) - (cacheRead ?? 0), 0),
      output: usage?.completion_tokens ?? 0,
      cacheWrite,
      cacheRead,
      reasoning: (raw?.completion_tokens_details as Record<string, number> | undefined)
        ?.reasoning_tokens,
    }
  }
}
