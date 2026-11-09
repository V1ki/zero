import {
  type CompletionRequest,
  type ToolDefinition,
  estimateMessageTokens,
  estimateTokens,
  truncateToTokens,
} from '@zero-os/shared'

const excerptTool: ToolDefinition = {
  name: 'read_context_excerpt',
  description:
    '按原工具调用 ID 查阅本轮被折叠的工具回执。可按字符位置分页，或从 offset 起查找原文中的文字。返回 nextOffset 可继续。',
  parameters: {
    type: 'object',
    properties: {
      callId: { type: 'string' },
      offset: { type: 'integer', minimum: 0 },
      find: { type: 'string' },
    },
    required: ['callId'],
  },
}

/** Project oversized receipts only at the provider boundary. The loop keeps its original messages. */
export class RouterContextWindow {
  private readonly originals = new Map<string, string>()
  private pageTokens = 0

  get readerName() {
    return excerptTool.name
  }

  read(input: Record<string, unknown>) {
    const original = this.originals.get(String(input.callId))
    if (original === undefined) throw Error('本轮没有这个可回查的工具回执。')
    const offset = input.offset ?? 0
    if (
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > original.length
    )
      throw Error('offset 必须是回执范围内的字符位置。')
    const start = typeof input.find === 'string' ? original.indexOf(input.find, offset) : offset
    if (start < 0) return JSON.stringify({ found: false, length: original.length })
    const text = truncateToTokens(original.slice(start), this.pageTokens)
    const end = start + text.length
    return JSON.stringify({ offset: start, text, nextOffset: end < original.length ? end : null })
  }

  project(
    request: CompletionRequest,
    maxContext: number,
    currentResults: ReadonlySet<string>,
    historyLength: number,
  ) {
    const available = maxContext - (request.maxTokens ?? 0)
    const before =
      estimateTokens(request.system ?? '') +
      estimateTokens(JSON.stringify(request.tools ?? [])) +
      request.messages.reduce(
        (total, message) => total + estimateMessageTokens(message.content) + 4,
        0,
      )
    if (available <= 0 || before <= available) return
    const currentMessages = request.messages.slice(historyLength)
    const replacement = new Map<string, string>()
    const historical = new Map<string, string>()
    const candidates: { text: string; reference: string; id: string; kind: 'turn' | 'receipt' }[] =
      []
    if (request.tools?.some((tool) => tool.name === 'read_conversation')) {
      // Only fold durable assistant answers. Keep the user's instructions and current matter verbatim.
      for (const message of request.messages.slice(0, historyLength)) {
        const id = /^router-assistant-([1-9]\d*)$/.exec(message.id)?.[1]
        if (!id || message.role !== 'assistant' || message.content.length !== 1) continue
        const block = message.content[0]
        if (block.type !== 'text') continue
        const reference = `历史答复 #${id} 已因模型窗口折叠。需要其结论或依据时，用 read_conversation，beforeTurnId 传 ${Number(id) + 1}，取回原话后再判断。`
        candidates.push({ id: message.id, kind: 'turn', text: block.text, reference })
      }
    }
    for (const message of currentMessages) {
      for (const block of message.content) {
        if (
          block.type !== 'tool_result' ||
          !currentResults.has(block.toolUseId) ||
          block.contentItems?.length
        )
          continue
        const reference = JSON.stringify({
          originalCallId: block.toolUseId,
          length: block.content.length,
          preview: truncateToTokens(block.content, 40),
          readWith: excerptTool.name,
        })
        candidates.push({ id: block.toolUseId, kind: 'receipt', text: block.content, reference })
      }
    }
    let projected = before
    for (const source of candidates.sort(
      (a, b) => b.text.length - b.reference.length - (a.text.length - a.reference.length),
    )) {
      const savings = estimateTokens(source.text) - estimateTokens(source.reference)
      if (savings <= 0) break
      if (source.kind === 'turn') historical.set(source.id, source.reference)
      else {
        if (!replacement.size) projected += estimateTokens(JSON.stringify(excerptTool))
        replacement.set(source.id, source.reference)
        this.originals.set(source.id, source.text)
      }
      projected -= savings
      if (projected <= available) break
    }
    // Older pages can be fetched again from the original call. Keep the latest page visible.
    const reads = new Map(
      currentMessages.flatMap((message) =>
        message.content.flatMap((block) =>
          block.type === 'tool_use' && block.name === excerptTool.name
            ? [[block.id, block.input] as const]
            : [],
        ),
      ),
    )
    for (const message of currentMessages.slice(0, -1)) {
      if (projected <= available) break
      for (const block of message.content) {
        if (block.type !== 'tool_result' || !reads.has(block.toolUseId)) continue
        const reference = JSON.stringify({
          readWith: excerptTool.name,
          input: reads.get(block.toolUseId),
        })
        const savings = estimateTokens(block.content) - estimateTokens(reference)
        if (savings <= 0) continue
        replacement.set(block.toolUseId, reference)
        projected -= savings
      }
    }
    if (!replacement.size && !historical.size) return
    this.pageTokens = Math.max(1, Math.floor((available - projected) / 2))
    if (replacement.size) request.tools = [...(request.tools ?? []), excerptTool]

    request.messages = request.messages.map((message, index) => {
      const text = historical.get(message.id)
      if (text !== undefined) return { ...message, content: [{ type: 'text', text }] }
      if (index < historyLength) return message
      const content = message.content.map((block) => {
        if (block.type !== 'tool_result') return block
        const reference = replacement.get(block.toolUseId)
        return reference === undefined ? block : { ...block, content: reference }
      })
      return { ...message, content }
    })
    return {
      reason: 'model_context_capacity',
      inputTokenEstimate: before,
      projectedTokenEstimate: projected,
      availableInputTokens: available,
      originals: [...replacement.keys()],
      historyMessages: [...historical.keys()],
    }
  }
}
