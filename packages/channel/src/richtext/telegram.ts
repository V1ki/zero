import { normalizeMarkdownForChannels } from './normalize'
import type { TelegramEntityType, TelegramRichText, TelegramTextEntity } from './types'

interface Chunk {
  type: 'text' | 'pre'
  content: string
  language?: string
}

interface ParsedTelegramInline {
  text: string
  entities: TelegramTextEntity[]
}

const MARKER_TO_ENTITY: Record<string, TelegramEntityType> = {
  '**': 'bold',
  '*': 'italic',
  __: 'underline',
  _: 'italic',
  '~~': 'strikethrough',
  '||': 'spoiler',
}

/**
 * Render markdown into Telegram Bot API text + entities.
 *
 * This parser intentionally focuses on the subset used in ZeRo OS replies.
 * Unsupported markdown remains as plain text so delivery is never blocked.
 */
export function markdownToTelegramRichText(markdown: string): TelegramRichText {
  const normalized = normalizeMarkdownForChannels(markdown)
  if (!normalized) {
    return { text: '', entities: [] }
  }

  const chunks = splitFencedCodeBlocks(normalized)
  let out = ''
  const entities: TelegramTextEntity[] = []

  for (const chunk of chunks) {
    if (chunk.type === 'pre') {
      const start = out.length
      out += chunk.content
      if (chunk.content.length > 0) {
        entities.push({
          type: 'pre',
          offset: start,
          length: chunk.content.length,
          language: chunk.language,
        })
      }
      continue
    }

    const lines = chunk.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseTelegramLine(lines[i], out.length)
      out += parsed.text
      entities.push(...parsed.entities)

      if (i < lines.length - 1) {
        out += '\n'
      }
    }
  }

  return {
    text: out,
    entities: entities
      .filter((e) => e.length > 0)
      .sort((a, b) => a.offset - b.offset || b.length - a.length),
  }
}

export function chunkTelegramRichText(
  rendered: TelegramRichText,
  maxLength = 4096,
): TelegramRichText[] {
  if (rendered.text.length <= maxLength) {
    return [rendered]
  }

  const chunks: TelegramRichText[] = []
  let start = 0

  while (start < rendered.text.length) {
    let end = Math.min(start + maxLength, rendered.text.length)

    if (end < rendered.text.length) {
      const candidate = rendered.text.lastIndexOf('\n', end)
      if (candidate > start + Math.floor(maxLength * 0.6)) {
        end = candidate
      }
    }

    const text = rendered.text.slice(start, end)

    const entities = rendered.entities
      .filter((entity) => {
        const entityStart = entity.offset
        const entityEnd = entity.offset + entity.length
        return entityStart >= start && entityEnd <= end
      })
      .map((entity) => ({
        ...entity,
        offset: entity.offset - start,
      }))

    chunks.push({ text, entities })
    start = end
  }

  return chunks
}

function parseTelegramLine(line: string, baseOffset: number): ParsedTelegramInline {
  let quoteType: TelegramEntityType | null = null
  let body = line

  if (line.startsWith('>!')) {
    quoteType = 'expandable_blockquote'
    body = line.slice(2)
  } else if (line.startsWith('>')) {
    quoteType = 'blockquote'
    body = line.slice(1)
  }

  if (body.startsWith(' ')) {
    body = body.slice(1)
  }

  const parsed = parseStructuredTelegramLine(body, baseOffset)

  if (quoteType && parsed.text.length > 0) {
    parsed.entities.push({
      type: quoteType,
      offset: baseOffset,
      length: parsed.text.length,
    })
  }

  return parsed
}

function parseStructuredTelegramLine(body: string, baseOffset: number): ParsedTelegramInline {
  const heading = body.match(/^#{1,6}\s+(.+)$/)
  if (heading) {
    const parsed = parseTelegramInline(heading[1], baseOffset)
    if (parsed.text.length > 0) {
      parsed.entities.push({
        type: 'bold',
        offset: baseOffset,
        length: parsed.text.length,
      })
    }
    return parsed
  }

  if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(body)) {
    return { text: '──────────', entities: [] }
  }

  const task = body.match(/^[-*+]\s+\[( |x|X)\]\s+(.+)$/)
  if (task) {
    const prefix = task[1].toLowerCase() === 'x' ? '☑ ' : '☐ '
    const parsed = parseTelegramInline(task[2], baseOffset + prefix.length)
    return {
      text: `${prefix}${parsed.text}`,
      entities: parsed.entities,
    }
  }

  const unordered = body.match(/^[-*+]\s+(.+)$/)
  if (unordered) {
    const prefix = '• '
    const parsed = parseTelegramInline(unordered[1], baseOffset + prefix.length)
    return {
      text: `${prefix}${parsed.text}`,
      entities: parsed.entities,
    }
  }

  const ordered = body.match(/^(\d+)[.)]\s+(.+)$/)
  if (ordered) {
    const prefix = `${ordered[1]}. `
    const parsed = parseTelegramInline(ordered[2], baseOffset + prefix.length)
    return {
      text: `${prefix}${parsed.text}`,
      entities: parsed.entities,
    }
  }

  return parseTelegramInline(body, baseOffset)
}

function splitFencedCodeBlocks(markdown: string): Chunk[] {
  const chunks: Chunk[] = []
  const re = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g
  let last = 0

  for (const match of markdown.matchAll(re)) {
    const full = match[0]
    const idx = match.index ?? 0
    const lang = match[1]?.trim() || undefined
    const code = match[2] ?? ''

    if (idx > last) {
      chunks.push({ type: 'text', content: markdown.slice(last, idx) })
    }

    chunks.push({ type: 'pre', content: code, language: lang })
    last = idx + full.length
  }

  if (last < markdown.length) {
    chunks.push({ type: 'text', content: markdown.slice(last) })
  }

  return chunks.length > 0 ? chunks : [{ type: 'text', content: markdown }]
}

function parseTelegramInline(input: string, baseOffset: number): ParsedTelegramInline {
  let text = ''
  const entities: TelegramTextEntity[] = []
  let i = 0

  while (i < input.length) {
    if (input[i] === '\\' && i + 1 < input.length) {
      text += input[i + 1]
      i += 2
      continue
    }

    if (input[i] === '`') {
      const end = findUnescaped(input, '`', i + 1)
      if (end !== -1) {
        const inner = input.slice(i + 1, end)
        const start = baseOffset + text.length
        text += inner
        if (inner.length > 0) {
          entities.push({ type: 'code', offset: start, length: inner.length })
        }
        i = end + 1
        continue
      }
    }

    if (input[i] === '[') {
      const link = parseLink(input, i, baseOffset + text.length)
      if (link) {
        text += link.text
        entities.push(...link.entities)
        i = link.nextIndex
        continue
      }
    }

    const marker = detectMarker(input, i)
    if (marker) {
      const end = findClosingMarker(input, marker, i + marker.length)
      if (end !== -1) {
        const innerRaw = input.slice(i + marker.length, end)
        const start = baseOffset + text.length
        const parsedInner = parseTelegramInline(innerRaw, start)

        text += parsedInner.text
        entities.push(...parsedInner.entities)

        if (parsedInner.text.length > 0) {
          entities.push({
            type: MARKER_TO_ENTITY[marker],
            offset: start,
            length: parsedInner.text.length,
          })
        }

        i = end + marker.length
        continue
      }
    }

    text += input[i]
    i += 1
  }

  return { text, entities }
}

function parseLink(
  input: string,
  start: number,
  baseOffset: number,
): { text: string; entities: TelegramTextEntity[]; nextIndex: number } | null {
  const closeLabel = findUnescaped(input, ']', start + 1)
  if (closeLabel === -1 || input[closeLabel + 1] !== '(') {
    return null
  }

  const closeUrl = findUnescaped(input, ')', closeLabel + 2)
  if (closeUrl === -1) {
    return null
  }

  const rawLabel = input.slice(start + 1, closeLabel)
  const rawUrl = input.slice(closeLabel + 2, closeUrl).trim()
  if (!rawUrl) {
    return null
  }

  const parsedLabel = parseTelegramInline(rawLabel, baseOffset)
  const text = parsedLabel.text
  const entities = [...parsedLabel.entities]

  if (text.length > 0) {
    entities.push({
      type: 'text_link',
      offset: baseOffset,
      length: text.length,
      url: rawUrl,
    })
  }

  return {
    text,
    entities,
    nextIndex: closeUrl + 1,
  }
}

function detectMarker(input: string, index: number): string | null {
  const candidates = ['**', '__', '~~', '||', '*', '_']
  for (const marker of candidates) {
    if (input.startsWith(marker, index)) {
      return marker
    }
  }
  return null
}

function findClosingMarker(input: string, marker: string, from: number): number {
  let idx = from
  while (idx < input.length) {
    const found = input.indexOf(marker, idx)
    if (found === -1) return -1
    if (input[found - 1] !== '\\') {
      return found
    }
    idx = found + marker.length
  }
  return -1
}

function findUnescaped(input: string, char: string, from: number): number {
  let idx = from
  while (idx < input.length) {
    const found = input.indexOf(char, idx)
    if (found === -1) return -1
    if (input[found - 1] !== '\\') {
      return found
    }
    idx = found + 1
  }
  return -1
}
