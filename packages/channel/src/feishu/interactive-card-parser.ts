import { extractTextFromJson } from './content-utils'

const FEISHU_CARD_FALLBACK_TEXT = '[卡片消息]'

export function parseInteractiveCardContent(rawJson: string): string {
  try {
    return parseCard(JSON.parse(rawJson))
  } catch {
    return FEISHU_CARD_FALLBACK_TEXT
  }
}

function parseCard(card: unknown): string {
  if (!isRecord(card)) return FEISHU_CARD_FALLBACK_TEXT

  if (card.type === 'template') return FEISHU_CARD_FALLBACK_TEXT

  if (card.type === 'card' && isRecord(card.data) && typeof card.data.card_id === 'string') {
    return FEISHU_CARD_FALLBACK_TEXT
  }

  if ((card.msg_type === 'interactive' || card.type === 'interactive') && isRecord(card.card)) {
    return parseCard(card.card)
  }

  if (card.schema === '2.0') {
    return parseCardKitCard(card)
  }

  if (Array.isArray(card.elements) && (card.config !== undefined || card.header !== undefined)) {
    return parseLegacyCard(card)
  }

  const extracted = extractTextFromJson(card).trim()
  return extracted || FEISHU_CARD_FALLBACK_TEXT
}

function parseCardKitCard(card: Record<string, unknown>): string {
  const parts: string[] = []
  const title = isRecord(card.header) ? getContentText(card.header.title) : ''
  if (title) parts.push(`# ${title}`)

  const bodyElements = isRecord(card.body) ? card.body.elements : undefined
  const body = joinTextBlocks(collectCardKitTexts(bodyElements))
  if (body) parts.push(body)

  return joinTextBlocks(parts) || FEISHU_CARD_FALLBACK_TEXT
}

function parseLegacyCard(card: Record<string, unknown>): string {
  const parts: string[] = []
  const title = isRecord(card.header) ? getContentText(card.header.title) : ''
  if (title) parts.push(`# ${title}`)

  const body = joinTextBlocks(collectLegacyCardTexts(card.elements))
  if (body) parts.push(body)

  return joinTextBlocks(parts) || FEISHU_CARD_FALLBACK_TEXT
}

function collectCardKitTexts(elements: unknown): string[] {
  if (!Array.isArray(elements)) return []

  const texts: string[] = []
  for (const element of elements) {
    if (!isRecord(element)) continue

    if (element.tag === 'markdown' && typeof element.content === 'string') {
      const content = element.content.trim()
      if (content) texts.push(content)
      continue
    }

    if (element.tag === 'column_set' && Array.isArray(element.columns)) {
      for (const column of element.columns) {
        if (!isRecord(column)) continue
        texts.push(...collectCardKitTexts(column.elements))
      }
      continue
    }

    if (Array.isArray(element.elements)) {
      texts.push(...collectCardKitTexts(element.elements))
    }
  }

  return texts
}

function collectLegacyCardTexts(elements: unknown): string[] {
  if (!Array.isArray(elements)) return []

  const texts: string[] = []
  for (const element of elements) {
    if (!isRecord(element)) continue

    if (element.tag === 'markdown' && typeof element.content === 'string') {
      const content = element.content.trim()
      if (content) texts.push(content)
      continue
    }

    if (element.tag === 'div') {
      const content = getContentText(element.text)
      if (content) texts.push(content)
      continue
    }

    if (element.tag === 'note' && Array.isArray(element.elements)) {
      texts.push(...collectLegacyCardTexts(element.elements))
      continue
    }

    const directText = getLegacyElementText(element)
    if (directText) texts.push(directText)

    if (Array.isArray(element.elements)) {
      texts.push(...collectLegacyCardTexts(element.elements))
    }
  }

  return texts
}

function getLegacyElementText(element: Record<string, unknown>): string {
  const nestedText = getContentText(element.text)
  if (nestedText) return nestedText

  if (element.tag === 'plain_text') {
    return getContentText(element)
  }

  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getContentText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!isRecord(value)) return ''
  return typeof value.content === 'string' ? value.content.trim() : ''
}

function joinTextBlocks(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n')
}
