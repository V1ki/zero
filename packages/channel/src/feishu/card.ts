export const FEISHU_MAX_TEXT_MESSAGE_BYTES = 150 * 1024
export const FEISHU_MAX_RICH_MESSAGE_BYTES = 30 * 1024
export const FEISHU_STREAMING_UPDATE_INTERVAL_MS = 300
export const FEISHU_STREAMING_ELEMENT_ID = 'streaming_content'

export interface FeishuCardOptions {
  title?: string
  template?: string
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Detect if text content is a complete Feishu card JSON.
 * Supports v1 (Message Card), v2 (CardKit), and template cards.
 * Returns the parsed card object or null.
 */
export function detectFeishuCardJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

    const card = parsed as Record<string, unknown>
    const data =
      typeof card.data === 'object' && card.data !== null
        ? (card.data as Record<string, unknown>)
        : null

    if (card.schema === '2.0') return card

    if (Array.isArray(card.elements) && (card.config !== undefined || card.header !== undefined)) {
      return card
    }

    if (card.type === 'template' && data?.template_id) return card

    if (
      (card.msg_type === 'interactive' || card.type === 'interactive') &&
      typeof card.card === 'object' &&
      card.card !== null &&
      !Array.isArray(card.card)
    ) {
      return card.card as Record<string, unknown>
    }

    return null
  } catch {
    return null
  }
}

/** Build JSON 2.0 interactive card payload. */
export function buildFeishuMarkdownCardV2(content: string, options?: FeishuCardOptions): string {
  const card: Record<string, unknown> = {
    schema: '2.0',
    body: {
      direction: 'vertical',
      elements: [{ tag: 'markdown', content }],
    },
  }

  if (options?.title) {
    card.header = {
      title: { tag: 'plain_text', content: options.title },
      ...(options.template ? { template: options.template } : {}),
    }
  }

  return JSON.stringify(card)
}

export function buildFeishuStreamingCardV2(summary = 'Thinking...'): string {
  return JSON.stringify({
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: { content: summary },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '',
          text_align: 'left',
          element_id: FEISHU_STREAMING_ELEMENT_ID,
        },
      ],
    },
  })
}

export function buildFeishuFinalStreamingCardV2(content: string): string {
  return JSON.stringify({
    schema: '2.0',
    body: {
      elements: [
        {
          tag: 'markdown',
          content,
          text_align: 'left',
        },
      ],
    },
  })
}

export function buildFeishuCardReferenceContent(cardId: string): string {
  return JSON.stringify({
    type: 'card',
    data: {
      card_id: cardId,
    },
  })
}

/** Build post payload with md tag for fallback. */
export function buildFeishuPostContent(content: string, options?: FeishuCardOptions): string {
  const zhCn: Record<string, unknown> = {
    content: [[{ tag: 'md', text: content }]],
  }
  if (options?.title) {
    zhCn.title = options.title
  }
  return JSON.stringify({ zh_cn: zhCn })
}

/** Build text payload as last fallback. */
export function buildFeishuTextContent(content: string, options?: FeishuCardOptions): string {
  if (!options?.title) {
    return JSON.stringify({ text: content })
  }

  const text = content ? `${options.title}\n\n${content}` : options.title
  return JSON.stringify({ text })
}

/**
 * Split message by line with byte-size guard for rich payloads.
 * This avoids hitting Feishu's 30KB post/interactive limit.
 */
export function chunkFeishuRichContent(content: string, options?: FeishuCardOptions): string[] {
  const chunks = splitByLinePreserveLimit(content, FEISHU_MAX_RICH_MESSAGE_BYTES, (chunk) =>
    buildFeishuMarkdownCardV2(chunk),
  )

  if (options?.title && chunks.length > 0) {
    const firstPayload = buildFeishuMarkdownCardV2(chunks[0], options)
    if (byteLength(firstPayload) > FEISHU_MAX_RICH_MESSAGE_BYTES) {
      const firstChunks = splitByLinePreserveLimit(
        chunks[0],
        FEISHU_MAX_RICH_MESSAGE_BYTES,
        (chunk) => buildFeishuMarkdownCardV2(chunk, options),
      )
      chunks.splice(0, 1, ...firstChunks)
    }
  }

  return chunks
}

export function splitByLinePreserveLimit(
  content: string,
  maxBytes: number,
  payloadBuilder: (chunk: string) => string,
): string[] {
  if (byteLength(payloadBuilder(content)) <= maxBytes) {
    return [content]
  }

  const lines = content.split('\n')
  const chunks: string[] = []
  let current = ''

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line
    if (current && byteLength(payloadBuilder(candidate)) > maxBytes) {
      chunks.push(current)
      current = ''
    }

    if (byteLength(payloadBuilder(line)) <= maxBytes) {
      current = current ? `${current}\n${line}` : line
      continue
    }

    if (current) {
      chunks.push(current)
      current = ''
    }

    let remaining = line
    while (remaining.length > 0) {
      const prefix = takeLargestPrefix(remaining, maxBytes, payloadBuilder)
      if (!prefix) {
        chunks.push(remaining)
        remaining = ''
        continue
      }
      chunks.push(prefix)
      remaining = remaining.slice(prefix.length)
    }
  }

  if (current) {
    chunks.push(current)
  }

  return chunks.length > 0 ? chunks : [content]
}

function takeLargestPrefix(
  content: string,
  maxBytes: number,
  payloadBuilder: (chunk: string) => string,
): string {
  let lo = 1
  let hi = content.length
  let best = 0

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const sample = content.slice(0, mid)
    if (byteLength(payloadBuilder(sample)) <= maxBytes) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  return best > 0 ? content.slice(0, best) : ''
}
