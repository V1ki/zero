import type { CompletionRequest, ContentBlock, ImageBlock, ToolResultBlock } from '@zero-os/shared'
import type OpenAI from 'openai'
import { resolveImageBlock } from './image'

function isImageBlock(block: ContentBlock): block is ImageBlock {
  return block.type === 'image'
}

function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result'
}

function toolResultImages(block: ToolResultBlock): ImageBlock[] {
  return (block.contentItems ?? []).filter((item): item is ImageBlock => item.type === 'image')
}

export function splitToolCallId(id: string): { callId: string; itemId: string | undefined } {
  if (id.includes('|')) {
    const [callId, itemId] = id.split('|', 2)
    return { callId, itemId: itemId || undefined }
  }
  return { callId: id, itemId: undefined }
}

export function joinToolCallId(callId: string, itemId?: string): string {
  return itemId ? `${callId}|${itemId}` : callId
}

export function buildOpenAIResponsesInput(
  req: CompletionRequest,
): OpenAI.Responses.ResponseInputItem[] {
  const input: OpenAI.Responses.ResponseInputItem[] = []
  const pairedCallIds = collectPairedToolCallIds(req)

  if (req.system) {
    input.push({
      role: 'system',
      content: req.system,
    })
  }

  for (const msg of req.messages) {
    if (msg.role === 'user') {
      const textParts = msg.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { text: string }).text)
        .join('\n')
      const imageParts = msg.content.filter(isImageBlock)

      const toolResults = msg.content.filter(isToolResultBlock)
      if (toolResults.length > 0) {
        for (const result of toolResults) {
          if (!pairedCallIds.has(result.toolUseId)) continue
          const { callId: outputCallId } = splitToolCallId(result.toolUseId)
          input.push({
            type: 'function_call_output',
            call_id: outputCallId,
            output: normalizeToolOutput(result.content, result.outputSummary),
          })
        }
      }

      const toolImageParts = toolResults
        .filter((result) => pairedCallIds.has(result.toolUseId))
        .flatMap(toolResultImages)
      const allImageParts = [...imageParts, ...toolImageParts]
      const resolvedImages = allImageParts.flatMap((image) => {
        const resolved = resolveImageBlock(image)
        return resolved ? [resolved] : []
      })

      if (textParts || resolvedImages.length > 0) {
        if (resolvedImages.length > 0) {
          const parts: OpenAI.Responses.ResponseInputContent[] = []
          if (textParts) parts.push({ type: 'input_text', text: textParts })
          for (const img of resolvedImages) {
            const { mediaType, data } = img
            parts.push({
              type: 'input_image',
              detail: 'auto',
              image_url: `data:${mediaType};base64,${data}`,
            })
          }
          input.push({ role: 'user', content: parts })
        } else {
          input.push({ role: 'user', content: textParts })
        }
      }
    } else if (msg.role === 'assistant') {
      const textParts = msg.content.filter((block) => block.type === 'text')
      const toolUses = msg.content.filter((block) => block.type === 'tool_use')

      if (textParts.length > 0) {
        input.push({
          role: 'assistant',
          content: textParts.map((block) => (block as { text: string }).text).join('\n'),
        })
      }

      for (const toolUse of toolUses) {
        const block = toolUse as { id: string; name: string; input: Record<string, unknown> }
        if (!pairedCallIds.has(block.id)) continue
        const { callId, itemId } = splitToolCallId(block.id)
        input.push({
          type: 'function_call',
          id: itemId ?? `fc_${callId}`,
          call_id: callId,
          name: block.name,
          arguments: JSON.stringify(block.input),
        })
      }
    }
  }

  return input
}

export function convertOpenAIResponsesTools(
  tools: CompletionRequest['tools'],
): OpenAI.Responses.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: null,
  }))
}

export function buildOpenAIResponsesReasoningConfig(
  req: CompletionRequest,
): OpenAI.Responses.ResponseCreateParams['reasoning'] {
  return req.reasoningEffort
    ? {
        summary: 'auto',
        effort: req.reasoningEffort as NonNullable<
          NonNullable<OpenAI.Responses.ResponseCreateParams['reasoning']>['effort']
        >,
      }
    : { summary: 'auto' }
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

function normalizeToolOutput(output: string, outputSummary?: string): string {
  if (output.trim().length > 0) return output
  if (outputSummary && outputSummary.trim().length > 0) return outputSummary
  return '[tool completed with empty output]'
}
